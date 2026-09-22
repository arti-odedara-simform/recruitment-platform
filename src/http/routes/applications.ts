import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { RoleStatus, Stage, TransitionKind, UserRole } from '@prisma/client';
import { body, params, query, validate } from '../middleware/validate.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';
import {
  advance,
  createApplication,
  listApplications,
  override,
} from '../../services/application.service.js';
import { ALLOWED, MIN_OVERRIDE_REASON_LENGTH } from '../../domain/stageMachine.js';
import { registerOperation } from '../openapi/registry.js';
import { PROBLEM_RESPONSES } from '../openapi/schemas.js';

export const applicationsRouter = Router();

/**
 * PLAN.md §2 took a surrogate `id` on Application but kept the §4 two-segment routes:
 * an application is identified by the pair it is unique on, which is also the pair a
 * recruiter has in hand.
 */
const targetParams = z.object({
  candidateId: z.uuid(),
  roleId: z.uuid(),
});

type TargetParams = z.infer<typeof targetParams>;

/**
 * Shape only (PLAN.md §7): is `toStage` a member of the enum. Whether the move is *legal*
 * from the application's current stage is domain logic and lives in the stage machine —
 * this schema deliberately does not know the ALLOWED table exists.
 */
const advanceSchema = z.object({
  toStage: z.enum(Stage).meta({ examples: [Stage.SCREEN] }),
});

const overrideSchema = z.object({
  toStage: z.enum(Stage).meta({ examples: [Stage.OFFER] }),
  /**
   * The same floor the domain asserts and the `override_requires_reason` CHECK enforces
   * — three layers, one constant. Trimmed before measuring, so ten spaces is not a
   * reason.
   */
  reason: z
    .string()
    .trim()
    .min(MIN_OVERRIDE_REASON_LENGTH, `must be at least ${MIN_OVERRIDE_REASON_LENGTH} characters`)
    .max(1000)
    .meta({ examples: ['Strong internal referral, skipping the screen round.'] }),
});

type AdvanceBody = z.infer<typeof advanceSchema>;
type OverrideBody = z.infer<typeof overrideSchema>;

const applicationSchema = z
  .strictObject({
    applicationId: z.uuid(),
    candidateId: z.uuid(),
    roleId: z.uuid(),
    currentStage: z.enum(Stage),
    currentStageEnteredAt: z.iso.datetime(),
  })
  .meta({ id: 'ApplicationStage' });

const transitionSchema = z
  .strictObject({
    id: z.uuid(),
    fromStage: z.enum(Stage),
    toStage: z.enum(Stage),
    kind: z.enum(TransitionKind),
    reason: z.string().nullable(),
    actorId: z.uuid(),
    occurredAt: z.iso.datetime(),
  })
  .meta({
    id: 'StageTransition',
    description:
      'The append-only audit row written in the same transaction as the stage change ' +
      '(PLAN.md §8). An AuditEvent is written alongside it.',
  });

const transitionResultSchema = z
  .strictObject({ application: applicationSchema, transition: transitionSchema })
  .meta({ id: 'StageTransitionResult' });

// ---------------------------------------------------------------------------
// GET /applications
// ---------------------------------------------------------------------------

const DEFAULT_LIST_LIMIT = 100;

const listQuery = z.object({
  roleId: z.uuid().optional().meta({ description: 'Narrow to one req.' }),
  stage: z.enum(Stage).optional().meta({ description: 'Narrow to one stage.' }),
  roleStatus: z
    .enum([RoleStatus.OPEN, RoleStatus.CLOSED, 'ALL'])
    .default(RoleStatus.OPEN)
    .meta({ description: 'Status of the req, not the application. Defaults to OPEN, as `GET /roles` does.' }),
  limit: z.coerce.number().int().min(1).max(500).default(DEFAULT_LIST_LIMIT),
});

type ListQuery = z.infer<typeof listQuery>;

const applicationListItemSchema = z
  .strictObject({
    applicationId: z.uuid(),
    candidate: z.strictObject({ id: z.uuid(), name: z.string() }),
    roleId: z.uuid(),
    roleTitle: z.string(),
    roleStatus: z.enum(RoleStatus),
    currentStage: z.enum(Stage),
    currentStageEnteredAt: z.iso.datetime(),
    daysInStage: z.number(),
    roundCount: z.int(),
  })
  .meta({
    id: 'ApplicationListItem',
    description:
      'The candidate carries `id` and `name` only — the same field set ' +
      '`GET /pipeline/stuck` returns, and for the same two reasons: contact details are ' +
      'read one record at a time from `GET /candidates/:id`, and this endpoint also ' +
      'serves hiring managers, who may not read them at all (PLAN.md §1).',
  });

