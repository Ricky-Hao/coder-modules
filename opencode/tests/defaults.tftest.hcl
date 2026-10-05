mock_provider "coder" {
  mock_data "coder_workspace" {
    defaults = {
      id = "11111111-1111-4111-8111-111111111111"
    }
  }
}

run "agent_only" {
  command = plan
  variables {
    agent_id = "22222222-2222-4222-8222-222222222222"
  }
  assert {
    condition     = coder_script.opencode.start_blocks_login && coder_script.opencode.run_on_start
    error_message = "Default startup must own blocking installation and PATH setup."
  }
  assert {
    condition     = jsondecode(base64decode(local.bundle)).config.install_root == ""
    error_message = "HOME must be resolved at runtime."
  }
  assert {
    condition     = jsondecode(base64decode(local.bundle)).config.workspace_id == data.coder_workspace.me.id
    error_message = "Workspace identity must be derived internally."
  }
  assert {
    condition     = var.runtime_profile == "env" && local.release.sha256 == "3494e42923ec3279bacc227e7274d6c580c76e7b28d3a6ea85042edb79feae0a"
    error_message = "Default profile and public release pin changed."
  }
  assert {
    condition     = output.opencode_command == "\"$HOME\"/.coder-opencode/bin/opencode"
    error_message = "Automation must not rely on agent PATH."
  }
}

run "dedicated_mount" {
  command = plan
  variables {
    agent_id        = "22222222-2222-4222-8222-222222222222"
    install_root    = "/mnt/opencode/toolset"
    runtime_profile = "none"
  }
  assert {
    condition     = output.acpx_command == "'/mnt/opencode/toolset'/bin/acpx"
    error_message = "Persistent automation command must be absolute."
  }
}

run "quoted_mount" {
  command = plan
  variables {
    agent_id     = "22222222-2222-4222-8222-222222222222"
    install_root = "/mnt/test ' $HOME $(false)/toolset"
  }
}

run "prepared_mount" {
  command = plan
  variables {
    agent_id     = "22222222-2222-4222-8222-222222222222"
    install_root = "/mnt/opencode/toolset"
    dedicated_volume = {
      mount_path   = "/mnt/opencode"
      workspace_id = "11111111-1111-4111-8111-111111111111"
    }
  }
  assert {
    condition     = startswith(output.volume_prepare_script, file("${path.module}/scripts/prepare_volume.py"))
    error_message = "Preparation must be the actual module-owned helper, known at plan time."
  }
}

run "invalid_preparation_scope" {
  command = plan
  variables {
    agent_id = "22222222-2222-4222-8222-222222222222"
    dedicated_volume = {
      mount_path   = "/mnt"
      workspace_id = "test-workspace"
    }
  }
  expect_failures = [var.dedicated_volume]
}

run "invalid_root" {
  command = plan
  variables {
    agent_id     = "22222222-2222-4222-8222-222222222222"
    install_root = "/mnt/../toolset"
  }
  expect_failures = [var.install_root]
}

run "invalid_release" {
  command = plan
  variables {
    agent_id = "22222222-2222-4222-8222-222222222222"
    release = {
      tag    = "v2.0.19-ricky.1"
      asset  = "mismatched.tar.gz"
      sha256 = "not-a-digest"
    }
  }
  expect_failures = [var.release]
}
