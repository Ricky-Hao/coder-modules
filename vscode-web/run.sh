#!/usr/bin/env bash

BOLD='\033[0;1m'
RESET='\033[0m'
CODE='\033[0;36m'
EXTENSIONS=("${EXTENSIONS}")
VSCODE_CLI="${INSTALL_PREFIX}/code"

# Set extension directory
EXTENSION_ARG=""
if [ -n "${EXTENSIONS_DIR}" ]; then
  EXTENSION_ARG="--extensions-dir=${EXTENSIONS_DIR}"
fi

# Set server base path
SERVER_BASE_PATH_ARG=""
if [ -n "${SERVER_BASE_PATH}" ]; then
  SERVER_BASE_PATH_ARG="--server-base-path=${SERVER_BASE_PATH}"
fi

run_vscode_web() {
  echo "👷 Running $${VSCODE_CLI} serve-web $${EXTENSION_ARG} $${SERVER_BASE_PATH_ARG} --port ${PORT} --host 127.0.0.1 --accept-server-license-terms --without-connection-token in the background..."
  echo "Check logs at ${LOG_PATH}!"

  "$${VSCODE_CLI}" serve-web $${EXTENSION_ARG} $${SERVER_BASE_PATH_ARG} --port "${PORT}" --host 127.0.0.1 --accept-server-license-terms --without-connection-token > "${LOG_PATH}" 2>&1 &
}

# Create the machine settings file if missing.
if [ ! -f ~/.vscode-server/data/Machine/settings.json ]; then
  echo "⚙️ Creating settings file..."
  mkdir -p ~/.vscode-server/data/Machine
  echo "${SETTINGS}" > ~/.vscode-server/data/Machine/settings.json
fi

# Create install prefix
mkdir -p ${INSTALL_PREFIX}

printf "$${BOLD}Installing Microsoft Visual Studio Code Server!\n"

# Detect architecture
ARCH=$(uname -m)
case "$${ARCH}" in
  x86_64) ARCH="x64" ;;
  aarch64) ARCH="arm64" ;;
  *)
    echo "Unsupported architecture"
    exit 1
    ;;
esac

# Resolve commit id (pin if COMMIT_ID is provided, else latest stable).
if [ -n "${COMMIT_ID}" ]; then
  HASH="${COMMIT_ID}"
else
  HASH=$(curl -fsSL https://update.code.visualstudio.com/api/commits/stable/server-linux-$${ARCH}-web | cut -d '"' -f 2)
fi
printf "$${BOLD}VS Code Web commit id version $${HASH}.\n"

# Download outer CLI (the small `code` binary)
output=$(curl -fsSL "https://vscode.download.prss.microsoft.com/dbazure/download/stable/$${HASH}/vscode_cli_alpine_$${ARCH}_cli.tar.gz" | tar -xz -C "${INSTALL_PREFIX}")
if [ $? -ne 0 ]; then
  echo "Failed to install Microsoft Visual Studio Code Server: $${output}"
  exit 1
fi
printf "$${BOLD}VS Code Web CLI has been installed.\n"

install_extension() {
  # Step 1: wait for `code serve-web` to listen on its port. This is also what
  # triggers the lazy download of the inner code-server (the CLI only fetches
  # it on the first health-check hit), so this curl loop pulls double duty as
  # readiness probe AND download trigger.
  echo "⏳ Waiting for code serve-web to listen on 127.0.0.1:${PORT}..."
  WAITED=0
  WAIT_LIMIT=600
  until curl -fsS -o /dev/null -m 2 "http://127.0.0.1:${PORT}/"; do
    if [ "$${WAITED}" -ge "$${WAIT_LIMIT}" ]; then
      echo "❌ Timed out after $${WAIT_LIMIT}s waiting for code serve-web."
      echo "   Tail of ${LOG_PATH}:"
      tail -n 50 "${LOG_PATH}" 2>/dev/null || true
      return 1
    fi
    sleep 5
    WAITED=$((WAITED + 5))
  done
  echo "✅ code serve-web is responding."

  # Step 2: HTTP 200 only means the CLI returned the "downloading..."
  # placeholder page. The actual ~120MB inner server is still being extracted
  # in the background, and bin/code-server doesn't exist yet. Poll the
  # filesystem until it lands. Use `find` instead of a fixed glob so we don't
  # depend on a specific layout under ~/.vscode/cli/serve-web/<hash>/.
  echo "⏳ Waiting for code-server binary to be extracted..."
  VSCODE_WEB=""
  WAITED=0
  WAIT_LIMIT=600
  while [ -z "$${VSCODE_WEB}" ]; do
    VSCODE_WEB=$(find ~/.vscode/cli/serve-web -maxdepth 5 -type f -name code-server -executable 2>/dev/null | head -n 1)
    if [ -n "$${VSCODE_WEB}" ]; then
      break
    fi
    if [ "$${WAITED}" -ge "$${WAIT_LIMIT}" ]; then
      echo "⚠️  Timed out after $${WAIT_LIMIT}s waiting for code-server binary. Cache layout dump:"
      find ~/.vscode/cli/serve-web -maxdepth 5 2>/dev/null | head -n 40
      echo "Skipping extension install."
      return 0
    fi
    sleep 5
    WAITED=$((WAITED + 5))
  done
  echo "✅ Using $${VSCODE_WEB} for extension installs."

  # Step 3: install each extension from the EXTENSIONS list.
  IFS=',' read -r -a EXTENSIONLIST <<< "$${EXTENSIONS}"
  for extension in "$${EXTENSIONLIST[@]}"; do
    if [ -z "$${extension}" ]; then
      continue
    fi
    printf "🧩 Installing extension $${CODE}$${extension}$${RESET}...\n"
    output=$($${VSCODE_WEB} $${EXTENSIONS_DIR} --install-extension "$${extension}" --force)
    if [ $? -ne 0 ]; then
      echo "Failed to install extension: $${extension}: $${output}"
    fi
  done

  if [ "${AUTO_INSTALL_EXTENSIONS}" = true ]; then
    if ! command -v jq > /dev/null; then
      echo "jq is required to install extensions from a workspace file."
    else
      WORKSPACE_DIR="$HOME"
      if [ -n "${FOLDER}" ]; then
        WORKSPACE_DIR="${FOLDER}"
      fi

      if [ -f "$${WORKSPACE_DIR}/.vscode/extensions.json" ]; then
        printf "🧩 Installing extensions from %s/.vscode/extensions.json...\n" "$${WORKSPACE_DIR}"
        # Use sed to remove single-line comments before parsing with jq
        extensions=$(sed 's|//.*||g' "$${WORKSPACE_DIR}"/.vscode/extensions.json | jq -r '.recommendations[]')
        for extension in $${extensions}; do
          $${VSCODE_WEB} $${EXTENSIONS_DIR} --install-extension "$${extension}" --force
        done
      fi
    fi
  fi
}

run_vscode_web
install_extension
printf "✅ VSCode Web installed.\n"
