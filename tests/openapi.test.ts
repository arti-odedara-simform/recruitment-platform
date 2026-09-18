import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma, disconnectDatabase } from '../src/db/client.js';
import { hashPassword } from '../src/auth/password.js';
import { buildOpenApiDocument, registeredOperations } from '../src/http/openapi/registry.js';
import { problemSchema } from '../src/http/openapi/schemas.js';

const app = createApp();

const PASSWORD = 'contract-test-password';
const EMAIL = 'openapi.test.recruiter@example.com';

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await prisma.user.create({
    data: {
      email: EMAIL,
      name: 'Contract Test Recruiter',
      role: UserRole.RECRUITER,
      passwordHash: await hashPassword(PASSWORD),
    },
  });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await disconnectDatabase();
});

describe('the OpenAPI document', () => {
  it('builds, and is served at /openapi.json', async () => {
    const response = await request(app).get('/openapi.json');

    expect(response.status).toBe(200);
    expect(response.body.openapi).toBe('3.1.0');
    expect(Object.keys(response.body.paths).sort()).toEqual(['/auth/login', '/auth/me', '/health']);
  });

  // The whole argument for generating the spec is that it cannot drift from the
  // validator. If this ever fails, the document was hand-edited.
  it('documents the login body with the same constraints validate() enforces', async () => {
    const document = buildOpenApiDocument() as any;
    const body =
      document.paths['/auth/login'].post.requestBody.content['application/json'].schema;

    expect(body.required.sort()).toEqual(['email', 'password']);
    expect(body.properties.email.format).toBe('email');
    expect(body.properties.password.maxLength).toBe(200);
  });

  // PLAN.md §4: exactly two anonymous routes. Documented as such, so a reviewer reading
  // only the spec draws the same conclusion as one reading app.ts.
  it('marks every route as bearer-guarded except login and health', () => {
    const document = buildOpenApiDocument() as any;
    expect(document.security).toEqual([{ bearerAuth: [] }]);

    const anonymous = registeredOperations()
      .filter((operation) => operation.security === 'none')
      .map((operation) => operation.path)
      .sort();

    expect(anonymous).toEqual(['/auth/login', '/health']);
    expect(document.paths['/auth/me'].get.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/auth/login'].post.security).toEqual([]);
  });

  /**
   * A `.meta({ id })` makes zod emit `$ref: '#/$defs/X'`, which is JSON Schema's location
   * and not OpenAPI's — the document looks fine and Swagger UI shows the model as
   * unresolved. Every ref is walked here so that cannot regress silently.
   */
  it('resolves every $ref against components.schemas', () => {
    const document = buildOpenApiDocument() as any;
    const refs: string[] = [];

    (function walk(node: unknown): void {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === '$ref' && typeof value === 'string') refs.push(value);
        else walk(value);
      }
    })(document);

    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((ref) => !ref.startsWith('#/components/schemas/'))).toEqual([]);

    for (const ref of refs) {
      const name = ref.replace('#/components/schemas/', '');
      expect(document.components.schemas[name], `unresolved $ref ${ref}`).toBeDefined();
    }

    // The named models are shared, not re-inlined per route.
    expect(Object.keys(document.components.schemas).sort()).toEqual([
      'Health',
      'LoginResponse',
      'Problem',
      'PublicUser',
    ]);
  });

  it('is served as a browsable Swagger UI page at /docs', async () => {
    const response = await request(app).get('/docs/');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.text).toContain('swagger-ui');
    // The page must not carry a CSP, or the bundle it loads is blocked.
    expect(response.headers['content-security-policy']).toBeUndefined();
  });

  it('leaves the CSP in place on real API routes', async () => {
    const response = await request(app).get('/health');
    expect(response.headers['content-security-policy']).toBeDefined();
  });
});

/**
 * Response schemas are the one half of the document that zod does not enforce at
 * runtime — nothing validates an outgoing body. These tests are the substitute: drive
 * the real endpoint, parse the real response against the schema the document publishes.
 * A handler that starts returning a different shape fails here.
 */
describe('documented response shapes match real responses', () => {
  function documentedSchema(path: string, method: string, status: number): z.ZodType {
    const operation = registeredOperations().find(
      (candidate) => candidate.path === path && candidate.method === method,
    );
    const response = operation?.responses.find((entry) => entry.status === status);
    if (!response?.schema) throw new Error(`no documented schema for ${method} ${path} ${status}`);
    return response.schema;
  }

  it('POST /auth/login 200', async () => {
    const response = await request(app).post('/auth/login').send({ email: EMAIL, password: PASSWORD });

    expect(response.status).toBe(200);
    expect(() => documentedSchema('/auth/login', 'post', 200).parse(response.body)).not.toThrow();
  });

  it('POST /auth/login 400', async () => {
    const response = await request(app).post('/auth/login').send({ email: 'nope' });

    expect(response.status).toBe(400);
    expect(() => problemSchema.parse(response.body)).not.toThrow();
  });

  it('POST /auth/login 401', async () => {
    const response = await request(app).post('/auth/login').send({ email: EMAIL, password: 'wrong' });

    expect(response.status).toBe(401);
    expect(() => problemSchema.parse(response.body)).not.toThrow();
  });

  it('GET /auth/me 200', async () => {
    const login = await request(app).post('/auth/login').send({ email: EMAIL, password: PASSWORD });
    const response = await request(app)
      .get('/auth/me')
      .set('authorization', `Bearer ${login.body.token}`);

    expect(response.status).toBe(200);
    expect(() => documentedSchema('/auth/me', 'get', 200).parse(response.body)).not.toThrow();
  });

  it('GET /auth/me 401', async () => {
    const response = await request(app).get('/auth/me');

    expect(response.status).toBe(401);
    expect(() => problemSchema.parse(response.body)).not.toThrow();
  });

  it('GET /health 200', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(() => documentedSchema('/health', 'get', 200).parse(response.body)).not.toThrow();
  });
});
