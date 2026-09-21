import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma, disconnectDatabase } from '../src/db/client.js';
import { hashPassword } from '../src/auth/password.js';
import { buildOpenApiDocument, registeredOperations } from '../src/http/openapi/registry.js';
import { problemSchema } from '../src/http/openapi/schemas.js';
import { CANDIDATE_IDS, DEV_PASSWORD } from '../src/seed/fixture.js';

const app = createApp();

const PASSWORD = 'contract-test-password';
const EMAIL = 'openapi.test.recruiter@example.com';

// The candidate route is driven with seeded accounts rather than this file's throwaway
// recruiter: its responses depend on the fixture's assignment graph (Ingrid is assigned
// to c01), which a freshly created user has no place in.
const RECRUITER_EMAIL = 'rachel.recruiter@example.com';
const INTERVIEWER_EMAIL = 'ingrid.interviewer@example.com';
const HIRING_MANAGER_EMAIL = 'hana.manager@example.com';

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
  await cleanupApplications();
  await prisma.role.deleteMany({ where: { id: CONTRACT_ROLE_ID } });
  await disconnectDatabase();
});

const CONTRACT_ROLE_ID = '22222222-2222-4222-8222-222222222222';
const CONTRACT_CANDIDATE_PREFIX = 'openapi.test.candidate';
let contractSequence = 0;

/** A throwaway APPLIED application, so the stage routes can be driven for real. */
async function givenApplication(): Promise<{ candidateId: string; roleId: string }> {
  const hiringManager = await prisma.user.findFirstOrThrow({
    where: { role: UserRole.HIRING_MANAGER },
    select: { id: true },
  });
  await prisma.role.upsert({
    where: { id: CONTRACT_ROLE_ID },
    create: { id: CONTRACT_ROLE_ID, title: 'Contract Test Role', hiringManagerId: hiringManager.id },
    update: {},
  });

  const candidate = await prisma.candidate.create({
    data: {
      name: `Contract Test ${(contractSequence += 1)}`,
      email: `${CONTRACT_CANDIDATE_PREFIX}.${contractSequence}@example.net`,
      applications: { create: { roleId: CONTRACT_ROLE_ID } },
    },
    select: { id: true },
  });

  return { candidateId: candidate.id, roleId: CONTRACT_ROLE_ID };
}

async function cleanupApplications(): Promise<void> {
  const candidates = await prisma.candidate.findMany({
    where: { email: { startsWith: CONTRACT_CANDIDATE_PREFIX } },
    select: { applications: { select: { id: true, rounds: { select: { id: true } } } } },
  });
  const applicationIds = candidates.flatMap((c) => c.applications.map((a) => a.id));
  const roundIds = candidates.flatMap((c) => c.applications.flatMap((a) => a.rounds.map((r) => r.id)));

  // Feedback.roundId is RESTRICT, not CASCADE — see the note in tests/rounds.test.ts.
  await prisma.feedback.deleteMany({ where: { roundId: { in: roundIds } } });
  await prisma.auditEvent.deleteMany({
    where: { entityId: { in: [...applicationIds, ...roundIds] } },
  });
  await prisma.candidate.deleteMany({
    where: { email: { startsWith: CONTRACT_CANDIDATE_PREFIX } },
  });
}

