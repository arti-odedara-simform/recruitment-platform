import express, { type Express } from 'express';
import helmet from 'helmet';
import { healthRouter } from './http/routes/health.js';
import { applicationsRouter } from './http/routes/applications.js';
import { authRouter } from './http/routes/auth.js';
import { candidatesRouter } from './http/routes/candidates.js';
import { docsRouter } from './http/routes/docs.js';
import { errorHandler, notFoundHandler } from './http/middleware/errorHandler.js';
import { env } from './config/env.js';
import './http/types.js';

/**
 * Builds the Express app without binding a port, so tests can drive it over supertest
 * against a real database (PLAN.md §9) with no listener to tear down.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');

  /**
   * Swagger UI ships inline styles and an inline bootstrap script, both of which
   * helmet's default Content-Security-Policy blocks outright.
   *
   * Relaxing the policy API-wide to fix a documentation page would be the wrong trade,
   * so the choice is made per request: the docs paths get helmet without a CSP, and
   * every actual API route keeps helmet's defaults untouched. Two prebuilt instances
   * rather than two `app.use` calls, because helmet sets headers as it runs — a second
   * pass would put the CSP straight back on.
   */
  const apiHelmet = helmet();
  const docsHelmet = helmet({ contentSecurityPolicy: false });

  app.use((req, res, next) => {
    const isDocsPath =
      env.ENABLE_DOCS &&
      (req.path === '/openapi.json' || req.path === '/docs' || req.path.startsWith('/docs/'));

    (isDocsPath ? docsHelmet : apiHelmet)(req, res, next);
  });
  app.use(express.json({ limit: '100kb' }));

  app.use(healthRouter);
  app.use(authRouter);

  // Two more anonymous routes, so they are opt-in — see ENABLE_DOCS in config/env.ts.
  if (env.ENABLE_DOCS) {
    app.use(docsRouter);
  }

  // Feature routers. Everything from here down is behind `requireAuth`; PLAN.md §4
  // leaves exactly two routes open, and both are mounted above.
  app.use(candidatesRouter);
  app.use(applicationsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
