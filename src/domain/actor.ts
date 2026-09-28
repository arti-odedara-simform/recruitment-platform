import type { UserRole } from '@prisma/client';

/**
 * The authenticated caller, as every layer below the HTTP boundary sees it.
 *
 * This is the argument PLAN.md §1 makes structural: "there is no repository function
 * that returns a candidate without an `actor: { id, role }` argument". Keeping it to
 * exactly those two fields is deliberate — a repository decides scope from *who is
 * asking*, and widening this type would invite passing request-shaped data into the
 * data-access layer.
 *
 * It is also exactly what the bearer token carries (`sub` + `role`), so an actor can be
 * reconstructed on every request without a database round-trip.
 */
export interface Actor {
  id: string;
  role: UserRole;
}
