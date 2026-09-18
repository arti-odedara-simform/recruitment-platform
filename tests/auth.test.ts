import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { UserRole } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma, disconnectDatabase } from '../src/db/client.js';
import { hashPassword } from '../src/auth/password.js';
import { signAccessToken } from '../src/auth/tokens.js';
import { requireAuth, requireRole, actorOf } from '../src/http/middleware/auth.js';
import { errorHandler } from '../src/http/middleware/errorHandler.js';
import { env } from '../src/config/env.js';

const app = createApp();

const PASSWORD = 'correct-horse-battery-staple';
const RECRUITER_EMAIL = 'auth.test.recruiter@example.com';
const INTERVIEWER_EMAIL = 'auth.test.interviewer@example.com';
const EMAILS = [RECRUITER_EMAIL, INTERVIEWER_EMAIL];

let recruiterId = '';
let interviewerId = '';

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: EMAILS } } });
  const passwordHash = await hashPassword(PASSWORD);

  const recruiter = await prisma.user.create({
    data: { email: RECRUITER_EMAIL, name: 'Auth Test Recruiter', role: UserRole.RECRUITER, passwordHash },
  });
  const interviewer = await prisma.user.create({
    data: { email: INTERVIEWER_EMAIL, name: 'Auth Test Interviewer', role: UserRole.INTERVIEWER, passwordHash },
  });

  recruiterId = recruiter.id;
  interviewerId = interviewer.id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: EMAILS } } });
  await disconnectDatabase();
});

async function tokenFor(email: string): Promise<string> {
  const response = await request(app).post('/auth/login').send({ email, password: PASSWORD });
  expect(response.status).toBe(200);
  return response.body.token as string;
}

describe('POST /auth/login', () => {
  it('issues a 15-minute bearer token and the caller\'s own record', async () => {
    const response = await request(app)
      .post('/auth/login')
      .send({ email: RECRUITER_EMAIL, password: PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: 900,
      user: { id: recruiterId, email: RECRUITER_EMAIL, role: 'RECRUITER' },
    });

    const claims = jwt.verify(response.body.token, env.JWT_SECRET) as jwt.JwtPayload;
    expect(claims.sub).toBe(recruiterId);
    expect(claims.role).toBe('RECRUITER');
    expect(claims.exp! - claims.iat!).toBe(900);
  });

  it('matches the email case-insensitively', async () => {
    const response = await request(app)
      .post('/auth/login')
      .send({ email: `  ${RECRUITER_EMAIL.toUpperCase()} `, password: PASSWORD });

    expect(response.status).toBe(200);
  });

  // PLAN.md §1 is about candidate contact details, but the same rule applies to the
  // credential column: it must not appear in any response body.
  it('never returns the password hash, and carries none in the token', async () => {
    const response = await request(app)
      .post('/auth/login')
      .send({ email: RECRUITER_EMAIL, password: PASSWORD });

    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain('passwordHash');
    expect(serialised).not.toContain('$2');           // no bcrypt hash anywhere
    expect(serialised).not.toContain(PASSWORD);

    const [, payload] = (response.body.token as string).split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'role', 'sub']);
  });

  // A 401 that differs between the two cases is an account-enumeration oracle.
  it('gives byte-identical 401s for a wrong password and an unknown account', async () => {
    const wrongPassword = await request(app)
      .post('/auth/login')
      .send({ email: RECRUITER_EMAIL, password: 'not-the-password' });
    const unknownEmail = await request(app)
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: PASSWORD });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
    expect(wrongPassword.body.detail).toBe('Invalid email or password.');
    expect(wrongPassword.headers['www-authenticate']).toBe('Bearer');
  });

  // Brief §6: bad input is rejected before any logic runs. These never reach the service.
  it.each([
    ['a missing body', {}],
    ['a malformed email', { email: 'not-an-email', password: PASSWORD }],
    ['an empty password', { email: RECRUITER_EMAIL, password: '' }],
    ['a non-string password', { email: RECRUITER_EMAIL, password: 12345 }],
  ])('rejects %s with a 400 from the validate middleware', async (_label, body) => {
    const response = await request(app).post('/auth/login').send(body);

    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body.errors.length).toBeGreaterThan(0);
  });
});

