import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Stage, TransitionKind, UserRole } from '@prisma/client';
import { body, params, validate } from '../middleware/validate.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';
import { advance, override } from '../../services/application.service.js';
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
