import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Backend } from './adapters/types.ts';
import { anonymizeText } from './anonymize.ts';
import type { ReplaySummary } from './bench-log.ts';
import { isFamily, type Family } from './config.ts';
import type { StepContext } from './context.ts';
import { isRecord, readArray, readBoolean, readNumber, readRecord, readString, stringArray, type JsonRecord } from './json.ts';
import { readChampionSnapshot } from './pairs.ts';
import { err, ok, type Result } from './result.ts';
import { runAll } from './runner.ts';
import { roundPaths, seededShuffle, sha256 } from './store.ts';
import { displayText, loadSubmission } from './submission.ts';
import { IntegrityError, runTask } from './task.ts';
import { taskId, type Order } from './tasks/ids.ts';
import { tasteTask } from './tasks/taste-pair.ts';
import { parseBenchmark, type Benchmark, type Pick } from './taste.ts';
import { LABELS_FILE, readLabelLedger, reserveLabels, type Label, type LabelText } from './trust.ts';

export type { ReplaySummary } from './bench-log.ts';

/*
 * Replay of a replay-class change on reserve labels (plan §6 step 4, s3 §3.6): every eligible family judges every
 * reserve label under the old and the new version in both orders (fresh sessions, tasteTask with decoy null). A trial
 * agrees iff both orders pick the owner's text on the version's decisive question; a void call removes the
 * (family, label) from both sides. Pass iff n_pooled ≥ replay_min_pairs, pooled new ≥ old and no family loses ≥ 2.
 */

/** Round-local result file under `bench/`. */
export const REPLAY_FILE = 'replay.json';

export type ReplayVersion = 'old' | 'new';

export interface ReplayCall {
  family: Family;
  /** Label id (`C00-P03`, `R01-audit-2`). */
  label: string;
  version: ReplayVersion;
  order: Order;
}

/** `bench/replay.json`. `verdicts` keyed by replayTaskId: true = owner's text picked, false = the other, null = void. */
export interface ReplayResult {
  old_version: string;
  new_version: string;
  plan: ReplayCall[];
  verdicts: Record<string, boolean | null>;
  summary: ReplaySummary;
}

/** seededShuffle key of the plan order. */
const PLAN_KEY = 'replay';
const VERSIONS: readonly ReplayVersion[] = ['old', 'new'];
const ORDERS: readonly Order[] = ['fwd', 'rev'];
const REASONS: readonly ReplaySummary['reason'][] = ['ok', 'pooled_lower', 'family_drop', 'too_few_pairs'];
/** A family whose agreement drops by this many trials fails the replay even when the pool holds. */
const FAMILY_DROP = 2;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `replay-<label>-<family>-<old|new>-<fwd|rev>` (task-id kind `replay`). */
export function replayTaskId(call: ReplayCall): string {
  return taskId(`replay-${call.label}-${call.family}-${call.version}-${call.order}`);
}

/** Per label the families that authored neither text, × old/new × fwd/rev, order interleaved by seededShuffle(seed, 'replay'). */
export function replayPlan(labels: readonly Label[], families: readonly Family[], seed: string): ReplayCall[] {
  const calls: ReplayCall[] = [];
  for (const label of labels) {
    const authors = new Set<Family>(label.texts.flatMap((t) => t.authors));
    for (const family of new Set(families)) {
      if (authors.has(family)) continue;
      for (const version of VERSIONS) for (const order of ORDERS) calls.push({ family, label: label.id, version, order });
    }
  }
  return seededShuffle(calls, seed, PLAN_KEY);
}

type FamilyRow = ReplaySummary['per_family'][string];

/** Per-family trial counts of a plan; a (family, label) with a void or missing call under either version counts void. */
function familyRows(plan: readonly ReplayCall[], verdicts: ReadonlyMap<string, boolean | null>): Map<Family, FamilyRow> {
  const trials = new Map<string, { family: Family; calls: Map<string, boolean | null> }>();
  for (const c of plan) {
    const key = `${c.family}\u0000${c.label}`;
    const trial = trials.get(key) ?? { family: c.family, calls: new Map<string, boolean | null>() };
    trial.calls.set(`${c.version}-${c.order}`, verdicts.get(replayTaskId(c)) ?? null);
    trials.set(key, trial);
  }
  const rows = new Map<Family, FamilyRow>();
  for (const f of [...new Set(plan.map((c) => c.family))].sort(byCodeUnit)) rows.set(f, { old: 0, new: 0, n: 0, void: 0 });
  for (const { family, calls } of trials.values()) {
    const row = rows.get(family);
    if (row === undefined) continue;
    const agrees = (version: ReplayVersion): boolean | null => {
      const [fwd, rev] = ORDERS.map((o) => calls.get(`${version}-${o}`) ?? null);
      return fwd === null || fwd === undefined || rev === null || rev === undefined ? null : fwd && rev;
    };
    const old = agrees('old');
    const next = agrees('new');
    if (old === null || next === null) {
      row.void += 1;
      continue;
    }
    row.n += 1;
    if (old) row.old += 1;
    if (next) row.new += 1;
  }
  return rows;
}

