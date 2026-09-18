import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { params, validate } from '../middleware/validate.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';
import { getCandidate } from '../../services/candidate.service.js';
import { registerOperation } from '../openapi/registry.js';
import { PROBLEM_RESPONSES } from '../openapi/schemas.js';

export const candidatesRouter = Router();

const candidateParams = z.object({
  id: z.uuid().meta({ description: 'Candidate id.', examples: ['38856b51-8ae9-546b-88cd-acbc21b291c7'] }),
});

type CandidateParams = z.infer<typeof candidateParams>;

/**
 * The two response shapes, strict on purpose.
 *
 * `strictObject` emits `additionalProperties: false`, so the interviewer view documents
 * itself as a closed set — and, because tests/openapi.test.ts parses real responses
 * against these schemas, a handler that started returning `email` to an interviewer
 * would fail the contract test rather than quietly matching a permissive union arm.
 */
const recruiterViewSchema = z
  .strictObject({
    id: z.uuid(),
    name: z.string(),
    email: z.email(),
    phone: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({
    id: 'CandidateRecruiterView',
    description: 'The full record. Contact details are recruiter-only (PLAN.md §1).',
  });

const interviewerViewSchema = z
  .strictObject({
    id: z.uuid(),
    name: z.string(),
  })
  .meta({
    id: 'CandidateInterviewerView',
    description:
      'What an assigned interviewer sees. `email` and `phone` are absent because they ' +
      'were never selected — see CANDIDATE_SELECT in src/repositories/candidate.repository.ts.',
  });

registerOperation({
  method: 'get',
  path: '/candidates/:id',
  tags: ['Candidates'],
  summary: 'One candidate, in the field set the caller’s role permits',
  description:
    'Two different queries, not one query and two serializers (PLAN.md §1).\n\n' +
    '- **Recruiter** — the full record, contact details included.\n' +
    '- **Interviewer** — name and id only, and only for a candidate they are assigned ' +
    'to interview. The assignment check is a JOIN inside the same SELECT, so an ' +
    'unassigned candidate returns zero rows.\n\n' +
    'An unassigned candidate is a **404, not a 403** — a 403 would confirm the record ' +
    'exists. "No such candidate" and "not yours" are deliberately indistinguishable.',
  request: { params: candidateParams },
  responses: [
    {
      status: 200,
      description: 'The candidate, in the caller’s field set.',
      schema: z.union([recruiterViewSchema, interviewerViewSchema]),
    },
    PROBLEM_RESPONSES.badRequest,
    PROBLEM_RESPONSES.unauthorized,
    {
      ...PROBLEM_RESPONSES.forbidden,
      description: 'Hiring managers: candidate records are not on their side of PLAN.md §4.',
    },
    {
      status: 404,
      description:
        'No such candidate — or one this interviewer is not assigned to. The two cases ' +
        'return the same body by design.',
      schema: PROBLEM_RESPONSES.unauthorized.schema,
    },
  ],
});

candidatesRouter.get(
  '/candidates/:id',
  requireAuth,
  requireRole(UserRole.RECRUITER, UserRole.INTERVIEWER),
  validate({ params: candidateParams }),
  async (req: Request, res: Response) => {
    const { id } = params<CandidateParams>(req);
    res.status(200).json(await getCandidate(actorOf(req), id));
  },
);
