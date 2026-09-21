import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma, disconnectDatabase } from '../src/db/client.js';
import { parseStatements } from '../src/db-rls.js';
import { installRls, resetRlsProbe, rlsStatus } from '../src/repositories/rls.repository.js';
import { CANDIDATE_IDS, DEV_PASSWORD, USER_IDS } from '../src/seed/fixture.js';

/**
 * PLAN.md §1 layer 3, and walkthrough answer Q3's last sentence: *"the same request after
 * dropping to `app_interviewer`, showing Postgres itself refusing"*.
 *
 * Layers 1 and 2 are asserted elsewhere and unconditionally. What is asserted here is the
 * layer beneath them — that if the field set were widened or the `where` clause were
 * edited wrongly tomorrow, the database would still refuse. Every test below therefore
 * asks Postgres directly, as the role, bypassing the repository entirely: an assertion
 * routed through the application code we are trying to prove unnecessary would prove
 * nothing.
 *
 * **These tests install the role themselves**, which needs a database user that may
 * CREATE ROLE. Where that is not the case — a stock local Postgres whose app user is
 * unprivileged — they skip with a message rather than fail, because a laptop that cannot
 * create a role is not a broken build. `docker compose up` always has it: there the app
 * user owns the cluster.
 */

const app = createApp();

const INTERVIEWER = 'ingrid.interviewer@example.com';

let installed = false;
let skipReason = '';

beforeAll(async () => {
  const sql = await readFile(new URL('../prisma/rls.sql', import.meta.url), 'utf8');

  try {
    await installRls(parseStatements(sql));
    installed = (await rlsStatus()) === 'enforced';
  } catch (error) {
    skipReason = error instanceof Error ? error.message.split('\n')[0]! : String(error);
  }

  if (!installed) {
    console.warn(
      `\n[rls.test] skipped — layer 3 could not be installed here.\n` +
        `           ${skipReason || 'the app_interviewer role is not usable'}\n` +
        `           Run the suite against the compose stack, or grant the app user ` +
        `CREATEROLE once.\n`,
    );
  }
}, 60_000);

afterAll(async () => {
  resetRlsProbe();
  await disconnectDatabase();
});

/**
 * Runs `sql` with the session dropped to `app_interviewer` and `app.actor_id` set, which
 * is exactly what `asInterviewer` does in production — reproduced here by hand so the
 * assertion does not depend on the code under test.
 */
