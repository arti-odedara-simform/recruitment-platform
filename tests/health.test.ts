import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { disconnectDatabase } from '../src/db/client.js';

const app = createApp();

afterAll(async () => {
  await disconnectDatabase();
});

describe('GET /health', () => {
  it('reports a live database round-trip', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', database: 'up' });
    expect(response.body.uptimeSeconds).toBeTypeOf('number');
  });
});

describe('unrouted paths', () => {
  it('404s in the problem shape rather than Express default HTML', async () => {
    const response = await request(app).get('/no-such-route');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({ title: 'Not Found', status: 404 });
  });

  it('rejects malformed JSON with a 400 problem, not a stack trace', async () => {
    const response = await request(app)
      .post('/no-such-route')
      .set('Content-Type', 'application/json')
      .send('{"broken":');

    expect(response.status).toBe(400);
    expect(response.body.status).toBe(400);
  });
});
