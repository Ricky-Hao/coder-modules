# copilot、codex 与单任务选模型

内置 `env` profile 恰好提供 `copilot` 和 `codex`。它们是本地 Provider 别名，
均使用 `@opencode/ai/providers/openai/responses`，不启用官方 Copilot/Codex 登录。
两个 Provider 的模型元数据和行为配置相同；完整一致性回归防止维护时漂移。
两者均允许选择，其余 Provider 仍由原策略禁止。

## 填写环境变量

在原有 Secret/env 机制中分别设置以下变量，不要把值放进 Terraform、JSON、命令参数或聊天：

| Provider | 端点 | 密钥 |
| --- | --- | --- |
| copilot | `COPILOT_BASE_URL` | `COPILOT_API_KEY` |
| codex | `CODEX_BASE_URL` | `CODEX_API_KEY` |

使用两者时填写四个变量。只使用一个时，只需该 Provider 的完整变量对；另一个完全未填写
不会阻塞。如果另一个只填了一项，或任一已填写的变量对无效，启动失败且只报变量名。
端点须兼容 OpenAI Responses。沿用原 URL/秘密校验规则：端点通常要求 HTTPS，
loopback 可用 HTTP；禁止 URL 用户信息、query、fragment、控制字符和 JSON 插值字符。
模块生成的 JSON 只保存 `{env:变量名}`，不保存实际值。

新任务不写模型参数时，主模型是 **`codex/gpt-6.1-sol`、max**，标题是
**`codex/gpt-6.1-sol`、low**。缺少 codex 凭据会明确失败，不回退到 copilot 或旧变量。

### 从 LLM_* 迁移

1. 在原 Secret/env 管理处，将原服务分别配置到 `COPILOT_BASE_URL`、`COPILOT_API_KEY`。
   操作者自行在该机制内处理值；内置 profile 不使用或迁移旧 `LLM_BASE_URL`、`LLM_API_KEY`。
2. 在同一机制中独立填写 `CODEX_BASE_URL`、`CODEX_API_KEY`，供默认任务使用。
3. 后续新启动的进程须获得新变量。launcher 默认继承启动进程的普通环境变量，无需列变量名。
   未注入 codex 时，可显式提交 copilot 任务。
4. 确认其他调用方已迁移后，再由操作者移除旧 LLM_*。内置 profile 不静默兼容旧名。

本次源码修改不注入凭据，不更新模板、不重启 Workspace，也不替换当前运行的工具。

## 单任务选择

```sh
# 默认 codex / Sol / max
opencode-task submit --key default-job --prompt-file ./prompt.txt < /private/callback.json

# 显式 copilot；标题及自动辅助请求沿 copilot，title 仍为 Sol/low
opencode-task submit --key copilot-job --model copilot/gpt-6.1-sol --variant max --prompt-file ./prompt.txt < /private/callback.json

# Astra 可选 low、medium、high、xhigh、max
opencode-task submit --key astra-job --model copilot/gpt-6-astra --variant high --prompt-file ./prompt.txt < /private/callback.json
```

`--model` 格式为 `provider/model`，variant 单独用 `--variant`。不把 variant 拼进 model，
也不通过自然语言或 readiness 环境变量选模型。只写 `--variant` 会调整本次默认模型。
内置 profile 中，显式模型省略 variant 时，Sol 取 max，Astra 取 medium；两个 Provider 相同。

两个模型均保留 context=400000、input=272000、output=128000，以及原完整
cost、capabilities、settings 和五个 variants。compaction buffer 仍为 13600。
MCP 开关、header 和默认 disabled 行为保持；disabled 只省略服务配置，环境变量仍继承。

提交前会生成不可变、0600、仅含 env 引用的任务配置，固定主模型和同 Provider 的
Sol/low title。任务记录保存非秘密选择与配置路径，纳入去重；恢复不重新解释默认值。
新 ACP session 使用显式模型选择，并在发送 prompt 前核对 ACP 确认的 model/effort。
选择失败或超过 setup 期限不发送 prompt，任务封存 error 并沿 outbox 回调；
`status` 给出安全的 setup 失败码。监督策略及恢复边界见 [TASKS.md](TASKS.md#监督策略与边界)。

`status` 显示 `model`、`variant`。named session 首次提交固定 model、variant 和配置快照；
同名后续请求须匹配。冲突报 `SESSION_MODEL_CONFLICT`，请使用新 session 名。
省略参数表示当前 profile 默认值，不会隐式继承另一个 Provider 的旧 session。
初始化由短暂锁串行化，运行和排队阶段不发送 session 级选模型控制，也不修改全局默认配置。

旧记录仍可读取，已 dispatch 的请求只按原 request ID watch/cancel，已封存回调不重写。
旧 named session 没有模型绑定，不能由新选择自动接管。旧 queued 记录未保存模型意图，
新 env 默认不会重解释它；需在原安装版本的工具环境中恢复，或显式提供原完整外部配置与所需
启动环境后恢复。原任务/session/cache 均不迁移或删除。

## 外部配置优先级

非空 `OPENCODE_MODULE_CONFIG` 仍优先于内置 env profile。原完整 JSON 的 model 作为
不写参数时的默认值，外部配置所需变量默认从启动进程继承，可直接使用 `{env:NAME}`。
旧外部 JSON 可继续自行维护 LLM_* 引用；这不构成内置 profile 的变量回退。
代理、自定义认证和其他 Provider/MCP 变量同样继承；模块覆盖及回调保护见
[Launch environment](README.md#launch-environment)。

任务模型参数会在该完整配置的私有快照中覆盖主模型，并将 title 固定到所选 Provider 的
同名标题模型/low（没有该标题模型时用所选主模型/low）。不会修改原文件。
外部模型须有完整定义且支持所需 variant 与 low title；否则提交失败。
`runtime_profile=none` 且无外部完整配置时，不支持模型参数，保留旧显式 readiness 契约。

`opencode --module-profile-info` 只显示来源、默认选择和变量名，不读取凭据或联系端点。
已在真实 pinned acpx 0.21.1、已发布 fork v2.1.2-ricky.1 及本地 v2.2.0 候选上用隔离
Responses/回调回环验证。当前默认已更新为正式发布的 v2.2.0-ricky.1，并用实际发布包
核验 codex→copilot→原 codex named session 的成功追问及历史延续；见 [UPGRADE.md](UPGRADE.md)。
实际服务的端点和访问权仍由使用方提供，本次未联系真实 Provider/MCP。
