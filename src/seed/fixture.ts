import { createHash } from 'node:crypto';
import { RoleStatus, Stage, UserRole } from '@prisma/client';

/**
 * The demo fixture: the roles, candidates, applications, rounds and assignments that
 * PLAN.md §10 calls for, as pure data. Nothing here touches the database — `run.ts`
 * writes it, `src/seed.ts` prints it, and tests import the id constants directly.
 *
 * Two properties this file exists to guarantee:
 *
 * 1. **Ids are deterministic.** Every row's primary key is a UUIDv5 of its fixture key,
 *    so `CANDIDATE_IDS.c02` is the same uuid on a laptop, in CI and in the compose
 *    stack. README curl examples and the D4 authorization tests can hard-code them
 *    instead of querying for an id first.
 * 2. **The assignment graph has holes on purpose.** An interviewer fixture where
 *    everyone can see everything proves nothing. See ASSIGNMENTS below.
 */

/**
 * Fixed namespace for the UUIDv5 derivation. Arbitrary, and permanent: changing it
 * changes every seeded id, which would break the ids written into the README.
 */
const NAMESPACE = 'f7c0d6a2-3b14-4f9e-9a52-6d1b8e4c5a70';

/**
 * UUIDv5 (RFC 9562 §5.5) of `key` under NAMESPACE. Hand-rolled rather than pulled from
 * a dependency: it is nine lines, and the seed is the only caller.
 */
