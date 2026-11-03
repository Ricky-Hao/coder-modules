# coder-modules 项目补充

通用个人规则由中心 `RickyHao/agent-config` 提供。本文件只保留仓库专有约定。
先读 [README.md](README.md)、[CONTRIBUTING.md](CONTRIBUTING.md)、
[opencode/README.md](opencode/README.md)；任务、回调和查询另读
[opencode/TASKS.md](opencode/TASKS.md)，Provider/模型另读
[opencode/PROVIDERS.md](opencode/PROVIDERS.md)。

- 本 fork 维护 `opencode/`，不是旧库的 `modules/opencode/`。
- 工作流归档于 `.github/workflows-archive/`，没有 active workflow 或替代 CI。
  保留归档原字节；不恢复 workflow、发布 registry、更新模板或重启 Workspace。
- Git 交付前运行 CONTRIBUTING 的 Python、Node task/launch/read、bundle 和 diff 检查；
  运行源码变化须重生成源码包，并做适用 Terraform render/runtime fixture。
  维持 65536 字节启动预算。离线或 loopback 检查不代表真实 Provider/MCP 健康。
- Task 只用 `runtime/tasks-v3`；保留旧 namespace、session、cache 和其他私有数据。
  查询先同步中心全局规则/Skill，但不恢复、重派或改写业务记录。
- 保留 Coder 注入的 Git SSH 身份和 PATH。仅模块 Git 通过现有 hook 接受新/变化 hostkey；
  不改设备 SSH、用户 `.ssh` 或全局 SSH 设置。
- 内置 env profile 恰好为 copilot、codex，默认 codex/Sol/max、title/low。
  保留模型完整一致性、四环境变量独立校验与单任务 ACP 选择。
  Named session 固定选择，running/queued 时不切换。全局规则不做 per-task 冻结。
- 源码交付、main 合并、模板接入、运行环境激活各有边界；只向用户指定 owner/ref 推送。
