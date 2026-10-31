# Detached OpenCode tasks and callback delivery

`opencode-task` adapts LibreChat's generic `create_task_callback` tool to pinned
**acpx 0.21.1**. It reuses the module's private Node, OpenCode wrapper, runtime HOME,
model selection, provider/MCP profile and permission defaults. No acpx patch,
session migration, parent-volume ownership change, or task dashboard is involved.

The installer bundles/fingerprints/inventories `task.mjs`, `task-cli.mjs` and
`task-acp.mjs`, installs
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
opencode-task recover
opencode-task cancel task_<64-hex-digest-from-submit>
```

Submit returns `{version:1,task_id,request_id,accepted:true}` after fsync of the
private request and the detached launch attempt. This is local durable acceptance,
not proof that ACP/the model already received the prompt. The worker survives the
submitter. Use a stable caller-chosen `--key`: the same key/prompt/cwd/registration
returns the same task/request; changed data fails closed. `status` exposes
state/result status, permission mode, optional session name, safe lifecycle timing,
cancellation request and safe codes, never callback, prompt, output or raw errors.
A stopped worker is recovered by startup or `recover`.

### 有界结果读取与时间

`result TASK_ID` 只读已有 durable state，不启动模型、恢复任务或投递 callback。
它返回 `task_id`、`request_id`、`session_name`、`session_key`、`session_id` 和
`acpx_record_id`。`session_id` 只使用已保存的 backend session ID，不用 acpx record ID
代替；未取得的标识为 `null`。`state` 是执行器状态，`result_status` 是已封存的
`success|error|cancelled`，与 callback 是否投递成功无关。

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

旧记录缺失时间时返回 `null`，读取不补写旧记录。wall clock 差值不是 CPU time，
可能受系统时钟调整影响。callback receipt 的服务时间单独保留于
`evidence.callback_receipt`，只证明 callback 存储/队列接受，不证明后续模型已完成。

`evidence.terminal_source` 区分 `turn.result`、`watchSession.turn_result`、
`queued_cancellation` 和 `operator_resolution`。`output_source` 区分
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
初始化失败保持 queued，status 报 `MODEL_OR_SESSION_SETUP_FAILED`；不会先发送 prompt。

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
cancellation map to `success`/`error`/`cancelled`. The worker never waits for an idle
owner/agent process to exit.

On restart, `queued` can execute because no dispatch was attempted. For
`dispatching`, `running`, and `ambiguous`, recovery finds/watches the **original**
session/request with `watchSession({handle,cursor})`; output and cursor are saved
together. Other requests cannot settle the task. A matching request is followed
for its lifetime. Missing request evidence has a 30-second discovery bound;
owner/journal uncertainty becomes explicit `ambiguous`. Elapsed time and missing
owners never authorize replay: **acpx requestId is not execution idempotency**.

An operator with independently verified original output can resolve ambiguity:

```sh
opencode-task resolve task_ error --output-file ./verified-result.txt < digest > --status
```

Resolution never dispatches a prompt or overwrites a sealed result. Queued
cancellation seals without execution; running cancellation requests ACP cancellation
and waits for the original canonical result. Uncertain cancellation is not guessed
from process exit.

Status/passive watch/outbox recovery needs no provider credentials. Queued execution
needs the usual launch environment. Startup can recover unsent callbacks without
keys; supply normal provider configuration and run `recover` to launch queued work
that could not start. Provider credentials are not stored in task records.

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
same request-targeted queue primitive as acpx 0.21.1's `turn.cancel`; that dist export
is version-bound and must be revalidated with a dependency upgrade. Passive watch
still determines the canonical result. A queued request whose driver disappeared
before a durable journal entry can remain ambiguous (including a lost cancellation
reply); do not infer execution or automatically replay it. Use observation or
explicit verified resolution.

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
receipt; changed status/output returns `409`. There is no heartbeat or automatic
prompt replay. Task state is retained for recovery; archival/removal is a separate
operator action after reviewing outstanding work. No older task/session/cache state
is migrated or deleted.

## Verification and rollout boundary

```sh
python3 -B -m unittest discover -s opencode/tests -v
node --test opencode/tests/task.test.mjs
(cd opencode/scripts && npm ci --ignore-scripts --no-audit --no-fund)
env -i PATH=/usr/local/bin:/usr/bin:/bin node --test opencode/tests/runtime.test.mjs
env -i PATH=/usr/local/bin:/usr/bin:/bin node --test opencode/tests/cli.test.mjs
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
