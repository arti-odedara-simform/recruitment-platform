import jwt from 'jsonwebtoken';
import { UserRole } from '@prisma/client';
import { z } from 'zod';
import { env } from '../config/env.js';
import { UnauthorizedError } from '../errors/AppError.js';
import type { Actor } from '../domain/actor.js';

/** PLAN.md §4: 15-minute bearer tokens. */
export const TOKEN_TTL_SECONDS = 15 * 60;

const ISSUER = 'recruitment-pipeline-poc';
const AUDIENCE = 'recruitment-pipeline-poc-api';

/**
 * Pinned on both sides. Signing with one algorithm but verifying with "whatever the
 * header says" is the classic JWT break: an attacker re-signs the payload with
 * `alg: none`, or with HS256 against a public key the server published. jsonwebtoken v9
 * rejects `none` on its own, but naming the single acceptable algorithm here means the
 * guarantee does not depend on a library default.
 */
const ALGORITHM = 'HS256' as const;

/**
 * The claims an access token carries — the `Actor` (PLAN.md §1) and nothing else. No
 * name, no email: a token is quoted in logs and error reports, and it should not be a
 * place personal data leaks from.
 */
const claimsSchema = z.object({
  sub: z.string().min(1),
  role: z.enum(UserRole),
});

export function signAccessToken(actor: Actor): string {
  return jwt.sign({ role: actor.role }, env.JWT_SECRET, {
    algorithm: ALGORITHM,
    subject: actor.id,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: TOKEN_TTL_SECONDS,
  });
}

/**
 * Verifies signature, expiry, issuer and audience, then re-validates the payload shape
 * before trusting it.
 *
 * The shape check is not paranoia about our own signer: it is what makes the `Actor`
 * returned here honestly typed. A token signed by an *older* build of this service could
 * carry a role string that is no longer a `UserRole` member, and an unchecked cast would
 * hand a bogus role to `requireRole`.
 */
export function verifyAccessToken(token: string): Actor {
  let payload: unknown;

  try {
    payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: [ALGORITHM],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new UnauthorizedError('The bearer token has expired. Log in again.');
    }
    // Signature failure, wrong issuer/audience, malformed token — all one message, so a
    // caller cannot probe which part of the token the server disliked.
    throw new UnauthorizedError('The bearer token is not valid.');
  }

  const claims = claimsSchema.safeParse(payload);
  if (!claims.success) {
    throw new UnauthorizedError('The bearer token is not valid.');
  }

  return { id: claims.data.sub, role: claims.data.role };
}
