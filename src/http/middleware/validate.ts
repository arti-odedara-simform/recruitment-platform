import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodType } from 'zod';
import { BadRequestError, type FieldIssue } from '../../errors/AppError.js';
import type { RequestSchemas } from '../types.js';

function toIssues(error: ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

/**
 * Shape validation, applied *before* the handler (PLAN.md §7). This checks enum
 * membership, uuid format, rating range, reason length — a body naming a stage that
 * is not defined never reaches a service.
 *
 * It deliberately does not check *legality*: whether APPLIED -> OFFER is a permitted
 * move is domain logic and lives in the stage machine (PLAN.md §3).
 */
export function validate(schemas: RequestSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.validated = {};
    const issues: FieldIssue[] = [];

    const sources: Array<[keyof RequestSchemas, ZodType | undefined, unknown]> = [
      ['body', schemas.body, req.body],
      ['params', schemas.params, req.params],
      ['query', schemas.query, req.query],
    ];

    for (const [key, schema, value] of sources) {
      if (!schema) continue;
      const result = schema.safeParse(value);
      if (result.success) {
        req.validated[key] = result.data;
      } else {
        issues.push(
          ...toIssues(result.error).map((issue) => ({
            path: `${key}.${issue.path}`,
            message: issue.message,
          })),
        );
      }
    }

    if (issues.length > 0) {
      next(new BadRequestError('The request failed validation.', issues));
      return;
    }

    next();
  };
}

/** Typed accessors, so handlers do not cast at every call site. */
export function body<T>(req: Request): T {
  return req.validated.body as T;
}

export function params<T>(req: Request): T {
  return req.validated.params as T;
}

export function query<T>(req: Request): T {
  return req.validated.query as T;
}
