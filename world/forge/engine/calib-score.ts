import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBenchLog } from './bench-log.ts';
import { PAIRS_FILE, readCalibSet, type CalibPairRecord, type CalibSetRecord, type DisplayRecord, type RequalReason, type SetId, type SetKind } from './calib-build.ts';
import { dryrunPath, jobsFor, PIN_FILE, readDryrunVerdicts, readPin, readVerdicts, type CalibPin, type DryrunVerdictRecord, type VerdictRecord } from './calib-run.ts';
import { qualifyNeed, round4, wilson, type Interval } from './calib-stats.ts';
import { FAMILIES, isFamily, type Family } from './config.ts';
import type { StepContext } from './context.ts';
import { isRecord, readArray, readBoolean, readNumber, readRecord, readString } from './json.ts';
import { OWNER_ANSWERS, OWNER_LOG, sha256Bytes, type CalibAnswer } from './owner-inputs.ts';
import type { CalibCategory, ProtocolCalibration } from './protocol.ts';
import { err, ok, type Result } from './result.ts';
import type { StepDef, StepOutcome } from './runner.ts';
import { loadSchema, validate, type Schema } from './schema.ts';
import { canonicalJson } from './seal.ts';
import { sha256 } from './store.ts';
import { IntegrityError } from './task.ts';
import { LABELS_FILE, rebuildTrust } from './trust.ts';
import { MIN_QUALIFIED_FAMILIES, TRUST_STATUS } from './trust-status.ts';

/**
 * `forge calib score` (c5-score, s4 §4.4): per-family qualification, gate dry-run result, owner retest
 * consistency, writer-model recommendation and the per-set report (`calibration/round0.json`,
 * `requal-<Qnn>.json`, `gate-<Gnn>.json`), then trust.ts rebuildTrust(ctx, set).
 */

export interface PairOutcome {
  pair: string;
  category: CalibCategory;
  /** The family judged this pair (not an author; Q: its own family only). */
  judged: boolean;
  /** Both orders ok and the same decisive text. */
  consistent: boolean;
  /** Both orders ok and both pick the owner's first answer. */
  agree: boolean;
  /** known pairs: both orders pick known_better; else null. */
  knownCorrect: boolean | null;
  void: number;
}

export interface FamilyScore {
  family: Family;
  nonknown: { m: number; agree: number; need: number; wilson90: Interval };
  known: { k: number; correct: number; need: number };
  byCategory: Partial<Record<CalibCategory, { m: number; agree: number }>>;
  orderConsistency: { n: number; consistent: number };
  voidCalls: number;
  qualified: boolean;
}

export interface OwnerRetest {
  n: number;
  consistent: number;
  wilson90: Interval;
}

export interface WriterModelRow {
  model: string;
  ownerWins: number;
  ownerN: number;
  panelWins: number;
  panelN: number;
}

/** Gate dry-run of one family: gate_judge iff of − caught ≤ gateDryrunMaxMiss (and of > 0). */
export interface DryrunScore {
  caught: number;
  of: number;
  gateJudge: boolean;
}

/** One family in a report (file shape, snake_case). */
export interface FamilyReport {
  nonknown: { m: number; agree: number; need: number; wilson90: [number, number] };
  known: { k: number; correct: number; need: number };
  by_category: Partial<Record<CalibCategory, { m: number; agree: number }>>;
  order_consistency: { n: number; consistent: number };
  void_calls: number;
  qualified: boolean;
}

/** `calibration/round0.json` | `requal-<Qnn>.json` | `gate-<Gnn>.json` (schema/calib-report.schema.json). */
export interface CalibReport {
  set: SetId;
  kind: SetKind;
  /** Q / G: the family under test; C00: null. */
  family: Family | null;
  reason: RequalReason | null;
  /** false: v1's first benchmark log entry is not earlier than the first C00 answer, or an answer fails the owner-log checks (qualifies nobody). */
  valid: boolean;
  invalid_reason: string | null;
  /** sha256 of pin.json bytes; null for G sets. */
  pin_sha256: string | null;
  /** Newest R round whose audit.json existed at scoring (posterior epoch boundary for a passed requal); null if none. */
  after_round: string | null;
  families: Partial<Record<Family, FamilyReport>>;
  qualified: Family[];
  canon_rounds_may_start: boolean;
  owner: { retest: { n: number; consistent: number; wilson90: [number, number] }; known: { n: number; correct: number }; median_ms: number | null } | null;
  writer_models: Array<{ model: string; owner_wins: number; owner_n: number; panel_wins: number; panel_n: number }>;
  writer_recommendation: { model: string; basis: string } | null;
  gate_dryrun: Partial<Record<Family, { caught: number; of: number; gate_judge: boolean }>>;
}


