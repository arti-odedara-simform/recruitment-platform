import { execFileSync } from 'node:child_process';
import { config } from 'dotenv';

/**
 * Runs once before the suite: point everything at the test database and bring its
 * schema up to date. PLAN.md §9 — no mocked Prisma anywhere, so the tests are only
 * meaningful against a real engine that has the migrations (and the CHECK
 * constraints) applied.
 *
 * PLAN.md §14 flagged testcontainers as a risk. This is the decided fallback: a
 * separate database name on the same Postgres, so the suite runs identically on a
 * laptop, in the compose stack, and in CI. The demo fixture is seeded here too, so
 * every file starts from the same assignment graph.
 */
export default async function globalSetup(): Promise<void> {
  config({ path: '.env.test', override: true });

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set — copy .env.example to .env.test.');
  }
  if (!/test/i.test(url)) {
    throw new Error(
      `Refusing to run the suite against ${url} — the test DATABASE_URL must name a ` +
        'database with "test" in it. The suite truncates tables.',
    );
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });

  // The PLAN.md §10 fixture, so the authorization tests can assert against a known
  // assignment graph (Ingrid sees c01 and not c02; Ian sees nothing) instead of each
  // building one. Imported dynamically: a static import would pull in src/config/env.ts
  // before the `config()` call above has pointed DATABASE_URL at the test database.
  //
  // Seeding is an upsert, so it is safe to re-run, and it never removes rows a test
  // created. Tests that need isolation still create and clean up their own rows, as
  // tests/auth.test.ts does.
  const { seedDatabase } = await import('../src/seed/run.js');
  const { disconnectDatabase } = await import('../src/db/client.js');
  await seedDatabase();
  await disconnectDatabase();
}