registerOperation({
  method: 'get',
  path: '/applications',
  tags: ['Applications'],
  summary: 'Who is on which req, and where they are',
  description:
    'The list a recruiter works from. `GET /pipeline` answers *how many* and ' +
    '`GET /pipeline/stuck` answers *which ones are late*; this answers *who*, and it is ' +
    'the screen the stage and round actions are reached from.\n\n' +
    '- **Recruiters** see every req.\n' +
    '- **Hiring managers** see applications on the reqs they own, and the restriction is ' +
    'a predicate in the same query — another manager’s `?roleId=` returns an empty list ' +
    'rather than a filtered one. They read it; every action on it is recruiter-only.\n' +
    '- **Interviewers** have no access. A list of everyone in the pipeline, by name, is ' +
    'the opposite of what the assignment scope exists to do.\n\n' +
    'Open reqs by default, longest-waiting first, bounded by `limit`.',
  request: { query: listQuery },
  responses: [
    {
      status: 200,
      description: 'Applications in scope, longest-waiting in their current stage first.',
      schema: z.array(applicationListItemSchema),
    },
    PROBLEM_RESPONSES.badRequest,
    PROBLEM_RESPONSES.unauthorized,
    { ...PROBLEM_RESPONSES.forbidden, description: 'Interviewers work from `GET /me/rounds`.' },
  ],
});

applicationsRouter.get(
  '/applications',
  requireAuth,
  requireRole(UserRole.RECRUITER, UserRole.HIRING_MANAGER),
  validate({ query: listQuery }),
  async (req: Request, res: Response) => {
    res.status(200).json(await listApplications(actorOf(req), query<ListQuery>(req)));
  },
);

// ---------------------------------------------------------------------------
// POST /applications
// ---------------------------------------------------------------------------

const createApplicationSchema = z.object({
  candidateId: z.uuid(),
  roleId: z.uuid().meta({ description: 'Must be an OPEN req.' }),
});

type CreateApplicationBody = z.infer<typeof createApplicationSchema>;

registerOperation({
  method: 'post',
  path: '/applications',
  tags: ['Applications'],
  summary: 'Put a candidate onto a req',
  description:
    'The pipeline unit comes into existence here, at `APPLIED`. Every later stage is ' +
    'the stage machine’s business (PLAN.md §3), so there is no `stage` input.\n\n' +
    'Only two things are checked in application code: that the req exists, and that it ' +
    'is OPEN — both inside the transaction. A candidate who does not exist is refused ' +
    'by the foreign key (404) and a candidate already on this req by the unique index ' +
    '(409), rather than by a read-then-write with a window in it (PLAN.md §5, §7).\n\n' +
    'No `StageTransition` row: there is no stage it moved *from*. The creation is ' +
    'recorded as an `AuditEvent` in the same transaction, and ' +
    '`GET /audit/candidates/:id` merges it into the timeline ahead of the transitions ' +
    'that follow.',
  request: { body: createApplicationSchema },
  responses: [
    { status: 201, description: 'The candidate is on the req, at APPLIED.', schema: applicationSchema },
    {
      ...PROBLEM_RESPONSES.badRequest,
      description: 'The req is CLOSED, among the usual shape failures.',
    },
    PROBLEM_RESPONSES.unauthorized,
    { ...PROBLEM_RESPONSES.forbidden, description: 'Recruiters only (PLAN.md §3).' },
    {
      status: 404,
      description: 'No such req, or no such candidate.',
      schema: PROBLEM_RESPONSES.unauthorized.schema,
    },
    {
      status: 409,
      description: 'That candidate is already on that req.',
      schema: PROBLEM_RESPONSES.unauthorized.schema,
    },
  ],
});

applicationsRouter.post(
  '/applications',
  requireAuth,
  requireRole(UserRole.RECRUITER),
  validate({ body: createApplicationSchema }),
  async (req: Request, res: Response) => {
    const input = body<CreateApplicationBody>(req);
    res.status(201).json(await createApplication(actorOf(req), input));
  },
);