const WRITER_CATEGORIES: readonly CalibCategory[] = ['canon_vs_rewrite', 'cross_model'];
const RECOMMEND_BASIS = 'owner_wins, ties → current writers.json default';

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Truth table of one pair for one family (ab / ba null = not judged). */
export function pairOutcome(pair: CalibPairRecord, ownerChosen: string, ab: VerdictRecord | null, ba: VerdictRecord | null): PairOutcome {
  const calls = [ab, ba].filter((v): v is VerdictRecord => v !== null);
  // both orders ok and the same decisive text; null otherwise (a void call is final: non-agreement, m unchanged)
  const settled = ab !== null && ba !== null && ab.status === 'ok' && ba.status === 'ok' && ab.decisive === ba.decisive ? ab.decisive : null;
  return {
    pair: pair.id,
    category: pair.category,
    judged: calls.length > 0,
    consistent: settled !== null,
    agree: settled !== null && settled === ownerChosen,
    knownCorrect: pair.known_better === null ? null : settled !== null && settled === pair.known_better,
    void: calls.filter((c) => c.status === 'void').length,
  };
}

/** round0: agree ≥ qualifyNeed(m, pct) && correct ≥ k − qualifyKnownMaxMiss; requal: agree ≥ nonknownMin && correct ≥ knownMin. */
export function scoreFamily(family: Family, outcomes: readonly PairOutcome[], kind: 'round0' | 'requal', cal: ProtocolCalibration): FamilyScore {
  const judged = outcomes.filter((o) => o.judged);
  const nonknown = judged.filter((o) => o.category !== 'known');
  const known = judged.filter((o) => o.category === 'known');
  const m = nonknown.length;
  const agree = nonknown.filter((o) => o.agree).length;
  const k = known.length;
  const correct = known.filter((o) => o.knownCorrect === true).length;
  const need = kind === 'round0' ? qualifyNeed(m, cal.qualifyNonknownPct) : cal.requal.nonknownMin;
  const knownNeed = kind === 'round0' ? Math.max(0, k - cal.qualifyKnownMaxMiss) : cal.requal.knownMin;
  const byCategory: FamilyScore['byCategory'] = {};
  for (const category of cal.categories) {
    if (category === 'known') continue;
    const in_ = nonknown.filter((o) => o.category === category);
    if (in_.length > 0) byCategory[category] = { m: in_.length, agree: in_.filter((o) => o.agree).length };
  }
  return {
    family,
    nonknown: { m, agree, need, wilson90: wilson(agree, m, cal.intervalZ) },
    known: { k, correct, need: knownNeed },
    byCategory,
    orderConsistency: { n: judged.length, consistent: judged.filter((o) => o.consistent).length },
    voidCalls: judged.reduce((sum, o) => sum + o.void, 0),
    // a family that judged no non-known or no known pair has shown nothing
    qualified: m > 0 && k > 0 && agree >= need && correct >= knownNeed,
  };
}

export function dryrunScore(records: readonly DryrunVerdictRecord[], maxMiss: number): DryrunScore {
  const caught = records.filter((r) => r.caught).length;
  const of = records.length;
  return { caught, of, gateJudge: of > 0 && of - caught <= maxMiss };
}

/** Retest slots (retest_of ≠ null) vs their originals: consistent when the owner chose the same text. */
export function ownerRetest(display: readonly DisplayRecord[], answers: readonly CalibAnswer[], z: number): OwnerRetest {
  const bySlot = new Map(answers.map((a) => [a.slot, a]));
  let n = 0;
  let consistent = 0;
  for (const d of display) {
    if (d.retest_of === null) continue;
    const again = bySlot.get(d.slot);
    const first = bySlot.get(d.retest_of);
    if (again === undefined || first === undefined) continue;
    n += 1;
    if (again.chosen === first.chosen) consistent += 1;
  }
  return { n, consistent, wilson90: wilson(consistent, n, z) };
}