/** First failing rule: the floor, then the pool, then a family drop. */
function reasonOf(pooled: ReplaySummary['pooled'], rows: ReadonlyMap<Family, FamilyRow>, minPairs: number): ReplaySummary['reason'] {
  if (pooled.n < minPairs) return 'too_few_pairs';
  if (pooled.new < pooled.old) return 'pooled_lower';
  if ([...rows.values()].some((r) => r.old - r.new >= FAMILY_DROP)) return 'family_drop';
  return 'ok';
}

function pooledOf(rows: ReadonlyMap<Family, FamilyRow>): ReplaySummary['pooled'] {
  const pooled = { old: 0, new: 0, n: 0 };
  for (const r of rows.values()) {
    pooled.old += r.old;
    pooled.new += r.new;
    pooled.n += r.n;
  }
  return pooled;
}

/** Pure scoring of a plan's verdicts (keyed by replayTaskId); `minPairs` = protocol.calibration.replayMinPairs. */
export function scoreReplay(plan: readonly ReplayCall[], verdicts: ReadonlyMap<string, boolean | null>, minPairs: number): ReplaySummary {
  const rows = familyRows(plan, verdicts);
  const pooled = pooledOf(rows);
  const reason = reasonOf(pooled, rows, minPairs);
  return {
    labels: [...new Set(plan.map((c) => c.label))].sort(byCodeUnit),
    families: [...rows.keys()],
    pooled,
    per_family: Object.fromEntries(rows),
    passed: reason === 'ok',
    reason,
  };
}

/** Where a label text lives: a calibration text file, a round submission, or a round's champion snapshot. */
function storedLabelText(root: string, t: LabelText): string | null {
  if (t.path.endsWith('.md')) {
    const abs = join(root, t.path);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  }
  const m = /^rounds\/([A-Z]\d{2})\/(?:submissions\/([A-Za-z0-9._-]+)\.json|champion\.json)$/u.exec(t.path);
  if (m?.[1] === undefined) return null;
  const paths = roundPaths(root, m[1]);
  if (m[2] === undefined) {
    const champion = readChampionSnapshot(paths);
    return champion.ok ? anonymizeText(champion.value.text) : null;
  }
  const sub = loadSubmission(paths, m[2]);
  return sub === null || sub.output === null ? null : displayText(sub.output);
}

/** The text as judges saw it, re-hashed against the ledger (the replay must judge exactly the labelled pair). */
function labelText(root: string, t: LabelText): string {
  const text = storedLabelText(root, t);
  if (text === null) throw new IntegrityError(`${t.path}: label text ${t.id} is unreadable`);
  if (sha256(text) !== t.sha256) throw new IntegrityError(`${t.path}: label text ${t.id} does not match its ${LABELS_FILE} hash`);
  return text;
}

function benchOf(value: JsonRecord, which: ReplayVersion): Benchmark {
  const parsed = parseBenchmark(value);
  if (!parsed.ok) throw new IntegrityError(`replay: the ${which} benchmark does not parse: ${parsed.error}`);
  return parsed.value;
}

/**
 * The verdict's answer on the benchmark's decisive question. tasteTask answers every question of a parsed benchmark,
 * so a missing answer is an IntegrityError (status.json, lock released), never a void.
 */
export function decisivePick(id: string, picks: Readonly<Record<string, Pick>>, decisive: string): Pick {
  const pick = Object.hasOwn(picks, decisive) ? picks[decisive] : undefined;
  if (pick === undefined) throw new IntegrityError(`${id}: the verdict has no answer to ${decisive}`);
  return pick;
}

interface ShownLabel {
  label: Label;
  texts: [{ id: string; text: string }, { id: string; text: string }];
}

