import { UserRole } from '@prisma/client';
import { hashPassword } from './auth/password.js';
import { disconnectDatabase } from './db/client.js';
import { upsertUser } from './repositories/seed.repository.js';

/**
 * Seeds the user accounts PLAN.md §10 calls for — 2 recruiters, 4 interviewers, 1 hiring
 * manager — and prints the login table.
 *
 * Users only, for now. The roles, candidates, rounds and assignments §10 also lists
 * belong with the features that read them (D4 onward); seeding them before there is a
 * scoped repository to read them through would be data with nothing to prove.
 */

/**
 * Development credentials, printed on every run and committed to the repository. They
 * exist so a reviewer can `curl` the API a minute after `docker compose up`. Nothing here
 * is a secret, and nothing here should ever reach an environment that holds real data.
 */
const DEV_PASSWORD = 'poc-dev-password';

const USERS: Array<{ email: string; name: string; role: UserRole }> = [
  { email: 'rachel.recruiter@example.com', name: 'Rachel Ahmed', role: UserRole.RECRUITER },
  { email: 'raj.recruiter@example.com', name: 'Raj Patel', role: UserRole.RECRUITER },
  { email: 'ingrid.interviewer@example.com', name: 'Ingrid Olsen', role: UserRole.INTERVIEWER },
  { email: 'ivan.interviewer@example.com', name: 'Ivan Petrov', role: UserRole.INTERVIEWER },
  { email: 'iris.interviewer@example.com', name: 'Iris Chen', role: UserRole.INTERVIEWER },
  { email: 'ian.interviewer@example.com', name: 'Ian Murphy', role: UserRole.INTERVIEWER },
  { email: 'hana.manager@example.com', name: 'Hana Suzuki', role: UserRole.HIRING_MANAGER },
];

async function main(): Promise<void> {
  // One hash for every seeded account: bcrypt at cost 12 is ~250ms, and hashing the same
  // string seven times would add two seconds to container boot for no benefit. Each row
  // still gets its own salt-bearing hash string — they are simply identical passwords.
  const passwordHash = await hashPassword(DEV_PASSWORD);

  for (const user of USERS) {
    await upsertUser({ ...user, passwordHash });
  }

  const width = Math.max(...USERS.map((u) => u.email.length));
  console.log(`\n[seed] ${USERS.length} users ready. Development credentials:\n`);
  for (const user of USERS) {
    console.log(`  ${user.email.padEnd(width)}  ${DEV_PASSWORD}  (${user.role})`);
  }

  console.log(`
[seed] Get a token:

  curl -s localhost:4000/auth/login -H 'content-type: application/json' \\
    -d '{"email":"${USERS[0]?.email}","password":"${DEV_PASSWORD}"}'

[seed] Then call an authenticated route:

  curl -s localhost:4000/auth/me -H "authorization: Bearer $TOKEN"
`);
}

main()
  .catch((error: unknown) => {
    console.error('[seed] failed:', error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