/** Pair id → the owner's first answer (retest slots excluded; the label is the first answer, D6). */
function firstAnswers(display: readonly DisplayRecord[], answers: readonly CalibAnswer[]): Map<string, CalibAnswer> {
  const retest = new Set(display.filter((d) => d.retest_of !== null).map((d) => d.slot));
  const out = new Map<string, CalibAnswer>();
  for (const a of answers) if (!retest.has(a.slot) && !out.has(a.pair)) out.set(a.pair, a);
  return out;
}

/** Rows from canon_vs_rewrite (rewrite model vs 8.1) and cross_model pairs, first answers only. */
export function writerModels(set: CalibSetRecord, answers: readonly CalibAnswer[], verdicts: readonly VerdictRecord[]): WriterModelRow[] {
  const first = firstAnswers(set.display, answers);
  const rows = new Map<string, WriterModelRow>();
  const row = (model: string): WriterModelRow => {
    const was = rows.get(model);
    if (was !== undefined) return was;
    const fresh: WriterModelRow = { model, ownerWins: 0, ownerN: 0, panelWins: 0, panelN: 0 };
    rows.set(model, fresh);
    return fresh;
  };
  for (const pair of set.pairs) {
    if (!WRITER_CATEGORIES.includes(pair.category)) continue;
    // the texts of the pair written by a gateway model (an 8.1 passage has none)
    const contenders = [pair.a, pair.b].flatMap((id) => {
      const model = Object.hasOwn(set.texts, id) ? set.texts[id]?.model : null;
      return model === null || model === undefined ? [] : [{ id, model }];
    });
    const chosen = first.get(pair.id)?.chosen;
    const panel = verdicts.filter((v) => v.pair === pair.id && v.status === 'ok');
    for (const c of contenders) {
      const r = row(c.model);
      if (chosen !== undefined) {
        r.ownerN += 1;
        if (chosen === c.id) r.ownerWins += 1;
      }
      r.panelN += panel.length;
      r.panelWins += panel.filter((v) => v.decisive === c.id).length;
    }
  }
  return [...rows.values()].sort((a, b) => byCodeUnit(a.model, b.model));
}

/** Highest ownerWins / ownerN among rows with ownerN ≥ 2; ties and no data → currentDefault. */
export function recommendWriter(rows: readonly WriterModelRow[], currentDefault: string): string {
  const eligible = rows.filter((r) => r.ownerN >= 2);
  // compare rates by cross-multiplication (exact for integers)
  const better = (a: WriterModelRow, b: WriterModelRow): number => a.ownerWins * b.ownerN - b.ownerWins * a.ownerN;
  const best = eligible.reduce<WriterModelRow | null>((top, r) => (top === null || better(r, top) > 0 ? r : top), null);
  if (best === null) return currentDefault;
  const tied = eligible.filter((r) => better(r, best) === 0);
  return tied.length === 1 ? best.model : currentDefault;
}

/** Forge-root-relative report file: C00 → calibration/round0.json, Qnn → calibration/requal-Qnn.json, Gnn → calibration/gate-Gnn.json. */
export function reportPath(set: SetId): string {
  if (/^C\d{2}$/u.test(set)) return 'calibration/round0.json';
  if (/^Q\d{2}$/u.test(set)) return `calibration/requal-${set}.json`;
  if (/^G\d{2}$/u.test(set)) return `calibration/gate-${set}.json`;
  throw new Error(`reportPath: ${set} is not a calibration set id`);
}

let cachedSchema: Schema | null = null;

/** The engine's copy of schema/calib-report.schema.json (module-relative, so temp forge roots need no schema dir). */
function reportSchema(): Schema {
  if (cachedSchema !== null) return cachedSchema;
  const raw: unknown = JSON.parse(readFileSync(fileURLToPath(new URL('../schema/calib-report.schema.json', import.meta.url)), 'utf8'));
  const schema = loadSchema(raw);
  if (!schema.ok) throw new Error(`schema/calib-report.schema.json: ${schema.error}`);
  cachedSchema = schema.value;
  return schema.value;
}

function interval(value: unknown, key: string): [number, number] | null {
  const list = readArray(value, key);
  const lo = list?.[0];
  const hi = list?.[1];
  return typeof lo === 'number' && typeof hi === 'number' && lo <= hi ? [lo, hi] : null;
}


