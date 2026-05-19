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

# Locate node binary for the target user
NODE_BIN="$(sudo -u "$APP_USER" -i bash -c 'command -v node' || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node not found in PATH for user $APP_USER." >&2
  echo "If you use 宝塔 PM2, look under /www/server/nodejs/<version>/bin/node" >&2
  echo "and either symlink it or set NODE_BIN manually:" >&2
  echo "  NODE_BIN=/www/server/nodejs/v20.19.6/bin/node sudo bash deploy/install.sh" >&2
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
