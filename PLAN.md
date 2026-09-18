# Recruitment Pipeline POC — Implementation Plan

**Stack decision:** Express (TypeScript) REST API only, PostgreSQL 16, Prisma. No UI.
**Timebox:** 2 weeks, solo. **Repo layout:** single service + `docker compose up`.

Rationale for Express-only: every graded item in §6 of the brief lives in the data-access
layer (query-level authorization, concurrency, index behaviour, audit trace). A UI would
consume time without moving any of those. The API is the deliverable; `curl`/REST client
scripts and the test suite are the walkthrough surface.

---

## 1. The one decision everything else hangs off

> *When an interviewer's request returns candidate data, are contact details ever in the row
> Postgres handed back to Node?*

**Answer this POC commits to: no. Restricted columns are never named in the SELECT for an
interviewer-scoped request, and the assignment check is a JOIN in the same query, not an
`if` after the fetch.**

Three layers, defence in depth, in order of importance:

| Layer | Mechanism | What it stops |
|---|---|---|
| 1. Field-set selection | Two distinct, hard-coded Prisma `select` objects per entity — `CANDIDATE_SELECT.recruiter` includes `email`/`phone`; `CANDIDATE_SELECT.interviewer` does not name them at all | Contact columns ever entering process memory on an interviewer path |
| 2. Scoped repository | Interviewer reads go through `findCandidateForInterviewer(actor, candidateId)` whose `where` contains `applications: { some: { rounds: { some: { assignments: { some: { interviewerId: actor.id } } } } } }` | Direct-by-ID access to an unassigned candidate — returns 0 rows, so the route 404s. Refusal happens *in the query*. |
| 3. (Stretch) Postgres RLS + column GRANTs | A second DB role `app_interviewer` with `REVOKE SELECT (email, phone) ON candidates`, plus RLS policies keyed on `current_setting('app.actor_id')` set via `SET LOCAL` inside `prisma.$transaction` | A future bug in layers 1–2. The database itself refuses. |

