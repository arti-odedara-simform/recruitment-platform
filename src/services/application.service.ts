import { Stage, TransitionKind, UserRole } from '@prisma/client';
import { BadRequestError, ForbiddenError, NotFoundError } from '../errors/AppError.js';
import { assertCanAdvance, assertCanOverride } from '../domain/stageMachine.js';
import {
  createApplication as createApplicationRow,
  listApplicationsForHiringManager,
  listApplicationsForRecruiter,
  runStageTransition,
  type ApplicationListFilter,
  type ApplicationListRow,
  type ApplicationStageView,
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

/**
 * Puts a candidate onto a req, at APPLIED. Recruiters only — the same authority that
 * moves an application between stages is the one that starts it, and a candidate
 * appearing on a req is a pipeline decision, not a side effect of anything else.
 *
 * A CLOSED req is a 400 with the field named, matching how `assignInterviewer` refuses a
 * target whose role is wrong: the request is well-formed but names something that cannot
 * accept it.
 */
export async function createApplication(
  actor: Actor,
  target: TransitionTarget,
): Promise<ApplicationStageView> {
  assertStageAuthority(actor);

  const result = await createApplicationRow(actor, target);

  switch (result.outcome) {
    case 'CREATED':
      return result.application;
    case 'NO_SUCH_ROLE':
      throw new NotFoundError('No such req.');
    case 'ROLE_CLOSED':                                                                                        
      throw new BadRequestError(`"${result.title}" is closed and takes no new candidates.`, [
        { path: 'body.roleId', message: 'must be an OPEN req' },
      ]);
  }
}

// ---------------------------------------------------------------------------
// The work queue behind the recruiter's candidate list
// ---------------------------------------------------------------------------

export interface ApplicationListView extends ApplicationListRow {
  /** Days in the current stage, one decimal — the same figure `GET /pipeline/stuck` publishes. */
  daysInStage: number;
}

/**
 * The same role split as the pipeline reads, and for the same reason: the scope belongs
 * in the query, not in a filter applied to a wider result.
 *
 * Unlike the stage routes this is *not* recruiter-only. A hiring manager may already see
 * counts and ageing for their own reqs through `GET /pipeline`, and the names behind
 * those counts through `GET /pipeline/stuck` — withholding the same rows here would be a
 * gate on one URL rather than on the data, which is not a boundary worth pretending to.
 * What they cannot do is act on any of it: every mutating route below is recruiter-only.
 */
export async function listApplications(
  actor: Actor,
  filter: ApplicationListFilter,
): Promise<ApplicationListView[]> {
  const rows = await readListFor(actor, filter);
  const now = Date.now();

  return rows.map((row) => ({
    ...row,
    daysInStage: Math.round(((now - row.currentStageEnteredAt.getTime()) / 86_400_000) * 10) / 10,
  }));
}

function readListFor(actor: Actor, filter: ApplicationListFilter): Promise<ApplicationListRow[]> {
  switch (actor.role) {
    case UserRole.RECRUITER:
      return listApplicationsForRecruiter(actor, filter);
    case UserRole.HIRING_MANAGER:
      return listApplicationsForHiringManager(actor, filter);
    /**
     * An interviewer's world is `GET /me/rounds` (PLAN.md §4). A list of everyone in the
     * pipeline — with the candidate names attached — is the opposite of the assignment
     * scope. Exhaustive switch, so a new role fails to compile here.
     */
    case UserRole.INTERVIEWER:
      throw new ForbiddenError('The candidate list is not available to interviewers.');
  }
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
