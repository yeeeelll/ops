#!/usr/bin/env bash
# Pull latest code, install deps if package.json changed, restart service.
# Run on the server, in the project directory, as the app owner (not root).
#
# Usage:
#   bash deploy/update.sh

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

BEFORE_LOCK="$(sha256sum package-lock.json 2>/dev/null | awk '{print $1}' || echo none)"

git fetch --prune
git reset --hard "@{u}"

AFTER_LOCK="$(sha256sum package-lock.json 2>/dev/null | awk '{print $1}' || echo none)"
if [[ "$BEFORE_LOCK" != "$AFTER_LOCK" ]]; then
  echo "package-lock.json changed, reinstalling..."
  npm ci
fi

sudo systemctl restart ai-agent-bot.service
sudo systemctl --no-pager status ai-agent-bot.service | head -20
echo ""
echo "Tail logs: journalctl -u ai-agent-bot.service -f"