const CATEGORIES: readonly CalibCategory[] = ['canon_vs_rewrite', 'cross_model', 'stance', 'known'];
const KINDS: readonly SetKind[] = ['round0', 'requal', 'gate'];
const REASONS: readonly RequalReason[] = ['calibration_fail', 'suspension'];

function isCategory(value: string): value is CalibCategory {
  return CATEGORIES.some((c) => c === value);
}

function isKind(value: string | null): value is SetKind {
  return KINDS.some((k) => k === value);
}

function isReason(value: string): value is RequalReason {
  return REASONS.some((r) => r === value);
}

/** Set id letter → kind (C round 0, Q requal, G gate). */
function kindOfSet(set: string): SetKind | null {
  return set.startsWith('C') ? 'round0' : set.startsWith('Q') ? 'requal' : set.startsWith('G') ? 'gate' : null;
}

function nullable(value: unknown, key: string): { ok: true; value: string | null } | { ok: false } {
  if (!isRecord(value) || !Object.hasOwn(value, key)) return { ok: false };
  const v = value[key];
  if (v === null) return { ok: true, value: null };
  return typeof v === 'string' ? { ok: true, value: v } : { ok: false };
}

function narrowFamilyReport(value: unknown): Result<FamilyReport> {
  const nk = readRecord(value, 'nonknown');
  const kn = readRecord(value, 'known');
  const oc = readRecord(value, 'order_consistency');
  const [m, agree, need] = [readNumber(nk, 'm'), readNumber(nk, 'agree'), readNumber(nk, 'need')];
  const [k, correct, knownNeed] = [readNumber(kn, 'k'), readNumber(kn, 'correct'), readNumber(kn, 'need')];
  const [n, consistent] = [readNumber(oc, 'n'), readNumber(oc, 'consistent')];
  const wilson90 = interval(nk, 'wilson90');
  const voidCalls = readNumber(value, 'void_calls');
  const qualified = readBoolean(value, 'qualified');
  if (m === null || agree === null || need === null || k === null || correct === null || knownNeed === null || n === null || consistent === null || wilson90 === null || voidCalls === null || qualified === null) {
    return err('malformed family report');
  }
  if (agree > m || correct > k || consistent > n) return err('a count exceeds its total');
  const byCategory: FamilyReport['by_category'] = {};
  for (const [category, c] of Object.entries(readRecord(value, 'by_category') ?? {})) {
    const cm = readNumber(c, 'm');
    const ca = readNumber(c, 'agree');
    if (!isCategory(category) || cm === null || ca === null || ca > cm) return err(`by_category.${category}: malformed`);
    byCategory[category] = { m: cm, agree: ca };
  }
  return ok({
    nonknown: { m, agree, need, wilson90 }, known: { k, correct, need: knownNeed }, by_category: byCategory,
    order_consistency: { n, consistent }, void_calls: voidCalls, qualified,
  });
}

function narrowOwner(value: unknown): Result<CalibReport['owner']> {
  if (value === null) return ok(null);
  const retest = readRecord(value, 'retest');
  const known = readRecord(value, 'known');
  const [rn, rc, kn, kc] = [readNumber(retest, 'n'), readNumber(retest, 'consistent'), readNumber(known, 'n'), readNumber(known, 'correct')];
  const w = interval(retest, 'wilson90');
  const median = isRecord(value) ? value['median_ms'] : undefined;
  if (rn === null || rc === null || kn === null || kc === null || w === null || (median !== null && typeof median !== 'number')) return err('owner: malformed');
  if (rc > rn || kc > kn) return err('owner: a count exceeds its total');
  return ok({ retest: { n: rn, consistent: rc, wilson90: w }, known: { n: kn, correct: kc }, median_ms: typeof median === 'number' ? median : null });
}

function narrowWriterRows(value: unknown): Result<CalibReport['writer_models']> {
  const out: CalibReport['writer_models'] = [];
  for (const r of readArray(value, 'writer_models') ?? []) {
    const model = readString(r, 'model');
    const [ow, on, pw, pn] = [readNumber(r, 'owner_wins'), readNumber(r, 'owner_n'), readNumber(r, 'panel_wins'), readNumber(r, 'panel_n')];
    if (model === null || ow === null || on === null || pw === null || pn === null || ow > on || pw > pn) return err('writer_models: malformed row');
    out.push({ model, owner_wins: ow, owner_n: on, panel_wins: pw, panel_n: pn });
  }
  return ok(out);
}