function shownLabel(root: string, label: Label): ShownLabel {
  const [a, b] = label.texts;
  if (a === undefined || b === undefined || label.texts.length !== 2) throw new IntegrityError(`${LABELS_FILE}: label ${label.id} must have exactly two texts`);
  return { label, texts: [{ id: a.id, text: labelText(root, a) }, { id: b.id, text: labelText(root, b) }] };
}

/**
 * Labels = reserveLabels(ledger, protocol.calibration.replayMaxPairs); runs the plan with runAll on the families' judge
 * backends (seed ctx.seed()); throws IntegrityError on an unreadable ledger or label text.
 */
export async function runReplay(ctx: StepContext, oldV: JsonRecord, newV: JsonRecord, families: readonly Family[]): Promise<ReplayResult> {
  const ledger = readLabelLedger(ctx.root);
  if (ledger === null) throw new IntegrityError(`${LABELS_FILE} is missing: the replay needs the blind-label ledger`);
  if (!ledger.ok) throw new IntegrityError(ledger.error);
  const benches = { old: benchOf(oldV, 'old'), new: benchOf(newV, 'new') };
  const labels = reserveLabels(ledger.value, ctx.protocol.calibration.replayMaxPairs);
  // Every text is read and re-hashed before the first paid call.
  const shown = new Map(labels.map((l) => [l.id, shownLabel(ctx.root, l)]));
  const backends = new Map<Family, Backend>();
  for (const f of families) {
    const judge = ctx.backends.judges.find((j) => j.backend.family === f);
    if (judge === undefined) throw new IntegrityError(`replay: no judge backend of family ${f}`);
    if (!backends.has(f)) backends.set(f, judge.backend);
  }
  const seed = ctx.seed();
  const plan = replayPlan(labels, families, seed);
  const verdicts = new Map<string, boolean | null>();
  await runAll(
    ctx,
    plan.map((c) => async () => {
      const entry = shown.get(c.label);
      const backend = backends.get(c.family);
      if (entry === undefined || backend === undefined) throw new IntegrityError(`replay: call ${replayTaskId(c)} has no label or backend`);
      const [a, b] = entry.texts;
      const [first, second] = c.order === 'fwd' ? [a, b] : [b, a];
      const bench = c.version === 'old' ? benches.old : benches.new;
      const id = replayTaskId(c);
      const r = await runTask(ctx, backend, tasteTask(bench, { text1: first.text, text2: second.text, decoy: null }, seed, id));
      if (r.value === null) {
        verdicts.set(id, null);
        return;
      }
      const pick = decisivePick(id, r.value.picks, bench.decisive);
      verdicts.set(id, (pick === 1 ? first.id : second.id) === entry.label.owner_chosen);
    }),
  );
  const scored = scoreReplay(plan, verdicts, ctx.protocol.calibration.replayMinPairs);
  const perFamily: ReplaySummary['per_family'] = {};
  for (const f of families) perFamily[f] = scored.per_family[f] ?? { old: 0, new: 0, n: 0, void: 0 };
  return {
    old_version: benches.old.version,
    new_version: benches.new.version,
    plan,
    verdicts: Object.fromEntries(plan.map((c) => [replayTaskId(c), verdicts.get(replayTaskId(c)) ?? null])),
    // The reserve labels and families asked, in their own order (newest label first; judges.json order).
    summary: { ...scored, labels: labels.map((l) => l.id), families: [...backends.keys()], per_family: perFamily },
  };
}

function count(value: unknown, key: string): number | null {
  const n = readNumber(value, key);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
}

function parseCall(value: unknown, i: number): Result<ReplayCall> {
  const family = readString(value, 'family');
  const label = readString(value, 'label');
  const version = readString(value, 'version');
  const order = readString(value, 'order');
  if (family === null || !isFamily(family) || label === null || label === '') return err(`plan[${i}]: family and label are required`);
  const v = VERSIONS.find((x) => x === version);
  const o = ORDERS.find((x) => x === order);
  if (v === undefined || o === undefined) return err(`plan[${i}]: version must be old|new and order fwd|rev`);
  return ok({ family, label, version: v, order: o });
}

function parseRow(value: unknown, family: string): Result<FamilyRow> {
  const row = { old: count(value, 'old'), new: count(value, 'new'), n: count(value, 'n'), void: count(value, 'void') };
  if (!isFamily(family) || !isRecord(value) || Object.keys(value).length !== 4) return err(`summary.per_family.${family}: expected a family with old, new, n and void`);
  if (row.old === null || row.new === null || row.n === null || row.void === null) return err(`summary.per_family.${family}: counts must be non-negative integers`);
  return ok({ old: row.old, new: row.new, n: row.n, void: row.void });
}

