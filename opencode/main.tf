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
  bundle_files = { for name in ["install.py", "runtime.py", "diagnostics.py", "safety.py", "profiles.py", "profile-env.json", "shell_path.py", "task.mjs", "task-read.mjs", "task-cli.mjs", "task-acp.mjs", "task-supervisor.mjs", "package.json", "package-lock.json"] :
    name => file("${path.module}/scripts/${name}")
  }
  # 原始文件用 NUL 分隔，避免 JSON 对源码的引号、换行和 HTML 字符再次转义。
  bundle = join("\u0000", concat([jsonencode(local.bundle_config)], flatten([
    for name, content in local.bundle_files : [name, content]
  ])))
  # Coder passes the script through exec arguments. Keep the embedded source
  # compressed so it fits Linux's per-argument limit before the installer runs.
  install_script = templatefile("${path.module}/scripts/install.sh.tftpl", { bundle = base64gzip(local.bundle) })
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
      condition     = length(split("\u0000", local.bundle)) == 1 + 2 * length(local.bundle_files)
      error_message = "OpenCode source bundle contains an invalid NUL delimiter."
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
