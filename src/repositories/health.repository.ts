import { prisma } from '../db/client.js';

/** Cheapest possible round-trip: proves the pool can reach Postgres. */
export async function pingDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
