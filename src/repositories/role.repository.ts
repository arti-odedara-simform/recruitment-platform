import { RoleStatus } from '@prisma/client';
import { prisma } from '../db/client.js';
import type { Actor } from '../domain/actor.js';

/**
 * Job reqs. Named `Role` per PLAN.md §2 and unrelated to `UserRole` — the authorization
 * enum — which is why every symbol here says "req" in prose and `Role` in code.
 *
 * Two scoped list functions rather than one with a flag, the same shape
 * candidate.repository.ts and pipeline.repository.ts use: a hiring manager's restriction
 * is a predicate in their query, not a filter applied to a recruiter's result.
 */

/**
 * `_count` is a lateral aggregate, not a second round-trip per row, and it is the reason
 * this list is worth calling at all — a req with no applications reads differently from
 * one with forty. Candidate rows are not reachable from here: the select names a count,
 * not a relation.
 */
export const ROLE_SELECT = {
  id: true,
  title: true,
  status: true,
  openedAt: true,
  hiringManager: { select: { id: true, name: true } },
  _count: { select: { applications: true } },
} as const;

export interface RoleView {
  id: string;
  title: string;
  status: RoleStatus;
  openedAt: Date;
  hiringManager: { id: string; name: string };
  applicationCount: number;
}

type RoleRow = {
  id: string;
  title: string;
  status: RoleStatus;
  openedAt: Date;
  hiringManager: { id: string; name: string };
  _count: { applications: number };
};

function toView(row: RoleRow): RoleView {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    openedAt: row.openedAt,
    hiringManager: row.hiringManager,
    applicationCount: row._count.applications,
  };
}

/** `?status=` — `ALL` is the explicit opt-in; the default is OPEN, as PLAN.md §4 has it. */
export type RoleStatusFilter = RoleStatus | 'ALL';

function statusWhere(status: RoleStatusFilter) {
  return status === 'ALL' ? {} : { status };
}

export async function listRolesForRecruiter(
  _actor: Actor,
  status: RoleStatusFilter,
): Promise<RoleView[]> {
  const rows = await prisma.role.findMany({
    where: statusWhere(status),
    select: ROLE_SELECT,
    orderBy: [{ status: 'asc' }, { openedAt: 'desc' }],
  });
  return rows.map(toView);
}

/** A hiring manager's own reqs and no others — the restriction is in the `where`. */
export async function listRolesForHiringManager(
  actor: Actor,
  status: RoleStatusFilter,
): Promise<RoleView[]> {
  const rows = await prisma.role.findMany({
    where: { ...statusWhere(status), hiringManagerId: actor.id },
    select: ROLE_SELECT,
    orderBy: [{ status: 'asc' }, { openedAt: 'desc' }],
  });
  return rows.map(toView);
}

/**
 * Opens a req, plus the `AuditEvent` §8 requires, in one transaction. A req that exists
 * without a record of who opened it is not a state this codebase can reach.
 *
 * `status` is not an input: a req opens OPEN. Closing one is a separate action with its
 * own audit row, and it does not exist yet — see the note in the route.
 */
export async function createRole(
  actor: Actor,
  input: { title: string; hiringManagerId: string },
): Promise<RoleView> {
  return prisma.$transaction(async (tx) => {
    const role = await tx.role.create({
      data: { title: input.title, hiringManagerId: input.hiringManagerId },
      select: ROLE_SELECT,
    });

    await tx.auditEvent.create({
      data: {
        actorId: actor.id,
        action: 'ROLE_OPENED',
        entity: 'Role',
        entityId: role.id,
        payload: { title: input.title, hiringManagerId: input.hiringManagerId },
      },
      select: { id: true },
    });

    return toView(role);
  });
}