export function fixtureId(key: string): string {
  const namespaceBytes = Buffer.from(NAMESPACE.replaceAll('-', ''), 'hex');
  const digest = createHash('sha1').update(Buffer.concat([namespaceBytes, Buffer.from(key, 'utf8')])).digest();

  const bytes = digest.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 9562 variant

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Negative `days` is in the past. Resolved against a single `now` per seed run. */
export function daysFrom(now: Date, days: number): Date {
  return new Date(now.getTime() + days * MS_PER_DAY);
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * Development credentials, printed on every run and committed to the repository. They
 * exist so a reviewer can `curl` the API a minute after `docker compose up`. Nothing here
 * is a secret, and nothing here should ever reach an environment that holds real data.
 */
export const DEV_PASSWORD = 'poc-dev-password';

export interface FixtureUser {
  key: string;
  email: string;
  name: string;
  role: UserRole;
}

export const USERS = [
  { key: 'rachel', email: 'rachel.recruiter@example.com', name: 'Rachel Ahmed', role: UserRole.RECRUITER },
  { key: 'raj', email: 'raj.recruiter@example.com', name: 'Raj Patel', role: UserRole.RECRUITER },
  { key: 'ingrid', email: 'ingrid.interviewer@example.com', name: 'Ingrid Olsen', role: UserRole.INTERVIEWER },
  { key: 'ivan', email: 'ivan.interviewer@example.com', name: 'Ivan Petrov', role: UserRole.INTERVIEWER },
  { key: 'iris', email: 'iris.interviewer@example.com', name: 'Iris Chen', role: UserRole.INTERVIEWER },
  { key: 'ian', email: 'ian.interviewer@example.com', name: 'Ian Murphy', role: UserRole.INTERVIEWER },
  { key: 'hana', email: 'hana.manager@example.com', name: 'Hana Suzuki', role: UserRole.HIRING_MANAGER },
] as const satisfies readonly FixtureUser[];

export type UserKey = (typeof USERS)[number]['key'];

// ---------------------------------------------------------------------------
// Roles (job reqs)
// ---------------------------------------------------------------------------

export interface FixtureRole {
  key: string;
  title: string;
  hiringManager: UserKey;
  status: RoleStatus;
  openedDaysAgo: number;
}

/**
 * Three roles, per PLAN.md §10. One is CLOSED — the §6 pipeline aggregate filters on
 * `status = 'OPEN'`, and a fixture where every role is open would let a missing WHERE
 * clause pass unnoticed.
 */
export const ROLES = [
  { key: 'backend', title: 'Senior Backend Engineer', hiringManager: 'hana', status: RoleStatus.OPEN, openedDaysAgo: 60 },
  { key: 'platform', title: 'Platform Engineer', hiringManager: 'hana', status: RoleStatus.OPEN, openedDaysAgo: 30 },
  { key: 'design', title: 'Product Designer', hiringManager: 'hana', status: RoleStatus.CLOSED, openedDaysAgo: 90 },
] as const satisfies readonly FixtureRole[];

export type RoleKey = (typeof ROLES)[number]['key'];

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export interface FixtureCandidate {
  key: string;
  name: string;
  /** RESTRICTED — recruiter-only (PLAN.md §1). */
  email: string;
  /** RESTRICTED — recruiter-only. Null on some rows so the optional path is exercised. */
  phone: string | null;
}

/**
 * Fifteen candidates. Every one has a real-looking `email`, and most have a `phone`:
 * the contact-leak sweep in PLAN.md §9 scans interviewer-reachable responses for `@`
 * and phone patterns, so the fixture has to contain something for it to find.
 */
export const CANDIDATES = [
  { key: 'c01', name: 'Amara Osei', email: 'amara.osei@example.net', phone: '+44 20 7946 0101' },
  { key: 'c02', name: 'Bruno Costa', email: 'bruno.costa@example.net', phone: '+351 21 000 0102' },
  { key: 'c03', name: 'Chen Wei', email: 'chen.wei@example.net', phone: null },
  { key: 'c04', name: 'Dara Singh', email: 'dara.singh@example.net', phone: '+91 22 4000 0104' },
  { key: 'c05', name: 'Elif Demir', email: 'elif.demir@example.net', phone: '+90 212 000 0105' },
  { key: 'c06', name: 'Farid Haddad', email: 'farid.haddad@example.net', phone: null },
  { key: 'c07', name: 'Grace Njoroge', email: 'grace.njoroge@example.net', phone: '+254 20 000 0107' },
  { key: 'c08', name: 'Hugo Lindqvist', email: 'hugo.lindqvist@example.net', phone: '+46 8 000 0108' },
  { key: 'c09', name: 'Ines Batista', email: 'ines.batista@example.net', phone: '+55 11 0000 0109' },
  { key: 'c10', name: 'Jonas Vogel', email: 'jonas.vogel@example.net', phone: '+49 30 000 0110' },
  { key: 'c11', name: 'Keiko Tanaka', email: 'keiko.tanaka@example.net', phone: '+81 3 0000 0111' },
  { key: 'c12', name: 'Liam Byrne', email: 'liam.byrne@example.net', phone: null },
  { key: 'c13', name: 'Mira Kovac', email: 'mira.kovac@example.net', phone: '+385 1 000 0113' },
  { key: 'c14', name: 'Noor Rahman', email: 'noor.rahman@example.net', phone: '+880 2 000 0114' },
  { key: 'c15', name: 'Oskar Nowak', email: 'oskar.nowak@example.net', phone: '+48 22 000 0115' },
] as const satisfies readonly FixtureCandidate[];

export type CandidateKey = (typeof CANDIDATES)[number]['key'];

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

export interface FixtureApplication {
  key: string;
  candidate: CandidateKey;
  role: RoleKey;
  stage: Stage;
  /** Drives `currentStageEnteredAt`, the column the §6 ageing aggregate reads. */
  daysInStage: number;
}

/**
 * Seventeen applications across fifteen candidates — `c01` and `c05` each sit on two
 * roles, because the pipeline unit is the *application*, not the candidate, and a
 * fixture of one-role candidates would let a query that groups by candidate look right.
 *
 * `daysInStage` spans 1 to 45 days on purpose: the §6 ageing columns need a spread to
 * mean anything, and the "stuck beyond N days" view in §8 needs rows on both sides of
 * any plausible threshold.
 */
export const APPLICATIONS = [
  // Senior Backend Engineer — a full funnel, one row per stage.
  { key: 'a01', candidate: 'c01', role: 'backend', stage: Stage.INTERVIEW, daysInStage: 6 },
  { key: 'a02', candidate: 'c02', role: 'backend', stage: Stage.INTERVIEW, daysInStage: 21 },
  { key: 'a03', candidate: 'c03', role: 'backend', stage: Stage.SCREEN, daysInStage: 3 },
  { key: 'a04', candidate: 'c04', role: 'backend', stage: Stage.SCREEN, daysInStage: 12 },
  { key: 'a05', candidate: 'c05', role: 'backend', stage: Stage.APPLIED, daysInStage: 1 },
  { key: 'a06', candidate: 'c06', role: 'backend', stage: Stage.APPLIED, daysInStage: 9 },
  { key: 'a07', candidate: 'c07', role: 'backend', stage: Stage.OFFER, daysInStage: 4 },
  { key: 'a08', candidate: 'c08', role: 'backend', stage: Stage.REJECTED, daysInStage: 30 },
  { key: 'a09', candidate: 'c09', role: 'backend', stage: Stage.HIRED, daysInStage: 45 },

  // Platform Engineer.
  { key: 'a10', candidate: 'c10', role: 'platform', stage: Stage.INTERVIEW, daysInStage: 2 },
  { key: 'a11', candidate: 'c11', role: 'platform', stage: Stage.SCREEN, daysInStage: 8 },
  { key: 'a12', candidate: 'c12', role: 'platform', stage: Stage.APPLIED, daysInStage: 15 },
  { key: 'a13', candidate: 'c13', role: 'platform', stage: Stage.OFFER, daysInStage: 1 },
  { key: 'a14', candidate: 'c01', role: 'platform', stage: Stage.APPLIED, daysInStage: 5 },
  { key: 'a15', candidate: 'c14', role: 'platform', stage: Stage.REJECTED, daysInStage: 18 },

  // Product Designer — CLOSED, so these must not appear in the §6 pipeline view.
  { key: 'a16', candidate: 'c15', role: 'design', stage: Stage.SCREEN, daysInStage: 11 },
  { key: 'a17', candidate: 'c05', role: 'design', stage: Stage.APPLIED, daysInStage: 20 },
] as const satisfies readonly FixtureApplication[];

export type ApplicationKey = (typeof APPLICATIONS)[number]['key'];

// ---------------------------------------------------------------------------
// Interview rounds
// ---------------------------------------------------------------------------

export interface FixtureRound {
  key: string;
  application: ApplicationKey;
  stage: Stage;
  /** Relative to the seed run; negative is a round that already happened. */
  scheduledInDays: number;
}

export const ROUNDS = [
  { key: 'r01', application: 'a01', stage: Stage.INTERVIEW, scheduledInDays: -2 },
  { key: 'r02', application: 'a02', stage: Stage.INTERVIEW, scheduledInDays: -20 },
  { key: 'r03', application: 'a03', stage: Stage.SCREEN, scheduledInDays: -1 },
  { key: 'r04', application: 'a04', stage: Stage.SCREEN, scheduledInDays: -10 },
  { key: 'r05', application: 'a07', stage: Stage.OFFER, scheduledInDays: -3 },
  { key: 'r06', application: 'a10', stage: Stage.INTERVIEW, scheduledInDays: 1 },
  { key: 'r07', application: 'a11', stage: Stage.SCREEN, scheduledInDays: -6 },
  { key: 'r08', application: 'a13', stage: Stage.OFFER, scheduledInDays: 2 },
  { key: 'r09', application: 'a16', stage: Stage.SCREEN, scheduledInDays: -9 },
  // A second round on the same application — one candidate, two rounds, so a query that
  // joins through rounds has to survive the duplicate.
  { key: 'r10', application: 'a01', stage: Stage.INTERVIEW, scheduledInDays: 3 },
] as const satisfies readonly FixtureRound[];

export type RoundKey = (typeof ROUNDS)[number]['key'];

// ---------------------------------------------------------------------------
// Assignments — the shape the authorization tests depend on
// ---------------------------------------------------------------------------

export interface FixtureAssignment {
  round: RoundKey;
  interviewer: UserKey;
  assignedBy: UserKey;
}

/**
 * The gaps here are the fixture's whole point (PLAN.md §9, §12 Q3):
 *
 * - **Ian is assigned to nothing.** He is the "interviewer with no business seeing this
 *   candidate at all" case — every `GET /candidates/:id` as Ian must 404.
 * - **Ingrid is assigned to some rounds and not others.** She sees c01, c03 and c07, and
 *   must 404 on c02 even though she is a legitimately assigned interviewer elsewhere.
 *   This is the case a naive `role === 'INTERVIEWER'` check passes and a scoped query
 *   catches, so it matters more than Ian's.
 * - **Ingrid and Ivan share r01** (and r10) — a two-person panel on one round, which is
 *   the fixture the §5 concurrency tests need: two different interviewers submitting
 *   feedback for the same round at the same time.
 * - **r04 has no assignments at all.** A round that exists but belongs to nobody.
 */
export const ASSIGNMENTS = [
  { round: 'r01', interviewer: 'ingrid', assignedBy: 'rachel' },
  { round: 'r01', interviewer: 'ivan', assignedBy: 'rachel' },
  { round: 'r02', interviewer: 'ivan', assignedBy: 'rachel' },
  { round: 'r03', interviewer: 'ingrid', assignedBy: 'rachel' },
  { round: 'r05', interviewer: 'ingrid', assignedBy: 'rachel' },
  { round: 'r06', interviewer: 'iris', assignedBy: 'raj' },
  { round: 'r07', interviewer: 'iris', assignedBy: 'raj' },
  { round: 'r09', interviewer: 'iris', assignedBy: 'raj' },
  { round: 'r10', interviewer: 'ingrid', assignedBy: 'rachel' },
  { round: 'r10', interviewer: 'ivan', assignedBy: 'rachel' },
] as const satisfies readonly FixtureAssignment[];

// ---------------------------------------------------------------------------
// Resolved ids
// ---------------------------------------------------------------------------

function idsOf<T extends { key: string }>(rows: readonly T[], prefix: string): Record<T['key'], string> {
  return Object.fromEntries(rows.map((row) => [row.key, fixtureId(`${prefix}:${row.key}`)])) as Record<
    T['key'],
    string
  >;
}

export const USER_IDS = idsOf(USERS, 'user');
export const ROLE_IDS = idsOf(ROLES, 'role');
export const CANDIDATE_IDS = idsOf(CANDIDATES, 'candidate');
export const APPLICATION_IDS = idsOf(APPLICATIONS, 'application');
export const ROUND_IDS = idsOf(ROUNDS, 'round');
