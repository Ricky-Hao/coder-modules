# Provider 与任务选择

内置 env profile 恰好提供 copilot、codex，均使用
`@opencode/ai/providers/openai/responses`，完整模型定义相同。它们是本地别名，
不启用官方登录；其余 Provider 保持禁用。默认主模型 **codex/gpt-6.1-sol / max**，
title 为同 Provider Sol/low。完整元数据一致性、context/input/output 和 variants 回归保留。

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
model/variant/config path 参与去重和 session 绑定；恢复不重新解释默认值。
首次 ACP 初始化选择模型并在 prompt 前核对 model/effort 确认；失败或超过 setup+confirm
沿原 outbox 报 MODEL_OR_SESSION_SETUP_FAILED，不发 prompt。
status 显示 model/variant；续接只允许相同选择，省略时沿保存值。不迁移或自动替换 session。
旧格式的安全拒绝边界见 [当前持久格式](TASKS.md#当前持久格式边界)。

## 外部配置

非空 OPENCODE_MODULE_CONFIG 优先于内置 profile。任务可用完整当前 OpenCode 配置中的
model 默认值及其 env 引用；参数在私有快照覆盖主模型，并将 title 固定到选中 Provider 的
原标题模型/low（无该模型时用主模型/low），不修改原文件。模型须完整定义、支持请求 variant
和 low title，否则失败。配置的原生 model 字符串/对象语法沿 pinned OpenCode；不是旧记录迁移。
runtime_profile=none 无外部完整配置时，直接 ACP 保留显式 readiness 契约，任务 launch
不支持不完整模型定义。`opencode --module-profile-info` 不读凭据或联系端点。

本地 fixture 使用 pinned acpx、合成 ACP 和隔离正式 OpenCode/Responses/callback；
真实服务的端点、访问权与健康由使用方核实，未联系真实 Provider/MCP。
