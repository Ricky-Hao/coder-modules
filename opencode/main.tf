data "coder_workspace" "me" {}

locals {
  install_root = var.install_root
  release = var.release == null ? {
    tag    = "v2.2.0-ricky.1"
    asset  = "opencode-linux-x64-baseline-v2.2.0-ricky.1.tar.gz"
    sha256 = "09ed8c564754413a7296c12ce147c4b60d98456dc3815db71b399e093ad7ddcd"
  } : var.release
  bundle_config = {
    install_root    = local.install_root
    workspace_id    = data.coder_workspace.me.id
    release_tag     = local.release.tag
    release_asset   = local.release.asset
    release_sha256  = local.release.sha256
    runtime_profile = var.runtime_profile
  }
  bundle_files = { for name in ["install.py", "runtime.py", "diagnostics.py", "safety.py", "profiles.py", "profile-env.json", "shell_path.py", "task.mjs", "task-read.mjs", "task-launch.mjs", "task-cli.mjs", "task-acp.mjs", "task-supervisor.mjs", "package.json", "package-lock.json"] :
    name => file("${path.module}/scripts/${name}")
  }
  # 生成包只包含原始源码；动态设置单独传入，不要求安装者生成文件。
  bundle = join("\u0000", flatten([
    for name, content in local.bundle_files : [name, content]
  ]))
  source_bundle = jsondecode(file("${path.module}/scripts/source.json"))
  install_script = templatefile("${path.module}/scripts/install.sh.tftpl", {
    bundle = local.source_bundle.data
    sha256 = sha256(local.bundle)
    config = base64encode(jsonencode(local.bundle_config))
  })
  # HOME is deliberately expanded by the workspace shell, never by Terraform.
  command_root = var.install_root == "" ? "\"$HOME\"/.coder-opencode" : "'${replace(var.install_root, "'", "'\"'\"'")}'"
  # Pure input/file expression: safe for init-container use without depending on
  # coder_agent, coder_workspace data, or coder_script attributes.
  volume_prepare_script = var.dedicated_volume == null ? null : join("\n", [
    file("${path.module}/scripts/prepare_volume.py"),
    "import base64",
    "sys.exit(main(json.loads(base64.b64decode('${base64encode(jsonencode({
      mount_path   = var.dedicated_volume.mount_path
      install_root = var.install_root
      workspace_id = var.dedicated_volume.workspace_id
    }))}'))))",
  ])
}

resource "coder_script" "opencode" {
  agent_id           = var.agent_id
  display_name       = "OpenCode and acpx"
  script             = local.install_script
  run_on_start       = true
  start_blocks_login = var.start_blocks_login
  timeout            = var.install_timeout
  lifecycle {
    precondition {
      condition     = length(split("\u0000", local.bundle)) == 2 * length(local.bundle_files)
      error_message = "OpenCode source bundle contains an invalid NUL delimiter."
    }
    precondition {
      condition     = local.source_bundle.sha256 == sha256(local.bundle)
      error_message = "OpenCode source bundle is stale; maintainers must run python3 -B opencode/build_bundle.py before committing."
    }
    precondition {
      # The rendered template is ASCII (including its base64 payload), so this
      # is also its byte size. Reserve half of Linux's 128-KiB argument ceiling.
      condition     = length(local.install_script) <= 65536
      error_message = "OpenCode startup script exceeds its 64-KiB execution budget; reduce the embedded payload before publishing."
    }
    precondition {
      condition     = var.dedicated_volume == null ? true : var.install_root == "/mnt/opencode/toolset"
      error_message = "Dedicated volume preparation requires install_root=/mnt/opencode/toolset."
    }
  }
}
