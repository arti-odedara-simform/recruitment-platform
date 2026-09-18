#!/bin/sh
# PLAN.md §10: migrate, optionally seed, then serve. `docker compose up` and nothing else.
set -e

echo "[entrypoint] applying migrations"
npx prisma migrate deploy

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
