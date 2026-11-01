# OpenCode 任务与持久回调

任务入口为 `opencode-task launch`。OpenCode **v2.2.0-ricky.1** 管模型、工具和上下文；
acpx **0.21.1** 管 ACP、持久 session、队列、执行和 journal，私有 Node 为 **22.23.4**。
模块只准备任务、适配原 request/session、保存结果并投递回调。每任务只有一个自建后台控制进程，
同时执行或观察原请求和处理 outbox。没有独立监护、替换 worker、内部心跳或 owner 健康推断。
安装和 Workspace 启动不扫描或恢复任务。控制程序被杀或重启后，须显式 `recover`。

## CLI

```sh
opencode-task launch --input-file /private/task-inputs/new.json
opencode-task launch --continue-from task_<64位摘要> --input-file /private/task-inputs/follow.json
opencode-task status task_<64位摘要>
opencode-task result task_<64位摘要>
opencode-task list --state ambiguous --limit 10
opencode-task doctor
opencode-task doctor --quick
opencode-task recover
opencode-task recover task_<64位摘要>
opencode-task cancel task_<64位摘要>
```

公开 submit、resolve、inspect 和手工 session 选择已删除。`_run`、`_selection` 为内部入口。
内部 TaskRunner.submit 是持久提交原语，不能作为公开绕过 launch 的方法。
查询不恢复、取消、执行或投递；`recover` 是有副作用的显式操作。

## 高层 launch 入口

Agent 沿现有工具完成三次调用：

1. 调用 `create_task_callback`，取得完整原生注册对象，遵守工具 schema 和已授权范围。
2. 用文件写入工具将 JSON 写到仓库外的私有文件，原样放入 `callback`。父目录由当前 UID
   拥有、mode 0700；文件是当前 UID 的普通文件、单链接、mode 0600，整条路径无 symlink。
3. Workspace Bash 执行 launch，只传文件路径。callback 不进入 shell 文本、argv、环境、业务 prompt
   或日志。无新增 MCP tool，也不复制 bearer 到另一个文件。

```json
{
  "schema_version": 1,
  "key": "review-1",
  "repo_path": "/workspaces/project",
  "branch": "feat/review-1",
  "worktree": "project-review-1",
  "base": "rickyhao/stable",
  "prompt": "完成已授权修改并报告实际测试。",
  "callback": {
    "callback_id": "<原生工具返回的私密值>",
    "callback_url": "https://chat.example.invalid/api/agents/task-callbacks",
    "max_output_bytes": 32768
  },
  "permissions": { "mode": "approve-reads", "policy": { "autoDeny": ["edit"] } },
  "provider": "codex",
  "model": "gpt-6.1-sol",
  "variant": "max",
  "no_progress_timeout_seconds": 900
}
```

新任务要求 schema_version/key/repo_path/branch/worktree/prompt/callback，其余可选。
`base` 是 origin 的远端分支名称，省略为 `main`。key 为 1～256 字符，无控制字符或 `tcb_`；
prompt 非空，UTF-8 最多 1 MiB。完整 callback 最多 4096 字节，原生 expiry/guidance 等附加字段
保留在输入指纹。整个文件最多 1 MiB+16 KiB。prompt、名称、权限策略不能含 callback bearer/URL。
输入与选择在 Git 修改前校验。未知字段、`start`、`base_sha` 和无效组合明确拒绝。

`no_progress_timeout_seconds` 是整数秒，范围 **1～86400**，默认 **900**。长构建或长工具由调用者
显式调长。不依据工具种类、retry 时间、owner lease 或查询自动延长。续接省略时使用默认 900 秒，
该轮显式值参与同 key 指纹；不改变 session 的模型和权限。

repo_path 须为无 symlink 的绝对 Git checkout 顶层并有 origin。worktree 为 1～64 位名称，首位
字母/数字，其余允许字母、数字、下划线或连字符；目录固定为 repo 的父目录加名称。
branch 和 base 最长 240 字符，按 `/` 分段，每段首位字母/数字，其余允许字母、数字、`.`、`_`、`-`；
禁止 HEAD、`..`、尾点、`.lock` 和 `tcb_`。base 可写 `main` 或 `rickyhao/stable`，不接受参数或 revision 表达式。

