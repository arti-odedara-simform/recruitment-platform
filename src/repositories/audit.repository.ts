import type { Prisma, Stage, TransitionKind, UserRole } from '@prisma/client';
import { prisma } from '../db/client.js';
import type { Actor } from '../domain/actor.js';

/**
 * The structured trace PLAN.md §8 exists for: *"a candidate disputes how they were
 * assessed"*. Two append-only tables, merged into one timeline.
 *
 * `StageTransition` records where an application moved and why; `AuditEvent` records
 * everything else — the req opening, the application being created, rounds, assignments,
 * feedback. Both are written inside the transaction that made the change, so this is a
 * reconstruction of what happened rather than a log that may or may not have been
 * flushed.
 *
 * Two field sets, the §1 discipline applied to a column rather than a row:
 * `AUDIT_SELECT.recruiter` names `payload`, `AUDIT_SELECT.hiringManager` does not. A
 * `FEEDBACK_SUBMITTED` payload carries the rating, and a hiring manager who is refused
 * feedback by `GET /rounds/:id/feedback` should not collect it here instead. They still
 * see the event — who submitted, for which round, when — which is what an audit trail is
 * for.
 */

const ACTOR_SELECT = { select: { id: true, name: true, role: true } } as const;

const AUDIT_BASE = {
  id: true,
  action: true,
  entity: true,
  entityId: true,
  occurredAt: true,
  actor: ACTOR_SELECT,
} as const;

export const AUDIT_SELECT = {
  recruiter: { ...AUDIT_BASE, payload: true },
  /** No `payload`. See the note above before adding it. */
  hiringManager: AUDIT_BASE,
} as const;

export interface TimelineActor {
  id: string;
  name: string;
  role: UserRole;
}

export interface TransitionEntry {
  type: 'STAGE_TRANSITION';
  id: string;
  occurredAt: Date;
  roleId: string;
  fromStage: Stage;
  toStage: Stage;
  kind: TransitionKind;
  reason: string | null;
  actor: TimelineActor;
}

export interface EventEntry {
  type: 'AUDIT_EVENT';
  id: string;
  occurredAt: Date;
  action: string;
  entity: string;
  entityId: string;
  /** Absent for hiring managers, by field set rather than by deletion. */
  payload?: Prisma.JsonValue;
  actor: TimelineActor;
}

export type TimelineEntry = TransitionEntry | EventEntry;

export interface CandidateAudit {
  candidate: { id: string; name: string };
  applications: Array<{
    applicationId: string;
    roleId: string;
    roleTitle: string;
    currentStage: Stage;
    createdAt: Date;
  }>;
  timeline: TimelineEntry[];
}

/**
 * The candidate, their applications and the round ids hanging off them — one query, and
 * the *only* place the scope is decided.
 *
 * Note the field set: `id` and `name`, no contact details. An audit timeline does not
 * need them, a hiring manager may not have them at all (PLAN.md §4), and a read that
 * does not select a column cannot leak it.
 *
 * `where` is the argument, not a flag: a recruiter passes `{}` and a hiring manager
 * passes a predicate tying the candidate to a req they own, so an unrelated candidate
 * comes back as zero rows and the service 404s — the same shape as
 * `findCandidateForInterviewer`.
 */
