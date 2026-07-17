#!/usr/bin/env bash
# Provisions a throwaway Postgres database for the pilot integration tests:
# applies the pilot migration, creates an app-role login (member of netzero_app,
# the real runtime posture), then runs the marking integration test against it.
#
# Requires a local PostgreSQL with createdb/dropdb/psql on PATH. Usage:
#   scripts/pilot-test-db.sh
set -euo pipefail

DB="${PILOT_TEST_DB:-mnz_pilot_it}"
OWNER="$(whoami)"
APP_ROLE="netzero_app_it"

cd "$(dirname "$0")/.."

dropdb --if-exists "$DB"
createdb "$DB"

# Owner applies the migration (creates schemas, roles, tables, the ranking view
# owned by netzero_ranking).
PILOT_DATABASE_URL="postgres://${OWNER}@localhost:5432/${DB}" node scripts/apply-pilot-migrations.mjs

# A login role that is a member of netzero_app - what the deployed app uses.
psql -d "$DB" -v ON_ERROR_STOP=1 -q \
  -c "DROP ROLE IF EXISTS ${APP_ROLE};" \
  -c "CREATE ROLE ${APP_ROLE} LOGIN IN ROLE netzero_app;"

export TEST_PILOT_DATABASE_URL="postgres://${APP_ROLE}@localhost:5432/${DB}"
echo "Running pilot integration tests as ${APP_ROLE}..."
node --test tests/pilot-*.test.mjs

dropdb --if-exists "$DB"
echo "Pilot integration test database cleaned up."
