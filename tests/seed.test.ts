import { afterAll, describe, expect, it } from 'vitest';
import { prisma, disconnectDatabase } from '../src/db/client.js';
import { seedDatabase } from '../src/seed/run.js';
import {
  APPLICATIONS,
  APPLICATION_IDS,
  CANDIDATES,
  CANDIDATE_IDS,
  ROLES,
  ROLE_IDS,
  ROUNDS,
  ROUND_IDS,
  USERS,
} from '../src/seed/fixture.js';

/**
 * The fixture is seeded once in tests/globalSetup.ts. These assertions are about its
 * *shape*, because the D4 authorization tests are only meaningful if the shape holds:
 * an interviewer who can reach every candidate would make a scoped query and an
 * unscoped one indistinguishable.
 *
 * Read from the database, not from the fixture constants — asserting the constants
 * against themselves would pass even if nothing were written.
 */

afterAll(async () => {
  await disconnectDatabase();
});

/** Candidates an interviewer reaches through assignment -> round -> application. */
async function reachableCandidateIds(email: string): Promise<string[]> {
  const rows = await prisma.candidate.findMany({
    where: {
      applications: {
        some: { rounds: { some: { assignments: { some: { interviewer: { email } } } } } },
      },
    },
    select: { id: true },
  });
  return rows.map((row) => row.id).sort();
}

describe('the seeded fixture', () => {
  it('is idempotent — re-running adds no rows', async () => {
    const before = await counts();
    await seedDatabase();
    expect(await counts()).toEqual(before);
  });

  // Asserted by id rather than by total row count: later suites create rounds,
  // applications and users of their own, and a count assertion would start failing for
  // reasons that have nothing to do with the fixture.
  it('writes every fixture row', async () => {
    const [users, roles, candidates, applications, rounds] = await Promise.all([
      prisma.user.count({ where: { email: { in: USERS.map((u) => u.email) } } }),
      prisma.role.count({ where: { id: { in: Object.values(ROLE_IDS) } } }),
      prisma.candidate.count({ where: { id: { in: Object.values(CANDIDATE_IDS) } } }),
      prisma.application.count({ where: { id: { in: Object.values(APPLICATION_IDS) } } }),
      prisma.interviewRound.count({ where: { id: { in: Object.values(ROUND_IDS) } } }),
    ]);

    expect({ users, roles, candidates, applications, rounds }).toEqual({
      users: USERS.length,
      roles: ROLES.length,
      candidates: CANDIDATES.length,
      applications: APPLICATIONS.length,
      rounds: ROUNDS.length,
    });
  });

  it('leaves Ian assigned to no round at all', async () => {
    expect(await reachableCandidateIds('ian.interviewer@example.com')).toEqual([]);
  });

  it('gives Ingrid a partial view — the case a role check alone would miss', async () => {
    const reachable = await reachableCandidateIds('ingrid.interviewer@example.com');

    expect(reachable).toContain(CANDIDATE_IDS.c01);
    expect(reachable).not.toContain(CANDIDATE_IDS.c02);
    expect(reachable.length).toBeLessThan(CANDIDATES.length);
  });

  it('puts two interviewers on one round, for the concurrency tests', async () => {
    const shared = await prisma.interviewRound.findMany({
      where: { assignments: { some: {} } },
      select: { id: true, _count: { select: { assignments: true } } },
    });

    expect(shared.some((round) => round._count.assignments >= 2)).toBe(true);
  });

  it('keeps contact details on candidates for the leak sweep to find', async () => {
    const candidate = await prisma.candidate.findUniqueOrThrow({
      where: { id: CANDIDATE_IDS.c01 },
      select: { email: true, phone: true },
    });

    expect(candidate.email).toContain('@');
    expect(candidate.phone).toBeTruthy();
  });
});

async function counts(): Promise<Record<string, number>> {
  const [users, roles, candidates, applications, rounds, assignments] = await Promise.all([
    prisma.user.count(),
    prisma.role.count(),
    prisma.candidate.count(),
    prisma.application.count(),
    prisma.interviewRound.count(),
    prisma.roundAssignment.count(),
  ]);
  return { users, roles, candidates, applications, rounds, assignments };
}
