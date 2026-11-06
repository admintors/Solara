#!/bin/sh
set -eu

APP_ENV="${APP_ENV:-production}"
DATA_DIR="${DATA_DIR:-/data}"
DB_PATH="${DB_PATH:-${DATA_DIR}/solara-multiuser.db}"
API_BASE_URL="${API_BASE_URL:-https://music-api.gdstudio.xyz/api.php}"
export APP_ENV NODE_ENV="${NODE_ENV:-$APP_ENV}" DATA_DIR DB_PATH API_BASE_URL

if [ "$APP_ENV" != "production" ] && [ "$APP_ENV" != "development" ]; then
  echo "APP_ENV must be production or development" >&2
  exit 1
fi
if [ -z "${PUBLIC_ORIGIN:-}" ]; then
  echo "PUBLIC_ORIGIN is required; set the public HTTPS origin in .env" >&2
  exit 1
fi

if ! mkdir -p "$DATA_DIR/backups" "$DATA_DIR/imports" 2>/dev/null || [ ! -w "$DATA_DIR" ]; then
  echo "DATA_DIR is not writable by uid $(id -u): $DATA_DIR" >&2
  echo "For a bind mount, prepare it on the host with: install -d -o 1000 -g 1000 ./data ./data/backups ./data/imports" >&2
  exit 1
fi

node -e '
  let origin, api;
  try { origin = new URL(process.env.PUBLIC_ORIGIN || ""); api = new URL(process.env.API_BASE_URL || ""); } catch { process.exit(1); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (origin.origin !== process.env.PUBLIC_ORIGIN ||
      (process.env.APP_ENV === "production" && origin.protocol !== "https:") ||
      (origin.protocol === "http:" && !local) ||
      api.protocol !== "https:" || api.username || api.password || /[\r\n"]/u.test(process.env.API_BASE_URL || "")) process.exit(1);
' || {
  echo "PUBLIC_ORIGIN or API_BASE_URL is invalid for APP_ENV" >&2
  exit 1
}
INTERNAL_PROXY_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
export INTERNAL_PROXY_TOKEN
umask 077
DEV_VARS="/app/server/internal-proxy/.dev.vars"
printf 'INTERNAL_PROXY_TOKEN="%s"\nAPI_BASE_URL="%s"\n' "$INTERNAL_PROXY_TOKEN" "$API_BASE_URL" > "$DEV_VARS"
chmod 0600 "$DEV_VARS"

cd /app/server/internal-proxy
./node_modules/.bin/wrangler pages dev ./public --ip 127.0.0.1 --port 8788 --log-level error >/dev/null 2>&1 &
PROXY_PID=$!
sleep 1
if ! kill -0 "$PROXY_PID" 2>/dev/null; then
  echo "Internal music proxy failed to start; readiness will remain unavailable" >&2
  exit 1
fi

exec node /app/server/index.js
