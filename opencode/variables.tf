variable "agent_id" {
  description = "The ID of the existing Coder agent. Installation runs as its workspace user."
  type        = string
}

variable "install_root" {
  description = "Empty uses runtime HOME/.coder-opencode. Otherwise an absolute private child of an existing writable persistent mount."
  type        = string
  default     = ""
  validation {
    condition = var.install_root == "" || (
      startswith(var.install_root, "/") && var.install_root != "/" &&
      !endswith(var.install_root, "/") && !can(regex("[\n\r:]|//|(^|/)\\.\\.?(/|$)", var.install_root))
    )
    error_message = "Use an empty string or canonical absolute child path without traversal, colons or newlines."
  }
}

variable "dedicated_volume" {
  description = "Opt-in root init script for the exclusive /mnt/opencode mount. Null disables preparation. Supply the workspace identity; invoke volume_prepare_script before any workspace process."
  type = object({
    mount_path   = string
    workspace_id = string
  })
  default = null
  validation {
    condition = var.dedicated_volume == null ? true : (
      var.dedicated_volume.mount_path == "/mnt/opencode" &&
      can(regex("^[A-Za-z0-9_-]{1,128}$", var.dedicated_volume.workspace_id))
    )
    error_message = "Preparation is restricted to /mnt/opencode and an explicit stable workspace identity."
  }
}

variable "release" {
  description = "Optional complete reviewed release override. Null uses the pinned public release; all three fields must be changed together."
  type = object({
    tag    = string
    asset  = string
    sha256 = string
  })
  default = null
  validation {
    condition = var.release == null ? true : (
      can(regex("^v[0-9]+\\.[0-9]+\\.[0-9]+-ricky\\.[1-9][0-9]*$", var.release.tag)) &&
      var.release.asset == "opencode-linux-x64-baseline-${var.release.tag}.tar.gz" &&
      can(regex("^[0-9a-f]{64}$", var.release.sha256))
    )
    error_message = "Provide the complete fixed tag, matching Linux x64 baseline asset and reviewed lowercase SHA256."
  }
}

variable "runtime_profile" {
  description = "env enables the bundled env-only provider/MCP configuration; none opts out. Explicit OPENCODE_MODULE_CONFIG overrides either choice."
  type        = string
  default     = "env"
  validation {
    condition     = contains(["env", "none"], var.runtime_profile)
    error_message = "runtime_profile must be env or none."
  }
}

variable "runtime_env_allowlist" {
  description = "Additional child environment variable NAMES, never values. Disabled MCP credentials remain filtered in env profile mode."
  type        = set(string)
  default     = []
  validation {
    condition     = alltrue([for key in var.runtime_env_allowlist : can(regex("^[A-Za-z_][A-Za-z0-9_]*$", key))])
    error_message = "Only environment variable names are accepted."
  }
}

variable "start_blocks_login" {
  description = "Wait for installation and Bash profile integration. Agent readiness alone does not prove tool readiness."
  type        = bool
  default     = true
}

variable "install_timeout" {
  description = "Startup script timeout in seconds."
  type        = number
  default     = 1200
  validation {
    condition     = var.install_timeout >= 60 && floor(var.install_timeout) == var.install_timeout
    error_message = "install_timeout must be an integer of at least 60 seconds."
  }
}
