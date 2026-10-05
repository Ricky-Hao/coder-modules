---
display_name: OpenCode and acpx
description: Pinned OpenCode and acpx with private storage and env-only provider integration
icon: ../.icons/code.svg
maintainer_github: Ricky-Hao
verified: false
tags: [helper, ide, ai]
---

# OpenCode and acpx

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
The module never sudo/chmods/chowns the parent or silently adopts an existing
unmarked directory, even an empty one. No special init container or copied parent
preparation script is needed when the mount already satisfies this contract.

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

Without a persisted HOME or explicit persisted mount, there is **no persistence
guarantee**. Repeated startup with the same UID, workspace identity and filesystem
reuses verified cached versions. UID changes, another workspace's files and old
session-state migration are not automatic: use a fresh module-owned path or a
separately reviewed migration. Do not change ownership recursively as an upgrade.

One `coder_script` runs installation and Bash PATH integration, blocking login by
default. The module derives identity with `data.coder_workspace.me.id`. It contains
all helpers; the caller supplies no `file()` helpers, startup snippets or dependency
from agent configuration back to module outputs. This avoids agent/module cycles.

The helper appends **only the wrapper bin directory** to `.bashrc` and Bash's existing
preferred login profile (`.bash_profile`, `.bash_login`, otherwise `.profile`). It
preserves existing bytes, modes and PATH order. Modified managed blocks, unsafe links,
foreign files and concurrent profile edits are refused. Profiles that return/exit
before the appended block can prevent it running; review such profiles explicitly.
No global PATH or Node installation is changed.

Profile edits apply to **fresh shells**; they cannot modify the already-running
parent agent's environment. Existing terminals and non-Bash programs may need a new
process or absolute commands. `opencode_command` and `acpx_command` are shell-quoted
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

| Input | Default |
| --- | --- |
| `agent_id` | Required existing agent ID |
| `install_root` | Empty: runtime `$HOME/.coder-opencode` |
| `release` | Null: pinned public release below |
| `runtime_profile` | `env`; `none` opts out |
| `runtime_env_allowlist` | `[]`; extra names only |
| `start_blocks_login` | `true` |
| `install_timeout` | `1200` seconds |

OpenCode is pinned to the public fork release
[v2.0.19-ricky.1](https://github.com/Ricky-Hao/opencode/releases/tag/v2.0.19-ricky.1),
asset `opencode-linux-x64-baseline-v2.0.19-ricky.1.tar.gz`, SHA256
`3494e42923ec3279bacc227e7274d6c580c76e7b28d3a6ea85042edb79feae0a`.
Private Node **22.22.0** and acpx **0.19.3** retain fixed checksums/dependency lock.
Node stays off project PATH. npm lifecycle scripts are disabled.

To override OpenCode, supply the complete `release = { tag = ..., asset = ...,
sha256 = ... }` object after reviewing the public artifact. Tag/asset consistency,
digest, metadata, ownership and cached inventory are checked. Overrides do not
override Node/acpx. Payload or settings changes create a new fingerprinted version;
failed installation restores the previous active selection. Old versions are not
edited or automatically removed. A profile-write failure reports failed installation;
already-appended safe PATH blocks may remain and are idempotent on retry.

## Environment-only provider and MCP configuration

Default `env` profile includes a nine-model catalog and selects
**`copilot/gpt-6-astra`**, variant **`medium`**, with compaction and deny-other-provider
policy. **`copilot` is a local provider alias, not official GitHub Copilot login/auth**.
It uses the fork's installed OpenAI Responses provider implementation. Users must
supply a compatible endpoint/key and actual model access; the catalog does not
establish availability or official pricing. Catalog settings/cost/limits/variants
are bundled nonsecret defaults, not a continuously synchronized service catalog.

| Environment names | Contract |
| --- | --- |
| `LLM_BASE_URL`, `LLM_API_KEY` | Required on a real provider launch |
| `CONTEXT7_MCP_ENABLED`, `FIRECRAWL_MCP_ENABLED`, `GITHUB_MCP_ENABLED`, `GITHUB_ACTIONS_MCP_ENABLED` | Only literal `1` enables; absent/`0` disables; other values fail |
| Each enabled prefix's `_MCP_URL`, `_MCP_API_KEY` | Required endpoint/key, child env only |
| Each prefix's `_MCP_AUTH_HEADER`, `_MCP_AUTH_SCHEME` | Optional validated nonsecret header/scheme |

Context7 defaults to `Authorization: Bearer {env:CONTEXT7_MCP_API_KEY}`. The other
three default to `X-MCP-API-Key: {env:..._MCP_API_KEY}`. An Authorization header
defaults to Bearer; other headers default to no scheme. Explicit empty scheme is
allowed. OAuth is disabled. Disabled MCP entries are omitted and their credentials
are stripped even if explicitly included in extras. Enabled control names survive
acpx -> OpenCode; unrelated Coder/Git credentials are not automatically forwarded.

Endpoints/keys remain **`{env:NAME}` references** in generated config; resolved
values are never put in Terraform, installer settings, argv or module errors.
Header names/schemes are literal nonsecret settings; enable flags select entries.
Validation rejects control/non-ASCII characters, JSON interpolation delimiters,
URL credentials/query/fragment/invalid ports. LLM requires HTTPS except loopback HTTP;
MCP allows HTTP(S), so supply HTTPS when transport confidentiality is needed.
Errors identify missing/invalid **variable names only**.

Content-addressed configs are written atomically at mode 0600 under
`runtime/module-profiles`, outside automatic config discovery. A safe parent lock
covers first directory and marker creation; simultaneous first launches cannot
mistake an in-progress directory for foreign state. Existing unmarked/foreign state
is still refused. Install/help/version require no keys. `--module-profile-info`
reports names and selection without reading credentials or contacting services.

**Precedence:** nonempty `OPENCODE_MODULE_CONFIG` selects an explicit user JSON file
over the bundled profile. No automatic profile credentials are passed in that case;
use `runtime_env_allowlist` for the external config's required names. `none` without
an external file keeps the explicit model/readiness-env contract. acpx keeps
deny-all/noninteractive-deny defaults; there is no automatic permission escalation.
OpenCode's own project config merging still applies. Do not print resolved debug
config, verbose service logs or environment values as a credential check.

## Validation and publication boundary

The predecessor's published binaries and integration have separate prior live
evidence. That does **not** validate this refactored public interface: HOME setup,
dedicated-mount startup and integrated PATH setup have **offline fixture validation
only**, not new live acceptance or registry publication.

Run self-contained fixtures: `python3 -B -m unittest discover -s opencode/tests -v`.
They use synthetic archives/keys and mocked downloads, never real tools or services.
For actual Terraform validation/rendering use `tests/validate_terraform.py --terraform
<binary> --provider-dir <cached-provider-mirror> --scratch <new-directory>`. This
requires Terraform 1.7+ for mock-provider tests; no apply or cluster is used.

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
