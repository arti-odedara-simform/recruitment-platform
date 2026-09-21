import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { RoleStatus, Stage, UserRole } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma, disconnectDatabase } from '../src/db/client.js';
import { hashPassword } from '../src/auth/password.js';
import { APPLICATION_IDS, DEV_PASSWORD, ROLE_IDS, USER_IDS } from '../src/seed/fixture.js';

/**
 * PLAN.md §6 — the pipeline view. The seeded fixture was built for these assertions:
 * `daysInStage` spans 1 to 45 days, one role is CLOSED, and two candidates sit on two
 * roles each, so a query that grouped by candidate rather than by application would
 * produce visibly wrong counts here.
 */

const app = createApp();

const RECRUITER = 'rachel.recruiter@example.com';
const HIRING_MANAGER = 'hana.manager@example.com';
const INTERVIEWER = 'ingrid.interviewer@example.com';

/** A second hiring manager, so "scoped to own roles" has something to exclude. */
const OTHER_MANAGER = 'pipeline.test.manager@example.com';
const OTHER_MANAGER_PASSWORD = 'pipeline-test-password';
const OTHER_MANAGER_ROLE_ID = '44444444-4444-4444-8444-444444444444';
/** An OPEN req nobody has applied to — the LEFT JOIN case. */
const EMPTY_ROLE_ID = '44444444-4444-4444-8444-444444444445';

const NO_SUCH_UUID = '00000000-0000-4000-8000-000000000000';

/** Every statement Prisma emits, cleared immediately before the request under test. */
const emitted: string[] = [];
prisma.$on('query', (event) => emitted.push(event.query));

const tokens: Record<string, string> = {};

beforeAll(async () => {
  for (const email of [RECRUITER, HIRING_MANAGER, INTERVIEWER]) {
    const response = await request(app).post('/auth/login').send({ email, password: DEV_PASSWORD });
    expect(response.status, `could not log in as ${email} — is the fixture seeded?`).toBe(200);
    tokens[email] = response.body.token as string;
  }

  const other = await prisma.user.upsert({
    where: { email: OTHER_MANAGER },
    create: {
      email: OTHER_MANAGER,
      name: 'Pipeline Test Manager',
      role: UserRole.HIRING_MANAGER,
      passwordHash: await hashPassword(OTHER_MANAGER_PASSWORD),
    },
    update: {},
    select: { id: true },
  });

  const login = await request(app)
    .post('/auth/login')
    .send({ email: OTHER_MANAGER, password: OTHER_MANAGER_PASSWORD });
  tokens[OTHER_MANAGER] = login.body.token as string;

  await prisma.role.upsert({
    where: { id: OTHER_MANAGER_ROLE_ID },
    create: {
      id: OTHER_MANAGER_ROLE_ID,
      title: 'Pipeline Test Foreign Req',
      hiringManagerId: other.id,
      status: RoleStatus.OPEN,
    },
    update: {},
  });

  await prisma.role.upsert({
    where: { id: EMPTY_ROLE_ID },
    create: {
      id: EMPTY_ROLE_ID,
      title: 'Pipeline Test Empty Req',
      hiringManagerId: USER_IDS.hana,
      status: RoleStatus.OPEN,
    },
    update: {},
  });
});

afterAll(async () => {
  await prisma.role.deleteMany({ where: { id: { in: [OTHER_MANAGER_ROLE_ID, EMPTY_ROLE_ID] } } });
  await prisma.user.deleteMany({ where: { email: OTHER_MANAGER } });
  await disconnectDatabase();
});

interface StageCell {
  stage: Stage;
  candidates: number;
  averageAgeDays: number;
  oldestAgeDays: number;
}

interface RoleCell {
  roleId: string;
  title: string;
  totalCandidates: number;
  stages: StageCell[];
}

function get(email: string, queryString = '') {
  return request(app)
    .get(`/pipeline${queryString}`)
    .set('authorization', `Bearer ${tokens[email]}`);
}

function roleOf(body: RoleCell[], roleId: string): RoleCell | undefined {
  return body.find((role) => role.roleId === roleId);
}

function stageOf(role: RoleCell | undefined, stage: Stage): StageCell | undefined {
  return role?.stages.find((cell) => cell.stage === stage);
}

