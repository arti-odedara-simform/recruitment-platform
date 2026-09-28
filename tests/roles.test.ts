import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { RoleStatus, UserRole } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma, disconnectDatabase } from '../src/db/client.js';
import { hashPassword } from '../src/auth/password.js';
import { DEV_PASSWORD, ROLE_IDS, USER_IDS } from '../src/seed/fixture.js';

/**
 * PLAN.md §4 — job reqs. The seeded fixture has three, one of them CLOSED, which is
 * what makes the default `?status=OPEN` filter testable without building anything.
 */

const app = createApp();

const RECRUITER = 'rachel.recruiter@example.com';
const HIRING_MANAGER = 'hana.manager@example.com';
const INTERVIEWER = 'ingrid.interviewer@example.com';

/** A second hiring manager, so "scoped to own reqs" has something to exclude. */
const OTHER_MANAGER = 'roles.test.manager@example.com';
const OTHER_MANAGER_PASSWORD = 'roles-test-password';

const CREATED_TITLE_PREFIX = 'Roles Test Req';
const NO_SUCH_UUID = '00000000-0000-4000-8000-000000000000';

const tokens: Record<string, string> = {};
const userIds: Record<string, string> = {};

beforeAll(async () => {
  for (const email of [RECRUITER, HIRING_MANAGER, INTERVIEWER]) {
    const response = await request(app).post('/auth/login').send({ email, password: DEV_PASSWORD });
    expect(response.status, `could not log in as ${email} — is the fixture seeded?`).toBe(200);
    tokens[email] = response.body.token as string;
    userIds[email] = response.body.user.id as string;
  }

  await prisma.user.upsert({
    where: { email: OTHER_MANAGER },
    create: {
      email: OTHER_MANAGER,
      name: 'Roles Test Manager',
      role: UserRole.HIRING_MANAGER,
      passwordHash: await hashPassword(OTHER_MANAGER_PASSWORD),
    },
    update: {},
    select: { id: true },
  });

  const login = await request(app)
    .post('/auth/login')
    .send({ email: OTHER_MANAGER, password: OTHER_MANAGER_PASSWORD });
  tokens[OTHER_MANAGER] = login.body.token as string;
  userIds[OTHER_MANAGER] = login.body.user.id as string;
});

afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { email: OTHER_MANAGER } });
  await disconnectDatabase();
});

/** Reqs created through the API, plus the audit rows they wrote. */
async function cleanup(): Promise<void> {
  const created = await prisma.role.findMany({
    where: { title: { startsWith: CREATED_TITLE_PREFIX } },
    select: { id: true },
  });

  await prisma.auditEvent.deleteMany({ where: { entityId: { in: created.map((r) => r.id) } } });
  await prisma.role.deleteMany({ where: { title: { startsWith: CREATED_TITLE_PREFIX } } });
}

interface RoleBody {
  id: string;
  title: string;
  status: RoleStatus;
  openedAt: string;
  hiringManager: { id: string; name: string };
  applicationCount: number;
}

function get(email: string | undefined, queryString = '') {
  const call = request(app).get(`/roles${queryString}`);
  return email ? call.set('authorization', `Bearer ${tokens[email]}`) : call;
}

function post(email: string | undefined, payload: unknown) {
  const call = request(app).post('/roles').send(payload as object);
  return email ? call.set('authorization', `Bearer ${tokens[email]}`) : call;
}

let sequence = 0;

function aReq() {
  return { title: `${CREATED_TITLE_PREFIX} ${(sequence += 1)}`, hiringManagerId: USER_IDS.hana };
}

