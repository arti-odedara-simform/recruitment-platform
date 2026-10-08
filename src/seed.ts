import { UserRole } from '@prisma/client';
import { disconnectDatabase } from './db/client.js';
import { seedDatabase } from './seed/run.js';
import {
  APPLICATIONS,
  ASSIGNMENTS,
  CANDIDATES,
  CANDIDATE_IDS,
  DEV_PASSWORD,
  ROLES,
  ROUNDS,
  USERS,
  type CandidateKey,
  type UserKey,
} from './seed/fixture.js';

/**
 * CLI entrypoint: writes the PLAN.md §10 fixture, then prints what a reviewer needs to
 * drive it — login credentials, the ids the README's curl examples use, and the
 * assignment graph the §12 Q3 walkthrough turns on.
 *
 * The visibility table below is derived from the fixture rather than typed out, so it
 * cannot drift from what was actually written.
 */

/** Which candidates each interviewer reaches, following assignment -> round -> application. */
function visibleCandidates(interviewer: UserKey): CandidateKey[] {
  const rounds = new Set<string>(
    ASSIGNMENTS.filter((a) => a.interviewer === interviewer).map((a) => a.round),
  );
  const applications = new Set<string>(
    ROUNDS.filter((r) => rounds.has(r.key)).map((r) => r.application),
  );
  const candidates = APPLICATIONS.filter((a) => applications.has(a.key)).map((a) => a.candidate);
  return [...new Set<CandidateKey>(candidates)].sort();
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

function printCredentials(): void {
  const width = Math.max(...USERS.map((u) => u.email.length));
  console.log(`\n[seed] ${USERS.length} users ready. Development credentials:\n`);
  for (const user of USERS) {
    console.log(`  ${pad(user.email, width)}  ${DEV_PASSWORD}  (${user.role})`);
  }
}

function printFixture(): void {
  console.log(
    `\n[seed] Fixture: ${CANDIDATES.length} candidates, ${APPLICATIONS.length} applications, ` +
      `${ROUNDS.length} rounds, ${ASSIGNMENTS.length} assignments.\n`,
  );

  const nameOf = new Map(CANDIDATES.map((c) => [c.key, c.name]));
  console.log('[seed] Interviewer visibility (candidates reachable via assigned rounds):\n');

  for (const user of USERS.filter((u) => u.role === UserRole.INTERVIEWER)) {
    const visible = visibleCandidates(user.key);
    const listed = visible.length
      ? visible.map((key) => `${key} ${nameOf.get(key) ?? ''}`).join(', ')
      : '(none — assigned to no round)';
    console.log(`  ${pad(user.name, 14)} ${listed}`);
  }

  console.log('\n[seed] Hiring manager scope (reqs owned, and the applications on them):\n');

  for (const user of USERS.filter((u) => u.role === UserRole.HIRING_MANAGER)) {
    const owned = ROLES.filter((r) => r.hiringManager === user.key);
    const listed = owned
      .map((role) => {
        const count = APPLICATIONS.filter((a) => a.role === role.key).length;
        return `${role.title} (${role.status}, ${count} applications)`;
      })
      .join('; ');
    console.log(`  ${pad(user.name, 14)} ${listed || '(none — owns no req)'}`);
  }
}

function printWalkthrough(): void {
  // The two candidates the §12 Q3 demo contrasts: Ingrid is assigned to c01 and not to
  // c02, so the same interviewer gets 200 on one and 404 on the other. Ian, assigned to
  // nothing, gets 404 on both.
  console.log(`
[seed] Get a token:

  TOKEN=$(curl -s localhost:4000/auth/login -H 'content-type: application/json' \\
    -d '{"email":"${USERS[0]?.email}","password":"${DEV_PASSWORD}"}' | jq -r .token)

[seed] Then call an authenticated route:

  curl -s localhost:4000/auth/me -H "authorization: Bearer $TOKEN"

[seed] Candidate ids for the authorization walkthrough (PLAN.md §12 Q3):

  Amara Osei   ${CANDIDATE_IDS.c01}   Ingrid IS assigned
  Bruno Costa  ${CANDIDATE_IDS.c02}   Ingrid is NOT assigned

  As a recruiter:   full record, contact details included.
  As ingrid:        Amara -> 200 without contact fields; Bruno -> 404.
  As ian:           both -> 404; he is assigned to no round at all.

[seed] Same role, different scope (hiring managers):

  As hana:          Senior Backend Engineer + Product Designer; Platform is absent.
  As hamid:         Platform Engineer only; Backend and Designer are absent.
                    Amara is on both reqs — each manager sees only their own application.
`);
}

async function main(): Promise<void> {
  await seedDatabase();
  printCredentials();
  printFixture();
  printWalkthrough();
}

main()
  .catch((error: unknown) => {
    console.error('[seed] failed:', error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
