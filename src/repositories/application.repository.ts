import { Prisma, RoleStatus, Stage, type TransitionKind } from '@prisma/client';
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

// ---------------------------------------------------------------------------
// The recruiter's work queue: which candidates are on which req, and where
// ---------------------------------------------------------------------------

/**
 * `GET /pipeline` answers *how many*, `GET /pipeline/stuck` answers *which ones are
 * late*. Neither answers "show me everyone on this req", which is the list a recruiter
 * works from — so this is that list, and it is the only read in the file.
 *
 * The candidate arrives as `{ id, name }` and nothing else, exactly as it does from
 * `findStuck`. Contact details are one record at a time through `GET /candidates/:id`,
 * where the recruiter-only field set lives (PLAN.md §1) — a list endpoint that carried
 * them would put fifteen email addresses on screen to answer a question about stages,
 * and this endpoint also serves hiring managers, who may not read them at all.
 */
export interface ApplicationListRow {
  applicationId: string;
  candidate: { id: string; name: string };
  roleId: string;
  roleTitle: string;
  roleStatus: RoleStatus;
  currentStage: Stage;
  currentStageEnteredAt: Date;
  /** Rounds scheduled so far — an aggregate, so no round row is read to produce it. */
  roundCount: number;
}

export interface ApplicationListFilter {
  roleId?: string | undefined;
  stage?: Stage | undefined;
  /** `ALL` is the explicit opt-in, matching `GET /roles`. */
  roleStatus: RoleStatus | 'ALL';
  limit: number;
}

const APPLICATION_LIST_SELECT = {
  id: true,
  currentStage: true,
  currentStageEnteredAt: true,
  candidate: { select: { id: true, name: true } },
  role: { select: { id: true, title: true, status: true } },
  _count: { select: { rounds: true } },
} as const;

function listWhere(
  filter: ApplicationListFilter,
  scope: Prisma.RoleWhereInput,
): Prisma.ApplicationWhereInput {
  return {
    ...(filter.stage ? { currentStage: filter.stage } : {}),
    role: {
      ...(filter.roleStatus === 'ALL' ? {} : { status: filter.roleStatus }),
      ...(filter.roleId ? { id: filter.roleId } : {}),
      ...scope,
    },
  };
}

async function listApplications(
  where: Prisma.ApplicationWhereInput,
  limit: number,
): Promise<ApplicationListRow[]> {
  const rows = await prisma.application.findMany({
    where,
    select: APPLICATION_LIST_SELECT,
    /**
     * Longest-waiting first, because that is the order the list is acted on — the same
     * ordering `findStuck` uses, and for the same reason. `(roleId, currentStage,
     * currentStageEnteredAt)` covers the `?roleId=&stage=` path of it.
     */
    orderBy: { currentStageEnteredAt: 'asc' },
    take: limit,
  });

  return rows.map((row) => ({
    applicationId: row.id,
    candidate: row.candidate,
    roleId: row.role.id,
    roleTitle: row.role.title,
    roleStatus: row.role.status,
    currentStage: row.currentStage,
    currentStageEnteredAt: row.currentStageEnteredAt,
    roundCount: row._count.rounds,
  }));
}

/** Recruiters work every req. The role is the authorization (PLAN.md §4). */
export async function listApplicationsForRecruiter(
  _actor: Actor,
  filter: ApplicationListFilter,
): Promise<ApplicationListRow[]> {
  return listApplications(listWhere(filter, {}), filter.limit);
}

/**
 * Ownership as a predicate in the same statement, not a filter over a recruiter's
 * result — so a hiring manager passing another manager's `?roleId=` gets an empty list
 * because the rows were never selected (PLAN.md §1 layer 2).
 */
export async function listApplicationsForHiringManager(
  actor: Actor,
  filter: ApplicationListFilter,
): Promise<ApplicationListRow[]> {
  return listApplications(listWhere(filter, { hiringManagerId: actor.id }), filter.limit);
}
