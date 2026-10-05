output "opencode_command" {
  description = "Shell-quoted absolute command; HOME mode expands the workspace shell's HOME at execution time."
  value       = "${local.command_root}/bin/opencode"
}

output "acpx_command" {
  description = "Shell-quoted absolute command; independent of profile loading or agent PATH."
  value       = "${local.command_root}/bin/acpx"
}

output "status_path" {
  description = "Absolute status path with explicit install_root; null for runtime HOME mode (HOME/.coder-opencode/status.json)."
  value       = var.install_root == "" ? null : "${var.install_root}/status.json"
}

output "script_id" {
  value = coder_script.opencode.id
}
