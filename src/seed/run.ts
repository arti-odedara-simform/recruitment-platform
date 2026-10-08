import { hashPassword } from '../auth/password.js';
import {
  upsertApplication,
  upsertAssignment,
  upsertCandidate,
  upsertRole,
  upsertRound,
  upsertUser,
} from '../repositories/seed.repository.js';
import {
  APPLICATIONS,
  APPLICATION_IDS,
  ASSIGNMENTS,
  CANDIDATES,
  CANDIDATE_IDS,
  DEV_PASSWORD,
  ROLES,
  ROLE_IDS,
  ROUNDS,
  ROUND_IDS,
  USERS,
  USER_IDS,
  daysFrom,
  type UserKey,
} from './fixture.js';

/**
 * Writes the PLAN.md §10 fixture. Idempotent, so the compose entrypoint can run it on
 * every boot, and importable, so a test that needs the assignment graph can call it
 * rather than rebuild one.
 *
 * Ordering is by foreign key: users before roles (hiring manager), candidates and roles
 * before applications, applications before rounds, rounds before assignments. Written as
 * sequential awaits rather than `Promise.all` — seventeen applications are not worth a
 * concurrency bug in a script whose whole job is to produce a known starting state.
 *
 * Returns the resolved user ids, which is the one thing the caller cannot derive: user
 * rows are upserted by email, so an account created before the ids became deterministic
 * keeps its original uuid.
 */
export async function seedDatabase(now: Date = new Date()): Promise<Record<UserKey, string>> {
  // One hash for every seeded account: bcrypt at cost 12 is ~250ms, and hashing the same
  // string eight times would add two seconds to container boot for no benefit. Each row
  // still gets its own salt-bearing hash string — they are simply identical passwords.
  const passwordHash = await hashPassword(DEV_PASSWORD);

  const userIds = {} as Record<UserKey, string>;
  for (const user of USERS) {
    const { id } = await upsertUser({
      id: USER_IDS[user.key],
      email: user.email,
      name: user.name,
      role: user.role,
      passwordHash,
    });
    userIds[user.key] = id;
  }

  for (const role of ROLES) {
    await upsertRole({
      id: ROLE_IDS[role.key],
      title: role.title,
      hiringManagerId: userIds[role.hiringManager],
      status: role.status,
      openedAt: daysFrom(now, -role.openedDaysAgo),
    });
  }

  for (const candidate of CANDIDATES) {
    await upsertCandidate({
      id: CANDIDATE_IDS[candidate.key],
      name: candidate.name,
      email: candidate.email,
      phone: candidate.phone,
    });
  }

  for (const application of APPLICATIONS) {
    await upsertApplication({
      id: APPLICATION_IDS[application.key],
      candidateId: CANDIDATE_IDS[application.candidate],
      roleId: ROLE_IDS[application.role],
      currentStage: application.stage,
      currentStageEnteredAt: daysFrom(now, -application.daysInStage),
    });
  }

  for (const round of ROUNDS) {
    await upsertRound({
      id: ROUND_IDS[round.key],
      applicationId: APPLICATION_IDS[round.application],
      stage: round.stage,
      scheduledAt: daysFrom(now, round.scheduledInDays),
    });
  }

  for (const assignment of ASSIGNMENTS) {
    await upsertAssignment({
      roundId: ROUND_IDS[assignment.round],
      interviewerId: userIds[assignment.interviewer],
      assignedById: userIds[assignment.assignedBy],
    });
  }

  return userIds;
}
