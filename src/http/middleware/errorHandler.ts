import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
  type ProblemDetails,
} from '../../errors/AppError.js';
import { env } from '../../config/env.js';

/** Terminal 404 for unrouted paths — keeps the problem shape consistent. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`No route for ${req.method} ${req.path}.`));
}

/**
 * Postgres constraint codes, reached either through Prisma's own mapping or through
 * `meta.code` on a failed raw query (P2010).
 *
 * 23505 unique_violation  — a second feedback row for the same (round, interviewer).
 *                           This is the concurrency rule in PLAN.md §5: 409, never a
 *                           silent update.
 * 23503 foreign_key       — feedback on a round that does not exist (PLAN.md §7). 404,
 *                           matching the scoping 404 an unassigned interviewer gets, so
 *                           the two are indistinguishable from outside.
 * 23514 check_violation   — an OVERRIDE with no reason, or a rating outside 1..4. The
 *                           database refuses it even if the service layer is bypassed.
 */
function fromPgCode(code: string | undefined): AppError | null {
  switch (code) {
    case '23505':
      return new ConflictError('That record already exists.');
    case '23503':
      return new NotFoundError('A referenced record does not exist.');
    case '23514':
      return new BadRequestError('The request violates a database constraint.');
    default:
      return null;
  }
}

interface HttpErrorLike extends Error {
  status?: number;
  statusCode?: number;
  expose?: boolean;
}

function isHttpError(error: unknown): error is HttpErrorLike {
  return (
    error instanceof Error &&
    (typeof (error as HttpErrorLike).status === 'number' ||
      typeof (error as HttpErrorLike).statusCode === 'number')
  );
}

function translate(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof ZodError) {
    return new BadRequestError(
      'The request failed validation.',
      error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    );
  }

  // body-parser and other http-errors producers (malformed JSON, payload too large)
  // arrive as plain Errors carrying a status. They are the caller's fault, not ours,
  // and `expose` marks the message as safe to return.
  if (isHttpError(error)) {
    const status = error.status ?? error.statusCode ?? 400;
    if (status === 413) {
      return new AppError({
        status: 413,
        type: 'https://httpstatuses.io/413',
        title: 'Payload Too Large',
        detail: 'The request body exceeds the accepted size.',
      });
    }
    if (status >= 400 && status < 500) {
      return new BadRequestError(
        error.expose === true ? error.message : 'The request could not be parsed.',
      );
    }
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case 'P2002':
        return new ConflictError('That record already exists.');
      case 'P2003':
        return new NotFoundError('A referenced record does not exist.');
      case 'P2025':
        return new NotFoundError('No such resource.');
      case 'P2010': {
        const raw = (error.meta as { code?: string } | undefined)?.code;
        return fromPgCode(raw) ?? new AppError({
          status: 500,
          type: 'about:blank',
          title: 'Internal Server Error',
        });
      }
      default:
        break;
    }
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    // A malformed query is our bug, not the caller's — do not leak the message.
    return new AppError({
      status: 500,
      type: 'about:blank',
      title: 'Internal Server Error',
    });
  }

  return new AppError({ status: 500, type: 'about:blank', title: 'Internal Server Error' });
}

/**
 * Central error middleware. Nothing else writes an error response, so the mapping from
 * Prisma/Postgres codes to HTTP lives in exactly one place (PLAN.md §7).
 */
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  const appError = translate(error);
  const problem: ProblemDetails = appError.toProblem();

  // RFC 9110 §15.5.2: a 401 MUST carry a challenge naming the scheme the caller should
  // have used. Set here rather than in requireAuth so every 401 gets it, including the
  // one from a token whose subject no longer exists.
  if (appError.status === 401) {
    res.setHeader('WWW-Authenticate', 'Bearer');
  }

  if (appError.status >= 500) {
    console.error('[error]', error);
    if (env.NODE_ENV !== 'production' && error instanceof Error) {
      problem.detail = error.message;
    }
  }

  res.status(appError.status).type('application/problem+json').json(problem);
}
