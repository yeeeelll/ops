#!/usr/bin/env bash
# Idempotent installer for the AI Ops Agent.
# Run on the target Linux server as root (or with sudo).
#
# Usage:
#   sudo bash deploy/install.sh                    # uses owner of project dir (default)
#   sudo APP_USER=aiops bash deploy/install.sh     # creates+uses dedicated user
#
# Reads ./deploy/ai-agent-bot.service template, renders it, installs to
# /etc/systemd/system/, reloads systemd and starts the service. When
# APP_USER differs from the project owner, creates the user if missing,
# fixes ownership, and renders /etc/sudoers.d/ai-agent so that user can
# run a restricted whitelist of root commands without password.

set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
APP_USER="${APP_USER:-$(stat -c '%U' "$APP_DIR")}"
SERVICE_NAME="ai-agent-bot.service"
TEMPLATE="$APP_DIR/deploy/$SERVICE_NAME"
TARGET="/etc/systemd/system/$SERVICE_NAME"
SUDOERS_TEMPLATE="$APP_DIR/deploy/ai-agent.sudoers"
SUDOERS_TARGET="/etc/sudoers.d/ai-agent"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/install.sh" >&2
  exit 1
fi

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "Missing $APP_DIR/.env. Copy .env.example to .env and fill credentials first." >&2
  exit 1
fi

ensure_user() {
  local user="$1"
  if id -u "$user" >/dev/null 2>&1; then
    return 0
  fi
  echo "Creating system user '$user'..."
  useradd -r -m -s /bin/bash "$user"
}

fix_ownership() {
  local user="$1" dir="$2"
  chown -R "$user":"$user" "$dir/data" "$dir/logs"
  chown -R "$user":"$user" "$dir"
  chmod 600 "$dir/.env"
}

# Build sudoers Cmnd_Alias body from APPROVED_SERVICES env (in .env).
build_services_cmnd() {
  local env_file="$1"
  local list
  list="$(grep -E '^APPROVED_SERVICES=' "$env_file" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  if [[ -z "$list" ]]; then
    echo "/bin/false"
    return
  fi
  local first=1 out=""
  IFS=',' read -ra parts <<< "$list"
  for raw in "${parts[@]}"; do
    local unit="${raw// /}"
    [[ -z "$unit" ]] && continue
    # Expand prefix wildcard `nginx*` to all matching commands by leaving "<unit>*"
    # sudoers supports glob in command argument.
    local glob="$unit"
    if [[ "$glob" != *"*" && "$glob" != *.service ]]; then
      glob="${glob}*"
    fi
    for action in restart reload start stop; do
      if [[ $first -eq 1 ]]; then
        first=0
        out="/bin/systemctl $action $glob"
      else
        out="$out, \\
                            /bin/systemctl $action $glob"
      fi
    done
  done
  if [[ -z "$out" ]]; then echo "/bin/false"; return; fi
  echo "$out"
}

install_sudoers() {
  local user="$1"
  if [[ "$user" == "root" ]]; then
    rm -f "$SUDOERS_TARGET"
    return
  fi
  local services_cmnd
  services_cmnd="$(build_services_cmnd "$APP_DIR/.env")"
  local tmp
  tmp="$(mktemp)"
  awk -v user="$user" -v services="$services_cmnd" '
    {
      gsub("__USER__", user);
      gsub("__SERVICES__", services);
      print;
    }
  ' "$SUDOERS_TEMPLATE" > "$tmp"

  # Validate before installing
  if ! visudo -cf "$tmp" >/dev/null; then
    echo "sudoers fragment failed visudo validation:" >&2
    cat "$tmp" >&2
    rm -f "$tmp"
    exit 1
  fi
  install -m 0440 -o root -g root "$tmp" "$SUDOERS_TARGET"
  rm -f "$tmp"
  echo "Installed sudoers: $SUDOERS_TARGET"
}

ensure_user "$APP_USER"

# Locate node binary. Priority:
#   1) NODE_BIN env var (sudo -E or explicit assignment)
#   2) user's login shell PATH (covers nvm if .bashrc sources nvm.sh)
#   3) common nvm / 宝塔 paths
NODE_BIN="${NODE_BIN:-}"

if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(sudo -u "$APP_USER" -i bash -lc 'command -v node' 2>/dev/null || true)"
fi

if [[ -z "$NODE_BIN" ]]; then
  for candidate in \
    "/root/.nvm/versions/node"/*/bin/node \
    "/home/$APP_USER/.nvm/versions/node"/*/bin/node \
    /www/server/nodejs/*/bin/node \
    /usr/local/bin/node \
    /usr/bin/node
  do
    if [[ -x "$candidate" ]]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "node binary not found." >&2
  echo "Pass NODE_BIN explicitly, e.g.:" >&2
  echo "  sudo NODE_BIN=/root/.nvm/versions/node/v20.20.2/bin/node bash deploy/install.sh" >&2
  exit 1
fi
NODE_BIN_DIR="$(dirname "$NODE_BIN")"

echo "Detected:"
echo "  APP_DIR      = $APP_DIR"
echo "  APP_USER     = $APP_USER"
echo "  NODE_BIN     = $NODE_BIN"
echo "  NODE_BIN_DIR = $NODE_BIN_DIR"

# Ensure dependencies are installed (as APP_USER so file ownership is right)
if [[ ! -d "$APP_DIR/node_modules" ]]; then
  echo "Installing npm dependencies as $APP_USER..."
  sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR' && npm install"
fi

mkdir -p "$APP_DIR/data" "$APP_DIR/logs"
fix_ownership "$APP_USER" "$APP_DIR"

install_sudoers "$APP_USER"

# Render systemd unit
sed -e "s|__USER__|$APP_USER|g" \
    -e "s|__APP_DIR__|$APP_DIR|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__NODE_BIN_DIR__|$NODE_BIN_DIR|g" \
    "$TEMPLATE" > "$TARGET"

chmod 644 "$TARGET"

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

sleep 2
systemctl --no-pager --full status "$SERVICE_NAME" || true

echo ""
echo "Installed. Useful commands:"
echo "  journalctl -u $SERVICE_NAME -f      # tail logs"
echo "  systemctl restart $SERVICE_NAME      # restart after code update"
echo "  systemctl stop    $SERVICE_NAME"
echo "  systemctl status  $SERVICE_NAME"
if [[ "$APP_USER" != "root" ]]; then
  echo ""
  echo "Service runs as user: $APP_USER"
  echo "Sudo whitelist installed at: $SUDOERS_TARGET"
fi
