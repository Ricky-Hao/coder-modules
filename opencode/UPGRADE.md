# v2.2.0-ricky.1 下游升级准备

当前模块默认仍引用已经发布并核验过的 **v2.1.2-ricky.1**。
本次仅将私有 Node 更新到 **22.23.4**、acpx 更新到 **0.21.1**，并更新 exact npm lock。
不创建 fork tag/Release，不更换已运行 toolset，也不激活模板。

fork 候选基于上游 **v2.2.0**，提交
`1097e2668b1e08ad63bdf0b1c4860b9bc01e420c`，使用 **Bun 1.4.4** 构建。
实际候选源码 commit、构建产物和验证结果记录在本次交付报告。
本地 clean、untagged 构建仅是验证产物，metadata 的 `source_tag` 为 null；
它不满足模块对已发布 tagged asset 的要求，不能把其 checksum 写入默认 pin。

## 待发布后的精确输入

负责人另行批准发布候选的精确 commit 后，按 fork 发布规则创建自有 tag 和 prerelease。
随后从公开 Release 下载并核对 `SHA256SUMS`、archive 和 metadata，才可填写：

```hcl
release = {
  tag    = "v2.2.0-ricky.1"
  asset  = "opencode-linux-x64-baseline-v2.2.0-ricky.1.tar.gz"
  sha256 = "<VERIFIED_RELEASE_ASSET_SHA256>"
}
```

预期下载位置是
`https://github.com/Ricky-Hao/opencode/releases/download/v2.2.0-ricky.1/opencode-linux-x64-baseline-v2.2.0-ricky.1.tar.gz`。
这是**待发布输入**，本阶段不声称该 URL 存在。占位 digest 不是可用配置。
完整 object 可作为调用方的 `release` override，无需立即改变模块默认值。

若要更新默认值，需要同时修改 `opencode/main.tf` 的 tag/asset/sha256、
`tests/defaults.tftest.hcl` 的默认断言及 README/TASKS 的 pin/provenance 说明，
并重跑 Python、Node、Terraform mock/render 和真实发布资产的隔离安装/loopback 验证。
metadata 必须为 clean、tag 精确匹配、源码 commit 与批准 commit 一致，
目标为 Linux x64 glibc baseline，archive 包含 `opencode`、MIT LICENSE、metadata。
模板固定版本更新和 Workspace 升级仍需后续单独安排。

## acpx 协议兼容性

0.21.1 的 `createSharedAcpRuntime`、`turn.result`、`watchSession({handle,cursor})`
和 request ID 关联契约仍可用于任务驱动。取消适配器继续使用与 shared turn.cancel 相同的
`tryCancelOnRunningOwner({sessionId,targetRequestId})`，内部文件从
`ipc-BW06Pbb8.js` 改为 `ipc-BbYFsKOj.js`，导出仍为 `t`。
版本 guard 固定为 0.21.1；后续升级必须重新核对内部导出并运行取消隔离测试。
不调用 session-wide cancel，不自动重放未知请求，也不迁移旧任务或 session。

Node 22.23.4 满足 acpx 的 `>=22.13.0` 要求。
Node 的 linux-x64 tar.xz SHA256 固定为
`1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce`，
来源为官方 `https://nodejs.org/dist/v22.23.4/SHASUMS256.txt`。
依赖更新不升级全局 Node/npm，也不改项目 PATH。

本次用 clean、untagged 的候选二进制和实际 acpx 0.21.1、Node 22.23.4
完成隔离 loopback：模块启动器读取双 Provider 外部 JSON，任务成功回调，
同 session 追问保留历史；停止本次 fixture 的任务 worker 后，恢复取消只作用于指定
request ID，排队的下一请求仍成功。主模型 Sol/max、title Sol/low 的请求均已核对。
该验收只连接本地 Responses 和回调服务，MCP 保持 disabled，不证明真实新端点可用。

第二个 Provider 的配置准备见 [PROVIDERS.md](PROVIDERS.md)。