function narrowDryrun(value: unknown): Result<CalibReport['gate_dryrun']> {
  const out: CalibReport['gate_dryrun'] = {};
  for (const [family, d] of Object.entries(readRecord(value, 'gate_dryrun') ?? {})) {
    const caught = readNumber(d, 'caught');
    const of = readNumber(d, 'of');
    const gateJudge = readBoolean(d, 'gate_judge');
    if (!isFamily(family) || caught === null || of === null || gateJudge === null || caught > of) return err(`gate_dryrun.${family}: malformed`);
    out[family] = { caught, of, gate_judge: gateJudge };
  }
  return ok(out);
}

/** Shape plus schema/calib-report.schema.json. */
export function parseCalibReport(value: unknown): Result<CalibReport> {
  const errors = validate(reportSchema(), value);
  if (errors.length > 0) return err(errors.join('; '));
  const set = readString(value, 'set');
  const kind = readString(value, 'kind');
  const valid = readBoolean(value, 'valid');
  const mayStart = readBoolean(value, 'canon_rounds_may_start');
  const [family, reason, invalid, pin, after] = ['family', 'reason', 'invalid_reason', 'pin_sha256', 'after_round'].map((key) => nullable(value, key));
  if (set === null || !isKind(kind) || kindOfSet(set) !== kind || valid === null || mayStart === null) return err('malformed report');
  if (family === undefined || !family.ok || reason === undefined || !reason.ok || invalid === undefined || !invalid.ok || pin === undefined || !pin.ok || after === undefined || !after.ok) {
    return err('malformed report');
  }
  const fam = family.value;
  const why = reason.value;
  if ((fam !== null && !isFamily(fam)) || (why !== null && !isReason(why))) return err('family / reason: malformed');
  if (valid !== (invalid.value === null)) return err('invalid_reason is set exactly when the report is invalid');
  const families: CalibReport['families'] = {};
  for (const [name, f] of Object.entries(readRecord(value, 'families') ?? {})) {
    const narrowed = narrowFamilyReport(f);
    if (!isFamily(name)) return err(`families: unknown family ${name}`);
    if (!narrowed.ok) return err(`families.${name}: ${narrowed.error}`);
    families[name] = narrowed.value;
  }
  const qualified = (readArray(value, 'qualified') ?? []).filter((q): q is Family => typeof q === 'string' && isFamily(q));
  const expected = FAMILIES.filter((f) => families[f]?.qualified === true).sort(byCodeUnit);
  if (qualified.join(',') !== expected.join(',')) return err('qualified must list the qualified families in code-unit order');
  if (!valid && qualified.length > 0) return err('an invalid report qualifies nobody');
  if (mayStart !== qualified.length >= MIN_QUALIFIED_FAMILIES) return err(`canon_rounds_may_start must be ≥ ${MIN_QUALIFIED_FAMILIES} qualified families`);
  const owner = narrowOwner(isRecord(value) ? value['owner'] : null);
  if (!owner.ok) return owner;
  const rows = narrowWriterRows(value);
  if (!rows.ok) return rows;
  const rec = readRecord(value, 'writer_recommendation');
  const recModel = readString(rec, 'model');
  const recBasis = readString(rec, 'basis');
  if (rec !== null && (recModel === null || recBasis === null)) return err('writer_recommendation: malformed');
  const dryrun = narrowDryrun(value);
  if (!dryrun.ok) return dryrun;
  return ok({
    set, kind, family: fam, reason: why, valid, invalid_reason: invalid.value, pin_sha256: pin.value, after_round: after.value, families, qualified,
    canon_rounds_may_start: mayStart, owner: owner.value, writer_models: rows.value,
    writer_recommendation: recModel === null || recBasis === null ? null : { model: recModel, basis: recBasis }, gate_dryrun: dryrun.value,
  });
}

function readReportFile(root: string, rel: string): Result<CalibReport> {
  const path = join(root, rel);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return err(`${rel}: ${e instanceof Error ? e.message.split(path).join(rel) : String(e)}`);
  }
  const parsed = parseCalibReport(raw);
  if (!parsed.ok) return err(`${rel}: ${parsed.error}`);
  if (reportPath(parsed.value.set) !== rel) return err(`${rel} holds the report of ${parsed.value.set}`);
  return parsed;
}

