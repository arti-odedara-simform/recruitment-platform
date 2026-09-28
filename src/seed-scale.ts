import { disconnectDatabase } from './db/client.js';
import { countGenerated, deleteGenerated } from './repositories/scale.repository.js';
import { MARKERS, SCALE_DEFAULTS, generateScaleDataset } from './seed/scale.js';
import { env } from './config/env.js';

/**
 * CLI entrypoint for the PLAN.md §8 scale dataset.
 *
 *   npm run db:seed:scale                                  # 200 reqs, 20 000 candidates
 *   npm run db:seed:scale -- --roles=50 --candidates=5000
 *   npm run db:seed:scale -- --clean                       # remove it again
 *
 * Kept out of `src/seed.ts`: that script writes the demo fixture the README's
 * credentials and walkthrough depend on, and the container entrypoint runs it on every
 * boot. Twenty thousand rows are for measuring query plans, not for booting a demo.
 */

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  return match?.slice(prefix.length);
}

function count(name: string, fallback: number): number {
  const raw = flag(name);
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer, got "${raw}".`);
  }
  return value;
}

async function main(): Promise<void> {
  // The generated rows are indistinguishable from real ones to anything but their
  // markers, and 20 000 of them are not something to discover in a production database.
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to generate the scale dataset with NODE_ENV=production.');
  }

  if (process.argv.includes('--clean')) {
    const removed = await deleteGenerated(MARKERS);
    console.log(
      `[scale] removed ${removed.candidates} candidates (applications cascade) and ` +
        `${removed.roles} reqs.`,
    );
    return;
  }

  const existing = await countGenerated(MARKERS);
  if (existing.candidates > 0) {
    console.log(
      `[scale] ${existing.candidates} generated candidates and ${existing.roles} reqs are ` +
        'already present. Run with --clean first to regenerate.',
    );
    return;
  }

  const result = await generateScaleDataset({
    roles: count('roles', SCALE_DEFAULTS.roles),
    candidates: count('candidates', SCALE_DEFAULTS.candidates),
  });

  console.log(
    `[scale] wrote ${result.roles} reqs, ${result.candidates} candidates and ` +
      `${result.applications} applications in ${(result.milliseconds / 1000).toFixed(1)}s, ` +
      'then ANALYZEd.',
  );
  console.log(`
[scale] Capture the PLAN.md §6 plan against it (D9):

  psql "$DATABASE_URL" -c 'EXPLAIN (ANALYZE, BUFFERS)
    SELECT r."id", r."title", a."currentStage", count(a."id"),
           avg(EXTRACT(EPOCH FROM ((now() AT TIME ZONE '"'"'UTC'"'"') - a."currentStageEnteredAt"))),
           max(EXTRACT(EPOCH FROM ((now() AT TIME ZONE '"'"'UTC'"'"') - a."currentStageEnteredAt")))
    FROM "Role" r LEFT JOIN "Application" a ON a."roleId" = r."id"
    WHERE r."status" = '"'"'OPEN'"'"'
    GROUP BY r."id", r."title", a."currentStage";'

[scale] Remove it again with:  npm run db:seed:scale -- --clean
`);
}

main()
  .catch((error: unknown) => {
    console.error('[scale] failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
