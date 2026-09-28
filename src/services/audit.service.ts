import { UserRole } from '@prisma/client';
import { ForbiddenError, NotFoundError } from '../errors/AppError.js';
import { findCandidateAudit, type CandidateAudit } from '../repositories/audit.repository.js';
import type { Actor } from '../domain/actor.js';

/**
 * PLAN.md §8. Recruiters and hiring managers only — the timeline names who did what, and
 * an interviewer reading the panel's ratings and the recruiter's override reasons for a
 * candidate they are about to interview is precisely the pollution the assignment scope
 * exists to prevent.
 *
 * A candidate outside a hiring manager's reqs 404s rather than 403s, because the scope
 * lives in the query and "no such candidate" and "not one of yours" arrive here as the
 * same zero rows (PLAN.md §4).
 */
export async function getCandidateAudit(
  actor: Actor,
  candidateId: string,
): Promise<CandidateAudit> {
  if (actor.role === UserRole.INTERVIEWER) {
    throw new ForbiddenError('The audit timeline is not available to interviewers.');
  }

  const audit = await findCandidateAudit(
    actor,
    candidateId,
    actor.role === UserRole.RECRUITER ? 'RECRUITER' : 'HIRING_MANAGER',
  );

  if (!audit) {
    throw new NotFoundError('No such candidate.');
  }

  return audit;
}
