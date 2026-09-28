import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { RoleStatus, Stage, TransitionKind, UserRole } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma, disconnectDatabase } from '../src/db/client.js';
import { hashPassword } from '../src/auth/password.js';
import { DEV_PASSWORD, USER_IDS } from '../src/seed/fixture.js';

/**
 * PLAN.md §8 — the structured trace, and the brief's *"a candidate disputes how they
 * were assessed"*.
 *
 * One candidate is driven through the whole lifecycle **through the API**, in order, and
 * then the timeline is asserted against what actually happened. Building the rows
 * directly would test the reader and not the writers; the point of §8 is that every
 * mutating service writes its own audit row inside its own transaction.
 */

const app = createApp();

const RECRUITER = 'rachel.recruiter@example.com';
const HIRING_MANAGER = 'hana.manager@example.com';
const INTERVIEWER = 'ingrid.interviewer@example.com';

/** Owns nothing this file creates, so their scope has something to exclude. */
const OTHER_MANAGER = 'audit.test.manager@example.com';
const OTHER_MANAGER_PASSWORD = 'audit-test-password';

const TEST_ROLE_ID = '55555555-5555-4555-8555-555555555555';
const TEST_CANDIDATE_PREFIX = 'audit.test';
const NO_SUCH_UUID = '00000000-0000-4000-8000-000000000000';

const tokens: Record<string, string> = {};
const userIds: Record<string, string> = {};

interface TimelineEntry {
  type: 'STAGE_TRANSITION' | 'AUDIT_EVENT';
  id: string;
  occurredAt: string;
  action?: string;
  kind?: TransitionKind;
  fromStage?: Stage;
  toStage?: Stage;
  reason?: string | null;
  payload?: unknown;
  actor: { id: string; name: string; role: UserRole };
}

interface AuditBody {
  candidate: { id: string; name: string };
  applications: Array<{ applicationId: string; roleId: string; roleTitle: string; currentStage: Stage }>;
  timeline: TimelineEntry[];
}

/** The lifecycle, driven once in beforeAll and asserted from many angles below. */
let candidateId = '';

