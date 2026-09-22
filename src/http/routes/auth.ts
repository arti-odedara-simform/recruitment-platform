import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { body, validate } from '../middleware/validate.js';
import { actorOf, requireAuth } from '../middleware/auth.js';
import { describeActor, login } from '../../services/auth.service.js';
import { registerOperation } from '../openapi/registry.js';
import { PROBLEM_RESPONSES, publicUserSchema } from '../openapi/schemas.js';

export const authRouter = Router();

/**
 * Shape only, as PLAN.md §7 requires: is this a syntactically plausible email, is a
 * password present. Whether the credentials are *correct* is the service's business, and
 * the failure for a 20-character password is identical to the failure for a wrong one —
 * so no password policy is asserted here. Rejecting a short password at the boundary
 * would tell a caller their guess was too short to be this account's password.
 *
 * This object is both the validator and the documented request body — see
 * src/http/openapi/registry.ts for why those must be the same object.
 */
const loginSchema = z.object({
  // Trimmed *before* the email check, not after: a pasted address routinely arrives with
  // a trailing space, and rejecting it as malformed would be a shape complaint about
  // something that is not a shape problem. Casing is left alone here — normalising it is
  // a storage concern and lives in one place, `normalizeEmail` in the user repository.
  email: z
    .string()
    .trim()
    .pipe(z.email({ message: 'must be a valid email address' }).max(320))
    .meta({
      format: 'email',
      description: 'Surrounding whitespace is trimmed; matching is case-insensitive.',
      examples: ['rachel.recruiter@example.com'],
    }),
  password: z
    .string()
    .min(1, 'is required')
    .max(200)
    .meta({ examples: ['poc-dev-password'] }),
});

type LoginBody = z.infer<typeof loginSchema>;

const loginResponseSchema = z
  .object({
    token: z.string().meta({ description: 'HS256 JWT. Carries only `sub` and `role`.' }),
    tokenType: z.literal('Bearer'),
    expiresIn: z.int().meta({ description: 'Seconds until the token expires.', examples: [900] }),
    user: publicUserSchema,
  })
  .meta({ id: 'LoginResponse' });

/**
 * One of only two unauthenticated routes (PLAN.md §4). Returns a 15-minute bearer token
 * plus the caller's own public record, so a client does not need a second call to learn
 * its role.
 */
registerOperation({
  method: 'post',
  path: '/auth/login',
  tags: ['Auth'],
  security: 'none',
  summary: 'Exchange credentials for a 15-minute bearer token',
  description:
    'One of only two routes that accept an anonymous caller (PLAN.md §4).\n\n' +
    'A wrong password and an unknown account return the *same* 401 body and take the ' +
    'same ~250ms — the response is not an account-enumeration oracle. Seeded development ' +
    'credentials are in README.md.',
  request: { body: loginSchema },
  responses: [
    { status: 200, description: 'Credentials accepted.', schema: loginResponseSchema },
    PROBLEM_RESPONSES.badRequest,
    {
      ...PROBLEM_RESPONSES.unauthorized,
      description: 'Invalid email or password — deliberately indistinguishable cases.',
    },
  ],
});

authRouter.post(
  '/auth/login',
  validate({ body: loginSchema }),
  async (req: Request, res: Response) => {
    const { email, password } = body<LoginBody>(req);
    res.status(200).json(await login(email, password));
  },
);

/**
 * Who the bearer token says you are, resolved against the current row rather than echoed
 * from the claims — see `describeActor`. Useful on its own, and it is the smoke test for
 * the whole chain: header parsed, signature verified, actor attached.
 */
registerOperation({
  method: 'get',
  path: '/auth/me',
  tags: ['Auth'],
  summary: 'The account behind the bearer token',
  description:
    'Read against the current row rather than echoed from the token claims, so an account ' +
    'deleted inside the 15-minute window gets a 401 rather than a stale answer.',
  responses: [
    { status: 200, description: 'The authenticated account.', schema: publicUserSchema },
    PROBLEM_RESPONSES.unauthorized,
  ],
});

authRouter.get('/auth/me', requireAuth, async (req: Request, res: Response) => {
  res.status(200).json(await describeActor(actorOf(req).id));
});
