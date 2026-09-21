import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Stage, UserRole } from '@prisma/client';
import { body, params, validate } from '../middleware/validate.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';
import {
  assignInterviewer,
  createRound,
  getRound,
  listMyRounds,
} from '../../services/round.service.js';
import { listFeedback, submitFeedback } from '../../services/feedback.service.js';
import { registerOperation } from '../openapi/registry.js';
import { PROBLEM_RESPONSES } from '../openapi/schemas.js';

export const roundsRouter = Router();

const roundParams = z.object({ id: z.uuid() });
type RoundParams = z.infer<typeof roundParams>;

/**
 * The candidate shape inside a round view. Two variants for the same reason
 * `CANDIDATE_SELECT` has two: an interviewer's round must not carry contact details, and
 * `strictObject` makes the document say so in a way the contract test can enforce.
 */
const candidateInRoundSchema = z.union([
  z.strictObject({
    id: z.uuid(),
    name: z.string(),
    email: z.email(),
    phone: z.string().nullable(),
    createdAt: z.iso.datetime(),
  }),
  z.strictObject({ id: z.uuid(), name: z.string() }),
]);

const roundSchema = z
  .strictObject({
    id: z.uuid(),
    stage: z.enum(Stage),
    scheduledAt: z.iso.datetime(),
    applicationId: z.uuid(),
    roleId: z.uuid(),
    currentStage: z.enum(Stage).meta({ description: 'The application’s stage, not the round’s.' }),
    candidate: candidateInRoundSchema,
    feedbackCount: z.int(),
    ratings: z.array(z.int()),
  })
  .meta({
    id: 'Round',
    description:
      'The outcome fields are derived on every read, never stored (PLAN.md §5) — two ' +
      'panel members submitting at once cannot clobber a rollup that does not exist.',
  });

const feedbackSchema = z
  .strictObject({
    id: z.uuid(),
    roundId: z.uuid(),
    interviewerId: z.uuid(),
    rating: z.int(),
    notes: z.string(),
    submittedAt: z.iso.datetime(),
  })
  .meta({ id: 'Feedback' });

const peerFeedbackSchema = z
  .strictObject({
    ...feedbackSchema.shape,
    interviewer: z.strictObject({ id: z.uuid(), name: z.string() }),
  })
  .meta({ id: 'PeerFeedback' });

const notFoundResponse = {
  status: 404,
  description:
    'No such round — or one this interviewer is not assigned to. The two cases return ' +
    'the same body by design (PLAN.md §4).',
  schema: PROBLEM_RESPONSES.unauthorized.schema,
} as const;

// ---------------------------------------------------------------------------
// GET /me/rounds
// ---------------------------------------------------------------------------

registerOperation({
  method: 'get',
  path: '/me/rounds',
  tags: ['Rounds'],
  summary: 'The rounds assigned to the calling interviewer',
  description:
    'The route *is* the scope: there is no parameter that could widen it to another ' +
    'interviewer’s rounds. Candidate contact details are absent, as everywhere on the ' +
    'interviewer path (PLAN.md §1).',
  responses: [
    { status: 200, description: 'Rounds assigned to the caller, soonest first.', schema: z.array(roundSchema) },
    PROBLEM_RESPONSES.unauthorized,
    { ...PROBLEM_RESPONSES.forbidden, description: 'Only interviewers have rounds of their own.' },
  ],
});

roundsRouter.get(
  '/me/rounds',
  requireAuth,
  requireRole(UserRole.INTERVIEWER),
  async (req: Request, res: Response) => {
    res.status(200).json(await listMyRounds(actorOf(req)));
  },
);

// ---------------------------------------------------------------------------
// POST /rounds
// ---------------------------------------------------------------------------

const createRoundSchema = z.object({
  candidateId: z.uuid(),
  roleId: z.uuid(),
  stage: z.enum(Stage).meta({ description: 'The stage this round belongs to.' }),
  scheduledAt: z.iso.datetime().meta({ examples: ['2026-10-01T09:00:00.000Z'] }),
});

type CreateRoundBody = z.infer<typeof createRoundSchema>;

