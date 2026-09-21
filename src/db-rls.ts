import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { disconnectDatabase } from './db/client.js';
import { installRls, rlsStatus } from './repositories/rls.repository.js';

/**
 * Installs PLAN.md §1 layer 3 — `npm run db:rls`.
 *
 * Separate from `prisma migrate deploy` on purpose. `CREATE ROLE` is a cluster-level
 * privilege, and the application's own database user does not have it on a typical
 * development machine: a Prisma migration containing it would fail on every laptop and
 * block work that has nothing to do with RLS. A script can fail with an explanation
 * instead, and the compose stack — where the app user owns the cluster — runs it on boot.
 */

const RLS_SQL = fileURLToPath(new URL('../prisma/rls.sql', import.meta.url));

/**
 * The file's own separator. `;` cannot be used: the `DO $$ … $$` blocks that create the
 * role are full of semicolons, and splitting on those would cut them in half.
 */
const SEPARATOR = /^--;;$/m;

export function parseStatements(sql: string): string[] {
  return sql
    .split(SEPARATOR)
    .map((statement) => stripComments(statement).trim())
    .filter((statement) => statement.length > 0);
}

/** Leading comment banners are not statements; Postgres accepts them, but a count of
 * "17 statements applied" should mean seventeen statements. */
function stripComments(statement: string): string {
  return statement
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

async function main(): Promise<void> {
  const sql = await readFile(RLS_SQL, 'utf8');
  const statements = parseStatements(sql);

  console.log(`[rls] applying ${statements.length} statements from prisma/rls.sql`);

  try {
    await installRls(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (/permission denied to create role|must be superuser/i.test(message)) {
      console.error(
        '\n[rls] this database user may not CREATE ROLE, so layer 3 cannot be installed ' +
          'from here.\n' +
          '      Run it as a privileged role instead, once:\n\n' +
          '        sudo -u postgres psql -d <database> -f prisma/rls.sql\n\n' +
          '      Or grant the app user the privilege once:\n\n' +
          '        sudo -u postgres psql -c \'ALTER ROLE <app user> CREATEROLE\'\n\n' +
          '      Layers 1 and 2 (the field sets and the scoped queries) are unaffected ' +
          'either way — the API is correct without this, just thinner. See PLAN.md §1.\n',
      );
      process.exitCode = 1;
      return;
    }

    throw error;
  }

  console.log(`[rls] done — status is now "${await rlsStatus()}".`);
  console.log(
    '[rls] verify by hand:\n\n' +
      "        psql \"$DATABASE_URL\" -c 'SET ROLE app_interviewer; " +
      'SELECT email FROM "Candidate" LIMIT 1;\'\n\n' +
      '      ERROR:  permission denied for table Candidate\n',
  );
}

main()
  .catch((error: unknown) => {
    console.error('[rls] failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