/** Every report under calibration/: C00, then Gnn ascending, then Qnn ascending (only the per-kind order is chronological); none → []. */
export function readCalibReports(root: string): Result<CalibReport[]> {
  const dir = join(root, 'calibration');
  if (!existsSync(dir)) return ok([]);
  const names = readdirSync(dir);
  const ordered = [
    ...names.filter((n) => n === 'round0.json'),
    ...names.filter((n) => /^gate-G\d{2}\.json$/u.test(n)).sort(byCodeUnit),
    ...names.filter((n) => /^requal-Q\d{2}\.json$/u.test(n)).sort(byCodeUnit),
  ];
  const out: CalibReport[] = [];
  for (const name of ordered) {
    const r = readReportFile(root, `calibration/${name}`);
    if (!r.ok) return r;
    out.push(r.value);
  }
  return ok(out);
}

/** What c5 reports, or a WAIT (the owner log needs repair before the answers can be read). */
export type ReportBuild = { kind: 'report'; report: CalibReport } | { kind: 'wait'; outcome: StepOutcome };

function familyReport(s: FamilyScore, valid: boolean): FamilyReport {
  return {
    nonknown: { m: s.nonknown.m, agree: s.nonknown.agree, need: s.nonknown.need, wilson90: [round4(s.nonknown.wilson90.lo), round4(s.nonknown.wilson90.hi)] },
    known: { ...s.known },
    by_category: { ...s.byCategory },
    order_consistency: { ...s.orderConsistency },
    void_calls: s.voidCalls,
    qualified: valid && s.qualified,
  };
}

/** Newest R round whose audit.json exists now (the posterior epoch boundary of a passed requal); null if none. */
function afterRound(root: string): string | null {
  const dir = join(root, 'rounds');
  if (!existsSync(dir)) return null;
  const done = readdirSync(dir).filter((n) => /^R\d{2}$/u.test(n) && existsSync(join(dir, n, 'audit.json'))).sort(byCodeUnit);
  return done.at(-1) ?? null;
}

/** C00 validity (epic F1-06): the pinned root version's first log entry precedes the earliest answer. */
function rootOrderProblem(root: string, pin: CalibPin, answers: readonly CalibAnswer[]): string | null {
  const log = readBenchLog(root);
  if (!log.ok) throw new IntegrityError(log.error);
  const entry = log.value.find((e) => e.version === pin.benchmark_version);
  if (entry === undefined) return `benchmark ${pin.benchmark_version} has no benchmark/log.jsonl entry`;
  if (entry.parent !== null) return `benchmark ${pin.benchmark_version} is not a root version`;
  const first = answers.reduce<CalibAnswer | null>((a, b) => (a === null || Date.parse(b.answered_at) < Date.parse(a.answered_at) ? b : a), null);
  if (first !== null && !(Date.parse(entry.at) < Date.parse(first.answered_at))) {
    return `benchmark ${pin.benchmark_version} was first logged at ${entry.at}, not before the first answer (${first.answered_at})`;
  }
  return null;
}

/**
 * The set's answers from ctx.owner.calibAnswers(), with the reason they invalidate the report (null = usable). c4 ran on
 * a complete, reader-valid set, so an unreadable, missing or set-less file is an IntegrityError (as in c3 / c4), never a
 * written report: only answers changed after the pin (still owner-logged) make an invalid report.
 */
function scoredAnswers(ctx: StepContext, pin: CalibPin): { kind: 'answers'; answers: CalibAnswer[]; invalid: string | null } | { kind: 'wait'; outcome: StepOutcome } {
  const read = ctx.owner.calibAnswers();
  if (read.state === 'repair') return { kind: 'wait', outcome: { kind: 'wait', waitingFor: 'owner_log_repair', detail: read.detail, inputs: [], outputs: [] } };
  if (read.state === 'invalid') throw new IntegrityError(read.error);
  if (read.state !== 'ok') throw new IntegrityError(`${OWNER_ANSWERS} is ${read.state}`);
  const set = Object.hasOwn(read.value.sets, ctx.roundId) ? read.value.sets[ctx.roundId] : undefined;
  if (set === undefined) throw new IntegrityError(`${OWNER_ANSWERS} has no answers for ${ctx.roundId}`);
  const changed = sha256(canonicalJson(set)) !== pin.answers_sha256;
  return { kind: 'answers', answers: set.answers, invalid: changed ? `${OWNER_ANSWERS} ${ctx.roundId} changed after c4-judge pinned it` : null };
}

