import { UserRole } from '@prisma/client';
import { ForbiddenError, NotFoundError } from '../errors/AppError.js';
import { isAssignedToRound } from '../repositories/round.repository.js';
import {
  createFeedback,
  listFeedbackForRound,
  type FeedbackRecord,
  type PeerFeedback,
} from '../repositories/feedback.repository.js';
import type { Actor } from '../domain/actor.js';

/**
 * Submitting feedback, and reading the panel's.
 *
 * PLAN.md §4 reads the brief's "interviewers can't see prior feedback before their round"
 * as a statement of the *problem*, so `GET /rounds/:id/feedback` returns peer feedback to
 * anyone assigned to that round. That is a deliberate reading of an ambiguous line, and
 * it is the kind of decision that belongs written down rather than buried in a handler.
 */

export async function submitFeedback(
  actor: Actor,
  roundId: string,
  input: { rating: number; notes: string },
): Promise<FeedbackRecord> {
  if (actor.role !== UserRole.INTERVIEWER) {
    throw new ForbiddenError('Only assigned interviewers may submit feedback.');
  }

  /**
   * The assignment check runs first and 404s — same body an unknown round would produce,
   * so an unassigned interviewer cannot probe for which rounds exist.
   *
   * The FK on `Feedback.roundId` is the backstop: a round deleted between this check and
   * the insert yields `23503`, which the error handler also maps to 404 (PLAN.md §7).
   * Both paths end in the same response, and both are tested.
   */
  if (!(await isAssignedToRound(actor, roundId))) {
    throw new NotFoundError('No such round.');
  }

  // No read-then-write from here on. A second submission by this interviewer collides
  // with @@unique([roundId, interviewerId]) and becomes a 409 (PLAN.md §5).
  return createFeedback(actor, { roundId, ...input });
}

export async function listFeedback(actor: Actor, roundId: string): Promise<PeerFeedback[]> {
  switch (actor.role) {
    case UserRole.RECRUITER:
      break;
    case UserRole.INTERVIEWER:
      if (!(await isAssignedToRound(actor, roundId))) {
        throw new NotFoundError('No such round.');
      }
      break;
    case UserRole.HIRING_MANAGER:
      throw new ForbiddenError('Interview feedback is not available to hiring managers.');
  }

  return listFeedbackForRound(roundId);
}
