import { z } from 'zod';
import { UserRole } from '@prisma/client';

/**
 * The RFC-7807-ish problem shape every error in this API serialises to (PLAN.md §4).
 * Mirrors `ProblemDetails` in src/errors/AppError.ts; the contract test parses real
 * error responses against it, so the two cannot drift apart silently.
 */
export const problemSchema = z
  .object({
    type: z.string().meta({ examples: ['https://httpstatuses.io/401'] }),
    title: z.string().meta({ examples: ['Unauthorized'] }),
    status: z.int().meta({ examples: [401] }),
    detail: z.string().optional().meta({ examples: ['Invalid email or password.'] }),
    errors: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional()
      .meta({ description: 'Present on 400s: one entry per field that failed validation.' }),
  })
  .meta({
    id: 'Problem',
    description: 'RFC-7807-ish problem details. No raw Prisma or stack trace ever reaches a client.',
  });

/** Reusable response entries, so every route documents its failures the same way. */
export const PROBLEM_RESPONSES = {
  badRequest: {
    status: 400,
    description: 'The request failed shape validation, before any domain logic ran (PLAN.md §7).',
    schema: problemSchema,
  },
  unauthorized: {
    status: 401,
    description:
      'No token, a malformed Authorization header, or a token that is expired, forged or ' +
      'issued to an account that no longer exists. Carries `WWW-Authenticate: Bearer`.',
    schema: problemSchema,
  },
  forbidden: {
    status: 403,
    description:
      'Authenticated, but the wrong role. Note that an out-of-scope *resource* 404s ' +
      'instead — a 403 there would confirm the record exists (PLAN.md §4).',
    schema: problemSchema,
  },
} as const;

/**
 * The user shape that may leave the API — `passwordHash` is not in it (PLAN.md §1).
 *
 * It lives here rather than next to one of its routes because three of them now return
 * it: `POST /auth/login`, `GET /auth/me` and `GET /users`. A second definition carrying
 * the same `.meta({ id })` would overwrite the first in `components.schemas`, so the
 * document would silently describe whichever route was registered last.
 */
export const publicUserSchema = z
  .object({
    id: z.uuid(),
    email: z.email(),
    name: z.string(),
    role: z.enum(UserRole),
  })
  .meta({ id: 'PublicUser' });
