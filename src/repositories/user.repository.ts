import type { UserRole } from '@prisma/client';
import { prisma } from '../db/client.js';

/**
 * Field sets, the same discipline PLAN.md §1 applies to candidates: two hard-coded
 * `select` objects, and the restricted column is named in exactly one of them.
 *
 * Here the restricted column is `passwordHash`. `USER_SELECT.public` does not name it at
 * all, so a handler that serialises a user cannot leak it — the wide shape never reaches
 * the serializer. `withCredentials` is used by exactly one function, consumed by exactly
 * one service, and its result never leaves `authService.login`.
 */
export const USER_SELECT = {
  public: {
    id: true,
    email: true,
    name: true,
    role: true,
  },
  withCredentials: {
    id: true,
    email: true,
    name: true,
    role: true,
    passwordHash: true,
  },
} as const;

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export interface UserWithCredentials extends PublicUser {
  passwordHash: string;
}

/**
 * The one repository function in the codebase that takes no `actor`, and the only place
 * that exemption is defensible: this *is* the call that establishes who the actor is.
 * Every other read path is scoped by the caller's identity (PLAN.md §1 layer 2).
 *
 * Emails are stored and compared lower-cased — Postgres `=` on `citext` would be the
 * alternative, but normalising in one place keeps the unique index on `email` doing the
 * work rather than a functional index.
 */
export async function findUserCredentialsByEmail(
  email: string,
): Promise<UserWithCredentials | null> {
  return prisma.user.findUnique({
    where: { email: normalizeEmail(email) },
    select: USER_SELECT.withCredentials,
  });
}

/** Used by `GET /auth/me`; never returns the password hash. */
export async function findUserById(id: string): Promise<PublicUser | null> {
  return prisma.user.findUnique({
    where: { id },
    select: USER_SELECT.public,
  });
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