describe('requireAuth', () => {
  it('admits a valid token and attaches the actor', async () => {
    const response = await request(app)
      .get('/auth/me')
      .set('authorization', `Bearer ${await tokenFor(INTERVIEWER_EMAIL)}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: interviewerId,
      email: INTERVIEWER_EMAIL,
      name: 'Auth Test Interviewer',
      role: 'INTERVIEWER',
    });
    expect(response.body.passwordHash).toBeUndefined();
  });

  // Brief §6: there is no anonymous path. Table-driven over the ways a caller can fail
  // to present a usable token.
  it.each([
    ['no Authorization header', undefined],
    ['an empty header', ''],
    ['the wrong scheme', 'Basic dXNlcjpwYXNz'],
    ['Bearer with no token', 'Bearer'],
    ['Bearer with a blank token', 'Bearer    '],
    ['a token with trailing junk', 'Bearer aaa.bbb.ccc extra'],
    ['a structurally invalid token', 'Bearer not-a-jwt'],
  ])('401s on %s', async (_label, header) => {
    const pending = request(app).get('/auth/me');
    if (header !== undefined) pending.set('authorization', header);
    const response = await pending;

    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
  });

  it('401s on a token signed with a different secret', async () => {
    const forged = jwt.sign({ role: 'RECRUITER' }, 'a'.repeat(64), {
      subject: recruiterId,
      issuer: 'recruitment-pipeline-poc',
      audience: 'recruitment-pipeline-poc-api',
      expiresIn: 900,
    });

    const response = await request(app).get('/auth/me').set('authorization', `Bearer ${forged}`);
    expect(response.status).toBe(401);
  });

  // The alg-confusion break: re-sign the payload with `alg: none` and no signature.
  it('401s on an unsigned "alg: none" token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: recruiterId,
        role: 'RECRUITER',
        iss: 'recruitment-pipeline-poc',
        aud: 'recruitment-pipeline-poc-api',
        exp: Math.floor(Date.now() / 1000) + 900,
      }),
    ).toString('base64url');

    const response = await request(app)
      .get('/auth/me')
      .set('authorization', `Bearer ${header}.${payload}.`);

    expect(response.status).toBe(401);
  });

  it('401s on an expired token, and says so', async () => {
    const expired = jwt.sign({ role: 'RECRUITER' }, env.JWT_SECRET, {
      algorithm: 'HS256',
      subject: recruiterId,
      issuer: 'recruitment-pipeline-poc',
      audience: 'recruitment-pipeline-poc-api',
      expiresIn: -60,
    });

    const response = await request(app).get('/auth/me').set('authorization', `Bearer ${expired}`);

    expect(response.status).toBe(401);
    expect(response.body.detail).toContain('expired');
  });

  it('401s on a valid signature whose subject no longer exists', async () => {
    const orphan = signAccessToken({
      id: '00000000-0000-4000-8000-000000000000',
      role: UserRole.RECRUITER,
    });

    const response = await request(app).get('/auth/me').set('authorization', `Bearer ${orphan}`);

    expect(response.status).toBe(401);
    expect(response.body.detail).toContain('no longer exists');
  });

  it('401s on a token whose role claim is not a UserRole', async () => {
    const bogus = jwt.sign({ role: 'SUPERUSER' }, env.JWT_SECRET, {
      algorithm: 'HS256',
      subject: recruiterId,
      issuer: 'recruitment-pipeline-poc',
      audience: 'recruitment-pipeline-poc-api',
      expiresIn: 900,
    });

    const response = await request(app).get('/auth/me').set('authorization', `Bearer ${bogus}`);
    expect(response.status).toBe(401);
  });
});

describe('requireRole', () => {
  // No role-guarded route exists until D4, so the gate is driven directly. Built the same
  // way app.ts builds the real one: requireAuth, then requireRole, then the error handler.
  function appWith(...middleware: express.RequestHandler[]): express.Express {
    const probe = express();
    probe.use(express.json());
    probe.get('/probe', ...middleware, (req, res) => {
      res.json({ actor: actorOf(req) });
    });
    probe.use(errorHandler);
    return probe;
  }

  const guarded = appWith(requireAuth, requireRole(UserRole.RECRUITER));

  it('admits the permitted role', async () => {
    const response = await request(guarded)
      .get('/probe')
      .set('authorization', `Bearer ${await tokenFor(RECRUITER_EMAIL)}`);

    expect(response.status).toBe(200);
    expect(response.body.actor).toEqual({ id: recruiterId, role: 'RECRUITER' });
  });

  // 403, not the 404 that out-of-scope resources get (PLAN.md §4): the route's existence
  // is not a secret, only the records behind it are.
  it('403s a wrong-role caller rather than 404ing', async () => {
    const response = await request(guarded)
      .get('/probe')
      .set('authorization', `Bearer ${await tokenFor(INTERVIEWER_EMAIL)}`);

    expect(response.status).toBe(403);
    expect(response.body.detail).toContain('RECRUITER');
  });

  it('accepts any one of several permitted roles', async () => {
    const multi = appWith(requireAuth, requireRole(UserRole.RECRUITER, UserRole.HIRING_MANAGER));

    const response = await request(multi)
      .get('/probe')
      .set('authorization', `Bearer ${await tokenFor(RECRUITER_EMAIL)}`);

    expect(response.status).toBe(200);
  });

  // Fails closed: mounting the gate without requireAuth ahead of it must not open the
  // route to anonymous callers.
  it('401s when mounted without requireAuth, rather than admitting an actorless request', async () => {
    const misconfigured = appWith(requireRole(UserRole.RECRUITER));

    const response = await request(misconfigured).get('/probe');
    expect(response.status).toBe(401);
  });
});
