# OpenCode 任务与持久回调

当前任务入口为 `opencode-task launch`，复用固定 OpenCode **v2.2.0-ricky.1**、
私有 Node **22.23.4** 和 acpx **0.21.1** 的共享持久 session、队列、执行和 journal。
安装生成稳定 `bin/opencode-task`，启动调用 `recover`；Terraform 输出带 shell quoting 的
`opencode_task_command`。安装保留 runtime、旧版本和卷上其他目录，详见 [README](README.md)。

## CLI

```sh
opencode-task launch --input-file /private/task-inputs/new.json
opencode-task launch --continue-from task_<64位摘要> --input-file /private/task-inputs/follow.json
opencode-task status task_<64位摘要>
opencode-task result task_<64位摘要>
opencode-task list --state ambiguous --limit 10
opencode-task inspect task_<64位摘要>
opencode-task doctor
opencode-task doctor --quick
opencode-task recover
opencode-task recover task_<64位摘要>
opencode-task cancel task_<64位摘要>
```

公开 `submit`、其 prompt/callback/policy 文件选项、手工 session 选择和 `resolve` 已删除。
不接受 `start` 或 `base_sha` 输入。内部 `TaskRunner.submit` 是 launch 的持久提交原语，
不是第二个公开流程。`_worker/_observe/_supervise/_fail_launch` 和 `_selection` 是模块内部入口。
status 的 session 名称统一使用 session_name，删除重复 session 别名；launch 响应的 session 保留。
查询与恢复/cancel 的职责分开；不要用 recover 当只读检查。

## 高层 launch 入口

Agent 沿现有工具完成三次调用：

1. 调用 `create_task_callback`，取得完整原生注册对象，遵守该工具 schema 和已授权范围。
2. 用文件写入工具将 JSON 写到仓库外的私有文件，原样放入 `callback`。父目录由当前 UID
   拥有、mode 0700；文件是当前 UID 的普通文件、单链接、mode 0600，整条路径无 symlink。
3. Workspace Bash 只执行上面的 launch 命令并传文件路径。不要将注册写进 shell -c/heredoc、
   echo/argv、环境、业务 prompt 或日志。无新增 MCP tool。

```json
{
  "schema_version": 1,
  "key": "review-1",
  "repo_path": "/workspaces/project",
  "branch": "feat/review-1",
  "worktree": "project-review-1",
  "prompt": "完成已授权修改并报告实际测试。",
  "callback": {
    "callback_id": "<原生工具返回的私密值>",
    "callback_url": "https://chat.example.invalid/api/agents/task-callbacks",
    "max_output_bytes": 32768
  },
  "permissions": { "mode": "approve-reads", "policy": { "autoDeny": ["edit"] } },
  "provider": "codex",
  "model": "gpt-6.1-sol",
  "variant": "max"
}
```

新任务要求上述前七个字段（直到 callback）；只有 permissions/provider/model/variant 可省略。
key 为 1～256 字符，无控制字符或 `tcb_`；prompt 非空，UTF-8 最多 1 MiB。
完整 callback 最多 4096 字节，原生 expiry/guidance 等附加字段保留在输入指纹中。
整个文件最多 1 MiB+16 KiB。prompt、名称和权限策略不能含 callback bearer/URL。
输入与选择在 Git 修改前校验，未知字段或无效组合明确失败。

repo_path 须是无 symlink 的绝对 Git checkout 顶层，已有 origin。worktree 为 1～64 位名称，
首位字母/数字，其余字母、数字、下划线或连字符；目录固定为 repo 的父目录加此名称。
branch 最长 240 字符，按 `/` 分段，每段首位字母/数字，其余允许字母、数字、`.`、`_`、`-`；
禁止 HEAD、`..`、尾点、`.lock` 和 `tcb_`。

Git 沿调用者 HOME、SSH 身份、hostkey、PATH 和网络环境运行，只清除仓库/index/对象路由变量。
新任务成功 fetch `origin refs/heads/main` 到本次专用 ref，再保存完整 SHA、创建显式 branch/worktree。
不使用旧 origin/main，不更新原 checkout 的 main，不要求无关 checkout 干净。
已有 branch/目录保留并报冲突；不 stash/reset、覆盖、强推、换目标名称或自动删除。
Git stderr、remote 值不进入输出或记录。

