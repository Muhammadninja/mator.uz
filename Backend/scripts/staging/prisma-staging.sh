#!/usr/bin/env bash
# Status is read-only by default. Migrations and seed require two explicit staging confirmations.
set -euo pipefail
set +x
umask 077

ENV_FILE=/etc/mator/backend-staging.env
ACTION=${1:---status}
if [[ "$ACTION" == --help ]]; then
  echo 'Usage: scripts/staging/prisma-staging.sh [--status|--apply]'
  echo 'For --apply, also set MATOR_STAGING_CONFIRM=mator_staging.'
  exit 0
fi
if [[ "$ACTION" != --status && "$ACTION" != --apply ]]; then
  echo 'Use --status or --apply.' >&2; exit 2
fi
[[ -f "$ENV_FILE" ]] || { echo 'Dedicated staging env file is missing.' >&2; exit 1; }
[[ $(stat -c '%a' "$ENV_FILE") == 600 ]] || { echo 'Staging env file must have mode 600.' >&2; exit 1; }
[[ -x ./node_modules/.bin/prisma ]] || { echo 'Install backend dependencies first.' >&2; exit 1; }

STAGE_PATH=/usr/bin:/usr/local/bin:/bin
run_stage_cmd() {
  /usr/bin/env -i PATH="$STAGE_PATH" HOME=/home/mator-backend-staging \
    NODE_ENV=staging DOTENV_CONFIG_PATH="$ENV_FILE" NODE_OPTIONS=--require=dotenv/config "$@"
}
run_stage_cmd node scripts/staging/staging-target-guard.cjs
if [[ "$ACTION" == --status ]]; then
  exec /usr/bin/env -i PATH="$STAGE_PATH" HOME=/home/mator-backend-staging \
    NODE_ENV=staging DOTENV_CONFIG_PATH="$ENV_FILE" NODE_OPTIONS=--require=dotenv/config \
    ./node_modules/.bin/prisma migrate status --schema=prisma/schema.prisma
fi
if [[ ${MATOR_STAGING_CONFIRM:-} != mator_staging ]]; then
  echo 'Refusing writes without MATOR_STAGING_CONFIRM=mator_staging.' >&2; exit 2
fi
if [[ -n ${SEED_ADMIN_EMAIL:-} || -n ${SEED_ADMIN_PASSWORD:-} ]]; then
  echo 'Refusing seed while admin bootstrap credentials are set.' >&2; exit 1
fi
run_stage_cmd ./node_modules/.bin/prisma migrate deploy --schema=prisma/schema.prisma
run_stage_cmd npm run seed
