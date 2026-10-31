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
`opencode-task`。任务通过 `launch` 准备 Git worktree、自动建立 session 并尝试派发，
支持可信续接、持久回调和原请求恢复。API、权限和未知结果边界见 [TASKS.md](TASKS.md)。
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
全部保留，不迁移、不自动删除。记录支持边界见 [TASKS.md](TASKS.md#当前持久格式边界)。

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
同时验证首次/缓存启动、恢复和数据保留。历史 E2BIG 及旧体积记录见 [UPGRADE.md](UPGRADE.md)。

当前清理候选原文 payload 为 196129 字节，标准 XZ 为 46160、base64 为 61548 字节。
实际 Terraform HOME/固定专用根/含引号路径分别为 62741/62769/62785 字节；
本轮全部配置最大 **62869/65536，余量 2667 字节**。余量仍有限，较长 settings 可被 plan 拒绝。

## 固定工具与输入

需要 Linux x86-64 glibc、Bash、Python 3.11+、curl、tar 和 xz。不编译源码或安装系统前置包。
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
[PROVIDERS.md](PROVIDERS.md)。catalog 不证明服务访问权、价格或可用性。

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
安全父目录锁覆盖首次目录和 owner 创建，已有无标记/外来状态拒绝接管。

非空 `OPENCODE_MODULE_CONFIG` 优先于内置 profile。`none` 无外部配置时保留显式
ACP readiness 模型/环境契约；任务 launch 仍须有完整模型配置。help/version 不要求凭据。
`--module-profile-info` 只报告来源、选择和变量名，不读取凭据或联系服务。
acpx 默认 deny-all/noninteractive-deny；OpenCode 项目配置合并仍按原生规则。

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
真实 Linux `env bash -c` 首次/缓存启动及恢复/数据保留，不 apply 或使用集群。
Python fixtures 另核 root/UID65534、安全 PVC group、PATH 和私有文件边界。
本地检查不证明真实服务健康，也不发布、激活模板或重启 Workspace。

## License

模块沿用仓库 Apache-2.0 许可。安装的 OpenCode 保留
[MIT notice](LICENSE.opencode) 及已校验发行包中的许可；acpx/npm 依赖保留上游 notice。
