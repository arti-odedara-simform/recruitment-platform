import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma, disconnectDatabase } from '../src/db/client.js';
import { CANDIDATE_SELECT } from '../src/repositories/candidate.repository.js';
import { CANDIDATE_IDS, DEV_PASSWORD } from '../src/seed/fixture.js';

/**
 * The highest-value tests in the POC (PLAN.md §9, §12 Q3). They run against the seeded
 * assignment graph: Ingrid is assigned to Amara (c01) and not to Bruno (c02); Ian is
 * assigned to nothing.
 */

const app = createApp();

const RECRUITER = 'rachel.recruiter@example.com';
/** Assigned to c01, c03, c07 — and pointedly not to c02. */
const ASSIGNED_INTERVIEWER = 'ingrid.interviewer@example.com';
/** Assigned to no round at all. */
const UNASSIGNED_INTERVIEWER = 'ian.interviewer@example.com';
const HIRING_MANAGER = 'hana.manager@example.com';

/** A well-formed uuid that is not any candidate's id. */
const NO_SUCH_CANDIDATE = '00000000-0000-4000-8000-000000000000';

/**
 * Every statement Prisma emits, in order. Prisma has no way to remove a listener, so the
 * array is cleared immediately before the request under test rather than re-registered.
 */
const emitted: string[] = [];
prisma.$on('query', (event) => emitted.push(event.query));

const tokens: Record<string, string> = {};

beforeAll(async () => {
  for (const email of [RECRUITER, ASSIGNED_INTERVIEWER, UNASSIGNED_INTERVIEWER, HIRING_MANAGER]) {
    const response = await request(app)
      .post('/auth/login')
      .send({ email, password: DEV_PASSWORD });
    expect(response.status, `could not log in as ${email} — is the fixture seeded?`).toBe(200);
    tokens[email] = response.body.token as string;
  }
});

afterAll(async () => {
  await disconnectDatabase();
});

function get(candidateId: string, email?: string) {
  const call = request(app).get(`/candidates/${candidateId}`);
  return email ? call.set('authorization', `Bearer ${tokens[email]}`) : call;
}

describe('GET /candidates/:id — recruiters', () => {
  it('returns the full record, contact details included', async () => {
    const response = await get(CANDIDATE_IDS.c01, RECRUITER);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: CANDIDATE_IDS.c01,
      name: 'Amara Osei',
      email: 'amara.osei@example.net',
      phone: '+44 20 7946 0101',
    });
  });

  it('is not scoped by assignment — a recruiter reads any candidate', async () => {
    const response = await get(CANDIDATE_IDS.c02, RECRUITER);

    expect(response.status).toBe(200);
    expect(response.body.email).toBe('bruno.costa@example.net');
  });

  it('404s on a candidate that does not exist', async () => {
    expect((await get(NO_SUCH_CANDIDATE, RECRUITER)).status).toBe(404);
  });
});

describe('GET /candidates/:id — interviewers', () => {
  it('returns an assigned candidate without any contact field', async () => {
    const response = await get(CANDIDATE_IDS.c01, ASSIGNED_INTERVIEWER);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: CANDIDATE_IDS.c01, name: 'Amara Osei' });
    // Not `toBeUndefined()` — that passes for a key present with an undefined value.
    expect(Object.keys(response.body).sort()).toEqual(['id', 'name']);
  });

  /**
   * The case that matters most. Ingrid is a legitimately assigned interviewer — a check
   * that stopped at `role === 'INTERVIEWER'` would hand her Bruno's record.
   */
  it('404s on a candidate this interviewer is not assigned to', async () => {
    const response = await get(CANDIDATE_IDS.c02, ASSIGNED_INTERVIEWER);

    expect(response.status).toBe(404);
    expect(response.body.title).toBe('Not Found');
  });

  it('404s on every candidate for an interviewer assigned to no round', async () => {
    for (const id of [CANDIDATE_IDS.c01, CANDIDATE_IDS.c02, CANDIDATE_IDS.c07]) {
      expect((await get(id, UNASSIGNED_INTERVIEWER)).status).toBe(404);
    }
  });

  /**
   * PLAN.md §4: a 403 would confirm the record exists. The two responses have to be
   * byte-identical, or the status code stops being the only thing an attacker reads.
   */
  it('makes "not yours" and "does not exist" indistinguishable', async () => {
    const notYours = await get(CANDIDATE_IDS.c02, ASSIGNED_INTERVIEWER);
    const notThere = await get(NO_SUCH_CANDIDATE, ASSIGNED_INTERVIEWER);

    expect(notYours.status).toBe(notThere.status);
    expect(notYours.body).toEqual(notThere.body);
  });
});

