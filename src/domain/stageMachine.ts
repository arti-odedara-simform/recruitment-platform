import { Stage, UserRole } from '@prisma/client';
import { BadRequestError, ForbiddenError, InvalidTransitionError } from '../errors/AppError.js';
import type { Actor } from './actor.js';

/**
 * Stage progression, PLAN.md §3. **This file is the single source of truth**, and the
 * answer to walkthrough Q1: it is called only from `applicationService.transition()`,
 * which is the only writer of `Application.currentStage`.
 *
 * Nothing here touches the database or knows what HTTP is. The legality of a move is a
 * fact about the domain; routes validate the *shape* of a request (is `toStage` a member
 * of the enum) and nothing more (PLAN.md §7).
 */
export const ALLOWED: Record<Stage, readonly Stage[]> = {
  [Stage.APPLIED]: [Stage.SCREEN, Stage.REJECTED],
  [Stage.SCREEN]: [Stage.INTERVIEW, Stage.REJECTED],
  [Stage.INTERVIEW]: [Stage.OFFER, Stage.REJECTED],
  [Stage.OFFER]: [Stage.HIRED, Stage.REJECTED],
  [Stage.HIRED]: [],
  [Stage.REJECTED]: [],
};

/**
 * The two stages nothing leaves — not even an override. A hire or a rejection that could
 * be quietly walked back would make the audit trail describe a pipeline that no longer
 * matches reality, and "reopen the application" is a different act with a different
 * record, not a stage edit.
 */
export const TERMINAL: readonly Stage[] = [Stage.HIRED, Stage.REJECTED];

/**
 * Shared by the zod schema on the override route and by `assertCanOverride` below, so
 * the boundary check and the domain check cannot disagree. The database enforces the
 * same floor a third time (`override_requires_reason`, in the init migration) — that
 * CHECK is what makes "recorded, not inferred" true even if this file is bypassed.
 */
export const MIN_OVERRIDE_REASON_LENGTH = 10;

export function isTerminal(stage: Stage): boolean {
  return TERMINAL.includes(stage);
}

/**
 * A normal advance: one step along ALLOWED, and nothing else. `APPLIED -> OFFER` throws
 * here, and the 422 body carries the legal set so the caller learns the rule rather than
 * just being refused.
 */
export function assertCanAdvance(from: Stage, to: Stage): void {
  if (!ALLOWED[from].includes(to)) {
    throw new InvalidTransitionError(from, to, ALLOWED[from]);
  }
}

/**
 * An override may skip stages — that is its whole purpose — but three things still hold.
 *
 * 1. **Recruiters only.** Hiring managers are read-only; interviewers have no stage
 *    authority at all. The route's `requireRole` says the same thing; this assertion is
 *    the one that survives a route being remounted without it (PLAN.md §12 Q2).
 * 2. **Terminal stages are still terminal.** An override is a licence to skip forward,
 *    not to undo a hire or a rejection.
 * 3. **A reason, and a real one.** Ten characters is not a quality bar, but it does stop
 *    `"."` and `"x"` from satisfying an audit requirement.
 *
 * A no-op override (`to === from`) is refused too: it would write a StageTransition row
 * describing a move that did not happen.
 */
export function assertCanOverride(actor: Actor, from: Stage, to: Stage, reason: string): void {
  if (actor.role !== UserRole.RECRUITER) {
    throw new ForbiddenError('Only recruiters may override a stage.');
  }

  if (reason.trim().length < MIN_OVERRIDE_REASON_LENGTH) {
    throw new BadRequestError(
      `An override reason of at least ${MIN_OVERRIDE_REASON_LENGTH} characters is required.`,
      [{ path: 'body.reason', message: `must be at least ${MIN_OVERRIDE_REASON_LENGTH} characters` }],
    );
  }

  if (isTerminal(from)) {
    throw new InvalidTransitionError(from, to, []);
  }

  if (to === from) {
    throw new InvalidTransitionError(from, to, ALLOWED[from]);
  }
}
