# OpenCode 任务与持久回调

`opencode-task` 是可信本地、单人使用的薄任务层。固定 OpenCode **v2.2.0-ricky.1**、acpx **0.21.1**、
Node **22.23.4**。每 task 只有一个后台 control，执行或观察原 request，并处理 outbox。
安装、Workspace 启动和查询均不自动恢复。没有 monitor、租约、健康探针或自动接管。

## CLI

```sh
opencode-task launch --input-file /private/task-inputs/new.json
opencode-task launch --continue-from task_<64位摘要> --input-file /private/task-inputs/follow.json
opencode-task launch --help
opencode-task status task_<64位摘要>
opencode-task result task_<64位摘要>
opencode-task list --state ambiguous --limit 10
opencode-task doctor --quick
opencode-task recover [TASK_ID]
opencode-task cancel TASK_ID
```

launch 是唯一公开派发入口。submit/resolve/inspect 不公开。`_run`、`_selection` 为内部入口。
help/version、list/status/result/doctor 只读；不创建存储、锁或配置，不要求 Provider key。
recover 有副作用，须显式调用。cancel 只针对原 request。

## 高层 launch 入口

Agent 调用原生 `create_task_callback`，将完整返回对象原样写入私有 JSON，再用 Workspace Bash 调用 launch。
输入在仓库外；父目录 0700、当前 UID 拥有，文件为 0600 普通单链接文件，整条输入路径无 symlink。
callback 不进入 shell 文本、argv、环境或业务 prompt；不要另存一份 bearer。

```json
{
  "schema_version": 1,
  "key": "review-1",
  "repo_path": "/workspaces/project",
  "branch": "feat/review-1",
  "worktree": "project-review-1",
  "base": "main",
  "prompt": "完成已授权修改并报告实际测试。",
  "callback": {
    "callback_id": "<原生私密值>",
    "callback_url": "https://chat.example.invalid/api/agents/task-callbacks",
    "max_output_bytes": 32768
  },
  "provider": "codex",
  "model": "gpt-6.1-sol",
  "variant": "max",
  "no_progress_timeout_seconds": 900
}
```

新任务必填 schema_version/key/repo_path/branch/worktree/prompt/callback。未知字段拒绝。
key 为 1～256 字符；prompt 非空、最多 1 MiB；callback 最多 4096 字节；整个输入最多 1 MiB+16 KiB。
名称和权限策略不得含 callback bearer/URL。输入和选择在 Git 写入前校验。

repo_path 是绝对 Git 顶层且有 origin。worktree 为 1～64 位名称，首位字母/数字，其余为字母、数字、`_`、`-`，
目录固定在 repo 的父目录。branch/base 最长 240 字符，按 `/` 分段；段首位字母/数字，其余允许字母、数字、`.`、`_`、`-`。
拒绝 HEAD、`..`、尾点、`.lock`、`tcb_`、选项和 revision 表达式。