新任务自动建立 session。省略选择时保存当前解析值，内置为 codex/Sol/max、同 Provider
title/low。provider/model 分开填 ID，variant 独立；只填 variant 调整默认模型。
指定 provider/model 且省略 variant 时使用目标模型默认值，Sol=max、Astra=medium。
完整配置优先级、四变量独立校验和过滤见 [PROVIDERS.md](PROVIDERS.md)。

permissions 为 `{mode,policy}`。mode 仅允许 deny-all、approve-reads、approve-all；新任务默认
deny-all。approve-all 须已有用户对该轮修改/命令的授权，不扩大授权，也不因拒绝自动升级。
policy 沿原生 acpx PermissionPolicy：autoApprove/autoDeny/escalate 各最多 32 个非空规则，
每条最多 256 字符且无控制字符；defaultAction 为 approve/deny/escalate，未知字段拒绝。
匹配沿原生工具名/title/kind 的大小写不敏感精确匹配或 `*`；非交互 escalation 仍拒绝。
例如 approve-all 配 `{"autoDeny":["edit"]}` 仍拒绝匹配写入。策略保存在该轮指纹，worker、
恢复和 cancel 使用已存策略，不读旧输入文件或改全局配置。

### 续接与同 key 重试

续接只要求 schema_version/key/prompt/callback，可带 permissions/provider/model/variant；
不接受 repo/branch/worktree。须从最新一轮可信 launch 续接，复用 repo、branch、worktree、
base SHA、session 和模型配置，不再次 fetch。省略权限沿保存值，显式覆盖只作用于该轮。
原请求须有 canonical 终态、排队取消或派发前 setup failure，并已有可信 backend session 身份。
running、queued、结果未知或监督通知不能授权第二个写入者；不从 PID、status 或 queueDepth
推断停止。会话缺失/变化则在派发前拒绝，不自动建新会话替代上下文。
续接轮在派发前失败/取消，可继续使用其保存的上轮可信身份，执行前再次核对。

续接省略选择沿原值，显式相同选择可用；切换报 SESSION_MODEL_CONFLICT。
固定 OpenCode 原生支持 ACP model/effort 控制，但 acpx 0.21.1 公共共享接口不能把完整
请求/profile/effort 与某条排队 prompt 原子绑定。控制还可能影响原 turn，单改 model 也不能
保证 title Provider 随之切换。因此不切换、不搬迁历史、不自动替换 session。

key 在 profile/Git 写入前领取，私有 `.launches/task_<key摘要>.json` 保存输入指纹、阶段、
对象身份、选择、策略和任务关联，不另存 prompt/完整 callback。submit.lock 串行整个准备链，
Git 继承该锁；CLI 退出后仍等待运行中的 Git 释放。每条续接链只有一个最新轮次。
同 key/同输入复用准备和 task/request，异输入报 LAUNCH_CONFLICT。

成功 fetch 的专用 ref 固定 base，保存 SHA 前中断也能恢复。branch 通过专用 reflog 标记核对。
worktree 先在同父目录的私有暂存目录保存 inode，再用 Linux/glibc renameat2(NOREPLACE) 原子
发布并由 Git 注册。部分准备对象不删除；身份、Git common dir 或 branch 不符则拒绝。
若创建暂存目录后尚未保存身份就中断，归属无法证明，保留并报冲突，须人工核对。
提交响应丢失后核对原 task 的指纹关联，只接管原 monitor/outbox，不再次发送 prompt。

