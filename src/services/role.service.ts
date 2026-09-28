import { UserRole } from '@prisma/client';
import { BadRequestError, ForbiddenError, NotFoundError } from '../errors/AppError.js';
import {
  createRole as createRoleRow,
  listRolesForHiringManager,
  listRolesForRecruiter,
  type RoleStatusFilter,
  type RoleView,
} from '../repositories/role.repository.js';
import { findUserById } from '../repositories/user.repository.js';
import type { Actor } from '../domain/actor.js';

export async function listRoles(actor: Actor, status: RoleStatusFilter): Promise<RoleView[]> {
  switch (actor.role) {
    case UserRole.RECRUITER:
      return listRolesForRecruiter(actor, status);
    case UserRole.HIRING_MANAGER:
      return listRolesForHiringManager(actor, status);
    /**
     * An interviewer's world is the rounds they are assigned to (PLAN.md §4). A list of
     * every open req is not part of it, and `GET /me/rounds` already tells them what
     * they need. Exhaustive switch, so a new role in the enum fails to compile here.
     */
    case UserRole.INTERVIEWER:
      throw new ForbiddenError('Open reqs are not available to interviewers.');
  }
}

/**
 * Opening a req names the hiring manager who owns it, and ownership is what
 * `GET /pipeline` and `GET /roles` scope a hiring manager by — so the named user's role
 * is checked before the write, exactly as `assignInterviewer` checks that its target is
 * an interviewer. A req owned by a recruiter would be a req its "manager" could never
 * see.
 */
export async function createRole(
  actor: Actor,
  input: { title: string; hiringManagerId: string },
): Promise<RoleView> {
  if (actor.role !== UserRole.RECRUITER) {
    throw new ForbiddenError('Only recruiters may open a req.');
  }

  const manager = await findUserById(input.hiringManagerId);

  if (!manager) {
    throw new NotFoundError('No such user.');
  }

  if (manager.role !== UserRole.HIRING_MANAGER) {
    throw new BadRequestError(`${manager.name} is a ${manager.role}, not a hiring manager.`, [
      { path: 'body.hiringManagerId', message: 'must be a user whose role is HIRING_MANAGER' },
    ]);
  }

  return createRoleRow(actor, input);
}
