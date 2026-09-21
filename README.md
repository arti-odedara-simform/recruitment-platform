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
| **Reqs, applications, audit trail** | `GET`/`POST /roles`, `POST /applications`, `GET /audit/candidates/:id` (§8) |
| Seed fixture | 7 accounts, 3 reqs, 15 candidates, 17 applications, 10 rounds, a deliberate assignment graph |
| OpenAPI + Swagger UI | `/docs` and `/openapi.json`, generated from the zod schemas `validate()` enforces |
| 212 tests | vitest + supertest, no mocked Prisma anywhere (§9), including the §9 sweeps at 20 000 candidates |

### The endpoints

| | Recruiter | Hiring manager | Interviewer |
|---|---|---|---|
| `POST /auth/login`, `GET /auth/me` | ✓ | ✓ | ✓ |
| `GET /roles`, `POST /roles` | all reqs / open one | own reqs / — | — |
| `POST /applications` | ✓ | — | — |
| `PATCH /applications/:candidateId/:roleId/stage` | ✓ | — | — |
| `POST /applications/:candidateId/:roleId/override` | **only** | — | — |
| `GET /pipeline` | all open reqs | own reqs | — |
| `GET /candidates/:id` | full record | — | assigned only, no contact details |
| `POST /rounds`, `POST /rounds/:id/assignments` | ✓ | — | — |
| `GET /rounds/:id` | ✓ | — | assigned only |
| `GET /me/rounds` | — | — | ✓ |
| `POST /rounds/:id/feedback` | — | — | own rounds |
| `GET /rounds/:id/feedback` | ✓ | — | assigned only |
| `GET /audit/candidates/:id` | any candidate | own reqs, no payloads | — |

Not built yet: the §8 stretch items — Postgres RLS + column GRANTs (layer 3), the "stuck
beyond N days" view — and closing a req. Candidates themselves are still seeded rather
than created through the API; `POST /applications` takes a candidate id.

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

Postgres is published on host port **5433** so it does not collide with a Postgres
already running on 5432. The API waits for the database healthcheck, applies migrations,
then serves.

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
prisma.config.ts             Prisma 7 config: where the CLI reads DATABASE_URL
src/
  server.ts                  listener + graceful shutdown
  app.ts                     Express app factory (no listener, so tests can drive it)
  seed.ts                    development accounts (§10) — idempotent, prints the logins
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

### Walkthrough

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
