import { RoleStatus, Stage, type TransitionKind } from '@prisma/client';
import { prisma } from '../db/client.js';
import { NotFoundError } from '../errors/AppError.js';
import type { Actor } from '../domain/actor.js';

/**
 * The only writer of `Application.currentStage` in the codebase (PLAN.md §3).
 *
 * Three writes, one transaction: the `Application` update, a `StageTransition` row and an
 * `AuditEvent`. A stage cannot move without leaving a trace, because the trace is not a
 * follow-up call that some future code path might forget — if the audit write fails, the
 * stage change rolls back with it (PLAN.md §8).
 */

export interface ApplicationStageView {
  applicationId: string;
  candidateId: string;
  roleId: string;
  currentStage: Stage;
  currentStageEnteredAt: Date;
}

export interface StageTransitionRecord {
  id: string;
  fromStage: Stage;
  toStage: Stage;
  kind: TransitionKind;
  reason: string | null;
  actorId: string;
  occurredAt: Date;
}

export interface StageTransitionResult {
  application: ApplicationStageView;
  transition: StageTransitionRecord;
}

export interface StageTransitionInput {
  actor: Actor;
  candidateId: string;
  roleId: string;
  toStage: Stage;
  kind: TransitionKind;
  reason: string | null;
  /** The `AuditEvent.action` for this move — STAGE_ADVANCED or STAGE_OVERRIDDEN. */
  action: string;
  /**
   * The domain check, run *inside* the transaction with the row locked. It has to happen
   * here rather than in the service: the legality of a move depends on `fromStage`, and
   * a `fromStage` read before the lock is a value that another transaction may already
   * have changed. Throwing aborts the transaction and nothing is written.
   */
  assertLegal: (fromStage: Stage) => void;
}

export async function runStageTransition(input: StageTransitionInput): Promise<StageTransitionResult> {
  return prisma.$transaction(async (tx) => {
    /**
     * `SELECT ... FOR UPDATE` (PLAN.md §3). Prisma has no first-class row lock, so this
     * is raw — and it is the point of the transaction, not an optimisation: two
     * recruiters transitioning the same application concurrently serialise here, so the
     * second one reads the stage the first one wrote and its `assertLegal` sees reality.
     * Without it, both would read `SCREEN` and both would write, producing two
     * StageTransition rows claiming the same `fromStage`.
     */
    const locked = await tx.$queryRaw<Array<{ id: string; currentStage: Stage }>>`
      SELECT "id", "currentStage"
      FROM "Application"
      WHERE "candidateId" = ${input.candidateId} AND "roleId" = ${input.roleId}
      FOR UPDATE
    `;

    const row = locked[0];
    if (!row) {
      throw new NotFoundError('No such application.');
    }

    const fromStage = row.currentStage;
    input.assertLegal(fromStage);

    // One timestamp for all three rows, so the ageing clock in `currentStageEnteredAt`
    // and the audit timeline agree to the millisecond.
    const occurredAt = new Date();

    const application = await tx.application.update({
      where: { id: row.id },
      data: { currentStage: input.toStage, currentStageEnteredAt: occurredAt },
      select: {
        id: true,
        candidateId: true,
        roleId: true,
        currentStage: true,
        currentStageEnteredAt: true,
      },
    });

    const transition = await tx.stageTransition.create({
      data: {
        candidateId: input.candidateId,
        roleId: input.roleId,
        fromStage,
        toStage: input.toStage,
        kind: input.kind,
        actorId: input.actor.id,
        reason: input.reason,
        occurredAt,
      },
      select: {
        id: true,
        fromStage: true,
        toStage: true,
        kind: true,
        reason: true,
        actorId: true,
        occurredAt: true,
      },
    });

    await tx.auditEvent.create({
      data: {
        actorId: input.actor.id,
        action: input.action,
        entity: 'Application',
        entityId: row.id,
        payload: {
          candidateId: input.candidateId,
          roleId: input.roleId,
          fromStage,
          toStage: input.toStage,
          kind: input.kind,
          reason: input.reason,
          transitionId: transition.id,
        },
        occurredAt,
      },
      select: { id: true },
    });

    return {
      application: {
        applicationId: application.id,
        candidateId: application.candidateId,
        roleId: application.roleId,
        currentStage: application.currentStage,
        currentStageEnteredAt: application.currentStageEnteredAt,
      },
      transition,
    };
  });
}

/**
 * Puts a candidate onto a req. The pipeline unit comes into existence here, at APPLIED —
 * every later stage is the stage machine's business (PLAN.md §3).
 *
 * Three failure modes, and only one of them is checked in application code:
 *
 * - **No such req** — read inside the transaction, so the status check below cannot race
 *   a req being deleted between the two statements.
 * - **The req is CLOSED** — a domain rule, and the only one that needs a read.
 * - **No such candidate**, or **this candidate is already on this req** — neither is
 *   checked. The FK and the `@@unique([candidateId, roleId])` index answer both, and the
 *   central error mapping turns `23503` into 404 and `23505` into 409. A read-then-write
 *   version would be longer and would have a window where two simultaneous requests both
 *   see "not applied yet" (PLAN.md §5, §7).
 */
export type CreateApplicationResult =
  | { outcome: 'CREATED'; application: ApplicationStageView }
  | { outcome: 'NO_SUCH_ROLE' }
  | { outcome: 'ROLE_CLOSED'; title: string };

export async function createApplication(
  actor: Actor,
  input: { candidateId: string; roleId: string },
): Promise<CreateApplicationResult> {
  return prisma.$transaction(async (tx) => {
    const role = await tx.role.findUnique({
      where: { id: input.roleId },
      select: { id: true, title: true, status: true },
    });

    if (!role) {
      return { outcome: 'NO_SUCH_ROLE' };
    }

    if (role.status === RoleStatus.CLOSED) {
      return { outcome: 'ROLE_CLOSED', title: role.title };
    }

    const application = await tx.application.create({
      data: {
        candidateId: input.candidateId,
        roleId: input.roleId,
        currentStage: Stage.APPLIED,
      },
      select: {
        id: true,
        candidateId: true,
        roleId: true,
        currentStage: true,
        currentStageEnteredAt: true,
      },
    });

    /**
     * No `StageTransition` row: there is no stage it moved *from*. The creation is the
     * audit record, and `GET /audit/candidates/:id` merges it into the same timeline as
     * the transitions that follow it.
     */
    await tx.auditEvent.create({
      data: {
        actorId: actor.id,
        action: 'APPLICATION_CREATED',
        entity: 'Application',
        entityId: application.id,
        payload: {
          candidateId: input.candidateId,
          roleId: input.roleId,
          currentStage: application.currentStage,
        },
      },
      select: { id: true },
    });

    return {
      outcome: 'CREATED',
      application: {
        applicationId: application.id,
        candidateId: application.candidateId,
        roleId: application.roleId,
        currentStage: application.currentStage,
        currentStageEnteredAt: application.currentStageEnteredAt,
      },
    };
  });
}
