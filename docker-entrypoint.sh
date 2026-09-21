#!/bin/sh
# PLAN.md §10: migrate, optionally seed, then serve. `docker compose up` and nothing else.
set -e

echo "[entrypoint] applying migrations"
npx prisma migrate deploy

# PLAN.md §1 layer 3. In this stack the app user owns the cluster, so CREATE ROLE
# succeeds and interviewer reads run as a role that cannot read the restricted columns.
# A failure here is reported, not fatal: layers 1 and 2 are unconditional, and the API is
# correct without this one.
if [ -f dist/db-rls.js ]; then
  echo "[entrypoint] installing row-level security"
  node dist/db-rls.js || echo "[entrypoint] layer 3 not installed — see above; layers 1 and 2 are unaffected"
fi

if [ "$SEED" = "true" ]; then
  if [ -f dist/seed.js ]; then
    echo "[entrypoint] seeding"
    node dist/seed.js
  else
    echo "[entrypoint] SEED=true but dist/seed.js does not exist yet — skipping"
  fi
fi

echo "[entrypoint] starting api"
exec node dist/server.js
