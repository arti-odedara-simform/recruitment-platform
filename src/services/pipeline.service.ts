import { UserRole, type Stage } from '@prisma/client';
import { ForbiddenError } from '../errors/AppError.js';
import {
  aggregatePipelineForHiringManager,
  aggregatePipelineForRecruiter,
  findStuckForHiringManager,
  findStuckForRecruiter,
  type PipelineCell,
  type PipelineFilter,
  type StuckApplication,
  type StuckFilter,
} from '../repositories/pipeline.repository.js';
import type { Actor } from '../domain/actor.js';

/**
 * Same shape as candidate.service.ts and round.service.ts: the role picks the query, and
 * the query carries the scope. Nothing here narrows a result that came back too wide.
 */

export interface PipelineStageSummary {
  stage: Stage;
  candidates: number;
  /** Time in the *current* stage, from `Application.currentStageEnteredAt` (PLAN.md §6). */
  averageAgeDays: number;
  oldestAgeDays: number;
}

export interface PipelineRoleSummary {
  roleId: string;
  title: string;
  totalCandidates: number;
  stages: PipelineStageSummary[];
}

export async function getPipeline(
  actor: Actor,
  filter: PipelineFilter,
): Promise<PipelineRoleSummary[]> {
  return toSummaries(await readFor(actor, filter));
}

function readFor(actor: Actor, filter: PipelineFilter): Promise<PipelineCell[]> {
  switch (actor.role) {
    case UserRole.RECRUITER:
      return aggregatePipelineForRecruiter(actor, filter);
    case UserRole.HIRING_MANAGER:
      return aggregatePipelineForHiringManager(actor, filter);
    /**
     * Interviewers have no pipeline view at all (PLAN.md §4). The route's `requireRole`
     * says so too; this arm keeps the switch exhaustive, so a role added to the enum
     * later fails to compile here rather than falling through to somebody's dashboard.
     */
    case UserRole.INTERVIEWER:
      throw new ForbiddenError('The pipeline view is not available to interviewers.');
  }
}

/**
 * Regroups the flat (role, stage) cells into one entry per role. This is the only
 * reshaping in the path — the counting and the ageing already happened in Postgres, and
 * the input here is at most (roles x stages) rows however large the pipeline is.
 *
 * Ages are rounded to one decimal on the way out: the underlying value carries float
 * noise (`8.999999999`) that means nothing at the resolution a pipeline dashboard reads
 * at, and rounding at the edge keeps the stored value exact for anything that later
 * wants it (the §8 "stuck beyond N days" view thresholds in SQL, not here).
 */
function toSummaries(cells: PipelineCell[]): PipelineRoleSummary[] {
  const byRole = new Map<string, PipelineRoleSummary>();

  for (const cell of cells) {
    let role = byRole.get(cell.roleId);
    if (!role) {
      role = { roleId: cell.roleId, title: cell.title, totalCandidates: 0, stages: [] };
      byRole.set(cell.roleId, role);
    }

    // The empty-role row from the LEFT JOIN: an open req with no applications. It earns
    // an entry with zero counts, not a missing one.
    if (cell.stage === null) continue;

    role.totalCandidates += cell.candidates;
    role.stages.push({
      stage: cell.stage,
      candidates: cell.candidates,
      averageAgeDays: round(cell.averageAgeDays),
      oldestAgeDays: round(cell.oldestAgeDays),
    });
  }

  return [...byRole.values()];
}

function round(value: number | null): number {
  return Math.round((value ?? 0) * 10) / 10;
}

// ---------------------------------------------------------------------------
// "Stuck beyond N days" (PLAN.md §4, §8)
// ---------------------------------------------------------------------------

export interface StuckView extends Omit<StuckApplication, 'currentStageEnteredAt'> {
  currentStageEnteredAt: Date;
  /** Days in the current stage, one decimal — the number the threshold was applied to. */
  daysInStage: number;
}

/**
 * The same role split as the aggregate, for the same reason: the scope belongs in the
 * query. Computing `daysInStage` here rather than in SQL is free — these rows are already
 * materialised, which is the one thing that separates this endpoint from the §6 view.
 */
export async function getStuck(actor: Actor, filter: StuckFilter): Promise<StuckView[]> {
  const rows = await readStuckFor(actor, filter);
  const now = Date.now();

  return rows.map((row) => ({
    ...row,
    daysInStage: Math.round(((now - row.currentStageEnteredAt.getTime()) / 86_400_000) * 10) / 10,
  }));
}

function readStuckFor(actor: Actor, filter: StuckFilter): Promise<StuckApplication[]> {
  switch (actor.role) {
    case UserRole.RECRUITER:
      return findStuckForRecruiter(actor, filter);
    case UserRole.HIRING_MANAGER:
      return findStuckForHiringManager(actor, filter);
    case UserRole.INTERVIEWER:
      throw new ForbiddenError('The pipeline view is not available to interviewers.');
  }
}
