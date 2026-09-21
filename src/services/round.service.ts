import { UserRole, type Stage } from '@prisma/client';
import { BadRequestError, ForbiddenError, NotFoundError } from '../errors/AppError.js';
import {
  createAssignment,
  createRound as createRoundRow,
  findRoundForInterviewer,
  findRoundForRecruiter,
  listRoundsForInterviewer,
  type RoundView,
} from '../repositories/round.repository.js';
import { findUserById } from '../repositories/user.repository.js';
import type { Actor } from '../domain/actor.js';

/**
 * Same shape as candidate.service.ts: the role picks the query, and the query carries the
 * scope. There is no "read the round, then decide" path.
 */
export async function getRound(actor: Actor, roundId: string): Promise<RoundView> {
  const round = await readFor(actor, roundId);

  if (!round) {
    throw new NotFoundError('No such round.');
  }

  return round;
}

function readFor(actor: Actor, roundId: string): Promise<RoundView | null> {
  switch (actor.role) {
    case UserRole.RECRUITER:
      return findRoundForRecruiter(actor, roundId);
    case UserRole.INTERVIEWER:
      return findRoundForInterviewer(actor, roundId);
    case UserRole.HIRING_MANAGER:
      throw new ForbiddenError('Interview rounds are not available to hiring managers.');
  }
}

/**
 * `GET /me/rounds`. The route is the scope — there is no `roleId` or `interviewerId`
 * parameter to widen it with, so the only rounds this can return are the caller's own.
 */
export async function listMyRounds(actor: Actor): Promise<RoundView[]> {
  if (actor.role !== UserRole.INTERVIEWER) {
    throw new ForbiddenError('Only interviewers have rounds of their own.');
  }
  return listRoundsForInterviewer(actor);
}

/**
 * The round's `stage` is deliberately not checked against the application's current
 * stage: scheduling an interview round while a candidate is still in SCREEN is ordinary
 * recruiting, and the stage machine governs where the *application* is, not what may be
 * booked ahead of it (PLAN.md §3).
 */
export async function createRound(
  actor: Actor,
  input: { candidateId: string; roleId: string; stage: Stage; scheduledAt: Date },
): Promise<{ id: string; applicationId: string }> {
  assertRecruiter(actor, 'create an interview round');

  const round = await createRoundRow(actor, input);

  if (!round) {
    throw new NotFoundError('No application for that candidate and role.');
  }

  return round;
}

/**
 * Assigning an interviewer is what *creates* an interviewer's access to a candidate, so
 * it is recruiter-only and it checks what it is granting: only a user whose role is
 * INTERVIEWER can be assigned. Assigning a recruiter would hand them a round through the
 * interviewer-scoped queries, which is not a door worth leaving open.
 *
 * A round that does not exist is caught by the FK on `RoundAssignment.roundId` — `23503`
 * maps to 404 in the central error handler (PLAN.md §7). Checking for it here first would
 * be a second answer to a question the database already answers correctly.
 */
export async function assignInterviewer(
  actor: Actor,
  roundId: string,
  interviewerId: string,
): Promise<void> {
  assertRecruiter(actor, 'assign an interviewer');

  const target = await findUserById(interviewerId);

  if (!target) {
    throw new NotFoundError('No such user.');
  }

  if (target.role !== UserRole.INTERVIEWER) {
    throw new BadRequestError(`${target.name} is a ${target.role}, not an interviewer.`, [
      { path: 'body.interviewerId', message: 'must be a user whose role is INTERVIEWER' },
    ]);
  }

  await createAssignment(actor, { roundId, interviewerId });
}

/** The routes carry `requireRole` too; this is the assertion that survives a remount. */
function assertRecruiter(actor: Actor, action: string): void {
  if (actor.role !== UserRole.RECRUITER) {
    throw new ForbiddenError(`Only recruiters may ${action}.`);
  }
}
