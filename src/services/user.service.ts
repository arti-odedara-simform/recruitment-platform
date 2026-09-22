import { UserRole } from '@prisma/client';
import { ForbiddenError } from '../errors/AppError.js';
import { listUsers as listUserRows, type PublicUser } from '../repositories/user.repository.js';
import type { Actor } from '../domain/actor.js';

/**
 * The staff directory, and the reason it exists: `POST /rounds/:id/assignments` takes an
 * interviewer id, and `POST /roles` takes a hiring manager id. Without a list, the only
 * way to obtain either is to read it out of the seed script — which is fine for a curl
 * example and useless to the recruiter screens.
 *
 * **Recruiters only**, and that is the narrowest role that can use it. Recruiters are
 * the only people who assign interviewers or open reqs, so nobody else has a reason to
 * enumerate accounts. An interviewer who could list the panel would learn who else is
 * interviewing a candidate before their own round — the same information the assignment
 * scope exists to withhold (PLAN.md §1).
 */
export async function listStaff(
  actor: Actor,
  filter: { role?: UserRole | undefined; limit: number },
): Promise<PublicUser[]> {
  if (actor.role !== UserRole.RECRUITER) {
    throw new ForbiddenError('The staff directory is not available to your role.');
  }

  return listUserRows(actor, filter);
}
