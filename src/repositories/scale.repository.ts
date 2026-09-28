import type { RoleStatus, Stage } from '@prisma/client';
import { prisma } from '../db/client.js';

/**
 * Bulk writes for the §8 scale dataset — 200 reqs and 20 000 candidates, the volume the
 * pipeline aggregate's `EXPLAIN (ANALYZE, BUFFERS)` is captured against (PLAN.md §6, §9).
 *
 * In `src/repositories/**` because that is the only place the lint rule allows the
 * Prisma client, and separate from seed.repository.ts because the contracts are
 * opposite: the demo fixture is idempotent upserts keyed on deterministic ids, this is
 * `createMany` in chunks with no read-back at all. Upserting twenty thousand rows one
 * statement at a time would take minutes and prove nothing.
 */

/** Postgres has a 65 535 bind-parameter ceiling; 1 000 rows keeps every table clear of it. */
export const CHUNK = 1_000;

async function inChunks<T>(rows: T[], write: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let index = 0; index < rows.length; index += CHUNK) {
    await write(rows.slice(index, index + CHUNK));
  }
}

export async function findAnyHiringManagerId(): Promise<string | null> {
  const user = await prisma.user.findFirst({
    where: { role: 'HIRING_MANAGER' },
    select: { id: true },
  });
  return user?.id ?? null;
}

export async function createHiringManager(user: {
  email: string;
  name: string;
  passwordHash: string;
}): Promise<string> {
  const created = await prisma.user.upsert({
    where: { email: user.email },
    create: { ...user, role: 'HIRING_MANAGER' },
    update: {},
    select: { id: true },
  });
  return created.id;
}

export async function insertRoles(
  roles: Array<{
    id: string;
    title: string;
    hiringManagerId: string;
    status: RoleStatus;
    openedAt: Date;
  }>,
): Promise<void> {
  await inChunks(roles, (chunk) => prisma.role.createMany({ data: chunk, skipDuplicates: true }));
}

export async function insertCandidates(
  candidates: Array<{ id: string; name: string; email: string; phone: string | null }>,
): Promise<void> {
  await inChunks(candidates, (chunk) =>
    prisma.candidate.createMany({ data: chunk, skipDuplicates: true }),
  );
}

export async function insertApplications(
  applications: Array<{
    id: string;
    candidateId: string;
    roleId: string;
    currentStage: Stage;
    currentStageEnteredAt: Date;
  }>,
): Promise<void> {
  await inChunks(applications, (chunk) =>
    prisma.application.createMany({ data: chunk, skipDuplicates: true }),
  );
}

/**
 * `ANALYZE` by hand after the load. Autovacuum gets there eventually, but "eventually"
 * is not a property you want in the minute between seeding and capturing a query plan —
 * a planner working from empty statistics picks a different plan, and the §9 numbers
 * would be measuring that rather than the index.
 */
export async function analyzePipelineTables(): Promise<void> {
  await prisma.$executeRawUnsafe('ANALYZE "Role", "Candidate", "Application"');
}

/**
 * Removes the generated dataset and nothing else. Candidates cascade to their
 * applications, so the two deletes below are the whole cleanup — and both are keyed on
 * the markers the generator writes (`emailDomain`, `titlePrefix`) rather than on a date
 * or a count, so a demo fixture or hand-made row can never be caught by it.
 */
export async function deleteGenerated(markers: {
  emailDomain: string;
  titlePrefix: string;
  managerEmail: string;
}): Promise<{ candidates: number; roles: number }> {
  const candidates = await prisma.candidate.deleteMany({
    where: { email: { endsWith: markers.emailDomain } },
  });
  const roles = await prisma.role.deleteMany({
    where: { title: { startsWith: markers.titlePrefix } },
  });
  await prisma.user.deleteMany({ where: { email: markers.managerEmail } });

  return { candidates: candidates.count, roles: roles.count };
}

export async function countGenerated(markers: {
  emailDomain: string;
  titlePrefix: string;
}): Promise<{ candidates: number; roles: number; applications: number }> {
  const [candidates, roles, applications] = await Promise.all([
    prisma.candidate.count({ where: { email: { endsWith: markers.emailDomain } } }),
    prisma.role.count({ where: { title: { startsWith: markers.titlePrefix } } }),
    prisma.application.count({ where: { role: { title: { startsWith: markers.titlePrefix } } } }),
  ]);
  return { candidates, roles, applications };
}