Layers 1 and 2 are **required** and shipped in week 1. Layer 3 is the first stretch item —
it makes the walkthrough answer to Q3 unarguable ("here is the error Postgres raises if
application code asks for the column").

**Architectural rule that makes this hold:** there is no repository function that returns a
candidate without an `actor: { id, role }` argument. No route handler ever calls
`prisma.candidate.*` directly — lint rule (`no-restricted-imports` on `@/db/client` outside
`src/repositories/**`) enforces it. A "select everything, strip in the serializer" path
cannot be written by accident because the serializer never receives the wide shape.

---

## 2. Domain model

Prisma sketch (names final, field lists indicative):

```prisma
enum UserRole        { INTERVIEWER RECRUITER HIRING_MANAGER }
enum Stage           { APPLIED SCREEN INTERVIEW OFFER HIRED REJECTED }
enum TransitionKind  { NORMAL OVERRIDE }

model User {
  id        String @id @default(uuid())
  email     String @unique
  name      String
  role      UserRole
  passwordHash String
}

model Role {              // the open job req
  id             String @id @default(uuid())
  title          String
  hiringManagerId String
  status         String  // OPEN | CLOSED
  openedAt       DateTime @default(now())
}

model Candidate {
  id      String  @id @default(uuid())
  name    String
  email   String   // RESTRICTED — recruiter-only
  phone   String?  // RESTRICTED — recruiter-only
}

model Application {       // candidate <-> role, the pipeline unit
  candidateId           String
  roleId                String
  currentStage          Stage    @default(APPLIED)
  currentStageEnteredAt DateTime @default(now())   // denormalised for ageing, see §6
  createdAt             DateTime @default(now())
  @@id([candidateId, roleId])
  @@index([roleId, currentStage, currentStageEnteredAt])
  @@index([currentStage, currentStageEnteredAt])
}

model InterviewRound {
  id            String @id @default(uuid())
  applicationId String       // composite FK to Application
  stage         Stage        // the stage this round belongs to
  scheduledAt   DateTime
  @@index([applicationId])
}

model RoundAssignment {    // who may see/act on this round
  roundId       String
  interviewerId String
  assignedById  String
  assignedAt    DateTime @default(now())
  @@id([roundId, interviewerId])
  @@index([interviewerId])   // drives the interviewer scoping query
}

model Feedback {
  id            String @id @default(uuid())
  roundId       String
  interviewerId String
  rating        Int      // 1..4, CHECK constraint
  notes         String
  submittedAt   DateTime @default(now())
  @@unique([roundId, interviewerId])   // <- the concurrency rule, see §5
}

model StageTransition {   // append-only; the audit trace for stage movement
  id           String @id @default(uuid())
  candidateId  String
  roleId       String
  fromStage    Stage
  toStage      Stage
  kind         TransitionKind
  actorId      String
  reason       String?    // NOT NULL enforced for OVERRIDE via CHECK
  occurredAt   DateTime @default(now())
  @@index([candidateId, roleId, occurredAt])
}

model AuditEvent {        // append-only, everything else
  id        String @id @default(uuid())
  actorId   String
  action    String   // FEEDBACK_SUBMITTED | ASSIGNMENT_CREATED | STAGE_ADVANCED | STAGE_OVERRIDDEN
  entity    String
  entityId  String
  payload   Json
  occurredAt DateTime @default(now())
  @@index([entity, entityId, occurredAt])
}
```

Raw-SQL constraints added in a migration Prisma can't express:

```sql
ALTER TABLE "StageTransition" ADD CONSTRAINT override_requires_reason
  CHECK (kind <> 'OVERRIDE' OR (reason IS NOT NULL AND length(btrim(reason)) >= 10));
ALTER TABLE "Feedback" ADD CONSTRAINT rating_range CHECK (rating BETWEEN 1 AND 4);
```

The CHECK is the point: an override with no reason is rejected by the database, so "recorded,
not inferred" is true even if the service layer is bypassed.

---

## 3. Stage progression

Single source of truth, one file, `src/domain/stageMachine.ts`:

```ts
export const ALLOWED: Record<Stage, Stage[]> = {
  APPLIED:   [SCREEN, REJECTED],
  SCREEN:    [INTERVIEW, REJECTED],
  INTERVIEW: [OFFER, REJECTED],
  OFFER:     [HIRED, REJECTED],
  HIRED: [], REJECTED: [],
};
```

- `advance()` — only moves along `ALLOWED`. Anything else → `InvalidTransitionError` → 422.
- `override()` — may move to any non-terminal-violating stage *except* it still cannot leave
  `HIRED`/`REJECTED`, and requires `actor.role === RECRUITER` + a reason ≥10 chars.
- Both run inside one `prisma.$transaction`, with `SELECT ... FOR UPDATE` on the Application
  row, and both write: the `Application` update, a `StageTransition` row, an `AuditEvent`.
  Three writes, one transaction — a stage can't move without leaving a trace.

**Who may override: recruiters only.** Hiring managers are read-only; interviewers have no
stage authority at all. Documented in README §Authorization and asserted by test.

Where the rule is enforced (walkthrough Q1): in `stageMachine.ts`, called by
`applicationService.transition()`, which is the only writer of `Application.currentStage`.
Routes do zod validation of the *shape* (is `toStage` a member of the enum) and nothing else;
the *legality* of the move is domain logic. Demo: `PATCH /applications/:id/stage
{"toStage":"OFFER"}` from `APPLIED` → 422 with the allowed set in the error body.

---

## 4. API surface

All routes behind `requireAuth` (JWT bearer, seeded users, 15-min tokens). There is no
unauthenticated route except `POST /auth/login` and `GET /health`. `requireRole(...)` on top.

```
POST   /auth/login                          -> { token }

# Recruiter
GET    /roles                                  list open roles
POST   /roles
GET    /pipeline                               counts per stage per role + ageing (§6)
GET    /pipeline/stuck?days=N                  stretch, §8
GET    /candidates/:id                         FULL shape incl. contact
POST   /applications                           candidate onto a role
PATCH  /applications/:candidateId/:roleId/stage        normal advance
POST   /applications/:candidateId/:roleId/override     stage skip, requires reason
POST   /rounds                                 create round for an application
POST   /rounds/:id/assignments                 assign interviewer
GET    /audit/candidates/:id                   full trace

# Interviewer
GET    /me/rounds                              only rounds assigned to me
GET    /rounds/:id                             404 unless assigned; NO contact fields
GET    /candidates/:id                         404 unless assigned; NO contact fields
POST   /rounds/:id/feedback                    { rating, notes }
GET    /rounds/:id/feedback                    prior feedback for this round (see note)

# Hiring manager (stretch)
GET    /pipeline?roleId=...                    scoped to own roles
```

Note on "interviewers can't see prior feedback before their round" from §1 of the brief —
the brief states the *problem* is that they can't; so `GET /rounds/:id/feedback` returns peer
feedback for rounds the requester is assigned to. Documented as a deliberate reading.

Errors: RFC-7807-ish `{ type, title, status, detail, errors[] }`. `404` (not `403`) for
out-of-scope resources — a 403 confirms the record exists. Documented as intentional.

---

## 5. Concurrent feedback — the documented rule

**Both submissions are kept. Feedback is per-(round, interviewer), never merged, never
overwritten. A second submission by the *same* interviewer for the same round is rejected
with 409, not silently updated.**

Enforced by `@@unique([roundId, interviewerId])`. The insert is a plain `INSERT`; a
`23505` unique violation maps to 409. No read-then-write, so no lost-update window.

Round outcome is *derived* (`GET /rounds/:id` returns `feedbackCount`, `ratings[]`), never a
stored mutable field — so two panel members writing at once can't clobber a rollup. Feedback
never auto-advances a stage; recruiters advance. This keeps the concurrency surface to a
single table.

Tests (§6 of brief): fire with `Promise.all`, real HTTP, against the compose stack —
1. Two *different* interviewers, same round, simultaneous → both 201, two rows.
2. Same interviewer twice, simultaneous → exactly one 201 and one 409, one row.
3. Stretch (§8): three interviewers + a recruiter override on the same candidate at once →
   assert 3 feedback rows, exactly one `StageTransition`, `currentStage` consistent with it.
   The `FOR UPDATE` on Application serialises the override against any concurrent transition.

---

## 6. Pipeline + ageing without loading candidates into memory

Ageing comes from `Application.currentStageEnteredAt`, written in the same transaction as
every stage change. The view is one grouped query:

```sql
SELECT r.id, r.title, a."currentStage",
       count(*) AS candidates,
       avg (now() - a."currentStageEnteredAt") AS avg_age,
       max (now() - a."currentStageEnteredAt") AS oldest
FROM "Application" a JOIN "Role" r ON r.id = a."roleId"
WHERE r.status = 'OPEN'
GROUP BY r.id, r.title, a."currentStage";
```

Index: `(roleId, currentStage, currentStageEnteredAt)`. No row ever reaches Node except the
aggregate. `$queryRaw` with `Prisma.sql` — grouped aggregates with intervals are clearer in
SQL than through Prisma's `groupBy`, and the plan is what gets shown at the walkthrough.

Stretch (§8): seed 200 roles / 20 000 candidates via a generator script, capture
`EXPLAIN (ANALYZE, BUFFERS)` before and after the index into `docs/query-plans.md`.

---

## 7. Input validation and bad-input rejection

- `zod` schemas per route, applied in a `validate(schema)` middleware **before** the handler —
  enum membership, uuid format, rating range, reason length. A body naming a stage that isn't
  defined never reaches the service.
- A round that doesn't exist: the FK on `Feedback.roundId` rejects it; `23503` maps to 404.
  Belt-and-braces because the assignment check (`RoundAssignment` lookup) already 404s first —
  both paths tested.
- Central error middleware maps `PrismaClientKnownRequestError` codes → HTTP, so no raw
  Prisma error ever reaches the client.

---

## 8. Auditability

Every mutating service writes an `AuditEvent` **inside the same transaction** as the mutation —
if the audit write fails, the mutation rolls back. `GET /audit/candidates/:id` returns the
merged `StageTransition` + `AuditEvent` timeline, recruiter/HM only. That is the answer to
"a candidate disputes how they were assessed".

---

## 9. Testing plan (maps 1:1 to brief §6)

Vitest + supertest, run against a real Postgres (testcontainers, fallback to the compose DB).
No mocked Prisma anywhere — these tests are only meaningful against the real engine.

| Brief §6 item | Test |
|---|---|
| Bad input rejected pre-logic | undefined stage → 400 from middleware; feedback on unknown round → 404 |
| No anonymous path | table-driven: every route without a token → 401 |
| **Interviewer requests unassigned candidate by ID** | `GET /candidates/:id` as unassigned interviewer → 404; **plus** a unit test asserting the generated SQL contains no `email`/`phone` (snapshot of `CANDIDATE_SELECT.interviewer` keys + a `$on('query')` log assertion) |
| Contact leak | response-body scan across *every* interviewer-reachable route for `@`/phone patterns, incl. the feedback POST response |
| Override without reason/actor | `POST /override` with blank reason → 400; direct repository insert with `reason: null` → DB CHECK violation |
| Concurrency | the three `Promise.all` cases in §5 |
| Pipeline scale | seeded 20k-candidate run asserts the pipeline query returns under a threshold and that Node never materialises > N rows |
| Structured trace | after a transition+override+feedback sequence, the audit timeline has exactly the expected events with actors |

---

## 10. Delivery — `docker compose up` and nothing else

```
compose.yaml   api (node:22) + postgres:16 (healthcheck) + optional pgadmin
.env.example   DATABASE_URL, JWT_SECRET, PORT, SEED=true      # documented in README
```
API entrypoint runs `prisma migrate deploy && node dist/seed.js && node dist/server.js`.
Seed creates 2 recruiters, 4 interviewers, 1 hiring manager, 3 roles, ~15 candidates with
assignments already in place, and prints a table of login credentials + curl examples.

---

## 11. Two-week schedule

**Week 1 — the graded core**
- D1: repo, TS/Express/Prisma/zod scaffolding, compose + healthcheck, CI runs tests.
- D2: schema + migrations + raw CHECK constraints + seed script.
- D3: auth (login, JWT, `requireAuth`/`requireRole`), actor context plumbed into repositories.
- D4: **field-set selects + scoped repositories**; the unassigned-candidate-by-ID test goes
  green today. This is the highest-value day — do it before anything else feature-shaped.
- D5: stage machine, advance + override endpoints, StageTransition + AuditEvent writes.

**Week 2 — concurrency, scale, polish**
- D6: rounds, assignments, feedback submission with the unique constraint.
- D7: the three concurrency tests; fix whatever they reveal.
- D8: pipeline + ageing SQL, indexes, seed generator for 200/20 000.
- D9: `EXPLAIN ANALYZE` capture, index tuning, `docs/query-plans.md`.
- D10: audit timeline endpoint, error-mapping pass, full response-leak sweep.
- D11: README — authorization matrix, the §3.4 concurrency decision, the §4 query-vs-filter
  answer, walkthrough script with copy-pasteable curls.
- D12: Postgres RLS + column GRANT layer (stretch layer 3).
- D13–14: buffer, "stuck beyond N days" view, rehearse the walkthrough.

---

## 12. Walkthrough answers, prepared

1. **Where is stage progression enforced?** `src/domain/stageMachine.ts`, called only from
   `applicationService.transition()`, the only writer of `currentStage`. Live demo:
   APPLIED → OFFER returns 422 with the legal set; the test is `stage.invalid.test.ts`.
2. **What does an override record, and who can do it?** Recruiters only (`requireRole`, plus
   a service-level assertion). Records `fromStage`, `toStage`, `actorId`, `reason` (≥10 chars,
   DB CHECK), `occurredAt`, `kind=OVERRIDE`, written in the same transaction as the stage move,
   plus an `AuditEvent`. Demo the CHECK rejecting a null reason at the psql prompt.
3. **Contact details — excluded at the query or filtered after?** Excluded at the query.
   Show `CANDIDATE_SELECT.interviewer` (no `email`/`phone` keys), then the Prisma query log
   for an interviewer request proving the emitted SQL never names those columns, then the
   same request after dropping to `app_interviewer` showing Postgres itself refusing.

---

## 13. Explicitly out of scope

No UI, no email/notifications, no resume upload/parsing, no scheduling/calendar integration,
no multi-tenancy, no candidate-facing portal, no offer-letter generation. If time remains,
§8's deepening items come first — the brief says not to add features.

## 14. Risks

- **Testcontainers in CI/sandbox** may be unavailable → fallback path that points tests at the
  compose Postgres on a separate database name. Decide D1, not D7.
- **Prisma + `SET LOCAL` with connection pooling** — RLS context must be set inside
  `$transaction` or it leaks across pooled connections. This is exactly why RLS is layer 3 and
  not the primary mechanism.
- **Composite PK on Application** makes route params two-segment; if that gets awkward, switch
  to a surrogate `id` with a `@@unique([candidateId, roleId])` — decide on D2, don't churn later.
