# Query plans — the pipeline aggregate at 20 000 candidates

What `GET /pipeline` actually does in the database, measured. D9 of [PLAN.md](../PLAN.md)
§11, against the §8 scale dataset.

[PLAN.md](../PLAN.md) §6 makes two claims about this endpoint. This document checks both:

> No row ever reaches Node except the aggregate.

> Index: `(roleId, currentStage, currentStageEnteredAt)`.

The first holds unconditionally — it is a property of the SQL, visible in every plan
below as a `HashAggregate` sitting between the scan and the client. The second turns out
to be **true for the single-req query and irrelevant for the whole-pipeline one**, and
the reason is worth reading: it changed a line of the repository.

---

## 1. Reproducing this

```bash
npm run db:seed:scale                     # 200 reqs, 20 000 candidates, deterministic, ANALYZEs
psql "$DATABASE_URL" -f docs/query-plans.sql
npm run db:seed:scale -- --clean          # remove exactly what was generated
```

The generator is seeded (`SCALE_DEFAULTS.seed`), so the dataset is byte-identical across
runs and two captures are comparable. [query-plans.sql](query-plans.sql) holds the two
statements exactly as [pipeline.repository.ts](../src/repositories/pipeline.repository.ts)
emits them, with the bind parameters written out as literals.

**Environment:** PostgreSQL 16.15 on Ubuntu 24.04, default `postgresql.conf`, local
socket. Every number below is the median of three consecutive runs on a **warm** cache —
`Buffers: shared hit` with no `read` anywhere. That matters for reading §3: on a cold
cache the I/O column is the one that decides, and it is the column where the plans differ
most.

### The dataset

| | |
|---|---|
| Roles | 203 — 177 OPEN, 26 CLOSED |
| Candidates | 20 015 |
| Applications | 21 951 (a tenth of candidates sit on two reqs) |
| `"Application"` heap | 10 MB / 448 pages |
| `Application_roleId_currentStage_currentStageEnteredAt_idx` | 2008 kB / 251 pages |

---

## 2. Q1 — the whole pipeline, `GET /pipeline`

```sql
SELECT r."id", r."title", a."currentStage",
       count(a."roleId")::int,
       avg(...) , max(...)
FROM "Role" r
LEFT JOIN "Application" a ON a."roleId" = r."id"
WHERE r."status" = 'OPEN'::"RoleStatus"
GROUP BY r."id", r."title", a."currentStage"
ORDER BY r."title", a."currentStage";
```

**With the index** — 16.3 ms, 460 buffers:

```
 Sort  (cost=1437.06..1439.72 rows=1062 width=78) (actual time=16.068..16.098 rows=1055 loops=1)
   Sort Key: r.title, a."currentStage"
   Buffers: shared hit=460
   ->  HashAggregate  (cost=1357.13..1383.68 rows=1062 width=78) (actual time=13.498..14.472 rows=1055 loops=1)
         Group Key: a."currentStage", r.id
         Batches: 1  Memory Usage: 833kB
         Buffers: shared hit=452
         ->  Hash Right Join  (cost=8.75..735.08 rows=19140 width=103) (actual time=0.105..5.096 rows=19200 loops=1)
               Hash Cond: (a."roleId" = r.id)
               ->  Seq Scan on "Application" a  (cost=0.00..667.51 rows=21951 width=49) (actual time=0.002..1.256 rows=21951 loops=1)
                     Buffers: shared hit=448
               ->  Hash  (cost=6.54..6.54 rows=177 width=54) (actual time=0.087..0.088 rows=177 loops=1)
                     ->  Seq Scan on "Role" r  (cost=0.00..6.54 rows=177 width=54) (actual time=0.007..0.041 rows=177 loops=1)
                           Filter: (status = 'OPEN'::"RoleStatus")
                           Rows Removed by Filter: 26
 Planning Time: 0.989 ms
 Execution Time: 16.315 ms
```

**Without the index** — 15.1 ms, 460 buffers. *The same plan, node for node.* Dropping
the index changes nothing, because nothing in this query wants it.

That is the correct outcome, not a disappointing one. Q1 has no predicate on
`"Application"` at all: it aggregates **every** application in the table. An index exists
to skip rows, and there are no rows to skip — so a sequential scan of 448 pages is the
cheapest way to read 21 951 rows, and the planner picks it. An index that "should" have
helped here would only mean the query was reading less than it needed to.

The line that carries the §6 claim is this one:

```
->  HashAggregate ... (actual rows=1055)
```

21 951 rows go into that node and 1 055 come out — one per (open req, stage). Those 1 055
are what crosses the wire to Node. The endpoint's response size is bounded by
`open reqs x stages`, and 20 000 candidates and 20 million would produce the same 1 055
rows. **This is the measurement PLAN.md §6 is about**, and it does not depend on any
index.

### Would an index-only scan be better?

Forcing it (`SET enable_seqscan = off`) answers the question rather than leaving it
rhetorical:

