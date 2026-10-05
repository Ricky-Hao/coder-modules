data "coder_workspace" "me" {}

locals {
  install_root = var.install_root
  release = var.release == null ? {
    tag    = "v2.0.19-ricky.1"
    asset  = "opencode-linux-x64-baseline-v2.0.19-ricky.1.tar.gz"
    sha256 = "3494e42923ec3279bacc227e7274d6c580c76e7b28d3a6ea85042edb79feae0a"
  } : var.release
  bundle = base64encode(jsonencode({
    config = {
      install_root          = local.install_root
      workspace_id          = data.coder_workspace.me.id
      release_tag           = local.release.tag
      release_asset         = local.release.asset
      release_sha256        = local.release.sha256
      runtime_profile       = var.runtime_profile
      runtime_env_allowlist = sort(tolist(var.runtime_env_allowlist))
    }
    files = { for name in ["install.py", "runtime.py", "safety.py", "profiles.py", "profile-env.json", "shell_path.py", "package.json", "package-lock.json"] :
      name => file("${path.module}/scripts/${name}")
    }
  }))
  install_script = templatefile("${path.module}/scripts/install.sh.tftpl", { bundle = local.bundle })
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
      condition     = var.dedicated_volume == null ? true : var.install_root == "/mnt/opencode/toolset"
      error_message = "Dedicated volume preparation requires install_root=/mnt/opencode/toolset."
    }
  }
}
