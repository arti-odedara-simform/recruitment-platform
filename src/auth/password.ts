import { randomBytes } from 'node:crypto';
import { compare, hash } from 'bcryptjs';

/**
 * bcrypt work factor. 12 is ~250ms on the development machine — slow enough to make
 * offline cracking of a leaked hash expensive, fast enough that the 15-minute token
 * TTL (PLAN.md §4) does not turn logins into a bottleneck.
 */
export const BCRYPT_COST = 12;

export function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, BCRYPT_COST);
}

export function verifyPassword(plaintext: string, passwordHash: string): Promise<boolean> {
  return compare(plaintext, passwordHash);
}

/**
 * Lazily-built hash of an unguessable value, used to keep the "no such user" path as
 * expensive as the "wrong password" path.
 *
 * Without it, an unknown email returns in ~1ms (one indexed SELECT) while a known email
 * with a bad password takes ~250ms (the bcrypt compare) — a timing oracle that enumerates
 * valid accounts even though both responses are an identical 401. Built on first use
 * rather than at import time so a 250ms hash does not sit in the boot path.
 */
let dummyHash: Promise<string> | null = null;

export async function simulatePasswordVerification(plaintext: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64'));
  await verifyPassword(plaintext, await dummyHash);
}