/** The 422 an illegal move produces, carrying the legal set (PLAN.md §3). */
const invalidTransitionResponse = {
  status: 422,
  description:
    'A move the stage machine does not permit — for example APPLIED -> OFFER without an ' +
    'override, or any move out of HIRED/REJECTED. The body carries `from`, `to` and the ' +
    'legal `allowed` set.',
  schema: PROBLEM_RESPONSES.unauthorized.schema,
} as const;

registerOperation({
  method: 'patch',
  path: '/applications/:candidateId/:roleId/stage',
  tags: ['Applications'],
  summary: 'Advance an application one stage',
  description:
    'A normal transition, one step along the stage machine:\n\n' +
    Object.entries(ALLOWED)
      .map(([from, to]) => `- \`${from}\` → ${to.length ? to.map((s) => `\`${s}\``).join(', ') : '_terminal_'}`)
      .join('\n') +
    '\n\nRecruiters only. Feedback never advances a stage on its own (PLAN.md §5). The ' +
    'update, a `StageTransition` row and an `AuditEvent` are written in one transaction ' +
    'against a `SELECT ... FOR UPDATE` lock, so a stage cannot move without a trace.',
  request: { params: targetParams, body: advanceSchema },
  responses: [
    { status: 200, description: 'The application moved.', schema: transitionResultSchema },
    PROBLEM_RESPONSES.badRequest,
    PROBLEM_RESPONSES.unauthorized,
    {
      ...PROBLEM_RESPONSES.forbidden,
      description: 'Only recruiters may move an application between stages (PLAN.md §3).',
    },
    {
      status: 404,
      description: 'No application for that candidate and role.',
      schema: PROBLEM_RESPONSES.unauthorized.schema,
    },
    invalidTransitionResponse,
  ],
});

applicationsRouter.patch(
  '/applications/:candidateId/:roleId/stage',
  requireAuth,
  requireRole(UserRole.RECRUITER),
  validate({ params: targetParams, body: advanceSchema }),
  async (req: Request, res: Response) => {
    const target = params<TargetParams>(req);
    const { toStage } = body<AdvanceBody>(req);
    res.status(200).json(await advance(actorOf(req), target, toStage));
  },
);

registerOperation({
  method: 'post',
  path: '/applications/:candidateId/:roleId/override',
  tags: ['Applications'],
  summary: 'Skip stages, on the record',
  description:
    'An override may jump the queue — that is its purpose — but it still cannot leave ' +
    '`HIRED` or `REJECTED`, it is restricted to recruiters, and it requires a reason of ' +
    `at least ${MIN_OVERRIDE_REASON_LENGTH} characters.\n\n` +
    'The reason is enforced three times: by this schema, by the stage machine, and by ' +
    'the `override_requires_reason` CHECK constraint in the database. The last one is ' +
    'the one that matters — an override with no reason is refused by Postgres even if ' +
    'the service layer is bypassed entirely (PLAN.md §2, §12 Q2).',
  request: { params: targetParams, body: overrideSchema },
  responses: [
    { status: 200, description: 'The application moved, with the reason recorded.', schema: transitionResultSchema },
    {
      ...PROBLEM_RESPONSES.badRequest,
      description: 'A missing or too-short reason, among the usual shape failures.',
    },
    PROBLEM_RESPONSES.unauthorized,
    {
      ...PROBLEM_RESPONSES.forbidden,
      description: 'Overrides are restricted to recruiters (PLAN.md §3).',
    },
    {
      status: 404,
      description: 'No application for that candidate and role.',
      schema: PROBLEM_RESPONSES.unauthorized.schema,
    },
    {
      ...invalidTransitionResponse,
      description: 'An override out of a terminal stage, or onto the stage it is already in.',
    },
  ],
});

applicationsRouter.post(
  '/applications/:candidateId/:roleId/override',
  requireAuth,
  requireRole(UserRole.RECRUITER),
  validate({ params: targetParams, body: overrideSchema }),
  async (req: Request, res: Response) => {
    const target = params<TargetParams>(req);
    const { toStage, reason } = body<OverrideBody>(req);
    res.status(200).json(await override(actorOf(req), target, toStage, reason));
  },
);