Git 沿调用者 HOME、SSH 身份、hostkey、PATH 和网络环境运行，只清除仓库/index/对象路由变量。
新任务 fresh fetch `origin refs/heads/<base>`，保存所选 base 名称和完整 40 位 base_sha，再从该提交创建 branch/worktree。
fetch 使用本次独立 ref，避免其他 fetch 改写 FETCH_HEAD；该 ref 不授权中断恢复。
远端分支不存在则报 GIT_FETCH_FAILED，不采用缓存或同名 tag。新任务不使用缓存 origin 分支，
不更新原 checkout 的分支，不要求无关 checkout 干净。已有 branch/目录
保留并报冲突；不 stash/reset、覆盖、删除、换名称或强推。Git stderr、remote 值不进入输出或记录。

### 续接与同 key 去重

续接只要求 schema_version/key/prompt/callback，可带权限、模型选择及时限；不接受 repo_path/branch/worktree/base，
即使 base 与原值相同也拒绝。须从最新一轮可信 launch 续接，保留 repo、branch、worktree、base 名称、
完整 base_sha、session、模型/profile；不重新 fetch，不改向当前远端提交。
省略权限沿保存值，显式覆盖只作用该轮。权限模式为 deny-all、approve-reads、approve-all，新任务
默认 deny-all；approve-all 须已有该轮授权。policy 的 autoApprove/autoDeny/escalate 各最多 32 个
非空规则，每条最多 256 字符；defaultAction 为 approve/deny/escalate。未知字段拒绝。
匹配沿原生 acpx 规则，非交互 escalation 仍拒绝。策略与选择持久保存，不读旧输入来恢复。

原轮须有 canonical 结果、可信派发前失败或取消，并有可信 backend session 身份。通知已投递、
控制程序退出、queueDepth 或 owner 缺失均不能证明原请求结束。未知仍拒绝第二个写入者。
晚到 canonical 结果独立落盘后可作为续接依据。派发前失败/取消的续接轮可保留上轮可信身份。
执行前再核 backend session 身份，缺失或变化则拒绝，不建新 session 替代上下文。

省略选择沿保存值，显式相同选择可用；切换报 SESSION_MODEL_CONFLICT。acpx 公共接口不能将
完整请求/profile/effort 与排队 prompt 原子绑定，因此不自动切换或接管手工 session。
默认 codex/Sol/max、同 Provider title/low，完整四变量和模型契约见 [PROVIDERS.md](PROVIDERS.md)。

私有 `.launches/task_<key摘要>.json` 保存输入指纹、选择、Git 身份和 task 关联，不另存 prompt
或完整 callback。submit.lock 串行整个准备/提交链，Git 继承锁；同 key 并发只有一个提交者。
同 key/完整同输入复用已提交的 task/request，异输入报 LAUNCH_CONFLICT。新任务显式 base 参与输入指纹，
省略与显式 `main` 也是不同输入；重试须保留原输入，不重新 fetch 或更改已保存的 SHA。

Git 准备中断采取 **fail closed**：没有完整 task 关联的旧 claim 报 GIT_PREPARATION_INTERRUPTED。
保留分支、目录和现场，人工核对后处理。没有分阶段自动续完、staging/rename/reflog 恢复协议。
task 已持久提交但响应丢失时，核对原关联，禁止再次 submit/startTurn；重复 launch 只尝试观察原
request 或补投原 body。原 queued 也不重新派发，而是如实封存未派发失败。

成功响应包含 key/task_id/request_id/accepted/stage/reused、Git/session、selection 和权限摘要。
`base` 返回 origin 分支名称，`base_sha` 返回本轮最初 fetch 的完整提交 SHA；续接返回原值。
accepted=true 只证明持久意图和控制进程接管确认，或原任务已有结果且无待投递；不证明模型收到。
ACK 等待最多 10 秒；丢失不能证明没有派发，不自动杀控制进程、换 key 或重发。
失败退出 1，安全 JSON 包含分类、定位和处理建议，见下节；保留原 key/输入/注册和现场。

