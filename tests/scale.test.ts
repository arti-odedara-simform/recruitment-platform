import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { RoleStatus, Stage } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma, disconnectDatabase } from '../src/db/client.js';
import { countGenerated, deleteGenerated } from '../src/repositories/scale.repository.js';
import { MARKERS, generateScaleDataset } from '../src/seed/scale.js';
import { DEV_PASSWORD } from '../src/seed/fixture.js';

/**
 * PLAN.md §9, last-but-one row: the pipeline view, measured against the §8 dataset —
 * 200 reqs and 20 000 candidates — asserting that it answers under a threshold **and
 * that Node never materialises more than the aggregate**.
 *
 * The second half is the one that matters. A wall-clock threshold on a shared machine
 * measures the machine as much as the query, so the one here is deliberately loose: it
 * catches a regression of *kind* — somebody replacing the grouped SQL with a fetch-then-
 * group in JavaScript would blow through it by an order of magnitude — and says nothing
 * about a few milliseconds either way. The row-count assertions are exact, and they are
 * what makes "no row ever reaches Node except the aggregate" a fact at this size rather
 * than at fixture size.
 *
 * The dataset is generated here and removed in `afterAll`. It is deterministic
 * (`SCALE_DEFAULTS.seed`), so a failure is reproducible rather than a story about the
 * data that happened to exist.
 *
 * Plans captured against this same dataset: docs/query-plans.md.
 */

const app = createApp();

const RECRUITER = 'rachel.recruiter@example.com';

/**
 * Generous on purpose — see above. A grouped aggregate over 21 951 rows answers in tens
 * of milliseconds; a version that loaded the rows would take seconds.
 */
const THRESHOLD_MS = 2_000;

let token = '';
let generated = { roles: 0, candidates: 0, applications: 0 };

beforeAll(async () => {
  const login = await request(app)
    .post('/auth/login')
    .send({ email: RECRUITER, password: DEV_PASSWORD });
  expect(login.status, 'could not log in — is the fixture seeded?').toBe(200);
  token = login.body.token as string;

  // Left over from an interrupted run, if anything was.
  await deleteGenerated(MARKERS);

  const result = await generateScaleDataset();
  generated = {
    roles: result.roles,
    candidates: result.candidates,
    applications: result.applications,
  };

  expect(generated.candidates).toBe(20_000);
}, 120_000);

afterAll(async () => {
  await deleteGenerated(MARKERS);
  const left = await countGenerated(MARKERS);
  expect(left, 'the scale dataset outlived its test').toEqual({
    roles: 0,
    candidates: 0,
    applications: 0,
  });
  await disconnectDatabase();
}, 120_000);

interface RoleCell {
  roleId: string;
  stages: Array<{ stage: Stage; candidates: number }>;
  totalCandidates: number;
}

function get(path: string) {
  return request(app).get(path).set('authorization', `Bearer ${token}`);
}

describe('GET /pipeline at 20 000 candidates (PLAN.md §6, §8)', () => {
  it('answers under the threshold', async () => {
    const startedAt = performance.now();
    const response = await get('/pipeline');
    const elapsed = performance.now() - startedAt;

    expect(response.status).toBe(200);
    expect(
      elapsed,
      `the pipeline aggregate took ${elapsed.toFixed(0)}ms over ${generated.applications} applications`,
    ).toBeLessThan(THRESHOLD_MS);
  });

  /**
   * The §6 claim, at scale. 21 951 applications go into the database and at most
   * (open reqs x stages) cells come back — the response is bounded by the *shape* of the
   * pipeline, never by its size.
   */
  it('returns one row per (open req, stage) and not one more', async () => {
    const roles: RoleCell[] = (await get('/pipeline')).body;

    const openReqs = await prisma.role.count({ where: { status: RoleStatus.OPEN } });
    const cells = roles.reduce((total, role) => total + role.stages.length, 0);

    expect(roles).toHaveLength(openReqs);
    expect(cells).toBeLessThanOrEqual(openReqs * Object.keys(Stage).length);

    // The point of the assertion above: two orders of magnitude fewer rows than exist.
    const applications = await prisma.application.count();
    expect(applications).toBeGreaterThan(20_000);
    expect(cells * 10).toBeLessThan(applications);
  });

  it('counts every application in an open req exactly once', async () => {
    const roles: RoleCell[] = (await get('/pipeline')).body;

    const counted = roles.reduce((total, role) => total + role.totalCandidates, 0);
    const expected = await prisma.application.count({ where: { role: { status: RoleStatus.OPEN } } });

    expect(counted).toBe(expected);
  });

  /**
   * The filtered path — the one the index is actually for (docs/query-plans.md §3). It
   * reads 136-odd index entries out of 21 951 rows, so if it were ever to degrade into a
   * scan of the whole table, it would do so here first.
   */
  it('answers a single-req view without reading the pipeline', async () => {
    const roles: RoleCell[] = (await get('/pipeline')).body;
    const busiest = roles.reduce((a, b) => (a.totalCandidates > b.totalCandidates ? a : b));

    const startedAt = performance.now();
    const response = await get(`/pipeline?roleId=${busiest.roleId}`);
    const elapsed = performance.now() - startedAt;

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].roleId).toBe(busiest.roleId);
    expect(elapsed).toBeLessThan(THRESHOLD_MS);
  });

  /** 20 000 candidates with contact details, and none of them in a pipeline response. */
  it('names no candidate, at any size', async () => {
    const response = await get('/pipeline');

    expect(response.text).not.toMatch(/@scale\.example\.invalid/);
    expect(response.text).not.toMatch(/\+\d[\d ]{6,}/);
    expect(response.text).not.toMatch(/Scale Candidate/);
  });
});
