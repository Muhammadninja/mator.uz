#!/usr/bin/env bash
# Creates only mator_staging and its restricted owner role. Prompts for the password; never accepts it on argv.
set -euo pipefail
set +x
umask 077

if [[ ${1:-} == --help ]]; then
  echo 'Usage: MATOR_STAGING_CONFIRM=mator_staging scripts/staging/create-staging-db.sh --apply'
  exit 0
fi
if [[ $# -ne 1 || $1 != --apply || ${MATOR_STAGING_CONFIRM:-} != mator_staging ]]; then
  echo 'Refusing. Require --apply and MATOR_STAGING_CONFIRM=mator_staging.' >&2
  exit 2
fi
if [[ $(id -u) -ne 0 ]]; then echo 'Run from the approved root session.' >&2; exit 1; fi
for tool in runuser createuser createdb psql; do
  command -v "$tool" >/dev/null || { echo "$tool is required." >&2; exit 1; }
done

ROLE=mator_backend_staging
DATABASE=mator_staging
role_exists=$(runuser -u postgres -- psql -XAtqc \
  "SELECT 1 FROM pg_roles WHERE rolname='mator_backend_staging'" postgres)
db_exists=$(runuser -u postgres -- psql -XAtqc \
  "SELECT 1 FROM pg_database WHERE datname='mator_staging'" postgres)
if [[ -n "$role_exists" || -n "$db_exists" ]]; then
  echo 'Staging role/database already exists; no changes made. Inspect it manually.' >&2
  exit 1
fi

runuser -u postgres -- createuser --login --no-superuser --no-createdb \
  --no-createrole --no-inherit --pwprompt "$ROLE"
runuser -u postgres -- createdb --owner="$ROLE" "$DATABASE"
runuser -u postgres -- psql -Xv ON_ERROR_STOP=1 -d postgres \
  -c 'REVOKE CONNECT ON DATABASE mator_staging FROM PUBLIC' \
  -c 'GRANT CONNECT, TEMPORARY ON DATABASE mator_staging TO mator_backend_staging'
echo 'Created the restricted staging role and database. No production database was targeted.'