describe('GET /pipeline — counts and ageing', () => {
  it('counts the seeded backend funnel, one entry per stage', async () => {
    const response = await get(RECRUITER);

    expect(response.status).toBe(200);
    const backend = roleOf(response.body, ROLE_IDS.backend);

    expect(backend?.title).toBe('Senior Backend Engineer');
    expect(backend?.totalCandidates).toBe(9);
    // Stage order follows the Postgres enum's declaration order, not the alphabet.
    expect(backend?.stages.map((cell) => cell.stage)).toEqual([
      Stage.APPLIED,
      Stage.SCREEN,
      Stage.INTERVIEW,
      Stage.OFFER,
      Stage.HIRED,
      Stage.REJECTED,
    ]);
    expect(stageOf(backend, Stage.INTERVIEW)?.candidates).toBe(2);
    expect(stageOf(backend, Stage.SCREEN)?.candidates).toBe(2);
    expect(stageOf(backend, Stage.OFFER)?.candidates).toBe(1);
  });

  /**
   * a01 has been in INTERVIEW for 6 days and a02 for 21, so the average is 13.5 and the
   * oldest is 21 — both computed by Postgres from `currentStageEnteredAt`. The tolerance
   * is the time between the seed running in globalSetup and this assertion.
   *
   * These numbers are also the regression test for the time-zone trap described in
   * pipeline.repository.ts: `now() - <timestamp without time zone>` is resolved through
   * the session's zone, so before the `AT TIME ZONE 'UTC'` fix every age here was out by
   * the server's UTC offset — 13.7 instead of 13.5 on a machine set to Asia/Kolkata. A
   * looser tolerance would have let that ship.
   */
  it('ages each stage from currentStageEnteredAt', async () => {
    const backend = roleOf((await get(RECRUITER)).body, ROLE_IDS.backend);
    const interview = stageOf(backend, Stage.INTERVIEW);

    expect(interview?.averageAgeDays).toBeCloseTo(13.5, 1);
    expect(interview?.oldestAgeDays).toBeCloseTo(21, 1);

    // The oldest row in the fixture, so a max() that had silently become an avg() shows.
    expect(stageOf(backend, Stage.HIRED)?.oldestAgeDays).toBeCloseTo(45, 1);
  });

  /**
   * c01 and c05 each sit on two roles. The pipeline unit is the application, so c01 is
   * counted once under backend and once under platform — never once overall.
   */
  it('counts applications, not candidates', async () => {
    const body = (await get(RECRUITER)).body;
    const platform = roleOf(body, ROLE_IDS.platform);

    expect(platform?.totalCandidates).toBe(6);
    expect(stageOf(platform, Stage.APPLIED)?.candidates).toBe(2);
    expect(stageOf(platform, Stage.APPLIED)?.averageAgeDays).toBeCloseTo(10, 1);
  });

  it('omits CLOSED reqs — a closed req is history, not pipeline', async () => {
    const response = await get(RECRUITER);

    expect(roleOf(response.body, ROLE_IDS.design)).toBeUndefined();
    // The control: the fixture's two applications on that role do exist.
    expect(await prisma.application.count({ where: { roleId: ROLE_IDS.design } })).toBe(2);
  });

  it('includes an open req with no applications, as zeros rather than a gap', async () => {
    const empty = roleOf((await get(RECRUITER)).body, EMPTY_ROLE_ID);

    expect(empty).toBeDefined();
    expect(empty?.totalCandidates).toBe(0);
    expect(empty?.stages).toEqual([]);
  });

  it('narrows to one req with ?roleId=', async () => {
    const response = await get(RECRUITER, `?roleId=${ROLE_IDS.platform}`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].roleId).toBe(ROLE_IDS.platform);
  });

  it('returns an empty view for a roleId that matches nothing', async () => {
    const response = await get(RECRUITER, `?roleId=${NO_SUCH_UUID}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });
});

describe('GET /pipeline — who may read it', () => {
  it('401s without a token', async () => {
    expect((await request(app).get('/pipeline')).status).toBe(401);
  });

  it('403s an interviewer', async () => {
    const response = await get(INTERVIEWER);

    expect(response.status).toBe(403);
    expect(response.body.title).toBe('Forbidden');
  });

  it('400s a malformed roleId before any query runs (PLAN.md §7)', async () => {
    emitted.length = 0;
    const response = await get(RECRUITER, '?roleId=not-a-uuid');

    expect(response.status).toBe(400);
    expect(response.body.errors?.[0].path).toBe('query.roleId');
    expect(emitted).toEqual([]);
  });

  /**
   * PLAN.md §4: a hiring manager is scoped to their own reqs. The restriction is a
   * predicate in the aggregate, so another manager's req is not in the result to be
   * filtered — asking for it by id returns an empty view rather than a 403, for the same
   * reason an unassigned candidate 404s (§4).
   */
  it('scopes a hiring manager to their own reqs', async () => {
    const response = await get(HIRING_MANAGER);

    expect(response.status).toBe(200);
    expect(roleOf(response.body, ROLE_IDS.backend)).toBeDefined();
    expect(roleOf(response.body, ROLE_IDS.platform)).toBeDefined();
    expect(roleOf(response.body, OTHER_MANAGER_ROLE_ID)).toBeUndefined();

    const byId = await get(HIRING_MANAGER, `?roleId=${OTHER_MANAGER_ROLE_ID}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toEqual([]);

    // The control: that req is real, and its own manager sees it.
    const owner = await get(OTHER_MANAGER, `?roleId=${OTHER_MANAGER_ROLE_ID}`);
    expect(owner.body).toHaveLength(1);
  });

  it('gives a recruiter the reqs a hiring manager cannot see', async () => {
    const response = await get(RECRUITER);

    expect(roleOf(response.body, OTHER_MANAGER_ROLE_ID)).toBeDefined();
  });
});

