terraform {
  required_version = ">= 1.6.0"
  required_providers {
    coder = {
      source  = "coder/coder"
      version = ">= 2.15.0, < 3.0.0"
    }
  }
}
