# Detached OpenCode tasks and callback delivery

`opencode-task` adapts LibreChat's generic `create_task_callback` tool to pinned
**acpx 0.21.1**. It reuses the module's private Node, OpenCode wrapper, runtime HOME,
model selection, provider/MCP profile and permission defaults. No acpx patch,
session migration, parent-volume ownership change, or task dashboard is involved.

The installer bundles/fingerprints/inventories `task.mjs`, `task-read.mjs`, `diagnostics.py`, `task-cli.mjs`,
`task-acp.mjs` and `task-supervisor.mjs`, installs
`bin/opencode-task`, and invokes `recover` on startup. Terraform exposes the
shell-quoted `opencode_task_command`. Repeat installation preserves `runtime/tasks`,
old acpx/OpenCode sessions/cache, old versions, and all `/mnt/opencode` siblings
outside the module-owned `toolset` child.
Installation `status.json` advertises `features.task_callbacks: 1` alongside
`state: ready`. OpenCode follows the published **v2.2.0-ricky.1** release pin;
private Node is **22.23.4** and acpx is **0.21.1**.
正式 tag、asset、SHA256 和试点交接见 [UPGRADE.md](UPGRADE.md)。
This upgrade does not migrate task/session/cache data or change callback, recovery,
request-targeted cancellation or permission contracts.
The source bundle uses the bounded compressed
[startup transport](README.md#startup-execution-budget), so callback runtime growth
cannot silently exceed the Linux execution argument limit before installation.
The 6516ad1 gate rollout failure left the prior toolset intact; source readiness
and a successful Coder build do not prove that `opencode-task` was installed.

## CLI and private input

Pass the Agent tool's registration JSON on stdin or in a private 0600 file under
a private directory. It contains `callback_id`, `callback_url`, and optionally the
tool's smaller `max_output_bytes`; expiry/guidance may remain in the file. Callback
fields are never command arguments or environment variables. Keep them out of the
OpenCode prompt, logs, URLs and ordinary prose.

```sh
opencode-task submit --key ticket-123 --prompt-file ./task-prompt.txt --callback-file /private/task-registration.json
# Alternative: registration JSON on stdin, never bearer bytes in argv/env.
opencode-task submit --key ticket-123 --prompt-file ./task-prompt.txt < /private/task-registration.json
opencode-task submit --key copilot-123 --model copilot/gpt-6.1-sol --variant max --prompt-file ./task-prompt.txt < /private/task-registration.json
opencode-task submit --key astra-123 --model copilot/gpt-6-astra --variant high --prompt-file ./task-prompt.txt < /private/task-registration.json
opencode-task submit --key ticket-123-fix --session ticket-123 --permission-mode approve-all --prompt-file ./fix.txt < /private/fix-registration.json
opencode-task status task_<64-hex-digest-from-submit>
opencode-task result task_<64-hex-digest-from-submit>
opencode-task list --state ambiguous --limit 10
opencode-task inspect task_<64-hex-digest-from-submit>
opencode-task doctor
opencode-task doctor --quick
opencode-task recover
# Recover only the original task when inspecting an interruption:
opencode-task recover task_<64-hex-digest-from-submit>
opencode-task cancel task_<64-hex-digest-from-submit>
```

Submit returns `{version:1,task_id,request_id,accepted:true}` after fsync of the
private request and a detached per-task monitor's acknowledgement (10-second launch
bound). This is local durable acceptance,
not proof that ACP/the model already received the prompt. The monitor survives the
submitter. Use a stable caller-chosen `--key`: the same key/prompt/cwd/registration
returns the same task/request; changed data fails closed. `status` exposes
state/result status, permission mode, optional session name, safe lifecycle timing,
cancellation request and safe codes, never callback, prompt, output or raw errors.
The monitor observes worker exit and starts an original-request observer; it also
owns callback delivery. Monitor start failure returns CLI exit 1. Its fallback
takes both task locks and rechecks that no worker attempted execution before
sealing a safe setup error. It retains the monitor lock and retries the outbox;
an existing concurrent monitor keeps ownership.
An unsent outbox survives for startup or `recover TASK_ID`.

### 只读查询与离线安装自检

`list`、`inspect`、`doctor`、`status`、`result` 不启动模型、执行、observer、恢复、取消或
callback，不依赖 Provider key，不创建目录、锁文件、配置或任务，也不迁移、补写旧 schema。
没有安装或 tasks 存储时报告缺失，不能用查询来初始化。只有 `result` 返回封存业务 output；
其他入口不返回 prompt、output、callback 注册、cwd、原始错误或凭据。

```sh
opencode-task list
opencode-task list --state running --session ticket-123 --limit 5 --scan-limit 50
opencode-task list --state ambiguous --cursor '<上页 next_cursor>'
opencode-task inspect task_<64-hex-digest-from-submit>
opencode-task doctor
opencode-task doctor --quick
# 稳定入口或 active 缺失时，在已审阅的源码 checkout 中直接检查：
python3 -B opencode/scripts/diagnostics.py --root /mnt/opencode/toolset
python3 -B opencode/scripts/diagnostics.py --root /mnt/opencode/toolset --quick
```

`list` 的 `--state` 精确匹配 `queued|dispatching|running|ambiguous|outbox|delivered|rejected`。
这是记录的执行器状态，不是实时健康；监督通知已 delivered 的任务仍可为 ambiguous。
`--session` 精确匹配提交时的 session name，不按 backend session ID 匹配。两项可组合。
默认 `--limit 20`、`--scan-limit 100`，上限分别为 50 和 200，均为正整数。

列表行复用 result 的安全元数据：`task_id`、`request_id`、`session_name`、`session_key`、
`session_id`、`acpx_record_id`、`state`、`result_status`、`callback_status/state/kind`、`timing`。
未知标识和时间为 null。列表不读心跳、journal 或业务日志，不计算全库总数。
每条 task.json 最多读取 8 MiB，每页最多读取 32 MiB 记录；超限不解析。各字符串有类型和
长度限制，最多返回 50 行及 200 条安全错误，不把历史原文拼入响应。

`coverage` 必须和 `items` 一起读取：