function ownerBlock(record: CalibSetRecord, answers: readonly CalibAnswer[], z: number): CalibReport['owner'] {
  if (answers.length === 0) return null;
  const retest = ownerRetest(record.display, answers, z);
  const first = firstAnswers(record.display, answers);
  const known = record.pairs.filter((p) => p.known_better !== null && first.has(p.id));
  const ms = answers.flatMap((a) => (a.ms === null ? [] : [a.ms])).sort((a, b) => a - b);
  const mid = Math.floor(ms.length / 2);
  const median = ms.length === 0 ? null : ms.length % 2 === 1 ? (ms[mid] ?? null) : Math.round(((ms[mid - 1] ?? 0) + (ms[mid] ?? 0)) / 2);
  return {
    retest: { n: retest.n, consistent: retest.consistent, wilson90: [round4(retest.wilson90.lo), round4(retest.wilson90.hi)] },
    known: { n: known.length, correct: known.filter((p) => first.get(p.id)?.chosen === p.known_better).length },
    median_ms: median,
  };
}

function dryrunByFamily(records: readonly DryrunVerdictRecord[], maxMiss: number): CalibReport['gate_dryrun'] {
  const out: CalibReport['gate_dryrun'] = {};
  for (const family of [...new Set(records.map((r) => r.family))].sort(byCodeUnit)) {
    const s = dryrunScore(records.filter((r) => r.family === family), maxMiss);
    out[family] = { caught: s.caught, of: s.of, gate_judge: s.gateJudge };
  }
  return out;
}

function required<T>(r: Result<T>): T {
  if (!r.ok) throw new IntegrityError(r.error);
  return r.value;
}

/**
 * Every dry-run verdict of a pinned set came from the judge pin.json pins for its family (same id and model), so
 * gate_judge never rests on another judge or model than the set's taste verdicts (c2 runs before c4 writes the pin).
 */
function checkDryrunPinned(ctx: StepContext, records: readonly DryrunVerdictRecord[], pin: CalibPin): void {
  for (const r of records) {
    const file = ctx.files.rel(dryrunPath(ctx.paths, r.family, r.id));
    const j = pin.judges[r.family];
    if (j === undefined) throw new IntegrityError(`${file}: no ${r.family} judge is pinned in calibration/${pin.set}/${PIN_FILE}`);
    if (j.id !== r.judge || j.model !== r.model) throw new IntegrityError(`${file}: judge ${r.judge}/${r.model} is not the pinned ${r.family} judge ${j.id}/${j.model}`);
  }
}

/**
 * The set's report from pairs.json, pin.json, the verdict and dry-run files and the owner answers. Every verdict the
 * pinned judges owe (jobsFor) must exist; owner answers the reader rejects are an IntegrityError; an invalid report
 * (root-version order, answers changed after the pin) keeps its numbers but qualifies nobody.
 */
