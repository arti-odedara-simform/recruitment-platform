import type { NextFunction, Request, Response } from 'express';
import type { UserRole } from '@prisma/client';
import { ForbiddenError, UnauthorizedError } from '../../errors/AppError.js';
import { verifyAccessToken } from '../../auth/tokens.js';
import type { Actor } from '../../domain/actor.js';

/**
 * `Bearer <token>`, case-insensitive scheme per RFC 6750, one token and nothing after it.
 * Anchored deliberately: a loose split on whitespace would accept `Bearer a b` and
 * silently use the first fragment.
 */
const BEARER = /^Bearer[ \t]+(\S+)$/i;

/**
 * PLAN.md §4: every route is behind this except `POST /auth/login` and `GET /health`.
 *
 * Verification is stateless — no database round-trip per request. The token carries the
 * whole `Actor` (id + role), so the trade is explicit: a role change or a deactivated
 * account takes effect at the next login, up to 15 minutes later. That window *is* the
 * reason the TTL is short. Endpoints that must reflect the current row read it
 * themselves (`GET /auth/me` does).
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.get('authorization');

  if (!header) {
    next(new UnauthorizedError('An "Authorization: Bearer <token>" header is required.'));
    return;
  }

  const match = BEARER.exec(header.trim());
  const token = match?.[1];

  if (!token) {
    next(new UnauthorizedError('The Authorization header must read "Bearer <token>".'));
    return;
  }

  // Throws UnauthorizedError; Express 5 forwards a synchronous throw to the error
  // middleware, so there is no catch-and-rethrow here.
  req.actor = verifyAccessToken(token);
  next();
}

/**
 * Role gate, mounted *after* `requireAuth` (PLAN.md §4: "`requireRole(...)` on top").
 *
 * 403, not the 404 that out-of-scope *resources* get. The distinction is the one §4
 * draws: 404 hides whether a particular candidate exists, whereas the existence of a
 * route like `POST /roles` is not a secret — the caller simply is not a recruiter.
 *
 * If `requireAuth` was not mounted ahead of this, it fails closed with a 401 rather than
 * reading an undefined actor. A wiring mistake cannot open a route.
 */
export function requireRole(...allowed: readonly UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const actor = req.actor;

    if (!actor) {
      next(new UnauthorizedError());
      return;
    }

    if (!allowed.includes(actor.role)) {
      next(
        new ForbiddenError(
          `This action is restricted to ${allowed.join(', ')}; you are ${actor.role}.`,
        ),
      );
      return;
    }

    next();
  };
}

/**
 * Typed accessor for handlers, matching `body()`/`params()`/`query()` in validate.ts.
 * Throws rather than returning `undefined`, so a handler mounted without `requireAuth`
 * fails loudly at the first line instead of querying with an undefined actor id.
 */
export function actorOf(req: Request): Actor {
  if (!req.actor) {
    throw new UnauthorizedError();
  }
  return req.actor;
}
