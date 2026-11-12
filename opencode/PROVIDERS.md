# Provider 与任务选择

内置 env profile 恰好提供 copilot、codex，均使用
`@opencode/ai/providers/openai/responses`，完整模型定义相同。它们是本地别名，
不启用官方登录；其余 Provider 保持禁用。默认主模型 **codex/gpt-6.1-sol / max**，
title 为同 Provider Sol/low。完整元数据一致性、context/input/output 和 variants 回归保留。

codex 默认设置 `providers.codex.settings.transport = "websocket"`，使用固定 fork 原生
Responses WebSocket；copilot 保持未指定 transport，主请求沿 HTTP/SSE。
固定 fork 的 session 主请求消费此设置；独立的 title/low 请求仍走 HTTP/SSE。
WebSocket 使用 `/responses`、`response.create` 和原生连接/续接逻辑，不改模型或权限选择。
原生实现会在连接/升级失败时回退 HTTP，并将该 session 保持在 HTTP；
请求可能已发送后的中断仍按原生错误语义处理，不把任意中断说成透明回退。
已有 task/session 沿保存的不可变 profile 保留原传输与压缩策略，不迁移或回写；
新 task 才采用更新默认值。

codex 默认设置 `providers.codex.settings.compaction = {"type":"native"}`，复用固定 fork
原生远程压缩：上游返回不透明的加密 checkpoint，后续上下文使用该 checkpoint 和保留的近期
用户消息。普通 summary 则由 OpenCode 调用 session 模型生成文本摘要；copilot 保持此默认策略。
两者沿用现有自动压缩阈值，native 始终使用 session 模型，title/low 路由不变。

固定版本优先在 `/responses` 发送末尾带 `compaction_trigger` 的请求，并接收含非空
`encrypted_content` 的 `compaction` 输出。HTTP 使用完整 input；WebSocket 可沿原生续接优化
使用 `previous_response_id` 和增量 input。协议能力还包含独立的 `/responses/compact` 路径，
但默认 Responses route 优先使用 trigger。
上游模型和代理须支持并透传该协议及后续 checkpoint；仅兼容普通 Responses 或 WebSocket
不足以证明支持 native。HTTP fallback 只改变传输，不取消 native 策略；不支持时沿原生错误
语义处理，模块不自动切回 summary。需要普通摘要时，在外部完整配置中显式设置
`settings.compaction = {"type":"summary"}`；模型级设置优先于 Provider 级设置。

固定 `v2.2.0-ricky.1` 已用候选配置通过 loopback WebSocket、工具续接和同 session 下一轮验证，
另用既有 CODEX 环境完成一次隔离真实请求：观测到 WebSocket `response.create` 和
`response.completed`，返回 `OK`，未发生主请求 HTTP POST。真实验收只证明该次端点请求；
不包含持续运行、所有模型或所有代理链路。脚本和配置只保存合成信息及 env 引用。

## 环境变量

在原 Secret/env 机制中独立填写，不把实际值放进 Terraform、JSON、argv 或聊天：

| Provider | 端点 | 密钥 |
| --- | --- | --- |
| copilot | COPILOT_BASE_URL | COPILOT_API_KEY |
| codex | CODEX_BASE_URL | CODEX_API_KEY |

只需选中 Provider 的完整变量对；另一个完全未填可跳过，部分填写或任一已填值无效则失败，
只列变量名。默认 codex 缺凭据不回退。内置 profile 不使用 LLM_BASE_URL/LLM_API_KEY。
端点须兼容 Responses，HTTPS 或 loopback HTTP；拒绝用户信息/query/fragment/坏端口、
控制字符和 JSON 插值字符。配置仅保存 `{env:NAME}`。
普通代理、其他认证和 disabled MCP 变量继承规则见 [启动环境](README.md#launch-environment)。
源码交付不注入凭据、不更新模板或重启 Workspace。

## launch JSON 选择

完整私有文件 schema 见 [TASKS.md](TASKS.md#高层-launch-入口)。在该 JSON 中选择：

| JSON 可选字段 | 主请求 | title |
| --- | --- | --- |
| 全部省略 | codex/Sol/max | codex/Sol/low |
| `"provider":"copilot"` | copilot/Sol/max | copilot/Sol/low |
| `"model":"gpt-6-astra","variant":"high"` | codex/Astra/high | codex/Sol/low |
| `"variant":"low"` | 默认模型/low | 同 Provider Sol/low |

provider/model 分别填 ID，不拼成一个字段；variant 独立，不靠自然语言或 readiness 环境选模型。
新任务显式 provider/model 但省略 variant 时，Sol 默认 max、Astra 默认 medium。
两个模型均保留 context=400000、input=272000、output=128000，buffer=13600 和完整
cost/capabilities/settings；均支持 low/medium/high/xhigh/max。

launch 在接受前生成不可变、0600、仅含 env 引用的任务配置，固定主模型和同 Provider title/low。
task.json 只引用该不可变快照；同 key 按原输入摘要去重，续接复用保存选择；恢复不重新解释默认值。
首次 ACP 初始化选择模型并在 prompt 前核对 model/effort 确认；明确失败或超过统一无进展时限
沿原 outbox 报明确派发前失败，不发 prompt。task 不复制 prompt/完整注册；原私密输入须保留到通知封存。
status 显示 model/variant；续接只允许相同选择，省略时沿保存值。不迁移或自动替换 session。
新任务只用 tasks-v3，旧目录不扫描或迁移，见 [当前持久格式](TASKS.md#当前持久格式)。

## 外部配置

非空 OPENCODE_MODULE_CONFIG 优先于内置 profile，不补入内置 transport/compaction 默认。
任务可用完整当前 OpenCode 配置中的
model 默认值及其 env 引用；参数在私有快照覆盖主模型，并将 title 固定到选中 Provider 的
原标题模型/low（无该模型时用主模型/low），不修改原文件。模型须完整定义、支持请求 variant
和 low title，否则失败。配置的原生 model 字符串/对象语法沿 pinned OpenCode；不是旧记录迁移。
runtime_profile=none 无外部完整配置时，直接 ACP 保留显式 readiness 契约，任务 launch
不支持不完整模型定义。`opencode --module-profile-info` 不读凭据或联系端点。

本地 fixture 使用 pinned acpx、合成 ACP 和隔离正式 OpenCode/Responses/callback；
真实服务的端点、访问权与持续健康由使用方核实；上面的单次 CODEX WebSocket 请求是显式授权的
隔离验收，其他 fixture 仅使用合成凭据、loopback，不联系真实 Provider/MCP。