export function calibReport(ctx: StepContext): ReportBuild {
  const set = ctx.roundId;
  const record = required(readCalibSet(ctx.root, set));
  const cal = ctx.protocol.calibration;
  const dryrun = required(readDryrunVerdicts(ctx.paths));
  const gateDryrun = dryrunByFamily(dryrun, cal.gateDryrunMaxMiss);
  const base = { set, kind: record.kind, family: record.family, reason: record.reason, after_round: afterRound(ctx.root) };
  if (record.kind === 'gate') {
    // G sets have no pin (c4 skips): c2's rerun check binds each file to the current backend's judge and model
    const report: CalibReport = {
      ...base, valid: true, invalid_reason: null, pin_sha256: null, families: {}, qualified: [], canon_rounds_may_start: false,
      owner: null, writer_models: [], writer_recommendation: null, gate_dryrun: gateDryrun,
    };
    return { kind: 'report', report };
  }
  const pinned = readPin(ctx.paths);
  if (pinned === null) throw new IntegrityError(`calibration/${set}/${PIN_FILE} is missing: c4-judge has not run`);
  const pin = required(pinned);
  checkDryrunPinned(ctx, dryrun, pin);
  const read = scoredAnswers(ctx, pin);
  if (read.kind === 'wait') return read;
  const { answers } = read;
  const invalid = read.invalid ?? (record.kind === 'round0' ? rootOrderProblem(ctx.root, pin, answers) : null);
  const valid = invalid === null;
  const verdicts = required(readVerdicts(ctx.paths));
  const byKey = new Map(verdicts.map((v) => [`${v.family}|${v.pair}|${v.order}`, v]));
  const judges = FAMILIES.flatMap((family) => {
    const j = pin.judges[family];
    return j === undefined ? [] : [{ id: j.id, family }];
  });
  for (const job of jobsFor(set, record, judges)) {
    if (!byKey.has(`${job.family}|${job.pair}|${job.order}`)) throw new IntegrityError(`calibration/${set}: verdict ${job.family} ${job.pair}-${job.order} is missing`);
  }
  const first = firstAnswers(record.display, answers);
  const families: CalibReport['families'] = {};
  for (const { family } of judges) {
    if (record.kind === 'requal' && family !== record.family) continue;
    const outcomes = record.pairs
      .filter((p) => !p.authors.includes(family))
      .map((p) => pairOutcome(p, first.get(p.id)?.chosen ?? '', byKey.get(`${family}|${p.id}|ab`) ?? null, byKey.get(`${family}|${p.id}|ba`) ?? null));
    families[family] = familyReport(scoreFamily(family, outcomes, record.kind, cal), valid);
  }
  const qualified = FAMILIES.filter((f) => families[f]?.qualified === true).sort(byCodeUnit);
  const rows = record.kind === 'round0' ? writerModels(record, answers, verdicts) : [];
  const writerDefault = ctx.config.slots[0]?.model ?? ctx.config.baseline.model;
  const report: CalibReport = {
    ...base,
    valid,
    invalid_reason: invalid,
    pin_sha256: sha256Bytes(readFileSync(join(ctx.paths.dir, PIN_FILE))),
    families,
    qualified,
    canon_rounds_may_start: qualified.length >= MIN_QUALIFIED_FAMILIES,
    owner: ownerBlock(record, answers, cal.intervalZ),
    writer_models: rows.map((r) => ({ model: r.model, owner_wins: r.ownerWins, owner_n: r.ownerN, panel_wins: r.panelWins, panel_n: r.panelN })),
    writer_recommendation: record.kind === 'round0' ? { model: recommendWriter(rows, writerDefault), basis: RECOMMEND_BASIS } : null,
    gate_dryrun: record.kind === 'round0' ? gateDryrun : {},
  };
  return { kind: 'report', report };
}

/** Forge-root-relative per-set files the report was computed from (pin, verdicts, dry-run verdicts). */
function reportInputs(ctx: StepContext): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.endsWith('.json')) out.push(ctx.files.rel(join(dir, e.name)));
    }
  };
  if (existsSync(join(ctx.paths.dir, PIN_FILE))) out.push(ctx.files.rel(join(ctx.paths.dir, PIN_FILE)));
  walk(ctx.paths.taste);
  walk(join(ctx.paths.dir, 'dryrun'));
  return out.sort(byCodeUnit);
}

/** c5: report (written once, reused on rerun), then rebuildTrust(ctx, set). */
export const scoreStep: StepDef = {
  id: 'c5-score',
  run: async (ctx) => {
    const rel = reportPath(ctx.roundId);
    const path = join(ctx.root, rel);
    let report: CalibReport;
    if (existsSync(path)) {
      report = required(readReportFile(ctx.root, rel));
    } else {
      const built = calibReport(ctx);
      if (built.kind === 'wait') return built.outcome;
      report = built.report;
      ctx.files.writeJson(path, report);
    }
    const trust = rebuildTrust(ctx, ctx.roundId);
    if (!trust.ok) throw new IntegrityError(`trust: ${trust.error}`);
    if (trust.value.kind === 'wait') return { kind: 'wait', waitingFor: trust.value.waitingFor, detail: trust.value.detail, inputs: [], outputs: [] };
    const verdict = report.valid ? `qualified ${report.qualified.join(', ') || 'none'}` : `invalid: ${report.invalid_reason ?? ''}`;
    ctx.progress('c5-score', 'info', `${rel}: ${verdict}`);
    return { kind: 'done', inputs: reportInputs(ctx), outputs: [rel], external: [PAIRS_FILE, OWNER_ANSWERS, OWNER_LOG, LABELS_FILE, TRUST_STATUS] };
  },
};