- `directory_entries_read` 是本页 helper 取出的目录项数，最多 scan-limit；包括隐藏的非任务项。
  libc 可在内部预读固定大小目录块，不加载整个目录。小 limit 仍可能预取本页剩余目录项。
- `entries_scanned` 是实际处理并推进游标的目录项数；`records_checked` 是成功投影的任务数，
  包括被筛选掉的记录；`records_failed` 对应 `errors`。未检、失败和未匹配不是同一回事。
- `record_bytes_read`、`record_limit_bytes`、`page_read_limit_bytes` 说明读取预算。
  字节预算不足时停在未检项之前；单条超限、坏记录或 unsafe 项会返回 task_id 和安全 code。
- `stop_reason` 为 `limit|scan_limit|read_budget|end`。`next_cursor` 为 null 才表示目录采样到结尾；
  `exhausted` 不证明采样后没有新增。`remaining_records` 始终为 null，不能从空 items 推断空库。
- `complete` 只表示本页已到目录结尾且本页无记录错误，不代表前页无错或整个历史已核验。
  调用者须保留各页错误，合并所有页后才能讨论覆盖范围。

顺序使用 Linux x86-64 glibc 的目录 cookie，不排序，不新增索引或扫描服务。游标直接续读，
不从头跳过所有旧记录。续页须保持筛选条件。目录 inode、mtime/ctime 等身份变化会报
`CURSOR_STALE`；目录内新增 task、锁或 session 元数据都可能使它失效。此时不带 cursor 重查，
按 task_id 去重。游标是 opaque 值，不能修改或跨存储复用。每页只验证枚举期间的目录身份；
记录逐条采样，状态变化不会产生一个跨任务或跨页的事务快照。并发更新可影响筛选结果。

`inspect TASK_ID` 复用 result/status 投影，省略所有 output 字段，保留终态来源、receipt 和
安全 health、model/variant、权限 mode 和 cancel_requested。`execution` 增加已保存的 `worker_attempted_at`、`dispatched_at`、
`original_request_observed`；队列成员、agent 存活和真正死锁均为 unknown。`health` 中的
phase/progress 可说明初始化、dispatch、执行、工具活动和 Provider retry；这是最后保存的样本。
`health.policy_ms` 只取当时保存的实际策略，不套用当前环境或给旧记录补生产默认值。

`durations` 每项为 `{ms,basis}`：接受到 worker attempt、attempt 到 dispatch、dispatch 到
started、接受到 started、started 到 terminal、terminal 到最近 callback attempt/确认投递，
以及监督通知封存到确认投递。接受到 started 包括排队与初始化，不能证明 acpx 队列成员关系。
terminal 到 attempt 使用最近一次尝试，不是首次投递延迟。缺任一端点为
`missing_timestamp`/null；反向时间为 `wall_clock_reversed`/null；其余为
`wall_clock_difference`，不是 CPU time 或原始远端事件的精确耗时。正向时钟跳变仍可能影响差值。

`observations` 返回 health、owner_probe、last_event、monitor、worker、owner 的
`at/age_ms/freshness/stale_after_ms`。未来时间的 age 为 null，freshness 为 future_timestamp；
无时间或无可用陈旧阈值为 unknown。health/owner probe 阈值取保存策略的 `2*(poll+probe)`，
monitor 为 `2*poll`，worker 为 workerMs，owner 为已有 lease 的 15000 ms。超过阈值为 stale，
其余为 recent。recent 也只是墙钟较近，不证明请求、进程或服务实时健康。last_event 不推断
陈旧阈值。journal availability 没有独立读取时间，只能结合历史 health 样本解释；查询不读 journal。
这些采样文件与 task.json 不是同时读取，不能据其组合猜测当前启动 token 或 agent 状态。

`callback` 返回 state/kind/status、`retry_count`、`next_attempt_at` 和安全 delivery_error。
retry_count 是已有 attempts 字段记录的重试安排次数：成功或最终拒绝那次不增加它，进程中断
也可能早于计数持久化，不能当作完整 POST 次数。旧计数缺失为 null。只有 outbox 返回下一次
已保存的尝试时间；过期 deadline 不证明 monitor 正在工作。receipt/202 仍只证明存储及 handoff。
inspect 不改 sealed body，也不因陈旧 health 改业务 result_status。

`doctor` 是本机安装自检。它核对实际 active 绑定、稳定 wrapper 的精确脚本、私有目录/owner、
安装 inventory、启动链文件、OpenCode/私有 Node 二进制摘要及可执行 mode、release metadata、
acpx package version、status task capability，并复用 `--module-profile-info` 的 profile 说明。
版本以 `installed_inventory_and_metadata` 为证据且 `executed: false`；不运行 `--version`、
OpenCode、acpx、Node/agent 或任何任务。固定检查项中，二进制最多读取 352+160 MiB，
manifest 最多 8 MiB，其余文件各最多 1 MiB；不递归遍历依赖树或任务历史。
它沿用当前 UID/root/可信 PVC group 的信任边界，不是对抗同 UID 改写 inventory 的远程证明。

doctor 遇首个失败即停，`checks` 区分 ok、failed、not_checked，返回安全 code；不能把后续项
算作通过。`runtime/features/profile` 在对应阶段未完成时为 null。none/external profile 保留原
边界，external 文件不打开，环境仅用于既有 profile 选择和 MCP enable flag；不读取或打印认证值。
`not_checked` 明列 Provider/MCP 健康、外部配置内容、agent 执行、任务历史、全依赖 inventory 和
运行时版本执行。静态 ready、文件存在及版本匹配都不证明实际 Provider 健康。

`doctor --quick` 复用同一流程。输出 `mode: quick`；默认命令为 `mode: full`。
quick 仍对小型启动链文件做摘要校验，对两个大型二进制只打开 fd 并核对类型、当前 UID、
私有权限、单链接、大小上限、inventory mode 及可执行位。`opencode:metadata` 和
`node/bin/node:metadata` 是静态属性检查；`opencode`、`node/bin/node` 内容项明确为
`not_checked`，原因 `quick_mode`。顶层 `not_checked` 同时列出各自 `content_and_sha256`。
它不读这两个文件的内容，不返回或复用旧哈希来冒充本次实测。`ok: true` 只表示所选模式完成，
不能将 quick 当作二进制完整性、运行版本执行或服务健康证明。默认 full 仍读取内容并发现篡改。
两个模式均遇错即停；真正的权限、类型、属主和 link 错误仍退出 1，不启动 Node/agent、网络、
认证检查或 callback，也不初始化目录和配置。新 metadata 项使失败阶段更明确；下游须按 name
读取检查结果，不能依赖数组位置或仅凭 ok 推断未检内容。

