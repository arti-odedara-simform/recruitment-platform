import type { ZodType } from 'zod';
import type { Actor } from '../domain/actor.js';

/**
 * Express 5 exposes `req.query` as a getter, so validated values cannot be written back
 * onto it. Handlers read the parsed, typed values from `req.validated` instead.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Set by `requireAuth` and by nothing else. Optional because the two
       * unauthenticated routes (POST /auth/login, GET /health) never have one —
       * handlers read it through `actorOf(req)`, which throws if it is missing.
       */
      actor?: Actor;
      validated: {
        body?: unknown;
        params?: unknown;
        query?: unknown;
      };
    }
  }
}

export interface RequestSchemas {
  body?: ZodType;
  params?: ZodType;
  query?: ZodType;
}

export {};