async function findCandidateWithApplications(candidateId: string, scope: AuditScope) {
  return prisma.candidate.findFirst({
    where: { id: candidateId, ...scope.candidate },
    select: {
      id: true,
      name: true,
      applications: {
        where: scope.applications,
        select: {
          id: true,
          roleId: true,
          currentStage: true,
          createdAt: true,
          role: { select: { title: true } },
          rounds: { select: { id: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
}

/**
 * A hiring manager sees the trail of a candidate on one of *their* reqs, and only the
 * applications on those reqs. A recruiter sees everything.
 *
 * Both halves are needed and they are not the same predicate: the first decides whether
 * the candidate is visible at all, the second decides which of their applications are.
 * Without the second, a hiring manager who owns one of a candidate's three reqs would
 * read the timeline of all three.
 */
interface AuditScope {
  candidate: Prisma.CandidateWhereInput;
  applications: Prisma.ApplicationWhereInput;
}

function scopeFor(actor: Actor, role: AuditRole): AuditScope {
  if (role === 'RECRUITER') {
    return { candidate: {}, applications: {} };
  }

  const ownedByActor = { role: { hiringManagerId: actor.id } };
  return { candidate: { applications: { some: ownedByActor } }, applications: ownedByActor };
}

/** Which field set to read with. The two roles PLAN.md §8 puts on this endpoint. */
export type AuditRole = 'RECRUITER' | 'HIRING_MANAGER';

export async function findCandidateAudit(
  actor: Actor,
  candidateId: string,
  role: AuditRole,
): Promise<CandidateAudit | null> {
  const scope = scopeFor(actor, role);
  const candidate = await findCandidateWithApplications(candidateId, scope);

  if (!candidate) {
    return null;
  }

  const applicationIds = candidate.applications.map((application) => application.id);
  const roleIds = candidate.applications.map((application) => application.roleId);
  const roundIds = candidate.applications.flatMap((application) =>
    application.rounds.map((round) => round.id),
  );

  /**
   * `AuditEvent` is keyed by (entity, entityId) rather than by candidate — that is what
   * makes it able to record things a candidate is not party to — so a candidate's events
   * are reached through the ids of their applications and rounds. Both lists are already
   * in hand from the query above, and `entityId IN (...)` rides the
   * `(entity, entityId, occurredAt)` index.
   *
   * The two reads run in parallel: they are independent, and neither is a write.
   */
  const entityIds = [...applicationIds, ...roundIds];

  const [transitions, events] = await Promise.all([
    prisma.stageTransition.findMany({
      where: { candidateId, roleId: { in: roleIds } },
      select: {
        id: true,
        roleId: true,
        fromStage: true,
        toStage: true,
        kind: true,
        reason: true,
        occurredAt: true,
        actor: ACTOR_SELECT,
      },
      orderBy: { occurredAt: 'asc' },
    }),
    role === 'RECRUITER'
      ? prisma.auditEvent.findMany({
          where: { entityId: { in: entityIds } },
          select: AUDIT_SELECT.recruiter,
          orderBy: { occurredAt: 'asc' },
        })
      : prisma.auditEvent.findMany({
          where: { entityId: { in: entityIds } },
          select: AUDIT_SELECT.hiringManager,
          orderBy: { occurredAt: 'asc' },
        }),
  ]);

  const timeline: TimelineEntry[] = [
    ...transitions.map((row): TransitionEntry => ({ type: 'STAGE_TRANSITION', ...row })),
    ...events.map((row): EventEntry => ({ type: 'AUDIT_EVENT', ...row })),
  ].sort(sortByTime);

  return {
    candidate: { id: candidate.id, name: candidate.name },
    applications: candidate.applications.map((application) => ({
      applicationId: application.id,
      roleId: application.roleId,
      roleTitle: application.role.title,
      currentStage: application.currentStage,
      createdAt: application.createdAt,
    })),
    timeline,
  };
}

/**
 * A stage change writes its `StageTransition` and its `AuditEvent` with the same
 * `occurredAt` — deliberately, so the ageing clock and the trail agree to the
 * millisecond. Ties are therefore the normal case, not a hypothetical, and sorting on
 * time alone would leave the pair in whatever order the two queries happened to return.
 *
 * So the tie breaks on kind first: the transition is the thing that happened, the event
 * is the note taken about it, and a reader scanning the timeline wants them in that
 * order every time. Ids break the remainder, which makes the ordering total — two calls
 * cannot disagree about it, and neither can two readers of the same dispute.
 */
const KIND_ORDER: Record<TimelineEntry['type'], number> = {
  STAGE_TRANSITION: 0,
  AUDIT_EVENT: 1,
};

function sortByTime(left: TimelineEntry, right: TimelineEntry): number {
  return (
    left.occurredAt.getTime() - right.occurredAt.getTime() ||
    KIND_ORDER[left.type] - KIND_ORDER[right.type] ||
    left.id.localeCompare(right.id)
  );
}
