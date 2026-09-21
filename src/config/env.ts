import 'dotenv/config';
import { z } from 'zod';

/**
 * Fail-fast environment validation. Nothing in the app reads process.env directly —
 * a missing or malformed variable stops the process at import time with a readable
 * list, rather than surfacing as a null deref three layers down.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(4000),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
      message: 'must be a postgres:// or postgresql:// connection string',
    }),
  /** Signing key for the 15-minute bearer tokens (PLAN.md §4). */
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  /** Run the seed script on boot — the compose entrypoint reads this (PLAN.md §10). */
  SEED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Echo every emitted SQL statement. This is the walkthrough Q3 proof surface: it
   * shows that an interviewer-scoped request never names `email`/`phone` (PLAN.md §12).
   */
  LOG_QUERIES: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * PLAN.md §1 layer 3: run interviewer reads as the `app_interviewer` role, which
   * Postgres has stripped of `email`/`phone` and put behind a row policy.
   *
   * - `auto` (default) — use it where prisma/rls.sql has been run, carry on without it
   *   where it has not. Layers 1 and 2 are unconditional, so "without it" is still
   *   correct, merely thinner. `GET /health` reports which.
   * - `require` — a missing layer 3 is a boot failure. For any deployment that has
   *   decided the database must be the one refusing.
   * - `off` — never switch role.
   */
  DB_RLS: z.enum(['auto', 'require', 'off']).default('auto'),
  /**
   * Serve `GET /docs` and `GET /openapi.json`.
   *
   * These are anonymous routes, and PLAN.md §4 says there are exactly two of those. Left
   * ungated they would quietly become four, so the default is derived rather than fixed:
   * on outside production. A deployment that wants the browsable spec has to say so,
   * which is the right way round — compose sets it explicitly for the walkthrough.
   */
  ENABLE_DOCS: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.issues.map(
    (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  console.error(`Invalid environment configuration:\n${lines.join('\n')}`);
  console.error('\nCopy .env.example to .env and fill in the blanks.');
  process.exit(1);
}

export const env = {
  ...parsed.data,
  ENABLE_DOCS: parsed.data.ENABLE_DOCS ?? parsed.data.NODE_ENV !== 'production',
};
export type Env = typeof env;