describe('the OpenAPI document', () => {
  it('builds, and is served at /openapi.json', async () => {
    const response = await request(app).get('/openapi.json');

    expect(response.status).toBe(200);
    expect(response.body.openapi).toBe('3.1.0');
    expect(Object.keys(response.body.paths).sort()).toEqual([
      '/applications',
      '/applications/{candidateId}/{roleId}/override',
      '/applications/{candidateId}/{roleId}/stage',
      '/audit/candidates/{id}',
      '/auth/login',
      '/auth/me',
      '/candidates/{id}',
      '/health',
      '/me/rounds',
      '/pipeline',
      '/pipeline/stuck',
      '/roles',
      '/rounds',
      '/rounds/{id}',
      '/rounds/{id}/assignments',
      '/rounds/{id}/feedback',
    ]);
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
      'ApplicationStage',
      'CandidateAudit',
      'CandidateInterviewerView',
      'CandidateRecruiterView',
      'CreatedRound',
      'Feedback',
      'Health',
      'LoginResponse',
      'PeerFeedback',
      'PipelineRole',
      'PipelineStage',
      'Problem',
      'PublicUser',
      'Role',
      'Round',
      'StageTransition',
      'StageTransitionResult',
      'StuckApplication',
      'TimelineEvent',
      'TimelineTransition',
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

  /**
   * Both arms of the candidate union, driven for real. The interviewer view is a
   * `strictObject`, so this fails if a contact field ever appears in that response —
   * the contract test and the leak sweep in tests/candidates.test.ts catch the same
   * regression from opposite directions.
   */
  it('GET /candidates/:id 200 — recruiter and interviewer arms', async () => {
    const schema = documentedSchema('/candidates/:id', 'get', 200);

    for (const [email, id] of [
      [RECRUITER_EMAIL, CANDIDATE_IDS.c01],
      [INTERVIEWER_EMAIL, CANDIDATE_IDS.c01],
    ] as const) {
      const login = await request(app)
        .post('/auth/login')
        .send({ email, password: DEV_PASSWORD });
      const response = await request(app)
        .get(`/candidates/${id}`)
        .set('authorization', `Bearer ${login.body.token}`);

      expect(response.status, `as ${email}`).toBe(200);
      expect(() => schema.parse(response.body), `as ${email}`).not.toThrow();
    }
  });

  it('GET /candidates/:id 404', async () => {
    const login = await request(app)
      .post('/auth/login')
      .send({ email: INTERVIEWER_EMAIL, password: DEV_PASSWORD });
    const response = await request(app)
      .get(`/candidates/${CANDIDATE_IDS.c02}`)
      .set('authorization', `Bearer ${login.body.token}`);

    expect(response.status).toBe(404);
    expect(() => problemSchema.parse(response.body)).not.toThrow();
  });

  /**
   * The stage routes, driven against a throwaway application so the seeded fixture's
   * starting position is untouched.
   */
  it('PATCH /applications/:candidateId/:roleId/stage 200 and 422', async () => {
    const login = await request(app)
      .post('/auth/login')
      .send({ email: RECRUITER_EMAIL, password: DEV_PASSWORD });
    const auth = `Bearer ${login.body.token}`;
    const target = await givenApplication();

    const moved = await request(app)
      .patch(`/applications/${target.candidateId}/${target.roleId}/stage`)
      .set('authorization', auth)
      .send({ toStage: 'SCREEN' });

    expect(moved.status).toBe(200);
    expect(() =>
      documentedSchema('/applications/:candidateId/:roleId/stage', 'patch', 200).parse(moved.body),
    ).not.toThrow();

    const refused = await request(app)
      .patch(`/applications/${target.candidateId}/${target.roleId}/stage`)
      .set('authorization', auth)
      .send({ toStage: 'HIRED' });

    expect(refused.status).toBe(422);
    expect(() => problemSchema.parse(refused.body)).not.toThrow();
  });

  it('POST /applications/:candidateId/:roleId/override 200', async () => {
    const login = await request(app)
      .post('/auth/login')
      .send({ email: RECRUITER_EMAIL, password: DEV_PASSWORD });
    const target = await givenApplication();

    const response = await request(app)
      .post(`/applications/${target.candidateId}/${target.roleId}/override`)
      .set('authorization', `Bearer ${login.body.token}`)
      .send({ toStage: 'OFFER', reason: 'Contract test override, recorded on purpose.' });

    expect(response.status).toBe(200);
    expect(() =>
      documentedSchema('/applications/:candidateId/:roleId/override', 'post', 200).parse(response.body),
    ).not.toThrow();
  });

  /**
   * The round lifecycle end to end: create, assign, read, submit feedback, read the
   * panel's. Each response is parsed against the shape the document publishes.
   */
  it('the round and feedback routes match their documented shapes', async () => {
    const recruiter = await request(app)
      .post('/auth/login')
      .send({ email: RECRUITER_EMAIL, password: DEV_PASSWORD });
    const interviewer = await request(app)
      .post('/auth/login')
      .send({ email: INTERVIEWER_EMAIL, password: DEV_PASSWORD });
    const recruiterAuth = `Bearer ${recruiter.body.token}`;
    const interviewerAuth = `Bearer ${interviewer.body.token}`;
    const target = await givenApplication();

    const created = await request(app)
      .post('/rounds')
      .set('authorization', recruiterAuth)
      .send({
        candidateId: target.candidateId,
        roleId: target.roleId,
        stage: 'INTERVIEW',
        scheduledAt: new Date().toISOString(),
      });
    expect(created.status).toBe(201);
    expect(() => documentedSchema('/rounds', 'post', 201).parse(created.body)).not.toThrow();

    const assigned = await request(app)
      .post(`/rounds/${created.body.id}/assignments`)
      .set('authorization', recruiterAuth)
      .send({ interviewerId: interviewer.body.user.id });
    expect(assigned.status).toBe(204);

    const round = await request(app)
      .get(`/rounds/${created.body.id}`)
      .set('authorization', interviewerAuth);
    expect(round.status).toBe(200);
    expect(() => documentedSchema('/rounds/:id', 'get', 200).parse(round.body)).not.toThrow();

    const mine = await request(app).get('/me/rounds').set('authorization', interviewerAuth);
    expect(mine.status).toBe(200);
    expect(() => documentedSchema('/me/rounds', 'get', 200).parse(mine.body)).not.toThrow();

    const submitted = await request(app)
      .post(`/rounds/${created.body.id}/feedback`)
      .set('authorization', interviewerAuth)
      .send({ rating: 3, notes: 'Contract test feedback.' });
    expect(submitted.status).toBe(201);
    expect(() =>
      documentedSchema('/rounds/:id/feedback', 'post', 201).parse(submitted.body),
    ).not.toThrow();

    const panel = await request(app)
      .get(`/rounds/${created.body.id}/feedback`)
      .set('authorization', interviewerAuth);
    expect(panel.status).toBe(200);
    expect(() => documentedSchema('/rounds/:id/feedback', 'get', 200).parse(panel.body)).not.toThrow();
  });

  it('POST /applications 201 and GET /audit/candidates/:id 200', async () => {
    const login = await request(app)
      .post('/auth/login')
      .send({ email: RECRUITER_EMAIL, password: DEV_PASSWORD });
    const auth = `Bearer ${login.body.token}`;

    const hiringManager = await prisma.user.findFirstOrThrow({
      where: { role: UserRole.HIRING_MANAGER },
      select: { id: true },
    });
    await prisma.role.upsert({
      where: { id: CONTRACT_ROLE_ID },
      create: { id: CONTRACT_ROLE_ID, title: 'Contract Test Role', hiringManagerId: hiringManager.id },
      update: {},
    });
    const candidate = await prisma.candidate.create({
      data: {
        name: `Contract Test Applicant ${(contractSequence += 1)}`,
        email: `${CONTRACT_CANDIDATE_PREFIX}.applicant.${contractSequence}@example.net`,
      },
      select: { id: true },
    });

    const created = await request(app)
      .post('/applications')
      .set('authorization', auth)
      .send({ candidateId: candidate.id, roleId: CONTRACT_ROLE_ID });

    expect(created.status).toBe(201);
    expect(() => documentedSchema('/applications', 'post', 201).parse(created.body)).not.toThrow();

    const audit = await request(app)
      .get(`/audit/candidates/${candidate.id}`)
      .set('authorization', auth);

    expect(audit.status).toBe(200);
    expect(() =>
      documentedSchema('/audit/candidates/:id', 'get', 200).parse(audit.body),
    ).not.toThrow();
    expect(audit.body.timeline.length).toBeGreaterThan(0);
  });

  it('GET /roles 200 and POST /roles 201', async () => {
    const login = await request(app)
      .post('/auth/login')
      .send({ email: RECRUITER_EMAIL, password: DEV_PASSWORD });
    const auth = `Bearer ${login.body.token}`;

    const hiringManager = await prisma.user.findFirstOrThrow({
      where: { role: UserRole.HIRING_MANAGER },
      select: { id: true },
    });

    const created = await request(app)
      .post('/roles')
      .set('authorization', auth)
      .send({ title: 'Contract Test Opened Req', hiringManagerId: hiringManager.id });

    expect(created.status).toBe(201);
    expect(() => documentedSchema('/roles', 'post', 201).parse(created.body)).not.toThrow();

    const listed = await request(app).get('/roles').set('authorization', auth);

    expect(listed.status).toBe(200);
    expect(() => documentedSchema('/roles', 'get', 200).parse(listed.body)).not.toThrow();

    await prisma.auditEvent.deleteMany({ where: { entityId: created.body.id } });
    await prisma.role.deleteMany({ where: { id: created.body.id } });
  });

  it('GET /pipeline 200 — recruiter and hiring-manager scopes', async () => {
    const schema = documentedSchema('/pipeline', 'get', 200);

    for (const email of [RECRUITER_EMAIL, HIRING_MANAGER_EMAIL]) {
      const login = await request(app).post('/auth/login').send({ email, password: DEV_PASSWORD });
      const response = await request(app)
        .get('/pipeline')
        .set('authorization', `Bearer ${login.body.token}`);

      expect(response.status, `as ${email}`).toBe(200);
      expect(() => schema.parse(response.body), `as ${email}`).not.toThrow();
      expect(response.body.length, `as ${email}`).toBeGreaterThan(0);
    }
  });

  it('GET /pipeline/stuck 200', async () => {
    const login = await request(app)
      .post('/auth/login')
      .send({ email: RECRUITER_EMAIL, password: DEV_PASSWORD });

    const response = await request(app)
      .get('/pipeline/stuck?days=1')
      .set('authorization', `Bearer ${login.body.token}`);

    expect(response.status).toBe(200);
    expect(() => documentedSchema('/pipeline/stuck', 'get', 200).parse(response.body)).not.toThrow();
    expect(response.body.length).toBeGreaterThan(0);
  });

  it('GET /health 200', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(() => documentedSchema('/health', 'get', 200).parse(response.body)).not.toThrow();
  });
});
