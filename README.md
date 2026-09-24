# Recruitment Pipeline POC

Express (TypeScript) REST API over PostgreSQL 16 with Prisma. No UI — the API is the
deliverable. [PLAN.md](PLAN.md) is the design document; this README covers running it.

## Status

Weeks 1 and most of week 2 of [PLAN.md](PLAN.md) §11 are in place — D1–D9. The API is
complete enough to build a pipeline through, not only to read a seeded one.

| Done | |
|---|---|
| TypeScript / Express 5 / Prisma 7 / zod project | `npm run dev`, `compose.yaml`, `Dockerfile`, CI |
| Full domain schema + migration | 9 tables, the indexes from §2 and §6 |
| Raw-SQL CHECK constraints | `override_requires_reason`, `rating_range` — verified rejecting bad rows |
| Central error mapping | Prisma/Postgres codes → RFC-7807-ish problem responses |
| zod `validate()` middleware | runs before handlers (§7) |
| **Authentication (D3)** | `POST /auth/login`, `GET /auth/me`, `requireAuth` / `requireRole`, actor context |
| **Scoped repositories + field sets (D4)** | the §1 answer: two `select` objects per entity, the assignment check inside the `where` |
| **Stage machine (D5)** | one writer of `currentStage`; advance, override, `StageTransition` + `AuditEvent` in one transaction |
| **Rounds, assignments, feedback (D6)** | one feedback row per (round, interviewer), enforced by a unique index |
| **Concurrency tests (D7)** | the three §5 cases, real HTTP, `Promise.all`, against real Postgres |
| **Pipeline + ageing (D8)** | `GET /pipeline` — one grouped aggregate, no candidate row reaches Node |
| **Scale dataset + query plans (D9)** | `npm run db:seed:scale`, [docs/query-plans.md](docs/query-plans.md) |
| **RLS + column GRANTs (D12)** | `npm run db:rls` — interviewer reads run as a role Postgres will not show `email`/`phone` |
| **Reqs, applications, audit trail** | `GET`/`POST /roles`, `POST /applications`, `GET /audit/candidates/:id` (§8) |
| Seed fixture | 7 accounts, 3 reqs, 15 candidates, 17 applications, 10 rounds, a deliberate assignment graph |
| OpenAPI + Swagger UI | `/docs` and `/openapi.json`, generated from the zod schemas `validate()` enforces |
| 254 tests | vitest + supertest, no mocked Prisma anywhere (§9), including the §9 sweeps at 20 000 candidates |

### The endpoints

| | Recruiter | Hiring manager | Interviewer |
|---|---|---|---|
| `POST /auth/login`, `GET /auth/me` | ✓ | ✓ | ✓ |
| `GET /roles`, `POST /roles` | all reqs / open one | own reqs / — | — |
| `GET /applications` | all reqs | own reqs | — |
| `POST /applications` | ✓ | — | — |
| `PATCH /applications/:candidateId/:roleId/stage` | ✓ | — | — |
| `POST /applications/:candidateId/:roleId/override` | **only** | — | — |
| `GET /pipeline` | all open reqs | own reqs | — |
| `GET /pipeline/stuck?days=N` | all open reqs | own reqs | — |
| `GET /candidates/:id` | full record | — | assigned only, no contact details |
| `POST /rounds`, `POST /rounds/:id/assignments` | ✓ | — | — |
| `GET /applications/:candidateId/:roleId/rounds` | ✓, panel included | — | — |
| `GET /rounds/:id` | ✓ | — | assigned only |
| `GET /me/rounds` | — | — | ✓ |
| `POST /rounds/:id/feedback` | — | — | own rounds |
| `GET /rounds/:id/feedback` | ✓ | — | assigned only |
| `GET /audit/candidates/:id` | any candidate | own reqs, no payloads | — |
| `GET /users` | ✓ | — | — |

**Every route in PLAN.md §4 is built.** Three reads go beyond it, added so the recruiter
screens in `web/` could be built against the API rather than against the seed script:

- `GET /applications` — the work queue. §4 has `GET /pipeline` (*how many*) and
  `GET /pipeline/stuck` (*which are late*) but nothing that answers *who is on this req*.
  Same scoping as both: recruiters see every req, hiring managers see their own by a
  predicate in the same query, and the rows carry `{ id, name }` — no list endpoint in
  this API selects a contact column.
- `GET /applications/:candidateId/:roleId/rounds` — the rounds on one application, each
  with its panel. `POST /rounds` returns an id and nothing else, so without this the only
  way to find a round again is to have kept that response. Recruiter-only, and the panel
  is on the recruiter field set alone: an interviewer who could read the roster would
  learn who else is interviewing a candidate, which is what the assignment scope exists
  to withhold.
- `GET /users` — the picker behind "assign an interviewer" and "open a req", both of
  which take a user id and verify the role they are handed. Recruiter-only for the same
  reason.

Not built, and not in the plan: closing a req, and creating a candidate — `POST
/applications` takes a candidate id, and candidates are seeded (§13 puts intake out of
scope).

## Prerequisites

- Node.js 22+ (developed on 24)
- PostgreSQL 16 — either via `docker compose`, or installed on the host

## Quick start

### Option A — Docker (`docker compose up` and nothing else)

```bash
cp .env.example .env          # compose supplies its own values; .env is for local runs
docker compose up --build
curl http://localhost:4000/health
```

Three services, no manual step between them: **db** (postgres:16), **api** on
<http://localhost:4000>, and **web** — the UI on <http://localhost:5173>, where the login
form lists the seeded accounts. The API waits for the database healthcheck, applies
migrations, installs row-level security and seeds; the UI waits for the API's.

