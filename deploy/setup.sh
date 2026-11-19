#!/usr/bin/env bash
# Installs or updates the win probability tracker on an Ubuntu/Debian droplet.
# Run from the unpacked folder:  sudo bash sleeper-winprob/deploy/setup.sh
# Safe to re-run for updates: the database already on the server is kept.
set -euo pipefail

APP_DIR=/opt/sleeper-winprob
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run with sudo: sudo bash $0" >&2
  exit 1
fi

# Node 24 (needs 23.4+ for the built-in SQLite module).
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if ! command -v node >/dev/null || [ "$(node_major)" -lt 24 ]; then
  echo "==> Installing Node.js 24"
  apt-get update -y
  apt-get install -y ca-certificates curl
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
echo "==> Node $(node --version)"

if ! id winprob >/dev/null 2>&1; then
  echo "==> Creating system user 'winprob'"
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin winprob
fi

echo "==> Copying app to $APP_DIR"
mkdir -p "$APP_DIR/data"
(cd "$SRC_DIR" && tar --exclude=./data -cf - .) | (cd "$APP_DIR" && tar -xf -)
if [ ! -f "$APP_DIR/data/winprob.db" ] && [ -f "$SRC_DIR/data/winprob.db" ]; then
  echo "==> First install: bringing over the history recorded on your PC"
  cp "$SRC_DIR/data/winprob.db" "$APP_DIR/data/winprob.db"
else
  echo "==> Keeping the database already on the server"
fi
chown -R winprob:winprob "$APP_DIR"
if [ ! -f "$APP_DIR/config.local.json" ]; then
  echo "!! No $APP_DIR/config.local.json: create it with {\"leagueId\": \"<your league id>\"}"
  echo "   (see config.local.example.json), then: sudo systemctl restart winprob-collector winprob-web"
fi

echo "==> Installing services"
cp "$APP_DIR/deploy/winprob-collector.service" "$APP_DIR/deploy/winprob-web.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable winprob-collector winprob-web >/dev/null
systemctl restart winprob-collector winprob-web

if [ -d /etc/nginx ]; then
  mkdir -p /etc/nginx/snippets
  cp "$APP_DIR/deploy/nginx-winprob.conf" /etc/nginx/snippets/winprob.conf
  echo "==> nginx snippet installed at /etc/nginx/snippets/winprob.conf"
  if ! grep -rqs "snippets/winprob.conf" /etc/nginx/sites-enabled /etc/nginx/conf.d; then
    echo "    Next: add 'include snippets/winprob.conf;' inside your site's server { } block,"
    echo "    then run: sudo nginx -t && sudo systemctl reload nginx"
  else
    nginx -t && systemctl reload nginx && echo "==> nginx reloaded"
  fi
else
  echo "!! nginx isn't installed on this droplet; see DEPLOY.md."
fi

sleep 2
echo
systemctl --no-pager --lines=0 status winprob-collector winprob-web | grep -E "●|Active:" || true
echo
echo "Check it locally on the droplet:  curl -s http://127.0.0.1:3017/api/weeks"
echo "Collector log:                    journalctl -u winprob-collector -f"
