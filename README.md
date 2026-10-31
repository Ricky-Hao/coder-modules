<div align="center">
  <h1>
  Modules
  </h1>

[Module Registry](https://registry.coder.com) | [Coder Docs](https://coder.com/docs) | [Why Coder](https://coder.com/why) | [Coder Enterprise](https://coder.com/docs/v2/latest/enterprise)

[![discord](https://img.shields.io/discord/747933592273027093?label=discord)](https://discord.gg/coder)
[![license](https://img.shields.io/github/license/coder/modules)](./LICENSE)

</div>

Modules extend Coder Templates to create reusable components for your development environment.

## Fork scope and validation

This fork maintains the OpenCode module while retaining the upstream modules and
registry references below. The inherited CI, scheduled health check and registry
deployment workflows are [archived](.github/workflows-archive/README.md), outside
`.github/workflows`; this source tree has no active GitHub workflows or replacement CI.
This is source-level deactivation, not a change to repository Actions settings.
Use [fork-local manual validation](CONTRIBUTING.md#fork-local-validation) before Git delivery.

- [OpenCode module](opencode/README.md): pinned private runtime and
  [detached tasks/callback recovery](opencode/TASKS.md). This fork module is a
  source candidate; read its publication boundary before selecting a fixed revision.
  内置 copilot、codex 默认使用 codex；四个独立环境变量及单任务选模型见
  [Provider 说明](opencode/PROVIDERS.md)。
  launcher 默认继承启动进程环境；模块目录覆盖和回调保护见
  [Launch environment](opencode/README.md#launch-environment)。
  有界任务列表、单任务诊断与离线安装自检见 [只读入口](opencode/TASKS.md#只读查询与离线安装自检)。
  `doctor` 默认完整校验；`doctor --quick` 只做静态日常核对，明确跳过二进制内容/哈希。
  Agent 可通过现有 Workspace Bash 调用 [`launch`](opencode/TASKS.md#高层-launch-入口)，
  用私密 JSON 一次准备 Git worktree 并尝试派发；续接保留原 session，第一版拒绝切换选择。

e.g.

```tf
module "code-server" {
  count    = data.coder_workspace.me.start_count
  source   = "registry.coder.com/modules/code-server/coder"
  version  = "1.0.2"
  agent_id = coder_agent.main.id
}
```

- [code-server](https://registry.coder.com/modules/code-server): Install on start, create an app to access via the dashboard, install extensions, and pre-configure editor settings.
- [personalize](https://registry.coder.com/modules/personalize): Run a script on workspace start that allows developers to run custom commands to personalize their workspace.
- [VS Code Desktop](https://registry.coder.com/modules/vscode-desktop): Add a button to open any workspace in VS Code with a single click.
- [JetBrains Gateway](https://registry.coder.com/modules/jetbrains-gateway): Display a button to launch JetBrains Gateway IDEs in the dashboard.

## Registry

Check out the [Coder Registry](https://registry.coder.com) for instructions to integrate modules into your template.

## Contributing a Module

See [CONTRIBUTING.md](./CONTRIBUTING.md) for fork-local validation and the inherited
upstream module contribution/release guidance. This fork does not automatically
publish or deploy to the Coder Registry.