隔离静态安装 fixture 复制当前真实发布二进制：OpenCode 223516848 字节，Node 124902584 字节。
一次 full 显式读取 348735004 字节，其中二进制 348419432；一次 quick 读取 315572 字节，
二进制为 0。两次耗时约 0.398 秒和 0.004 秒，包含 fd 属性核对；这是复制及 inventory 后的
热缓存样本，每种模式仅一次。计数覆盖 doctor 的显式 `os.read`，不含解释器/import 读取。
这些是实际大二进制的读取量证据，不是冷存储、生产延迟或服务速度承诺；小 fixture 不用于外推。

只读错误为安全 JSON `{error:{code,hint}}`，不附原始异常、路径或记录原文。
命令/存储级失败及 doctor failed 退出 1；成功退出 0。list 可退出 0 并带逐记录 errors，须检查
coverage。常见 code：`TASK_STORE_MISSING`（先核对安装和任务是否存在）、`TASK_NOT_FOUND`
（核对原 task_id）、`INVALID_ARGUMENTS/INVALID_CURSOR`（核对参数和筛选）、`CURSOR_STALE`
（重新分页）、`TASK_RECORD_TOO_LARGE/TASK_READ_BUDGET`（有界读取停止）、
`TASK_RECORD_CHANGED`（三次原子替换均无稳定样本，或同 inode 读取期间增长）、`INVALID_TASK_RESULT`（坏投影记录）、
`UNSAFE_TASK_FILE/UNSAFE_TASK_DIRECTORY`（保留记录并核对私有权限/属主/类型/链接）。
Node 查询依赖缺失时返回 TASK_MODULE_UNAVAILABLE；若 Python launcher 本身已不完整而无法启动，
使用上面的源码 doctor 入口检查，不把无法启动当作服务健康结论。
doctor/launcher 另用 `MISSING|READ_LIMIT|FILE_CHANGED|UNSAFE_FILE|OWNER_MISMATCH|INVALID_RECORD|
INSTALLATION_MISMATCH|READ_FAILED` 定位检查阶段；未知内部读错误只报 TASK_READ_FAILED。
未知历史 reason/error 映射为 UNKNOWN_RECORDED_CODE，不能把原始错误当安全 code 输出。

task.json、心跳和取消标记均通过 O_NOFOLLOW/O_NONBLOCK 打开，在同一 fd 上校验普通文件、
当前 UID、私有 mode、单链接再有界读取。只有其他属性安全的 nlink=0 才重开，最多三次；
不会把合法原子替换误报为非法链接。真正 unsafe 或坏记录失败关闭。health 小文件上限 16 KiB。
旧的 worker 心跳确认策略保持，读取查询不会启动监护或覆盖旧失败事实。

### 有界结果读取与时间

`result TASK_ID` 只读已有 durable state，不启动模型、恢复任务或投递 callback。
它返回 `task_id`、`request_id`、`session_name`、`session_key`、`session_id` 和
`acpx_record_id`。`session_id` 只使用已保存的 backend session ID，不用 acpx record ID
代替；未取得的标识为 `null`。`state` 是执行器状态，`result_status` 是已封存的
`success|error|cancelled`，与 callback 是否投递成功无关。监督失败通知保留
`state: ambiguous`、`result_status: null`，见下文。

终态 `output` 只取已封存 body 的输出字段。非终态返回 `output: null`，不返回正在收集
的文本。`output_bytes` 是返回文本的 UTF-8 字节数；`output_limit_bytes` 为 callback
注册的较小限额，缺省 32768，上限 32768。这是文本限额，不含 JSON 转义和其他字段。
`output_truncated` 覆盖流收集、封存和读取时的实际裁剪；旧记录未保存裁剪信息且本次
未裁剪时，返回 `null`，不能推定完整。`output_available` 区分未取得或被扣留的输出。

该接口不返回内部 prompt、callback 注册、完整 body、凭据、cwd 或 raw errors。
它只允许已知元数据字段及类型。malformed 记录失败时不打印原文。输出含 `tcb_` 或
已保存 callback URL 时，扣留整个输出并返回 `PRIVATE_CALLBACK_CONTENT`；不改写
封存 body。assistant 文本仍可能含业务敏感内容，负责人应在任务授权范围内读取。

`timing.time_basis` 为 `unix_epoch_ms_wall_clock`。各时间使用本地 wall clock 毫秒：

- `accepted_at` 复用已有 `createdAt`，记录首次提交的持久接受；同 key 重试不更新。
- `started_at` 只在 `promptStarted` 时保存。恢复若未找到已保存时间，则保持 `null`，
  不把首次观察时间当作原请求开始时间。
- `terminal_at` 记录封存终态的本地观测时间，在首次 POST 前保存。被动恢复或人工
  resolve 的时间可能晚于原业务完成时间，不声称是原事件的精确时间。
- `callback_attempted_at` 记录最近一次 POST 前的时间。它不证明服务已收到。
- `callback_delivered_at` 只在收到有效 `202` receipt 后保存，表示本地确认时间。
- `supervision_failed_at` 是无法继续确认原请求时的通知封存时间，不是业务终态。

旧记录缺失时间时返回 `null`，读取不补写旧记录。wall clock 差值不是 CPU time，
可能受系统时钟调整影响。callback receipt 的服务时间单独保留于
`evidence.callback_receipt`，只证明 callback 存储/队列接受，不证明后续模型已完成。

`evidence.terminal_source` 区分 `turn.result`、`watchSession.turn_result`、
`queued_cancellation`、`operator_resolution`、`execution_setup_failure` 和
`supervision_failure`。`output_source` 区分
`assistant_output`、`program_generated` 和 `operator_verified`，旧来源为 `null`。
assistant 的改动、测试和 SHA 是声明，执行器不解析这些声明，也不推断测试通过或
Git push。task/request/session 标识和 receipt 是后续核对入口。
所有事实沿用任务记录或封存 body；不生成或要求模型维护
`result.md`、`result.json`、`recovery.md`。

