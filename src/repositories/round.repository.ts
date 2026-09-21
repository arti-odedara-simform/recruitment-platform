import type { Stage } from '@prisma/client';
import { prisma } from '../db/client.js';
import type { Actor } from '../domain/actor.js';
import { CANDIDATE_SELECT } from './candidate.repository.js';

/**
 * Rounds and assignments, under the same discipline as candidate.repository.ts
 * (PLAN.md §1): two hard-coded field sets, and the interviewer's scope lives in the
 * `where` rather than in an `if` after the fetch.
 *
 * A round carries its candidate, so the restricted columns are reachable from here too —
 * which is exactly why the nested selects below *reuse* `CANDIDATE_SELECT` instead of
 * listing candidate fields again. There is one definition of "what a recruiter may see
 * of a candidate" and one of "what an interviewer may see", and a round view cannot
 * quietly disagree with a candidate view.
 */

/** Feedback ratings are selected, never a stored rollup — see PLAN.md §5 and `toView`. */
const ROUND_BASE = {
  id: true,
  stage: true,
  scheduledAt: true,
  createdAt: true,
  feedback: { select: { rating: true } },
} as const;

export const ROUND_SELECT = {
  recruiter: {
    ...ROUND_BASE,
    application: {
      select: {
        id: true,
        roleId: true,
        currentStage: true,
        candidate: { select: CANDIDATE_SELECT.recruiter },
      },
    },
  },
  interviewer: {
    ...ROUND_BASE,
    application: {
      select: {
        id: true,
        roleId: true,
        currentStage: true,
        candidate: { select: CANDIDATE_SELECT.interviewer },
      },
    },
  },
} as const;

export interface RoundView {
  id: string;
  stage: Stage;
  scheduledAt: Date;
  applicationId: string;
  roleId: string;
  currentStage: Stage;
  candidate: { id: string; name: string } | Record<string, unknown>;
  /**
   * Derived on every read, never stored (PLAN.md §5). A stored rollup is a mutable field
   * two panel members can clobber; a count of the rows that exist cannot be.
   */
  feedbackCount: number;
  ratings: number[];
}

type RoundRow = {
  id: string;
  stage: Stage;
  scheduledAt: Date;
  feedback: Array<{ rating: number }>;
  application: {
    id: string;
    roleId: string;
    currentStage: Stage;
    candidate: Record<string, unknown>;
  };
};

function toView(row: RoundRow): RoundView {
  return {
    id: row.id,
    stage: row.stage,
    scheduledAt: row.scheduledAt,
    applicationId: row.application.id,
    roleId: row.application.roleId,
    currentStage: row.application.currentStage,
    candidate: row.application.candidate,
    feedbackCount: row.feedback.length,
    ratings: row.feedback.map((entry) => entry.rating),
  };
}

/**
 * The interviewer scope, in one place. Every interviewer-facing round query below spreads
 * this into its `where`, so "may this interviewer see this round" has exactly one
 * definition and Postgres answers it.
 */
function assignedTo(actor: Actor) {
  return { assignments: { some: { interviewerId: actor.id } } };
}

export async function findRoundForRecruiter(_actor: Actor, roundId: string): Promise<RoundView | null> {
  const row = await prisma.interviewRound.findUnique({
    where: { id: roundId },
    select: ROUND_SELECT.recruiter,
  });
  return row ? toView(row) : null;
}

/** 404-by-zero-rows, same as `findCandidateForInterviewer`. */
export async function findRoundForInterviewer(actor: Actor, roundId: string): Promise<RoundView | null> {
  const row = await prisma.interviewRound.findFirst({
    where: { id: roundId, ...assignedTo(actor) },
    select: ROUND_SELECT.interviewer,
  });
  return row ? toView(row) : null;
}

/** `GET /me/rounds` — the list is the scope, so there is no "all rounds" variant to misuse. */
export async function listRoundsForInterviewer(actor: Actor): Promise<RoundView[]> {
  const rows = await prisma.interviewRound.findMany({
    where: assignedTo(actor),
    select: ROUND_SELECT.interviewer,
    orderBy: { scheduledAt: 'asc' },
  });
  return rows.map(toView);
}

/**
 * Answers "is this interviewer assigned to this round" without returning the round.
 * Used by the feedback path, which needs the permission but not the payload.
 */
export async function isAssignedToRound(actor: Actor, roundId: string): Promise<boolean> {
  const assignment = await prisma.roundAssignment.findUnique({
    where: { roundId_interviewerId: { roundId, interviewerId: actor.id } },
    select: { roundId: true },
  });
  return assignment !== null;
}

/**
 * Creates a round against the (candidateId, roleId) pair the §4 routes carry, and an
 * `AuditEvent` in the same transaction (PLAN.md §8).
 *
 * Returns `null` when no application exists for that pair, which the service turns into
 * a 404. The lookup is inside the transaction, so a round is never written against an
 * application that was deleted between the two statements.
 */
export async function createRound(
  actor: Actor,
  input: { candidateId: string; roleId: string; stage: Stage; scheduledAt: Date },
): Promise<{ id: string; applicationId: string } | null> {
  return prisma.$transaction(async (tx) => {
    const application = await tx.application.findUnique({
      where: { candidateId_roleId: { candidateId: input.candidateId, roleId: input.roleId } },
      select: { id: true },
    });

    if (!application) {
      return null;
    }

    const round = await tx.interviewRound.create({
      data: {
        applicationId: application.id,
        stage: input.stage,
        scheduledAt: input.scheduledAt,
      },
      select: { id: true },
    });

    await tx.auditEvent.create({
      data: {
        actorId: actor.id,
        action: 'ROUND_CREATED',
        entity: 'InterviewRound',
        entityId: round.id,
        payload: {
          candidateId: input.candidateId,
          roleId: input.roleId,
          applicationId: application.id,
          stage: input.stage,
          scheduledAt: input.scheduledAt.toISOString(),
        },
      },
      select: { id: true },
    });

    return { id: round.id, applicationId: application.id };
  });
}

/**
 * Assigns an interviewer to a round, plus the audit row, in one transaction.
 *
 * The insert is plain: a duplicate assignment collides with the composite primary key and
 * surfaces as a 409 through the central error mapping. Checking first and inserting after
 * would open a window this constraint closes for free — the same argument PLAN.md §5
 * makes about feedback.
 */
export async function createAssignment(
  actor: Actor,
  input: { roundId: string; interviewerId: string },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.roundAssignment.create({
      data: {
        roundId: input.roundId,
        interviewerId: input.interviewerId,
        assignedById: actor.id,
      },
      select: { roundId: true },
    });

    await tx.auditEvent.create({
      data: {
        actorId: actor.id,
        action: 'ASSIGNMENT_CREATED',
        entity: 'InterviewRound',
        entityId: input.roundId,
        payload: { roundId: input.roundId, interviewerId: input.interviewerId },
      },
      select: { id: true },
    });
  });
}
