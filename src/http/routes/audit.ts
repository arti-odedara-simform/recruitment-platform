import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Stage, TransitionKind, UserRole } from '@prisma/client';
import { params, validate } from '../middleware/validate.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';
import { getCandidateAudit } from '../../services/audit.service.js';
import { registerOperation } from '../openapi/registry.js';
import { PROBLEM_RESPONSES } from '../openapi/schemas.js';

export const auditRouter = Router();

const candidateParams = z.object({ id: z.uuid() });
type CandidateParams = z.infer<typeof candidateParams>;

const timelineActorSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  role: z.enum(UserRole),
});

const transitionEntrySchema = z
  .strictObject({
    type: z.literal('STAGE_TRANSITION'),
    id: z.uuid(),
    occurredAt: z.iso.datetime(),
    roleId: z.uuid(),
    fromStage: z.enum(Stage),
    toStage: z.enum(Stage),
    kind: z.enum(TransitionKind),
    reason: z.string().nullable(),
    actor: timelineActorSchema,
  })
  .meta({
    id: 'TimelineTransition',
    description:
      'Where an application moved, by whom, and — for an OVERRIDE — why. The reason is ' +
      'not optional at the database level: `override_requires_reason` refuses the row.',
  });

const eventEntrySchema = z
  .strictObject({
    type: z.literal('AUDIT_EVENT'),
    id: z.uuid(),
    occurredAt: z.iso.datetime(),
    action: z.string().meta({
      description:
        'ROLE_OPENED | APPLICATION_CREATED | ROUND_CREATED | ASSIGNMENT_CREATED | ' +
        'FEEDBACK_SUBMITTED | STAGE_ADVANCED | STAGE_OVERRIDDEN',
    }),
    entity: z.string(),
    entityId: z.uuid(),
    payload: z.unknown().optional(),
    actor: timelineActorSchema,
  })
  .meta({
    id: 'TimelineEvent',
    description:
      '`payload` is present for recruiters and absent for hiring managers — a ' +
      'FEEDBACK_SUBMITTED payload carries the rating, and a hiring manager refused ' +
      'feedback by `GET /rounds/:id/feedback` should not collect it here instead. The ' +
      'event itself — who, which round, when — is still theirs to see.',
  });

const auditSchema = z
  .strictObject({
    candidate: z.strictObject({ id: z.uuid(), name: z.string() }),
    applications: z.array(
      z.strictObject({
        applicationId: z.uuid(),
        roleId: z.uuid(),
        roleTitle: z.string(),
        currentStage: z.enum(Stage),
        createdAt: z.iso.datetime(),
      }),
    ),
    timeline: z.array(z.union([transitionEntrySchema, eventEntrySchema])),
  })
  .meta({
    id: 'CandidateAudit',
    description:
      'The candidate carries `id` and `name` only. An audit timeline has no use for ' +
      'contact details, and a read that does not select a column cannot leak it ' +
      '(PLAN.md §1).',
  });

registerOperation({
  method: 'get',
  path: '/audit/candidates/:id',
  tags: ['Audit'],
  summary: 'Everything recorded about a candidate, in order',
  description:
    'The answer to *"a candidate disputes how they were assessed"* (PLAN.md §8).\n\n' +
    'Two append-only tables merged into one timeline: `StageTransition` for where an ' +
    'application moved and why, `AuditEvent` for everything else — the req opening, the ' +
    'application, rounds, assignments, feedback. Every row was written **inside the ' +
    'transaction that made the change**, so if the audit write had failed the change ' +
    'would have rolled back with it. This is a reconstruction, not a log that may or ' +
    'may not have been flushed.\n\n' +
    '- **Recruiters** read any candidate.\n' +
    '- **Hiring managers** read candidates on their own reqs, and see only the ' +
    'applications on those reqs — a candidate outside them 404s rather than 403s, ' +
    'because the scope is in the query (PLAN.md §4).\n' +
    '- **Interviewers** have no access at all. A panel member reading the prior ' +
    'ratings and the recruiter’s override reasons before their own round is exactly ' +
    'the pollution the assignment scope exists to prevent.',
  request: { params: candidateParams },
  responses: [
    { status: 200, description: 'The candidate’s timeline, oldest first.', schema: auditSchema },
    PROBLEM_RESPONSES.badRequest,
    PROBLEM_RESPONSES.unauthorized,
    { ...PROBLEM_RESPONSES.forbidden, description: 'Interviewers do not read audit trails.' },
    {
      status: 404,
      description:
        'No such candidate — or, for a hiring manager, one who has not applied to any ' +
        'of their reqs. The two cases return the same body by design.',
      schema: PROBLEM_RESPONSES.unauthorized.schema,
    },
  ],
});

auditRouter.get(
  '/audit/candidates/:id',
  requireAuth,
  requireRole(UserRole.RECRUITER, UserRole.HIRING_MANAGER),
  validate({ params: candidateParams }),
  async (req: Request, res: Response) => {
    res.status(200).json(await getCandidateAudit(actorOf(req), params<CandidateParams>(req).id));
  },
);