内置 env profile 的新任务默认 **codex/gpt-6.1-sol / max**，title 为 codex/Sol/low。
`--model provider/model` 和独立的 `--variant variant` 正式选择单任务模型；
只给 variant 会调整本次默认模型。显式模型省略 variant 时，内置 Sol 取 max，Astra 取 medium。
copilot 任务的 title 为 copilot/Sol/low，辅助请求使用该任务的 Provider。
请在原 Secret/env 机制独立填写 `COPILOT_BASE_URL`、`COPILOT_API_KEY`、
`CODEX_BASE_URL`、`CODEX_API_KEY`，迁移步骤见 [PROVIDERS.md](PROVIDERS.md)。
只需选中 Provider 的完整变量对；另一个完全未填写可跳过，部分填写则按变量名报错。
缺 codex 默认凭据不会改用 copilot。外部完整配置的优先级保留，所需环境变量默认继承。

模型、variant 和不可变配置路径保存于非秘密任务意图并参与去重，`status` 返回 model/variant。
同 key 改选择会冲突；恢复使用已保存的选择，不重新读取当前默认值。
配置快照为 0600，仅含 env 引用，不修改原外部文件或全局默认。
ACP 初始化显式选择模型，并核对 agent 确认的模型/effort，再发 prompt。
初始化明确失败，或超过 setup 加确认宽限后会封存 `error`，status 报 `MODEL_OR_SESSION_SETUP_FAILED`；
不会先发送 prompt，也不会自动重做该任务。

Callback input is capped at 4096 bytes, prompts at 1 MiB. Callback files must be
regular, current-UID-owned, single-link, and inaccessible to group/other; symlinks
are refused. Unknown options fail closed. Do not name files with bearer values.
Prompts containing their callback ID/URL are rejected. The launcher strips
`LC_TASK_CALLBACK*`, `OPENCODE_TASK_CALLBACK*` and any value containing a `tcb_`
bearer. Ordinary locale variables remain inherited. No callback input reaches the
ACP child. Existing explicit-config/profile precedence remains unchanged.

## Persistence and execution

Private `runtime/tasks/owner.json` binds state to UID/workspace. Submission is
serialized; a per-task advisory lock admits one cooperating worker. JSON writes use
atomic replacement plus file/directory fsync. Unsafe ownership, links and file modes
fail closed. This retains the existing root/same-UID/trusted-volume-group boundary;
it is not a sandbox against those trusted actors reading private files.

The adapter creates `createSharedAcpRuntime`, ensures a task-specific persistent
session, and writes `dispatching` **before** `startTurn`. `turn.result` is canonical
completion. Only assistant output is collected: thoughts/tools are omitted, and a
new assistant message ID replaces intermediate output. The final output is bounded
to 32768 UTF-8 bytes or the tool's smaller advertised limit. Completion/failure/
cancellation map to `success`/`error`/`cancelled`. Failure output uses a safe program
reason, without raw Provider errors or partial assistant claims. A canonical result
cannot be blocked by a stuck events iterator or `promptStarted` promise; buffered
output drains for at most 250 ms per channel. The worker never waits for an idle
owner/agent process to exit.

On restart, `queued` without a previous worker attempt can execute. Losing a worker
before dispatch seals a setup error. For
`dispatching`, `running`, and `ambiguous`, recovery finds/watches the **original**
session/request with `watchSession({handle,cursor})`; output and cursor are saved
together. Other requests cannot settle the task. A matching request is followed
while its progress and owner observations meet the policy below. Missing request
evidence uses the health policy below: a healthy owner with no original-request
acknowledgement permits a bounded wait, and unavailable observations require continuous confirmation.
An old marker never disables later health
checks. Owner/journal uncertainty becomes explicit `ambiguous`. Elapsed time and missing
owners never authorize replay: **acpx requestId is not execution idempotency**.

An operator with independently verified original output can resolve ambiguity:

```sh
opencode-task resolve task_<64-hex-digest> --status error --output-file ./verified-result.txt
```

Resolution never dispatches a prompt or overwrites a sealed result, including a
supervision notification. It still serves legacy unsealed ambiguity. Queued
cancellation seals without execution; running cancellation requests ACP cancellation
and waits for the original canonical result. Uncertain cancellation is not guessed
from process exit.

Status/passive watch/outbox recovery needs no provider credentials. Queued execution
needs the usual launch environment. Startup can recover unsent callbacks without
keys. New setup failures are sealed and notified; a fresh authorized intent needs a
new key/registration. Provider credentials are not stored in task records.

