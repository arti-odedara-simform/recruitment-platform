import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { RoleStatus, UserRole } from '@prisma/client';
import { body, query, validate } from '../middleware/validate.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';
import { createRole, listRoles } from '../../services/role.service.js';
import { registerOperation } from '../openapi/registry.js';
import { PROBLEM_RESPONSES } from '../openapi/schemas.js';

export const rolesRouter = Router();

const roleSchema = z
  .strictObject({
    id: z.uuid(),
    title: z.string(),
    status: z.enum(RoleStatus),
    openedAt: z.iso.datetime(),
    hiringManager: z.strictObject({ id: z.uuid(), name: z.string() }),
    applicationCount: z.int(),
  })
  .meta({
    id: 'Role',
    description:
      'A job req. Named `Role` per PLAN.md §2 and unrelated to `UserRole`, the ' +
      'authorization enum. `applicationCount` is an aggregate — no candidate row is ' +
      'read to produce it.',
  });

// ---------------------------------------------------------------------------
// GET /roles
// ---------------------------------------------------------------------------

const listQuery = z.object({
  status: z
    .enum([RoleStatus.OPEN, RoleStatus.CLOSED, 'ALL'])
    .default(RoleStatus.OPEN)
    .meta({ description: 'Defaults to OPEN. `ALL` is the explicit opt-in.' }),
});

type ListQuery = z.infer<typeof listQuery>;

registerOperation({
  method: 'get',
  path: '/roles',
  tags: ['Roles'],
  summary: 'List job reqs',
  description:
    'Recruiters see every req; hiring managers see the ones they own, and the ' +
    'restriction is a predicate in their query rather than a filter over a recruiter’s ' +
    'result (PLAN.md §1 layer 2).\n\n' +
    'Open reqs by default — a closed req is history. Pass `?status=CLOSED` or ' +
    '`?status=ALL` to see them.',
  request: { query: listQuery },
  responses: [
    {
      status: 200,
      description: 'Reqs in scope: open first, newest first within a status.',
      schema: z.array(roleSchema),
    },
    PROBLEM_RESPONSES.badRequest,
    PROBLEM_RESPONSES.unauthorized,
    { ...PROBLEM_RESPONSES.forbidden, description: 'Interviewers work from `GET /me/rounds`.' },
  ],
});

rolesRouter.get(
  '/roles',
  requireAuth,
  requireRole(UserRole.RECRUITER, UserRole.HIRING_MANAGER),
  validate({ query: listQuery }),
  async (req: Request, res: Response) => {
    res.status(200).json(await listRoles(actorOf(req), query<ListQuery>(req).status));
  },
);

// ---------------------------------------------------------------------------
// POST /roles
// ---------------------------------------------------------------------------

const createRoleSchema = z.object({
  title: z.string().trim().min(1).max(200).meta({ examples: ['Staff Backend Engineer'] }),
  hiringManagerId: z
    .uuid()
    .meta({ description: 'Must be a user whose role is HIRING_MANAGER — checked, not assumed.' }),
});

type CreateRoleBody = z.infer<typeof createRoleSchema>;

registerOperation({
  method: 'post',
  path: '/roles',
  tags: ['Roles'],
  summary: 'Open a req',
  description:
    'Recruiters only. The named hiring manager’s role is verified before the write, ' +
    'because ownership is what `GET /roles` and `GET /pipeline` scope a hiring manager ' +
    'by — a req owned by a recruiter would be one its "manager" could never see.\n\n' +
    'A req opens OPEN; `status` is not an input. Closing one is a distinct action with ' +
    'its own audit row and does not exist yet — the seeded CLOSED req is there so the ' +
    'pipeline aggregate has something to exclude.\n\n' +
    'Written with an `AuditEvent` in the same transaction (PLAN.md §8).',
  request: { body: createRoleSchema },
  responses: [
    { status: 201, description: 'The req is open.', schema: roleSchema },
    {
      ...PROBLEM_RESPONSES.badRequest,
      description: 'The named user is not a hiring manager, among the usual shape failures.',
    },
    PROBLEM_RESPONSES.unauthorized,
    { ...PROBLEM_RESPONSES.forbidden, description: 'Recruiters only.' },
    {
      status: 404,
      description: 'No such user.',
      schema: PROBLEM_RESPONSES.unauthorized.schema,
    },
  ],
});

rolesRouter.post(
  '/roles',
  requireAuth,
  requireRole(UserRole.RECRUITER),
  validate({ body: createRoleSchema }),
  async (req: Request, res: Response) => {
    res.status(201).json(await createRole(actorOf(req), body<CreateRoleBody>(req)));
  },
);
