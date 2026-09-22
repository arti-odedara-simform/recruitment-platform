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
 * `/api` is rewritten to the API's root by the Vite dev proxy (and by the same-origin
 * deployment in production), so nothing below knows or cares where the API lives.
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
