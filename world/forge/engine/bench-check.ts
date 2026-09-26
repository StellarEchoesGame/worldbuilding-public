import { loadVersion, readBenchLog, type BenchLogEntry, type VersionRef } from './bench-log.ts';
import { changedKeys, validateBenchmark, type Activation, type BenchVerdict, type RollbackEntry } from './bench-validate.ts';
import type { StepContext } from './context.ts';
import { isRecord, readRecord, readString, type JsonRecord } from './json.ts';
import { ownerInputs, readOwnerLog, type OwnerInputs } from './owner-inputs.ts';
import type { Protocol } from './protocol.ts';
import { err, ok, type Result } from './result.ts';
import { benchContext } from './rules.ts';
import { PROMPT_SLOTS } from './taste-template.ts';
import { IntegrityError } from './task.ts';

/*
 * Candidate validation of the cycle (plan §6 step 3, s3 §3.5) on the F1-01 validateBenchmark: prompt slots, rollback
 * holds from the owner log, the allocated version; and the file form of `forge bench validate`, whose holds default
 * to the owner-log rollbacks when --rollbacks is absent.
 */

/** Key path → required `{SLOT}` tokens, each exactly once (taste.template ← taste-template.ts PROMPT_SLOTS). */
export const BENCH_PROMPT_SLOTS: Readonly<Record<string, readonly string[]>> = { 'taste.template': [...PROMPT_SLOTS] };

/** validateBenchmark's verdict plus the slot and version checks (`ok` false when either list is non-empty). */
export interface CandidateVerdict extends BenchVerdict {
  slotErrors: string[];
  versionErrors: string[];
}

/** validateCandidate's error for a `change` whose maintainer keys equal the head (logged as no_change). */
const NO_CHANGE_ERROR = 'change output equals head';
/** A `{NAME}` token in a slotted prompt. */
const SLOT_TOKEN = /\{([A-Z0-9_]+)\}/gu;
const ROUND_ID = /^R(\d{2})$/u;

function valueAt(record: JsonRecord, path: string): unknown {
  let at: unknown = record;
  for (const part of path.split('.')) {
    if (!isRecord(at)) return undefined;
    at = at[part];
  }
  return at;
}

/** Missing, duplicated or unknown `{[A-Z0-9_]+}` tokens per slotted key; a prototype author is exempt. */
export function promptSlotErrors(candidate: JsonRecord, slots: Readonly<Record<string, readonly string[]>>): string[] {
  if (readString(readRecord(candidate, 'author'), 'kind') === 'prototype') return [];
  const errors: string[] = [];
  for (const [path, required] of Object.entries(slots)) {
    const value = valueAt(candidate, path);
    // Absent or null = the engine default prompt (schema: optional template).
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      errors.push(`${path}: not a string`);
      continue;
    }
    const counts = new Map<string, number>();
    for (const m of value.matchAll(SLOT_TOKEN)) {
      const name = m[1] ?? '';
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    for (const slot of required) {
      const n = counts.get(slot) ?? 0;
      if (n === 0) errors.push(`${path}: missing slot {${slot}}`);
      else if (n > 1) errors.push(`${path}: slot {${slot}} occurs ${n} times`);
    }
    for (const name of counts.keys()) if (!required.includes(name)) errors.push(`${path}: unknown slot {${name}}`);
  }
  return errors;
}

/** `R03` → 3, `R00` → 0; anything else (P rounds, calibration sets) → err. */
export function roundNumber(id: string): Result<number> {
  const m = ROUND_ID.exec(id);
  return m?.[1] === undefined ? err(`${JSON.stringify(id)} is not a round id (R00-R99)`) : ok(Number(m[1]));
}

/** The logged `activate` / `pending_owner` line of `version` (the first, as bench-active's validRollbacks reads it). */
function loggedRef(log: readonly BenchLogEntry[], version: string): VersionRef | null {
  const entry = log.find((e) => e.version === version && (e.outcome === 'activate' || e.outcome === 'pending_owner'));
  return entry === undefined || entry.sha256 === null || entry.path === null ? null : { version, sha256: entry.sha256, path: entry.path };
}

/** The version file of a logged `activate` / `pending_owner` line, re-hashed against the log. */
function loggedVersion(root: string, log: readonly BenchLogEntry[], version: string): Result<JsonRecord> {
  const ref = loggedRef(log, version);
  if (ref === null) return err(`${version} is not a logged version`);
  return loadVersion(root, ref);
}