成功输出 version/key/task_id/request_id/accepted/stage/reused、实际 Git/session 标识、
selection、权限摘要和 durations_ms。selection.status=resolved 只表示解析完成。
accepted=true 仅表示请求已 fsync 且 detached monitor 确认接管，或原任务已完成投递；
不证明 ACP/模型已收到。monitor 确认等待最多 10 秒。准备阶段为 validate、claimed、fetch、
branch、worktree_directory、worktree、input、submit、accepted；耗时来自本地单调时钟。
失败退出 1，安全 JSON 增加 error.code/hint 和 outcome_unknown；未知标识为 null。
outcome_unknown 表示可能留下部分对象或接管未确认。保留原 key/输入/注册重试，
不要自动换 key 重做未知业务。monitor 启动失败的内部回退持有两把任务锁，重新确认未执行，
只封存 setup error 并继续原 outbox；锁被其他进程占用时不抢权。未投递记录留给 recover。

## 当前持久格式边界

只维护当前字段齐全的 task.json `version: 1`：必须有 model、绝对 modelConfig、
modelProfile=env|external、permissions、整数 createdAt；封存记录还须有布尔 outputTruncated。
已有当前记录无需含 launch 元数据即可查询/原请求恢复，但只有可信 launch 元数据允许续接。
旧的 operator_resolution 记录不再受支持。session 绑定须匹配 cwd、选择和配置快照；
无模型绑定的旧 session 不能被新任务接管。

不支持的记录返回 UNSUPPORTED_TASK_RECORD。status/result/inspect、定向 recover/cancel
退出 1；list 将该项放入 errors，coverage 不完整。无参数 recover 跳过这些记录并在
`unsupported:[{task_id,code}]` 中明确列出，继续恢复当前记录，退出 0 表示此轮扫描/派发完成，
不表示所有历史都受支持。安装启动调用同一恢复逻辑。旧格式不补默认选择、不迁移、不改字节，
不投递或重放。保留原数据和原安装版本供负责人独立核实；本版本不承诺旧格式的完整恢复。
坏记录、unsafe 属性和读错误仍失败关闭，不作为可跳过的旧格式。

## 执行、恢复与持久 outbox

