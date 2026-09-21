import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Stage, UserRole } from '@prisma/client';
import { query, validate } from '../middleware/validate.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';
import { getPipeline, getStuck } from '../../services/pipeline.service.js';
import { registerOperation } from '../openapi/registry.js';
import { PROBLEM_RESPONSES } from '../openapi/schemas.js';

export const pipelineRouter = Router();

const pipelineQuery = z.object({
  roleId: z
    .uuid()
    .optional()
    .meta({ description: 'Narrow the view to one open req.' }),
});

type PipelineQuery = z.infer<typeof pipelineQuery>;

const stageSummarySchema = z
  .strictObject({
    stage: z.enum(Stage),
    candidates: z.int(),
    averageAgeDays: z.number(),
    oldestAgeDays: z.number(),
  })
  .meta({
    id: 'PipelineStage',
    description:
      'Ageing is time in the *current* stage, from `Application.currentStageEnteredAt` — ' +
      'written in the same transaction as every stage change, so it cannot drift from ' +
      'the audit trail.',
  });

const roleSummarySchema = z
  .strictObject({
    roleId: z.uuid(),
    title: z.string(),
    totalCandidates: z.int(),
    stages: z.array(stageSummarySchema),
  })
  .meta({
    id: 'PipelineRole',
    description:
      'One open req. `stages` carries only the stages that hold candidates, so an empty ' +
      'array is an open req nobody has applied to.',
  });

registerOperation({
  method: 'get',
  path: '/pipeline',
  tags: ['Pipeline'],
  summary: 'Candidate counts and ageing, per stage, per open req',
  description:
    'One grouped SQL aggregate (PLAN.md §6). No application row and no candidate row ' +
    'reaches Node — the largest result this endpoint can produce is ' +
    '(open reqs x stages), whether the pipeline holds fifteen candidates or twenty ' +
    'thousand. That is also why contact details cannot leak here: the statement never ' +
    'touches the candidate table.\n\n' +
    '- **Recruiters** see every OPEN req.\n' +
    '- **Hiring managers** see only their own, and the restriction is a predicate in ' +
    'the same statement — passing another manager’s `roleId` returns an empty view ' +
    'rather than a filtered one.\n' +
    '- CLOSED reqs are never included. A closed req is history, not pipeline.',
  request: { query: pipelineQuery },
  responses: [
    {
      status: 200,
      description: 'One entry per open req in scope, by title.',
      schema: z.array(roleSummarySchema),
    },
    PROBLEM_RESPONSES.badRequest,
    PROBLEM_RESPONSES.unauthorized,
    {
      ...PROBLEM_RESPONSES.forbidden,
      description: 'Interviewers have no pipeline view (PLAN.md §4).',
    },
  ],
});

pipelineRouter.get(
  '/pipeline',
  requireAuth,
  requireRole(UserRole.RECRUITER, UserRole.HIRING_MANAGER),
  validate({ query: pipelineQuery }),
  async (req: Request, res: Response) => {
    res.status(200).json(await getPipeline(actorOf(req), query<PipelineQuery>(req)));
  },
);

// ---------------------------------------------------------------------------
// GET /pipeline/stuck
// ---------------------------------------------------------------------------

const DEFAULT_DAYS = 14;
const DEFAULT_LIMIT = 100;

const stuckQuery = z.object({
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .default(DEFAULT_DAYS)
    .meta({ description: `Days in the current stage to count as stuck. Default ${DEFAULT_DAYS}.` }),
  roleId: z.uuid().optional().meta({ description: 'Narrow to one open req.' }),
  limit: z.coerce.number().int().min(1).max(500).default(DEFAULT_LIMIT),
});

type StuckQuery = z.infer<typeof stuckQuery>;

const stuckSchema = z
  .strictObject({
    applicationId: z.uuid(),
    candidate: z.strictObject({ id: z.uuid(), name: z.string() }),
    roleId: z.uuid(),
    roleTitle: z.string(),
    currentStage: z.enum(Stage),
    currentStageEnteredAt: z.iso.datetime(),
    daysInStage: z.number(),
  })
  .meta({
    id: 'StuckApplication',
    description:
      'The candidate carries `id` and `name` only — a recruiter reads contact details ' +
      'from `GET /candidates/:id`, and a hiring manager may not read them at all.',
  });

registerOperation({
  method: 'get',
  path: '/pipeline/stuck',
  tags: ['Pipeline'],
  summary: 'Applications sitting in one stage longer than N days',
  description:
    'The counterpart to `GET /pipeline`: that one answers *how many*, this one answers ' +
    '*which*, so it returns rows — bounded by `limit`, oldest first.\n\n' +
    '**HIRED and REJECTED are excluded.** A candidate hired six months ago is not stuck, ' +
    'they are done; terminal stages have no exit in the stage machine, so an ageing ' +
    'clock on them measures nothing anyone can act on. Closed reqs are excluded for the ' +
    'same reason they are absent from the aggregate.\n\n' +
    'Scoped like the aggregate: recruiters see every open req, hiring managers only ' +
    'their own, and the restriction is a predicate in the same query. Rides the ' +
    '`(currentStage, currentStageEnteredAt)` index, which is worth about 3x at a '+
    'selective threshold and is ignored at a loose one — see docs/query-plans.md §4.',
  request: { query: stuckQuery },
  responses: [
    {
      status: 200,
      description: 'Stuck applications, longest-waiting first.',
      schema: z.array(stuckSchema),
    },
    PROBLEM_RESPONSES.badRequest,
    PROBLEM_RESPONSES.unauthorized,
    {
      ...PROBLEM_RESPONSES.forbidden,
      description: 'Interviewers have no pipeline view (PLAN.md §4).',
    },
  ],
});

pipelineRouter.get(
  '/pipeline/stuck',
  requireAuth,
  requireRole(UserRole.RECRUITER, UserRole.HIRING_MANAGER),
  validate({ query: stuckQuery }),
  async (req: Request, res: Response) => {
    res.status(200).json(await getStuck(actorOf(req), query<StuckQuery>(req)));
  },
);
