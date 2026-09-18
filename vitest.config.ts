import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every test runs against a real Postgres — no mocked Prisma anywhere (PLAN.md §9).
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    // Concurrency tests (PLAN.md §5) share one database; keep files serial so they
    // do not race each other's rows.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