/**
 * PLAN.md §6: "no row ever reaches Node except the aggregate". These are the tests that
 * make that a fact rather than a claim — and they double as the contact-leak argument
 * for this endpoint, since a statement that never touches the candidate table cannot
 * return a candidate's email.
 */
describe('the aggregate is computed in Postgres', () => {
  it('emits one grouped statement that never reads the candidate table', async () => {
    emitted.length = 0;
    expect((await get(RECRUITER)).status).toBe(200);

    const aggregates = emitted.filter((statement) => /FROM "Role"/i.test(statement));
    expect(aggregates).toHaveLength(1);

    const statement = aggregates[0] as string;
    expect(statement).toMatch(/GROUP BY/i);
    expect(statement).toMatch(/count\(/i);
    expect(statement).not.toMatch(/"Candidate"/);
    expect(statement).not.toMatch(/email|phone/i);
  });

  /**
   * Seventeen applications in the fixture, and the largest result the endpoint can
   * return is (open reqs x stages) — which is what keeps the §8 twenty-thousand-row run
   * from putting twenty thousand rows through this process.
   */
  it('returns at most one row per (open req, stage), whatever the pipeline holds', async () => {
    const response = await get(RECRUITER);
    const roles: RoleCell[] = response.body;

    const cells = roles.reduce((total, role) => total + role.stages.length, 0);
    const openRoles = await prisma.role.count({ where: { status: RoleStatus.OPEN } });

    expect(roles).toHaveLength(openRoles);
    expect(cells).toBeLessThanOrEqual(openRoles * Object.keys(Stage).length);

    const applications = await prisma.application.count();
    expect(applications).toBeGreaterThan(cells);
  });
});

/**
 * PLAN.md §4 and §8 — "stuck beyond N days". The seeded `daysInStage` spread is what
 * makes this testable without building anything: rows sit at 1, 3, 4, 6, 9, 12, 21 and
 * 45 days, on both sides of any threshold, and two of the oldest are deliberately in
 * terminal stages or on a closed req so the exclusions have something to exclude.
 */
describe('GET /pipeline/stuck', () => {
  interface StuckRow {
    applicationId: string;
    candidate: { id: string; name: string };
    roleId: string;
    roleTitle: string;
    currentStage: Stage;
    daysInStage: number;
  }

  function stuck(email: string | undefined, queryString = '') {
    const call = request(app).get(`/pipeline/stuck${queryString}`);
    return email ? call.set('authorization', `Bearer ${tokens[email]}`) : call;
  }

  /**
   * At ten days the fixture has exactly three: a02 (21 days, INTERVIEW), a12 (15,
   * APPLIED) and a04 (12, SCREEN) — longest wait first.
   *
   * Everything older that is *not* here is the point of the test: a09 has been HIRED for
   * 45 days, a08 REJECTED for 30, and a17 has waited 20 days on a CLOSED req.
   */
  it('lists what is past the threshold, longest wait first', async () => {
    const response = await stuck(RECRUITER, '?days=10');

    expect(response.status).toBe(200);
    const rows: StuckRow[] = response.body;

    expect(rows.map((row) => row.applicationId)).toEqual([
      APPLICATION_IDS.a02,
      APPLICATION_IDS.a12,
      APPLICATION_IDS.a04,
    ]);
    expect(rows[0]).toMatchObject({
      currentStage: Stage.INTERVIEW,
      roleTitle: 'Senior Backend Engineer',
      candidate: { name: 'Bruno Costa' },
    });
    expect(rows[0]?.daysInStage).toBeCloseTo(21, 1);
  });

  it('excludes terminal stages — hired is not stuck, it is done', async () => {
    const ids = ((await stuck(RECRUITER, '?days=1')).body as StuckRow[]).map((r) => r.applicationId);

    expect(ids).not.toContain(APPLICATION_IDS.a09); // HIRED, 45 days
    expect(ids).not.toContain(APPLICATION_IDS.a08); // REJECTED, 30 days
    expect(ids).toContain(APPLICATION_IDS.a02);
  });

  it('excludes closed reqs, as the aggregate does', async () => {
    const ids = ((await stuck(RECRUITER, '?days=1')).body as StuckRow[]).map((r) => r.applicationId);

    expect(ids).not.toContain(APPLICATION_IDS.a16);
    expect(ids).not.toContain(APPLICATION_IDS.a17);
  });

  it('narrows by req, and returns nothing at an unreachable threshold', async () => {
    const platform: StuckRow[] = (await stuck(RECRUITER, `?days=10&roleId=${ROLE_IDS.platform}`)).body;
    expect(platform.map((row) => row.applicationId)).toEqual([APPLICATION_IDS.a12]);

    expect((await stuck(RECRUITER, '?days=365')).body).toEqual([]);
  });

  it('caps the result with limit', async () => {
    const rows: StuckRow[] = (await stuck(RECRUITER, '?days=1&limit=2')).body;

    expect(rows).toHaveLength(2);
    // Still the oldest two, not an arbitrary two.
    expect(rows[0]?.applicationId).toBe(APPLICATION_IDS.a02);
  });

  it('defaults to 14 days when none is given', async () => {
    const rows: StuckRow[] = (await stuck(RECRUITER)).body;

    expect(rows.map((row) => row.applicationId)).toEqual([
      APPLICATION_IDS.a02,
      APPLICATION_IDS.a12,
    ]);
  });

  it('scopes a hiring manager to their own reqs', async () => {
    const hers: StuckRow[] = (await stuck(HIRING_MANAGER, '?days=10')).body;
    expect(hers.map((row) => row.applicationId)).toContain(APPLICATION_IDS.a02);

    // Owns no req in the fixture, so nothing is stuck for them.
    expect((await stuck(OTHER_MANAGER, '?days=1')).body).toEqual([]);
  });

  it('names no contact details', async () => {
    const response = await stuck(RECRUITER, '?days=1');

    expect(response.text).not.toMatch(/@example\.net/);
    expect(response.text).not.toMatch(/\+\d[\d ]{6,}/);
  });

  it.each(['?days=0', '?days=nope', '?days=400', '?limit=0', '?limit=501'])(
    '400s %s',
    async (queryString) => {
      emitted.length = 0;
      const response = await stuck(RECRUITER, queryString);

      expect(response.status).toBe(400);
      expect(emitted).toEqual([]);
    },
  );

  it('403s an interviewer and 401s an anonymous caller', async () => {
    expect((await stuck(INTERVIEWER, '?days=10')).status).toBe(403);
    expect((await stuck(undefined, '?days=10')).status).toBe(401);
  });
});
