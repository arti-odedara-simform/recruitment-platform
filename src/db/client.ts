import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env.js';

/**
 * The single Prisma client.
 *
 * Architectural rule (PLAN.md §1): only modules under `src/repositories/**` may import
 * this file — enforced by the `no-restricted-imports` rule in eslint.config.js. Route
 * handlers and services go through a scoped repository that takes an `actor`, so a
 * "select everything, strip it in the serializer" path cannot be written by accident.
 *
 * Prisma 7 connects through a driver adapter rather than a `url` in schema.prisma; the
 * pg Pool below is the connection pool. Note PLAN.md §14: RLS context (stretch layer 3)
 * must be set with `SET LOCAL` *inside* `$transaction`, or it leaks across pooled
 * connections.
 */
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

export const prisma = new PrismaClient({
  adapter,
  log: [
    { emit: 'event', level: 'query' },
    { emit: 'stdout', level: 'warn' },
    { emit: 'stdout', level: 'error' },
  ],
});

if (env.LOG_QUERIES) {
  prisma.$on('query', (event) => {
    console.log(`[prisma] ${event.duration}ms  ${event.query}  -- params: ${event.params}`);
  });
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