runtime/tasks 的 owner 标记绑定 UID/Workspace。目录 0700、记录 0600；原子替换与文件/目录
fsync 保证合作进程的持久接受。per-task worker.lock 只允许一个 driver。
继承 [安装信任边界](README.md#存储与启动)，不是防 root/同 UID/可信 group 读私有文件的沙箱。

模块使用 createSharedAcpRuntime、ensureSession、startTurn 和 watchSession({handle,cursor})。
先持久写 dispatching，再发 prompt；原 request 的 turn.result 或 journal turn_result 才能完成。
只收集 assistant output，不收 thought/工具；新 message ID 替换中间文本，按 UTF-8 限额裁剪。
终态先到时每个输出通道最多排空 250 ms，不让挂起的 events/promptStarted 阻止封存。
不等待 idle owner/agent 退出。失败输出是安全程序原因，不附原始 Provider 错误或部分 assistant 声明。

queued 且从未尝试的任务可执行；worker 在 dispatch 前丢失则封存 setup error。
dispatching/running/ambiguous 只找原 session/request 被动观察，output 和 cursor 一同保存。
其他 request 不能完成本任务。共享连接的 failed 先核原 journal；WATCH_OUTCOME_UNKNOWN
仍是未知。请求 ID 不是业务幂等键，时间流逝、owner 缺失或 driver 退出均不授权重放。
被动观察和 outbox 恢复不要求 Provider 凭据；queued 执行仍需当前启动环境。

cancel 只针对原 request ID。queued 取消不执行业务；已 dispatch 则发请求级 cancel_prompt RPC，
等待原 canonical result。不能用 RPC 回复或进程退出宣称停止，也不调用 session-wide cancel。
原生 helper 带 owner 健康清理回退，行为不等价；模块保留固定版本的 socket/generation 校验和
3 秒取消等待。升级 acpx 须重验私有 wire format。driver 在 journal 前丢失的排队请求可能
一直未知，不能据此重放。同 session 其他排队请求必须保持隔离。

封存后只发送下列 body，精确字节先 fsync，重试不再生成：

```json
{"version":1,"callback_id":"<私密 bearer>","status":"success","output":"有界结果"}
```

一次注册只有一个封存 body。仅 success/error/cancelled；不附输入、mode、metadata 或认证头。
URL 仅允许 HTTPS（loopback fixture 可 HTTP），路径固定 `/api/agents/task-callbacks`，
拒绝用户信息/query/fragment 和重定向。只保留最多 4096 字节的有效 202 receipt
`{version:1,receipt_id,accepted_at}`；它仅证明存储和恢复队列接管，不证明后续推理完成。
网络/receipt 丢失、坏成功 receipt、408/425/429/5xx 按原字节重试。退避从 5 秒到 5 分钟，
Retry-After 可延至 24 小时，deadline 持久化。其他状态成为 rejected。
不按本地 expiry 丢弃 outbox：相同重试可能取回过期前已经封存的 receipt。

## 监督策略与边界

每任务一个持有 monitor.lock 的监护和一个持有 worker.lock 的 worker。监护直接等待自己
创建的 child，不从保存 PID 发信号。worker 心跳丢失先怀疑，连续 confirm 且至少两次检查后
只停止自有未回收 child，等 exit 再观察原请求。Linux parent-death signal 在监护退出时停止
其 worker，独立 acpx owner 继续。监护重启不重发已可能执行的 prompt。

只读 owner lease 并匹配 generation、boot/namespace/start ticks。lease 心跳须在过去 15 秒内；
未来时间、PID 复用或 namespace 不匹配不算健康。不调用会清理 owner 的 CLI health helper。
generation 变化不证明请求被接管；只有原 request 的新进展可与恢复的 lease 配对并撤销怀疑。
lease 中断时保留待配对进展。原请求持续的新事件优先于短时 lease 缺失。
acpx 公共共享接口不能证明队列成员或 agent 实时心跳，health.agent 始终 unknown。

没有固定总执行时长。原请求 ACP 通知、thought、工具状态、压缩和 Provider retry 都算进展；
其他 request 不延长本任务期限。普通阶段默认无进展 15 分钟，活动工具按 ID 跟踪、宽限 6 小时；
retry 等到 nextRetryAt 后再加普通宽限。健康 owner 下始终无原请求确认，也只等待普通 progress。
owner/session/journal 持续不可确认按 discovery；重连不刷新静默时间或缩短已有进展预算。

超过阈值后仍须连续 confirm、至少两次检查；新进展、有效 owner 或终态撤销相应怀疑。
采样间隔超过 `2*(poll+probe)` 会重启确认，避免监测进程长暂停后立即通知/杀 worker。
心跳读取错误和超时原因切换重新确认；最后有效心跳已过期后固定按超时判断，不反复续期。
心跳/记录以 O_NOFOLLOW|O_NONBLOCK 打开，在同一 fd 核普通文件、当前 UID、私有 mode、单链接；
只有其他属性安全的 nlink=0 可有界重开三次。小型心跳上限 16 KiB；失败样本不更新进展预算。

同 boot/time namespace 的恢复沿保存的单调时间；进程内 retry 使用单调期限。跨 boot/namespace
或缺证据时取 wall-clock 差值并重新连续确认，不重赠完整静默期。journal 事件无生成时间，
“新进展”只指 cursor 后新观察到的事件，不能证明远端实时活跃。
setup 超时先 SETUP_SLOW，继续等待同一个 ensureSession promise 至多 confirm，不重复初始化。

| 环境变量 | 默认毫秒 | 用途 |
| --- | ---: | --- |
| OPENCODE_TASK_POLL_MS | 5000 | 心跳/观察间隔 |
| OPENCODE_TASK_PROBE_MS | 3000 | 被动观察/findSession/detach 上限 |
| OPENCODE_TASK_DISCOVERY_MS | 30000 | 原请求及 owner 不可确认窗口 |
| OPENCODE_TASK_SETUP_MS | 30000 | 初始化/选择确认 |
| OPENCODE_TASK_WORKER_MS | 30000 | worker 心跳期限 |
| OPENCODE_TASK_CONFIRM_MS | 30000 | 连续确认；setup 额外等待 |
| OPENCODE_TASK_PROGRESS_MS | 900000 | 普通静默/retry 宽限 |
| OPENCODE_TASK_TOOL_MS | 21600000 | 活动工具无进展宽限 |
| OPENCODE_TASK_DRAIN_MS | 250 | 终态后每通道排空 |

各值仅允许 10～86400000 整数；worker 至少 3*poll，discovery 至少 probe。
连续调度、磁盘可用和 probe 受限时，阈值后确认额外最多 confirm+2*(poll+probe)，
worker 心跳额外 confirm+2*poll；detach 另加至多 probe，callback 每次网络等待至多 30 秒。
CPU 饥饿、暂停、磁盘不可写或整个 Workspace 停止时没有实时保证，也没有外部监护服务。

监督失效沿原 outbox 封存 error 通知，明确结果/副作用未知、可能仍在执行、不可自动重试。
任务保留 ambiguous，result_status 和 terminal_at 为 null；callback_kind=supervision_failure，
其 callback 状态与业务终态分开。后续成功不改已封存字节或投递第二个结果。
通知不取消原请求或终止共享 owner/agent；通知后仍可定向 cancel，但通知不变。
负责人须独立核实原 request/session 后再授权新动作。静默策略不证明模型或工具死亡。

## 只读查询与离线安装自检

list/inspect/status/result/doctor 不初始化存储、不建锁/配置、不恢复/取消/执行或投递 callback，
不要求 Provider key。不存在的存储明确报告 TASK_STORE_MISSING。只有 result 返回封存 output，
其他查询不返回 prompt/output/callback/cwd/原始错误。错误为安全 JSON，命令级失败退出 1。

list 支持精确 state=queued|dispatching|running|ambiguous|outbox|delivered|rejected 和 session 名
筛选。默认 limit=20、scan-limit=100，上限 50/200。每条记录最多 8 MiB、每页最多 32 MiB。
行仅含有界任务/request/session 标识、执行/回调状态和 timing；不读 journal/心跳、不算全库总数。
coverage 分别列目录项读取、推进、成功投影、失败和读取字节，须连同 items/errors 解释。
stop_reason 为 limit/scan_limit/read_budget/end；remaining_records 始终 null。
next_cursor=null 才是采样到目录末尾；complete 仅指本页到末尾且无错，不证明历史全库完整。
空 items 不表示空库；未检、失败和未匹配不同。

游标使用 Linux x86-64 glibc 目录 cookie，不排序、不从头扫描。续页须保持筛选；目录身份变化
报 CURSOR_STALE，重查并按 task_id 去重。libc 可预读固定目录块。逐记录及跨页非事务快照。
常见安全码：INVALID_ARGUMENTS/INVALID_CURSOR、TASK_NOT_FOUND、TASK_RECORD_TOO_LARGE、
TASK_READ_BUDGET、TASK_RECORD_CHANGED、INVALID_TASK_RESULT、UNSUPPORTED_TASK_RECORD、
UNSAFE_TASK_FILE/UNSAFE_TASK_DIRECTORY。保留原记录，不修改权限/元数据来消除错误。

result 返回 task_id/request_id/session_name/session_key/session_id/acpx_record_id；backend session
ID 不用 acpx record ID 代替，未知为 null。state 是记录的执行器状态，result_status 是封存
success/error/cancelled，独立于回调是否投递。output 只读封存 body，非终态为 null。
output_limit_bytes 取注册较小限额，默认/最大 32768；计 UTF-8 文本，不含 JSON 转义。
output_bytes/truncated/available 明确说明裁剪与扣留。完整输出含 `tcb_` 或保存的 callback URL
则扣留整个 output 并报 PRIVATE_CALLBACK_CONTENT，不改 sealed body；业务敏感文本仍须按授权读取。

timing 使用本地 Unix wall-clock 毫秒：accepted_at 是首次 createdAt，started_at 仅在
promptStarted 保存，terminal_at 是本地封存观测，callback_attempted_at 是最近 POST 前时间，
callback_delivered_at 是确认有效 receipt 时间，supervision_failed_at 是监督通知时间。
缺证据为 null，不以首次恢复观察代填 started，不把墙钟差当 CPU 时间或远端事件精确时刻。
evidence 区分 turn.result/watchSession.turn_result/queued_cancellation/execution_setup_failure/
supervision_failure；output_source 为 assistant_output/program_generated。receipt 只证明 handoff。
assistant 声称的测试/SHA 不由执行器核实，也不要求模型维护结果文件。

inspect 沿 status 投影且无 output，增加 worker attempt/dispatch 时间、original request 是否
观测到、durations、observations 和回调重试信息。队列成员、agent 存活、真正死锁均 unknown。
duration 缺端点为 missing_timestamp，反向墙钟为 wall_clock_reversed，其余是 wall_clock_difference。
observations 的 freshness 仅解释历史样本：health/probe 阈值为保存策略 2*(poll+probe)，monitor
为 2*poll、worker 为 workerMs、owner 为 15000；未来时间 age=null，缺阈值/时间为 unknown。
recent 不证明实时健康。各采样文件非同时读取，查询不读 journal。retry_count 是安排重试的
次数，成功/拒绝那次不增加，不等于完整 HTTP POST 数；next_attempt_at 过期不证明 monitor 活着。
未知历史原因只报 UNKNOWN_RECORDED_CODE，不输出原文。

doctor 默认 full；--quick 明确跳过两个大二进制内容/哈希。两种模式都核 active 绑定、wrapper
精确脚本、私有布局/owner、inventory、小型启动链摘要、release metadata、Node/acpx pin、
status capability 和 profile 说明。大二进制均沿同 fd 校验类型、属主、mode、单链接、大小和
可执行位；quick 的 metadata 检查不冒充内容校验。版本证据是 installed_inventory_and_metadata，
executed=false，不运行工具 --version、Node、agent、Provider/MCP 或 callback。
遇首错即停，checks 区分 ok/failed/not_checked；不能把后续项算通过。
二进制上限分别 352/160 MiB，manifest 8 MiB，其余各 1 MiB；不递归扫依赖或任务历史。
not_checked 明列外部配置内容、服务健康、agent 执行、任务历史、完整依赖 inventory 和运行时
版本执行；quick 另列二进制内容/哈希。ok=true 只表示所选模式完成。
稳定 wrapper 缺失时可从已审阅源码运行：

```sh
python3 -B opencode/scripts/diagnostics.py --root /mnt/opencode/toolset --quick
```

<a id="verification-and-rollout-boundary"></a>
## 验证与交付边界

```sh
python3 -B -m unittest discover -s opencode/tests -v
python3 -B opencode/build_bundle.py --check
node --test opencode/tests/task.test.mjs opencode/tests/task-supervisor.test.mjs opencode/tests/task-launch.test.mjs opencode/tests/task-read.test.mjs
(cd opencode/scripts && npm ci --ignore-scripts --no-audit --no-fund)
env -i PATH=/usr/local/bin:/usr/bin:/bin node --test opencode/tests/runtime.test.mjs opencode/tests/cli-fixture.test.mjs opencode/tests/cli.test.mjs
# 可选：把正式 OpenCode 复制到隔离目录后，仅连接本地 Responses/callback。
env -i PATH=/usr/local/bin:/usr/bin:/bin OPENCODE_FIXTURE_BINARY=/private/fixture/opencode node --test opencode/tests/published.test.mjs
```

测试保护同 key 全准备去重/并发/部分恢复/响应丢失、fresh main、脏工作保护、可信续接与选择、
权限隔离、原请求取消/恢复、原字节 outbox、未知不重放、连续确认/单调时间、有界只读和安全失败。
完整 CLI 仍用真实 pinned acpx 和合成 ACP peer；内部队列测试直接使用 TaskRunner.submit，
不恢复已删除的公开流程。故障 fixture 先按出生身份停止自有进程，再清理隔离目录；失败保留原根
与首错，不用清理异常覆盖它。历史未解超时及 SQLite 故障见 [UPGRADE.md](UPGRADE.md)。
没有真实 Provider/MCP/QQ 或付费推理；本地通过不等于模板/Workspace/平台 Skill 已更新。
