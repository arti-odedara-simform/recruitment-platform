import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { query, validate } from '../middleware/validate.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';
import { listStaff } from '../../services/user.service.js';
import { registerOperation } from '../openapi/registry.js';
import { PROBLEM_RESPONSES, publicUserSchema } from '../openapi/schemas.js';

export const usersRouter = Router();

const DEFAULT_LIMIT = 100;

const listQuery = z.object({
  role: z
    .enum(UserRole)
    .optional()
    .meta({ description: 'Narrow to one role. Omitted returns every account, by name.' }),
  limit: z.coerce.number().int().min(1).max(500).default(DEFAULT_LIMIT),
});

type ListQuery = z.infer<typeof listQuery>;

registerOperation({
  method: 'get',
  path: '/users',
  tags: ['Users'],
  summary: 'The staff directory, for the pickers that need an id',
  description:
    'Two recruiter actions name a user by id — `POST /rounds/:id/assignments` takes an ' +
    'interviewer, `POST /roles` takes a hiring manager — and both verify the role they ' +
    'were handed. This is where a client gets the id to send.\n\n' +
    '**Recruiters only.** Nobody else assigns or opens reqs, so nobody else has a ' +
    'reason to enumerate accounts; an interviewer able to list the panel would learn ' +
    'who else is interviewing a candidate ahead of their own round.\n\n' +
    'Staff accounts, not candidates: `email` here is a colleague’s work address, and it ' +
    'is not the restricted contact data PLAN.md §1 is about. `passwordHash` is not in ' +
    'the field set at all.',
  request: { query: listQuery },
  responses: [
    { status: 200, description: 'Accounts in scope, by name.', schema: z.array(publicUserSchema) },
    PROBLEM_RESPONSES.badRequest,
    PROBLEM_RESPONSES.unauthorized,
    { ...PROBLEM_RESPONSES.forbidden, description: 'Recruiters only.' },
  ],
});

usersRouter.get(
  '/users',
  requireAuth,
  requireRole(UserRole.RECRUITER),
  validate({ query: listQuery }),
  async (req: Request, res: Response) => {
    const { role, limit } = query<ListQuery>(req);
    res.status(200).json(await listStaff(actorOf(req), { role, limit }));
  },
);