| Plan | Buffers | Time |
|---|---|---|
| Seq Scan (planner's choice) | 460 | 16.3 ms |
| Index Only Scan (forced) | 706 | 17.7 ms |

The planner is right at this size. Worth revisiting only if `"Application"` grows wide —
the index is a fifth of the heap today, and the wider the row gets, the better
index-only looks.

---

## 3. Q2 — one req, `GET /pipeline?roleId=…`

Same statement plus `AND r."id" = '…'`. This is where the index earns its place.

**With the index** — 0.145 ms, **9 buffers**:

```
 Sort  (cost=23.51..23.52 rows=6 width=78) (actual time=0.115..0.115 rows=6 loops=1)
   Buffers: shared hit=9
   ->  HashAggregate  (cost=23.28..23.43 rows=6 width=78) (actual time=0.105..0.109 rows=6 loops=1)
         Group Key: a."currentStage"
         ->  Nested Loop Left Join  (cost=0.41..19.20 rows=136 width=103) (actual time=0.027..0.048 rows=136 loops=1)
               ->  Seq Scan on "Role" r  (cost=0.00..7.04 rows=1 width=54) (actual time=0.018..0.019 rows=1 loops=1)
                     Filter: ((status = 'OPEN'::"RoleStatus") AND (id = 'b7d5…'::text))
               ->  Index Only Scan using "Application_roleId_currentStage_currentStageEnteredAt_idx" on "Application" a
                       (cost=0.41..10.79 rows=136 width=49) (actual time=0.008..0.020 rows=136 loops=1)
                     Index Cond: ("roleId" = 'b7d5…'::text)
                     Heap Fetches: 0
                     Buffers: shared hit=5
 Execution Time: 0.145 ms
```

**Without the index** — 1.265 ms, **452 buffers**:

```
               ->  Seq Scan on "Application" a  (cost=0.00..722.39 rows=136 width=49) (actual time=0.002..1.118 rows=136 loops=1)
                     Filter: ("roleId" = 'b7d5…'::text)
                     Rows Removed by Filter: 21815
                     Buffers: shared hit=448
 Execution Time: 1.265 ms
```

| | Buffers | Time | Rows discarded |
|---|---|---|---|
| With index | 9 | 0.145 ms | 0 |
| Without index | 452 | 1.265 ms | 21 815 |

**8.7x faster, 50x less I/O**, and the shape of the difference is what matters more than
the milliseconds: without the index the cost of looking at *one* req is proportional to
the size of the *whole* pipeline. At 200 000 applications that seq scan is ten times
slower again; the index-only scan is not, because it reads only the 136 index entries
under that `roleId`. `Heap Fetches: 0` — the table is never touched.

This is also the plan behind the hiring-manager scope, which is the same statement with
`r."hiringManagerId" = …` instead. In the generated dataset all 200 reqs belong to one
manager, so that variant degenerates to Q1 and is not measured separately; with a
realistic spread of owners it behaves like Q2.

---

## 4. What this changed in the code

`count(a."id")` became `count(a."roleId")`.

Both columns are non-null on `"Application"` and null only on the LEFT JOIN's
no-applications row, so the count is identical — but `id` is not in the index and
`roleId` is. Counting `id` forces the heap to be read for every row, and the best plan
the index can offer drops from *Index Only Scan* to *Index Scan*:

| Q1, `enable_seqscan = off` | Scan node | Buffers | Time |
|---|---|---|---|
| `count(a."roleId")` | Index **Only** Scan, `Heap Fetches: 0` | 706 | 17.7 ms |
| `count(a."id")` | Index Scan + heap access | 19 999 | 22.8 ms |

28x the I/O, for one word. On Q2 — the query that actually uses the index in production —
the same word is the difference between the plan above and a Bitmap Heap Scan touching
117 heap blocks:

| Q2, with index | Plan | Buffers | Time |
|---|---|---|---|
| `count(a."roleId")` | Index Only Scan | 9 | 0.145 ms |
| `count(a."id")` | Bitmap Index Scan + Bitmap Heap Scan | 125 | 0.220 ms |

A covering index only covers if the query stays inside it, and `count(*)` was not an
option here: under a LEFT JOIN it returns 1 for a req with no applications instead of 0.
`count(<indexed non-null column>)` is the version that is both correct and covered.

---

## 5. Conclusions

1. **The §6 claim holds.** 21 951 rows in, 1 055 out, and the bound is
   `open reqs x stages` regardless of pipeline size. Asserted by test, too — see
   "returns at most one row per (open req, stage)" in
   [tests/pipeline.test.ts](../tests/pipeline.test.ts).
2. **`(roleId, currentStage, currentStageEnteredAt)` is the right index, for the right
   query.** It does nothing for the unfiltered view and is worth 50x the I/O on the
   filtered one. Keep it.
3. **`(currentStage, currentStageEnteredAt)`** — the second §2 index — is unused by both
   queries here. It is there for the §8 "stuck beyond N days" view, which filters on
   stage and age across all reqs. Measure it when that endpoint exists; if it ships
   without one, drop the index.
4. **Ageing arithmetic is not free but is not the bottleneck either.** Two `EXTRACT`
   calls per row over 21 951 rows sit inside the 13 ms `HashAggregate`. If Q1 ever needs
   to be faster, that node — not the scan — is where to look, and a materialised rollup
   refreshed on stage change is the answer, at the cost of a stored value two concurrent
   transitions could disagree about. Not a trade worth making at 16 ms.

## 6. What is not measured here

The interviewer-scoping queries (`RoundAssignment_interviewerId_idx`), the audit timeline
and the `GET /roles` listing. All are point lookups or small scans on indexed columns at
a scale the generator does not reach — it creates reqs, candidates and applications, not
rounds, assignments or feedback. Worth a second pass if the §8 deepening items get that
far.