/**
 * Walkthrough Q3: are contact details excluded at the query, or filtered after? These
 * are the tests that make "at the query" a fact rather than a claim.
 */
describe('contact details never enter the interviewer path', () => {
  it('names no restricted column in CANDIDATE_SELECT.interviewer', () => {
    expect(Object.keys(CANDIDATE_SELECT.interviewer).sort()).toEqual(['id', 'name']);
    expect(CANDIDATE_SELECT.interviewer).not.toHaveProperty('email');
    expect(CANDIDATE_SELECT.interviewer).not.toHaveProperty('phone');
    // The recruiter set is the control: if it stopped naming them, the test above would
    // pass for the wrong reason.
    expect(Object.keys(CANDIDATE_SELECT.recruiter)).toEqual(
      expect.arrayContaining(['email', 'phone']),
    );
  });

  it('emits SQL that does not mention email or phone', async () => {
    emitted.length = 0;
    const response = await get(CANDIDATE_IDS.c01, ASSIGNED_INTERVIEWER);
    expect(response.status).toBe(200);

    // Guards against the assertion below passing vacuously on an empty array.
    expect(emitted.length).toBeGreaterThan(0);
    for (const statement of emitted) {
      expect(statement, `restricted column named in: ${statement}`).not.toMatch(/email|phone/i);
    }
  });

  it('does emit them for a recruiter — the log assertion is meaningful', async () => {
    emitted.length = 0;
    expect((await get(CANDIDATE_IDS.c01, RECRUITER)).status).toBe(200);

    expect(emitted.some((statement) => /email/i.test(statement))).toBe(true);
  });

  /**
   * The §9 leak sweep, over every interviewer-reachable candidate. It scans the raw
   * response text rather than parsed keys, so a contact detail smuggled into a nested
   * object or a message string is caught too.
   */
  it('leaks no address or phone number in any interviewer-reachable response', async () => {
    const reachable = [CANDIDATE_IDS.c01, CANDIDATE_IDS.c03, CANDIDATE_IDS.c07];

    for (const id of [...reachable, CANDIDATE_IDS.c02, NO_SUCH_CANDIDATE]) {
      const response = await get(id, ASSIGNED_INTERVIEWER);
      expect(response.text).not.toMatch(/@example\.net/);
      expect(response.text).not.toMatch(/\+\d[\d ]{6,}/);
    }
  });
});

describe('GET /candidates/:id — the guards around it', () => {
  it('401s without a token', async () => {
    expect((await get(CANDIDATE_IDS.c01)).status).toBe(401);
  });

  it('403s a hiring manager — a role gate, not a resource scope', async () => {
    const response = await get(CANDIDATE_IDS.c01, HIRING_MANAGER);

    expect(response.status).toBe(403);
    expect(response.body.title).toBe('Forbidden');
  });

  it('400s a malformed id before any query runs (PLAN.md §7)', async () => {
    emitted.length = 0;
    const response = await get('not-a-uuid', ASSIGNED_INTERVIEWER);

    expect(response.status).toBe(400);
    expect(response.body.errors[0].path).toBe('params.id');
    expect(emitted).toEqual([]);
  });
});

function list(search: string, email?: string) {
  const call = request(app).get(`/candidates${search}`);
  return email ? call.set('authorization', `Bearer ${tokens[email]}`) : call;
}