base 为 origin 的分支名称，省略 main。新任务 fresh fetch 到本次独立 ref，保存完整 40 位 base_sha。
不使用缓存或同名 tag，不更新原 checkout 分支。已有分支/目录报冲突，不覆盖、stash/reset 或自动清理。
Git 身份、参数、PATH 和主机信任见 [README](README.md#git-ssh)。

### 权限与续接

新 launch 缺省 **approve-all**。可显式设置 `permissions: {"mode":"deny-all"}` 或 approve-reads。
policy 的 autoApprove/autoDeny/escalate 各最多 32 条，每条 1～256 字符；defaultAction 为 approve/deny/escalate。
回执仅显示固定安全规则名及扣留数量，完整规则不公开。原生 policy 拒绝、非交互 escalation 拒绝继续生效。
这些默认值只影响模块工具能力，不增加业务授权或平台 Agent/MCP ACL。

continue 只接受 schema_version/key/prompt/callback，以及可选权限、选择、时限。不接受 repo/branch/worktree/base。
省略权限沿原保存值，不追溯放权；显式权限只作用本轮。模型/profile/variant 固定，显式相同值可用，改变则报 SESSION_MODEL_CONFLICT。
保留原 repo、branch、worktree、base、SHA 和 session，不重新 fetch。每轮时限省略为 900 秒。
完整四变量与模型契约见 [PROVIDERS](PROVIDERS.md)。

续接须从最新一轮可信 task 开始，有 canonical 结果或明确派发前失败/取消，并有可信 backend session 身份。
通知已投递、control 退出或 owner 缺失不能证明业务结束。未知时不启动第二个写入者。
派发前取消的续接轮保留上轮已确认的 session 身份；执行前再次核对，不建立替代 session。

### 去重与 Git 中断

固定 key 对应 task_id。`.launches` 的排他 claim 在 profile/Git 写入前领取；同 key 竞争只允许一方准备/submit。
claim 用完整输入指纹去重，不保存 prompt 或 callback。完整相同输入复用原 task/request；不同输入报 LAUNCH_CONFLICT。
显式 base 与省略 base 是不同输入。重试保留原输入，不重新 fetch 或更改已存 SHA。

**fail_closed_on_partial_git_preparation**：有 claim、无完整 task 时拒绝自动续完，报 GIT_PREPARATION_INTERRUPTED。
用回执的 `query.status` 直接查同一 TASK_ID；status 返回计划路径、对象当前存在性及人工核对动作。
计划 worktree 不证明已建立 Git worktree，session 名不证明 backend session 已创建。
此时 recover 不适用。不得换 key 自动重派，不自动 resume/replay/cleanup。
同 key 并发时，后到者也可能看到准备中断；首个完成后可用原输入复用原关联。

## 回执、错误与查询

成功和失败都返回已知的 repo/branch/worktree/base/base_sha、task/request/session、selection、权限、时限、reused、continue_from。
`query` 给出使用模块 wrapper 绝对路径的 status/result 命令和新 namespace 的 task_directory。它不是已生成报告或日志。
backend session_id/started_at 未取得时为 null，不阻塞 accepted 等待它们。

| 字段 | 含义 |
| --- | --- |
| accepted | 保留原 ACK 语义：control 已确认接管，或原结果无需补投；不证明模型收到或 started。 |
| task_recorded | true：task 已保存且关联确认；false：本次尚未到 submit；null：写入/fsync 或原关联不能确认。 |
| claim_recorded | true：claim 已保存/读到；false：本次未领取；null：claim 写入持久性不能确认。 |
| dispatch_state | not_reached：当前证据尚未到 startTurn；attempted：已落盘派发尝试，不等于模型收到；unknown：可能已尝试。 |
| unknown_scope | preparation、storage、request 的数组；指出准备现场、持久性或原请求不确定性。 |
| outcome_unknown | unknown_scope 是否非空；不是“业务目标未完成”的自动标记。 |

首次 fetch 失败：accepted=false、task_recorded=false、claim_recorded=true、dispatch_state=not_reached，未知范围仅 preparation。
submit fsync 失败可能已有可读 request；task_recorded=null，但本次不启动 control。
ACK 丢失时 dispatch_state 可为 unknown。最后 claim 写入失败可同时 **accepted=true + TASK_WRITE_FAILED**；仍观察原对象，不再次 submit。
task_id 存在不证明 task 已存在；可读文件也不证明失败 fsync 已完成。status 是当前只读采样，不补写或倒推历史 fsync。

失败退出 1。error 只保留固定 code/stage/field/category/reason/action/hint、安全句柄、允许的变量名/HTTP 状态。
Git 另返回数值 git_exit_code、启动 git_errno、允许的 git_signal；必要时有固定 SSH_HOST_KEY_VERIFICATION_FAILED 或 SSH_OPTIONS_UNSUPPORTED。
exit 128 不代表认证失败。stderr 只在内存有界匹配后丢弃；不返回 remote、用户名、公钥、凭据、原 cause/stack。
不解析自然语言、assistant 拒绝或 retryable 来猜 Provider policy/auth。明确 ACP 认证/权限拒绝分别为 REQUEST_AUTH_REQUIRED/REQUEST_PERMISSION_DENIED。

status/result 区分 execution、observation、delivery 错误。REQUEST_FAILED 是 canonical 失败；REQUEST_OUTCOME_UNKNOWN/TURN_TRANSPORT_INTERRUPTED 是观察未知。
NO_PROGRESS 通知不证明原请求结束；CALLBACK_REJECTED/REDIRECT_REFUSED 不更换地址或重派业务。
TASK_WRITE_FAILED/CONTROL_ACK_UNKNOWN 先查原 task；需要时只显式 recover 原 request/原 body。
坏 JSON、缺失、超限或不支持格式均报错，保留原字节，不授权重放。

result 直接返回 canonical output、callback_output 和已有 delivery/receipt 字段。无 canonical 时 result_status/output/terminal_at 为 null。
晚到 canonical 结果和已封存 callback 分开；receipt 只证明 handoff。输出按注册限额裁剪（默认/最大 32768），
含 `tcb_` 或保存 callback URL 的文本扣留。业务敏感输出仍须按授权读取。

list 用普通目录列表、排序和 state/session 筛选。默认 limit=20，最大 50；最多读 200 个 task，每记录最多 8 MiB。
返回 records_checked、truncated 和逐项 errors；无 cursor、目录指纹、coverage 或全库索引。空 items 不保证无其他任务。
claim-only 用已知 TASK_ID 的 status 查询。doctor 默认 full 校验安装 inventory；--quick 跳过二进制内容/哈希。
doctor 不扫描任务，不执行版本或访问 Provider/MCP。离线自检不证明服务健康。

## 当前持久格式

源码新版本只读写 **runtime/tasks-v3/** 中的 **version: 3** task/claim，无旧 v1/v2 兼容或迁移。
旧 runtime/tasks、session、cache、private 和 installed 均不扫描、不删除、不自动 adopt；清理由负责人另阶段处理。
任务查询信任本地用户，不逐祖先/UID/inode/hardlink 检查，不加读锁或跨文件快照。
私密输入写前保护、发行包验证和安装回退仍保留，见 [README](README.md#存储与启动)。

task 写入使用小型 atomic replace，文件及目录 fsync；claim 排他发布，防意外双提交。
无全局 submit/目录锁，不把 flock 描述符传给 Git。每 task 只有 nonblocking control.lock，防重复执行/投递。
不防 root、同 UID 或恶意本地用户，不保证并发跨文件事务快照。

## 执行、统一时限和显式恢复

默认连续 **900 秒**无原 request 执行事件，整数 override 范围 1～86400 秒。起点是持久接受时间。
初始化、排队、执行共用期限；阶段变化、findSession、重连、空轮询、其他请求和读查询不续期。
原 promptStarted、文本、thought、工具等执行事件续期；只收集 assistant 文本，thought/工具不进入业务结果。
不同 message ID 替换中间回答。只有原 canonical turn.result/journal turn_result 才结束请求。

派发前先落盘 dispatching；从这里起可能已发送，响应丢失仍未知，不重发。
queued/preparing 显式 recover 只封存未派发失败或排队取消；其余阶段只观察保存的 session/request/cursor。
无日志、owner、结果或时间流逝均不授权重放。通信失败不伪装 canonical 失败。

到期后先持久封存一次 unknown error 通知；不自动取消或重发。原 control 继续 passive observe，晚到 canonical 独立保存，不覆盖 body 或二次 callback。
断线和显式恢复沿剩余期限；同 boot 用单调起点，跨重启用原墙钟差，不重赠完整期限。
control 可调度时约 200 ms 检查；网络投递异步、每次最多 30 秒。磁盘不可写、进程停止或 Workspace 停止时无及时通知保证。
只有显式 recover 恢复观察/补投。cancel 只保存意图并向原 request ID 发 cancel_prompt，canonical cancelled 才是业务终态。
不影响同 session 其他 queued 请求，不调用 session-wide cancel。

## 持久 outbox

每注册只封存一个 exact body，先 fsync 再 POST：

```json
{"version":1,"callback_id":"<私密 bearer>","status":"success","output":"有界结果"}
```

仅 success/error/cancelled，无输入/metadata/认证头。URL 仅 HTTPS（loopback fixture 可 HTTP），固定 `/api/agents/task-callbacks`，拒绝用户信息/query/fragment/重定向。
最多读取 4096 字节 202 receipt `{version:1,receipt_id,accepted_at}`；有效 receipt 后停止补投，只证明 handoff。
网络失败、无效 receipt、408/425/429/5xx 重试原 body；退避 5 秒～5 分钟，Retry-After 最多 24 小时，期限保存。
其余状态 rejected。不因 expiry 丢弃 outbox；进程退出后须显式 recover。

## 下游交接

callback 后按已有结果继续，不重复读取已确认的 status/report/diff。下游 prompt 需带已核门槛：实际 repo、run_id、branch、完整 SHA、status、conclusion 和核对时间。
continue 只补增量，并写明已完成步骤。不解析报告文字虚构自动业务成功标记，也不把 accepted 当成 started。
平台 Task Running 人读文案、PTC 样例和 Skill 由平台负责人同步，本仓不改宿主或机器触发条件。

<a id="verification-and-rollout-boundary"></a>
## 验证与交付边界

```sh
python3 -B -m unittest discover -s opencode/tests -v
node --test opencode/tests/task.test.mjs opencode/tests/task-launch.test.mjs opencode/tests/task-read.test.mjs
python3 -B opencode/build_bundle.py --check
(cd opencode/scripts && npm ci --ignore-scripts --no-audit --no-fund)
env -i PATH=/usr/local/bin:/usr/bin:/bin node --test --test-concurrency=1 opencode/tests/runtime.test.mjs opencode/tests/cli-fixture.test.mjs opencode/tests/cli.test.mjs
env -i PATH=/usr/local/bin:/usr/bin:/bin OPENCODE_FIXTURE_BINARY=/private/fixture/opencode node --test opencode/tests/published.test.mjs
```

原生 OpenSSH 新/变化 key、host/port/alias 回环 fixture 另需测试环境的 paramiko 3.5.1；通过 PYTHONPATH 指向隔离依赖即可，不进 payload。
测试仅合成凭据、mock ACP、loopback。安装覆盖首次/缓存、普通 UID 和旧数据保留；Terraform render 固定 65536 预算，见 [README](README.md#validation-and-publication-boundary)。
不调用真实 Provider/MCP/QQ，不部署、激活模板、替换 installed 或重启 Workspace；fixture 通过不证明生产部署。
