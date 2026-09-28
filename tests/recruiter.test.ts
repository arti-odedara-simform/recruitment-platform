import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { UserRole } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma, disconnectDatabase } from '../src/db/client.js';
import { hashPassword } from '../src/auth/password.js';
import {
  CANDIDATE_IDS,
  DEV_PASSWORD,
  ROLE_IDS,
  ROUND_IDS,
  USER_IDS,
} from '../src/seed/fixture.js';

/**
 * The three reads the recruiter screens are built on, and the reason each one is not
 * simply "the recruiter can see everything":
 *
 * - `GET /applications` — the work queue. Recruiters get every req; a hiring manager gets
 *   their own, by a predicate in the same query rather than a filter over a wider read.
 * - `GET /applications/:candidateId/:roleId/rounds` — the rounds and, crucially, the
 *   *panel*. Recruiter-only, because the roster is the one thing the assignment scope
 *   exists to keep from interviewers.
 * - `GET /users` — the picker behind "assign an interviewer". Recruiter-only for the same
 *   reason: an interviewer who can enumerate the panel knows who else is interviewing.
 *
 * Driven over real HTTP against the seeded fixture (PLAN.md §9), so what is asserted is
 * what a browser would receive.
 */

const app = createApp();

const RECRUITER = 'rachel.recruiter@example.com';
const INTERVIEWER = 'ingrid.interviewer@example.com';
const HIRING_MANAGER = 'hana.manager@example.com';

/** A second hiring manager, so "scoped to their own reqs" has something to exclude. */
const OTHER_MANAGER = 'recruiter.test.manager@example.com';
const OTHER_ROLE_ID = '77777777-7777-4777-8777-777777777777';
const TEST_CANDIDATE_EMAIL = 'recruiter.test.candidate@example.net';

/** Candidate contact details are `@example.net`; a list endpoint must never carry one. */
const CANDIDATE_EMAIL = /@example\.net/;

const tokens: Record<string, string> = {};

beforeAll(async () => {
  const manager = await prisma.user.upsert({
    where: { email: OTHER_MANAGER },
    create: {
      email: OTHER_MANAGER,
      name: 'Other Manager',
      role: UserRole.HIRING_MANAGER,
      passwordHash: await hashPassword(DEV_PASSWORD),
    },
    update: {},
    select: { id: true },
  });

  await prisma.role.upsert({
    where: { id: OTHER_ROLE_ID },
    create: { id: OTHER_ROLE_ID, title: 'Other Manager Req', hiringManagerId: manager.id },
    update: { hiringManagerId: manager.id },
  });

  await prisma.candidate.upsert({
    where: { id: '77777777-7777-4777-8777-777777777778' },
    create: {
      id: '77777777-7777-4777-8777-777777777778',
      name: 'Other Manager Candidate',
      email: TEST_CANDIDATE_EMAIL,
      applications: { create: { roleId: OTHER_ROLE_ID } },
    },
    update: {},
  });

  for (const email of [RECRUITER, INTERVIEWER, HIRING_MANAGER]) {
    const response = await request(app).post('/auth/login').send({ email, password: DEV_PASSWORD });
    expect(response.status, `could not log in as ${email} — is the fixture seeded?`).toBe(200);
    tokens[email] = response.body.token as string;
  }
});

afterAll(async () => {
  // `findFirst`, not `findUnique`: a candidate's email carries no unique index — it is
  // data about a person, not an account identifier.
  const candidate = await prisma.candidate.findFirst({
    where: { email: TEST_CANDIDATE_EMAIL },
    select: { applications: { select: { id: true } } },
  });
  await prisma.auditEvent.deleteMany({
    where: { entityId: { in: (candidate?.applications ?? []).map((row) => row.id) } },
  });
  await prisma.candidate.deleteMany({ where: { email: TEST_CANDIDATE_EMAIL } });
  await prisma.role.deleteMany({ where: { id: OTHER_ROLE_ID } });
  await prisma.user.deleteMany({ where: { email: OTHER_MANAGER } });
  await disconnectDatabase();
});

function auth(email: string): [string, string] {
  return ['authorization', `Bearer ${tokens[email]}`];
}