describe('GET /candidates — pagination and search', () => {
  it('defaults to page 1 of 20, ordered by name', async () => {
    const response = await list('', RECRUITER);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ page: 1, pageSize: 20 });
    expect(response.body.items.length).toBeLessThanOrEqual(20);
    expect(response.body.totalPages).toBe(Math.ceil(response.body.total / 20));

    const names = (response.body.items as Array<{ name: string }>).map((c) => c.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('pages without overlap', async () => {
    const first = await list('?pageSize=2&page=1', RECRUITER);
    const second = await list('?pageSize=2&page=2', RECRUITER);

    expect(first.body.items).toHaveLength(2);
    expect(second.body.items).toHaveLength(2);
    const ids = [...first.body.items, ...second.body.items].map((c: { id: string }) => c.id);
    expect(new Set(ids).size).toBe(4);
  });

  it('returns an empty page past the end, not an error', async () => {
    const response = await list('?page=100000', RECRUITER);

    expect(response.status).toBe(200);
    expect(response.body.items).toEqual([]);
  });

  it('searches name case-insensitively for a recruiter', async () => {
    const response = await list('?q=AMARA', RECRUITER);

    expect(response.status).toBe(200);
    expect(response.body.items.map((c: { id: string }) => c.id)).toContain(CANDIDATE_IDS.c01);
    expect(response.body.items.map((c: { id: string }) => c.id)).not.toContain(CANDIDATE_IDS.c02);
  });

  it('searches email and phone for a recruiter', async () => {
    const byEmail = await list('?q=bruno.costa@', RECRUITER);
    const byPhone = await list(`?q=${encodeURIComponent('7946 0101')}`, RECRUITER);

    expect(byEmail.body.items.map((c: { id: string }) => c.id)).toEqual([CANDIDATE_IDS.c02]);
    expect(byPhone.body.items.map((c: { id: string }) => c.id)).toEqual([CANDIDATE_IDS.c01]);
  });

  it('treats a blank q as no search', async () => {
    const blank = await list('?q=%20%20', RECRUITER);
    const none = await list('', RECRUITER);

    expect(blank.body.total).toBe(none.body.total);
  });

  it('400s an out-of-range page size', async () => {
    const response = await list('?pageSize=101', RECRUITER);

    expect(response.status).toBe(400);
    expect(response.body.errors[0].path).toBe('query.pageSize');
  });

  it('scopes an interviewer to assigned candidates, name and id only', async () => {
    const response = await list('', ASSIGNED_INTERVIEWER);

    expect(response.status).toBe(200);
    const ids = response.body.items.map((c: { id: string }) => c.id);
    expect(ids).toEqual(expect.arrayContaining([CANDIDATE_IDS.c01, CANDIDATE_IDS.c03, CANDIDATE_IDS.c07]));
    expect(ids).not.toContain(CANDIDATE_IDS.c02);
    for (const item of response.body.items) {
      expect(Object.keys(item).sort()).toEqual(['id', 'name']);
    }
    expect(response.text).not.toMatch(/@example\.net/);
  });

  it('returns nothing for an interviewer assigned to no round', async () => {
    const response = await list('', UNASSIGNED_INTERVIEWER);

    expect(response.body).toMatchObject({ items: [], total: 0, totalPages: 0 });
  });

  /**
   * The oracle case: if `q` reached `email` for an interviewer, this would return Amara
   * and confirm a fragment of her address.
   */
  it('does not let an interviewer search contact fields', async () => {
    emitted.length = 0;
    const response = await list('?q=amara.osei@example', ASSIGNED_INTERVIEWER);

    expect(response.status).toBe(200);
    expect(response.body.items).toEqual([]);
    expect(emitted.length).toBeGreaterThan(0);
    for (const statement of emitted) {
      expect(statement, `restricted column named in: ${statement}`).not.toMatch(/email|phone/i);
    }
  });

  it('401s without a token and 403s a hiring manager', async () => {
    expect((await list('')).status).toBe(401);
    expect((await list('', HIRING_MANAGER)).status).toBe(403);
  });
});
