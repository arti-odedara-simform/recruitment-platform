import { UserRole } from '@prisma/client';
import { ForbiddenError, NotFoundError } from '../errors/AppError.js';
import type { Actor } from '../domain/actor.js';
import {
  findCandidateForInterviewer,
  findCandidateForRecruiter,
  listCandidatesForInterviewer,
  listCandidatesForRecruiter,
  type CandidateListFilter,
  type InterviewerCandidateView,
  type RecruiterCandidateView,
} from '../repositories/candidate.repository.js';

export type CandidateView = RecruiterCandidateView | InterviewerCandidateView;

export interface CandidateList {
  items: CandidateView[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/**
 * Picks the field set from the caller's role, and nothing else.
 *
 * Note what this function does *not* do: it never fetches a candidate and then decides
 * what to keep. The branch happens before the read, so the two paths run different SQL
 * (PLAN.md §1 layer 1). A "fetch once, strip for interviewers" version would be shorter
 * and would put contact details in process memory on every interviewer request.
 *
 * The `null` -> 404 mapping is the only place the interviewer's scope becomes an HTTP
 * status. Because the scope lives in the `where`, "no such candidate" and "not yours"
 * arrive here identically — there is no branch that could accidentally distinguish them.
 */
export async function getCandidate(actor: Actor, candidateId: string): Promise<CandidateView> {
  const candidate = await readFor(actor, candidateId);

  if (!candidate) {
    throw new NotFoundError('No such candidate.');
  }

  return candidate;
}

function readFor(actor: Actor, candidateId: string): Promise<CandidateView | null> {
  switch (actor.role) {
    case UserRole.RECRUITER:
      return findCandidateForRecruiter(actor, candidateId);
    case UserRole.INTERVIEWER:
      return findCandidateForInterviewer(actor, candidateId);
    /**
     * Hiring managers are read-only over the *pipeline*, not over candidate records —
     * PLAN.md §4 lists them against `GET /pipeline` alone. The route's `requireRole`
     * already rejects them; this arm exists so the switch is exhaustive and a role added
     * to the enum later fails to compile here rather than falling through to a view.
     */
    case UserRole.HIRING_MANAGER:
      throw new ForbiddenError('Candidate records are not available to hiring managers.');
  }
}

/**
 * The list counterpart to `getCandidate`: the same role branch before the read, so an
 * interviewer's page is assigned candidates only, in the narrow field set.
 */
export async function listCandidates(actor: Actor, filter: CandidateListFilter): Promise<CandidateList> {
  const { items, total } = await listFor(actor, filter);

  return {
    items,
    page: filter.page,
    pageSize: filter.pageSize,
    total,
    totalPages: Math.ceil(total / filter.pageSize),
  };
}

function listFor(
  actor: Actor,
  filter: CandidateListFilter,
): Promise<{ items: CandidateView[]; total: number }> {
  switch (actor.role) {
    case UserRole.RECRUITER:
      return listCandidatesForRecruiter(actor, filter);
    case UserRole.INTERVIEWER:
      return listCandidatesForInterviewer(actor, filter);
    case UserRole.HIRING_MANAGER:
      throw new ForbiddenError('Candidate records are not available to hiring managers.');
  }
}