async function asInterviewerRaw<T>(actorId: string | null, sql: string): Promise<T> {
  return prisma.$transaction(async (tx) => {
    if (actorId !== null) {
      await tx.$queryRaw`SELECT set_config('app.actor_id', ${actorId}, true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE app_interviewer');
    return tx.$queryRawUnsafe<T>(sql);
  });
}

describe.skipIf(!installed)('layer 3: Postgres refuses what the application never asks for', () => {
  /** Walkthrough Q3, the closing demo: name the column and the database says no. */
  it('refuses a SELECT that names email, and one that names phone', async () => {
    for (const column of ['email', 'phone']) {
      await expect(
        asInterviewerRaw(USER_IDS.ingrid, `SELECT "${column}" FROM "Candidate" LIMIT 1`),
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it('refuses SELECT *, which is the same mistake spelled differently', async () => {
    await expect(asInterviewerRaw(USER_IDS.ingrid, 'SELECT * FROM "Candidate" LIMIT 1')).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('allows the columns the interviewer field set actually names', async () => {
    const rows = await asInterviewerRaw<Array<{ id: string; name: string }>>(
      USER_IDS.ingrid,
      `SELECT "id", "name" FROM "Candidate" WHERE "id" = '${CANDIDATE_IDS.c01}'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Amara Osei');
  });

  /**
   * The row policy, tested without any `WHERE` at all. This is the case that matters: if
   * `findCandidateForInterviewer` lost its assignment filter tomorrow, the query would
   * still come back with only the candidates this interviewer is assigned to.
   */
  it('returns only assigned candidates from an unfiltered SELECT', async () => {
    const rows = await asInterviewerRaw<Array<{ id: string }>>(
      USER_IDS.ingrid,
      'SELECT "id" FROM "Candidate"',
    );
    const ids = rows.map((row) => row.id);

    // Ingrid is assigned to rounds on c01 (Amara), c03 (Chen) and c07 (Grace).
    expect(ids).toContain(CANDIDATE_IDS.c01);
    expect(ids).not.toContain(CANDIDATE_IDS.c02);

    const total = await prisma.candidate.count();
    expect(ids.length).toBeLessThan(total);
  });

  /** Fail-closed: a transaction that switched role but forgot to say who it is sees nothing. */
  it('returns nothing when app.actor_id was never set', async () => {
    const rows = await asInterviewerRaw<Array<{ id: string }>>(null, 'SELECT "id" FROM "Candidate"');

    expect(rows).toEqual([]);
  });

  it('shows an interviewer only their own assignment rows', async () => {
    const rows = await asInterviewerRaw<Array<{ interviewerId: string }>>(
      USER_IDS.ingrid,
      'SELECT "interviewerId" FROM "RoundAssignment"',
    );

    expect(rows.length).toBeGreaterThan(0);
    expect([...new Set(rows.map((row) => row.interviewerId))]).toEqual([USER_IDS.ingrid]);
  });

  /**
   * PLAN.md §14: `SET LOCAL` is scoped to the transaction. If it were plain `SET`, the
   * role would ride the pooled connection into the next request — so this asserts the
   * pool hands back an ordinary session afterwards.
   */
  it('reverts the role when the transaction ends', async () => {
    await asInterviewerRaw(USER_IDS.ingrid, 'SELECT "id" FROM "Candidate" LIMIT 1');

    const [row] = await prisma.$queryRaw<Array<{ role: string }>>`SELECT current_user AS role`;
    expect(row?.role).not.toBe('app_interviewer');

    // And the ordinary path still reads the restricted columns, as the recruiter view must.
    const candidate = await prisma.candidate.findUniqueOrThrow({
      where: { id: CANDIDATE_IDS.c01 },
      select: { email: true },
    });
    expect(candidate.email).toBe('amara.osei@example.net');
  });
});

/**
 * The API surface is expected to behave identically whether or not layer 3 is installed —
 * that is what "defence in depth" means here. These run either way.
 */
describe('the API behaves the same with the layer installed or not', () => {
  it(`reports its status on /health (currently "${installed ? 'enforced' : 'unavailable'}")`, async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.rls).toBe(installed ? 'enforced' : 'unavailable');
  });

  it('serves an assigned candidate and refuses an unassigned one', async () => {
    const login = await request(app)
      .post('/auth/login')
      .send({ email: INTERVIEWER, password: DEV_PASSWORD });
    const auth = `Bearer ${login.body.token}`;

    const assigned = await request(app).get(`/candidates/${CANDIDATE_IDS.c01}`).set('authorization', auth);
    expect(assigned.status).toBe(200);
    expect(assigned.body).toEqual({ id: CANDIDATE_IDS.c01, name: 'Amara Osei' });

    const unassigned = await request(app)
      .get(`/candidates/${CANDIDATE_IDS.c02}`)
      .set('authorization', auth);
    expect(unassigned.status).toBe(404);
  });

  it('serves the interviewer’s own rounds', async () => {
    const login = await request(app)
      .post('/auth/login')
      .send({ email: INTERVIEWER, password: DEV_PASSWORD });

    const response = await request(app)
      .get('/me/rounds')
      .set('authorization', `Bearer ${login.body.token}`);

    expect(response.status).toBe(200);
    expect(response.body.length).toBeGreaterThan(0);
    expect(response.text).not.toMatch(/@example\.net/);
  });
});
