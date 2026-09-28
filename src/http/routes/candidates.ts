import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { params, query, validate } from '../middleware/validate.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';
import { getCandidate, listCandidates } from '../../services/candidate.service.js';
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

const DEFAULT_PAGE_SIZE = 20;

const listQuery = z.object({
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((value) => value || undefined)
    .meta({
      description:
        'Case-insensitive substring search. Recruiters match name, email and phone; ' +
        'interviewers match name only.',
      examples: ['amara'],
    }),
  page: z.coerce.number().int().min(1).default(1).meta({ description: '1-based page number.' }),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(DEFAULT_PAGE_SIZE)
    .meta({ description: `Rows per page. Defaults to ${DEFAULT_PAGE_SIZE}.` }),
});

type ListQuery = z.infer<typeof listQuery>;

const candidatePageSchema = z
  .strictObject({
    items: z.array(z.union([recruiterViewSchema, interviewerViewSchema])),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  })
  .meta({ id: 'CandidatePage', description: 'One page of candidates, by name.' });

registerOperation({
  method: 'get',
  path: '/candidates',
  tags: ['Candidates'],
  summary: 'Candidates in the caller’s scope, paginated and searchable',
  description:
    'The list counterpart to `GET /candidates/:id`, with the same split.\n\n' +
    '- **Recruiter** — every candidate, full record. `q` matches name, email or phone.\n' +
    '- **Interviewer** — only candidates they are assigned to interview, name and id ' +
    'only. `q` matches **name only**: searching contact fields would let an interviewer ' +
    'recover an address one character at a time from which rows come back.\n\n' +
    'Ordered by name, then id, so pages are stable. A page past the end is an empty ' +
    '`items`, not an error.',
  request: { query: listQuery },
  responses: [
    { status: 200, description: 'One page of candidates.', schema: candidatePageSchema },
    PROBLEM_RESPONSES.badRequest,
    PROBLEM_RESPONSES.unauthorized,
    {
      ...PROBLEM_RESPONSES.forbidden,
      description: 'Hiring managers: candidate records are not on their side of PLAN.md §4.',
    },
  ],
});

candidatesRouter.get(
  '/candidates',
  requireAuth,
  requireRole(UserRole.RECRUITER, UserRole.INTERVIEWER),
  validate({ query: listQuery }),
  async (req: Request, res: Response) => {
    const { q, page, pageSize } = query<ListQuery>(req);
    res.status(200).json(await listCandidates(actorOf(req), { q, page, pageSize }));
  },
);
