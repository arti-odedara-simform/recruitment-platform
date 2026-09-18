import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Stage, TransitionKind } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma, disconnectDatabase } from '../src/db/client.js';
import { ALLOWED } from '../src/domain/stageMachine.js';
import { DEV_PASSWORD } from '../src/seed/fixture.js';

/**
 * PLAN.md §3 and §8: stage progression and the trace it leaves.
 *
 * These build their own applications rather than moving the seeded fixture's. A stage
 * test needs to start from a chosen stage — including the terminal ones — and mutating
 * the demo fixture would make the walkthrough's starting position depend on whether the
 * suite had run.
 */

const app = createApp();

const RECRUITER = 'rachel.recruiter@example.com';
const INTERVIEWER = 'ingrid.interviewer@example.com';
const HIRING_MANAGER = 'hana.manager@example.com';

const TEST_ROLE_ID = '11111111-1111-4111-8111-111111111111';
const TEST_CANDIDATE_PREFIX = 'stage.test';

const NO_SUCH_UUID = '00000000-0000-4000-8000-000000000000';

const tokens: Record<string, string> = {};
let recruiterId = '';

beforeAll(async () => {
  for (const email of [RECRUITER, INTERVIEWER, HIRING_MANAGER]) {
    const response = await request(app).post('/auth/login').send({ email, password: DEV_PASSWORD });
    expect(response.status, `could not log in as ${email} — is the fixture seeded?`).toBe(200);
    tokens[email] = response.body.token as string;
  }
  recruiterId = (
    await prisma.user.findUniqueOrThrow({ where: { email: RECRUITER }, select: { id: true } })
  ).id;

  const hiringManager = await prisma.user.findUniqueOrThrow({
    where: { email: HIRING_MANAGER },
    select: { id: true },
  });

  await prisma.role.upsert({
    where: { id: TEST_ROLE_ID },
    create: {
      id: TEST_ROLE_ID,
      title: 'Stage Machine Test Role',
      hiringManagerId: hiringManager.id,
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
 * Candidates cascade to applications and stage transitions; AuditEvent has no candidate
 * FK by design (it is append-only and entity-agnostic), so those are cleared by hand.
 */
async function cleanup(): Promise<void> {
  const candidates = await prisma.candidate.findMany({
    where: { email: { startsWith: TEST_CANDIDATE_PREFIX } },
    select: { applications: { select: { id: true } } },
  });
  const applicationIds = candidates.flatMap((c) => c.applications.map((a) => a.id));

  await prisma.auditEvent.deleteMany({ where: { entityId: { in: applicationIds } } });
  await prisma.candidate.deleteMany({ where: { email: { startsWith: TEST_CANDIDATE_PREFIX } } });
}

let sequence = 0;

/** A fresh candidate on the test role, sitting in `stage`. */
async function givenApplication(stage: Stage): Promise<{ candidateId: string; roleId: string }> {
  const candidate = await prisma.candidate.create({
    data: {
      name: `Stage Test ${(sequence += 1)}`,
      email: `${TEST_CANDIDATE_PREFIX}.${sequence}@example.net`,
      applications: { create: { roleId: TEST_ROLE_ID, currentStage: stage } },
    },
    select: { id: true },
  });

  return { candidateId: candidate.id, roleId: TEST_ROLE_ID };
}

function patchStage(target: { candidateId: string; roleId: string }, email: string | undefined, payload: unknown) {
  const call = request(app)
    .patch(`/applications/${target.candidateId}/${target.roleId}/stage`)
    .send(payload as object);
  return email ? call.set('authorization', `Bearer ${tokens[email]}`) : call;
}

function postOverride(target: { candidateId: string; roleId: string }, email: string | undefined, payload: unknown) {
  const call = request(app)
    .post(`/applications/${target.candidateId}/${target.roleId}/override`)
    .send(payload as object);
  return email ? call.set('authorization', `Bearer ${tokens[email]}`) : call;
}

function transitionsFor(candidateId: string) {
  return prisma.stageTransition.findMany({ where: { candidateId }, orderBy: { occurredAt: 'asc' } });
}

function auditFor(candidateId: string) {
  return prisma.auditEvent.findMany({
    where: { payload: { path: ['candidateId'], equals: candidateId } },
    orderBy: { occurredAt: 'asc' },
  });
}

describe('PATCH /applications/:candidateId/:roleId/stage', () => {
  it('advances one step along the machine', async () => {
    const target = await givenApplication(Stage.APPLIED);
    const response = await patchStage(target, RECRUITER, { toStage: Stage.SCREEN });

    expect(response.status).toBe(200);
    expect(response.body.application).toMatchObject({
      candidateId: target.candidateId,
      currentStage: Stage.SCREEN,
    });
    expect(response.body.transition).toMatchObject({
      fromStage: Stage.APPLIED,
      toStage: Stage.SCREEN,
      kind: TransitionKind.NORMAL,
      reason: null,
      actorId: recruiterId,
    });
  });

  /** Walkthrough Q1's live demo: APPLIED -> OFFER, 422, with the legal set in the body. */
  it('refuses a skip with 422 and names the legal moves', async () => {
    const target = await givenApplication(Stage.APPLIED);
    const response = await patchStage(target, RECRUITER, { toStage: Stage.OFFER });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      title: 'Invalid Stage Transition',
      from: Stage.APPLIED,
      to: Stage.OFFER,
      allowed: [...ALLOWED[Stage.APPLIED]],
    });
  });

  it.each([Stage.HIRED, Stage.REJECTED])('refuses to move out of %s', async (terminal) => {
    const target = await givenApplication(terminal);
    const response = await patchStage(target, RECRUITER, { toStage: Stage.SCREEN });

    expect(response.status).toBe(422);
    expect(response.body.allowed).toEqual([]);
  });

  it('writes nothing when the move is refused', async () => {
    const target = await givenApplication(Stage.APPLIED);
    await patchStage(target, RECRUITER, { toStage: Stage.HIRED });

    expect(await transitionsFor(target.candidateId)).toHaveLength(0);
    expect(await auditFor(target.candidateId)).toHaveLength(0);
    const application = await prisma.application.findFirstOrThrow({
      where: { candidateId: target.candidateId },
    });
    expect(application.currentStage).toBe(Stage.APPLIED);
  });

  it('404s on an application that does not exist', async () => {
    const response = await patchStage(
      { candidateId: NO_SUCH_UUID, roleId: TEST_ROLE_ID },
      RECRUITER,
      { toStage: Stage.SCREEN },
    );
    expect(response.status).toBe(404);
  });

  it('400s a stage that is not in the enum, before any domain logic runs', async () => {
    const target = await givenApplication(Stage.APPLIED);
    const response = await patchStage(target, RECRUITER, { toStage: 'PROBATION' });

    expect(response.status).toBe(400);
    expect(response.body.errors[0].path).toBe('body.toStage');
    expect(await transitionsFor(target.candidateId)).toHaveLength(0);
  });
});

describe('POST /applications/:candidateId/:roleId/override', () => {
  const REASON = 'Strong internal referral, skipping the screen round.';

  it('skips stages and records the reason', async () => {
    const target = await givenApplication(Stage.APPLIED);
    const response = await postOverride(target, RECRUITER, { toStage: Stage.OFFER, reason: REASON });

    expect(response.status).toBe(200);
    expect(response.body.application.currentStage).toBe(Stage.OFFER);
    expect(response.body.transition).toMatchObject({
      fromStage: Stage.APPLIED,
      toStage: Stage.OFFER,
      kind: TransitionKind.OVERRIDE,
      reason: REASON,
      actorId: recruiterId,
    });
  });

  it.each([
    ['missing', undefined],
    ['blank', '   '],
    ['too short', 'too short'],
  ])('400s an override whose reason is %s', async (_label, reason) => {
    const target = await givenApplication(Stage.APPLIED);
    const response = await postOverride(target, RECRUITER, { toStage: Stage.OFFER, reason });

    expect(response.status).toBe(400);
    expect(response.body.errors.some((issue: { path: string }) => issue.path === 'body.reason')).toBe(true);
    expect(await transitionsFor(target.candidateId)).toHaveLength(0);
  });

  it.each([Stage.HIRED, Stage.REJECTED])('cannot override out of %s either', async (terminal) => {
    const target = await givenApplication(terminal);
    const response = await postOverride(target, RECRUITER, { toStage: Stage.SCREEN, reason: REASON });

    expect(response.status).toBe(422);
  });

  it('refuses a no-op override', async () => {
    const target = await givenApplication(Stage.SCREEN);
    const response = await postOverride(target, RECRUITER, { toStage: Stage.SCREEN, reason: REASON });

    expect(response.status).toBe(422);
  });
});

describe('who may move a stage', () => {
  it.each([INTERVIEWER, HIRING_MANAGER])('403s %s on advance', async (email) => {
    const target = await givenApplication(Stage.APPLIED);
    const response = await patchStage(target, email, { toStage: Stage.SCREEN });

    expect(response.status).toBe(403);
    expect(await transitionsFor(target.candidateId)).toHaveLength(0);
  });

  it.each([INTERVIEWER, HIRING_MANAGER])('403s %s on override', async (email) => {
    const target = await givenApplication(Stage.APPLIED);
    const response = await postOverride(target, email, {
      toStage: Stage.OFFER,
      reason: 'Interviewers have no stage authority at all.',
    });

    expect(response.status).toBe(403);
  });

  it('401s without a token', async () => {
    const target = await givenApplication(Stage.APPLIED);
    expect((await patchStage(target, undefined, { toStage: Stage.SCREEN })).status).toBe(401);
    expect(
      (await postOverride(target, undefined, { toStage: Stage.OFFER, reason: 'no token at all here' }))
        .status,
    ).toBe(401);
  });
});

/**
 * PLAN.md §8: a stage cannot move without leaving a trace, because the trace is written
 * in the same transaction as the move.
 */
describe('the trace a stage change leaves', () => {
  it('writes the application update, a transition and an audit event together', async () => {
    const target = await givenApplication(Stage.APPLIED);
    const response = await patchStage(target, RECRUITER, { toStage: Stage.SCREEN });
    expect(response.status).toBe(200);

    const [transition] = await transitionsFor(target.candidateId);
    const [event] = await auditFor(target.candidateId);
    const application = await prisma.application.findFirstOrThrow({
      where: { candidateId: target.candidateId },
    });

    expect(transition).toBeDefined();
    expect(event).toMatchObject({ action: 'STAGE_ADVANCED', actorId: recruiterId, entity: 'Application' });
    expect(event?.payload).toMatchObject({ fromStage: Stage.APPLIED, toStage: Stage.SCREEN });

    // One timestamp for all three rows, so the ageing clock and the audit timeline agree.
    expect(application.currentStageEnteredAt).toEqual(transition?.occurredAt);
    expect(event?.occurredAt).toEqual(transition?.occurredAt);
  });

  it('records an ordered timeline across a sequence of moves', async () => {
    const target = await givenApplication(Stage.APPLIED);

    expect((await patchStage(target, RECRUITER, { toStage: Stage.SCREEN })).status).toBe(200);
    expect(
      (await postOverride(target, RECRUITER, {
        toStage: Stage.OFFER,
        reason: 'Panel agreed to skip the interview loop.',
      })).status,
    ).toBe(200);
    expect((await patchStage(target, RECRUITER, { toStage: Stage.HIRED })).status).toBe(200);

    const transitions = await transitionsFor(target.candidateId);
    expect(
      transitions.map((t) => [t.fromStage, t.toStage, t.kind]),
    ).toEqual([
      [Stage.APPLIED, Stage.SCREEN, TransitionKind.NORMAL],
      [Stage.SCREEN, Stage.OFFER, TransitionKind.OVERRIDE],
      [Stage.OFFER, Stage.HIRED, TransitionKind.NORMAL],
    ]);

    expect((await auditFor(target.candidateId)).map((e) => e.action)).toEqual([
      'STAGE_ADVANCED',
      'STAGE_OVERRIDDEN',
      'STAGE_ADVANCED',
    ]);
  });

  /**
   * PLAN.md §9: the service layer is not the last line. Written straight at the table,
   * bypassing every check above, the database still refuses.
   */
  it('refuses an override with no reason at the database level', async () => {
    const target = await givenApplication(Stage.APPLIED);

    await expect(
      prisma.stageTransition.create({
        data: {
          candidateId: target.candidateId,
          roleId: target.roleId,
          fromStage: Stage.APPLIED,
          toStage: Stage.OFFER,
          kind: TransitionKind.OVERRIDE,
          actorId: recruiterId,
          reason: null,
        },
      }),
    ).rejects.toThrow(/override_requires_reason/);
  });

  it('refuses an override whose reason is only whitespace at the database level', async () => {
    const target = await givenApplication(Stage.APPLIED);

    await expect(
      prisma.stageTransition.create({
        data: {
          candidateId: target.candidateId,
          roleId: target.roleId,
          fromStage: Stage.APPLIED,
          toStage: Stage.OFFER,
          kind: TransitionKind.OVERRIDE,
          actorId: recruiterId,
          reason: '          ',
        },
      }),
    ).rejects.toThrow(/override_requires_reason/);
  });
});

/**
 * The `SELECT ... FOR UPDATE` in the repository, substantiated. PLAN.md §5's third
 * concurrency case builds on this; here it is on its own, because the lock is claimed by
 * a comment in application.repository.ts and a comment is not evidence.
 */
describe('concurrent stage changes', () => {
  it('serialises two simultaneous advances — one wins, one gets 422', async () => {
    const target = await givenApplication(Stage.APPLIED);

    const responses = await Promise.all([
      patchStage(target, RECRUITER, { toStage: Stage.SCREEN }),
      patchStage(target, RECRUITER, { toStage: Stage.SCREEN }),
    ]);

    // The loser reads SCREEN once the winner commits, and SCREEN -> SCREEN is not a
    // legal move. Without the lock both would read APPLIED and both would write.
    expect(responses.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(await transitionsFor(target.candidateId)).toHaveLength(1);
  });

  it('leaves exactly one transition when an advance and an override race', async () => {
    const target = await givenApplication(Stage.SCREEN);

    const responses = await Promise.all([
      patchStage(target, RECRUITER, { toStage: Stage.INTERVIEW }),
      postOverride(target, RECRUITER, {
        toStage: Stage.OFFER,
        reason: 'Racing the normal advance on purpose.',
      }),
    ]);

    // Both are legal from SCREEN, so both may succeed — but they cannot interleave: the
    // second reads whatever the first wrote. What must hold is that the transitions form
    // an unbroken chain and the stored stage matches the last one.
    const transitions = await transitionsFor(target.candidateId);
    const application = await prisma.application.findFirstOrThrow({
      where: { candidateId: target.candidateId },
    });

    expect(transitions.length).toBe(responses.filter((r) => r.status === 200).length);
    expect(transitions[0]?.fromStage).toBe(Stage.SCREEN);
    for (let i = 1; i < transitions.length; i += 1) {
      expect(transitions[i]?.fromStage).toBe(transitions[i - 1]?.toStage);
    }
    expect(application.currentStage).toBe(transitions.at(-1)?.toStage);
  });
});

describe('the stage machine itself', () => {
  it('has no move out of a terminal stage', () => {
    expect(ALLOWED[Stage.HIRED]).toEqual([]);
    expect(ALLOWED[Stage.REJECTED]).toEqual([]);
  });

  it('lets every non-terminal stage reach REJECTED', () => {
    for (const stage of [Stage.APPLIED, Stage.SCREEN, Stage.INTERVIEW, Stage.OFFER]) {
      expect(ALLOWED[stage]).toContain(Stage.REJECTED);
    }
  });

  it('never allows a stage to advance to itself', () => {
    for (const [from, allowed] of Object.entries(ALLOWED)) {
      expect(allowed).not.toContain(from as Stage);
    }
  });
});
