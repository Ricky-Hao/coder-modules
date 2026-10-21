# Archived upstream workflows

These inherited workflows are intentionally outside GitHub's recognized
`.github/workflows` directory. They are reference files, not active CI, and no
replacement workflow is installed. Their bytes are preserved from commit
`51524055c61443b5768b62e0d0e059459f88caa7`, under their original
`.github/workflows/<filename>` paths; do not reformat the archived copies.

| File                   | Original triggers                             | Why archived in this fork                                                                                     |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `ci.yaml`              | Push to `main`, pull request, manual dispatch | Broad upstream Bun/Terraform tests, formatting and linting; not the custom OpenCode Python/callback fixtures. |
| `check.yaml`           | Every 15 minutes, manual dispatch             | Upstream registry health checks using Instatus/Vercel integration.                                            |
| `deploy-registry.yaml` | Push to `main`                                | Google Cloud deployment to upstream `dev.registry.coder.com`; not a fork delivery target.                     |

## Delivery and manual validation

Deliver the workflow removals and reviewed OpenCode changes together into `main`.
The resulting tree must contain no `.yml` or `.yaml` workflow files under
`.github/workflows`. Run the [fork-local manual checks](../../CONTRIBUTING.md#fork-local-validation)
before delivery; a source merge is not module publication or an installed-runtime update.

This is **source-level deactivation**, not a change to repository/organization
Actions permissions or workflow platform state. Until this tree reaches `main`,
the existing default-branch workflows remain in place. Old refs and already queued
or running jobs are not disabled or cancelled by this change.

## Deliberate restoration only

Restore only with explicit owner approval in a separate reviewed source change:

1. Select only the workflow that is actually needed; moving it back to
   `.github/workflows/<filename>` makes it discoverable again after delivery.
2. Review its triggers, permissions, dependencies, runners and fork-specific
   validation commands before restoration. Do not blindly restore all three.
3. Replace upstream deployment targets and identities before enabling any deploy
   workflow. Review any required secrets/permissions separately; do not assume
   upstream Instatus, Vercel or Google Cloud access is available or authorized.
4. Review the restored workflow and update this archive/index and the contributing
   guidance together. Never claim that source restoration changed platform settings.
