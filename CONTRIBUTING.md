# Contributing

## Fork-local validation

This fork's OpenCode module uses manual validation, not the inherited upstream CI.
The three inherited workflows are [archived](.github/workflows-archive/README.md)
outside `.github/workflows`; no replacement CI or registry deployment is enabled
in this source tree. This does not change repository Actions settings or cancel
existing jobs. Deliver the workflow removals together with the reviewed module changes.

From the repository root, with Python 3.11+ and Node 22+ available:

```sh
python3 -B -m unittest discover -s opencode/tests -v
node --test opencode/tests/task.test.mjs
python3 -B opencode/build_bundle.py --check
git diff --check
```

These fixtures use synthetic tools/credentials and mock ACP or local HTTP, not
real provider/MCP requests. See [opencode/README.md](opencode/README.md#validation-and-publication-boundary)
for Terraform mock/render checks and [opencode/TASKS.md](opencode/TASKS.md#verification-and-rollout-boundary)
for optional acpx runtime/CLI fixtures and their prerequisites. Offline checks do
not establish live acceptance, publication or deployment.

修改 OpenCode 运行源码后，维护者运行 `python3 -B opencode/build_bundle.py`，将无损生成包
与源码一起提交；固定 source 的安装者无需此步骤。plan 拒绝过期摘要，启动拒绝损坏原文，
具体封装和预算见 [启动传输契约](opencode/README.md#startup-execution-budget)。

修改 Provider/任务选模型时，还须运行 pinned acpx 的 runtime/CLI fixtures、相关
Terraform mock/render，并用真实已发布 OpenCode 与本地候选做隔离 Responses/回调验收。
检查默认 codex、显式 copilot 的主请求和 title 路由、session 固定选择、恢复与取消队列。
只用合成凭据和 loopback，不因测试读取真实秘密或替换当前 toolset。

Before Git delivery, verify no `.yml`/`.yaml` files remain under `.github/workflows`
and compare the archived workflow bytes with their original paths at commit
`51524055c61443b5768b62e0d0e059459f88caa7`. Keep the archive unchanged; restoring a
workflow is a separate, explicitly approved review following its restoration policy.

## Upstream getting started (reference)

This repo uses the [Bun runtime](https://bun.sh/) to to run all code and tests. To install Bun, you can run this command on Linux/MacOS:

```shell
curl -fsSL https://bun.sh/install | bash
```

Or this command on Windows:

```shell
powershell -c "irm bun.sh/install.ps1 | iex"
```

Follow the instructions to ensure that Bun is available globally. Once Bun has been installed, clone this repository. From there, run this script to create a new module:

```shell
./new.sh NAME_OF_NEW_MODULE
```

## Upstream module tests (reference)

> **Note:** It is the responsibility of the module author to implement tests for their module. The author must test the module locally before submitting a PR.

A suite of test-helpers exists to run `terraform apply` on modules with variables, and test script output against containers.

The testing suite must be able to run docker containers with the `--network=host` flag. This typically requires running the tests on Linux as this flag does not apply to Docker Desktop for MacOS and Windows. MacOS users can work around this by using something like [colima](https://github.com/abiosoft/colima) or [Orbstack](https://orbstack.dev/) instead of Docker Desktop.

Reference the existing `*.test.ts` files to get an idea for how to set up tests.

You can run all tests in a specific file with this command:

```shell
$ bun test -t '<module>'
```

Or run all tests by running this command:

```shell
$ bun test
```

You can test a module locally by updating the source as follows

```tf
module "example" {
  source = "git::https://github.com/<USERNAME>/<REPO>.git//<MODULE-NAME>?ref=<BRANCH-NAME>"
  # You may need to remove the 'version' field, it is incompatible with some sources.
}
```

## Upstream releases (reference only)

The process below describes upstream `coder/modules`, not this fork's delivery.
The archived workflows do not run it. Any fork publication or workflow restoration
requires a separate deliberate owner decision; merging source alone does not deploy it.

> [!WARNING]
> When creating a new release, make sure that your new version number is fully accurate. If a version number is incorrect or does not exist, we may end up serving incorrect/old data for our various tools and providers.

Much of the upstream release process is automated. To cut an upstream release:

1. Navigate to [GitHub's Releases page](https://github.com/coder/modules/releases)
2. Click "Draft a new release"
3. Click the "Choose a tag" button and type a new release number in the format `v<major>.<minor>.<patch>` (e.g., `v1.18.0`). Then click "Create new tag".
4. Click the "Generate release notes" button, and clean up the resulting README. Be sure to remove any notes that would not be relevant to end-users (e.g., bumping dependencies).
5. Once everything looks good, click the "Publish release" button.

Once the release has been cut, a script will run to check whether there are any modules that will require that the new release number be published to Terraform. If there are any, a new pull request will automatically be generated. Be sure to approve this PR and merge it into the `main` branch.

Following that, our automated processes will handle publishing new data for [`registry.coder.com`](https://github.com/coder/registry.coder.com/):

1. Publishing new versions to Coder's [Terraform Registry](https://registry.terraform.io/providers/coder/coder/latest)
2. Publishing new data to the [Coder Registry](https://registry.coder.com)

> [!NOTE]
> Some data in `registry.coder.com` is fetched on demand from the Module repo's main branch. This data should be updated almost immediately after a new release, but other changes will take some time to propagate.
