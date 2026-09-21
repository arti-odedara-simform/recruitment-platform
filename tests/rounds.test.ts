import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Stage } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma, disconnectDatabase } from '../src/db/client.js';
import { DEV_PASSWORD } from '../src/seed/fixture.js';

/**
 * PLAN.md §5 (the concurrency rule), §1 (field sets on the round view) and §8 (audit).
 *
 * Rounds are built per test rather than taken from the seeded fixture: feedback tests
 * need a round with no feedback on it yet, and the unique-constraint cases need to be
 * the only writers.
 */

const app = createApp();

const RECRUITER = 'rachel.recruiter@example.com';
const OTHER_RECRUITER = 'raj.recruiter@example.com';
const INTERVIEWER_A = 'ingrid.interviewer@example.com';
const INTERVIEWER_B = 'ivan.interviewer@example.com';
/** Assigned to nothing in the fixture, so `GET /me/rounds` starts empty for them. */
const INTERVIEWER_C = 'ian.interviewer@example.com';
const HIRING_MANAGER = 'hana.manager@example.com';

const TEST_ROLE_ID = '33333333-3333-4333-8333-333333333333';
const TEST_CANDIDATE_PREFIX = 'rounds.test';
const NO_SUCH_UUID = '00000000-0000-4000-8000-000000000000';

const tokens: Record<string, string> = {};
const userIds: Record<string, string> = {};

beforeAll(async () => {
  const emails = [
    RECRUITER,
    OTHER_RECRUITER,
    INTERVIEWER_A,
    INTERVIEWER_B,
    INTERVIEWER_C,
    HIRING_MANAGER,
  ];

  for (const email of emails) {
    const response = await request(app).post('/auth/login').send({ email, password: DEV_PASSWORD });
    expect(response.status, `could not log in as ${email} — is the fixture seeded?`).toBe(200);
    tokens[email] = response.body.token as string;
    userIds[email] = response.body.user.id as string;
  }

  await prisma.role.upsert({
    where: { id: TEST_ROLE_ID },
    create: {
      id: TEST_ROLE_ID,
      title: 'Rounds Test Role',
      hiringManagerId: userIds[HIRING_MANAGER] as string,
    },
    update: {},
  });
});

afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await prisma.role.deleteMany({ where: { id: TEST_ROLE_ID } });
  await disconnectDatabase();
});

/**
 * Order matters. Candidates cascade to applications and rounds, but `Feedback.roundId`
 * is RESTRICT, not CASCADE — feedback is append-only, and a round disappearing should
 * not take the panel's record of it along. So feedback goes first, by hand.
 */
async function cleanup(): Promise<void> {
  const candidates = await prisma.candidate.findMany({
    where: { email: { startsWith: TEST_CANDIDATE_PREFIX } },
    select: { applications: { select: { id: true, rounds: { select: { id: true } } } } },
  });
  const applicationIds = candidates.flatMap((c) => c.applications.map((a) => a.id));
  const roundIds = candidates.flatMap((c) => c.applications.flatMap((a) => a.rounds.map((r) => r.id)));

  await prisma.feedback.deleteMany({ where: { roundId: { in: roundIds } } });
  await prisma.auditEvent.deleteMany({
    where: { entityId: { in: [...applicationIds, ...roundIds] } },
  });
  await prisma.candidate.deleteMany({ where: { email: { startsWith: TEST_CANDIDATE_PREFIX } } });
}

let sequence = 0;

async function givenApplication(): Promise<{ candidateId: string; roleId: string }> {
  const candidate = await prisma.candidate.create({
    data: {
      name: `Rounds Test ${(sequence += 1)}`,
      email: `${TEST_CANDIDATE_PREFIX}.${sequence}@example.net`,
      phone: '+44 20 7946 0999',
      applications: { create: { roleId: TEST_ROLE_ID, currentStage: Stage.INTERVIEW } },
    },
    select: { id: true },
  });
  return { candidateId: candidate.id, roleId: TEST_ROLE_ID };
}

