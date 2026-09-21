import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Stage } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma, disconnectDatabase } from '../src/db/client.js';
import { registeredOperations, type OperationSpec } from '../src/http/openapi/registry.js';
import { CANDIDATE_IDS, DEV_PASSWORD, ROUND_IDS } from '../src/seed/fixture.js';

/**
 * The two sweeps in PLAN.md §9 that are *about the whole API* rather than about one
 * endpoint:
 *
 * 1. **No anonymous path.** Every registered route, driven without a token, must 401.
 *    Table-driven from the OpenAPI registry rather than from a hand-kept list — a route
 *    added tomorrow is swept the moment it registers itself, which is the only version
 *    of this test that cannot rot.
 * 2. **No contact leak.** Every interviewer-reachable response, success and failure
 *    alike, scanned as raw text for a candidate's email or phone number.
 *
 * Both are deliberately blunt. The per-endpoint tests assert on parsed fields and
 * documented schemas; these scan bytes, so a contact detail smuggled into an error
 * message, a nested object or a field nobody documented is still caught.
 */

const app = createApp();

const RECRUITER = 'rachel.recruiter@example.com';
/** Assigned to r01 (Amara, c01) and r03 (Chen, c03) in the fixture — not to c02's rounds. */
const INTERVIEWER = 'ingrid.interviewer@example.com';

const NO_SUCH_UUID = '00000000-0000-4000-8000-000000000000';
const TEST_CANDIDATE_PREFIX = 'access.test';
const TEST_ROLE_ID = '66666666-6666-4666-8666-666666666666';

/**
 * Candidate contact details use `@example.net` and users use `@example.com`, so these
 * patterns separate "a candidate's email leaked" from "the caller's own account came
 * back from `GET /auth/me`", which is not a leak.
 */
const CANDIDATE_EMAIL = /@example\.net/;
const PHONE = /\+\d[\d ]{6,}/;

const tokens: Record<string, string> = {};
const userIds: Record<string, string> = {};

beforeAll(async () => {
  for (const email of [RECRUITER, INTERVIEWER]) {
    const response = await request(app).post('/auth/login').send({ email, password: DEV_PASSWORD });
    expect(response.status, `could not log in as ${email} — is the fixture seeded?`).toBe(200);
    tokens[email] = response.body.token as string;
    userIds[email] = response.body.user.id as string;
  }
});

afterAll(async () => {
  await cleanup();
  await prisma.role.deleteMany({ where: { id: TEST_ROLE_ID } });
  await disconnectDatabase();
});

async function cleanup(): Promise<void> {
  const candidates = await prisma.candidate.findMany({
    where: { email: { startsWith: TEST_CANDIDATE_PREFIX } },
    select: { applications: { select: { id: true, rounds: { select: { id: true } } } } },
  });
  const applicationIds = candidates.flatMap((c) => c.applications.map((a) => a.id));
  const roundIds = candidates.flatMap((c) => c.applications.flatMap((a) => a.rounds.map((r) => r.id)));

  // Feedback.roundId is RESTRICT, not CASCADE — feedback outlives its round by design.
  await prisma.feedback.deleteMany({ where: { roundId: { in: roundIds } } });
  await prisma.auditEvent.deleteMany({ where: { entityId: { in: [...applicationIds, ...roundIds] } } });
  await prisma.candidate.deleteMany({ where: { email: { startsWith: TEST_CANDIDATE_PREFIX } } });
}

function auth(email: string): [string, string] {
  return ['authorization', `Bearer ${tokens[email]}`];
}

// ---------------------------------------------------------------------------
// 1. No anonymous path
// ---------------------------------------------------------------------------

/** `:id` and friends are substituted with a well-formed uuid; nothing needs to exist. */
function concretePath(spec: OperationSpec): string {
  return spec.path.replace(/:[A-Za-z0-9_]+/g, NO_SUCH_UUID);
}

function drive(spec: OperationSpec, headers: Array<[string, string]> = []) {
  const call = request(app)[spec.method](concretePath(spec));
  for (const [field, value] of headers) call.set(field, value);
  return spec.method === 'get' ? call : call.send({});
}

