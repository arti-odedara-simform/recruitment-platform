import type { Schemas } from '../api/client.js';

/**
 * The stage machine, as the screens need to *offer* it.
 *
 * **The server is authoritative.** `src/domain/stageMachine.ts` is the single source of
 * truth, `applicationService.transition()` is its only caller, and an illegal move is
 * refused with a 422 whose body carries the legal set — so this table cannot grant
 * anything. What it does is stop the UI offering moves that are certain to be refused,
 * which is a different job and a purely presentational one.
 *
 * `Stage` is taken from the generated API types rather than written out, so the `ALLOWED`
 * record below stops compiling if a stage is ever added to the enum. That is the guard
 * against this copy drifting quietly: it cannot fall behind the API without breaking the
 * build, and when a transition rule changes the 422 path still renders the truth.
 */
export type Stage = Schemas['ApplicationStage']['currentStage'];

/** Declaration order, so a funnel reads left to right. Not the alphabet. */
export const STAGES: readonly Stage[] = [
  'APPLIED',
  'SCREEN',
  'INTERVIEW',
  'OFFER',
  'HIRED',
  'REJECTED',
];

export const ALLOWED: Record<Stage, readonly Stage[]> = {
  APPLIED: ['SCREEN', 'REJECTED'],
  SCREEN: ['INTERVIEW', 'REJECTED'],
  INTERVIEW: ['OFFER', 'REJECTED'],
  OFFER: ['HIRED', 'REJECTED'],
  HIRED: [],
  REJECTED: [],
};

/** Nothing leaves these two — not even an override. A hire is not walked back by an edit. */
export const TERMINAL: readonly Stage[] = ['HIRED', 'REJECTED'];

export function isTerminal(stage: Stage): boolean {
  return TERMINAL.includes(stage);
}

/**
 * What an override may target: anything but the stage it is already in, and never a move
 * out of a terminal stage. Skipping forward is the point; undoing a hire is not.
 */
export function overrideTargets(from: Stage): readonly Stage[] {
  return isTerminal(from) ? [] : STAGES.filter((stage) => stage !== from);
}
