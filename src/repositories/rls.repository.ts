import type { Prisma } from '@prisma/client';
import { prisma } from '../db/client.js';
import { env } from '../config/env.js';
import type { Actor } from '../domain/actor.js';

/**
 * PLAN.md §1 layer 3, from the application's side: run an interviewer's reads as
 * `app_interviewer`, the role that prisma/rls.sql strips of `email` and `phone` and puts
 * behind a row policy.
 *
 * The whole mechanism is two statements at the top of a transaction —
 *
 *     SELECT set_config('app.actor_id', $1, true);
 *     SET LOCAL ROLE app_interviewer;
 *
 * — and the reason both say LOCAL is PLAN.md §14. Prisma hands out pooled connections; a
 * `SET ROLE` without `LOCAL` would outlive the request and the next caller to be handed
 * that connection would inherit somebody else's identity. `SET LOCAL` is scoped to the
 * transaction and Postgres reverts it on COMMIT, so the blast radius is the transaction
 * that set it. This is also why every call below goes through `$transaction`: there is no
 * safe way to do this outside one.
 */

export type RlsStatus =
  /** The role exists and this connection may become it. Interviewer reads run under it. */
  | 'enforced'
  /** Switched off by configuration. */
  | 'disabled'
  /** prisma/rls.sql has not been run here — layers 1 and 2 still hold on their own. */
  | 'unavailable';

/**
 * Probed once and cached for the process. The answer cannot change without a DDL
 * statement, and paying a round-trip per request to re-learn it would be silly.
 */
let probe: Promise<RlsStatus> | null = null;

export function rlsStatus(): Promise<RlsStatus> {
  probe ??= detect();
  return probe;
}

/** Test helper: forget the cached probe so a suite can install the role and re-probe. */
export function resetRlsProbe(): void {
  probe = null;
}

async function detect(): Promise<RlsStatus> {
  if (env.DB_RLS === 'off') {
    return 'disabled';
  }

  const [row] = await prisma.$queryRaw<Array<{ usable: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname = 'app_interviewer'
    ) AND pg_has_role(current_user, 'app_interviewer', 'MEMBER') AS usable
  `;

  return row?.usable ? 'enforced' : 'unavailable';
}

/**
 * Called once at startup. With `DB_RLS=require` a missing layer 3 is a boot failure
 * rather than a silent downgrade — which is what a deployment that has decided it wants
 * the database to enforce this should be able to insist on. The default, `auto`, uses it
 * where it is installed and says so on `GET /health` where it is not.
 */
export async function assertRlsReady(): Promise<RlsStatus> {
  const status = await rlsStatus();

  if (env.DB_RLS === 'require' && status !== 'enforced') {
    throw new Error(
      'DB_RLS=require, but the app_interviewer role is not usable on this database. ' +
        'Run `npm run db:rls` with a role that may CREATE ROLE.',
    );
  }

  return status;
}

/**
 * Runs `read` as the interviewer role when layer 3 is installed, and as the ordinary
 * application user when it is not.
 *
 * The fallback is deliberate and it is not a hole: layers 1 and 2 — the field set that
 * never names the restricted columns, and the assignment check inside the `where` — are
 * unconditional and are what the tests assert against. Layer 3 is defence in depth, and
 * a laptop whose Postgres role cannot be created should still run the API rather than
 * refuse to start. `DB_RLS=require` is there for the environments that disagree.
 */
export async function asInterviewer<T>(
  actor: Actor,
  read: (db: Prisma.TransactionClient | typeof prisma) => Promise<T>,
): Promise<T> {
  if ((await rlsStatus()) !== 'enforced') {
    return read(prisma);
  }

  return prisma.$transaction(async (tx) => {
    // Parameterised, because `SET LOCAL app.actor_id = $1` is not — `SET` does not take
    // bind parameters, and building that string by hand is how an actor id becomes an
    // injection point. `set_config(..., true)` is the transaction-local equivalent that
    // does take one.
    await tx.$queryRaw`SELECT set_config('app.actor_id', ${actor.id}, true)`;
    // No parameter here, and none possible: `SET LOCAL ROLE` takes an identifier. The
    // value is this module's own constant, never anything from a request.
    await tx.$executeRawUnsafe('SET LOCAL ROLE app_interviewer');

    return read(tx);
  });
}

/**
 * Installs prisma/rls.sql. Statement-by-statement because the file contains `DO $$ … $$`
 * blocks whose bodies are full of semicolons, so it cannot be split on `;` — the file
 * carries explicit `--;;` separators instead, and they are comments, so psql can still
 * read the same file end to end.
 */
export async function installRls(statements: readonly string[]): Promise<number> {
  let applied = 0;

  for (const statement of statements) {
    await prisma.$executeRawUnsafe(statement);
    applied += 1;
  }

  resetRlsProbe();
  return applied;
}
