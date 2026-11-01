# OpenCode 极简任务层

本模块固定 OpenCode、Node 和 acpx **0.21.1**。OpenCode 管模型、工具和上下文；acpx 管
session、request、queue 和 journal。模块只准备 Git、派发一次、观察并保存结果、持久通知。
适用于单人、可信本地文件；不防同 UID/root 的恶意修改，不提供跨记录事务快照。

## 入口

```sh
opencode-task launch --input-file /absolute/private/input.json
opencode-task launch --input-file /absolute/private/next.json --continue-from TASK_ID
opencode-task status TASK_ID
opencode-task result TASK_ID
opencode-task list --phase dispatched --limit 20
opencode-task cancel TASK_ID
opencode-task recover TASK_ID
opencode-task doctor --quick
```

help/version、launch --help、status/result/list/doctor 只读，不创建目录、锁或配置，不读 Provider
凭据。查询不恢复任务。`recover` 省略 ID 时只处理当前 namespace 中未完成或待投递的记录；
preparing 留作人工核对。没有公开 submit、inspect 或自动恢复入口。

## 高层 launch 入口

原生 callback 注册保存在调用者提供的私密输入原位，不放进模型 prompt：

```json
{
  "schema_version": 1,
  "key": "example-1",
  "repo_path": "/workspaces/project",
  "branch": "feat/example-1",
  "worktree": "project-example-1",
  "base": "main",
  "prompt": "完成已授权修改并报告实际检查。",
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

新任务必填 schema_version/key/repo_path/branch/worktree/prompt/callback；未知字段拒绝。
key 最多 256 字符，prompt 非空且最多 1 MiB，callback 最多 4096 字节，总输入最多 1 MiB+16 KiB。
callback 只接受固定 task-callbacks 路径、HTTPS 或 loopback HTTP，无用户信息/query/fragment。
原生注册的其他字段留在原文件，不复制进 task。输出默认/最大 32768 字节，可显式收紧。

输入必须为当前 UID 的 0600 regular、单链接文件，直接父目录为该 UID 的 0700 目录，
全路径无 symlink。接入和 worker 使用输入时校验；普通 task 查询不重复这套检查。
**保留原文件且不要修改，直到通知封存。** task 只保存绝对输入路径与规范 JSON 摘要；
worker 派发和首次封存通知时需要原 prompt/注册，输入丢失或变化时明确失败，不猜回调目标。
通知封存后，补投只依赖 outbox，不再需要原输入或模型配置。

repo_path 必须是 Git 顶层且有 origin。branch/base 为最长 240 字符的分段名称，拒绝 HEAD、
`..`、尾点、`.lock` 和 revision 表达式；worktree 是最长 64 字符的简单名称，位置固定在
repo 的父目录。已有分支/目录直接拒绝；不覆盖、stash/reset 或清理。

launch 校验输入和完整模型配置，排他 mkdir 领取 key，保存 preparing，再 fresh fetch origin
指定 base（缺省 main）到本次独立 ref，取得完整 SHA，创建 branch/worktree 并保存 ready。
不使用缓存/tag，不改原 checkout 分支或 FETCH_HEAD。Git 部分准备失败保留 task/对象现场，
同 key 不续完、不 refetch；新 key 也不是自动恢复授权。

新 launch 权限缺省 **approve-all**。可显式 deny-all/approve-reads 和原生 policy；policy 各类
规则最多 32 条，每条最多 256 字符，原生明确拒绝和非交互 escalation 拒绝保留。
模型和 title/low 完整配置契约见 [PROVIDERS.md](PROVIDERS.md)。

## 续接与去重

continue 只接受 schema_version/key/prompt/callback，以及可选权限、provider/model/variant 和时限。
前轮须有可信终态与 backend session；原请求未知、只投递过通知或 control 退出都不授权续接。
保留原 repo/worktree/branch/base/full SHA/session/model/profile，不 refetch、换 session 或切模型。
显式相同模型选择可用；权限省略继承前轮，时限省略仍为本轮 **900 秒**。

前轮的 `successor.json` 排他发布一个后继。不同 key 并发续接时一方胜出，另一方
CONTINUE_NOT_LATEST。后继准备中断也保留领取，不自动释放、续完或再建。

固定 key 对应 `task_` 加 key 的 SHA256。完整相同输入只读返回原 task/request；不同输入
LAUNCH_CONFLICT。重复 launch 不启动 worker、recover、startTurn 或 Git 准备。排他目录存在但
task 尚未完整写入时也保留现场，不接管。输入路径可以不同，但复用仍引用第一次保存的路径。

## 当前持久格式

只读写 `runtime/tasks-v3/task_<摘要>/`，不扫描、迁移、修复或删除旧 namespace：

| 文件 | 事实与写入者 |
| --- | --- |
| task.json | 有效配置引用、Git/session/request 句柄、准备子步骤、进展、单份输出与终态；launch 准备，worker 接管后独写 |
| control.lock | 该 task 的 nonblocking 排他 worker 锁 |
| cancel.request | 取消后才写入的持久意图；取消 CLI 不写 task |
| successor.json | 原轮被续接时排他发布的唯一后继 |
| outbox.json | 通知封存后才保存的 exact wire body、目标、重试与 receipt；独立于 task.result |

没有 .launches、.sessions、origin/tail、launch proof、task owner、副本输入、报告或恢复账本。
profile 只用现有内容寻址、原子排他发布，无目录锁或重复 owner。安装根的信任边界保留。
task 源码分 CLI、launch、store、worker、固定 ACP adapter 五职责，无通用 backend/兼容框架。

普通 JSON 有读取上限，坏 JSON 报错，不冒充缺失或自动补齐。无读锁、反复 inode/属主/祖先
检查、cookie/cursor 分页或跨文件快照。关键写入用 temp+atomic replace、文件/目录 fsync；
派发标记、终态、outbox 立即保存。普通 journal 进展/文本在现有约 200 ms 循环合并保存，
cursor 与对应输出一起保存，不每 token fsync。

## 回执、错误与查询

launch 有限等待 worker ACK，返回当时事实，不等 backend session/started。worker 接管后
launch 不再写 task，也不为了 null backend 字段追加查询。ACK 未知可能已派发：保留原句柄，
不 kill、换 key 或重发。`accepted` 表示 worker 已保存接管事实，不等于 started 或业务完成。
重入只返回保存的原事实，不伪造本次新 ACK；fsync 出错的 task_recorded 为 null，不能据此重派。

launch/status 共用固定摘要：key/task/request、accepted/reused/phase/step、dispatch_state 与
outcome_unknown，实际 repo/branch/worktree/base/full SHA，session/backend/acpx 已知句柄，
continue_from、实际 model/variant、固定白名单权限摘要、时限、直接 status/result 命令及
task_directory。未创建 worktree 为 null；没有旧 proof 或计划产物存在性的额外扫描。

result 另外给 canonical output、callback_output、output_truncated/output_incomplete。
晚到 canonical 与已封存 callback 分开。成功只说明程序观察到 canonical success。
终态先到但 journal 输出取不全时仍保存真实终态，通知说明输出不全，不重新执行业务。
含 callback bearer/目标 URL 的输出扣留；公开摘要不展开 prompt、registration、env 或 raw stderr。

list 枚举当前 namespace 全部记录，筛选 phase/session 后按创建时间倒序、再 limit，默认 20、
最大 50；逐记录 errors 不吞。不截前 200 个 hash，无分页框架或全库快照。
错误只含决定下一步所需 code/stage/field/安全 reason/action。认证/权限只按结构证据识别，
不猜异常自然语言，也不输出底层 message/cause/stack、remote 或凭据。

## 执行、时限与显式恢复

主要 phase 只有 preparing、ready、dispatched、finished；unknown 用事实表达，不另建状态机。
worker 持自己的 control.lock，startTurn **之前持久保存 dispatched**。从此永不重发。
recover 见到 ready 也只保存派发前失败/取消；preparing 保留 Git 现场。

保留 **explicit_recovery_only / execution_stalls_only / durable_outbox**。统一无进展期限从
持久任务进展起算，覆盖准备后初始化、排队、执行；缺省 900 秒，显式整数 1..86400。
只有原 request 的 thought/text/tool 等 journal 消息和 promptStarted/turn_started 续期；
查询、空轮询、重连或其他 request 不续期。同 boot 用单调时钟，跨 boot 用保存的墙钟差，
恢复不重赠期限。派发前到期明确失败，迟到初始化不得发送 prompt；已可能派发后到期只封
一次 unknown error 通知，并继续 passive 观察。晚 canonical 只更新 task.result，不改 body 或第二次通知。

journal 按原 requestId/cursor 聚合唯一输出。startTurn 的 promptStarted/result/异常仍接住；
立即 closeStream 清空关闭 acpx 本地旁路队列，不停止 IPC/result。通信 failed、
WATCH_OUTCOME_UNKNOWN 不是 canonical；journal 的可信 turn_result 与 API 已知终态保留。
cursor 过期/轮转报告观察错误，不清 cursor 猜测或重派。result Promise 先到时短暂排空 journal；
即使 unknown 通知已投递或被拒绝，也等输出完整或原有 3 秒排空期限再退出，不改原通知。
取不全明确 output_incomplete，排空不延长执行期限。没有保留全量旁路 permission_escalation 的要求。

worker 不监护自身。进程/Workspace 停止或磁盘不可写时无及时通知保证；无自动 recover、
daemon、租约、接管或健康探针。已 finished 且有 outbox 的 recover 只补投，不初始化 Provider。

cancel 先保存 cancel.request，再尝试原 request 的 cancel_prompt。无 worker 时意图保留。
保留固定 socket 路径、UID、generation 和响应身份校验，不 session-wide cancel；RPC 确认不等于
canonical cancelled，发送失败报 CANCEL_UNCONFIRMED。显式 recover 可观察原请求并处理意图。

## 持久 outbox

canonical 或期限先到者只封一次 exact body，先 fsync 再 POST；没有按 expiry 自动删除。
有效 202 receipt 才证明交接。网络/坏 receipt/408/425/429/5xx 只重试原 body，退避 5 秒至
5 分钟，真实 Retry-After 最多 24 小时并保存。redirect 拒绝，其余明确拒绝保留原 outbox。
最长 30 秒 HTTP 等待与执行事件、超时、取消、晚结果异步协调。receipt 仅证明 handoff。

## Verification and rollout boundary

必跑 Python、Node task/launch/read、bundle --check、diff --check 与 inactive workflow/archive
核对；命令见 [CONTRIBUTING.md](../CONTRIBUTING.md)。变更选模型/运行入口时还跑固定 acpx 的
runtime/CLI、正式已发布 OpenCode+合成凭据的 Responses/callback loopback、Terraform 五种
render/首次/cache/nonroot/PVC 保留。测试不进 payload，不访问真实付费 Provider/MCP/QQ。
源码候选不代表部署；main 合并、模板版本与激活/Workspace 更新分别由负责人按授权处理。

固定依赖与 loopback 入口（Node 22+，仅在源码目录装测试依赖）：

```sh
npm --prefix opencode/scripts ci --ignore-scripts --no-audit --no-fund
env -i PATH=/usr/local/bin:/usr/bin:/bin node --test --test-concurrency=1 opencode/tests/runtime.test.mjs opencode/tests/cli-fixture.test.mjs opencode/tests/cli.test.mjs
env -i PATH=/usr/local/bin:/usr/bin:/bin OPENCODE_FIXTURE_BINARY=/private/fixture/opencode node --test opencode/tests/published.test.mjs
```

OPENCODE_FIXTURE_BINARY 指向已发布的固定 OpenCode。原生 OpenSSH 回环 fixture 另需隔离的
paramiko 3.5.1，用 PYTHONPATH 指向即可，不进 payload。Terraform 命令见
[README](README.md#validation-and-publication-boundary)。