beforeAll(async () => {
  for (const email of [RECRUITER, HIRING_MANAGER, INTERVIEWER]) {
    const response = await request(app).post('/auth/login').send({ email, password: DEV_PASSWORD });
    expect(response.status, `could not log in as ${email} — is the fixture seeded?`).toBe(200);
    tokens[email] = response.body.token as string;
    userIds[email] = response.body.user.id as string;
  }

  await prisma.user.upsert({
    where: { email: OTHER_MANAGER },
    create: {
      email: OTHER_MANAGER,
      name: 'Audit Test Manager',
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
    where: { id: TEST_ROLE_ID },
    create: {
      id: TEST_ROLE_ID,
      title: 'Audit Test Req',
      hiringManagerId: USER_IDS.hana,
      status: RoleStatus.OPEN,
    },
    update: {},
  });

  const candidate = await prisma.candidate.create({
    data: {
      name: 'Audit Test Candidate',
      email: `${TEST_CANDIDATE_PREFIX}.1@example.net`,
      phone: '+44 20 7946 0777',
    },
    select: { id: true },
  });
  candidateId = candidate.id;

  // 1. onto the req, 2. advance, 3. round, 4. assignment, 5. feedback, 6. override.
  expect(
    (await recruiter(request(app).post('/applications')).send({ candidateId, roleId: TEST_ROLE_ID }))
      .status,
  ).toBe(201);

  expect(
    (
      await recruiter(
        request(app).patch(`/applications/${candidateId}/${TEST_ROLE_ID}/stage`),
      ).send({ toStage: Stage.SCREEN })
    ).status,
  ).toBe(200);

  const round = await recruiter(request(app).post('/rounds')).send({
    candidateId,
    roleId: TEST_ROLE_ID,
    stage: Stage.SCREEN,
    scheduledAt: new Date().toISOString(),
  });
  expect(round.status).toBe(201);

  expect(
    (
      await recruiter(request(app).post(`/rounds/${round.body.id}/assignments`)).send({
        interviewerId: userIds[INTERVIEWER],
      })
    ).status,
  ).toBe(204);

  expect(
    (
      await request(app)
        .post(`/rounds/${round.body.id}/feedback`)
        .set('authorization', `Bearer ${tokens[INTERVIEWER]}`)
        .send({ rating: 4, notes: 'Strong screen; recommending an onsite.' })
    ).status,
  ).toBe(201);

  expect(
    (
      await recruiter(
        request(app).post(`/applications/${candidateId}/${TEST_ROLE_ID}/override`),
      ).send({ toStage: Stage.OFFER, reason: 'Panel and manager aligned; skipping the onsite.' })
    ).status,
  ).toBe(200);
});

afterAll(async () => {
  const applications = await prisma.application.findMany({
    where: { candidate: { email: { startsWith: TEST_CANDIDATE_PREFIX } } },
    select: { id: true, rounds: { select: { id: true } } },
  });
  const roundIds = applications.flatMap((application) => application.rounds.map((r) => r.id));

  await prisma.feedback.deleteMany({ where: { roundId: { in: roundIds } } });
  await prisma.auditEvent.deleteMany({
    where: { entityId: { in: [...applications.map((a) => a.id), ...roundIds, TEST_ROLE_ID] } },
  });
  await prisma.candidate.deleteMany({ where: { email: { startsWith: TEST_CANDIDATE_PREFIX } } });
  await prisma.role.deleteMany({ where: { id: TEST_ROLE_ID } });
  await prisma.user.deleteMany({ where: { email: OTHER_MANAGER } });
  await disconnectDatabase();
});

function recruiter<T extends { set: (field: string, value: string) => T }>(call: T): T {
  return call.set('authorization', `Bearer ${tokens[RECRUITER]}`);
}

function get(email: string | undefined, id = candidateId) {
  const call = request(app).get(`/audit/candidates/${id}`);
  return email ? call.set('authorization', `Bearer ${tokens[email]}`) : call;
}

describe('GET /audit/candidates/:id', () => {
  it('reconstructs the whole lifecycle, oldest first', async () => {
    const response = await get(RECRUITER);

    expect(response.status).toBe(200);
    const body: AuditBody = response.body;

    expect(body.candidate).toEqual({ id: candidateId, name: 'Audit Test Candidate' });
    expect(body.applications).toEqual([
      expect.objectContaining({
        roleId: TEST_ROLE_ID,
        roleTitle: 'Audit Test Req',
        currentStage: Stage.OFFER,
      }),
    ]);

    /**
     * Two tables, one order. The transitions are interleaved with the events that
     * accompanied them, not appended after — and each stage change reads as the
     * transition followed by the note taken about it, because both rows carry the same
     * `occurredAt` and the sort breaks that tie on kind.
     */
    expect(body.timeline.map(label)).toEqual([
      'AUDIT_EVENT:APPLICATION_CREATED',
      'STAGE_TRANSITION:APPLIED->SCREEN',
      'AUDIT_EVENT:STAGE_ADVANCED',
      'AUDIT_EVENT:ROUND_CREATED',
      'AUDIT_EVENT:ASSIGNMENT_CREATED',
      'AUDIT_EVENT:FEEDBACK_SUBMITTED',
      'STAGE_TRANSITION:SCREEN->OFFER',
      'AUDIT_EVENT:STAGE_OVERRIDDEN',
    ]);

    const times = body.timeline.map((entry) => Date.parse(entry.occurredAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  /** Walkthrough Q2: what an override records, and who did it. */
  it('carries the override’s reason, actor and kind', async () => {
    const body: AuditBody = (await get(RECRUITER)).body;
    const override = body.timeline.find((entry) => entry.kind === TransitionKind.OVERRIDE);

    expect(override).toMatchObject({
      type: 'STAGE_TRANSITION',
      fromStage: Stage.SCREEN,
      toStage: Stage.OFFER,
      reason: 'Panel and manager aligned; skipping the onsite.',
      actor: { id: userIds[RECRUITER], name: 'Rachel Ahmed', role: UserRole.RECRUITER },
    });
  });

  it('names the interviewer on the feedback event, not the recruiter', async () => {
    const body: AuditBody = (await get(RECRUITER)).body;
    const feedback = body.timeline.find((entry) => entry.action === 'FEEDBACK_SUBMITTED');

    expect(feedback?.actor).toMatchObject({
      id: userIds[INTERVIEWER],
      role: UserRole.INTERVIEWER,
    });
  });

  /**
   * The audit view selects `id` and `name` — a timeline has no use for contact details,
   * and a hiring manager may not have them at all (PLAN.md §4).
   */
  it('leaks no contact details, to either reader', async () => {
    for (const email of [RECRUITER, HIRING_MANAGER]) {
      const response = await get(email);

      expect(response.status, `as ${email}`).toBe(200);
      expect(response.text).not.toMatch(/@example\.net/);
      expect(response.text).not.toMatch(/\+\d[\d ]{6,}/);
    }
  });

  /**
   * A hiring manager is refused feedback by `GET /rounds/:id/feedback`; collecting the
   * rating out of an audit payload instead would be the same read by another door. The
   * field set differs, so the column is never selected.
   */
  it('withholds event payloads from a hiring manager and keeps the events', async () => {
    const recruiterBody: AuditBody = (await get(RECRUITER)).body;
    const managerBody: AuditBody = (await get(HIRING_MANAGER)).body;

    expect(recruiterBody.timeline.map(label)).toEqual(managerBody.timeline.map(label));

    const recruiterFeedback = recruiterBody.timeline.find((e) => e.action === 'FEEDBACK_SUBMITTED');
    const managerFeedback = managerBody.timeline.find((e) => e.action === 'FEEDBACK_SUBMITTED');

    expect(recruiterFeedback?.payload).toMatchObject({ rating: 4 });
    expect(managerFeedback).toBeDefined();
    expect(managerFeedback).not.toHaveProperty('payload');
    expect(JSON.stringify(managerBody)).not.toContain('"rating"');
  });

  it('404s a candidate on nobody’s req for a hiring manager who owns none of them', async () => {
    const response = await get(OTHER_MANAGER);

    expect(response.status).toBe(404);
    // Indistinguishable from a candidate who does not exist (PLAN.md §4).
    expect(response.body).toEqual((await get(OTHER_MANAGER, NO_SUCH_UUID)).body);
  });

  it('404s an unknown candidate for a recruiter too', async () => {
    expect((await get(RECRUITER, NO_SUCH_UUID)).status).toBe(404);
  });

  it('403s an interviewer', async () => {
    const response = await get(INTERVIEWER);

    expect(response.status).toBe(403);
    expect(response.body.title).toBe('Forbidden');
  });

  it('401s without a token, and 400s a malformed id', async () => {
    expect((await get(undefined)).status).toBe(401);
    expect((await get(RECRUITER, 'not-a-uuid')).status).toBe(400);
  });
});

function label(entry: TimelineEntry): string {
  return entry.type === 'AUDIT_EVENT'
    ? `AUDIT_EVENT:${entry.action}`
    : `STAGE_TRANSITION:${entry.fromStage}->${entry.toStage}`;
}