function auth(email: string): [string, string] {
  return ['authorization', `Bearer ${tokens[email]}`];
}

/** A round on a fresh application, with `assigned` already assigned to it. */
async function givenRound(assigned: string[] = []): Promise<{ roundId: string; candidateId: string }> {
  const target = await givenApplication();
  const created = await request(app)
    .post('/rounds')
    .set(...auth(RECRUITER))
    .send({
      candidateId: target.candidateId,
      roleId: target.roleId,
      stage: Stage.INTERVIEW,
      scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
  expect(created.status).toBe(201);

  for (const email of assigned) {
    const response = await request(app)
      .post(`/rounds/${created.body.id}/assignments`)
      .set(...auth(RECRUITER))
      .send({ interviewerId: userIds[email] });
    expect(response.status).toBe(204);
  }

  return { roundId: created.body.id as string, candidateId: target.candidateId };
}

describe('POST /rounds', () => {
  it('creates a round against the (candidateId, roleId) pair', async () => {
    const target = await givenApplication();
    const response = await request(app)
      .post('/rounds')
      .set(...auth(RECRUITER))
      .send({ ...target, stage: Stage.SCREEN, scheduledAt: new Date().toISOString() });

    expect(response.status).toBe(201);
    expect(response.body.id).toBeTruthy();

    const audit = await prisma.auditEvent.findMany({ where: { entityId: response.body.id } });
    expect(audit.map((event) => event.action)).toEqual(['ROUND_CREATED']);
  });

  it('404s when no application exists for that pair', async () => {
    const response = await request(app)
      .post('/rounds')
      .set(...auth(RECRUITER))
      .send({
        candidateId: NO_SUCH_UUID,
        roleId: TEST_ROLE_ID,
        stage: Stage.SCREEN,
        scheduledAt: new Date().toISOString(),
      });

    expect(response.status).toBe(404);
  });

  it('403s an interviewer', async () => {
    const target = await givenApplication();
    const response = await request(app)
      .post('/rounds')
      .set(...auth(INTERVIEWER_A))
      .send({ ...target, stage: Stage.SCREEN, scheduledAt: new Date().toISOString() });

    expect(response.status).toBe(403);
  });

  it('400s a stage outside the enum', async () => {
    const target = await givenApplication();
    const response = await request(app)
      .post('/rounds')
      .set(...auth(RECRUITER))
      .send({ ...target, stage: 'COFFEE_CHAT', scheduledAt: new Date().toISOString() });

    expect(response.status).toBe(400);
    expect(response.body.errors[0].path).toBe('body.stage');
  });
});

describe('POST /rounds/:id/assignments', () => {
  it('grants an interviewer access to the round', async () => {
    const { roundId } = await givenRound();

    expect((await request(app).get(`/rounds/${roundId}`).set(...auth(INTERVIEWER_A))).status).toBe(404);

    const assigned = await request(app)
      .post(`/rounds/${roundId}/assignments`)
      .set(...auth(RECRUITER))
      .send({ interviewerId: userIds[INTERVIEWER_A] });
    expect(assigned.status).toBe(204);

    expect((await request(app).get(`/rounds/${roundId}`).set(...auth(INTERVIEWER_A))).status).toBe(200);

    const audit = await prisma.auditEvent.findMany({
      where: { entityId: roundId, action: 'ASSIGNMENT_CREATED' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorId).toBe(userIds[RECRUITER]);
  });

  it('409s a repeat assignment rather than ignoring it', async () => {
    const { roundId } = await givenRound([INTERVIEWER_A]);

    const response = await request(app)
      .post(`/rounds/${roundId}/assignments`)
      .set(...auth(RECRUITER))
      .send({ interviewerId: userIds[INTERVIEWER_A] });

    expect(response.status).toBe(409);
  });

  it('400s an attempt to assign someone who is not an interviewer', async () => {
    const { roundId } = await givenRound();

    const response = await request(app)
      .post(`/rounds/${roundId}/assignments`)
      .set(...auth(RECRUITER))
      .send({ interviewerId: userIds[OTHER_RECRUITER] });

    expect(response.status).toBe(400);
    expect(response.body.errors[0].path).toBe('body.interviewerId');
  });

  it('404s an unknown user and an unknown round', async () => {
    const { roundId } = await givenRound();

    expect(
      (
        await request(app)
          .post(`/rounds/${roundId}/assignments`)
          .set(...auth(RECRUITER))
          .send({ interviewerId: NO_SUCH_UUID })
      ).status,
    ).toBe(404);

    // No pre-check for the round — the FK on RoundAssignment.roundId produces 23503,
    // which the central handler maps to 404 (PLAN.md §7).
    expect(
      (
        await request(app)
          .post(`/rounds/${NO_SUCH_UUID}/assignments`)
          .set(...auth(RECRUITER))
          .send({ interviewerId: userIds[INTERVIEWER_A] })
      ).status,
    ).toBe(404);
  });

  it('403s an interviewer trying to assign themselves', async () => {
    const { roundId } = await givenRound();

    const response = await request(app)
      .post(`/rounds/${roundId}/assignments`)
      .set(...auth(INTERVIEWER_A))
      .send({ interviewerId: userIds[INTERVIEWER_A] });

    expect(response.status).toBe(403);
  });
});

describe('GET /rounds/:id', () => {
  it('gives a recruiter the full candidate record', async () => {
    const { roundId } = await givenRound();
    const response = await request(app).get(`/rounds/${roundId}`).set(...auth(RECRUITER));

    expect(response.status).toBe(200);
    expect(response.body.candidate.email).toContain('@');
    expect(response.body.candidate.phone).toBeTruthy();
  });

  it('gives an assigned interviewer the round with no contact fields', async () => {
    const { roundId } = await givenRound([INTERVIEWER_A]);
    const response = await request(app).get(`/rounds/${roundId}`).set(...auth(INTERVIEWER_A));

    expect(response.status).toBe(200);
    expect(Object.keys(response.body.candidate).sort()).toEqual(['id', 'name']);
    expect(response.text).not.toMatch(/@example\.net/);
    expect(response.text).not.toMatch(/\+\d[\d ]{6,}/);
  });

  it('404s an interviewer who is not assigned', async () => {
    const { roundId } = await givenRound([INTERVIEWER_A]);
    const response = await request(app).get(`/rounds/${roundId}`).set(...auth(INTERVIEWER_B));

    expect(response.status).toBe(404);
  });

  it('403s a hiring manager', async () => {
    const { roundId } = await givenRound();
    expect((await request(app).get(`/rounds/${roundId}`).set(...auth(HIRING_MANAGER))).status).toBe(403);
  });

  it('401s without a token', async () => {
    const { roundId } = await givenRound();
    expect((await request(app).get(`/rounds/${roundId}`)).status).toBe(401);
  });
});

describe('GET /me/rounds', () => {
  it('returns only the caller’s own rounds, without contact fields', async () => {
    const before = await request(app).get('/me/rounds').set(...auth(INTERVIEWER_C));
    expect(before.status).toBe(200);
    expect(before.body).toEqual([]);

    const { roundId } = await givenRound([INTERVIEWER_C]);

    const after = await request(app).get('/me/rounds').set(...auth(INTERVIEWER_C));
    expect(after.body.map((round: { id: string }) => round.id)).toEqual([roundId]);
    expect(Object.keys(after.body[0].candidate).sort()).toEqual(['id', 'name']);
    expect(after.text).not.toMatch(/@example\.net/);
  });

  it('403s a recruiter — the route has no "whose rounds" parameter to widen', async () => {
    expect((await request(app).get('/me/rounds').set(...auth(RECRUITER))).status).toBe(403);
  });
});

/**
 * PLAN.md §5. The rule is a unique index, not a check in application code, so these
 * tests are only meaningful against the real engine — which is what §9 insists on.
 */
describe('POST /rounds/:id/feedback — the concurrency rule', () => {
  const NOTES = 'Solid on system design, thin on testing.';

  it('records feedback from an assigned interviewer', async () => {
    const { roundId } = await givenRound([INTERVIEWER_A]);

    const response = await request(app)
      .post(`/rounds/${roundId}/feedback`)
      .set(...auth(INTERVIEWER_A))
      .send({ rating: 3, notes: NOTES });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ roundId, rating: 3, interviewerId: userIds[INTERVIEWER_A] });

    const audit = await prisma.auditEvent.findMany({
      where: { entityId: roundId, action: 'FEEDBACK_SUBMITTED' },
    });
    expect(audit).toHaveLength(1);
  });

  it('409s a second submission from the same interviewer, and keeps the first', async () => {
    const { roundId } = await givenRound([INTERVIEWER_A]);

    const first = await request(app)
      .post(`/rounds/${roundId}/feedback`)
      .set(...auth(INTERVIEWER_A))
      .send({ rating: 3, notes: NOTES });
    const second = await request(app)
      .post(`/rounds/${roundId}/feedback`)
      .set(...auth(INTERVIEWER_A))
      .send({ rating: 1, notes: 'Changed my mind entirely.' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);

    const rows = await prisma.feedback.findMany({ where: { roundId } });
    expect(rows).toHaveLength(1);
    // Not overwritten — the original rating and notes stand.
    expect(rows[0]).toMatchObject({ rating: 3, notes: NOTES });
  });

  /** PLAN.md §5 case 1: two different interviewers, same round, simultaneously. */
  it('keeps both submissions when two interviewers write at once', async () => {
    const { roundId } = await givenRound([INTERVIEWER_A, INTERVIEWER_B]);

    const responses = await Promise.all([
      request(app)
        .post(`/rounds/${roundId}/feedback`)
        .set(...auth(INTERVIEWER_A))
        .send({ rating: 4, notes: 'Would hire.' }),
      request(app)
        .post(`/rounds/${roundId}/feedback`)
        .set(...auth(INTERVIEWER_B))
        .send({ rating: 2, notes: 'Not for this level.' }),
    ]);

    expect(responses.map((r) => r.status)).toEqual([201, 201]);

    const rows = await prisma.feedback.findMany({ where: { roundId } });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.rating).sort()).toEqual([2, 4]);
  });

  /** PLAN.md §5 case 2: the same interviewer twice, simultaneously. */
  it('yields exactly one 201 and one 409 when one interviewer double-submits at once', async () => {
    const { roundId } = await givenRound([INTERVIEWER_A]);

    const responses = await Promise.all([
      request(app)
        .post(`/rounds/${roundId}/feedback`)
        .set(...auth(INTERVIEWER_A))
        .send({ rating: 4, notes: 'First of two simultaneous writes.' }),
      request(app)
        .post(`/rounds/${roundId}/feedback`)
        .set(...auth(INTERVIEWER_A))
        .send({ rating: 1, notes: 'Second of two simultaneous writes.' }),
    ]);

    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.feedback.count({ where: { roundId } })).toBe(1);
  });

  it('404s an interviewer who is not assigned, and an unknown round', async () => {
    const { roundId } = await givenRound([INTERVIEWER_A]);

    expect(
      (
        await request(app)
          .post(`/rounds/${roundId}/feedback`)
          .set(...auth(INTERVIEWER_B))
          .send({ rating: 3, notes: NOTES })
      ).status,
    ).toBe(404);

    expect(
      (
        await request(app)
          .post(`/rounds/${NO_SUCH_UUID}/feedback`)
          .set(...auth(INTERVIEWER_A))
          .send({ rating: 3, notes: NOTES })
      ).status,
    ).toBe(404);
  });

  it.each([0, 5, -1])('400s a rating of %s before it reaches the database', async (rating) => {
    const { roundId } = await givenRound([INTERVIEWER_A]);

    const response = await request(app)
      .post(`/rounds/${roundId}/feedback`)
      .set(...auth(INTERVIEWER_A))
      .send({ rating, notes: NOTES });

    expect(response.status).toBe(400);
    expect(await prisma.feedback.count({ where: { roundId } })).toBe(0);
  });

  it('refuses an out-of-range rating at the database level too', async () => {
    const { roundId } = await givenRound([INTERVIEWER_A]);

    await expect(
      prisma.feedback.create({
        data: {
          roundId,
          interviewerId: userIds[INTERVIEWER_A] as string,
          rating: 9,
          notes: 'Written straight at the table.',
        },
      }),
    ).rejects.toThrow(/rating_range/);
  });

  it('403s a recruiter — feedback comes from the panel', async () => {
    const { roundId } = await givenRound([INTERVIEWER_A]);

    const response = await request(app)
      .post(`/rounds/${roundId}/feedback`)
      .set(...auth(RECRUITER))
      .send({ rating: 3, notes: NOTES });

    expect(response.status).toBe(403);
  });
});

