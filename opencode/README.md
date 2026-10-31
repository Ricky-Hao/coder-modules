---
display_name: OpenCode and acpx
description: Pinned OpenCode and acpx with private storage and env-only provider integration
icon: ../.icons/code.svg
maintainer_github: Ricky-Hao
verified: false
tags: [helper, ide, ai]
---

# OpenCode and acpx

The module also installs **`opencode-task`** for detached tasks, durable callback
delivery, recovery and bounded terminal-result reads using the pinned acpx runtime.
Each task has a monitor for worker exit and callback delivery. Unknown execution
outcomes retain `ambiguous` and send an explicit supervision-failure notification;
the [health policy](TASKS.md#监督策略与边界) defines deadlines, configuration and limits.
See [TASKS.md](TASKS.md) for the CLI, private-input contract, protocol and focused
verification.

Install pinned OpenCode and acpx as the existing workspace user. Only `agent_id` is
required. For persistent use, a dedicated writable PVC is recommended:

```tf
module "opencode" {
  # Pin the module source version to a reviewed, published 40-character commit.
  source       = "git::https://github.com/Ricky-Hao/coder-modules.git//opencode?ref=<FIXED_COMMIT>"
  agent_id     = coder_agent.example.id
  install_root = "/mnt/opencode/toolset" # Optional; mount must already be writable.
}
```

Replace `<FIXED_COMMIT>` with the actual commit containing this module **after it
is published**; it is not a usable revision as written. This module is not claimed
to be published in the Coder Registry. Git sources do not accept a registry `version`
argument. For local review use `source = "./opencode"` from the repository root.

## Storage and startup

Omit `install_root` to use **`$HOME/.coder-opencode`**, resolved from the agent user's
HOME by the startup program, never Terraform's HOME or `pathexpand`. Both root and
nonroot users are supported. HOME must be canonical, user-owned and not group/world
writable; HOME and installation paths cannot traverse symlinks.

**Recommended persistence:** the template owns a dedicated PVC mounted at
`/mnt/opencode`; the module owns only its private `toolset` child. See
[examples/kubernetes.tf.example](examples/kubernetes.tf.example) for PVC/mount wiring.
An existing mount can be user-owned or root-owned with a suitable writable filesystem
group. Infrastructure must supply the correct UID/fsGroup/volume permissions for the
image. A root-owned, unwritable volume does not work for an arbitrary nonroot UID.
By default the module never changes parent permissions or silently adopts an existing
unmarked directory, even an empty one. No special init container or copied parent
preparation script is needed **when the mount already satisfies this contract**.

**Ancestor trust:** every installation and HOME/profile ancestor must be a real
directory owned by root or the current UID. World-writable nonsticky directories
are rejected anywhere in the chain, even when root-owned. Sticky shared ancestors
such as `/tmp` are allowed; the private HOME itself must still have no group/other
write permission. Nonsticky group-writable ancestors are rejected too, with one
explicit exception: the installation root's **immediate parent** may be a writable
PVC whose group includes the process. All members of that group must be trusted.
This exception does not extend to higher ancestors or to HOME/profile ancestry;
mount the dedicated PVC directly above the module's private child.

Advisory locks serialize cooperating module processes; they cannot prevent malicious
rename/replacement by the PVC group, root or the same UID. The shared-mount policy
is a trust boundary, not race-safe support for an arbitrary untrusted writable PVC.
HOME/profile access walks descriptors with no symlink following. Installation still
uses absolute paths after ancestor validation and relies on that declared boundary.
The module fails closed on an unsafe ancestor instead of changing its permissions.

### Opt-in preparation for a root-owned 0777 dedicated PVC

Some provisioners present `/mnt/opencode` as root-owned 0777 without the sticky bit.
The installer correctly refuses that unsafe parent, even when the workspace user is
root. For this specific case, set `dedicated_volume = { mount_path = "/mnt/opencode",
workspace_id = data.coder_workspace.me.id }` together with
`install_root = "/mnt/opencode/toolset"`. The new `volume_prepare_script` output is
a Python program for a **root init container before any workspace process**. The
output depends only on inputs/module files, not agent/script/data-resource attributes;
it can be used in a Pod/Deployment init command without a module/agent cycle.

The init command is `["python3", "-B", "-c", module.opencode.volume_prepare_script]`
(index the module when the caller uses count). Mount only the dedicated PVC at
`/mnt/opencode` in that init container. Use an image with Python 3.11+ and Linux
procfs (`/proc/self/fdinfo`, `/proc/self/mountinfo`); BusyBox alone is insufficient.
Preparation requires UID/EUID 0 to change a root-owned volume's mode. It does not
force the final workspace user to root and never uses sudo, chown or recursive chmod.
Templates must explicitly wire and order the init container; setting the input alone
does not execute preparation. With null/default input the output is null.

Scope is intentionally fixed: only the actual mounted `/mnt/opencode`, with private
child `toolset`. `/`, system/HOME/project/shared roots and non-mount directories are
refused. No symlinks are followed. Root-owned safe ancestors are required; fdinfo's
mount ID must match that exact mountpoint in mountinfo. Only `toolset` is managed by
this module; other volume-root entries, such as `tasks`, are allowed and are not
opened, traversed or modified. A missing `toolset` is left for the installer to create.
An existing `toolset` must be a valid private directory with the supplied workspace's
owner marker and recognized private installation entries. An unmarked directory,
unexpected files inside `toolset`, unsafe links or inconsistent ownership fail closed.
Existing `active` is allowed only in its module-managed relative-version form; the
installer separately verifies the cached inventory. No session data is migrated or
recursively inspected/changed.

Only mode **0777 → 1777** is changed, using `fchmod` on the validated open directory
descriptor; existing 1777 and supported safe modes are respected. The managed
`toolset` child is checked before and after the change. A detected concurrent change
to that child fails init; if the sticky bit was already added, it is retained rather
than weakened back to 0777.
Mount ownership and all child bytes/modes remain untouched. The volume must be
exclusively assigned to this workspace, with preparation before its users start;
checks and advisory locks do not establish lifetime exclusivity or prevent malicious
root/same-UID/trusted-group interference. Sticky protects against other UIDs replacing
existing children, not against those trusted actors or arbitrary future file creation.

This API is a local candidate until its new source commit is reviewed and published.
The earlier zero-init interface applied only to preprepared mounts. Safe-mode mounts
remain an infrastructure writability contract; preparation does not broaden a 0755
mount for nonroot users. Default HOME mode, strict ancestor checks and agent-only
invocation remain unchanged.

Without a persisted HOME or explicit persisted mount, there is **no persistence
guarantee**. Repeated startup with the same UID, workspace identity and filesystem
reuses verified cached versions. UID changes, another workspace's files and old
session-state migration are not automatic: use a fresh module-owned path or a
separately reviewed migration. Do not change ownership recursively as an upgrade.

One `coder_script` runs installation and Bash PATH integration, blocking login by
default. The module derives identity with `data.coder_workspace.me.id`. It contains
all helpers; the caller supplies no `file()` helpers, startup snippets or dependency
from agent configuration back to module outputs. This avoids agent/module cycles.

### Startup execution budget

The startup script embeds a gzip-compressed, base64-encoded bundle using Terraform's
`base64gzip`. Python's standard-library `gzip` decoder restores the exact source
files and settings in memory before invoking the existing installer. This adds no
remote bootstrap, download, prerequisite, or trust source. Installed-file inventory,
payload fingerprints, ownership checks, wrapper commands and persistent state keep
their existing contracts; transport-only changes do not invalidate a verified cache.

Coder launches scripts through execution arguments. On a Linux host with 4096-byte
pages, one argument may occupy at most 131072 bytes including its terminator.
The rendered script is ASCII and has a **65536-byte plan-time budget**, leaving
headroom for the launch wrapper. If payload/settings growth exceeds that budget,
Terraform rejects the plan; maintainers must reduce the embedded payload before
publication. Passing `bash -n` or executing a script file does not verify this
boundary. Regression tests pass the actual rendered script as one `env bash -c`
argument, then verify first installation, offline cache reuse, startup recovery
invocation, private modes and preservation of runtime and sibling data.

The 2026-10-20 gate rollout of source
`6516ad1f2242a46dce9ed42f834542a34e525121` exposed the missing execution-boundary
check: its dedicated-mount script was 153559 bytes, and the Agent failed with
`argument list too long` before the installer ran. Coder's build could succeed
while the script log stayed empty and the old installation status remained on disk.
The compact transport reduces that same rendered configuration to 40722 bytes.
The negative control reproduces `E2BIG` for the original script size; the bounded
positive cases execute on Linux, including a nonroot fixture. These are local
source/fixture results; a repaired fixed template still needs operator review,
publication and rollout verification. Check the requested source/version and
installed command as well as readiness; an old status file is not fresh startup
evidence. No runtime data repair or deletion is needed for this transport failure.

The helper appends **only the wrapper bin directory** to `.bashrc` and Bash's existing
preferred login profile (`.bash_profile`, `.bash_login`, otherwise `.profile`). It
preserves existing bytes, modes and PATH order. Modified managed blocks, unsafe links,
foreign files and concurrent profile edits are refused. Profiles that return/exit
before the appended block can prevent it running; review such profiles explicitly.
No global PATH or Node installation is changed.

Profile edits apply to **fresh shells**; they cannot modify the already-running
parent agent's environment. Existing terminals and non-Bash programs may need a new
process or absolute commands. `opencode_command`, `acpx_command` and
`opencode_task_command` are shell-quoted
absolute invocations for automation. In HOME mode these expand `"$HOME"` at execution
time; Terraform cannot know that absolute HOME path. Treat outputs as shell command
expressions, not executable filenames. Explicit-PVC mode returns a quoted absolute
path. `status_path` is absolute for an explicit root and null in HOME mode; there
the status file is `$HOME/.coder-opencode/status.json`. `script_id` identifies the
startup script. Read `state: ready` in status; agent readiness alone is insufficient.

## Pinned tools and inputs

Linux **x86-64 glibc**, Bash, Python **3.11+**, curl, tar and xz are required. No source
build or package-manager installation of prerequisites occurs. Release and Node
archives require network on first installation; verified cached reuse is offline.

| Input                   | Default                                                 |
| ----------------------- | ------------------------------------------------------- |
| `agent_id`              | Required existing agent ID                              |
| `install_root`          | Empty: runtime `$HOME/.coder-opencode`                  |
| `dedicated_volume`      | Null; explicit dedicated-volume root-init output opt-in |
| `release`               | Null: pinned public release below                       |
| `runtime_profile`       | `env`; `none` opts out                                  |
| `start_blocks_login`    | `true`                                                  |
| `install_timeout`       | `1200` seconds                                          |

OpenCode is pinned to the published fork release
[v2.2.0-ricky.1](https://github.com/Ricky-Hao/opencode/releases/tag/v2.2.0-ricky.1),
asset `opencode-linux-x64-baseline-v2.2.0-ricky.1.tar.gz`, SHA256
`09ed8c564754413a7296c12ce147c4b60d98456dc3815db71b399e093ad7ddcd`.
Its clean tagged source is `9291b46db483415e1c9bdaa72f8e48637e3f7b49`,
based on upstream v2.2.0 (`1097e2668b1e08ad63bdf0b1c4860b9bc01e420c`).
Do not substitute a dirty local validation build or a moving latest asset.
Private Node **22.23.4** and acpx **0.21.1** use fixed checksums/dependency lock.
Node follows the current Node 22 LTS maintenance release; acpx requires Node >=22.13.0.
该 Release 是 prerelease，非 latest；已核 archive、metadata、tag 与源码 commit。
发布证据、旧记录恢复限制和负责人试点顺序见 [UPGRADE.md](UPGRADE.md)。
Node stays off project PATH. npm lifecycle scripts are disabled.

To override OpenCode, supply the complete `release = { tag = ..., asset = ...,
sha256 = ... }` object after reviewing the public artifact. Tag/asset consistency,
digest, metadata, ownership and cached inventory are checked. Overrides do not
override Node/acpx. Payload or settings changes create a new fingerprinted version;
failed installation restores the previous active selection. Old versions are not
edited or automatically removed. A profile-write failure reports failed installation;
already-appended safe PATH blocks may remain and are idempotent on retry.

## Environment-only provider and MCP configuration

内置 `env` profile 恰好包含 **copilot、codex**，两者均完整提供
**`gpt-6.1-sol`、`gpt-6-astra`**。默认主模型为 **`codex/gpt-6.1-sol` / max**，
标题为同 Provider 的 Sol/low。两者使用相同 OpenAI Responses 实现和模型元数据；
完整一致性回归防止定义漂移，其余 Provider 仍被原策略禁止。
它们是本地别名，不启用官方 Copilot/Codex 登录。单任务参数、四变量及迁移方法见
[PROVIDERS.md](PROVIDERS.md)。用户自行提供兼容的端点、密钥和模型访问权。
catalog 不证明服务可用或官方定价；其中的 settings/cost/limits/variants 是随源码维护的
非秘密默认值，不会自动同步实际服务。

### Context and input budgeting

| Model         | Context tokens | Input tokens       | Output tokens      | Default reasoning    |
| ------------- | -------------- | ------------------ | ------------------ | -------------------- |
| `gpt-6.1-sol`  | 400000         | 272000             | 128000             | `max`                |
| `gpt-6-astra`  | 400000         | 272000 (unchanged) | 128000 (unchanged) | `medium` (unchanged) |

Both retain their existing costs, capabilities and `low`/`medium`/`high`/`xhigh`/`max`
variants. Compatibility follows **v2.2.0-ricky.1**, commit
`9291b46db483415e1c9bdaa72f8e48637e3f7b49`, including its
[`ConfigProvider` model limit/variant schema](https://github.com/Ricky-Hao/opencode/blob/9291b46db483415e1c9bdaa72f8e48637e3f7b49/packages/schema/src/config/provider.ts#L75-L114):

- [`SessionCompaction.calculateCeiling`](https://github.com/Ricky-Hao/opencode/blob/9291b46db483415e1c9bdaa72f8e48637e3f7b49/packages/core/src/session/compaction.ts#L1133-L1141)
  uses `(limit.input || limit.context) - compaction.buffer` when the buffer is explicit.
  It does **not** subtract the output limit. Sol's explicit **272000 = 400000 - 128000**
  input budget preserves room for the existing full output allowance. The unchanged
  **13600** buffer then triggers compaction at **258400** estimated prompt tokens,
  leaving **141600 = 128000 + 13600** tokens in the context window. The buffer is not
  deducted twice from the configured input limit. Astra keeps the same input cap.
- [`SessionModelRequest.outputLimit`](https://github.com/Ricky-Hao/opencode/blob/9291b46db483415e1c9bdaa72f8e48637e3f7b49/packages/core/src/session/model-request.ts#L85-L90)
  independently fits output to the remaining context, adding 15% to the unmeasured
  input estimate. These are
  local budgeting thresholds, not a hard prompt truncation or a guarantee against
  provider overflow. An oversized turn or estimation error can still reduce output
  or invoke the fork's overflow recovery.

### Auxiliary model and reasoning isolation

The only automatic small-model consumer in this pin is **session title generation**:

- [`Model.small`](https://github.com/Ricky-Hao/opencode/blob/9291b46db483415e1c9bdaa72f8e48637e3f7b49/packages/core/src/model.ts#L306-L318)
  searches active text models in the primary provider by family (`gpt-luna`,
  `gemini-flash-lite`, `gemini-flash`, `claude-haiku`). Neither retained model is one
  of those families; the title selector can use a lower primary-model variant instead.
- The native override is **`agents.title.model = { providerID: "codex", model:
  "gpt-6.1-sol", variant: "low" }`**. The pinned
  [`ConfigAgent.Info`](https://github.com/Ricky-Hao/opencode/blob/9291b46db483415e1c9bdaa72f8e48637e3f7b49/packages/schema/src/config/agent.ts#L11-L26)
  and [`ConfigModel.Selection`](https://github.com/Ricky-Hao/opencode/blob/9291b46db483415e1c9bdaa72f8e48637e3f7b49/packages/schema/src/config/model.ts#L12-L28)
  accept this shape. Legacy `small_model` only migrates to the title agent; it is
  not a global auxiliary setting and is not added to this profile.
- [`SessionContext.selectTitle`](https://github.com/Ricky-Hao/opencode/blob/9291b46db483415e1c9bdaa72f8e48637e3f7b49/packages/core/src/session/context.ts#L94-L124)
  resolves that model/variant separately from the session (its automatic minimal
  variant order is `none`, `minimal`, `low`).
  [`ModelResolver.withVariant`](https://github.com/Ricky-Hao/opencode/blob/9291b46db483415e1c9bdaa72f8e48637e3f7b49/packages/core/src/model-resolver.ts#L160-L184)
  overlays settings on a request-local copy, leaving Sol's catalog default and main
  selection at **max**.
  [`OpenResponses.lowerGeneration`](https://github.com/Ricky-Hao/opencode/blob/9291b46db483415e1c9bdaa72f8e48637e3f7b49/packages/ai/src/protocols/open-responses.ts#L752-L780)
  lowers `reasoningEffort` to `reasoning.effort`.
  [`SessionTitle.generate`](https://github.com/Ricky-Hao/opencode/blob/9291b46db483415e1c9bdaa72f8e48637e3f7b49/packages/core/src/session/title.ts#L105-L139)
  handles initial titles and regeneration without coding tools. If the low title
  request fails, it may retry with the unchanged primary model/variant (normally max).
- Compaction uses the loaded **session model/agent**, not the hidden `compaction`
  or `summary` agent's model
  ([`SessionCompaction.prepare`](https://github.com/Ricky-Hao/opencode/blob/9291b46db483415e1c9bdaa72f8e48637e3f7b49/packages/core/src/session/compaction.ts#L833-L850)).
  Generic [`SessionGenerate.generate`](https://github.com/Ricky-Hao/opencode/blob/9291b46db483415e1c9bdaa72f8e48637e3f7b49/packages/core/src/session/generate.ts#L26-L68)
  also resolves the current session model. Subagents use explicit selections or
  inherit their parent, not `Model.small`. These paths keep main reasoning; no
  unsupported global small-model reasoning option, third model or fork change is needed.

### Launch environment

所有 launcher 默认继承当前启动进程的环境，无需列变量名。代理（含大小写形式）、自定义变量、
工具认证、其他 Provider 和 disabled MCP 的变量均保留；`env`、`none`、外部配置和
help/version 使用相同规则。MCP 开关只决定是否生成服务配置，不删除其环境变量。
内置 profile 的 Provider/模型策略和变量校验保持，继承其他 Provider 的变量不会启用它。

模块仍覆盖 `HOME`、`XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`XDG_CACHE_HOME`、
`XDG_STATE_HOME`、`TMPDIR`、`OPENCODE_CONFIG_DIR` 和自动更新控制；原始
`OPENCODE_CONFIG`/`OPENCODE_CONFIG_CONTENT` 及任务内部控制变量不能覆盖模块选择。
任务回调协议的 `LC_TASK_CALLBACK*`、`OPENCODE_TASK_CALLBACK*`，以及含 `tcb_` bearer
的值始终过滤，不传给模型子进程。模块不保存环境快照。

| Environment names                                                                                   | Contract                                                         |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `CODEX_BASE_URL`, `CODEX_API_KEY`                                                                   | 默认 codex 任务所需；缺少则失败，不回退 |
| `COPILOT_BASE_URL`, `COPILOT_API_KEY`                                                               | 显式 copilot 任务所需；另一个完整未配置可跳过 |
| `CONTEXT7_MCP_ENABLED`, `FIRECRAWL_MCP_ENABLED`, `GITHUB_MCP_ENABLED`, `GITHUB_ACTIONS_MCP_ENABLED` | Only literal `1` enables; absent/`0` disables; other values fail |
| Each enabled prefix's `_MCP_URL`, `_MCP_API_KEY`                                                    | Required endpoint/key, child env only                            |
| Each prefix's `_MCP_AUTH_HEADER`, `_MCP_AUTH_SCHEME`                                                | Optional validated nonsecret header/scheme                       |

Context7 defaults to `Authorization: Bearer {env:CONTEXT7_MCP_API_KEY}`. The other
three default to `X-MCP-API-Key: {env:..._MCP_API_KEY}`. An Authorization header
defaults to Bearer; other headers default to no scheme. Explicit empty scheme is
allowed. OAuth is disabled. Disabled MCP entries are omitted from config; their
environment variables remain inherited. The environment also survives acpx -> OpenCode.

Endpoints/keys remain **`{env:NAME}` references** in generated config; resolved
values are never put in Terraform, installer settings, argv or module errors.
Header names/schemes are literal nonsecret settings; enable flags select entries.
Validation rejects control/non-ASCII characters, JSON interpolation delimiters,
URL credentials/query/fragment/invalid ports. Provider endpoints require HTTPS except loopback HTTP;
MCP allows HTTP(S), so supply HTTPS when transport confidentiality is needed.
Errors identify missing/invalid **variable names only**.

Content-addressed configs are written atomically at mode 0600 under
`runtime/module-profiles`, outside automatic config discovery. A safe parent lock
covers first directory and marker creation; simultaneous first launches cannot
mistake an in-progress directory for foreign state. Existing unmarked/foreign state
is still refused. Install/help/version require no keys. `--module-profile-info`
reports names and selection without reading credentials or contacting services.

**Precedence:** nonempty `OPENCODE_MODULE_CONFIG` selects an explicit user JSON file
over the bundled profile. External configs inherit the same launch environment and
can use its `{env:NAME}` references directly. `none` without
an external file keeps the explicit model/readiness-env contract. acpx keeps
deny-all/noninteractive-deny defaults; there is no automatic permission escalation.
OpenCode's own project config merging still applies. Do not print resolved debug
config, verbose service logs or environment values as a credential check.

内置 profile 不再使用 `LLM_BASE_URL`、`LLM_API_KEY`，迁移由操作者在原 Secret/env
机制中完成。另一个 Provider 部分填写或已填写的值无效时，只报告变量名。
`opencode-task submit --model copilot/gpt-6.1-sol --variant max` 可显式选择；省略参数
默认 codex。任务配置与 ACP 选择共同固定主请求、title 和辅助请求的 Provider，
不修改全局默认。named session 固定选择，冲突须换新 session；见 [TASKS.md](TASKS.md)。

## Validation and publication boundary

HOME setup、dedicated-mount startup 和 PATH 设置已通过离线 fixtures；
正式 v2.2.0-ricky.1 包另通过隔离首次/缓存安装与真实 ACP loopback。
这些检查不代表新 Workspace 的 live 验收或 registry 发布。

Run self-contained fixtures: `python3 -B -m unittest discover -s opencode/tests -v`.
They use synthetic archives/keys and mocked downloads, never real tools or services.
For actual Terraform validation/rendering use `tests/validate_terraform.py --terraform
<binary> --provider-dir <cached-provider-mirror> --scratch <new-directory>`. This
requires Terraform 1.7+ for mock-provider tests; no apply or cluster is used.
It also enforces the script budget, rejects an oversized plan, and executes the
rendered HOME/dedicated startup through the real Linux argument path using local
synthetic archives. The installer, cache and startup recovery paths run; no model
or live provider is invoked.

当前正式包回环使用私有 Node 22.23.4、acpx 0.21.1，验证默认 codex、显式 copilot、
各自 Provider 的主请求 max/title low，并在 copilot 之后返回原 codex named session
成功追问、保留历史。上轮恢复取消队列证据保留，旧 SQLite 疑点的定向结论见
[UPGRADE.md](UPGRADE.md)。所有 Responses/回调均为本地 fixture，MCP disabled；
真实 Provider/MCP 与 Workspace 试点尚需环境管家执行。

Before publication, review the added files and fixed source revision, then separately
verify first/repeat startup on root/nonroot images, mount persistence, fresh Bash and
absolute automation commands, model/variant and bounded read-only MCP operations.
Use a module-hosted process with the real launch env. Status-only or direct external
service probes do not establish end-to-end integration. No permissions should be
broadened or agent toolsets changed to make acceptance tests pass.

## License

Module code follows this repository's Apache-2.0 framework license. The installed
OpenCode distribution retains its MIT notice in [LICENSE.opencode](LICENSE.opencode)
and its verified release package; acpx/npm dependencies retain their upstream notices.