function parseSummary(value: JsonRecord | null): Result<ReplaySummary> {
  const labels = stringArray(value?.['labels']);
  const families = stringArray(value?.['families']);
  const pooled = readRecord(value, 'pooled');
  const counts = { old: count(pooled, 'old'), new: count(pooled, 'new'), n: count(pooled, 'n') };
  const passed = readBoolean(value, 'passed');
  const reason = REASONS.find((r) => r === readString(value, 'reason'));
  if (labels === null || families === null || passed === null || reason === undefined) return err('summary: labels, families, passed and reason are required');
  if (counts.old === null || counts.new === null || counts.n === null) return err('summary.pooled: counts must be non-negative integers');
  const knownFamilies: Family[] = [];
  for (const f of families) {
    if (!isFamily(f)) return err(`summary.families: unknown family ${f}`);
    knownFamilies.push(f);
  }
  const perFamily: ReplaySummary['per_family'] = {};
  for (const [family, raw] of Object.entries(readRecord(value, 'per_family') ?? {})) {
    const row = parseRow(raw, family);
    if (!row.ok) return row;
    perFamily[family] = row.value;
  }
  return ok({ labels, families: knownFamilies, pooled: { old: counts.old, new: counts.new, n: counts.n }, per_family: perFamily, passed, reason });
}

/** The summary must be the plan's verdicts scored at the protocol floor `minPairs`, reason included. */
function summaryProblem(s: ReplaySummary, plan: readonly ReplayCall[], verdicts: ReadonlyMap<string, boolean | null>, minPairs: number): string | null {
  const rows = familyRows(plan, verdicts);
  const pooled = pooledOf(rows);
  if (pooled.old !== s.pooled.old || pooled.new !== s.pooled.new || pooled.n !== s.pooled.n) return 'summary.pooled does not score the plan verdicts';
  for (const [family, row] of rows) {
    const got = s.per_family[family];
    if (got === undefined || got.old !== row.old || got.new !== row.new || got.n !== row.n || got.void !== row.void) return `summary.per_family.${family} does not score the plan verdicts`;
  }
  if (s.passed !== (s.reason === 'ok')) return 'summary.passed contradicts its reason';
  const expected = reasonOf(pooled, rows, minPairs);
  if (s.reason !== expected) return `summary.reason ${s.reason} contradicts the counts (${expected})`;
  return null;
}

/** Validates a `bench/replay.json` read back from disk; `minPairs` = protocol.calibration.replayMinPairs (as scoreReplay). */
export function parseReplayResult(value: unknown, minPairs: number): Result<ReplayResult> {
  if (!isRecord(value)) return err('replay: expected an object');
  const oldVersion = readString(value, 'old_version');
  const newVersion = readString(value, 'new_version');
  if (oldVersion === null || newVersion === null) return err('replay: old_version and new_version are required strings');
  const plan: ReplayCall[] = [];
  for (const [i, raw] of (readArray(value, 'plan') ?? []).entries()) {
    const call = parseCall(raw, i);
    if (!call.ok) return err(`replay: ${call.error}`);
    plan.push(call.value);
  }
  const rawVerdicts = readRecord(value, 'verdicts');
  if (rawVerdicts === null) return err('replay: verdicts is required');
  const ids = plan.map(replayTaskId);
  const keys = Object.keys(rawVerdicts);
  if (keys.length !== ids.length || new Set(ids).size !== ids.length || !ids.every((id) => Object.hasOwn(rawVerdicts, id))) return err('replay: verdict keys must equal the plan task ids');
  const verdicts: Record<string, boolean | null> = {};
  for (const id of ids) {
    const v = rawVerdicts[id];
    if (v !== null && typeof v !== 'boolean') return err(`replay: verdict ${id} must be true, false or null`);
    verdicts[id] = v;
  }
  const summary = parseSummary(readRecord(value, 'summary'));
  if (!summary.ok) return err(`replay: ${summary.error}`);
  const problem = summaryProblem(summary.value, plan, new Map(Object.entries(verdicts)), minPairs);
  if (problem !== null) return err(`replay: ${problem}`);
  return ok({ old_version: oldVersion, new_version: newVersion, plan, verdicts, summary: summary.value });
}
