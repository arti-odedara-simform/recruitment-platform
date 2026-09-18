import { Stage, TransitionKind, UserRole } from '@prisma/client';
import { ForbiddenError } from '../errors/AppError.js';
import { assertCanAdvance, assertCanOverride } from '../domain/stageMachine.js';
import {
  runStageTransition,
  type StageTransitionResult,
} from '../repositories/application.repository.js';
import type { Actor } from '../domain/actor.js';

/**
 * The only caller of the stage machine, and the only path to
 * `applicationRepository.runStageTransition` — which is in turn the only writer of
 * `Application.currentStage`. That chain is the answer to walkthrough Q1 (PLAN.md §12):
 * there is exactly one way a stage moves, and it runs the rules every time.
 *
 * Both functions pass their check to the repository as a callback rather than running it
 * here. `fromStage` is only trustworthy once the row is locked, so the check belongs
 * inside the transaction — see the note on `assertLegal`.
 */

export interface TransitionTarget {
  candidateId: string;
  roleId: string;
}

/** PLAN.md §5: feedback never advances a stage. Recruiters advance, explicitly. */
export async function advance(
  actor: Actor,
  target: TransitionTarget,
  toStage: Stage,
): Promise<StageTransitionResult> {
  assertStageAuthority(actor);

  return runStageTransition({
    actor,
    ...target,
    toStage,
    kind: TransitionKind.NORMAL,
    reason: null,
    action: 'STAGE_ADVANCED',
    assertLegal: (fromStage) => assertCanAdvance(fromStage, toStage),
  });
}

export async function override(
  actor: Actor,
  target: TransitionTarget,
  toStage: Stage,
  reason: string,
): Promise<StageTransitionResult> {
  // `assertCanOverride` re-checks the role itself, inside the transaction. Belt and
  // braces, and cheap: the override path is the one a reviewer will read hardest.
  assertStageAuthority(actor);

  return runStageTransition({
    actor,
    ...target,
    toStage,
    kind: TransitionKind.OVERRIDE,
    reason,
    action: 'STAGE_OVERRIDDEN',
    assertLegal: (fromStage) => assertCanOverride(actor, fromStage, toStage, reason),
  });
}

/**
 * PLAN.md §3, stated once: **recruiters only**. Hiring managers are read-only over the
 * pipeline and interviewers have no stage authority at all — a panel member's opinion
 * reaches the pipeline as feedback, which a recruiter then acts on.
 *
 * The routes carry `requireRole(RECRUITER)` as well. This is the assertion that holds if
 * a route is ever remounted without it.
 */
function assertStageAuthority(actor: Actor): void {
  if (actor.role !== UserRole.RECRUITER) {
    throw new ForbiddenError('Only recruiters may move an application between stages.');
  }
}
