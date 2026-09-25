import type { Family } from '../config.ts';
import { TASK_ID } from '../task.ts';

/**
 * Task ids (= provenance labels) of every PR-B task, plan §3.3:
 * `<kind>-<subject>-<family or backendId>[-s<k>[r]-<fwd|rev>][-rerun|-re|-2|-t<n>]`. Subjects are submission ids
 * (`W1`, `W1-r2`, `BASE`, `DECOY`, anchors `AN1`/`AN2`, aux pairs `<a>.<b>`), never the letters assigned at 08.
 * The fake router routes on the kind (text before the first `-`). Every builder throws on an id TASK_ID refuses.
 */

export type Order = 'fwd' | 'rev';

/** `id` when it matches TASK_ID, else a crash (a malformed id is an engine bug, never model input). */
export function taskId(id: string): string {
  if (!TASK_ID.test(id)) throw new Error(`not a task id: ${JSON.stringify(id)}`);
  return id;
}

/** The resubmitted submission of a writer slot: `W1` → `W1-r2` (file `submissions/W1-r2.json`, writer task `write-W1-r2`). */
export function resubmissionId(slot: string): string {
  return `${slot}-r2`;
}

/** 05b: `defect-<submission>` (gateway; a void is final, no rerun). */
export function defectTaskId(submission: string): string {
  return taskId(`defect-${submission}`);
}

/**
 * 05c / 05d gate calls: `gate-<sub>-<family>-<n>` on the real text, `gatecopy-<sub>-<family>-<n>` on the defect
 * copy; `n` = the assignment's ordinal on that submission (1, 2 = the seeded judges; 3, 4, … = reserve replacements
 * in seeded order). The 05d pass on a resubmission carries `-re`: `gate-W1-r2-xAI-1-re`.
 */
export function gateTaskId(submission: string, family: Family, n: number, opts: { copy: boolean; resubmission: boolean }): string {
  if (!Number.isInteger(n) || n < 1) throw new Error(`gateTaskId: n must be a positive integer, got ${n}`);
  return taskId(`${opts.copy ? 'gatecopy' : 'gate'}-${submission}-${family}-${n}${opts.resubmission ? '-re' : ''}`);
}

/** 06a: `decoy-DECOY`, then `decoy-DECOY-t<n>` from the second step attempt on (void → failed, rerun calls afresh). */
export function decoyTaskId(attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`decoyTaskId: attempt must be a positive integer, got ${attempt}`);
  return taskId(attempt === 1 ? 'decoy-DECOY' : `decoy-DECOY-t${attempt}`);
}

/** Aux pair id: sub–sub pairs sort their two ids by code unit (`W1.W3`); anchor pairs are `<sub>.<anchor>` (`W1.AN1`). */
export function auxPairId(a: string, b: string, kind: 'sub_sub' | 'anchor'): string {
  if (kind === 'anchor') return `${a}.${b}`;
  return a < b ? `${a}.${b}` : `${b}.${a}`;
}

/**
 * 06b / 06c taste calls: `taste-<pair>-<family>-s<k>[r]-<fwd|rev>`; champion pair id = the submission id
 * (`taste-W1-Moonshot-s1r-rev`), aux pairs use session 0 and never rerun (`taste-W1.W3-xAI-s0-fwd`). Shadow
 * (flagged) families use the same ids (their family differs).
 */
export function tasteTaskId(pair: string, family: Family, session: number, rerun: boolean, order: Order): string {
  if (!Number.isInteger(session) || session < 0) throw new Error(`tasteTaskId: session must be a non-negative integer, got ${session}`);
  return taskId(`taste-${pair}-${family}-s${session}${rerun ? 'r' : ''}-${order}`);
}

export type MeasureKind = 'recall' | 'skin' | 'cold' | 'producer';

/** 06d: `recall-<sub>-<family>`, `skin-…`, `cold-…`, `producer-…`; the producer's second family carries `-2`. */
export function measureTaskId(kind: MeasureKind, submission: string, family: Family, second: boolean): string {
  if (second && kind !== 'producer') throw new Error(`measureTaskId: only the producer has a second family, not ${kind}`);
  return taskId(`${kind}-${submission}-${family}${second ? '-2' : ''}`);
}

export type SurpriseKind = 'match' | 'chain' | 'accept';

/** 07b: `match-<sub>-<family>`, `chain-<sub>-<family>`, `accept-<sub>-<family>` (a reused acceptor keeps its own kind). */
export function surpriseTaskId(kind: SurpriseKind, submission: string, family: Family): string {
  return taskId(`${kind}-${submission}-${family}`);
}

/** 09a audit pair id and blind-label id: `<RNN>-audit-<k>`, k = 1…4 in audit-set order. */
export function auditPairId(round: string, k: number): string {
  if (!Number.isInteger(k) || k < 1) throw new Error(`auditPairId: k must be a positive integer, got ${k}`);
  return `${round}-audit-${k}`;
}