## 错误分类与定位

`error` 只输出安全字段：

- `code`：稳定错误码。已有准确码保留，不将所有失败归为输入或读取错误。
- `stage`：本次失败发生的阶段。它与 launch 顶层 `stage` 的准备进度分开。
- `field`：允许列表内的字段或对象类别。未知 JSON 字段只报 `fields`，不回显其名称。
- `category`、`reason`：可证明的类别和固定原因。不能安全分辨时为 `unknown`。
- `action`、`hint`：下一步建议，不增加权限，也不触发自动控制、换模型、放权或重派。
- 可选 `task_id`、`request_id`、`environment_names`、`http_status`：只保留安全句柄、模块变量名和标准 HTTP 状态。

不输出 prompt、注册/bearer、callback URL、编码串、完整环境、原私密 stderr 或任意底层异常消息。
任务层诊断不保存原 `cause` 或 `stack`；安全异常的 stack 也只含固定错误码。

| 错误码 | 定位与动作 |
| --- | --- |
| `INVALID_LAUNCH_JSON` | `input/input_file`：修正输入文件 JSON，不当作坏 task 记录。 |
| `LAUNCH_INPUT_UNREADABLE` | `input/input_file`：核对私有文件和路径；不当作 task 不存在。安全属性和体积错误仍保留原码。 |
| `INVALID_LAUNCH_INPUT` | `validate`：核对 `schema_version`、必填字段、名称或字段组合。 |
| `INVALID_CALLBACK`、`CALLBACK_IN_PROMPT` | 指出 callback 子字段或 prompt；修正原私有输入，不输出或重新复制注册。 |
| `INVALID_PERMISSIONS` | 指出模式或 policy 子字段；格式修正不等于授权放权。 |
| `INVALID_NO_PROGRESS_TIMEOUT` | `no_progress_timeout_seconds`：1～86400 的整数，默认 900；不按工具或 retry 延长。 |
| `LAUNCH_ENVIRONMENT_INVALID` | `selection/environment`：`missing`/`invalid` 加变量名；通过已有 env 机制处理，不输出值或回退 Provider。 |
| `INVALID_MODEL`、`INVALID_VARIANT`、`TASK_MODEL_CONFIG_REQUIRED`、`TASK_TITLE_LOW_UNAVAILABLE` | 保留选择/配置的准确码，指出 model、variant 或 model_config。 |
| `LAUNCH_SELECTION_INVALID` | 选择、配置读取或快照失败；字段和固定原因可定位，但根因不能证明时仍为 unknown。 |
| `GIT_FETCH_FAILED`、`GIT_PREPARE_FAILED`、`GIT_PREPARATION_INTERRUPTED` | 指出 fetch/base、branch 或 worktree 阶段。保留 claim 和 Git 现场，人工核对，不自动续完或用缓存替代。 |
| `TASK_WRITE_FAILED` | 写入、替换或 fsync 失败。记录和副作用可能未知；可读文件不能证明失败 fsync 已完成。先查原 task，不启动另一个请求。 |
| `CONTROL_START_FAILED` | 本层明确未能启动控制进程；task 意图仍可能已经保存，先查原关联。 |
| `CONTROL_ACK_UNKNOWN` | ACK 超时、进程退出或 ACK 无效。不能证明未派发；查原 task，必要时仅显式 recover。 |
| `MODEL_OR_SESSION_SETUP_FAILED` | prompt 尚未派发，初始化根因未知。准确的 session 身份、model/effort 和 acpx pin 错误保留原码。 |
| `REQUEST_FAILED` | 原 journal 的 canonical 失败；根因未知，副作用可能已发生。核对原结果，不因泛化失败换模型、放权或重发。 |
| `REQUEST_AUTH_REQUIRED`、`REQUEST_PERMISSION_DENIED` | ACP 有明确结构化认证或权限证据；尊重拒绝，由负责人处理授权，不自动换模型、放权或重发。 |
| `REQUEST_OUTCOME_UNKNOWN`、`TURN_TRANSPORT_INTERRUPTED` | 非 canonical 观察失败或明确通信中断。只观察原 request，不将其封存为业务失败或重放授权。 |
| `NO_PROGRESS` | 原请求静默达到本轮期限。已尝试派发时封存结果未知通知，再继续被动观察；没有额外期限。 |
| `CANCEL_UNCONFIRMED`、`UNSAFE_OWNER_SOCKET` | 原 request 取消或 socket 身份未确认。取消意图/RPC 不等于 canonical cancelled；不扩大为 session-wide cancel。 |
| `INVALID_RECEIPT`、`CALLBACK_RETRYABLE_STATUS`、`DELIVERY_UNCONFIRMED` | 分别表示无有效 receipt、可重试 HTTP 状态、handoff 未知。沿原 exact body 和期限重试，不重派业务。 |
| `CALLBACK_REJECTED`、`REDIRECT_REFUSED` | 明确拒绝或重定向拒绝；保留原 outbox，由负责人处理，不向新地址发送 bearer。 |
| 原读取/安全/不支持记录码、`UNKNOWN_RECORDED_CODE` | 核对所列记录，保留原字节；缺记录、坏记录或未知旧码不授权重放。 |
| `TASK_OPERATION_FAILED` | 本层只能确认操作失败，不能安全分辨根因；沿 stage/field 核对原任务。 |

