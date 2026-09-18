import type { UserRole } from '@prisma/client';
import { prisma } from '../db/client.js';
import { normalizeEmail } from './user.repository.js';

/**
 * Write access for the seed script, kept in `src/repositories/**` because that is the
 * only place the lint rule permits the Prisma client (PLAN.md §1).
 *
 * `upsert` rather than `create`: the container entrypoint runs the seed on every boot
 * with `SEED=true`, so it has to be idempotent. A re-run resets a seeded account's
 * password and role back to the documented values, which is what you want from a demo
 * fixture and never what you want from a real user table — hence a separate module
 * whose only caller is `src/seed.ts`.
 */
export async function upsertUser(user: {
  email: string;
  name: string;
  role: UserRole;
  passwordHash: string;
}): Promise<{ id: string }> {
  const email = normalizeEmail(user.email);

  return prisma.user.upsert({
    where: { email },
    create: { ...user, email },
    update: { name: user.name, role: user.role, passwordHash: user.passwordHash },
    select: { id: true },
  });
}