registerOperation({
  method: 'post',
  path: '/rounds',
  tags: ['Rounds'],
  summary: 'Schedule an interview round for an application',
  description:
    'Identified by the `(candidateId, roleId)` pair the application is unique on, the ' +
    'same pair the stage routes use.\n\n' +
    'The round’s `stage` is not checked against the application’s current stage — ' +
    'booking an interview loop while a candidate is still in SCREEN is ordinary ' +
    'recruiting. The stage machine governs where the application is, not what may be ' +
    'scheduled ahead of it.',
  request: { body: createRoundSchema },
  responses: [
    {
      status: 201,
      description: 'The round was created, with an AuditEvent in the same transaction.',
      schema: z.strictObject({ id: z.uuid(), applicationId: z.uuid() }).meta({ id: 'CreatedRound' }),
    },
    PROBLEM_RESPONSES.badRequest,
    PROBLEM_RESPONSES.unauthorized,
    { ...PROBLEM_RESPONSES.forbidden, description: 'Recruiters only.' },
    {
      status: 404,
      description: 'No application for that candidate and role.',
      schema: PROBLEM_RESPONSES.unauthorized.schema,
    },
  ],
});

roundsRouter.post(
  '/rounds',
  requireAuth,
  requireRole(UserRole.RECRUITER),
  validate({ body: createRoundSchema }),
  async (req: Request, res: Response) => {
    const input = body<CreateRoundBody>(req);
    const round = await createRound(actorOf(req), {
      candidateId: input.candidateId,
      roleId: input.roleId,
      stage: input.stage,
      scheduledAt: new Date(input.scheduledAt),
    });
    res.status(201).json(round);
  },
);

// ---------------------------------------------------------------------------
// GET /rounds/:id
// ---------------------------------------------------------------------------

registerOperation({
  method: 'get',
  path: '/rounds/:id',
  tags: ['Rounds'],
  summary: 'One round, in the field set the caller’s role permits',
  description:
    'Recruiters read any round with the full candidate record. Interviewers read only ' +
    'rounds they are assigned to, and the candidate arrives without contact details — ' +
    'the round view reuses `CANDIDATE_SELECT`, so it cannot disagree with ' +
    '`GET /candidates/:id` about what a role may see.',
  request: { params: roundParams },
  responses: [
    { status: 200, description: 'The round.', schema: roundSchema },
    PROBLEM_RESPONSES.badRequest,
    PROBLEM_RESPONSES.unauthorized,
    { ...PROBLEM_RESPONSES.forbidden, description: 'Hiring managers do not read rounds.' },
    notFoundResponse,
  ],
});

roundsRouter.get(
  '/rounds/:id',
  requireAuth,
  requireRole(UserRole.RECRUITER, UserRole.INTERVIEWER),
  validate({ params: roundParams }),
  async (req: Request, res: Response) => {
    res.status(200).json(await getRound(actorOf(req), params<RoundParams>(req).id));
  },
);

// ---------------------------------------------------------------------------
// POST /rounds/:id/assignments
// ---------------------------------------------------------------------------

const assignmentSchema = z.object({ interviewerId: z.uuid() });
type AssignmentBody = z.infer<typeof assignmentSchema>;

registerOperation({
  method: 'post',
  path: '/rounds/:id/assignments',
  tags: ['Rounds'],
  summary: 'Assign an interviewer to a round',
  description:
    'This is the call that *creates* an interviewer’s access to a candidate, so it is ' +
    'recruiter-only and it checks what it grants: the target user’s role must be ' +
    'INTERVIEWER.\n\n' +
    'A repeat assignment collides with the composite primary key and returns 409 rather ' +
    'than being silently ignored — the same read-free approach PLAN.md §5 takes with ' +
    'feedback.',
  request: { params: roundParams, body: assignmentSchema },
  responses: [
    { status: 204, description: 'Assigned, with an AuditEvent in the same transaction.' },
    { ...PROBLEM_RESPONSES.badRequest, description: 'The target user is not an interviewer.' },
    PROBLEM_RESPONSES.unauthorized,
    { ...PROBLEM_RESPONSES.forbidden, description: 'Recruiters only.' },
    {
      status: 404,
      description: 'No such round, or no such user.',
      schema: PROBLEM_RESPONSES.unauthorized.schema,
    },
    {
      status: 409,
      description: 'That interviewer is already assigned to this round.',
      schema: PROBLEM_RESPONSES.unauthorized.schema,
    },
  ],
});

