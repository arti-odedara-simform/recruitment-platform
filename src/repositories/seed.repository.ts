import type { RoleStatus, Stage, UserRole } from '@prisma/client';
import { prisma } from '../db/client.js';
import { normalizeEmail } from './user.repository.js';

/**
 * Write access for the seed script, kept in `src/repositories/**` because that is the
 * only place the lint rule permits the Prisma client (PLAN.md §1).
 *
 * `upsert` rather than `create`: the container entrypoint runs the seed on every boot
 * with `SEED=true`, so it has to be idempotent. A re-run resets a seeded account's
 * password and role back to the documented values, which is what you want from a demo
 * fixture and never what you want from a real user table — hence a separate module
 * whose only caller is `src/seed.ts`.
 */
export async function upsertUser(user: {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  passwordHash: string;
}): Promise<{ id: string }> {
  const email = normalizeEmail(user.email);

  return prisma.user.upsert({
    // Keyed on email, not on the fixture id: a database seeded before the ids became
    // deterministic still has these accounts under generated uuids, and re-seeding
    // should update those rows rather than insert a second Rachel.
    where: { email },
    create: { ...user, email },
    update: { name: user.name, role: user.role, passwordHash: user.passwordHash },
    select: { id: true },
  });
}

/**
 * Everything below writes the PLAN.md §10 demo fixture. Same idempotency contract as
 * `upsertUser`: the entrypoint runs the seed on every boot, so each call is an upsert
 * keyed on a deterministic id (or, for the two composite-unique tables, on the pair).
 *
 * `update` deliberately re-asserts the fixture values rather than leaving existing rows
 * alone. A reviewer who advances a stage by hand and then restarts the stack gets the
 * documented starting position back, which is the only useful behaviour for a demo
 * fixture and, again, exactly why this module is separate from the ones the API uses.
 *
 * One thing is *not* seeded: `StageTransition` and `AuditEvent` rows. The claim PLAN.md
 * §8 makes is that the trace is written inside the mutating transaction — fabricating a
 * history here would make the audit endpoint demo-able while proving nothing about it.
 * The walkthrough produces that history by calling the API.
 */

export async function upsertRole(role: {
  id: string;
  title: string;
  hiringManagerId: string;
  status: RoleStatus;
  openedAt: Date;
}): Promise<{ id: string }> {
  return prisma.role.upsert({
    where: { id: role.id },
    create: role,
    update: {
      title: role.title,
      hiringManagerId: role.hiringManagerId,
      status: role.status,
      openedAt: role.openedAt,
    },
    select: { id: true },
  });
}

export async function upsertCandidate(candidate: {
  id: string;
  name: string;
  email: string;
  phone: string | null;
}): Promise<{ id: string }> {
  return prisma.candidate.upsert({
    where: { id: candidate.id },
    create: candidate,
    update: { name: candidate.name, email: candidate.email, phone: candidate.phone },
    select: { id: true },
  });
}

/**
 * Keyed on the `@@unique([candidateId, roleId])` pair rather than the surrogate id: the
 * pair is what actually identifies an application, and upserting on it means a fixture
 * whose id changed cannot quietly produce a duplicate pipeline row.
 */
export async function upsertApplication(application: {
  id: string;
  candidateId: string;
  roleId: string;
  currentStage: Stage;
  currentStageEnteredAt: Date;
}): Promise<{ id: string }> {
  return prisma.application.upsert({
    where: {
      candidateId_roleId: {
        candidateId: application.candidateId,
        roleId: application.roleId,
      },
    },
    create: application,
    update: {
      currentStage: application.currentStage,
      currentStageEnteredAt: application.currentStageEnteredAt,
    },
    select: { id: true },
  });
}

export async function upsertRound(round: {
  id: string;
  applicationId: string;
  stage: Stage;
  scheduledAt: Date;
}): Promise<{ id: string }> {
  return prisma.interviewRound.upsert({
    where: { id: round.id },
    create: round,
    update: { stage: round.stage, scheduledAt: round.scheduledAt },
    select: { id: true },
  });
}

/**
 * The rows PLAN.md §1 layer 2 scopes every interviewer read against. Keyed on the
 * composite PK, so re-seeding never widens an interviewer's visibility by accident.
 */
export async function upsertAssignment(assignment: {
  roundId: string;
  interviewerId: string;
  assignedById: string;
}): Promise<void> {
  await prisma.roundAssignment.upsert({
    where: {
      roundId_interviewerId: {
        roundId: assignment.roundId,
        interviewerId: assignment.interviewerId,
      },
    },
    create: assignment,
    update: { assignedById: assignment.assignedById },
    select: { roundId: true },
  });
}