launch 错误的 `task_recorded` 为三态：`true` 表示已核对原 task 关联；`false` 表示本次在 submit 前失败；
`null` 表示原记录或持久性不能确认。`false` 不判断更早的同 key 调用。`outcome_unknown=true` 要求保留并核对
原请求或准备现场；`accepted=false`、ACK 丢失或文件缺失均不证明未派发。submit 的写入失败不启动控制进程；
若原 task 已可读，返回原 request_id，后续只能按既有显式恢复规则观察。普通 submit 响应丢失仍复用原请求。
已领取 claim 时，即使修正环境或选择，也不自动续完准备。若先前调用结果未知，先观察原请求，再处理新输入。

status/result/list items 同时显示 `execution_error`/`execution_diagnostic`、
`observation_error`/`observation_diagnostic` 和 `delivery_error`/`delivery_diagnostic`。
执行终态、非 canonical 观察失败、回调 handoff 分开。晚到 canonical 结果清除观察错误，但不改已封存 callback body。
list 的逐项 `errors` 使用相同定位字段，coverage 和有界游标规则不变。批量 recover 失败时，
`recovery_confirmed` 只数已收到 ACK 的控制请求；更早的控制可能已接管，不能将批量失败理解为全部未启动。
后续项读取失败只定位当前 task；未确认 request_id 时不返回该字段，`task_recorded=null`。

pinned acpx 的 journal 会丢失部分原 ACP/Provider 细节。任务层只识别固定认证/权限字段，
不解析异常文字、assistant 自然语言拒绝或 `retryable` 来猜 Provider policy/auth。
canonical completed 也不证明业务目标完成，仍须按授权读取结果。callback 的 401/403 不是 Provider 认证证据。
CodeAPI runner 的 fork/thread EAGAIN、执行 502 或 LibreChat 的 `PTC_TOOL_FAILED` 位于本层之外。
没有本层结构化错误和原 task/request 证据时，不映射成同一错误；由宿主负责人保留原 Workspace 执行证据。
本改造不修 PTC 宿主、替换 installed runtime 或承诺宿主恢复。

## 当前持久格式边界

