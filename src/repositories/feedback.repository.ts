import { prisma } from '../db/client.js';
import type { Actor } from '../domain/actor.js';

/**
 * PLAN.md §5, the documented concurrency rule:
 *
 * > **Both submissions are kept. Feedback is per-(round, interviewer), never merged,
 * > never overwritten. A second submission by the *same* interviewer for the same round
 * > is rejected with 409, not silently updated.**
 *
 * That rule is a database constraint, `@@unique([roundId, interviewerId])`, not a check
 * in this file. The insert below is plain — no `findFirst` beforehand, no `upsert`. Two
 * panel members writing at the same instant both succeed because they are different
 * rows; the same interviewer writing twice collides in the index and surfaces as a 409
 * through the central mapping of `23505`.
 *
 * A read-then-write would be the natural way to produce a friendlier error and would
 * reintroduce exactly the lost-update window the constraint exists to close.
 */

export interface FeedbackRecord {
  id: string;
  roundId: string;
  interviewerId: string;
  rating: number;
  notes: string;
  submittedAt: Date;
}

export interface PeerFeedback extends FeedbackRecord {
  interviewer: { id: string; name: string };
}

/**
 * The insert, plus the `AuditEvent` §8 requires, in one transaction — if the audit write
 * fails the feedback rolls back with it.
 *
 * Note what is *not* here: no stage change. Feedback never auto-advances an application
 * (PLAN.md §5); recruiters advance. That keeps the concurrency surface to a single table.
 */
export async function createFeedback(
  actor: Actor,
  input: { roundId: string; rating: number; notes: string },
): Promise<FeedbackRecord> {
  return prisma.$transaction(async (tx) => {
    const feedback = await tx.feedback.create({
      data: {
        roundId: input.roundId,
        interviewerId: actor.id,
        rating: input.rating,
        notes: input.notes,
      },
      select: {
        id: true,
        roundId: true,
        interviewerId: true,
        rating: true,
        notes: true,
        submittedAt: true,
      },
    });

    await tx.auditEvent.create({
      data: {
        actorId: actor.id,
        action: 'FEEDBACK_SUBMITTED',
        entity: 'InterviewRound',
        entityId: input.roundId,
        payload: { feedbackId: feedback.id, roundId: input.roundId, rating: input.rating },
      },
      select: { id: true },
    });

    return feedback;
  });
}

/**
 * Peer feedback for one round.
 *
 * The interviewer is named — `id` and `name`, never their email. A `User` is not a
 * `Candidate` and carries no restricted-contact rule, but there is no reason for a
 * feedback list to hand out addresses either, so the select stays narrow.
 *
 * Scope is the caller's business, not this function's: the service checks assignment
 * before calling, because "which rounds may I read" is already answered by
 * `round.repository.ts` and duplicating it here would create a second definition.
 */
export async function listFeedbackForRound(roundId: string): Promise<PeerFeedback[]> {
  return prisma.feedback.findMany({
    where: { roundId },
    select: {
      id: true,
      roundId: true,
      interviewerId: true,
      rating: true,
      notes: true,
      submittedAt: true,
      interviewer: { select: { id: true, name: true } },
    },
    orderBy: { submittedAt: 'asc' },
  });
}