describe('GET /rounds/:id/feedback', () => {
  async function givenTwoSubmissions() {
    const { roundId } = await givenRound([INTERVIEWER_A, INTERVIEWER_B]);
    for (const [email, rating] of [
      [INTERVIEWER_A, 4],
      [INTERVIEWER_B, 2],
    ] as const) {
      const response = await request(app)
        .post(`/rounds/${roundId}/feedback`)
        .set(...auth(email))
        .send({ rating, notes: `Notes from ${email}.` });
      expect(response.status).toBe(201);
    }
    return roundId;
  }

  it('shows an assigned interviewer the whole panel’s feedback', async () => {
    const roundId = await givenTwoSubmissions();
    const response = await request(app).get(`/rounds/${roundId}/feedback`).set(...auth(INTERVIEWER_A));

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
    expect(response.body[0].interviewer).toHaveProperty('name');
    // The panel are users, not candidates — but the select stays narrow anyway.
    expect(response.body[0].interviewer).not.toHaveProperty('email');
  });

  it('shows a recruiter the same list', async () => {
    const roundId = await givenTwoSubmissions();
    const response = await request(app).get(`/rounds/${roundId}/feedback`).set(...auth(RECRUITER));

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
  });

  it('404s an interviewer who is not assigned to the round', async () => {
    const roundId = await givenTwoSubmissions();
    const response = await request(app).get(`/rounds/${roundId}/feedback`).set(...auth(INTERVIEWER_C));

    expect(response.status).toBe(404);
  });
});

/** PLAN.md §5: the round outcome is derived on read, never a stored mutable field. */
describe('round outcome is derived, not stored', () => {
  it('reports feedbackCount and ratings from the rows that exist', async () => {
    const { roundId } = await givenRound([INTERVIEWER_A, INTERVIEWER_B]);

    const empty = await request(app).get(`/rounds/${roundId}`).set(...auth(RECRUITER));
    expect(empty.body).toMatchObject({ feedbackCount: 0, ratings: [] });

    for (const [email, rating] of [
      [INTERVIEWER_A, 4],
      [INTERVIEWER_B, 2],
    ] as const) {
      await request(app)
        .post(`/rounds/${roundId}/feedback`)
        .set(...auth(email))
        .send({ rating, notes: 'Derived-outcome fixture.' });
    }

    const filled = await request(app).get(`/rounds/${roundId}`).set(...auth(RECRUITER));
    expect(filled.body.feedbackCount).toBe(2);
    expect([...filled.body.ratings].sort()).toEqual([2, 4]);
  });
});