仅支持当前 task.json 与 launch 记录 **version: 2**。task 必须有完整模型/config/profile、权限、
createdAt、noProgressMs 和进展起点；结果单独存入 result，callback body/state 单独保存。
已有 v2 launch 未存 base 时，沿其原约定按 main 返回及续接，保留已存 base_sha，不回填字段或迁移数据。
旧 version=1、旧 callback/ACK/unknown 和所有 runtime/session/cache/private 数据不迁移、不改字节。
当前任务在既有状态写入时可保存允许列表内的可选诊断；旧 v2 无诊断仍受支持，查询只作安全投影，不回填。
task/launch 仍为 version 2，公开响应与 callback wire version 均不变。
不支持记录报 UNSUPPORTED_TASK_RECORD（launch 元数据为 UNSUPPORTED_LAUNCH_RECORD）。
定向操作退出 1；list 列 errors/不完整 coverage；无参数 recover 明列 unsupported 并继续支持项。
坏记录、unsafe 属性和读错误失败关闭，不静默当作缺失，也不授权重放。

runtime/tasks 的 owner 标记绑定 UID/Workspace。目录 0700、记录 0600，原子替换和文件/目录 fsync
保证合作进程的持久接受。control.lock 只允许一个控制进程。锁不证明进程健康；不保存 PID 作接管
或发信号依据。继承 [安装信任边界](README.md#存储与启动)，不防 root/同 UID/可信 PVC group。

## 执行、统一时限和显式恢复

无事件计时起点是 task 持久接受的 createdAt。初始化、排队及执行使用同一条规则；进入阶段、
findSession、重连、空轮询和其他请求均不续期。原 promptStarted、thought、文本、工具状态等
执行事件续期。输出仅收集 assistant 文本，thought/工具不进入业务结果。新 message ID 替换
中间回答，按 UTF-8 限额裁剪。原 request 的 canonical turn.result 或 journal turn_result 才完成。
通信 failed/WATCH_OUTCOME_UNKNOWN 不伪装 canonical 失败；明确 setup/canonical 失败及时报告。

派发前先落盘 dispatching；从这一刻开始即可能已发送，响应丢失仍未知，禁止重发。
queued/preparing 尚未尝试 startTurn，显式 recover 可如实报告未派发失败或排队取消。
dispatching/running/ambiguous 只观察保存的原 session/request/cursor，output 与 cursor 一起保存。
不从缺日志、缺 owner、缺结果、时间流逝或控制程序退出推断重放授权。

连续无原请求事件达到时限时，控制进程先持久保存一次 error 通知：原结果和副作用未知、可能
仍执行，不自动重发或取消。回调封存后同一控制进程继续被动观察，晚到 canonical 成功/失败/取消
另存 result，查询可见；不覆盖 body、不投递第二次回调。若初始化尚未派发，可报告未派发错误，
其晚到初始化完成也不发送 prompt。

进程内及同 boot/time namespace 显式恢复沿保存的单调起点；跨重启沿原墙钟时间差，不重赠完整
期限。journal 无生成时间，新进展仅表示 cursor 后新观察到事件，不证明远端实时活跃。
控制程序存活且可调度时，超时检查间隔最多约 200 ms；callback 每次网络上限 30 秒且异步。
磁盘不可写、控制程序卡住/退出或整个 Workspace 停止时没有及时通知保证，也没有另一个 monitor。
只有显式 recover 恢复观察/补投，安装和启动不自动恢复，不重新派发业务。

cancel 只保存取消请求并对原 request ID 发 cancel_prompt，不调用 session-wide cancel。
RPC accepted/cancelled 回复只是取消请求确认，canonical cancelled 才表示原业务终态。
未派发的 queued 取消不执行业务；不影响同 session 其他 queued。acpx 私有 adapter 仅保留固定
0.21.1 的 socket 路径/UID/权限及 generation/响应身份校验，3 秒取消等待；这些校验不用于健康探测。

## 持久 outbox

每次注册只封存一个 exact body，先 fsync 再 POST，重试不重新生成：

```json
{"version":1,"callback_id":"<私密 bearer>","status":"success","output":"有界结果"}
```

仅 success/error/cancelled，不附输入/metadata/认证头。URL 仅 HTTPS（loopback fixture 可 HTTP），
路径固定 `/api/agents/task-callbacks`，拒绝用户信息/query/fragment/重定向。最多读 4096 字节
202 receipt `{version:1,receipt_id,accepted_at}`，有效 receipt 后停止重投；只证明 handoff。
网络失败、无效 receipt、408/425/429/5xx 沿同一 body 自动重试。退避 5 秒～5 分钟，Retry-After
可延至 24 小时，期限持久保存。其他状态成为 rejected，保留安全原因。不按 expiry 丢弃 outbox。
投递等待不阻塞事件消费、超时或晚到结果。进程退出后自动重试停止，须显式 recover 补投。

## 只读查询与离线安装自检

list/status/result/doctor 不建存储/锁/config，不要求 Provider key；存储不存在报 TASK_STORE_MISSING。
仅 result 返回 canonical output 和已封存 callback_output，二者分开。status 的 result_status/
terminal_at 表示真实业务结果；callback_kind/status/state 和 notification_at 表示通知及投递。
无 canonical 时 result_status/output/terminal_at 为 null。receipt 不能证明业务结束或后续推理完成。
output_limit_bytes 取注册限额，默认/最大 32768；output_bytes/truncated/available 明确裁剪和扣留。
文本含 `tcb_` 或保存的 callback URL 则扣留，不改原 body；业务敏感文本仍须按授权读取。

list 支持 state=queued|preparing|dispatching|running|ambiguous|completed 和 session 精确筛选。
默认 limit=20、scan-limit=100，上限 50/200；单记录最多 8 MiB、每页最多 32 MiB。不读 journal
或旧健康文件，不算全库总数。coverage 列读取/推进/成功/失败/字节，须连同 items/errors 解释。
stop_reason=limit|scan_limit|read_budget|end；remaining_records 始终 null。next_cursor=null 才采样到
目录末尾，complete 只指本页到末尾且无错；空 items 不表示空库。
游标用 Linux x86-64 glibc 目录 cookie，续页保留筛选；目录身份变化报 CURSOR_STALE，重查按
task_id 去重。逐记录与跨页非事务快照。安全错误不附 prompt、路径、callback 或原 Provider 错误。

doctor 只核必要安装项：active/wrapper、私有布局、源码 inventory、固定工具 metadata/pin、profile
和安装 capability。默认 full 核二进制内容/摘要，--quick 明确跳过二进制内容/摘要，仅核同 fd 元数据。
不扫描任务/依赖历史，不执行 agent/工具版本、不联系服务。遇首错停止，其后标为 not_checked。
离线通过不证明真实 Provider/MCP 健康。wrapper 缺失可用已审阅源码：

```sh
python3 -B opencode/scripts/diagnostics.py --root /mnt/opencode/toolset --quick
```

<a id="verification-and-rollout-boundary"></a>
## 验证与交付边界

```sh
python3 -B -m unittest discover -s opencode/tests -v
python3 -B opencode/build_bundle.py --check
node --test opencode/tests/task.test.mjs opencode/tests/task-launch.test.mjs opencode/tests/task-read.test.mjs
(cd opencode/scripts && npm ci --ignore-scripts --no-audit --no-fund)
env -i PATH=/usr/local/bin:/usr/bin:/bin node --test --test-concurrency=1 opencode/tests/runtime.test.mjs opencode/tests/cli-fixture.test.mjs opencode/tests/cli.test.mjs
env -i PATH=/usr/local/bin:/usr/bin:/bin OPENCODE_FIXTURE_BINARY=/private/fixture/opencode node --test opencode/tests/published.test.mjs
```

使用已有 Node 时可用其绝对路径；Python 非 root fixture 支持 NODE_FIXTURE_BINARY。
测试含单控制进程、默认/覆盖时限、原事件隔离、重连剩余期限、晚到结果、异步 outbox、显式恢复、
取消队列隔离、同 key 并发/响应丢失、Git 中断保留、有界只读和私密输入安全。
夹具先按出生身份停止自有写入者才清理；失败保留现场与首错。历史并行 heartbeat 超时、copilot
首次 resume 停顿、SQLite/worker.lock 原因仍未证；删除旧保证不证明修复，见 [UPGRADE.md](UPGRADE.md)。
无真实 Provider/MCP/QQ 或付费推理，不发布、激活模板或替换当前 toolset。平台 Skill 由负责人同步。
