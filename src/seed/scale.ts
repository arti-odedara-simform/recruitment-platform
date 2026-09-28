import { RoleStatus, Stage } from '@prisma/client';
import { hashPassword } from '../auth/password.js';
import {
  analyzePipelineTables,
  createHiringManager,
  findAnyHiringManagerId,
  insertApplications,
  insertCandidates,
  insertRoles,
} from '../repositories/scale.repository.js';

/**
 * The PLAN.md §8 scale generator: 200 reqs and 20 000 candidates, so the §6 pipeline
 * aggregate can be `EXPLAIN (ANALYZE, BUFFERS)`-ed against a volume where the index
 * choice actually shows (D9).
 *
 * Deterministic on purpose. Everything below — ids included — comes out of one seeded
 * PRNG, so two runs produce byte-identical data and a plan captured before an index can
 * be compared with one captured after. A generator using `crypto.randomUUID()` and
 * `Math.random()` would make every measurement its own dataset.
 */

export const MARKERS = {
  /** Every generated candidate's email ends here; the cleanup is keyed on it. */
  emailDomain: '@scale.example.invalid',
  titlePrefix: '[scale] ',
  managerEmail: 'scale.manager@scale.example.invalid',
} as const;

export interface ScaleOptions {
  roles: number;
  candidates: number;
  /** Share of candidates who sit on a second req — the pipeline unit is the application. */
  secondApplicationRate: number;
  /** Fixed so the dataset is reproducible; change it only to generate a different one. */
  seed: number;
}

export const SCALE_DEFAULTS: ScaleOptions = {
  roles: 200,
  candidates: 20_000,
  secondApplicationRate: 0.1,
  seed: 0x5eed,
};

/** mulberry32 — small, fast, and identical across Node versions, which is the requirement. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A v4-shaped uuid drawn from the PRNG, so ids are part of the reproducible output. */
function uuid(random: () => number): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let index = 0; index < 32; index += 1) {
    if (index === 12) out += '4';
    else if (index === 16) out += hex[8 + Math.floor(random() * 4)];
    else out += hex[Math.floor(random() * 16)];
  }
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
}

/**
 * A funnel shape rather than a uniform one: most applications sit early, few reach
 * OFFER. A uniform distribution would hand every stage the same row count and hide
 * exactly the skew a real pipeline's query plan has to cope with.
 */
const STAGE_WEIGHTS: Array<[Stage, number]> = [
  [Stage.APPLIED, 0.4],
  [Stage.SCREEN, 0.22],
  [Stage.INTERVIEW, 0.16],
  [Stage.OFFER, 0.05],
  [Stage.HIRED, 0.03],
  [Stage.REJECTED, 0.14],
];

function pickStage(random: () => number): Stage {
  let roll = random();
  for (const [stage, weight] of STAGE_WEIGHTS) {
    roll -= weight;
    if (roll <= 0) return stage;
  }
  return Stage.APPLIED;
}

const MS_PER_DAY = 86_400_000;

export interface ScaleResult {
  roles: number;
  candidates: number;
  applications: number;
  milliseconds: number;
}

export async function generateScaleDataset(
  options: Partial<ScaleOptions> = {},
  now: Date = new Date(),
): Promise<ScaleResult> {
  const config = { ...SCALE_DEFAULTS, ...options };
  const random = prng(config.seed);
  const startedAt = Date.now();

  // Reuse the fixture's hiring manager when the demo seed has run, so the generated reqs
  // land under an account that can actually read `GET /pipeline` at the walkthrough.
  const hiringManagerId =
    (await findAnyHiringManagerId()) ??
    (await createHiringManager({
      email: MARKERS.managerEmail,
      name: 'Scale Fixture Manager',
      passwordHash: await hashPassword('scale-dataset-not-for-login'),
    }));

  /**
   * A tenth of the reqs are CLOSED. The §6 aggregate filters them out, so a dataset
   * where every req is open would let the `WHERE status = 'OPEN'` predicate look free —
   * here it has real rows to exclude.
   */
  const roleIds: string[] = [];
  const roles = Array.from({ length: config.roles }, (_, index) => {
    const id = uuid(random);
    const closed = random() < 0.1;
    roleIds.push(id);
    return {
      id,
      title: `${MARKERS.titlePrefix}Req ${String(index + 1).padStart(4, '0')}`,
      hiringManagerId,
      status: closed ? RoleStatus.CLOSED : RoleStatus.OPEN,
      openedAt: new Date(now.getTime() - Math.floor(random() * 365) * MS_PER_DAY),
    };
  });

  await insertRoles(roles);

  const candidates: Array<{ id: string; name: string; email: string; phone: string | null }> = [];
  const applications: Array<{
    id: string;
    candidateId: string;
    roleId: string;
    currentStage: Stage;
    currentStageEnteredAt: Date;
  }> = [];

  for (let index = 0; index < config.candidates; index += 1) {
    const candidateId = uuid(random);
    candidates.push({
      id: candidateId,
      name: `Scale Candidate ${index + 1}`,
      // Contact details on every row, and `.invalid` by RFC 2606 so nothing generated
      // here could ever reach a real inbox. The leak sweep needs something to find.
      email: `candidate.${index + 1}${MARKERS.emailDomain}`,
      phone: random() < 0.8 ? `+44 20 7946 ${String(index % 10_000).padStart(4, '0')}` : null,
    });

    const first = roleIds[Math.floor(random() * roleIds.length)] as string;
    applications.push(application(uuid(random), candidateId, first, random, now));

    if (random() < config.secondApplicationRate) {
      const second = roleIds[Math.floor(random() * roleIds.length)] as string;
      if (second !== first) {
        applications.push(application(uuid(random), candidateId, second, random, now));
      }
    }
  }

  await insertCandidates(candidates);
  await insertApplications(applications);
  await analyzePipelineTables();

  return {
    roles: roles.length,
    candidates: candidates.length,
    applications: applications.length,
    milliseconds: Date.now() - startedAt,
  };
}

/**
 * Ageing spread over 120 days. The §8 "stuck beyond N days" view needs rows on both
 * sides of any plausible threshold, and the §6 ageing columns need a spread to mean
 * anything at all.
 */
function application(
  id: string,
  candidateId: string,
  roleId: string,
  random: () => number,
  now: Date,
) {
  return {
    id,
    candidateId,
    roleId,
    currentStage: pickStage(random),
    currentStageEnteredAt: new Date(now.getTime() - Math.floor(random() * 120) * MS_PER_DAY),
  };
}
