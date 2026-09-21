-- ============================================================================
-- PLAN.md §1, layer 3: the database refuses, not just the application.
--
-- Layers 1 and 2 — the two hard-coded field sets and the assignment check inside
-- the WHERE — are what ship in every environment. This file is the layer under
-- them: a second role that *cannot* read a candidate's contact details and
-- *cannot* see a candidate it is not assigned to, whatever the application asks
-- for. It is what makes the answer to walkthrough Q3 unarguable: here is the
-- error Postgres raises when the column is named.
--
-- Run it with a role that may CREATE ROLE:
--
--     npm run db:rls                       # via Prisma, any environment
--     psql "$DATABASE_URL" -f prisma/rls.sql
--
-- It is idempotent, and it is NOT a Prisma migration on purpose: `CREATE ROLE`
-- is a cluster-level privilege the application's own user does not have on a
-- typical development machine, and a migration that cannot run is worse than a
-- script that says so. `compose.yaml` runs it on boot, where the app user owns
-- the cluster.
--
-- Statements are separated by `--;;` so the same file can be fed to psql or
-- executed statement-by-statement by src/db-rls.ts. Do not remove the markers.
-- ============================================================================

-- The role itself. NOLOGIN: nothing connects as `app_interviewer`. The
-- application connects as its usual user and *becomes* this role for the
-- duration of one transaction, via SET LOCAL ROLE, which is why it needs no
-- password and no second connection pool.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_interviewer') THEN
    CREATE ROLE app_interviewer NOLOGIN;
  END IF;
END
$$;

--;;

-- Membership, so the application's user is allowed to SET ROLE to it.
DO $$
BEGIN
  EXECUTE format('GRANT app_interviewer TO %I', current_user);
END
$$;

--;;

GRANT USAGE ON SCHEMA public TO app_interviewer;

--;;

-- Start from nothing every time, so a column added to a table later is not
-- silently readable because an earlier run granted the whole table.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_interviewer;

--;;

-- **The column GRANT.** `email` and `phone` are not in this list, so they are
-- not merely filtered out — they are not grantable to this role at all.
-- Naming one in a SELECT raises:
--
--     ERROR: permission denied for table Candidate
--
-- which is the demo in PLAN.md §12 Q3.
GRANT SELECT ("id", "name", "createdAt") ON "Candidate" TO app_interviewer;

--;;

-- The tables an interviewer-scoped query joins through. None of them carries a
-- restricted column; they exist so the assignment check can be resolved.
GRANT SELECT ON "Application", "InterviewRound", "RoundAssignment", "Role", "Feedback"
  TO app_interviewer;

--;;

-- Peer feedback names its author. Everything else about a user — the password
-- hash above all — stays outside the grant.
GRANT SELECT ("id", "name", "role") ON "User" TO app_interviewer;

--;;

-- ----------------------------------------------------------------------------
-- Row-level security, keyed on the actor the application sets per transaction.
--
-- `current_setting('app.actor_id', true)` returns NULL when the setting is
-- absent — the `true` is "missing_ok" — and a NULL comparison makes the policy
-- false. So a transaction that switched role but forgot to say who it is sees
-- **nothing**, rather than everything. Fail-closed is the only acceptable
-- direction for this one.
--
-- Note that the table owner bypasses RLS: recruiter and hiring-manager reads,
-- which run as the application's own user, are entirely unaffected by the
-- policies below.
-- ----------------------------------------------------------------------------

ALTER TABLE "Candidate" ENABLE ROW LEVEL SECURITY;

--;;

DROP POLICY IF EXISTS candidate_assigned_only ON "Candidate";

--;;

CREATE POLICY candidate_assigned_only ON "Candidate"
  FOR SELECT TO app_interviewer
  USING (
    EXISTS (
      SELECT 1
      FROM "Application" a
      JOIN "InterviewRound" r ON r."applicationId" = a."id"
      JOIN "RoundAssignment" ra ON ra."roundId" = r."id"
      WHERE a."candidateId" = "Candidate"."id"
        AND ra."interviewerId" = current_setting('app.actor_id', true)
    )
  );

--;;

ALTER TABLE "RoundAssignment" ENABLE ROW LEVEL SECURITY;

--;;

DROP POLICY IF EXISTS assignment_own_only ON "RoundAssignment";

--;;

-- An interviewer sees the rows that grant *them* access and no others, so the
-- policy above cannot be satisfied by borrowing somebody else's assignment.
CREATE POLICY assignment_own_only ON "RoundAssignment"
  FOR SELECT TO app_interviewer
  USING ("interviewerId" = current_setting('app.actor_id', true));
