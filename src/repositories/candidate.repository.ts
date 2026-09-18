import { prisma } from '../db/client.js';
import type { Actor } from '../domain/actor.js';

/**
 * The layer-1 and layer-2 mechanisms from PLAN.md §1, in one file.
 *
 * **Layer 1 — field-set selection.** Two hard-coded `select` objects. `recruiter` names
 * `email` and `phone`; `interviewer` does not name them *at all*. That is the difference
 * between "we removed the contact details" and "the contact details were never in the
 * row Postgres handed back" — the emitted SQL for an interviewer request contains no
 * reference to those columns, which is what makes the answer to walkthrough Q3 a fact
 * about the query rather than a claim about the serializer.
 *
 * **Layer 2 — scoped reads.** Neither function below can be called without an `actor`,
 * and the interviewer's assignment check lives in the `where` clause, not in an `if`
 * after the fetch. An unassigned candidate comes back as zero rows, so the refusal
 * happens in the database and the route has nothing to leak.
 *
 * There is deliberately no `findCandidate(id)` here. Adding one would make the wide
 * shape reachable, and the whole design rests on it not being.
 */
export const CANDIDATE_SELECT = {
  recruiter: {
    id: true,
    name: true,
    email: true,
    phone: true,
    createdAt: true,
  },
  /**
   * No `email`. No `phone`. Do not add them, and do not add a `candidate: true` nested
   * include anywhere that would reach around this object — tests/candidates.test.ts
   * asserts on these keys *and* on the SQL Prisma emits.
   */
  interviewer: {
    id: true,
    name: true,
  },
} as const;

export interface RecruiterCandidateView {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  createdAt: Date;
}

export interface InterviewerCandidateView {
  id: string;
  name: string;
}

/**
 * Recruiters are not scoped to a subset of candidates — the role *is* the authorization,
 * and PLAN.md §4 puts the full record on their side of the line.
 *
 * It still takes an `actor`, because the architectural rule in §1 is that no repository
 * function returns a candidate without one. An unscoped read that advertises itself as
 * unscoped is reviewable; one that quietly takes only an id is the function a future
 * handler reaches for by mistake.
 */
export async function findCandidateForRecruiter(
  _actor: Actor,
  candidateId: string,
): Promise<RecruiterCandidateView | null> {
  return prisma.candidate.findUnique({
    where: { id: candidateId },
    select: CANDIDATE_SELECT.recruiter,
  });
}

/**
 * The query the POC is built around.
 *
 * The `where` is two conditions, not one: the candidate's id *and* the existence of a
 * round assignment leading back to this interviewer. Postgres resolves both; a candidate
 * this interviewer has no business seeing produces zero rows, and the caller cannot tell
 * that case apart from a candidate who does not exist — which is the 404-not-403 choice
 * PLAN.md §4 makes explicit.
 *
 * `findFirst` rather than `findUnique`: a relation filter is not part of any unique
 * index, so Prisma will not accept it in `findUnique`'s `where`. The `id` equality still
 * makes the result at most one row.
 */
export async function findCandidateForInterviewer(
  actor: Actor,
  candidateId: string,
): Promise<InterviewerCandidateView | null> {
  return prisma.candidate.findFirst({
    where: {
      id: candidateId,
      applications: {
        some: {
          rounds: {
            some: {
              assignments: {
                some: { interviewerId: actor.id },
              },
            },
          },
        },
      },
    },
    select: CANDIDATE_SELECT.interviewer,
  });
}
