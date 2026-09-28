-- The two statements docs/query-plans.md measures, exactly as
-- src/repositories/pipeline.repository.ts emits them, with the bind parameters written
-- out. Run against a database holding the §8 scale dataset:
--
--   npm run db:seed:scale
--   psql "$DATABASE_URL" -f docs/query-plans.sql
--   npm run db:seed:scale -- --clean
--
-- To capture the "without index" half, drop and recreate it around the run:
--
--   DROP INDEX "Application_roleId_currentStage_currentStageEnteredAt_idx";
--   ANALYZE "Application";
--   -- ... run this file ...
--   CREATE INDEX "Application_roleId_currentStage_currentStageEnteredAt_idx"
--     ON "Application"("roleId", "currentStage", "currentStageEnteredAt");
--   ANALYZE "Application";

\set ON_ERROR_STOP on
\pset pager off

-- The busiest open req, chosen from the data rather than pasted in, so the file works
-- against any dataset. The generator is deterministic, so this picks the same row every
-- time for a given --roles/--candidates pair.
SELECT r."id" AS busiest
FROM "Role" r
JOIN "Application" a ON a."roleId" = r."id"
WHERE r."status" = 'OPEN'
GROUP BY r."id"
ORDER BY count(*) DESC, r."id"
LIMIT 1
\gset

\echo ''
\echo '=== Q1 — GET /pipeline (every OPEN req) ==='

EXPLAIN (ANALYZE, BUFFERS)
SELECT r."id"    AS "roleId",
       r."title" AS "title",
       a."currentStage" AS "stage",
       count(a."roleId")::int AS "candidates",
       (avg(EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - a."currentStageEnteredAt"))) / 86400)::double precision AS "averageAgeDays",
       (max(EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - a."currentStageEnteredAt"))) / 86400)::double precision AS "oldestAgeDays"
FROM "Role" r
LEFT JOIN "Application" a ON a."roleId" = r."id"
WHERE r."status" = 'OPEN'::"RoleStatus"
GROUP BY r."id", r."title", a."currentStage"
ORDER BY r."title", a."currentStage";

\echo ''
\echo '=== Q2 — GET /pipeline?roleId=… (one req) ==='

EXPLAIN (ANALYZE, BUFFERS)
SELECT r."id"    AS "roleId",
       r."title" AS "title",
       a."currentStage" AS "stage",
       count(a."roleId")::int AS "candidates",
       (avg(EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - a."currentStageEnteredAt"))) / 86400)::double precision AS "averageAgeDays",
       (max(EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - a."currentStageEnteredAt"))) / 86400)::double precision AS "oldestAgeDays"
FROM "Role" r
LEFT JOIN "Application" a ON a."roleId" = r."id"
WHERE r."status" = 'OPEN'::"RoleStatus" AND r."id" = :'busiest'
GROUP BY r."id", r."title", a."currentStage"
ORDER BY r."title", a."currentStage";

\echo ''
\echo '=== Q3 — GET /pipeline/stuck?days=N (rows, not an aggregate) ==='
\echo '--- loose threshold: most of the table matches, the index is ignored'

EXPLAIN (ANALYZE, BUFFERS)
SELECT "Application"."id", "Application"."currentStage"::text, "Application"."currentStageEnteredAt",
       "Application"."candidateId", "Application"."roleId"
FROM "Application"
LEFT JOIN "Role" AS "j0" ON "j0"."id" = "Application"."roleId"
WHERE "Application"."currentStage" IN ('APPLIED','SCREEN','INTERVIEW','OFFER')
  AND "Application"."currentStageEnteredAt" < (now() AT TIME ZONE 'UTC') - interval '30 days'
  AND "j0"."status" = 'OPEN' AND "j0"."id" IS NOT NULL
ORDER BY "Application"."currentStageEnteredAt" ASC
LIMIT 100 OFFSET 0;

\echo '--- selective threshold: few rows match, the index is used'

EXPLAIN (ANALYZE, BUFFERS)
SELECT "Application"."id", "Application"."currentStage"::text, "Application"."currentStageEnteredAt",
       "Application"."candidateId", "Application"."roleId"
FROM "Application"
LEFT JOIN "Role" AS "j0" ON "j0"."id" = "Application"."roleId"
WHERE "Application"."currentStage" IN ('APPLIED','SCREEN','INTERVIEW','OFFER')
  AND "Application"."currentStageEnteredAt" < (now() AT TIME ZONE 'UTC') - interval '110 days'
  AND "j0"."status" = 'OPEN' AND "j0"."id" IS NOT NULL
ORDER BY "Application"."currentStageEnteredAt" ASC
LIMIT 100 OFFSET 0;