describe('every guarded route refuses an anonymous caller (PLAN.md §9)', () => {
  const guarded = registeredOperations().filter((spec) => spec.security !== 'none');
  const anonymous = registeredOperations().filter((spec) => spec.security === 'none');

  it('has something to sweep, and exactly two open routes (PLAN.md §4)', () => {
    expect(guarded.length).toBeGreaterThan(10);
    expect(anonymous.map((spec) => spec.path).sort()).toEqual(['/auth/login', '/health']);
  });

  it.each(guarded.map((spec) => [`${spec.method.toUpperCase()} ${spec.path}`, spec] as const))(
    '%s → 401 with a Bearer challenge',
    async (_label, spec) => {
      const response = await drive(spec);

      expect(response.status).toBe(401);
      // RFC 9110 §15.5.2: a 401 names the scheme the caller should have used.
      expect(response.headers['www-authenticate']).toBe('Bearer');
      expect(response.body.title).toBe('Unauthorized');
    },
  );

  /**
   * The same sweep with a token-shaped string that is not a token. It runs the *second*
   * half of `requireAuth` — the header parses, the signature does not verify — which the
   * anonymous pass never reaches.
   */
  it.each(guarded.map((spec) => [`${spec.method.toUpperCase()} ${spec.path}`, spec] as const))(
    '%s → 401 for a forged token',
    async (_label, spec) => {
      const forged = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJub3BlIiwicm9sZSI6IlJFQ1JVSVRFUiJ9.';
      const response = await drive(spec, [['authorization', `Bearer ${forged}`]]);

      expect(response.status).toBe(401);
    },
  );

  it('and the two open routes do answer without one', async () => {
    expect((await request(app).get('/health')).status).toBe(200);
    expect(
      (await request(app).post('/auth/login').send({ email: RECRUITER, password: DEV_PASSWORD }))
        .status,
    ).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 2. No contact leak, anywhere an interviewer can reach
// ---------------------------------------------------------------------------

describe('no interviewer-reachable response carries contact details (PLAN.md §9)', () => {
  /** A candidate with both contact fields populated, a round, and Ingrid assigned to it. */
  async function givenOwnRound(): Promise<string> {
    const hiringManager = await prisma.user.findFirstOrThrow({
      where: { role: 'HIRING_MANAGER' },
      select: { id: true },
    });
    await prisma.role.upsert({
      where: { id: TEST_ROLE_ID },
      create: { id: TEST_ROLE_ID, title: 'Access Sweep Role', hiringManagerId: hiringManager.id },
      update: {},
    });

    const candidate = await prisma.candidate.create({
      data: {
        name: 'Access Sweep Candidate',
        email: `${TEST_CANDIDATE_PREFIX}.1@example.net`,
        phone: '+44 20 7946 0555',
        applications: { create: { roleId: TEST_ROLE_ID, currentStage: Stage.INTERVIEW } },
      },
      select: { applications: { select: { id: true } } },
    });

    const round = await prisma.interviewRound.create({
      data: {
        applicationId: candidate.applications[0]!.id,
        stage: Stage.INTERVIEW,
        scheduledAt: new Date(),
      },
      select: { id: true },
    });

    await prisma.roundAssignment.create({
      data: {
        roundId: round.id,
        interviewerId: userIds[INTERVIEWER] as string,
        assignedById: userIds[RECRUITER] as string,
      },
      select: { roundId: true },
    });

    return round.id;
  }

  it('scans every reachable route, including the ones that refuse', async () => {
    const ownRound = await givenOwnRound();

    /**
     * Successes, refusals and not-founds together. A 403 or 404 body is a response like
     * any other, and an error message that helpfully names the candidate it is refusing
     * to show you would defeat the whole design.
     */
    const responses = [
      // Reachable, and expected to succeed.
      await request(app).get('/auth/me').set(...auth(INTERVIEWER)),
      await request(app).get('/me/rounds').set(...auth(INTERVIEWER)),
      await request(app).get(`/rounds/${ROUND_IDS.r01}`).set(...auth(INTERVIEWER)),
      await request(app).get(`/rounds/${ROUND_IDS.r01}/feedback`).set(...auth(INTERVIEWER)),
      await request(app).get(`/candidates/${CANDIDATE_IDS.c01}`).set(...auth(INTERVIEWER)),
      await request(app).get(`/candidates/${CANDIDATE_IDS.c03}`).set(...auth(INTERVIEWER)),
      await request(app).get(`/rounds/${ownRound}`).set(...auth(INTERVIEWER)),

      // The feedback POST's own response body — named in §9, and the one response that
      // is written rather than read.
      await request(app)
        .post(`/rounds/${ownRound}/feedback`)
        .set(...auth(INTERVIEWER))
        .send({ rating: 3, notes: 'Sweep fixture feedback.' }),
      await request(app).get(`/rounds/${ownRound}/feedback`).set(...auth(INTERVIEWER)),

      // Out of scope: 404, and the body must say nothing about what it is hiding.
      await request(app).get(`/candidates/${CANDIDATE_IDS.c02}`).set(...auth(INTERVIEWER)),
      await request(app).get(`/candidates/${NO_SUCH_UUID}`).set(...auth(INTERVIEWER)),
      await request(app).get(`/rounds/${ROUND_IDS.r02}`).set(...auth(INTERVIEWER)),
      await request(app).get(`/rounds/${ROUND_IDS.r02}/feedback`).set(...auth(INTERVIEWER)),

      // Wrong role: 403.
      await request(app).get('/pipeline').set(...auth(INTERVIEWER)),
      await request(app).get('/roles').set(...auth(INTERVIEWER)),
      await request(app).get(`/audit/candidates/${CANDIDATE_IDS.c01}`).set(...auth(INTERVIEWER)),
      await request(app)
        .post('/applications')
        .set(...auth(INTERVIEWER))
        .send({ candidateId: CANDIDATE_IDS.c01, roleId: TEST_ROLE_ID }),

      // Bad input: the 400 body echoes paths and messages, never values.
      await request(app).get('/candidates/not-a-uuid').set(...auth(INTERVIEWER)),
      await request(app)
        .post(`/rounds/${ownRound}/feedback`)
        .set(...auth(INTERVIEWER))
        .send({ rating: 99, notes: '' }),
    ];

    // Guards against the loop below passing because something returned an empty body.
    expect(responses).toHaveLength(19);
    expect(responses.filter((response) => response.status === 200).length).toBeGreaterThan(5);

    for (const response of responses) {
      const where = `${response.request.method} ${response.request.url} → ${response.status}`;
      expect(response.text, `candidate email leaked in ${where}`).not.toMatch(CANDIDATE_EMAIL);
      expect(response.text, `phone number leaked in ${where}`).not.toMatch(PHONE);
    }
  });

  /**
   * The control. If the patterns above stopped matching anything — a changed fixture
   * domain, a typo'd regex — every assertion in this file would pass while proving
   * nothing. A recruiter reading the same candidate must trip both.
   */
  it('trips on the recruiter view of the same candidate', async () => {
    const response = await request(app)
      .get(`/candidates/${CANDIDATE_IDS.c01}`)
      .set(...auth(RECRUITER));

    expect(response.status).toBe(200);
    expect(response.text).toMatch(CANDIDATE_EMAIL);
    expect(response.text).toMatch(PHONE);
  });
});
