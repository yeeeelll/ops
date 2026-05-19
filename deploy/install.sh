#!/usr/bin/env bash
# Idempotent installer for the AI Ops Agent.
# Run on the target Linux server as root (or with sudo).
#
# Usage:
#   sudo bash deploy/install.sh
#
# Reads ./deploy/ai-agent-bot.service template, renders it, installs to
# /etc/systemd/system/, reloads systemd and starts the service.

set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
APP_USER="${APP_USER:-$(stat -c '%U' "$APP_DIR")}"
SERVICE_NAME="ai-agent-bot.service"
TEMPLATE="$APP_DIR/deploy/$SERVICE_NAME"
TARGET="/etc/systemd/system/$SERVICE_NAME"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/install.sh" >&2
  exit 1
fi

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "Missing $APP_DIR/.env. Copy .env.example to .env and fill credentials first." >&2
  exit 1
fi

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
  echo "Or create a symlink:" >&2
  echo "  sudo ln -sf /root/.nvm/versions/node/v20.20.2/bin/node /usr/local/bin/node" >&2
  exit 1
fi
NODE_BIN_DIR="$(dirname "$NODE_BIN")"

echo "Detected:"
echo "  APP_DIR      = $APP_DIR"
echo "  APP_USER     = $APP_USER"
echo "  NODE_BIN     = $NODE_BIN"
echo "  NODE_BIN_DIR = $NODE_BIN_DIR"

# Ensure dependencies are installed
if [[ ! -d "$APP_DIR/node_modules" ]]; then
  echo "Installing npm dependencies..."
  sudo -u "$APP_USER" bash -c "cd '$APP_DIR' && npm install --omit=dev=false"
fi

mkdir -p "$APP_DIR/data" "$APP_DIR/logs"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR/data" "$APP_DIR/logs"

# Render template
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
