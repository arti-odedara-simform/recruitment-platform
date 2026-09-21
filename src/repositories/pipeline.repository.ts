import { Prisma, type Stage } from '@prisma/client';
import { prisma } from '../db/client.js';
import type { Actor } from '../domain/actor.js';

/**
 * The pipeline view (PLAN.md §6): counts per stage per role, with ageing, and **no row
 * ever leaves Postgres except the aggregate**.
 *
 * That is the whole point of doing this in SQL. A "load the applications and group them
 * in Node" version answers the same question and materialises 20 000 rows — including
 * every candidate's contact details — to produce thirty numbers. Here the largest result
 * this function can return is (roles x stages), whatever the pipeline holds.
 *
 * Raw rather than Prisma's `groupBy` for two reasons: `groupBy` cannot express the
 * interval aggregates, and the emitted statement is the artefact that gets read at the
 * walkthrough alongside its `EXPLAIN` plan. It is also parameterised throughout —
 * `Prisma.sql` tagged templates bind values, they do not interpolate them.
 */

/** One (role, stage) cell. A role with no applications arrives once with `stage: null`. */
export interface PipelineCell {
  roleId: string;
  title: string;
  stage: Stage | null;
  candidates: number;
  /** Null on the empty-role row; there is no age without an application. */
  averageAgeDays: number | null;
  oldestAgeDays: number | null;
}

export interface PipelineFilter {
  /** `?roleId=` — narrows the view to one req. */
  roleId?: string | undefined;
}

/**
 * Ids are `text`, not `uuid`, in this schema — Prisma's `String @id @default(uuid())`
 * stores the generated uuid as text. So the comparisons below bind plain strings and
 * carry no `::uuid` cast: adding one makes Postgres refuse the operator outright
 * (`text = uuid`), and the route's zod schema is what guarantees the shape anyway.
 */

/**
 * `now() AT TIME ZONE 'UTC'`, not `now()`, and the difference is not cosmetic.
 *
 * Prisma maps `DateTime` to `TIMESTAMP(3)` — *without* time zone — and writes UTC into
 * it. `now()` is a `timestamptz`, so `now() - a."currentStageEnteredAt"` makes Postgres
 * coerce the stored value to the session's time zone before subtracting, and every age
 * comes back shifted by the server's UTC offset. On a machine set to Asia/Kolkata that
 * is five and a half hours of ageing nobody's candidate actually did. `AT TIME ZONE
 * 'UTC'` reduces `now()` to a plain timestamp in the same frame the column is stored in,
 * so the subtraction is between two comparable values wherever the server is.
 *
 * Ages are then seconds divided down, rather than the `interval` that `avg(...)`
 * produces: an interval crosses the wire as a driver-specific object, and "2 mons 5
 * days" is not a number anything can sort or threshold. Days are what the API
 * publishes, so days are what the database is asked for.
 *
 * `count(...)::int` keeps it out of BigInt — count is int8 by default, and a JSON
 * serialiser meeting a BigInt throws. It counts `a."roleId"`, not `a."id"`, and that is
 * a deliberate one-word difference: both are NULL only on the LEFT JOIN's empty-req row,
 * so the number is identical, but `id` is not in the index and `roleId` is. Counting
 * `id` forces a heap fetch for every row and the best plan available becomes an Index
 * Scan at 19 999 buffers; counting `roleId` leaves the whole statement inside
 * `(roleId, currentStage, currentStageEnteredAt)` and an Index *Only* Scan at 706 is on
 * the table — and on the `?roleId=` path it is the difference between 125 buffers and 9.
 * Measured both ways in docs/query-plans.md.
 */
const SELECT_LIST = Prisma.sql`
  SELECT r."id"    AS "roleId",
         r."title" AS "title",
         a."currentStage" AS "stage",
         count(a."roleId")::int AS "candidates",
         (avg(EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - a."currentStageEnteredAt"))) / 86400)::double precision AS "averageAgeDays",
         (max(EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - a."currentStageEnteredAt"))) / 86400)::double precision AS "oldestAgeDays"
`;

/**
 * A LEFT JOIN, where PLAN.md §6 sketched an inner one. The aggregate is unchanged; the
 * difference is that an OPEN req nobody has applied to appears with zero candidates
 * instead of vanishing from the view — which is information a recruiter wants, and an
 * inner join silently withholds.
 *
 * The index the §6 note is about is still the one that matters:
 * `(roleId, currentStage, currentStageEnteredAt)` covers the grouping and the ageing
 * columns, so the aggregate reads the index rather than the table.
 */
async function aggregate(where: Prisma.Sql): Promise<PipelineCell[]> {
  return prisma.$queryRaw<PipelineCell[]>`
    ${SELECT_LIST}
    FROM "Role" r
    LEFT JOIN "Application" a ON a."roleId" = r."id"
    WHERE ${where}
    GROUP BY r."id", r."title", a."currentStage"
    ORDER BY r."title", a."currentStage"
  `;
}

/**
 * `status = 'OPEN'` is not optional and not a parameter (PLAN.md §6). A closed req is
 * not pipeline — it is history — and leaving it switchable would invite a query string
 * that turns the dashboard into a full table scan of every role ever opened.
 */
function openRoles(filter: PipelineFilter): Prisma.Sql[] {
  const predicates = [Prisma.sql`r."status" = 'OPEN'::"RoleStatus"`];

  if (filter.roleId) {
    predicates.push(Prisma.sql`r."id" = ${filter.roleId}`);
  }

  return predicates;
}

/** Recruiters see every open req. */
export async function aggregatePipelineForRecruiter(
  _actor: Actor,
  filter: PipelineFilter,
): Promise<PipelineCell[]> {
  return aggregate(Prisma.join(openRoles(filter), ' AND '));
}

/**
 * Hiring managers see their own reqs and no others, and the restriction is a predicate
 * in the same statement rather than a filter applied to a wider result — the same
 * discipline `findCandidateForInterviewer` follows (PLAN.md §1 layer 2). A hiring
 * manager passing another manager's `?roleId=` gets an empty view, because the row was
 * never selected, not because something dropped it afterwards.
 */
export async function aggregatePipelineForHiringManager(
  actor: Actor,
  filter: PipelineFilter,
): Promise<PipelineCell[]> {
  const predicates = [
    ...openRoles(filter),
    Prisma.sql`r."hiringManagerId" = ${actor.id}`,
  ];

  return aggregate(Prisma.join(predicates, ' AND '));
}
