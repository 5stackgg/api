#!/bin/bash
# Runs the draft-region guard suites against a disposable database.
#
#   PGHOST=... PGPORT=... PGUSER=... PGDATABASE=... ./run.sh
#
# The target database must have the full schema loaded the same way the API
# boots it: migrations (in version order), then hasura/enums, hasura/functions,
# hasura/views, hasura/triggers. See ../leagues/README.md for setup details.
# Never point this at a production database — the suites insert and delete
# fixture data.
set -euo pipefail
cd "$(dirname "$0")"

SUITES=(01_no_region_guards)

for suite in "${SUITES[@]}"; do
  echo "==> cleanup"
  psql -q -f cleanup.sql >/dev/null
  echo "==> ${suite}"
  psql -v ON_ERROR_STOP=1 -f "${suite}.sql" 2>&1 | grep -E "PASSED|ERROR|ASSERT" || {
    echo "SUITE FAILED: ${suite}"
    exit 1
  }
done

echo "All draft-region suites passed."