describe('GET /applications', () => {
  it('lists every open req for a recruiter, longest-waiting first', async () => {
    const response = await request(app).get('/applications').set(...auth(RECRUITER));

    expect(response.status).toBe(200);

    const ids = response.body.map((row: { candidate: { id: string } }) => row.candidate.id);
    expect(ids).toContain(CANDIDATE_IDS.c01);

    const waits = response.body.map((row: { daysInStage: number }) => row.daysInStage);
    expect(waits).toEqual([...waits].sort((a: number, b: number) => b - a));
  });

  /**
   * The same default `GET /roles` takes: a closed req is history. `c15` sits on the
   * CLOSED design req and nowhere else, so its absence here is the filter working.
   */
  it('excludes closed reqs by default and includes them on request', async () => {
    const open = await request(app).get('/applications').set(...auth(RECRUITER));
    const all = await request(app).get('/applications?roleStatus=ALL').set(...auth(RECRUITER));

    const idsIn = (response: { body: Array<{ candidate: { id: string } }> }) =>
      response.body.map((row) => row.candidate.id);

    expect(idsIn(open)).not.toContain(CANDIDATE_IDS.c15);
    expect(idsIn(all)).toContain(CANDIDATE_IDS.c15);
  });

  it('narrows by req and by stage', async () => {
    const byRole = await request(app)
      .get(`/applications?roleId=${ROLE_IDS.platform}`)
      .set(...auth(RECRUITER));
    expect(byRole.status).toBe(200);
    expect(byRole.body.length).toBeGreaterThan(0);
    expect(byRole.body.every((row: { roleId: string }) => row.roleId === ROLE_IDS.platform)).toBe(true);

    const byStage = await request(app).get('/applications?stage=OFFER').set(...auth(RECRUITER));
    expect(byStage.status).toBe(200);
    expect(byStage.body.length).toBeGreaterThan(0);
    expect(byStage.body.every((row: { currentStage: string }) => row.currentStage === 'OFFER')).toBe(
      true,
    );
  });

  /**
   * The list names candidates, so it is worth scanning: contact details are read one
   * record at a time from `GET /candidates/:id`, never in bulk (PLAN.md §1).
   */
  it('carries no candidate contact details', async () => {
    const response = await request(app).get('/applications?roleStatus=ALL').set(...auth(RECRUITER));

    expect(response.text).not.toMatch(CANDIDATE_EMAIL);
    expect(response.text).not.toMatch(/\+\d[\d ]{6,}/);
  });

  it('scopes a hiring manager to the reqs they own', async () => {
    const response = await request(app).get('/applications').set(...auth(HIRING_MANAGER));

    expect(response.status).toBe(200);
    expect(response.body.length).toBeGreaterThan(0);
    expect(response.body.some((row: { roleId: string }) => row.roleId === OTHER_ROLE_ID)).toBe(false);
  });

  /** Another manager's `?roleId=` is not a filtered view — the rows were never selected. */
  it('returns an empty list for a req a hiring manager does not own', async () => {
    const response = await request(app)
      .get(`/applications?roleId=${OTHER_ROLE_ID}`)
      .set(...auth(HIRING_MANAGER));

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  it('is closed to interviewers', async () => {
    const response = await request(app).get('/applications').set(...auth(INTERVIEWER));
    expect(response.status).toBe(403);
  });
});

describe('GET /applications/:candidateId/:roleId/rounds', () => {
  it('returns the rounds for an application with the panel attached', async () => {
    const response = await request(app)
      .get(`/applications/${CANDIDATE_IDS.c01}/${ROLE_IDS.backend}/rounds`)
      .set(...auth(RECRUITER));

    expect(response.status).toBe(200);
    // a01 carries r01 and r10 — the fixture's one application with two rounds.
    expect(response.body.map((round: { id: string }) => round.id)).toEqual([
      ROUND_IDS.r01,
      ROUND_IDS.r10,
    ]);

    const panel = response.body[0].assignments as Array<{
      interviewer: { id: string };
      assignedBy: { id: string };
    }>;
    expect(panel.map((entry) => entry.interviewer.id).sort()).toEqual(
      [USER_IDS.ingrid, USER_IDS.ivan].sort(),
    );
    expect(panel[0]?.assignedBy.id).toBe(USER_IDS.rachel);
  });

  it('404s on a pair that names no application', async () => {
    const response = await request(app)
      .get(`/applications/${CANDIDATE_IDS.c01}/${OTHER_ROLE_ID}/rounds`)
      .set(...auth(RECRUITER));

    expect(response.status).toBe(404);
  });

  it('is closed to interviewers and hiring managers', async () => {
    for (const email of [INTERVIEWER, HIRING_MANAGER]) {
      const response = await request(app)
        .get(`/applications/${CANDIDATE_IDS.c01}/${ROLE_IDS.backend}/rounds`)
        .set(...auth(email));

      expect(response.status, `as ${email}`).toBe(403);
    }
  });

  /**
   * Absent, not empty. An interviewer's round is read through a query that never selects
   * the roster, so there is no array here that a serializer had to clear.
   */
  it('leaves the panel off an interviewer’s own round view', async () => {
    const response = await request(app).get(`/rounds/${ROUND_IDS.r01}`).set(...auth(INTERVIEWER));

    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('assignments');
  });
});

describe('GET /users', () => {
  it('returns the interviewers a recruiter can assign, without password hashes', async () => {
    const response = await request(app).get('/users?role=INTERVIEWER').set(...auth(RECRUITER));

    expect(response.status).toBe(200);
    expect(response.body.every((user: { role: string }) => user.role === 'INTERVIEWER')).toBe(true);
    expect(response.body.map((user: { id: string }) => user.id)).toContain(USER_IDS.ingrid);
    expect(response.text).not.toMatch(/passwordHash|\$2[aby]\$/);
  });

  it('is closed to everyone but recruiters', async () => {
    for (const email of [INTERVIEWER, HIRING_MANAGER]) {
      const response = await request(app).get('/users').set(...auth(email));
      expect(response.status, `as ${email}`).toBe(403);
    }
  });
});