/**
 * One RollbackEntry per owner rollback: round = roundNumber(entry.round) (null → 0), keys = the keys changedKeys finds
 * over `activation` (the protocol's map) between the `from` and target versions (both loaded through the log,
 * re-hashed). A rollback whose target has no logged `activate` / `pending_owner` line, or whose sha256 is not that
 * line's, is skipped, as bench-active's validRollbacks ignores it (the UI refuses such a click; only a hand-written line
 * carries one). err = a version file whose bytes no longer match the log, or a `from` the log does not know: bench-active
 * counts that rollback whatever its `from` says, so its hold must not vanish. Deliberately timing- and approval-blind
 * (validRollbacks' "logged after the click" / "pending never approved" rules are not mirrored): a hand-written line can
 * only add a hold, never remove one (fail closed).
 */
export function rollbackHolds(root: string, owner: OwnerInputs, log: readonly BenchLogEntry[], activation: Readonly<Record<string, Activation>>): Result<RollbackEntry[]> {
  // ownerInputs swallows an unreadable log (no rollbacks); a hold must not vanish that way.
  const readable = readOwnerLog(root);
  if (!readable.ok) return err(`owner-log.jsonl needs repair: ${readable.error}`);
  const out: RollbackEntry[] = [];
  for (const [i, r] of owner.rollbacks().entries()) {
    const at = `rollback ${i + 1}`;
    const logged = loggedRef(log, r.version);
    if (logged === null || logged.sha256 !== r.sha256) continue;
    const round = r.round === null ? ok(0) : roundNumber(r.round);
    if (!round.ok) return err(`${at}: ${round.error}`);
    const target = loadVersion(root, logged);
    if (!target.ok) return err(`${at}: ${target.error}`);
    const from = loggedVersion(root, log, r.from);
    if (!from.ok) return err(`${at}: ${from.error}`);
    out.push({ round: round.value, rolledBackKeys: changedKeys(target.value, from.value, activation) });
  }
  return ok(out);
}

/**
 * validateBenchmark(candidate, head, benchContext(root, protocol, roundNumber(ctx.roundId), holds)) + slots +
 * `version === candidate.version`. A body whose maintainer keys equal the head and that breaks no rule is `noChange`
 * with the one error NO_CHANGE_ERROR; one that also breaks a rule (a protected key, a schema error) is not a no-change
 * but a rejection (`noChange` false, its errors kept), so decideOutcome logs rejected_validate, not no_change. A root
 * version (null head) is always owner class. A pipeline without an R round id, or an unreadable schema, throws (the
 * candidate is not at fault, so no outcome may be logged).
 */
export function validateCandidate(ctx: StepContext, candidate: JsonRecord, head: JsonRecord | null, holds: readonly RollbackEntry[], version: string): CandidateVerdict {
  const round = roundNumber(ctx.roundId);
  if (!round.ok) throw new Error(`validateCandidate: ${round.error}`);
  const bench = benchContext(ctx.root, ctx.protocol, round.value, [...holds]);
  if (!bench.ok) throw new IntegrityError(`validateCandidate: ${bench.error}`);
  const base = validateBenchmark(candidate, head, bench.value);
  const slotErrors = promptSlotErrors(candidate, BENCH_PROMPT_SLOTS);
  const claimed = candidate['version'];
  const versionErrors = claimed === version ? [] : [`version must be the allocated ${version}, got ${typeof claimed === 'string' ? claimed : String(claimed)}`];
  if (base.noChange && base.errors.length === 0) return { ...base, ok: false, errors: [NO_CHANGE_ERROR], activation: null, slotErrors, versionErrors };
  if (base.noChange) return { ...base, ok: false, activation: null, noChange: false, slotErrors, versionErrors };
  const passed = base.ok && slotErrors.length === 0 && versionErrors.length === 0;
  const activation = !passed ? null : head === null ? 'owner' : base.activation;
  return { ...base, ok: passed, activation, slotErrors, versionErrors };
}

/** `forge bench validate <file>`: `rollbacks` null → rollbackHolds over the owner log and benchmark log (protocol's activation map); err = unreadable inputs. */
export function validateBenchFile(root: string, protocol: Protocol, input: { candidate: unknown; parent: unknown; round: number; rollbacks: readonly RollbackEntry[] | null }): Result<BenchVerdict> {
  let holds: RollbackEntry[];
  if (input.rollbacks === null) {
    const log = readBenchLog(root);
    if (!log.ok) return log;
    const fromLog = rollbackHolds(root, ownerInputs(root), log.value, protocol.activation);
    if (!fromLog.ok) return fromLog;
    holds = fromLog.value;
  } else {
    holds = [...input.rollbacks];
  }
  const bench = benchContext(root, protocol, input.round, holds);
  if (!bench.ok) return bench;
  return ok(validateBenchmark(input.candidate, input.parent, bench.value));
}
