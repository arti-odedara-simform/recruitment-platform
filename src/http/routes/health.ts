import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { pingDatabase } from '../../repositories/health.repository.js';
import { registerOperation } from '../openapi/registry.js';

export const healthRouter = Router();

const healthSchema = z
  .object({
    status: z.enum(['ok', 'degraded']),
    database: z.enum(['up', 'down']),
    uptimeSeconds: z.int(),
  })
  .meta({ id: 'Health' });

registerOperation({
  method: 'get',
  path: '/health',
  tags: ['Health'],
  security: 'none',
  summary: 'Liveness, including a database round-trip',
  description:
    'The second and last anonymous route (PLAN.md §4); the compose healthcheck polls it. ' +
    'A container that is up but cannot reach Postgres reports 503 rather than accepting ' +
    'traffic.',
  responses: [
    { status: 200, description: 'API and database both reachable.', schema: healthSchema },
    { status: 503, description: 'The database round-trip failed.', schema: healthSchema },
  ],
});

/**
 * One of only two unauthenticated routes (PLAN.md §4); the compose healthcheck polls it.
 * It reports the database round-trip, so a container that is up but cannot reach
 * Postgres is reported unhealthy rather than accepting traffic.
 */
healthRouter.get('/health', async (_req: Request, res: Response) => {
  const databaseUp = await pingDatabase();
  res.status(databaseUp ? 200 : 503).json({
    status: databaseUp ? 'ok' : 'degraded',
    database: databaseUp ? 'up' : 'down',
    uptimeSeconds: Math.round(process.uptime()),
  });
});
