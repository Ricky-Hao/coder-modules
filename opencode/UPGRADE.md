# 当前 pin 与保留的历史证据

源码交付与运行环境升级分开。当前 pin 为 OpenCode v2.2.0-ricky.1、私有 Node 22.23.4、
acpx 0.21.1。合并/推送模块不替换真实 toolset，不激活模板或重启 Workspace。
当前 CLI、数据边界和恢复契约以 [TASKS.md](TASKS.md) 为准；不承诺以前的代码/用法兼容。
全部现有任务、session、cache、旧安装版本和其他目录保留，无自动迁移/删除/业务重放。

## 精确发行输入

[公开 prerelease](https://github.com/Ricky-Hao/opencode/releases/tag/v2.2.0-ricky.1)
tag 指向 `9291b46db483415e1c9bdaa72f8e48637e3f7b49`，基于 upstream v2.2.0
`1097e2668b1e08ad63bdf0b1c4860b9bc01e420c`，Bun 1.4.4 构建。
tag CI run 40654819290 attempt 1 成功；不是 latest 或本地 dirty 构建。

```hcl
release = {
  tag    = "v2.2.0-ricky.1"
  asset  = "opencode-linux-x64-baseline-v2.2.0-ricky.1.tar.gz"
  sha256 = "09ed8c564754413a7296c12ce147c4b60d98456dc3815db71b399e093ad7ddcd"
}
```

archive 仅含 opencode、MIT LICENSE、metadata.json；内外 metadata 相同、source_dirty=false，
tag/commit 精确匹配。metadata SHA256 为
`1ff846468bf8296c6da8274d2d937829b56917ba7a948bf9fb400d700ee9989a`，binary SHA256 为
`444fdfcef16e7e183071bdefd9620cc9af5c3796a1037cf15ca2bbfb8c43bf75`。
Node linux-x64 tar.xz SHA256 为
`1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce`。
exact npm lock 保留；不升级全局 Node/npm。

## 版本维护边界

原生 acpx 共享执行、watch cursor/request ID 和 session 队列仍使用公共 runtime。
私有 `ipc-BbYFsKOj.js` 的只读 lease/进程出生检查及取消 wire format 固定于 0.21.1，
升级必须重验。请求级取消避开原生 helper 的 owner 清理回退；不调用 session-wide cancel。
OpenCode model/effort 控制不补齐 acpx 请求/profile/effort 的原子绑定，续接切换仍拒绝。
新任务默认 codex/Sol/max、同 Provider title/low；四变量契约见 [PROVIDERS.md](PROVIDERS.md)。

## 本轮隔离验证与保留失败

- 首次 runtime/CLI 夹具依赖已删除的业务 fs import，注入改为独立 import 后，完整 CLI 单跑通过。
  随后的并行 Node 全套为 92/93，CLI 等待 heartbeat fault 原请求接收记录超时；串行全套为
  **93/93，无跳过**。原失败现场和日志保留，尚不能认定并行是超时原因。
- 正式包三次 launch 的首次回环中，codex 成功，copilot 在原生 session resume/模型控制期间
  未完成，封存结果未知通知。清理期间的 ACP disconnect/SESSION_MODEL_REPLAY_FAILED
  不能证明最初停顿原因。独立重跑三次 launch 全部成功，收到 3 个回调，确认 codex/copilot
  主请求 max、title low，以及原 codex session 续接和历史保留；首次失败仍未解释。
- 原日志保留在 `/mnt/opencode/tasks/opencode-current-runtime/`，失败根目录按原路径保留。
  `runtime-cli.log`、`final-node.log`、`published-launch.log` 保留首错；通过记录为
  `cli-current.log`、`node-complete.log`、`published-launch-isolated.log`。均为合成凭据和本地回环，
  不代表真实 Provider/MCP/QQ 或付费推理验收。

## 历史故障与测量

以下是已有记录，不作为当前版本的验收结果。原日志/DB/夹具现场不删除，未知原因仍保留未知。

- 2026-10-20，模块源 `6516ad1f2242a46dce9ed42f834542a34e525121` 的专用卷脚本为
  153559 字节，Agent 在 installer 前报 argument list too long。Coder build 可成功但脚本日志空，
  旧 status/active 留在磁盘。标准 XZ 修复当时渲染为 40722 字节，负对照复现 E2BIG。
  后续只读候选最大 57993/65536；launch 基线最大 **64873/65536，余量 663 字节**，
  原文 204710、XZ 47668、base64 63560 字节。不能用这些历史体积代替当前 Terraform render。
- 早期正式包回环复用 codex session 时曾报 SQLite database disk image is malformed/HTTP 500，
  原 DB 与失败保留。后续只读 quick_check=ok、DB hash 未变；最短正式包回环未复现。
  原轮包含取消、终止 worker 和更多 session，不能归因于 fixture、Bun/SQLite 或模块并发，
  不声称已修复。后续正式包 codex→独立 copilot→原 codex 追问保留历史，主请求 max/title low。
- 旧夹具只 TERM 就删目录有并发写入竞态，finally 的 ENOTEMPTY 也可能覆盖首错。当前按出生身份
  停自有进程并等退出，失败保留目录/首错。sing-box 固定 7f7b749 的原 TAP 未取得，
  不能据此认定生产检测失败或确定首错。前轮单次超时根因同样未定。
- 另一次 cancel/recover 等待 delivered 超时已按 exit 1 保留；原进程/journal 不足，原因未证。
  曾见同 session queued 的 monitor 约 0.45 秒 code 1 退出但无栈；随后 3b2fa59 夹具/
  7f7b749 安装捕获 privateFile(worker.json)→timer→UNSAFE_TASK_FILE，与已复现的 stat
  原子替换竞态一致，不能将每次旧超时都归于它。
- 上轮 `_fail_launch` 的 worker.lock 拒绝用例曾有一次未解释的 5 秒超时。
  原证据保留在 `/mnt/opencode/tasks/opencode-task-launch/`，本次继续保留该安全用例。
- 历史 doctor 大二进制静态样本：OpenCode 223516848、Node 124902584 字节；一次 full
  显式读 348735004 字节/约 0.398 秒，quick 315572 字节/约 0.004 秒，二进制读取为 0。
  是热缓存各一次的本地读取证据，不是冷存储、生产速度或吞吐承诺。

当前验证及精确 Git 交付证据保存在任务指定目录的 verification.json 和原日志中，
不复制为另一份仓库报告。模板、平台 Skill 和所有 Workspace 的更新由负责人验收后另行处理。