describe('GET /roles', () => {
  it('lists open reqs with their hiring manager and application count', async () => {
    const response = await get(RECRUITER);

    expect(response.status).toBe(200);
    const backend = (response.body as RoleBody[]).find((role) => role.id === ROLE_IDS.backend);

    expect(backend).toMatchObject({
      title: 'Senior Backend Engineer',
      status: RoleStatus.OPEN,
      hiringManager: { id: USER_IDS.hana, name: 'Hana Suzuki' },
      applicationCount: 9,
    });
  });

  it('omits CLOSED reqs by default', async () => {
    const body: RoleBody[] = (await get(RECRUITER)).body;

    expect(body.find((role) => role.id === ROLE_IDS.design)).toBeUndefined();
    expect(body.every((role) => role.status === RoleStatus.OPEN)).toBe(true);
  });

  it('shows them on ?status=CLOSED and ?status=ALL', async () => {
    const closed: RoleBody[] = (await get(RECRUITER, '?status=CLOSED')).body;
    expect(closed.map((role) => role.id)).toContain(ROLE_IDS.design);
    expect(closed.every((role) => role.status === RoleStatus.CLOSED)).toBe(true);

    const all: RoleBody[] = (await get(RECRUITER, '?status=ALL')).body;
    expect(all.map((role) => role.id)).toEqual(
      expect.arrayContaining([ROLE_IDS.backend, ROLE_IDS.design]),
    );
  });

  it('400s a status outside the enum', async () => {
    const response = await get(RECRUITER, '?status=OPENISH');

    expect(response.status).toBe(400);
    expect(response.body.errors?.[0].path).toBe('query.status');
  });

  /**
   * The restriction is a predicate in the hiring manager's own query, not a filter over
   * a recruiter's result — so a req they do not own is never in the row set.
   */
  it('scopes a hiring manager to their own reqs', async () => {
    const created = await post(RECRUITER, {
      ...aReq(),
      hiringManagerId: userIds[OTHER_MANAGER],
    });
    expect(created.status).toBe(201);

    const mine: RoleBody[] = (await get(HIRING_MANAGER)).body;
    expect(mine.map((role) => role.id)).toContain(ROLE_IDS.backend);
    expect(mine.map((role) => role.id)).not.toContain(created.body.id);
    expect(mine.every((role) => role.hiringManager.id === USER_IDS.hana)).toBe(true);

    // The control: the req is real, and its own manager sees it.
    const theirs: RoleBody[] = (await get(OTHER_MANAGER)).body;
    expect(theirs.map((role) => role.id)).toEqual([created.body.id]);
  });

  it('403s an interviewer and 401s an anonymous caller', async () => {
    expect((await get(INTERVIEWER)).status).toBe(403);
    expect((await get(undefined)).status).toBe(401);
  });
});

describe('POST /roles', () => {
  it('opens a req at OPEN, with an audit row in the same transaction', async () => {
    const input = aReq();

    const response = await post(RECRUITER, input);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      title: input.title,
      status: RoleStatus.OPEN,
      hiringManager: { id: USER_IDS.hana },
      applicationCount: 0,
    });

    const events = await prisma.auditEvent.findMany({ where: { entityId: response.body.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'ROLE_OPENED',
      entity: 'Role',
      actorId: userIds[RECRUITER],
    });
  });

  it('appears in the list it was created for', async () => {
    const created = await post(RECRUITER, aReq());
    const listed: RoleBody[] = (await get(RECRUITER)).body;

    expect(listed.map((role) => role.id)).toContain(created.body.id);
  });

  /** Ownership is what scopes a hiring manager, so the named user's role is checked. */
  it('400s a hiringManagerId that is not a hiring manager', async () => {
    const response = await post(RECRUITER, {
      ...aReq(),
      hiringManagerId: userIds[INTERVIEWER],
    });

    expect(response.status).toBe(400);
    expect(response.body.errors?.[0].path).toBe('body.hiringManagerId');
    expect(await prisma.role.count({ where: { title: { startsWith: CREATED_TITLE_PREFIX } } })).toBe(0);
  });

  it('404s an unknown hiringManagerId', async () => {
    const response = await post(RECRUITER, { ...aReq(), hiringManagerId: NO_SUCH_UUID });

    expect(response.status).toBe(404);
  });

  it('400s an empty title', async () => {
    const response = await post(RECRUITER, { title: '   ', hiringManagerId: USER_IDS.hana });

    expect(response.status).toBe(400);
    expect(response.body.errors?.[0].path).toBe('body.title');
  });

  it.each([HIRING_MANAGER, INTERVIEWER])('403s %s — opening a req is a recruiter action', async (email) => {
    const response = await post(email, aReq());

    expect(response.status).toBe(403);
    expect(await prisma.role.count({ where: { title: { startsWith: CREATED_TITLE_PREFIX } } })).toBe(0);
  });

  it('401s without a token', async () => {
    expect((await post(undefined, aReq())).status).toBe(401);
  });
});
