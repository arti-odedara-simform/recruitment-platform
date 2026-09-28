import { Router, type Request, type Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApiDocument } from '../openapi/registry.js';

export const docsRouter = Router();

/**
 * Built once, on first use rather than at import time: route modules register their
 * operations as they are imported, and this module cannot know it is last in line.
 */
let document: Record<string, unknown> | null = null;

function openApiDocument(): Record<string, unknown> {
  document ??= buildOpenApiDocument();
  return document;
}

/** The raw spec, for anything that is not a browser — codegen, Postman, `curl | jq`. */
docsRouter.get('/openapi.json', (_req: Request, res: Response) => {
  res.status(200).json(openApiDocument());
});

/**
 * Swagger UI. `swaggerUi.setup(null, ...)` with `swaggerOptions.url` makes the page fetch
 * the spec from /openapi.json at load rather than having it inlined into the HTML, so a
 * route added in D4 shows up on refresh instead of on restart.
 *
 * `persistAuthorization` keeps the token you paste into **Authorize** across reloads,
 * which matters when it expires every 15 minutes and you are clicking through §4's
 * endpoints.
 */
docsRouter.use(
  '/docs',
  swaggerUi.serveFiles(undefined, { swaggerOptions: { url: '/openapi.json' } }),
  swaggerUi.setup(undefined, {
    swaggerOptions: { url: '/openapi.json', persistAuthorization: true },
    customSiteTitle: 'Recruitment Pipeline POC — API',
  }),
);
