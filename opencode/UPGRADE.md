# v2.2.0-ricky.1 发布 pin 与试点交接

模块默认已更新为真实发布的 **v2.2.0-ricky.1**，私有 Node **22.23.4**、
acpx **0.21.1** 和 exact npm lock 保持。模块提交与运行环境升级是两个步骤；
源码修改不会替换运行中的 toolset、激活模板或重启 Workspace。

## 精确发布输入

[Release](https://github.com/Ricky-Hao/opencode/releases/tag/v2.2.0-ricky.1) 是 prerelease，
不是 latest。tag 精确指向 `9291b46db483415e1c9bdaa72f8e48637e3f7b49`；
tag CI run `40654819290` attempt 1 成功。它基于上游 **v2.2.0**
（`1097e2668b1e08ad63bdf0b1c4860b9bc01e420c`），用 **Bun 1.4.4** 构建。

```hcl
release = {
  tag    = "v2.2.0-ricky.1"
  asset  = "opencode-linux-x64-baseline-v2.2.0-ricky.1.tar.gz"
  sha256 = "09ed8c564754413a7296c12ce147c4b60d98456dc3815db71b399e093ad7ddcd"
}
```

固定下载地址为
`https://github.com/Ricky-Hao/opencode/releases/download/v2.2.0-ricky.1/opencode-linux-x64-baseline-v2.2.0-ricky.1.tar.gz`。
已核 `SHA256SUMS`、archive 和 metadata。archive 仅包含 `opencode`、MIT LICENSE、
`metadata.json`；内外 metadata 一致，`source_dirty=false`、tag 与源码 commit 精确匹配。
metadata SHA256 为 `1ff846468bf8296c6da8274d2d937829b56917ba7a948bf9fb400d700ee9989a`，
binary SHA256 为 `444fdfcef16e7e183071bdefd9620cc9af5c3796a1037cf15ca2bbfb8c43bf75`。
目标仍是 Linux x64 glibc baseline。不使用旧本地 untagged 候选的 hash 或移动 latest。

## 配置与持久记录

内置 profile 为 copilot、codex，默认 codex/Sol/max，title codex/Sol/low；
单任务 `--model`、`--variant` 和 named session 固定选择的契约保持。
四变量及旧 LLM_* 迁移见 [PROVIDERS.md](PROVIDERS.md)。变量继续由原 Secret/env
机制注入；使用 Coder 用户级 Secrets 时，新 Agent 重新获取 manifest 后取得变量，
模板无需为它们增加 env_from 或 Secret 映射。源码不读取、复制真实值。

安装保留任务、session、cache、旧工具版本及 toolset 外的目录，不做破坏性迁移。
已 dispatch 请求按原 request ID 恢复或取消，不重复 dispatch，也不重写已封存结果。
旧 queued 记录没有模型意图，不能套用新 codex 默认；需在原工具版本环境中，
或用原完整外部配置与所需启动环境恢复。旧 named session 没有模型绑定时拒绝新选择接管。
详见 [TASKS.md](TASKS.md)。

## 本地验收与数据库疑点

真实发布包已通过隔离首次/缓存安装，实际执行 pinned Node/npm/acpx，复用已有公开下载
缓存并重新校验 archive hash。模块 Python、Node task/runtime/CLI 和 Terraform mock/render
检查通过；未重跑无变更 fork 的构建或 TypeScript 全套。

真实 Responses/回调回环使用正式发布二进制与 acpx 0.21.1，MCP disabled，合成凭据。
新 codex named session 成功、独立 copilot session 成功后，返回同一 codex session
追问仍成功，实际请求保留原回答历史。主请求 max、各自 Provider 的 title low 均已核对。

上轮旧回环曾在复用 codex session 时记录 SQLite `database disk image is malformed`
及 HTTP 500，原失败与 DB 保留。此次只读 `quick_check` 返回 `ok`，DB hash 未变；
最短正式包回环没有复现。旧轮次还包含取消、终止 worker 和更多独立 session，
不足以将错误归因于 fixture、Bun/SQLite 或模块并发。原原因未证，此次未声称修复旧 DB。
完整证据在本次交付报告，不能用新 session 成功替代原 session 追问验证。

## acpx 与 Node 维护约束

0.21.1 的 `createSharedAcpRuntime`、`turn.result`、`watchSession({handle,cursor})`
和 request ID 契约保持。取消适配器继续使用 shared turn.cancel 相同的
`tryCancelOnRunningOwner({sessionId,targetRequestId})`，内部文件是
`ipc-BbYFsKOj.js`，导出为 `t`。版本 guard 固定 0.21.1；后续升级须重新核对内部导出
并运行取消隔离测试。不调用 session-wide cancel，不自动重放未知请求。

Node 22.23.4 满足 acpx 的 `>=22.13.0` 要求。官方 linux-x64 tar.xz SHA256 为
`1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce`。
不升级全局 Node/npm，也不改项目 PATH。

## 负责人后续试点

由环境管家将模板固定到本次最终模块 commit，仅升级 **ricky/sing-box**，检查新 Agent
注入、首次/重复启动、私有安装状态、真实模型请求与受限 MCP 行为。试点成功后，
再将该精确模板版本设为 active。其他 Workspace 不在试点范围。
这些生命周期动作与真实 Provider/MCP 验收尚未由本地源码检查完成。