roundsRouter.post(
  '/rounds/:id/assignments',
  requireAuth,
  requireRole(UserRole.RECRUITER),
  validate({ params: roundParams, body: assignmentSchema }),
  async (req: Request, res: Response) => {
    await assignInterviewer(
      actorOf(req),
      params<RoundParams>(req).id,
      body<AssignmentBody>(req).interviewerId,
    );
    res.status(204).send();
  },
);

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

const submitFeedbackSchema = z.object({
  /** 1..4 here, and `rating_range` CHECK in the database — the boundary is not the only guard. */
  rating: z.int().min(1).max(4),
  notes: z.string().trim().min(1).max(5000),
});

type SubmitFeedbackBody = z.infer<typeof submitFeedbackSchema>;

registerOperation({
  method: 'post',
  path: '/rounds/:id/feedback',
  tags: ['Rounds'],
  summary: 'Submit your feedback for a round',
  description:
    'One row per `(round, interviewer)`, enforced by a unique index rather than by a ' +
    'check in application code (PLAN.md §5).\n\n' +
    '- Two *different* interviewers submitting simultaneously both get 201. Their ' +
    'feedback is never merged and never overwritten.\n' +
    '- The *same* interviewer submitting twice gets 409 on the second, not a silent ' +
    'update. There is no read-then-write anywhere on this path, so there is no ' +
    'lost-update window to lose a race in.\n\n' +
    'Feedback never advances a stage — recruiters do that, explicitly.',
  request: { params: roundParams, body: submitFeedbackSchema },
  responses: [
    { status: 201, description: 'Recorded.', schema: feedbackSchema },
    { ...PROBLEM_RESPONSES.badRequest, description: 'A rating outside 1..4, or empty notes.' },
    PROBLEM_RESPONSES.unauthorized,
    { ...PROBLEM_RESPONSES.forbidden, description: 'Only interviewers submit feedback.' },
    notFoundResponse,
    {
      status: 409,
      description: 'You have already submitted feedback for this round.',
      schema: PROBLEM_RESPONSES.unauthorized.schema,
    },
  ],
});

roundsRouter.post(
  '/rounds/:id/feedback',
  requireAuth,
  requireRole(UserRole.INTERVIEWER),
  validate({ params: roundParams, body: submitFeedbackSchema }),
  async (req: Request, res: Response) => {
    const feedback = await submitFeedback(
      actorOf(req),
      params<RoundParams>(req).id,
      body<SubmitFeedbackBody>(req),
    );
    res.status(201).json(feedback);
  },
);

registerOperation({
  method: 'get',
  path: '/rounds/:id/feedback',
  tags: ['Rounds'],
  summary: 'The panel’s feedback for a round',
  description:
    'The brief lists "interviewers can’t see prior feedback before their round" as a ' +
    'problem, so this returns peer feedback to anyone assigned to the round — a ' +
    'deliberate reading, recorded here and in README.md rather than left implicit.',
  request: { params: roundParams },
  responses: [
    { status: 200, description: 'Feedback for the round, oldest first.', schema: z.array(peerFeedbackSchema) },
    PROBLEM_RESPONSES.badRequest,
    PROBLEM_RESPONSES.unauthorized,
    { ...PROBLEM_RESPONSES.forbidden, description: 'Hiring managers do not read feedback.' },
    notFoundResponse,
  ],
});

roundsRouter.get(
  '/rounds/:id/feedback',
  requireAuth,
  requireRole(UserRole.RECRUITER, UserRole.INTERVIEWER),
  validate({ params: roundParams }),
  async (req: Request, res: Response) => {
    res.status(200).json(await listFeedback(actorOf(req), params<RoundParams>(req).id));
  },
);