Postgres is published on host port **5433** so it does not collide with a Postgres
already running on 5432.

| | |
|---|---|
| <http://localhost:5173> | the UI |
| <http://localhost:4000/docs> | Swagger UI — browse and try every endpoint |
| <http://localhost:4000/health> | liveness, database, and whether layer 3 is enforced |

The `web` image is nginx serving the built bundle, and it forwards `/api/*` to the api
service the way Vite's dev proxy does for `npm run dev` — so the browser sees one origin
and [the API still needs no CORS](#frontend-web).

> Not yet verified on this machine — Docker is not installed here. Everything below
> (Option B) has been run end to end.

### Option B — Local PostgreSQL

Create the role and the two databases (the test suite needs its own):

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE recruitment_app WITH LOGIN PASSWORD 'recruitment_dev_pw' CREATEDB;
CREATE DATABASE recruitment_poc      OWNER recruitment_app;
CREATE DATABASE recruitment_poc_test OWNER recruitment_app;
SQL
```

Then:

```bash
npm install
cp .env.example .env                 # set DATABASE_URL and JWT_SECRET
npx prisma generate
npx prisma migrate deploy            # or `npm run db:migrate` while iterating on the schema
npm run db:seed                      # seven development accounts; prints the logins
npm run dev
curl http://localhost:4000/health    # {"status":"ok","database":"up",...}
```

Then open **<http://localhost:4000/docs>** to browse and try the API, or see
[Authentication](#authentication) for the seeded credentials and a curl walkthrough.

Generate a `JWT_SECRET` with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## Environment

Validated at boot by [src/config/env.ts](src/config/env.ts) — a missing or malformed
value stops the process with a readable list rather than failing three layers down.

| Variable | Notes |
|---|---|
| `NODE_ENV` | `development` \| `test` \| `production` |
| `PORT` | default `4000` (3000 is commonly taken by other local apps) |
| `DATABASE_URL` | `postgresql://…` — read by the runtime adapter *and* the Prisma CLI |
| `JWT_SECRET` | ≥ 32 chars; the 15-minute bearer tokens (§4) |
| `SEED` | `true` runs the seed on container boot |
| `LOG_QUERIES` | `true` echoes every SQL statement Prisma emits — the walkthrough Q3 proof surface |
| `ENABLE_DOCS` | serve `/docs` + `/openapi.json`. Defaults to on outside production, off in it |
| `DB_RLS` | `auto` (default) \| `require` \| `off` — whether interviewer reads run as the `app_interviewer` role. `require` turns a missing role into a boot failure; compose sets it |

`.env` drives local runs, `.env.test` drives the suite. Both are gitignored;
`.env.example` is the template.

## Scripts

| | |
|---|---|
| `npm run dev` | watch-mode server (tsx) |
| `npm run build` / `npm start` | compile to `dist/` / run the compiled server |
| `npm test` | vitest against `recruitment_poc_test`, migrating it first |
| `npm run typecheck` | `tsc` over `src/` and `tests/` |
| `npm run lint` | eslint, including the restricted-import rule |
| `npm run db:migrate` | `prisma migrate dev` — create and apply a migration |
| `npm run db:deploy` | `prisma migrate deploy` — apply existing migrations |
| `npm run db:seed` | create/refresh the seven development accounts (idempotent) |
| `npm run openapi:json` | write the generated OpenAPI document to `openapi.json` (gitignored; `web/` turns it into client types) |
| `npm run db:rls` | install PLAN.md §1 layer 3 — the `app_interviewer` role, its column GRANTs and its row policies (idempotent; needs CREATE ROLE) |
| `npm run db:seed:scale` | generate the §8 scale dataset — 200 reqs, 20 000 candidates, deterministic; `-- --clean` removes it |
| `npm run db:reset` | drop, recreate, re-migrate |
| `npm run db:studio` | Prisma Studio |

## Testing

The suite runs against a **real** Postgres — no mocked Prisma anywhere (§9), because
every graded behaviour (constraint violations, concurrency, query shape) only exists in
the engine. `tests/globalSetup.ts` applies migrations to `.env.test`'s database before
the first test and refuses to run unless that URL names a database with `test` in it.

Two files sweep the API rather than one endpoint, both driven from something that
cannot go stale ([tests/access.test.ts](tests/access.test.ts)): every route registered in
the OpenAPI document is called without a token and must 401, and every
interviewer-reachable response — successes, 403s, 404s and 400s alike — is scanned as raw
text for a candidate's email or phone. A route added without a thought about auth fails
the suite the moment it registers itself.

[tests/scale.test.ts](tests/scale.test.ts) generates the §8 dataset — 200 reqs, 20 000
candidates — asserts `GET /pipeline` answers well under a threshold and returns at most
one row per (open req, stage), then removes it again. That is ~6 seconds of the suite's
runtime and the reason `npm test` takes about half a minute.

PLAN.md §14 flagged testcontainers as a risk. **Decided:** the fallback — a separate
database name on the same Postgres. It runs identically on a laptop, in compose, and in
CI, where the workflow starts a `postgres:16` service.

## Project layout

```
docs/
  authentication.md          the auth flow, end to end (D3)
  query-plans.md             EXPLAIN (ANALYZE, BUFFERS) for the pipeline aggregate (D9)
  query-plans.sql            the two statements that document measures, ready to run
prisma/
  schema.prisma              the domain model (§2)
  migrations/                init migration + the raw CHECK constraints
  rls.sql                    layer 3: the app_interviewer role, GRANTs and policies (§1)
prisma.config.ts             Prisma 7 config: where the CLI reads DATABASE_URL
src/
  server.ts                  listener + graceful shutdown
  app.ts                     Express app factory (no listener, so tests can drive it)
  seed.ts                    development accounts (§10) — idempotent, prints the logins
  db-rls.ts                  installs prisma/rls.sql — `npm run db:rls`
  config/env.ts              zod-validated environment
  db/client.ts               the single Prisma client — repositories only
  domain/actor.ts            the { id, role } every scoped repository takes (§1)
  auth/password.ts           bcrypt hashing + the enumeration-resistant dummy compare
  auth/tokens.ts             sign/verify the 15-minute HS256 bearer tokens
  repositories/              the only place Prisma may be touched
  services/                  domain logic; talks to repositories, never to Prisma
  errors/AppError.ts         the problem-details shape
  http/middleware/           validate(), requireAuth/requireRole, the error handler
  http/openapi/              the spec, generated from the same zod schemas
  http/routes/               routers
tests/                       vitest + supertest, against a real database
web/                         the frontend — its own package, see below
```

## API docs

```bash
npm run dev
open http://localhost:4000/docs      # Swagger UI — browse and try every endpoint
curl -s localhost:4000/openapi.json  # the raw OpenAPI 3.1 spec
```

To try a guarded route: run `POST /auth/login` from the page with any seeded account
below, copy `token` out of the response, click **Authorize**, paste it in. The token is
kept across reloads, which matters when it expires every 15 minutes.

**The spec is generated, never written.** `registerOperation` sits next to each route and
takes the *same* zod object that `validate()` rejects bad input with, so the documented
request body cannot describe something the API does not enforce — see
[src/http/openapi/registry.ts](src/http/openapi/registry.ts). Adding a route without
documenting it is a visible omission in the same diff, not a silent gap — and
`tests/openapi.test.ts` asserts the exact set of documented paths, so it is also a
failing test.

Response schemas are the one half zod does not enforce at runtime — nothing validates an
outgoing body. Those are pinned by [tests/openapi.test.ts](tests/openapi.test.ts), which
drives each real endpoint and parses the real response against the schema the document
publishes. A handler that changes shape fails the suite.

Two notes on the setup:

- **`ENABLE_DOCS` gates it.** These are anonymous routes, and §4 says there are exactly
  two of those. Left ungated they would quietly become four, so the default is derived:
  on outside production, off in it. `compose.yaml` turns it on explicitly, because a
  reviewer browsing the API is the point of that stack.
- **CSP is relaxed on the docs paths only.** Swagger UI ships inline styles and an inline
  bootstrap script that helmet's default policy blocks. [app.ts](src/app.ts) picks between
  two helmet instances per request rather than loosening the policy API-wide; a test
  asserts `/health` still carries a CSP and `/docs` does not.

Validated with `npx @redocly/cli lint` — the document is valid OpenAPI 3.1. The three
remaining warnings are style rules that do not apply here: no `license` field, a
`localhost` server URL, and `/health` having no 4xx response.

## Authentication

> Full implementation reference, with sequence diagrams and where each rule is enforced:
> **[docs/authentication.md](docs/authentication.md)**. The summary below is enough to log
> in and start calling the API.

PLAN.md §4: every route is behind `requireAuth` except `POST /auth/login` and
`GET /health`. Tokens are HS256, 15 minutes, and carry the `Actor` (`sub` + `role`) and
nothing else — no name, no email, because a token gets quoted in logs.

### Accounts

`npm run db:seed` (or `SEED=true` in compose) creates seven accounts. **These are
development credentials, committed on purpose so a reviewer can curl the API a minute
after `docker compose up`.** Re-running resets them; nothing here should ever meet real
data.

| Email | Role |
|---|---|
| `rachel.recruiter@example.com` | RECRUITER |
| `raj.recruiter@example.com` | RECRUITER |
| `ingrid.interviewer@example.com` | INTERVIEWER |
| `ivan.interviewer@example.com` | INTERVIEWER |
| `iris.interviewer@example.com` | INTERVIEWER |
| `ian.interviewer@example.com` | INTERVIEWER |
| `hana.manager@example.com` | HIRING_MANAGER |

Password for all seven: `poc-dev-password`.

### A first call

Everything below is one `curl`; the whole pipeline walkthrough is
[further down](#walkthrough--the-whole-pipeline-in-curls).

```bash
TOKEN=$(curl -s localhost:4000/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"rachel.recruiter@example.com","password":"poc-dev-password"}' \
  | jq -r .token)

curl -s localhost:4000/auth/me -H "authorization: Bearer $TOKEN"
# {"id":"…","email":"rachel.recruiter@example.com","name":"Rachel Ahmed","role":"RECRUITER"}

curl -s -i localhost:4000/auth/me | head -1
# HTTP/1.1 401 Unauthorized   (with WWW-Authenticate: Bearer)
```

### Authorization

`requireRole(...)` mounts on top of `requireAuth`. The matrix the API is built against
(PLAN.md §3, §4) — see **The endpoints** above for the per-route view:

| | Interviewer | Recruiter | Hiring manager |
|---|---|---|---|
| Candidate contact details | **never** | yes | never |
| Candidate / round by ID | only if assigned, else 404 | yes | — |
| Submit feedback | own rounds | — | — |
| Read a round's feedback | only if assigned | yes | — |
| Advance a stage | — | yes | — |
| Override a stage | — | **yes, only** | — |
| Pipeline view | — | all open reqs | own reqs |
| Audit timeline | — | yes | own reqs, without event payloads |

Two status codes are chosen deliberately and are asserted by test:

- **403 for a wrong role**, because the existence of a route like `POST /roles` is not a
  secret — the caller simply is not a recruiter.
- **404, not 403, for an out-of-scope resource** (§4). A 403 would confirm the record
  exists. An unassigned interviewer asking for a candidate by id gets the same body as
  one asking for a candidate that was never there, and the two are byte-identical by
  test.

### Decisions taken building it

1. **Stateless verification — no database round-trip per request.** The token carries the
   whole actor, so a role change or a disabled account takes effect at the next login, up
   to 15 minutes later. That window *is* the argument for the short TTL. Endpoints that
   must reflect the current row read it themselves — `GET /auth/me` does, which is why a
   token whose subject was deleted gets a 401 rather than an echo of its own claims.
2. **The algorithm is pinned on both sides.** `verifyAccessToken` passes
   `algorithms: ['HS256']` instead of trusting the token's own `alg` header. jsonwebtoken
   v9 rejects `alg: none` on its own, but the guarantee should not rest on a library
   default. Tested with a hand-rolled unsigned token.
3. **A wrong password and an unknown account are indistinguishable** — same 401, same
   body, and the same ~250ms. The unknown-account path runs a bcrypt compare against a
   dummy hash it would otherwise skip; measured on this machine, median 263.5ms vs
   261.8ms. Without it the unknown path returns in ~1ms and the identical bodies are
   defeated by a stopwatch.
4. **No password policy at the login boundary.** The schema checks that a password is
   present, not that it is long — rejecting a short one would tell the caller their guess
   was too short to be this account's password.
5. **`passwordHash` gets the same field-set treatment as candidate contact details.**
   `USER_SELECT.public` does not name the column at all; `withCredentials` is read by one
   function and consumed by one service, and its result never leaves `authService.login`.
   Same mechanism as §1, applied to the other restricted column in the schema.
6. **`findUserCredentialsByEmail` is the one repository function with no `actor`** — and
   the only place that exemption is defensible, since it *is* the call that establishes
   who the actor is. Called out here so the §1 rule does not look quietly broken.
7. **`requireRole` fails closed.** Mounted without `requireAuth` ahead of it, it 401s
   rather than reading an undefined actor, so a wiring mistake cannot open a route.
   Asserted by test.
8. **Email is trimmed at the HTTP boundary, lower-cased in the repository.** Whitespace is
   a shape concern; casing is a storage concern and belongs next to the unique index.

Not built, and deliberately: no refresh tokens (re-login is one curl), no logout/denylist
(the 15-minute TTL is the revocation story), no login rate limiting, and no `AuditEvent`
on login — PLAN.md §8 scopes the audit trail to domain mutations. Each is a small
addition if the walkthrough wants it.

## Walkthrough — the whole pipeline in curls

Every command below was run against `npm run dev` on a freshly seeded database, and every
response is the real one, trimmed only where noted with `…`. Paste them in order.

The seeded candidate ids are deterministic — `npm run db:seed` prints them, and they are
the same on every machine:

| | |
|---|---|
| Amara Osei (Ingrid **is** assigned) | `38856b51-8ae9-546b-88cd-acbc21b291c7` |
| Bruno Costa (Ingrid is **not**) | `f6b046bd-78d7-5821-b2d0-cfc450b0ae08` |
| Oskar Nowak (used below) | `fa50e31a-7b82-57bf-b32f-23a026af31b4` |

### 0. Four tokens

```bash
API=localhost:4000; J='content-type: application/json'
login() { curl -s $API/auth/login -H "$J" -d "{\"email\":\"$1\",\"password\":\"poc-dev-password\"}"; }

RACHEL=$(login rachel.recruiter@example.com | jq -r .token)     # recruiter
INGRID=$(login ingrid.interviewer@example.com | jq -r .token)   # interviewer
IVAN=$(login ivan.interviewer@example.com | jq -r .token)       # interviewer
HANA=$(login hana.manager@example.com | jq -r .token)           # hiring manager

INGRID_ID=$(login ingrid.interviewer@example.com | jq -r .user.id)
IVAN_ID=$(login ivan.interviewer@example.com | jq -r .user.id)
HANA_ID=$(login hana.manager@example.com | jq -r .user.id)
OSKAR=fa50e31a-7b82-57bf-b32f-23a026af31b4
```

### 1. Open a req, put a candidate on it

```bash
REQ=$(curl -s $API/roles -H "authorization: Bearer $RACHEL" -H "$J" \
  -d "{\"title\":\"Staff Backend Engineer\",\"hiringManagerId\":\"$HANA_ID\"}")
REQ_ID=$(echo "$REQ" | jq -r .id); echo "$REQ" | jq -c .
```
```json
{"id":"288c8518-…","title":"Staff Backend Engineer","status":"OPEN","openedAt":"2026-09-21T12:09:49.937Z",
 "hiringManager":{"id":"e42848d3-…","name":"Hana Suzuki"},"applicationCount":0}
```

```bash
curl -s $API/applications -H "authorization: Bearer $RACHEL" -H "$J" \
  -d "{\"candidateId\":\"$OSKAR\",\"roleId\":\"$REQ_ID\"}" | jq -c .
```
```json
{"applicationId":"6bbeb74e-…","candidateId":"fa50e31a-…","roleId":"288c8518-…",
 "currentStage":"APPLIED","currentStageEnteredAt":"2026-09-21T12:09:49.960Z"}
```

### 2. Advance a stage — and try an illegal one

```bash
curl -s -X PATCH $API/applications/$OSKAR/$REQ_ID/stage \
  -H "authorization: Bearer $RACHEL" -H "$J" -d '{"toStage":"SCREEN"}' | jq -c .transition
```
```json
{"id":"69831bea-…","fromStage":"APPLIED","toStage":"SCREEN","kind":"NORMAL","reason":null,
 "actorId":"300c2087-…","occurredAt":"2026-09-21T12:09:49.972Z"}
```

Now skip two stages. **This is walkthrough answer Q1** — the refusal comes from
[`src/domain/stageMachine.ts`](src/domain/stageMachine.ts), the only thing that decides
legality, and the body carries the legal set:

```bash
curl -s -X PATCH $API/applications/$OSKAR/$REQ_ID/stage \
  -H "authorization: Bearer $RACHEL" -H "$J" -d '{"toStage":"HIRED"}' | jq -c .
```
```json
{"type":"https://httpstatuses.io/422","title":"Invalid Stage Transition","status":422,
 "from":"SCREEN","to":"HIRED","allowed":["INTERVIEW","REJECTED"],
 "detail":"SCREEN -> HIRED is not a legal transition."}
```

### 3. Override it, on the record

**Walkthrough answer Q2.** Recruiters only, reason required, and the record names who:

```bash
curl -s $API/applications/$OSKAR/$REQ_ID/override -H "authorization: Bearer $RACHEL" -H "$J" \
  -d '{"toStage":"OFFER","reason":"Panel unanimous after the screen; skipping the onsite."}' \
  | jq -c .transition
```
```json
{"id":"f871e6b5-…","fromStage":"SCREEN","toStage":"OFFER","kind":"OVERRIDE",
 "reason":"Panel unanimous after the screen; skipping the onsite.",
 "actorId":"300c2087-…","occurredAt":"2026-09-21T12:09:50.024Z"}
```

A short reason never reaches the database — and if the service layer were bypassed, the
`override_requires_reason` CHECK would refuse the row anyway:

```bash
curl -s $API/applications/$OSKAR/$REQ_ID/override -H "authorization: Bearer $RACHEL" -H "$J" \
  -d '{"toStage":"HIRED","reason":"too short"}' | jq -c .errors
```
```json
[{"path":"body.reason","message":"must be at least 10 characters"}]
```

### 4. A round, and two interviewers on it

```bash
ROUND_ID=$(curl -s $API/rounds -H "authorization: Bearer $RACHEL" -H "$J" \
  -d "{\"candidateId\":\"$OSKAR\",\"roleId\":\"$REQ_ID\",\"stage\":\"SCREEN\",\"scheduledAt\":\"2026-10-01T09:00:00.000Z\"}" \
  | jq -r .id)

for who in $INGRID_ID $IVAN_ID; do
  curl -s -o /dev/null -w "assign %{http_code}\n" $API/rounds/$ROUND_ID/assignments \
    -H "authorization: Bearer $RACHEL" -H "$J" -d "{\"interviewerId\":\"$who\"}"
done      # assign 204 / assign 204
```

### 5. What an interviewer can see — walkthrough answer Q3

```bash
curl -s $API/candidates/$OSKAR -H "authorization: Bearer $INGRID" | jq -c .
curl -s $API/candidates/$OSKAR -H "authorization: Bearer $RACHEL" | jq -c .
```
```json
{"id":"fa50e31a-…","name":"Oskar Nowak"}
{"id":"fa50e31a-…","name":"Oskar Nowak","email":"oskar.nowak@example.net","phone":"+48 22 000 0115","createdAt":"…"}
```

Same route, same candidate, two different queries — see
[Contact details](#contact-details--excluded-at-the-query-not-filtered-after) below for the
SQL each one emits. And a candidate Ingrid is not assigned to is a **404, not a 403**:

```bash
curl -s $API/candidates/f6b046bd-78d7-5821-b2d0-cfc450b0ae08 -H "authorization: Bearer $INGRID" | jq -c .
```
```json
{"type":"https://httpstatuses.io/404","title":"Not Found","status":404,"detail":"No such candidate."}
```

Byte-identical to the body for a candidate id that was never issued. `GET /me/rounds`
carries the same field set — no contact details anywhere on the interviewer path.

### 6. Two panel members submitting at once

```bash
curl -s -o /dev/null -w "ingrid %{http_code}\n" $API/rounds/$ROUND_ID/feedback \
  -H "authorization: Bearer $INGRID" -H "$J" -d '{"rating":4,"notes":"Strong systems answers."}' &
curl -s -o /dev/null -w "ivan   %{http_code}\n" $API/rounds/$ROUND_ID/feedback \
  -H "authorization: Bearer $IVAN" -H "$J" -d '{"rating":3,"notes":"Solid, some gaps on concurrency."}' &
wait      # ingrid 201 / ivan 201 — both kept, neither merged
```

Ingrid submitting a second time is refused, not silently updated:

```json
{"type":"https://httpstatuses.io/409","title":"Conflict","status":409,"detail":"That record already exists."}
```

And the round's outcome is derived on read, never stored:

```bash
curl -s $API/rounds/$ROUND_ID -H "authorization: Bearer $RACHEL" | jq -c '{feedbackCount, ratings}'
# {"feedbackCount":2,"ratings":[3,4]}
```

### 7. The pipeline, and the trail

```bash
curl -s "$API/pipeline?roleId=$REQ_ID" -H "authorization: Bearer $RACHEL" | jq -c .
```
```json
[{"roleId":"288c8518-…","title":"Staff Backend Engineer","totalCandidates":1,
  "stages":[{"stage":"OFFER","candidates":1,"averageAgeDays":0,"oldestAgeDays":0}]}]
```

```bash
curl -s $API/audit/candidates/$OSKAR -H "authorization: Bearer $RACHEL" \
  | jq -c '.timeline[] | {type, action, kind, reason, actor: .actor.name}'
```
```json
{"type":"AUDIT_EVENT","action":"APPLICATION_CREATED","actor":"Rachel Ahmed"}
{"type":"STAGE_TRANSITION","kind":"NORMAL","reason":null,"actor":"Rachel Ahmed"}
{"type":"AUDIT_EVENT","action":"STAGE_ADVANCED","actor":"Rachel Ahmed"}
{"type":"STAGE_TRANSITION","kind":"OVERRIDE","reason":"Panel unanimous after the screen; skipping the onsite.","actor":"Rachel Ahmed"}
{"type":"AUDIT_EVENT","action":"STAGE_OVERRIDDEN","actor":"Rachel Ahmed"}
{"type":"AUDIT_EVENT","action":"ROUND_CREATED","actor":"Rachel Ahmed"}
{"type":"AUDIT_EVENT","action":"ASSIGNMENT_CREATED","actor":"Rachel Ahmed"}
{"type":"AUDIT_EVENT","action":"ASSIGNMENT_CREATED","actor":"Rachel Ahmed"}
{"type":"AUDIT_EVENT","action":"FEEDBACK_SUBMITTED","actor":"Ingrid Olsen"}
{"type":"AUDIT_EVENT","action":"FEEDBACK_SUBMITTED","actor":"Ivan Petrov"}
```

Ten rows, every one written inside the transaction that made the change. Hana reads the
same trail for her own req — with the `payload` field absent, so the ratings she is
refused by `GET /rounds/:id/feedback` do not arrive through the back door.

### Tearing it down

The walkthrough leaves one req behind. `npm run db:reset && npm run db:seed` puts the
fixture back, or delete the req — applications, rounds and transitions cascade.

## Concurrent feedback — the decision

> Two interviewers submit feedback for the same round at the same moment. What happens?

**Both submissions are kept. Feedback is per `(round, interviewer)`, never merged, never
overwritten — and a second submission by the *same* interviewer is refused with 409, not
silently applied.**

The rule is a `@@unique([roundId, interviewerId])` index, and the insert is a plain
`INSERT` that does not read first. That is the whole mechanism:

- **Two different interviewers, simultaneously** → two 201s, two rows. They were never in
  competition; they are writing different rows.
- **The same interviewer twice, simultaneously** → exactly one 201 and one 409. Postgres
  picks the winner; `23505` maps to 409 in the central error handler.
- **There is no read-then-write anywhere on this path**, so there is no window between
  "does feedback exist?" and "write it" for a second request to slip into. A check-then-
  insert version would pass a single-threaded test and lose a row under load.

The round's outcome — `feedbackCount`, `ratings[]` — is **derived on every read**, never
a stored column. A stored rollup is a mutable field two panel members can clobber; a
count of the rows that exist cannot be. And feedback never advances a stage: recruiters
do that, explicitly, so the concurrency surface stays one table.

Asserted by [tests/rounds.test.ts](tests/rounds.test.ts) with real HTTP and `Promise.all`,
including the three-interviewers-plus-a-recruiter-override case, which also asserts that
exactly one `StageTransition` exists afterwards and that `currentStage` agrees with it —
the `SELECT … FOR UPDATE` on the application row serialises the override against any
concurrent transition.

## Contact details — excluded at the query, not filtered after

> When an interviewer's request returns candidate data, are contact details ever in the
> row Postgres handed back to Node?

**No.** Two hard-coded field sets in
[candidate.repository.ts](src/repositories/candidate.repository.ts) —
`CANDIDATE_SELECT.recruiter` names `email` and `phone`, `CANDIDATE_SELECT.interviewer`
does not name them at all — and the role picks the *query*, before the read, not the
fields to keep after it.

Run the server with `LOG_QUERIES=true` and make the same request as each role. This is the
actual emitted SQL, reformatted only for line length:

```sql
-- as an interviewer: no email, no phone, and the assignment check is IN the where
SELECT "Candidate"."id", "Candidate"."name"
FROM "Candidate"
WHERE "Candidate"."id" = $1
  AND EXISTS (SELECT "t0"."candidateId" FROM "Application" AS "t0"
              WHERE EXISTS (SELECT "t1"."applicationId" FROM "InterviewRound" AS "t1"
                            WHERE EXISTS (SELECT "t2"."roundId" FROM "RoundAssignment" AS "t2"
                                          WHERE "t2"."interviewerId" = $2 AND …)
                              AND …)
                AND …)
LIMIT $3 OFFSET $4
-- params: ["38856b51-…", "5846d715-…", "1", "0"]

-- as a recruiter: the full record
SELECT "Candidate"."id", "Candidate"."name", "Candidate"."email",
       "Candidate"."phone", "Candidate"."createdAt"
FROM "Candidate" WHERE "Candidate"."id" = $1 LIMIT $2 OFFSET $3
```

Three things follow from the first statement, and all three are the point:

1. **The restricted columns are not in the result set**, so they never enter process
   memory on an interviewer request. There is nothing for a serializer to forget to strip.
2. **The authorization is the `EXISTS` chain**, not an `if` after the fetch. An
   unassigned candidate returns zero rows — the refusal happens in the database.
3. **Zero rows becomes a 404**, and "no such candidate" and "not yours" are therefore
   indistinguishable from outside. A 403 would confirm the record exists.

There is deliberately no `findCandidate(id)` in that repository. Adding one would make the
wide shape reachable, and the design rests on it not being. A lint rule
(`no-restricted-imports` on `src/db/client.ts` outside `src/repositories/**`) stops a route
handler from going around the repository to write one.

Enforced by three tests pulling in different directions:
[tests/candidates.test.ts](tests/candidates.test.ts) asserts on the emitted SQL itself,
the strict response schemas in [tests/openapi.test.ts](tests/openapi.test.ts) fail if an
extra field ever appears, and [tests/access.test.ts](tests/access.test.ts) scans every
interviewer-reachable response — successes, 403s, 404s and 400s — as raw text for an
address or a phone number.

### Layer 3 — and the database refuses too

Everything above is application code. [prisma/rls.sql](prisma/rls.sql) adds the layer
underneath it: a second role, `app_interviewer`, that is granted
`SELECT ("id", "name", "createdAt")` on `"Candidate"` and nothing else, plus a row policy
keyed on the actor.

```bash
npm run db:rls        # idempotent; needs a database user that may CREATE ROLE
```

Interviewer reads then run as that role, for one transaction:

```sql
SELECT set_config('app.actor_id', $1, true);   -- who is asking
SET LOCAL ROLE app_interviewer;                -- what they may see
```

Both say **LOCAL** for the reason PLAN.md §14 flagged: Prisma hands out pooled
connections, and a `SET ROLE` without it would outlive the request and hand the next
caller somebody else's identity. Postgres reverts both on COMMIT, so the blast radius is
the transaction — which is also why every one of these reads goes through
`$transaction`. There is no safe way to do it outside one.

What that buys, demonstrable at a psql prompt:

```console
$ psql "$DATABASE_URL" -c 'SET ROLE app_interviewer; SELECT email FROM "Candidate" LIMIT 1;'
ERROR:  permission denied for table Candidate
```

and, with a valid actor set, an **unfiltered** `SELECT "id" FROM "Candidate"` returns only
the candidates that interviewer is assigned to — so if `findCandidateForInterviewer` lost
its `where` clause tomorrow, the answer would not change. With no actor set it returns
nothing at all: `current_setting('app.actor_id', true)` is NULL, the policy is false, and
the failure direction is closed.

Three notes on how it is wired, each of them a deliberate choice:

- **It is not a Prisma migration.** `CREATE ROLE` is a cluster-level privilege that the
  application's own database user does not have on a typical development machine, and a
  migration that cannot run blocks work that has nothing to do with RLS. `compose.yaml`
  runs the script on boot, where the app user owns the cluster.
- **`DB_RLS=auto` degrades visibly, not silently.** Where the role is not installed the
  API still works — layers 1 and 2 are unconditional — and `GET /health` reports
  `"rls":"unavailable"` rather than looking identical to an environment where it is doing
  its job. Compose sets `DB_RLS=require`, which turns a missing role into a boot failure.
- **The table owner bypasses RLS**, so recruiter and hiring-manager reads, which run as
  the application's own user, are untouched by the policies.

[tests/rls.test.ts](tests/rls.test.ts) asserts all of this by asking Postgres directly as
the role, never through the repository — an assertion routed through the code being proved
unnecessary would prove nothing. Those tests install the role themselves and skip, with a
message, on a database whose user may not create one.

## Frontend (`web/`)

**Outside PLAN.md on purpose.** §13 lists "No UI" as out of scope and the plan's opening
rationale explains why: every graded item lives in the data-access layer, so the API is
the deliverable. `web/` is an addition on top of a finished API, not part of what the
plan set out to build — it changes nothing about the API's behaviour, and the suite that
covers the API does not depend on it.

React + Vite + TypeScript, as **its own package** with its own `package.json`, lockfile,
`tsconfig` and eslint config. Not an npm workspace: the [Dockerfile](Dockerfile) copies
`node_modules/@prisma` and `node_modules/.prisma` by exact path, and workspace hoisting
is the one thing that could move them.

`docker compose up` builds and serves it — see [Quick start](#option-a--docker-docker-compose-up-and-nothing-else);
nothing below is needed to *run* it. To work on it with hot reload instead:

```bash
npm run dev                  # the API, on :4000   (in the repo root)
cd web && npm install
npm run dev                  # the UI, on :5173
```

Either way, open <http://localhost:5173> and sign in — the login form lists the seeded
accounts.

| | |
|---|---|
| `npm run dev` | Vite dev server on :5173, proxying `/api/*` to the API on :4000 |
| `npm run build` | typecheck, then a production bundle in `web/dist` — what [web/Dockerfile](web/Dockerfile) runs |
| `npm run api:types` | regenerate `src/api/types.ts` from the API's OpenAPI document |
| `npm run lint` / `npm run typecheck` | its own configs, React rules included |

Three decisions worth knowing:

- **No CORS on the API.** Vite's dev proxy forwards `/api/*` server-side, and in the
  compose stack [web/nginx.conf](web/nginx.conf) does the same thing, so the browser only
  ever sees one origin. The API's middleware stack and its "exactly two anonymous routes"
  surface are untouched by the existence of a frontend — the bundle is served by its own
  nginx, not mounted onto Express.
- **The client types are generated, not written.** `npm run api:types` dumps the
  OpenAPI document (itself generated from the zod schemas `validate()` enforces) and
  turns it into `web/src/api/types.ts`. So the chain from what the server enforces to
  what the UI believes has no hand-written link, and a response shape that moves breaks
  `npm run typecheck` in `web/`.
- **The token lives in `sessionStorage`.** It survives a reload — a 15-minute token that
  dies on F5 is unusable — and dies with the tab. It is readable by any script on the
  origin, so it is not what a production app would do; that would be an httpOnly cookie
  set by the API, with a CSRF story to match. Noted in
  [web/src/auth/session.tsx](web/src/auth/session.tsx) rather than left implicit.

What it covers so far: login; the pipeline dashboard (counts and time-in-stage per open
req, plus the "waiting too long" list with an adjustable threshold); the req list with
its status filter; the interviewer's rounds and feedback form; and the recruiter path —

- **Reqs** (`/reqs`) — the status-filtered list, and, for a recruiter, the form that
  opens one. The hiring manager is picked from `GET /users?role=HIRING_MANAGER` rather
  than typed, because ownership is what scopes a hiring manager's whole view: a req
  handed to the wrong person is one its "manager" can never see. The API verifies the
  named user's role before the write regardless.
- **Candidates** (`/candidates`) — one row per application, filtered by req, stage and
  req status, longest-waiting first. Names and stages only, because that is all the
  endpoint returns. A recruiter also puts a candidate onto a req from here: only OPEN
  reqs are offered, since the API refuses a closed one from inside the transaction. The
  candidate picker lists whoever is already on a req, gathered from `GET /applications`
  — this API has no candidate directory, so anyone new is reachable by id, which the
  form offers as its own option rather than hiding the gap.
- **The application screen** (`/applications/:candidateId/:roleId`) — a candidate on a
  req, and everything a recruiter does to it: contact details (recruiter-only, read one
  record at a time), stage advances as buttons for the legal moves, an override as a form
  that will not submit without a reason, rounds with the panel already on each, a
  scheduler, an interviewer picker, and the audit timeline underneath.

A hiring manager reaches the same two screens and gets less on them: the sections they
may not read are not rendered, so the request behind them is never made. The stage table
in [web/src/domain/stages.ts](web/src/domain/stages.ts) exists only to decide which
buttons to offer — the server refuses anything illegal with a 422 that carries the legal
set, and the screen renders that set when it happens.

Navigation hides links a role would only get a 403 from — a
courtesy, not a security boundary, since the request still reaches the server and the
server still refuses it. An interviewer signing in gets a plain "nothing here yet"
panel rather than a red 403, because a 403 there is the authorization model working, not
a fault.

## Architecture rules already enforced

- **No direct Prisma access outside repositories.** `eslint.config.js` restricts importing
  `src/db/client.ts` to `src/repositories/**`. This is what makes §1 hold: a
  "select everything, strip it in the serializer" path cannot be written by accident,
  because the serializer never receives the wide shape. Verified by probe — the rule
  errors on a violating import.
- **The database refuses bad rows regardless of the service layer.** Verified after
  migrating:
  ```
  ERROR: new row for relation "StageTransition" violates check constraint
         "override_requires_reason"
  ```
  for an `OVERRIDE` with a null reason, and for one whose reason is whitespace-padded
  and under 10 characters (the constraint uses `btrim`).
- **One error shape.** Only `errorHandler` writes an error response, so the
  Prisma/Postgres → HTTP mapping lives in exactly one place (§7): `P2002`/`23505` → 409,
  `P2003`/`23503` → 404, `23514` → 400, and nothing raw ever reaches a client.

## Decisions taken during setup

Each of these was a question PLAN.md left open or a constraint the toolchain imposed.

1. **`Application` gets a surrogate `id`** instead of the composite PK sketched in §2.
   §14 asked for this call on D2. Reason: `InterviewRound` needs a single-column FK to an
   application; with a composite PK that FK becomes two columns and propagates. The pair
   is still unique (`@@unique([candidateId, roleId])`), so the two-segment routes in §4
   are unaffected.
2. **`Role.status` is an enum** (`OPEN` / `CLOSED`) rather than the `String` in §2. The
   pipeline query filters on it; the enum makes an invalid status unrepresentable and
   still compares against `'OPEN'` in raw SQL.
3. **Prisma pinned to 7.10.0, both packages.** `npm install prisma` resolves the `latest`
   dist-tag to `8.0.0-rc.15` — a release candidate — while `@prisma/client` resolves to
   7.10.0, so the default install is a mismatched major pair. Both are pinned exactly.
4. **Prisma 7 changed how the connection URL is supplied.** It is no longer allowed in
   `schema.prisma`: the CLI reads `prisma.config.ts`, and the runtime client connects
   through the `@prisma/adapter-pg` driver adapter. That config reads `process.env`
   directly rather than prisma's `env()` helper, which throws at config-load time — the
   Docker build runs `prisma generate` in an image with no `.env`, and `env()` breaks it.
5. **`prisma` is a runtime dependency, not a dev one.** The container entrypoint runs
   `prisma migrate deploy`, and the runtime image installs with `--omit=dev`.
6. **Default port 4000.** Port 3000 is occupied by another app on the development machine.
7. **Validated input lands on `req.validated`,** not back on `req.query` — Express 5
   exposes `req.query` as a getter and it cannot be assigned.

## Known notes

- `npm audit` reports 4 high advisories in **`mysql2`**, a transitive dependency of the
  Prisma CLI. This project is Postgres-only, so that driver is never loaded; the only
  offered fix is downgrading to Prisma 6, which reintroduces the v7 schema differences.
  Left as-is deliberately — revisit when Prisma updates the dependency.
