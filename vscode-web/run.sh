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
  echo "👷 Running $VSCODE_CLI serve-web $EXTENSION_ARG $SERVER_BASE_PATH_ARG --port ${PORT} --host 127.0.0.1 --accept-server-license-terms --without-connection-token in the background..."
  echo "Check logs at ${LOG_PATH}!"

  "$VSCODE_CLI" serve-web $EXTENSION_ARG $SERVER_BASE_PATH_ARG --port "${PORT}" --host 127.0.0.1 --accept-server-license-terms --without-connection-token > "${LOG_PATH}" 2>&1 &
}

# Check if the settings file exists...
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
case "$ARCH" in
  x86_64) ARCH="x64" ;;
  aarch64) ARCH="arm64" ;;
  *)
    echo "Unsupported architecture"
    exit 1
    ;;
esac

# Check if a specific VS Code Web commit ID was provided
if [ -n "${COMMIT_ID}" ]; then
  HASH="${COMMIT_ID}"
else
  HASH=$(curl -fsSL https://update.code.visualstudio.com/api/commits/stable/server-linux-$ARCH-web | cut -d '"' -f 2)
fi
printf "$${BOLD}VS Code Web commit id version $HASH.\n"

# Download outer CLI (the small `code` binary)
output=$(curl -fsSL "https://vscode.download.prss.microsoft.com/dbazure/download/stable/$HASH/vscode_cli_alpine_"$ARCH"_cli.tar.gz" | tar -xz -C "${INSTALL_PREFIX}")
if [ $? -ne 0 ]; then
  echo "Failed to install Microsoft Visual Studio Code Server: $output"
  exit 1
fi
printf "$${BOLD}VS Code Web CLI has been installed.\n"

VSCODE_WEB=~/.vscode/cli/serve-web/$HASH/bin/code-server

# ---------------------------------------------------------------------------
# Pre-download the inner vscode-server-web for the SAME commit, so that
# `code serve-web` does NOT silently fetch a different (latest) version
# from update.code.visualstudio.com.
#
# Background: when COMMIT_ID is pinned, only the outer `code` CLI honors it.
# `code serve-web` independently calls the update API at runtime and would
# download whatever stable is current — e.g. 1.119.0, which has a hyper
# 0.14 -> 1.x migration bug that breaks WebSocket upgrades and leaves the
# workbench stuck at "Time limit reached".
# Refs: microsoft/vscode#315003, microsoft/vscode#315448
# ---------------------------------------------------------------------------
if [ -n "${COMMIT_ID}" ]; then
  SERVER_DIR=~/.vscode/cli/serve-web/$HASH

  # Clean up any wrong-hash directories that an earlier (broken) run cached.
  if [ -d ~/.vscode/cli/serve-web ]; then
    for d in ~/.vscode/cli/serve-web/*/; do
      [ -d "$d" ] || continue
      name=$(basename "$d")
      if [ "$name" != "$HASH" ]; then
        echo "🧹 Removing stale serve-web cache: $name"
        rm -rf "$d"
      fi
    done
    rm -f ~/.vscode/cli/serve-web/lru.json
  fi

  if [ ! -f "$VSCODE_WEB" ]; then
    printf "$${BOLD}Pre-downloading vscode-server-linux-$ARCH-web for $HASH...\n"
    mkdir -p "$SERVER_DIR"
    SERVER_URL="https://update.code.visualstudio.com/commit:$HASH/server-linux-$ARCH-web/stable"
    if curl -fsSL "$SERVER_URL" | tar -xz -C "$SERVER_DIR" --strip-components=1; then
      # Touch the lru.json so the CLI accepts the cached copy as fresh.
      printf '{"entries":[{"name":"%s","lastUsed":%s}]}\n' "$HASH" "$(date +%s)000" \
        > ~/.vscode/cli/serve-web/lru.json
      printf "$${BOLD}✅ vscode-server-web pre-downloaded to $SERVER_DIR\n"
    else
      echo "⚠️  Failed to pre-download vscode-server-web; falling back to runtime download."
    fi
  else
    echo "🥳 vscode-server-web already present at $VSCODE_WEB"
  fi
fi

install_extension() {
  # code serve-web auto downloads code-server via the health-check trigger
  # (or it's already there from the pre-download above).
  echo "Waiting for code-server at $VSCODE_WEB..."

  # Bound the wait so a misconfigured pin doesn't loop forever.
  WAITED=0
  WAIT_LIMIT=300
  while true; do
    if [ -f "$VSCODE_WEB" ]; then
      echo "$VSCODE_WEB exists."
      break
    fi
    if [ "$WAITED" -ge "$WAIT_LIMIT" ]; then
      echo "❌ Timed out waiting for $VSCODE_WEB after ${WAIT_LIMIT}s."
      echo "   Tail of ${LOG_PATH}:"
      tail -n 50 "${LOG_PATH}" 2>/dev/null || true
      echo "   Contents of ~/.vscode/cli/serve-web:"
      ls -la ~/.vscode/cli/serve-web/ 2>/dev/null || true
      return 1
    fi
    echo "Wait for $VSCODE_WEB. (${WAITED}s / ${WAIT_LIMIT}s)"
    sleep 10
    WAITED=$((WAITED + 10))
  done

  # Install each extension from the EXTENSIONS list.
  IFS=',' read -r -a EXTENSIONLIST <<< "$${EXTENSIONS}"
  for extension in "$${EXTENSIONLIST[@]}"; do
    if [ -z "$extension" ]; then
      continue
    fi
    printf "🧩 Installing extension $${CODE}$extension$${RESET}...\n"
    output=$($VSCODE_WEB $EXTENSIONS_DIR --install-extension "$extension" --force)
    if [ $? -ne 0 ]; then
      echo "Failed to install extension: $extension: $output"
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

      if [ -f "$WORKSPACE_DIR/.vscode/extensions.json" ]; then
        printf "🧩 Installing extensions from %s/.vscode/extensions.json...\n" "$WORKSPACE_DIR"
        # Use sed to remove single-line comments before parsing with jq
        extensions=$(sed 's|//.*||g' "$WORKSPACE_DIR"/.vscode/extensions.json | jq -r '.recommendations[]')
        for extension in $extensions; do
          $VSCODE_WEB $EXTENSIONS_DIR --install-extension "$extension" --force
        done
      fi
    fi
  fi
}

run_vscode_web
install_extension
printf "✅ VSCode Web installed.\n"