提交 launcher、detached worker、acpx owner 和 OpenCode 子进程默认继承各次启动进程的
环境，包括代理、自定义认证、其他 Provider 和 disabled MCP 变量。help/version、被动恢复
和外部配置也不删除这些变量。模块管理的 HOME/XDG/TMPDIR、配置/任务控制变量仍由模块
覆盖，回调字段和值仍过滤；见 [Launch environment](README.md#launch-environment)。
环境不写入任务记录。重启后的 `recover` 使用恢复进程当前环境，queued worker 仍校验
已保存选择所需的 Provider/MCP 配置。

Deny-all/noninteractive-deny remains the default. An already authorized caller may
explicitly select `--permission-mode deny-all|approve-reads|approve-all` for one
task. `approve-all` requires existing user scope for that task's edits/commands;
it does not grant new user authorization. There is no automatic escalation after
a denial. The optional `--permission-policy-file PRIVATE_FILE` snapshots the pinned
acpx `PermissionPolicy`: bounded `autoApprove`, `autoDeny`, `escalate` string arrays
and `defaultAction: approve|deny|escalate`. Unknown fields are rejected. Noninteractive
escalation still denies; it never opens a prompt or broadens permissions. For
example, `{"autoDeny":["edit"]}` denies matching edits even with explicit approve-all.
Rules use acpx's exact case-insensitive tool-name/title/kind matching or `*`.

Mode/policy are stored in the immutable submit fingerprint and task record, then
supplied to each detached runtime, recovery and cancel operation. Workers never
re-read a policy file or inherit a preceding task's permission choice. No global
acpx/OpenCode config changes. The fixture verifies denied writes, an explicitly
permitted write surviving driver recovery, and restored denial on the next run.

`--session NAME` reuses one module-owned persistent OpenCode session for related
fix/review runs. Each distinct submit key/callback still has a fresh request ID
and its own terminal notification. The bounded name is bound to the canonical cwd
in private `.sessions` metadata; reusing it from a different cwd, or a stored handle
whose cwd/session identity differs, fails closed. Omitting it retains a private
session per task. There is no arbitrary external handle-adoption interface and no
existing session migration. The fixture proves multiple runs retain the same ACP
session and context while each notifies once.

新 named session 同时固定模型、variant 和配置快照。后续请求须显式匹配，或当前默认值
恰好相同；不会从旧 session 隐式继承其他 Provider。冲突报 `SESSION_MODEL_CONFLICT`，
应换新 session 名。短暂初始化锁覆盖首次 ACP 选择和确认，随后释放，仍由原队列执行。
同 session 的后续任务不会发送选模型控制，避免影响 running/queued 请求。
若首次初始化中断，已有 session 缺少成功确认则失败关闭；不会通过重发 prompt 修复。

旧记录不增加模型字段、不回写已封存结果，已 dispatch 请求仍按原 request ID 被动恢复/取消。
旧 named session 无模型绑定，拒绝新选择自动接管。旧 queued 记录未保存选择，
不能直接套用新的 codex 默认；请在原工具版本环境中，或使用原完整外部配置及所需启动环境恢复。
`runtime_profile=none` 且无外部完整配置时，保留原显式 readiness 契约，模型参数需完整配置。

Cancellation always targets the original request ID, including an active request
recovered after driver exit. It never calls session-wide `runtime.cancel`, so an
unrelated queued follow-up can continue. The small `task-acp.mjs` adapter uses the
same request-targeted `cancel_prompt` RPC as acpx 0.21.1's `turn.cancel`, with the
observed owner generation and a bounded socket wait, without its health-cleanup fallback; that wire format
is version-bound and must be revalidated with a dependency upgrade. Passive watch
still determines the canonical result. A queued request whose driver disappeared
before a durable journal entry can remain ambiguous (including a lost cancellation
reply); do not infer execution or automatically replay it. Use observation or
explicit verified resolution.

## 监督策略与边界

每任务有一个持有 `monitor.lock` 的监护进程和一个持有 `worker.lock` 的 worker。
监护直接等待自己创建的 child 的 exit，不从持久化 PID 猜测或发送信号。
worker 每 5 秒写私有心跳。30 秒没有当前启动 token 的新心跳先进入怀疑，再连续观察 30 秒
且至少取得两次检查后，监护才停止自己的 worker。心跳恢复会撤销怀疑。
确认 child 退出后才启动被动 observer。Linux parent-death signal 也会在监护退出时停止它的
worker；独立 acpx owner 继续运行。监护重启不会重放可能已执行的 prompt。

acpx 0.21.1 的 `getStatus` 是持久快照，`lastRequestId` 不是运行证明。模块只读 owner lease，
核对 `ownerGeneration` 与 acpx 的出生身份（boot/namespace/start ticks），每 5 秒观察一次；
lease 的 5 秒心跳在 15 秒内才算新鲜。PID 复用、namespace 不匹配或证据不足不会判业务失败。
不调用可能清理/终止 owner 的 acpx CLI health helper。换 owner 也不证明原请求还在执行。
换代后观察到原 request 的新事件，可更新 generation 并撤销怀疑；只有其他 request 活动不能更新。
事件恰逢 lease 中断时，保留尚未配对的进展，待有效 lease 恢复再核对，避免正常工具被旧 generation 卡住。
事件不带 owner generation；这份配对只用于撤销短时怀疑，不能证明新 owner 已接管该请求。
即使 lease 暂时不可读，原请求持续的新事件也优先于该弱证据。未来时间的 lease 不算新鲜。
共享 runtime 没有按 request 查询队列成员、agent 心跳或进程退出的公共接口，因此
`health.agent` 为 `unknown`。OpenCode/ACP 异常退出通常形成原 request 的 journal `failed`；
仅收到共享连接的 `failed` 要先找原 journal。`WATCH_OUTCOME_UNKNOWN` 即使包装成 failed，
仍只表示原结果未知。

没有固定总执行时长。进展取原 request 的 ACP 通知，包含 thought、工具状态、压缩和
Provider retry；不以 assistant 文本是否出现判断健康。默认普通阶段连续 15 分钟没有 ACP
进展先进入怀疑；活动工具有 6 小时的无进展宽限，按 tool ID 跟踪完成。
retry 通知的 `nextRetryAt` 及之后 15 分钟内保持等待。其他 request 的活动不能延长本任务
进展期限。共享 owner 健康但原请求尚无事件/开始确认时，最多等待普通 progress 期限，
随后进入怀疑；这兼顾排队等待，但 acpx 公共接口不能证明原请求确在队列中。
owner 不可确认、换代后未见原请求新事件或 session 持续找不到时，discovery 期限后进入怀疑。
原 cursor 的 journal/session 读取失败会自动重试观察。相同 owner 健康且已见原请求时，
重连后的正常静默仍按普通/工具进展预算等待；单次读取失败不会缩短这个预算。

请求与 worker 的健康怀疑都须再连续观察 confirm（默认 30 秒）且至少取得两次检查，才确认监测不可用并通知。
原请求的新进展、恢复的有效 owner 证据或明确终态会撤销相应怀疑。业务终态无需等待 confirm。
采样间隔超过 `2 × (poll + probe)` 时重新开始确认，避免监测进程恢复调度后立即报错或杀 worker。
正常调度抖动可能延后通知；持续 CPU 饥饿没有实时上限。

恢复优先沿用同 boot、同 time namespace 的单调进展时间；进程内 retry 等待也使用单调期限，
不会因 wall clock 前跳而突然到期。旧记录、跨 boot/namespace 或缺该证据时，才回退至 wall clock
差值，并重新完成连续确认。`status/result` 不为旧记录补写时钟证据；恢复不会重新赠送完整静默期。
过期 retry 按已过去的时间计算，不重新赠送 progress 宽限；无时钟身份的旧 tick 不可跨 worker 复用。
acpx journal 没有逐事件生成时间；这里的“新进展”是原 cursor 之后新观察到的事件，不能证明远端
实时活跃。这些策略阈值都不证明模型或工具死亡。

setup 超时先标记 `SETUP_SLOW`，继续等待同一个初始化 promise 至多 confirm；不再发一次
`ensureSession`。明确初始化失败立即封存 setup error，超出宽限则同样封存。冷启动仍可能比预算更慢。

启动环境可配置以下毫秒值，允许 10～86400000 的整数。worker 期限至少是 poll 的 3 倍，
discovery 至少等于 probe；恢复使用当前启动环境，公开本次实际策略。

| 环境变量 | 默认值 | 含义 |
| --- | ---: | --- |
| `OPENCODE_TASK_POLL_MS` | 5000 | worker/monitor 心跳及观察间隔 |
| `OPENCODE_TASK_PROBE_MS` | 3000 | 一次被动观察、findSession、detach 等待上限 |
| `OPENCODE_TASK_DISCOVERY_MS` | 30000 | 原请求发现、连续 owner 不可确认及中断后补查窗口 |
| `OPENCODE_TASK_SETUP_MS` | 30000 | ensureSession/模型确认上限；不提交 prompt |
| `OPENCODE_TASK_WORKER_MS` | 30000 | 当前 worker 心跳期限 |
| `OPENCODE_TASK_CONFIRM_MS` | 30000 | 超过策略阈值后的连续确认；setup 等待同一初始化的额外宽限 |
| `OPENCODE_TASK_PROGRESS_MS` | 900000 | 普通阶段无 ACP 进展及 retry 到期宽限 |
| `OPENCODE_TASK_TOOL_MS` | 21600000 | 活动工具无 ACP 进展宽限 |
| `OPENCODE_TASK_DRAIN_MS` | 250 | 已有结果后每个输出通道排空上限 |

连续调度和磁盘可用、单次 probe 在配置上限内完成时，超阈值到确认最多增加
`confirm + 2 × (poll + probe)`；worker 心跳检查不做异步 probe，增加 `confirm + 2 × poll`。
worker 返回前 detach 最多再等 probe。默认预算如下，均是本地首次 POST 前的预算：

| 持续条件 | 默认预算 |
| --- | ---: |
| 初始化不完成 | setup + confirm = 60 秒，再加 detach 至多 3 秒 |
| owner 心跳停止且无新原请求进展 | 15 秒 lease 宽限 + discovery + confirm + 两轮 poll/probe + detach，约 94 秒 |
| 普通静默或健康 owner 下原请求始终未开始 | progress + confirm + 两轮 poll/probe + detach，约 15 分 49 秒 |
| 活动工具无进展 | tool + 同上附加时间，约 6 小时 49 秒 |
| Provider retry | 从 nextRetryAt 加 progress 和上述附加时间 |

worker 真正退出立即触发原请求观察；心跳持续缺失默认最多约 70 秒后停止自有 child，随后按
原请求的剩余健康预算观察，不会因 worker 丢失重发。若原请求也持续不可观察，再约 79 秒内
通知。owner 仍健康且原请求可能继续时，遵守上表的进展预算。
callback 网络等待另有每次 30 秒上限；远端接受时间取决于网络和重试。上述预算不包含
监测自身长暂停后的重新确认；CPU 饥饿、挂起或磁盘不可写时不是实时保证。

未知时沿原 outbox 封存 `status: error` 的**监督失败通知**。输出明确说明结果和副作用未知、
可能仍在执行、不可自动重试。任务仍为 `ambiguous`，`result_status` 与 `terminal_at` 保持
`null`。`callback_kind: supervision_failure`、`callback_status`、`callback_state` 与业务结果
分开。LibreChat v1 callback 只有 success/error/cancelled；通知种类通过固定安全文字说明，
不增加协议字段。一次注册只有一个封存 body；后续原请求成功也不改 body 或投递第二个结果。
负责人须用原 request/session 标识独立核实后续结果，再授权新的业务动作。

监督期限不会取消原请求或终止共享 owner/agent。显式 `cancel TASK_ID` 只请求取消原 ID，
取消 RPC 回复不代表已经停止；原请求的 canonical result 才能确认取消。监督通知发出后仍可
定向取消，但通知不变，也不声称取消已完成。`resolve` 不覆盖已封存通知。

`status`/`result` 的 `health.assessment` 区分 `observing`、`suspected`、`unavailable`、`settled`；
`suspected_since`、`suspected_reason` 解释怀疑，`journal` 表示最后一次读取是否可用，`worker_assessment`
单独说明 worker 心跳怀疑。`unavailable` 是监测不可用，业务失败只由原请求终态或未 dispatch 的
setup error 证明。`health` 还公开观测阶段、进展分类、owner 身份状态、安全原因、心跳/
事件/probe/退出时间、退出码及实际策略。旧字段未知时为 `null`。心跳时间是历史观测，
不代表读命令实时探活。读命令不启动执行、恢复或 callback。

监护本身退出后，启动恢复或 `recover TASK_ID` 可接续原请求/原 outbox；本模块没有监护自身的
外部服务。整个 Workspace/宿主停止、监护被杀或磁盘不可用时，内部不能保证及时 callback。
活着的 OpenCode/owner 也不证明远端模型仍在推进，长工具内部进度仍不可见。
这些层的持续保障需基础设施另行部署外部监督；本次源码没有部署它。
本轮用合成场景先复现了旧 generation 导致的提前结束，再验证修复及短暂故障恢复、怀疑撤销、
排队等待、单调时间和暂停 worker。它们不提供生产误报率，也不能消除无请求心跳时的静默歧义。
一次监督通知仍占用原 callback；后续成功不会改封存字节或发第二个结果，须独立核实原请求。

源码边界核对：acpx 0.21.1 `SharedAcpRuntime.startTurn/turnFailure`、
`SessionEventWriter.beginTurn`、`observeProcessIncarnation`、`readQueueOwnerRecord`；
OpenCode 发布提交
[`9291b46` 的 ACP translate](https://github.com/Ricky-Hao/opencode/blob/9291b46db483415e1c9bdaa72f8e48637e3f7b49/packages/cli/src/acp/translate.ts)
把 Provider 执行失败转为 ACP error，并用 `_meta["opencode/retry"]` 发送重试计划。
其 ACP 不提供专用 heartbeat；HTTP server 心跳不代表请求进展，也未向标准 ACP 客户端公开
内部随机 HTTP 认证。模块无需 fork 或读取这些凭据。

## Terminal protocol and durable outbox

Before POST, the worker fsyncs result status and the exact stable callback body:

```json
{
  "version": 1,
  "callback_id": "<private bearer>",
  "status": "success",
  "output": "Bounded assistant output"
}
```

No input, prompt, target, mode, metadata, API key or Authorization header is sent.
The callback ID is the sole bearer, in the body only. HTTPS is required except
loopback HTTP fixtures. Credentials/query/fragment and paths other than
`/api/agents/task-callbacks` are rejected. Redirects are never followed. Responses
and errors are not logged. A valid bounded (4096-byte) `202` receipt
`{version:1,receipt_id,accepted_at}` is retained; it acknowledges LibreChat storage
and recoverable queue handoff, not completed model inference.

Lost receipts/network failures, malformed success receipts, `408`, `425`, `429` and
5xx retry identical saved bytes without executing again. Exponential backoff starts
at 5 seconds and caps at 5 minutes; `Retry-After` may extend it up to 24 hours. The
next deadline survives restart. Other statuses, including redirect, expiry and
conflict, become `rejected` for operator inspection. Do not discard the outbox from
a local expiry check: an identical retry after expiry can recover a lost receipt
when LibreChat sealed the result before expiry.

LibreChat accepts one terminal result: identical retries return the same durable
receipt; changed status/output returns `409`. There is no callback heartbeat or automatic
prompt replay. Local health observations stay outside that protocol. Task state is retained for recovery; archival/removal is a separate
operator action after reviewing outstanding work. No older task/session/cache state
is migrated or deleted.

## Verification and rollout boundary

```sh
python3 -B -m unittest discover -s opencode/tests -v
python3 -B opencode/build_bundle.py --check
node --test opencode/tests/task.test.mjs opencode/tests/task-supervisor.test.mjs
node --test opencode/tests/task-read.test.mjs
(cd opencode/scripts && npm ci --ignore-scripts --no-audit --no-fund)
env -i PATH=/usr/local/bin:/usr/bin:/bin node --test opencode/tests/runtime.test.mjs
env -i PATH=/usr/local/bin:/usr/bin:/bin node --test opencode/tests/cli-fixture.test.mjs opencode/tests/cli.test.mjs
# Optional: a reviewed published binary copied into an isolated scratch directory:
env -i PATH=/usr/local/bin:/usr/bin:/bin OPENCODE_FIXTURE_BINARY=/private/fixture/opencode node --test opencode/tests/published.test.mjs
# From the LibreChat companion's packages/api:
CODER_MODULES_CHECKOUT=/workspaces/coder-modules npx jest src/agents/callbacks.integration.spec.ts --runInBand
```

Task fixtures use mock ACP and local HTTP for terminal statuses, dedupe, pre-POST
persistence, stable retry/restart, request-specific watch recovery, ambiguity,
payload bounds and redirect refusal. The pinned runtime test uses real acpx 0.21.1
and a synthetic ACP peer for `turn.result`, watch cursor/request identity and
cancellation while the owner remains alive. The cross-repository test posts the
production `TaskRunner` payload into LibreChat's actual handler/Mongo/continuation
wiring. Python fixtures cover installer/wrapper/profile, first/repeat startup,
preservation and permissions; Terraform mock validation is separate.
The installed CLI fixture uses the actual wrapper/private Node/acpx path to prove
task-scoped permission/policy, named-session continuity, callback secrecy, driver
recovery, and cancellation isolation from another queued run. It also checks that
the global deny-all config remains unchanged. Synthetic unlisted proxy, custom
authentication, other-provider and disabled-MCP variables cross the detached launch
chain by default; callback names/bearers remain filtered.

故障回归还覆盖启动失败、worker 退出/心跳停止、监护重启、ACP peer 异常退出、
owner 异常退出、Provider failed、终态先到但 started/events 悬挂、原请求恢复和监督通知的
原字节重投递。慢静默、长工具、retry 等待、同 session 其他 request 与 PID 出生身份冲突
分别验证。可选 `published.test.mjs` 在隔离 HOME 中运行指定发布包，仅连接本地 Responses/
callback fixture，核对 HTTP 200 `response.failed` 和同 session 后续成功；不替换当前 toolset。

CLI 还专门验收“owner/agent 仍存活、原 request 已开始、永久静默且没有终态”：生产 wrapper、
detached monitor/worker 和固定 acpx 自动完成怀疑、连续确认、封存及 HTTP error 投递。
测试只控制合成 ACP peer、观察原 request journal 与出生身份，不代调 `fail/seal/deliver`，
不通过取消或杀 owner/agent 促成检测。原请求先发送合成进展，待同 session 后续请求排队且
确认 peer 实际消费原请求后，再注入永久静默；`running/turn_started` 本身不代表 peer 已消费。
缩小策略为 poll 100、probe 1000、progress 600、
confirm 800 毫秒；首次 POST 须在最后进展后的 1400～4600 毫秒内，首 receipt 丢失后由
原 outbox 按正常 5 秒退避原字节重投。有效 `202` receipt 后，`callback_state: delivered`、
`callback_kind: supervision_failure`、`callback_status: error`，业务仍为 `ambiguous`，
`result_status/terminal_at: null`。只执行一次业务；同 session 后续请求仍排队，未误取消或放行。

健康对照由独立采样线程记录怀疑/恢复快照并只放行 peer 的 thought，避免同步 submit 阻塞父测试
时错过短暂状态。等待任务 handle 就绪及 peer 实际接收后，由阻塞子进程触发静默；记录真实阻塞起止，并核对怀疑发生在
阻塞期间、阻塞结束已越过该次怀疑的确认期限。父测试至少阻塞 1.8 秒，peer 恢复后仍持续 thought，待核对健康跨度超过
progress + confirm 后才放行成功终态。最后只有一次 success callback，全程没有 assistant 文字；已有长工具
对照继续跨普通静默边界成功，并在一次心跳读取异常后保持同一 driver 成功。CLI 的 `healthy-tool`、
`thought-after-suspicion`、`alive-original-stall`、`persistent-heartbeat-read-error` 诊断只输出合成标识、
策略、观测时间与次数，可由上述命令复核。
这些是本地故障注入证据，不证明真实 Provider 卡死或生产误报率；正常长思考与永久卡住仍可能
暂时不可区分。业务无需自动恢复，监护接续原请求也不等于重做业务。

心跳通过 `O_NOFOLLOW | O_NONBLOCK` 打开，在同一 fd 上 `fstat` 校验普通文件、当前 UID、私有
mode 和单一链接，再从该 fd 读 JSON。合法原子替换可能在 lookup/stat 之间使旧 inode 的
`nlink` 变成 0；仅在其他安全属性合格时关闭并重开当前路径，最多三次。三次均被替换或文件
暂缺时不更新最后有效进展时间，原 worker 静默期限和连续确认继续计时。真实越界文件、坏 JSON
和其他读错误仍被拒绝，转为 `WORKER_HEARTBEAT_UNREADABLE` 怀疑；有效样本可撤销怀疑，持续
错误经至少两次采样及完整 confirm 后只停止自有未回收 child、等其退出再观察原请求。接续观察
仍不可读时封存监督 error 并由原 outbox 投递，不重发业务，不假定业务已失败。读取异常与
心跳超时的 reason 切换会重启确认，不能沿用另一个原因的怀疑时间。
最后有效心跳超过 worker 期限后固定按超时确认，避免读错误和文件暂缺交替出现时反复续期。

定向测试用真实 rename 在已打开 fd 的 stat 前替换文件，稳定取得实际 `nlink=0`，验证重读与
三次上限；硬链接、symlink、错误权限/属主、目录、FIFO、坏 JSON 仍拒绝。原读取路径的两个
真实子进程并发复现捕获 `nlink=0`、mode 0600、当前 UID 的误报；修复后五秒并发检查同时验证
重试和 sequence 推进。完整 CLI 注入一次/持续读取异常，验证恢复与确认后的 error/202/delivered、
自有 driver 退出后仅被动观察、业务一次及无取消；不会代调封存或投递方法。

夹具清理先保留原失败及阶段，再按出生身份停止自有 monitor、worker、owner/agent，等待它们
退出或进入不可写的僵尸状态后才删临时目录。复制脚本的父 spawn 点立即登记 child 出生身份，
精确匹配 version、active 及 wrapper 启动路径，覆盖尚未完成 Node 初始化的自有子进程和暂停的
worker；无法确认停止则保留临时目录并报错。清理异常会另行诊断，不覆盖首错；只有清理失败
也必须使测试失败。回归用真实子进程验证 TERM 后延迟重建目录、SIGSTOP、PID 出生身份不符和
首错保留（含诊断自身抛错），清理不更改生产监督状态或原等待上限。旧夹具只发 TERM 就立即删目录，
存在可证的并发写入竞态；旧 finally 在已有首错时可能用 ENOTEMPTY 覆盖它。sing-box 固定
`7f7b749` 的原 TAP 尚未取得，是否存在首错及其内容未知，不能据此认定生产检测失败或确定首错。
前轮单次 fixture timeout 的根因同样仍未确定。
本轮另一次本地 cancel/recover 等待 delivered 超时按 exit 1 保留，未被清理异常覆盖；该次
原始进程及 journal 证据不足，原因未证。失败诊断会补充原请求终态摘要、已登记进程的出生
身份/状态与正常退出记录；写入者停止后仍保留失败夹具目录，成功运行才删除。
另一次同 session 后续请求停在 queued 的现场确认 monitor 在启动后约 0.45 秒以 code 1 退出，
该次未取得异常栈。后续 sing-box 固定 `3b2fa59` 夹具/已安装 `7f7b749` 脚本捕获
`privateFile(worker.json) → timer → UNSAFE_TASK_FILE` 导致 monitor code 1 退出；与已复现的
路径 stat 竞态一致，但现场未保存该次 stat，不能将旧的每次超时都归因于它。复制脚本的
`uncaughtExceptionMonitor` 只记录异常，不拦截 Node 默认退出。

peer 独立记录自身出生身份；只有父关系、父出生身份和本夹具命令都稳定匹配时才记为 owner。
启动时已被收养则记录 `invalidOwner`，不能用 PID 1 代填。清理同时硬拒绝 PID 1、宿主和非法
PID，不放宽命令/出生检查；owner 校验失败仍尝试收尾已确认 agent，最终保留目录并报原错误。
空 cmdline 只能等待、不能发信号或视为退出；命令确认后才发送一次 TERM 并给予两秒退出宽限，
每批清理最多六秒，仍不可核实时失败保留目录。合成收养、延迟退出写入及空命令回归核对这些边界。

双 Provider 回归覆盖完整元数据一致性、独立变量对与名字级错误、两跳转发、model/variant
去重与 session 冲突、ACP 拒绝选模型时不发 prompt、旧记录兼容。真实 loopback 还分别用
已发布 v2.1.2-ricky.1 和本地 v2.2.0 候选检查不同 Provider 端口上的主请求 max/title low、
Astra 档位、同 session 追问及恢复定向取消。当前正式发布 v2.2.0-ricky.1 包另通过
首次/缓存安装和 codex→独立 copilot→原 codex named session 的最短追问回环，
确认原回答历史保留；它不连接真实 Provider/MCP。旧 SQLite 故障未证成因，原证据保留。

These are local source checks, with no paid inference or production webhook.
Publish/deploy reviewed matching module/LibreChat versions, ensure persistent volume
permissions, configure LibreChat's HTTPS endpoint/capability and attach its built-in
before real use. Publication, template updates, live Agent/Skill setup, deployment
and real provider smoke require separate operator action. Source is not deployment.
