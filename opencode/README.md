---
display_name: OpenCode and acpx
description: Pinned OpenCode and acpx with private storage and env-only provider integration
icon: ../.icons/code.svg
maintainer_github: Ricky-Hao
verified: false
tags: [helper, ide, ai]
---

# OpenCode and acpx

本模块为现有 Workspace 用户安装固定版本的 OpenCode、私有 Node、acpx 和
`opencode-task`。任务通过 `launch` 从 origin 的 `base` 分支（默认 main）准备 Git worktree，
自动建立 session 并尝试派发，支持可信续接、持久回调和原请求恢复。
API、权限和未知结果边界见 [TASKS.md](TASKS.md)。
错误的阶段、字段、unknown 和原请求处理建议见 [回执与查询](TASKS.md#回执错误与查询)。
错误诊断不证明未派发，也不触发换模型、放权或自动重派。
无需新增 MCP tool；Agent 沿已有 callback 注册、私有文件写入和 Workspace Bash 调用。

```hcl
module "opencode" {
  source       = "git::https://github.com/Ricky-Hao/coder-modules.git//opencode?ref=<FIXED_COMMIT>"
  agent_id     = coder_agent.example.id
  install_root = "/mnt/opencode/toolset"
}
```

`<FIXED_COMMIT>` 须替换为已审阅并可获取的完整 commit。Git source 不接受 registry
`version` 参数。此 fork 不自动发布到 Coder Registry；合并源码也不会更新模板或运行环境。
本地审阅可用 `source = "./opencode"`。

## 存储与启动

只需 `agent_id`。省略 `install_root` 时，启动程序使用 Agent 用户的
`$HOME/.coder-opencode`，不使用 Terraform 的 HOME 或 `pathexpand`。支持 root 和非 root。
HOME 须是规范绝对路径、由当前 UID 拥有且不可被 group/other 写入；路径不穿越 symlink。

持久使用建议由模板提供专用、可写 PVC，挂到 `/mnt/opencode`，模块只管理其私有
`toolset` 子目录。挂载示例见 [examples/kubernetes.tf.example](examples/kubernetes.tf.example)。
基础设施负责 UID/fsGroup 和卷权限。模块不递归 chown/chmod，不接管已有的无标记目录，
即使目录为空。没有持久 HOME 或显式持久挂载时，不保证重启后数据仍在。

安装路径及 HOME/profile 的祖先须是 root 或当前 UID 拥有的真实目录。拒绝 nonsticky
world-writable 祖先；允许 `/tmp` 这类 sticky 共享祖先。nonsticky group-writable 祖先也拒绝，
只有安装根的直接父目录可为进程所属可信 group 可写的 PVC。此例外不用于更高祖先或 HOME。
HOME/profile 沿 fd 访问且不跟随链接；安装在祖先校验后使用绝对路径，依赖上述信任边界。
锁只串行合作进程，不能对抗 root、同 UID 或可信 PVC group 的恶意替换。

一个 `coder_script` 完成安装和 Bash PATH 集成，默认阻塞登录。模块自行取得 Workspace ID，
内含所需 helper；调用方无需复制源码、传 `file()` 或让 Agent 配置依赖模块输出。
同 UID、Workspace ID 和文件系统上的重复启动会核验并复用缓存。实际源码/settings 变化
生成新 fingerprint 版本；失败回退原 active。已有版本、任务、session、cache 和卷上兄弟目录
全部保留，不迁移、不自动删除。新版本仅使用 `runtime/tasks-v3/`，不扫描旧 `runtime/tasks/`。
记录支持边界见 [TASKS.md](TASKS.md#当前持久格式)。

### 专用 root-owned 0777 PVC 的显式准备

若 provisioner 将专用 `/mnt/opencode` 挂成 root-owned 0777 nonsticky，设置：

```hcl
install_root = "/mnt/opencode/toolset"
dedicated_volume = {
  mount_path   = "/mnt/opencode"
  workspace_id = data.coder_workspace.me.id
}
```

模板须在 Workspace 进程启动前，以 root init container 执行
`["python3", "-B", "-c", module.opencode.volume_prepare_script]`。有 count 时索引模块。
设置输入本身不执行准备。此输出只依赖输入和模块文件，避免 Agent/Pod 依赖环；默认输出 null。
需要 Python 3.11+ 及 Linux procfs 的 fdinfo/mountinfo，BusyBox 不够。

准备只接受实际挂载点 `/mnt/opencode` 和其私有 `toolset`。校验 root-owned 安全祖先、
无链接路径及 mount ID。已有 toolset 须有本 Workspace owner 标记、私有属性和已知安装项；
active 只接受模块管理的相对 versions 链接。安装者另验缓存 inventory。其他卷根目录项
不打开、不遍历、不修改；已有 session 数据也不扫描。只在验证后的目录 fd 上将
**0777 改为 1777**，保留已有安全模式；不拓宽 0755 卷供非 root 写入。
修改前后均核 toolset 身份，发现并发变化则失败；已加的 sticky 不回退。卷须专属本 Workspace，
准备先于使用者。sticky 不能约束 root、同 UID、可信 group 或任意未来文件创建。

### Bash 与自动化输出

只在 `.bashrc` 和现有首选登录文件（`.bash_profile`、`.bash_login`、否则 `.profile`）末尾
追加 wrapper bin 目录，保留原字节、权限和 PATH 顺序。修改过的托管块、不安全链接、外来文件
和并发编辑会被拒绝。原文件提前 return/exit 可能跳过追加块，须由负责人检查。
只对新 shell 生效；不改父 Agent 环境、全局 PATH 或项目 Node。

`opencode_command`、`acpx_command`、`opencode_task_command` 是经过 shell quoting 的调用表达式，
不是裸文件名。HOME 模式在执行时展开 `"$HOME"`；显式根返回带引号绝对路径。
`status_path` 在显式根模式为绝对路径，HOME 模式为 null，此时读取
`$HOME/.coder-opencode/status.json`。`script_id` 标识启动脚本。
检查新启动的 `state: ready` 和实际命令；Agent ready 或旧 status 不代表此次安装完成。

<a id="startup-execution-budget"></a>
## 启动传输与预算

源码保留在模块内。[source.json](scripts/source.json) 使用标准 XZ + base64，无自定义编码。
解压原文是 NUL 分隔的文件名与 UTF-8 原字节；动态 settings 单独传递。Terraform 根据当前
源码核摘要和格式，拒绝过期包；Python 标准库 `lzma` 在内存解包并核原文 SHA256 后才执行。
包损坏时不安装或写 status，已有 active 保留。生成包本身不安装到 runtime。

修改运行源码后运行并一同提交：

```sh
python3 -B opencode/build_bundle.py
python3 -B opencode/build_bundle.py --check
```

`--check` 核对恢复后的每个原字节，不要求不同 lzma 库生成相同压缩流。缓存身份仍基于
原始源码和 settings。固定 source 的安装者无需构建。没有远程 bootstrap 或额外下载信任源。
不嵌入 OpenCode/acpx 二进制、测试或文档；依赖 lock 和 provenance 保留。

实际渲染脚本的 plan-time 上限为 **65536 字节**，不调整此预算。Linux 4096 字节页环境下，
单参数含终止符上限为 131072 字节，须为 Coder wrapper 留空间。`bash -n` 或执行脚本文件
不能代替真实 `env bash -c` 参数边界检查。源码/settings 增长后须重新运行真实 Terraform render，
同时验证首次/缓存启动和数据保留，确认不自动恢复任务。历史 E2BIG 及旧体积记录见 [UPGRADE.md](UPGRADE.md)。

源码不做 minify。每次维护须重新生成无损源码包并 render 全部配置；较长 settings 可被 plan 拒绝。
生成包使用标准 XZ/LZMA2 的文本参数（pb=0、1 MiB 字典），解包仍逐字节核对源码摘要。
预算始终为 **65536 字节**；交付报告记录本轮 payload 和实际 Terraform 字节数。

## 固定工具与输入

需要 Linux x86-64 glibc、Bash、Python 3.11+、Git、curl、tar 和 xz。不编译源码或安装系统前置包。
首次安装需网络下载经过校验的发行包；核验后的缓存可离线使用。npm 禁用 lifecycle scripts。

| 输入 | 默认值 |
| --- | --- |
| `agent_id` | 必填，现有 Agent ID |
| `install_root` | 空，启动时使用 `$HOME/.coder-opencode` |
| `dedicated_volume` | null，显式启用专用卷 root-init 输出 |
| `release` | null，使用下列固定发行包 |
| `runtime_profile` | `env`，可选 `none` |
| `start_blocks_login` | `true` |
| `install_timeout` | 1200 秒 |

OpenCode 固定为公开 prerelease
[v2.2.0-ricky.1](https://github.com/Ricky-Hao/opencode/releases/tag/v2.2.0-ricky.1)，
asset `opencode-linux-x64-baseline-v2.2.0-ricky.1.tar.gz`，SHA256
`09ed8c564754413a7296c12ce147c4b60d98456dc3815db71b399e093ad7ddcd`。
tag 源码为 `9291b46db483415e1c9bdaa72f8e48637e3f7b49`，基于 upstream v2.2.0
`1097e2668b1e08ad63bdf0b1c4860b9bc01e420c`。私有 Node 为 **22.23.4**，acpx 为 **0.21.1**。
不使用 dirty 构建或 moving latest。完整 provenance 见 [UPGRADE.md](UPGRADE.md)。

覆盖 OpenCode 须提供完整 `release = { tag, asset, sha256 }` 并先审阅发行物。
安装核 tag/asset、摘要、metadata、属主和缓存 inventory；不覆盖 Node/acpx 的 pin。
接口按上述当前版本维护，覆盖发行物不意味着旧协议受支持。

## Provider、模型和 MCP

内置 `env` profile 恰好包含 **copilot、codex**，两者模型定义完整相同，使用 OpenAI Responses，
不启用官方 Copilot/Codex 登录。默认主模型为 **codex/gpt-6.1-sol / max**，title 为同 Provider
Sol/low。其他 Provider 保持禁用。四个独立变量、任务 JSON 选择及外部配置见
[PROVIDERS.md](PROVIDERS.md)。codex session 主请求默认使用原生 Responses WebSocket，
连接失败沿原生 HTTP fallback，并默认启用 native 远程压缩；上游须支持 compaction trigger
及加密 checkpoint。copilot 保持普通文本摘要；copilot 与 title/low 保持 HTTP/SSE。
已有 task/session 沿保存的 profile 保留原策略，新任务采用新默认。catalog 不证明服务访问权、价格或可用性。

| 模型 | context | input | output | 默认 reasoning |
| --- | ---: | ---: | ---: | --- |
| `gpt-6.1-sol` | 400000 | 272000 | 128000 | max |
| `gpt-6-astra` | 400000 | 272000 | 128000 | medium |

保留完整 cost/capabilities/settings 和 low/medium/high/xhigh/max variants。
固定 fork 的 `SessionCompaction.calculateCeiling` 在显式 buffer 下取 input-buffer，
不再减 output。input=272000、buffer=13600 时，估算 prompt 258400 触发压缩，
上下文留 141600=128000+13600 tokens。`SessionModelRequest.outputLimit` 另按剩余上下文
和未测 input 的 15% 余量拟合 output。这是预算阈值，不能保证大 turn 或估算误差不会溢出。

此 pin 的自动 small-model 消费者是 title。使用原生
`agents.title.model = { providerID, model: "gpt-6.1-sol", variant: "low" }`；主请求仍为 max。
title 失败可能按主模型重试。压缩使用 session model/agent；普通生成和继承选择的子任务
不受 title 低档位影响。无需第三模型、全局 small-model 选项或 fork 修改。

## 中心个人规则与通用 Skill

安装、普通 `opencode`/`acpx` 启动及 **每个 `opencode-task` 公共入口**（含 help/version、
list/status/result/doctor）先同步私有中心
`ssh://git@git.rickyhao.com:2222/RickyHao/agent-config.git` 的 `main`，随后执行原命令。
查询更新全局规则是有意的副作用；同步不创建业务 task/session、不操作业务 Git repo，
不恢复任务、不重放请求。任务模型 profile 与权限仍按原快照固定。

同步复用 Git、启动者的受控认证环境和现有 Git SSH hook；不复制凭据或输出 Git stderr。
网络操作总计最多 6 秒，合作写入锁最多等待 8 秒。先比较远端 revision，变化时取得完整
原始 Git 对象，校验内容及执行权限后发布到 `runtime/agent-config/snapshots/<tree>/repo`。
不应用 `export-ignore`、`export-subst` 或 checkout filter，以免漏掉或改写引用文件。
共享 `current` 链接原子切换；旧完整快照保留。相同内容不替换加载链接。
网络失败且已有完整副本时简短提示沿用旧版；首次无副本时返回
`AGENT_CONFIG_SYNC_FAILED`，不执行原命令。目标冲突或已修改缓存拒绝覆盖。

OpenCode 实际加载位置为 `<install_root>/runtime/config/opencode/AGENTS.md`，
它是快照正文的托管 hardlink，以临时文件加 atomic replace 发布，保持原生 watcher 使用的
全局路径。完整通用包位于该配置目录的 `skills/agent-config/`，链接到同一共享快照。
引用文件、脚本与 license 随完整仓库保留。固定 fork 原生发现配置目录的 `skill/skills`；
本模块不依赖 `.agents/skills` 的原生发现。项目 `.agents/skills` 按通用正文约定按需读取，
不是可执行 hook。已有 unmanaged AGENTS 或 `skills/agent-config` 会报冲突，须由用户先整理；
其他 Skill、旧任务、session 和 cache 保留。

全局文件与 Skill 入口分别原子替换。同步成功返回前两处均完成；普通发布错误回退旧版。
这不是跨路径事务：并发读取或进程在两次替换间中断时，可观察到两个不同但完整的版本；
下一公共入口在同步锁内校正中断状态。固定 fork 会缓存全局文件的 canonical 路径，
因此不能用单个 generation 软链同时提供跨路径原子切换和已有会话热更新。
锁等待超时时明确报 `busy`，保留缓存并停止原命令。

第三方 Skill 只消费中心审阅的版本，不在启动时另追 upstream。全局正文对所有会话共用，
不做每个 task 的规则快照。固定 fork 的 instruction/skill watcher 会重载配置；
隔离固定二进制已验证：同一 ACP session 的下一请求收到新全局正文及新增 Skill，
新 session 同样读取新版。Skill 正文与引用文件通过原生工具实际加载。
验证使用中心完整包、本地测试 Git 更新、合成标记与 loopback Responses；
不代表真实 Provider/MCP 健康，也不保证正在执行中的请求中途换规则。

普通 Codex 可显式执行同一同步器，接入同一正文及完整 Skill，不安装或运行 Codex：

```sh
python3 -B /mnt/opencode/toolset/active/agent_config.py --codex-home "${CODEX_HOME:-$HOME/.codex}"
```

HOME 安装时将脚本路径改为 `"$HOME/.coder-opencode/active/agent_config.py"`。
Codex 的全局规则为 `$CODEX_HOME/AGENTS.md`，默认 `~/.codex/AGENTS.md`；
`AGENTS.override.md` 会优先覆盖它，命令在该文件存在时拒绝接入。
本命令使用仍受支持的 `$CODEX_HOME/skills`（默认 `~/.codex/skills`）兼容路径。
当前 Codex 新推荐的用户路径是 `~/.agents/skills`，也支持目录 symlink；
此处显式选择 CODEX_HOME 下的路径，避免同时向两处安装重复 Skill。
命令只创建托管链接，保留现有规则文件和其他 Skill；冲突时失败，不自动合并。
路径核定见 [Codex 官方源码](https://github.com/openai/codex/tree/main/codex-rs/ext/skills/src)。
更新后为 Codex 新开会话；这里不承诺已有 Codex 会话热更新。
需要每次启动检查时，可在自己的启动命令中先执行上述命令，成功后再执行原有 Codex 命令。
LibreChat 仅消费同一通用正文；其专属 Skill、角色与平台流程留在平台，此模块不改平台源码。

<a id="launch-environment"></a>
## 启动环境

launcher 默认继承启动进程的普通环境，包括代理、自定义认证、其他 Provider 和 disabled MCP
的变量。disabled 只省略服务配置，不删除环境。模块覆盖 HOME/XDG/TMPDIR、配置和自动更新控制，
屏蔽原 `OPENCODE_CONFIG`/`OPENCODE_CONFIG_CONTENT` 和任务内部控制变量。
`LC_TASK_CALLBACK*`、`OPENCODE_TASK_CALLBACK*` 以及含 `tcb_` bearer 的值始终过滤。
不保存环境快照；恢复使用恢复进程当前环境，执行前重新校验已保存选择所需的变量。

MCP 前缀为 CONTEXT7、FIRECRAWL、GITHUB、GITHUB_ACTIONS。各 `_MCP_ENABLED` 仅接受 1/0，
缺省关闭。开启时要求 `_MCP_URL`、`_MCP_API_KEY`，可选 `_MCP_AUTH_HEADER`、`_MCP_AUTH_SCHEME`。
Context7 默认 `Authorization: Bearer {env:CONTEXT7_MCP_API_KEY}`；其余默认 X-MCP-API-Key、
空 scheme。Authorization 默认 Bearer，显式空 scheme 可用。OAuth 关闭。

配置只保存 `{env:NAME}`，不将实际值放入 Terraform、settings、argv 或错误。
拒绝控制/非 ASCII、JSON 插值字符、URL 用户信息/query/fragment/坏端口。
Provider 须用 HTTPS，loopback 可 HTTP；MCP 支持 HTTP(S)，需要传输保密时使用 HTTPS。
错误只列变量名。0600 内容寻址配置位于 `runtime/module-profiles`，在自动发现目录外；
文件排他原子发布并核对原字节，无目录锁或重复 owner；已有不安全文件、符号链接和变化内容拒绝使用。
模块自有内容地址与原字节一致的 profile 允许发布临时名留下的多链接；类型、UID、0600 仍校验。
运行与续接共用该校验，私密输入和其他安装文件仍须单链接。

非空 `OPENCODE_MODULE_CONFIG` 优先于内置 profile。`none` 无外部配置时保留显式
ACP readiness 模型/环境契约；任务 launch 仍须有完整模型配置。help/version 不要求凭据。
`--module-profile-info` 只报告来源、选择和变量名，不读取凭据或联系服务。
新 launch 和 direct acpx 默认 approve-all，显式较小模式仍尊重；noninteractive-deny 和原生 policy 拒绝保留。
continue 省略权限沿原 task 保存值。初始化只给新建 acpx config 写 approve-all，不改已有 config；
direct acpx wrapper 用缺省 CLI 参数选择新默认，task runtime 仍显式传保存权限。
直接 `opencode run` 未指定 continue/session 时追加原生 `--auto`，显式 auto/yolo 选项保留。
ACP、交互式 OpenCode 和指定旧 session 的 run 沿原生/保存选择，不注入全局 allow 规则。
这些默认只覆盖本模块工具，不改变平台 Agent/MCP ACL 或业务授权。

<a id="git-ssh"></a>
## Git SSH

模块初始化建立私有 `runtime/git/`。每个实际 lookup host/port 或 HostKeyAlias 用固定 SHA256 文件名独立保存一条公共 key，
不同目标并发不会覆盖彼此；同目标最后一次 atomic replace 胜出，无额外锁或集中全库读写。
launch 及模块启动的 OpenCode/acpx 模型工具 Git 共用一个小型 SSH 适配入口，保留继承 PATH。
固定支持当前 Workspace 注入的 `executable gitssh --`，也可显式提供 OpenSSH 命令或 GIT_SSH。
GIT_SSH_COMMAND 的原身份和参数保留，只在这些子环境指向适配器；不复制认证材料。
没有 `bin/git`、通用 shell/wrapper 或 core.sshCommand 解析层。仅靠隐式 core.sshCommand 选择身份
不受支持：未提供显式 SSH 命令时，SSH 操作报 SSH_OPTIONS_UNSUPPORTED，避免静默改换身份。
不改设备 SSH、用户 `.ssh` 或全局 SSH 设置，不改 HTTPS。
envbuilder 在 Agent 启动前的首次 clone 不在此范围。

适配器用原生 OpenSSH `KnownHostsCommand` 得到本次协商的公共 key 和实际 host/port 或 HostKeyAlias，
自动接受新 key 和变化 key，并 atomic replace 保存最新记录，保留其他目标。无需 keyscan 或连接重试；认证/网络失败不重试或绕过。
按用户选择自动信任变化 key 会降低主机身份保证。此策略无需静态 GitHub/Gitea 种子：首次连接直接保存本次 key，安装时不联网获取 key。
不将公开服务器 key 当成认证私钥，不输出 key、remote、凭据或任意 stderr。

身份、端口、HostKeyAlias 等受支持参数原样传递。显式 UserKnownHostsFile、GlobalKnownHostsFile、
StrictHostKeyChecking 保留；这些文件只读，本次 key 由 hook 另存到模块信任文件。
调用者显式 KnownHostsCommand、UpdateHostKeys 或 VerifyHostKeyDNS 会报固定 SSH_OPTIONS_UNSUPPORTED，
避免拼接未知 hook、写调用者文件或绕过本次 key 的记录。缺省模块选项优先于 ssh_config。
只接受当前 Coder 命令形态或显式 OpenSSH 的少量常用参数（-o/-p/-i/-F/-l、-v/-G/-T/-q/-4/-6），识别 `-vo...`。
其他 Git SSH variant、未知 wrapper 参数、shell 控制操作符或需 shell 展开的复杂身份命令明确拒绝。
主机证书由 hook 成功返回空内容，沿 OpenSSH 既有 known_hosts/CA 与原生回退规则；模块不自动信任或保存证书。
hook 的代码位置和信任路径经环境传给 Python，不经 OpenSSH 再展开；支持字面量 `${HOME}`、空格、引号和 `%`。
首次/缓存初始化保留已记 key；不扫描旧任务、不递归 chown 旧卷。
doctor 的安装自检只核必要信任目录，不扫描整个 trust store；公共入口仍先联系中心同步规则。
因此公共 doctor 返回 `read_only: false, agent_config_sync: true`；自检本身不恢复或改写业务任务。

<a id="validation-and-publication-boundary"></a>
## 验证与交付边界

运行 [CONTRIBUTING.md](../CONTRIBUTING.md#fork-local-validation) 的 fork 检查。
任务、pinned acpx、完整 CLI 和正式包 Responses/回调隔离 fixture 命令见
[TASKS.md](TASKS.md#verification-and-rollout-boundary)。均使用合成凭据、mock ACP 或 loopback，
不调用真实 Provider/MCP/QQ 或付费推理。

真实 Terraform 检查命令：

```sh
python3 -B opencode/tests/validate_terraform.py --terraform /path/to/terraform --provider-dir /path/to/mirror --scratch /new/private/directory
```

需要 Terraform 1.7+ 和缓存 provider；执行 init、validate、mock plan/render、超预算拒绝、
真实 Linux `env bash -c` 首次/缓存启动和数据保留，确认无自动恢复，不 apply 或使用集群。
Python fixtures 另核 root/UID65534、安全 PVC group、PATH 和私有文件边界。
本地检查不证明真实服务健康，也不发布、激活模板或重启 Workspace。

## License

模块沿用仓库 Apache-2.0 许可。安装的 OpenCode 保留
[MIT notice](LICENSE.opencode) 及已校验发行包中的许可；acpx/npm 依赖保留上游 notice。
