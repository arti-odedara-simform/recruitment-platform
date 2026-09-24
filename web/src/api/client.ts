import type { components } from './types.js';

/**
 * The only place in the app that talks to the network.
 *
 * Everything it returns is typed from `src/api/types.ts`, which is generated from the
 * API's own OpenAPI document — which is itself generated from the zod schemas the API
 * validates with (`npm run api:types` regenerates both). So the chain from "what the
 * server enforces" to "what this app believes" has no hand-written link in it, and a
 * route whose response shape changes breaks `npm run typecheck` here.
 */

export type Schemas = components['schemas'];
export type Problem = Schemas['Problem'];

/** The API's RFC-7807-ish error, carried as an exception so callers can branch on status. */
export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem | null;

  constructor(status: number, problem: Problem | null) {
    super(problem?.detail ?? problem?.title ?? `Request failed with ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
  }

  /** Field-level messages, for a form to render next to its inputs. */
  get fieldErrors(): Record<string, string> {
    return Object.fromEntries(
      (this.problem?.errors ?? []).map((issue) => [issue.path, issue.message]),
    );
  }
}

/**
 * `/api` is rewritten to the API's root by the Vite dev proxy in development and by
 * nginx in the compose stack, so nothing below knows or cares where the API lives.
 */
const BASE = '/api';

let token: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setToken(next: string | null): void {
  token = next;
}

/**
 * Registered by the session provider. Tokens last 15 minutes, so a 401 mid-session is a
 * routine event rather than an error worth showing — the app drops the token and asks
 * for a login again.
 */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Set on the login call, which must surface its own 401 rather than trigger a logout. */
  skipUnauthorizedHandler?: boolean;
}

function toUrl(path: string, query: RequestOptions['query']): string {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(toUrl(path, options.query), {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  if (response.status === 204) {
    return undefined as T;
  }

  // The API answers errors as application/problem+json. Anything else at an error status
  // is a proxy or a crash, and pretending it parses would hide that.
  const payload = response.headers.get('content-type')?.includes('json')
    ? ((await response.json()) as unknown)
    : null;

  if (!response.ok) {
    if (response.status === 401 && !options.skipUnauthorizedHandler) {
      onUnauthorized?.();
    }
    throw new ApiError(response.status, payload as Problem | null);
  }

  return payload as T;
}

// ---------------------------------------------------------------------------
// One function per endpoint this app uses. Typed from the generated schemas, so
// the compiler is what notices when the API's shape moves.
// ---------------------------------------------------------------------------

export function login(email: string, password: string): Promise<Schemas['LoginResponse']> {
  return apiFetch('/auth/login', {
    method: 'POST',
    body: { email, password },
    skipUnauthorizedHandler: true,
  });
}

export function me(): Promise<Schemas['PublicUser']> {
  return apiFetch('/auth/me');
}

export function pipeline(roleId?: string): Promise<Schemas['PipelineRole'][]> {
  return apiFetch('/pipeline', { query: { roleId } });
}

export function stuck(days: number, limit = 25): Promise<Schemas['StuckApplication'][]> {
  return apiFetch('/pipeline/stuck', { query: { days, limit } });
}

export function roles(status: 'OPEN' | 'CLOSED' | 'ALL' = 'OPEN'): Promise<Schemas['Role'][]> {
  return apiFetch('/roles', { query: { status } });
}

/**
 * The interviewer path. `/me/rounds` takes no parameter by design — the route is the
 * scope, so there is nothing here that could be pointed at someone else's assignments.
 *
 * Round ids reach these from the URL bar via `useParams`, so they are encoded rather
 * than interpolated raw: a path segment is not a place to trust a router param.
 */
export function myRounds(): Promise<Schemas['Round'][]> {
  return apiFetch('/me/rounds');
}

export function round(id: string): Promise<Schemas['Round']> {
  return apiFetch(`/rounds/${encodeURIComponent(id)}`);
}

export function roundFeedback(id: string): Promise<Schemas['PeerFeedback'][]> {
  return apiFetch(`/rounds/${encodeURIComponent(id)}/feedback`);
}

/**
 * A 409 from this is not a fault — it is the `@@unique([roundId, interviewerId])` index
 * saying this interviewer has already submitted. The caller refetches rather than
 * apologises; see `RoundDetail`.
 */
export function submitFeedback(
  id: string,
  input: { rating: number; notes: string },
): Promise<Schemas['Feedback']> {
  return apiFetch(`/rounds/${encodeURIComponent(id)}/feedback`, { method: 'POST', body: input });
}

// ---------------------------------------------------------------------------
// The recruiter path: the work queue, the record behind a row, and the four
// actions a recruiter takes on it.
// ---------------------------------------------------------------------------

export interface ApplicationFilter {
  roleId?: string;
  stage?: Schemas['ApplicationListItem']['currentStage'];
  roleStatus?: 'OPEN' | 'CLOSED' | 'ALL';
}

export function applications(
  filter: ApplicationFilter = {},
): Promise<Schemas['ApplicationListItem'][]> {
  return apiFetch('/applications', { query: { ...filter } });
}

/**
 * The full candidate record — contact details included, for a recruiter. An interviewer
 * calling this gets `{ id, name }` and nothing else, because the API runs a different
 * query rather than trimming one result, so the union here is not a formality: reading
 * `email` off it is a type error until the caller has narrowed.
 */
export function candidate(
  id: string,
): Promise<Schemas['CandidateRecruiterView'] | Schemas['CandidateInterviewerView']> {
  return apiFetch(`/candidates/${encodeURIComponent(id)}`);
}

export function candidateAudit(id: string): Promise<Schemas['CandidateAudit']> {
  return apiFetch(`/audit/candidates/${encodeURIComponent(id)}`);
}

/** Every round booked against one application, with the panel already on each. */
export function applicationRounds(candidateId: string, roleId: string): Promise<Schemas['Round'][]> {
  return apiFetch(
    `/applications/${encodeURIComponent(candidateId)}/${encodeURIComponent(roleId)}/rounds`,
  );
}

/** The picker behind "assign an interviewer" and "open a req". Recruiters only. */
export function users(role?: Schemas['PublicUser']['role']): Promise<Schemas['PublicUser'][]> {
  return apiFetch('/users', { query: { role } });
}

export function advanceStage(
  candidateId: string,
  roleId: string,
  toStage: Schemas['ApplicationStage']['currentStage'],
): Promise<Schemas['StageTransitionResult']> {
  return apiFetch(
    `/applications/${encodeURIComponent(candidateId)}/${encodeURIComponent(roleId)}/stage`,
    { method: 'PATCH', body: { toStage } },
  );
}

/**
 * A stage skip. The reason is not a UI nicety — the API refuses anything under ten
 * characters and a `CHECK` constraint refuses the row underneath that, so it reaches the
 * audit trail or the override does not happen.
 */
export function overrideStage(
  candidateId: string,
  roleId: string,
  toStage: Schemas['ApplicationStage']['currentStage'],
  reason: string,
): Promise<Schemas['StageTransitionResult']> {
  return apiFetch(
    `/applications/${encodeURIComponent(candidateId)}/${encodeURIComponent(roleId)}/override`,
    { method: 'POST', body: { toStage, reason } },
  );
}

export function createRound(input: {
  candidateId: string;
  roleId: string;
  stage: Schemas['Round']['stage'];
  scheduledAt: string;
}): Promise<Schemas['CreatedRound']> {
  return apiFetch('/rounds', { method: 'POST', body: input });
}

/**
 * 204, so nothing comes back. A 409 is the composite primary key saying this interviewer
 * is already on the round — the caller refetches rather than apologises, exactly as the
 * feedback form does.
 */
export function assignInterviewer(roundId: string, interviewerId: string): Promise<void> {
  return apiFetch(`/rounds/${encodeURIComponent(roundId)}/assignments`, {
    method: 'POST',
    body: { interviewerId },
  });
}

// ---------------------------------------------------------------------------
// The two writes that bring the pipeline's own subjects into existence: a req,
// and a candidate on one. Recruiters only, both of them.
// ---------------------------------------------------------------------------

/**
 * `status` is not an input — a req opens OPEN, and closing one is a separate act the API
 * does not have yet. `hiringManagerId` must name a user whose role is HIRING_MANAGER; the
 * API checks rather than assumes, and answers 400 when it is somebody else.
 */
export function createRole(input: {
  title: string;
  hiringManagerId: string;
}): Promise<Schemas['Role']> {
  return apiFetch('/roles', { method: 'POST', body: input });
}

/**
 * The pipeline unit comes into existence here, at APPLIED — there is no `stage` input,
 * because every later stage is the stage machine's business.
 *
 * A 409 is the unique index saying this candidate is already on this req. Like the
 * assignment and feedback forms, the caller refetches rather than apologises: the row
 * the recruiter wanted is there, someone else just created it first.
 */
export function createApplication(input: {
  candidateId: string;
  roleId: string;
}): Promise<Schemas['ApplicationStage']> {
  return apiFetch('/applications', { method: 'POST', body: input });
}
