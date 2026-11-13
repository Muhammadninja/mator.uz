#!/usr/bin/env bash
# Launch only with a clean environment so the PM2 daemon or shell cannot leak production secrets.
set -euo pipefail

APP_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PATH=/usr/bin:/usr/local/bin:/bin
NODE_BIN=$(PATH="$PATH" command -v node || true)
if [[ -z "$NODE_BIN" ]]; then echo 'Node.js is unavailable.' >&2; exit 1; fi
NODE_MAJOR=$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')
if (( NODE_MAJOR < 20 )); then echo 'Backend staging requires Node.js 20 or newer.' >&2; exit 1; fi
[[ -s "$APP_ROOT/dist/src/main.js" ]] || { echo 'Build dist/src/main.js before starting staging.' >&2; exit 1; }
[[ -f /etc/mator/backend-staging.env ]] || { echo 'Staging env file is missing.' >&2; exit 1; }
[[ $(stat -c '%a' /etc/mator/backend-staging.env) == 600 ]] || { echo 'Staging env file must have mode 600.' >&2; exit 1; }

exec /usr/bin/env -i \
  PATH="$PATH" \
  HOME=/home/mator-backend-staging \
  NODE_ENV=staging \
  PORT=3001 \
  BIND_HOST=127.0.0.1 \
  DOTENV_CONFIG_PATH=/etc/mator/backend-staging.env \
  NODE_OPTIONS=--require=dotenv/config \
  "$NODE_BIN" "$APP_ROOT/dist/src/main.js"
