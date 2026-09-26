import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { roundNumber } from './bench-check.ts';
import { BENCH_LOG, readBenchLog, VERSION_ID, type BenchLogEntry, type VersionRef } from './bench-log.ts';
import { EVIDENCE_DIR, evidencePath } from './bench-log.ts';

export { EVIDENCE_DIR, evidencePath };
import { changedKeys } from './bench-validate.ts';
import { calibPaths } from './calib-build.ts';
import { CALIB_ORDERS, parsePin, parseVerdictRecord, PIN_FILE, verdictPath } from './calib-run.ts';
import { posterior, round4 } from './calib-stats.ts';
import { isFamily, type Family } from './config.ts';
import { round10 } from './cost.ts';
import type { StepContext } from './context.ts';
import { checkQuotes } from './evidence.ts';
import { isRecord, readArray, readBoolean, readNumber, readRecord, readString, type JsonRecord } from './json.ts';
import { sha256Bytes, type OwnerInputs } from './owner-inputs.ts';
import { pairDir, pairVerdicts, pairsFilePath, readPairsFile, sessionVoid, type FamilySessions } from './pairs.ts';
import { err, ok, type Result } from './result.ts';
import { loadSchema, type Schema, schemaFile, validate } from './schema.ts';
import { roundPaths, sha256 } from './store.ts';
import { displayText } from './submission.ts';
import { IntegrityError } from './task.ts';
import { isRoundTally, sortedRecord } from './tally.ts';
import { parseAuditSet, type AuditSetFile } from './steps/owner-waits.ts';
import { LABELS_FILE, parseLabelLedger, type Label, type LabelLedger, type LabelText, type Trial } from './trust.ts';
import { parseTrustStatus, TRUST_STATUS, type TrustStatus } from './trust-status.ts';
import { parseWriterOutput } from './writer-output.ts';

/*
 * Evidence packet of one benchmark cycle (plan §6 step 1, s3 §1.5): `benchmark/evidence/RNN.json`, built by 11f from
 * the round's records (R00: the C00 labels and trust status only). buildEvidence is pure and byte-deterministic;
 * collectEvidence does the IO and hashes every input but the append-only logs. Reserve labels contribute counts only:
 * their texts and pair ids never reach the packet (the maintainer must not see replay material): reserve texts are never
 * read, and the files whose names carry pair ids (taste call files, call records) are hashed into per-directory
 * aggregates (foldedInputs), never listed by path.
 */

/** Forge-root-relative directory of the packets (a packet is a verified output: no later round rewrites it). */
/** Cap per shown text (the submission cap). */
export const EVIDENCE_TEXT_MAX = 2500;
/** Cap per judge quote. */
export const EVIDENCE_QUOTE_MAX = 200;
/** At most this many disagreement items (newest first). */
export const EVIDENCE_DISAGREEMENTS_MAX = 12;
/** Saturation ceiling: top / n at or above this share in both of the last two rounds. */
export const CEILING_SHARE = 0.7;
/** Prefix of a judge quote that is not a verbatim substring of the shown text (evidence.ts checkQuotes). */
export const UNVERIFIED_QUOTE_PREFIX = '［未逐字命中］';
/** Evidence id pattern (schema/benchmark.schema.json reasons[].evidence_ids). */
export const EVIDENCE_ID = /^E-[A-Za-z0-9-]+$/u;

/** Measures a saturation item can name (taste = the champion pairs; the rest are taste.ts MeasureKey). */
export type EvidenceMeasure = 'taste' | 'hook' | 'skin_swap' | 'cold_reader' | 'surprise';

/** An anonymized visible text; never author identity. */
export interface EvidenceText {
  text_id: string;
  text: string;
}

/** One family's order-consistent choice on a visible label (0 = texts[0]), with its quotes. */
export interface PanelView {
  family: Family;
  choice: 0 | 1 | 'inconsistent';
  quotes: string[];
}

/** One point of a saturation series: `top` of `n` hit the measure's ceiling event in `round`. */
export interface SaturationPoint {
  round: string;
  n: number;
  top: number;
}

/** One packet item; ids are `E-<round>-<CODE>[-<subject>]` (evidenceId). */
export type EvidenceItem = { id: string } & (
  | { kind: 'agreement'; family: Family; n: number; agree: number; mean: number; ci90: [number, number]; state: 'ok' | 'flagged' | 'suspended' }
  | { kind: 'order_consistency'; family: Family; calls: number; consistent: number }
  | { kind: 'void_decoy'; family: Family; session_pairs: number; void: number; decoy_fail: number }
  | { kind: 'family_matrix'; families: Family[]; agree: number[][]; n: number[][] }
  | { kind: 'saturation'; measure: EvidenceMeasure; rounds: SaturationPoint[]; ceiling: boolean }
  | { kind: 'reason_codes'; counts: Record<string, number>; rounds: number }
  | { kind: 'disagreement'; label: string; texts: [EvidenceText, EvidenceText]; owner: 0 | 1; panel: PanelView[] }
  | { kind: 'stagnation'; row_id: string; rounds_without_beat: number; champion_kind: 'baseline' | 'owner_pick' | 'golden'; flagged: boolean }
  | { kind: 'defect_catch'; family: Family; injected: number; caught: number }
  | { kind: 'cost'; family: Family; calls: number; usd: number; p50_ms: number; p90_ms: number }
  | { kind: 'rollback'; at: string; version: string; from: string; keys: string[] }
  | { kind: 'pending'; version: string; since: string; activation: 'owner' }
  | { kind: 'reserve_count'; visible: number; reserve: number }
);

/** `benchmark/evidence/RNN.json` (schema/evidence.schema.json); bytes = JSON.stringify(packet, null, 2) + LF. */
export interface EvidencePacket {
  round: string;
  /** The version the round ran under (freeze.json; R00: the C00 pin). */
  benchmark_version: string;
  /** Parent for the proposal (activeBenchmark 'head' at 11f). */
  head_version: string;
  /** Forge-root-relative path → SHA-256 of every file read; files below a round sub-directory as one `rounds/RNN/<dir>/*` key (foldedInputs). */
  inputs: Record<string, string>;
  /** Sorted by id (code-unit order). */
  items: EvidenceItem[];
  /** Ids of saturation items with ceiling: true. */
  ceilings: string[];
}

/** Defect copies one family judged this round and how many it caught (gate records). */
export interface DefectCount {
  family: Family;
  injected: number;
  caught: number;
}

/** Paid calls of one family this round (cost.json + call records). */
export interface CostRow {
  family: Family;
  calls: number;
  usd: number;
  p50_ms: number;
  p90_ms: number;
}

/** Consecutive rounds on a row without a beaten champion (each round's brief.json row + tally.json). */
export interface StagnationRow {
  row_id: string;
  rounds_without_beat: number;
  champion_kind: 'baseline' | 'owner_pick' | 'golden';
}

/** An owner rollback as the packet shows it; `keys` = maintainer keys that differ between `from` and `version`. */
export interface RollbackView {
  at: string;
  version: string;
  from: string;
  keys: string[];
}

/** An unapproved, unsuperseded pending_owner version (pendingVersions). */
export interface PendingVersion {
  version: string;
  since: string;
}

/** Everything buildEvidence reads; collectEvidence fills it (R00: sessions {}, empty series, no reasons / defects / costs). */
/** One judge's quoted sentence on a visible label: `source` = the text id its pick names (picks[q] of the call). */
export interface EvidenceQuote {
  family: Family;
  source: string;
  quote: string;
}

export interface EvidenceInputs {
  round: string;
  benchmarkVersion: string;
  head: VersionRef;
  ledger: LabelLedger;
  /** LabelText.sha256 → text, filled for visible labels only (reserve texts are never read). */
  visibleTexts: Readonly<Record<string, string>>;
  status: TrustStatus;
  /** This round's champion pairs (pairs.ts pairVerdicts), keyed by pair id. */
  sessions: Readonly<Record<string, readonly FamilySessions[]>>;
  /** Visible label id → the judges' quotes on it (C00 verdicts / audit taste calls); reserve labels have none. */
  quotes: Readonly<Record<string, readonly EvidenceQuote[]>>;
  saturation: Readonly<Record<EvidenceMeasure, readonly SaturationPoint[]>>;
  /** Decision reason codes of this and earlier rounds (decision reason only). */
  reasons: ReadonlyArray<{ round: string; reason: string }>;
  defects: readonly DefectCount[];
  costs: readonly CostRow[];
  stagnation: readonly StagnationRow[];
  rollbacks: readonly RollbackView[];
  pending: readonly PendingVersion[];
  /** packet.inputs as is (collectEvidence: foldedInputs of the files read). */
  inputs: Record<string, string>;
  /** Every file read, path → SHA-256, unfolded (the 11f marker lists these; never serialised into the packet). */
  files: Record<string, string>;
}


/** Saturation measures in the order the packet builds them (ids sort them anyway). */
const MEASURES: readonly EvidenceMeasure[] = ['taste', 'hook', 'skin_swap', 'cold_reader', 'surprise'];

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** At most `max` code points (the schema counts code points too). */
function cap(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : points.slice(0, max).join('');
}


/** `E-<round>-<code>[-<subject>]` (`_` in a subject → `-`); throws RangeError outside EVIDENCE_ID. */
export function evidenceId(round: string, code: string, subject?: string): string {
  if (subject === '') throw new RangeError(`evidence id ${round}-${code}: empty subject`);
  const id = `E-${round}-${code}${subject === undefined ? '' : `-${subject.replaceAll('_', '-')}`}`;
  if (!EVIDENCE_ID.test(id)) throw new RangeError(`evidence id ${id} is outside ${EVIDENCE_ID.source}`);
  return id;
}

/** `STAG-<first 8 hex of sha256(row_id)>`: row ids hold Chinese, ids stay ASCII. */
function stagnationId(round: string, rowId: string): string {
  return evidenceId(round, 'STAG', sha256(rowId).slice(0, 8));
}

/** A point is at the ceiling when its measure ran (n > 0) and top / n ≥ CEILING_SHARE (0.69 is not; correctly rounded 7/10 is 0.7). */
function atCeiling(p: SaturationPoint): boolean {
  return p.n > 0 && p.top / p.n >= CEILING_SHARE;
}

/** The rounds a saturation item may show: the one before `round` (none before R01 or outside R01–R99), then `round`. */
function saturationWindow(round: string): string[] {
  const k = roundNumber(round);
  return !k.ok || k.value < 2 ? [round] : [`R${String(k.value - 1).padStart(2, '0')}`, round];
}

/** Ceiling = a point in each of the two window rounds, in order, both at the ceiling (PROTOCOL §6: 连续 2 轮). */
function windowCeiling(round: string, points: readonly SaturationPoint[]): boolean {
  const window = saturationWindow(round);
  return window.length === 2 && points.length === 2 && points.every((p, i) => p.round === window[i] && atCeiling(p));
}

/**
 * The saturation item of one measure: its points in this round and the one before (a measure that did not run in a
 * round has no point there, so a retired measure or a gap of one round is never a ceiling).
 */
export function saturation(round: string, measure: EvidenceMeasure, points: readonly SaturationPoint[]): EvidenceItem {
  const window = saturationWindow(round);
  const last = points.filter((p) => window.includes(p.round)).slice(-2).map((p) => ({ round: p.round, n: p.n, top: p.top }));
  return { id: evidenceId(round, 'SAT', measure), kind: 'saturation', measure, rounds: last, ceiling: windowCeiling(round, last) };
}

/** Ids of the packet's saturation items with ceiling true, sorted. */
export function ceilingIds(packet: EvidencePacket): string[] {
  return packet.items.filter((i) => i.kind === 'saturation' && i.ceiling).map((i) => i.id).sort(byCodeUnit);
}

type Choice = 0 | 1 | 'inconsistent';

/** Index of the owner's text in a two-text label; null for any other shape. */
function ownerIndex(l: Label): 0 | 1 | null {
  if (l.texts.length !== 2) return null;
  return l.texts[0]?.id === l.owner_chosen ? 0 : l.texts[1]?.id === l.owner_chosen ? 1 : null;
}

/** A family's order-consistent choice on a two-text label (a void session makes the trial inconsistent). */
function choiceOf(trial: Trial, owner: 0 | 1): Choice {
  if (!trial.consistent) return 'inconsistent';
  return trial.agree ? owner : owner === 0 ? 1 : 0;
}

/** Two trials on one label made the same order-consistent choice. */
function sameChoice(a: Trial, b: Trial): boolean {
  return a.consistent && b.consistent && a.agree === b.agree;
}

/** Blind labels (split visible or reserve); requal labels (split none) never feed evidence. */
function blindLabels(ledger: LabelLedger): Label[] {
  return ledger.labels.filter((l) => l.split !== 'none');
}

/** Round order of a label: C00 / Q sets before every R round (R01 = 1). */
function labelRound(l: Label): number {
  const m = /^R(\d{2})$/u.exec(l.round)?.[1];
  return m === undefined ? -1 : Number(m);
}

/**
 * AGR per trust-status family: n / agree over every blind label the family judged (reserve labels count, their texts
 * are never read); mean and ci90 of the Beta(1,1) posterior over those counts; state = the trust status (the official
 * state, audit labels after the epoch).
 */
function agreementItems(round: string, ledger: LabelLedger, status: TrustStatus, families: readonly Family[]): EvidenceItem[] {
  const blind = blindLabels(ledger);
  return families.map((family) => {
    const own = blind.flatMap((l) => l.trials[family] ?? []);
    const agree = own.filter((t) => t.agree).length;
    // the threshold only feeds pBelow, which the packet does not show
    const p = posterior(agree, own.length, 0.5);
    const state = status.families[family]?.agreement.state ?? 'ok';
    return { id: evidenceId(round, 'AGR', family), kind: 'agreement', family, n: own.length, agree, mean: round4(p.mean), ci90: [round4(p.ci90.lo), round4(p.ci90.hi)], state };
  });
}

/** IFA: per family pair, blind labels both judged (n) and those where both made the same order-consistent choice. */
function familyMatrix(round: string, ledger: LabelLedger, families: readonly Family[]): EvidenceItem {
  const blind = blindLabels(ledger);
  const both = (x: Family, y: Family): Array<[Trial, Trial]> => blind.flatMap((l): Array<[Trial, Trial]> => {
    const a = l.trials[x];
    const b = l.trials[y];
    return a === undefined || b === undefined ? [] : [[a, b]];
  });
  return {
    id: evidenceId(round, 'IFA'), kind: 'family_matrix', families: [...families],
    agree: families.map((x) => families.map((y) => both(x, y).filter(([a, b]) => sameChoice(a, b)).length)),
    n: families.map((x) => families.map((y) => both(x, y).length)),
  };
}

/** ORD and VOID per family over this round's champion-pair sessions (shadow sessions included). */
function sessionItems(round: string, sessions: Readonly<Record<string, readonly FamilySessions[]>>): EvidenceItem[] {
  const per = new Map<Family, { pairs: number; void: number; decoy: number; calls: number; consistent: number }>();
  for (const pairId of Object.keys(sessions).sort(byCodeUnit)) {
    for (const fs of sessions[pairId] ?? []) {
      const c = per.get(fs.family) ?? { pairs: 0, void: 0, decoy: 0, calls: 0, consistent: 0 };
      for (const [fwd, rev] of fs.sessions) {
        c.pairs += 1;
        if (fwd.preferredDecoy || rev.preferredDecoy) c.decoy += 1;
        if (sessionVoid(fwd, rev)) c.void += 1;
        else {
          c.calls += 1;
          if (fwd.decisive === rev.decisive) c.consistent += 1;
        }
      }
      per.set(fs.family, c);
    }
  }
  return [...per.entries()].sort((x, y) => byCodeUnit(x[0], y[0])).flatMap(([family, c]): EvidenceItem[] => [
    { id: evidenceId(round, 'ORD', family), kind: 'order_consistency', family, calls: c.calls, consistent: c.consistent },
    { id: evidenceId(round, 'VOID', family), kind: 'void_decoy', family, session_pairs: c.pairs, void: c.void, decoy_fail: c.decoy },
  ]);
}

/** The text of a visible label (collectEvidence filled it); a missing one is a caller bug, not an input state. */
function shownText(input: EvidenceInputs, l: Label, t: LabelText): string {
  const text = Object.hasOwn(input.visibleTexts, t.sha256) ? input.visibleTexts[t.sha256] : undefined;
  if (text === undefined) throw new Error(`buildEvidence: visible label ${l.id} text ${t.id} has no entry in visibleTexts`);
  return text;
}

/**
 * One family's quotes on a label: each checked verbatim against the label's full texts (evidence.ts checkQuotes, keyed
 * by text id); a failing quote is kept with UNVERIFIED_QUOTE_PREFIX; capped at EVIDENCE_QUOTE_MAX, duplicates collapse.
 */
function panelQuotes(quotes: readonly EvidenceQuote[], family: Family, sources: Record<string, string>, where: string): string[] {
  const out: string[] = [];
  for (const q of quotes) {
    if (q.family !== family) continue;
    const verified = checkQuotes([{ source: q.source, quote: q.quote }], sources, where).length === 0;
    const shown = cap(verified ? q.quote : `${UNVERIFIED_QUOTE_PREFIX}${q.quote}`, EVIDENCE_QUOTE_MAX);
    if (!out.includes(shown)) out.push(shown);
  }
  return out;
}

/** DIS: visible labels where some family's order-consistent choice differs from the owner or is inconsistent; newest first, ≤ 12. */
function disagreementItems(input: EvidenceInputs): EvidenceItem[] {
  const found: Array<{ label: Label; owner: 0 | 1; panel: Array<[Family, Choice]> }> = [];
  for (const label of input.ledger.labels) {
    const owner = ownerIndex(label);
    if (label.split !== 'visible' || owner === null) continue;
    const panel = Object.entries(label.trials).flatMap(([f, t]): Array<[Family, Choice]> => (isFamily(f) && t !== undefined ? [[f, choiceOf(t, owner)]] : []));
    if (panel.some(([, c]) => c !== owner)) found.push({ label, owner, panel: panel.sort((x, y) => byCodeUnit(x[0], y[0])) });
  }
  found.sort((x, y) => labelRound(y.label) - labelRound(x.label) || y.label.seq - x.label.seq || byCodeUnit(x.label.id, y.label.id));
  return found.slice(0, EVIDENCE_DISAGREEMENTS_MAX).flatMap(({ label, owner, panel }): EvidenceItem[] => {
    const [a, b] = label.texts;
    if (a === undefined || b === undefined) return [];
    const full: [string, string] = [shownText(input, label, a), shownText(input, label, b)];
    const sources: Record<string, string> = { [a.id]: full[0], [b.id]: full[1] };
    const quotes = Object.hasOwn(input.quotes, label.id) ? (input.quotes[label.id] ?? []) : [];
    return [{
      id: evidenceId(input.round, 'DIS', label.id), kind: 'disagreement', label: label.id,
      texts: [{ text_id: a.id, text: cap(full[0], EVIDENCE_TEXT_MAX) }, { text_id: b.id, text: cap(full[1], EVIDENCE_TEXT_MAX) }],
      owner, panel: panel.map(([family, choice]) => ({ family, choice, quotes: panelQuotes(quotes, family, sources, label.id) })),
    }];
  });
}

/** RC: decision reason codes counted over the rounds given (keys code-unit sorted). */
function reasonItem(round: string, reasons: EvidenceInputs['reasons']): EvidenceItem[] {
  if (reasons.length === 0) return [];
  const counts: Record<string, number> = {};
  for (const r of reasons) counts[r.reason] = (counts[r.reason] ?? 0) + 1;
  return [{ id: evidenceId(round, 'RC'), kind: 'reason_codes', counts: sortedRecord(counts), rounds: new Set(reasons.map((r) => r.round)).size }];
}

/** Pure, deterministic: same inputs → byte-identical packet. */
export function buildEvidence(input: EvidenceInputs): EvidencePacket {
  const { round } = input;
  const families = Object.keys(input.status.families).filter(isFamily).sort(byCodeUnit);
  const visible = input.ledger.labels.filter((l) => l.split === 'visible').length;
  const reserve = input.ledger.labels.filter((l) => l.split === 'reserve').length;
  const items: EvidenceItem[] = [
    ...agreementItems(round, input.ledger, input.status, families),
    ...(families.length > 0 ? [familyMatrix(round, input.ledger, families)] : []),
    { id: evidenceId(round, 'RES'), kind: 'reserve_count', visible, reserve },
    ...sessionItems(round, input.sessions),
    ...MEASURES.map((m) => saturation(round, m, input.saturation[m])),
    ...reasonItem(round, input.reasons),
    ...disagreementItems(input),
    ...input.stagnation.map((s): EvidenceItem => ({
      id: stagnationId(round, s.row_id), kind: 'stagnation', row_id: s.row_id, rounds_without_beat: s.rounds_without_beat, champion_kind: s.champion_kind, flagged: s.rounds_without_beat >= 2,
    })),
    ...input.defects.map((d): EvidenceItem => ({ id: evidenceId(round, 'DEF', d.family), kind: 'defect_catch', family: d.family, injected: d.injected, caught: d.caught })),
    ...input.costs.map((c): EvidenceItem => ({ id: evidenceId(round, 'COST', c.family), kind: 'cost', family: c.family, calls: c.calls, usd: c.usd, p50_ms: c.p50_ms, p90_ms: c.p90_ms })),
    ...input.rollbacks.map((r, i): EvidenceItem => ({ id: evidenceId(round, 'RB', String(i + 1)), kind: 'rollback', at: r.at, version: r.version, from: r.from, keys: [...r.keys] })),
    ...input.pending.map((p): EvidenceItem => ({ id: evidenceId(round, 'PEND', p.version), kind: 'pending', version: p.version, since: p.since, activation: 'owner' })),
  ];
  items.sort((x, y) => byCodeUnit(x.id, y.id));
  const packet: EvidencePacket = { round, benchmark_version: input.benchmarkVersion, head_version: input.head.version, inputs: sortedRecord(input.inputs), items, ceilings: [] };
  packet.ceilings = ceilingIds(packet);
  return packet;
}

/** Unapproved pending_owner versions not superseded by a later logged version or a later rollback (log order). */
export function pendingVersions(log: readonly BenchLogEntry[], owner: OwnerInputs): PendingVersion[] {
  const rollbacks = owner.rollbacks().map((r) => Date.parse(r.at));
  const out: PendingVersion[] = [];
  for (const [i, e] of log.entries()) {
    if (e.outcome !== 'pending_owner' || e.version === null || e.sha256 === null) continue;
    if (owner.benchApproved(e.version, e.sha256) !== null) continue;
    const later = log.slice(i + 1).some((x) => x.outcome === 'activate' || x.outcome === 'pending_owner');
    const at = Date.parse(e.at);
    if (later || rollbacks.some((r) => r > at)) continue;
    out.push({ version: e.version, since: e.at });
  }
  return out;
}

/** File access for collectEvidence: every byte read is hashed into `hashes` (forge-root-relative keys); the logs bypass it. */
interface InputReader {
  root: string;
  /** null when absent. */
  bytes(rel: string): Buffer | null;
  /** null when absent; err when not JSON. */
  json(rel: string): Result<unknown> | null;
  rel(abs: string): string;
  hashes: Record<string, string>;
}

function inputReader(root: string): InputReader {
  const hashes: Record<string, string> = {};
  const bytes = (rel: string): Buffer | null => {
    const path = join(root, rel);
    if (!existsSync(path)) return null;
    const b = readFileSync(path);
    hashes[rel] = sha256Bytes(b);
    return b;
  };
  return {
    root, hashes, bytes,
    json(rel) {
      const b = bytes(rel);
      if (b === null) return null;
      try {
        const value: unknown = JSON.parse(b.toString('utf8'));
        return ok(value);
      } catch (e) {
        return err(`${rel} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    rel: (abs) => relative(root, abs).split(sep).join('/'),
  };
}

/** A required JSON input parsed by `parse`; err names the file. */
function requiredJson<T>(r: InputReader, rel: string, parse: (v: unknown) => Result<T>): Result<T> {
  const raw = r.json(rel);
  if (raw === null) return err(`${rel} is missing`);
  if (!raw.ok) return raw;
  const parsed = parse(raw.value);
  return parsed.ok ? parsed : err(`${rel}: ${parsed.error}`);
}

/** JSON files of a directory (forge-root-relative, code-unit sorted); [] when absent. */
function jsonFiles(r: InputReader, relDir: string): string[] {
  const dir = join(r.root, relDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.json')).sort(byCodeUnit).map((n) => `${relDir}/${n}`);
}

/**
 * The display text of one visible label's text, checked against the label's hash: a calibration `.md` as stored, a
 * round champion snapshot's `text`, or a submission's display text (submission.ts displayText of the writer output).
 */
function labelText(r: InputReader, t: LabelText): Result<string> {
  const raw = r.bytes(t.path);
  if (raw === null) return err(`${t.path} is missing`);
  let text: string | null = null;
  if (t.path.endsWith('.md')) text = raw.toString('utf8');
  else {
    let value: unknown;
    try {
      value = JSON.parse(raw.toString('utf8'));
    } catch {
      return err(`${t.path} is not valid JSON`);
    }
    if (t.path.endsWith('/champion.json')) text = readString(value, 'text');
    else {
      const out = readBoolean(value, 'ok') === true ? parseWriterOutput(readString(value, 'text') ?? '') : null;
      text = out !== null && out.ok ? displayText(out.value) : null;
    }
  }
  if (text === null) return err(`${t.path} holds no display text`);
  return sha256(text) === t.sha256 ? ok(text) : err(`${t.path} does not match the hash labels.json records for ${t.id}`);
}

/** Quotes of one call (question id order), each naming the text its pick for that question chose. */
function callQuotes(family: Family, picks: Readonly<Record<string, string>>, quotes: Readonly<Record<string, string>>): EvidenceQuote[] {
  return Object.keys(quotes).sort(byCodeUnit).flatMap((q) => {
    const quote = quotes[q];
    return quote === undefined ? [] : [{ family, source: picks[q] ?? '', quote }];
  });
}

/** A JSON object of strings; null when any value is not one. */
function stringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') return null;
    out[k] = v;
  }
  return out;
}

/**
 * Judge quotes on one visible label: a C00 label's ab / ba verdicts, an audit label's taste call files of the judged
 * pair its audit-set entry names. Only visible labels are ever passed here.
 */
function labelQuotes(r: InputReader, label: Label): Result<EvidenceQuote[]> {
  const out: EvidenceQuote[] = [];
  if (label.source === 'round0') {
    const paths = calibPaths(r.root, label.round);
    for (const family of Object.keys(label.trials).filter(isFamily).sort(byCodeUnit)) {
      for (const order of CALIB_ORDERS) {
        const rel = r.rel(verdictPath(paths, family, label.id, order));
        const raw = r.json(rel);
        if (raw === null) continue;
        const v = raw.ok ? parseVerdictRecord(raw.value) : raw;
        if (!v.ok) return err(`${rel}: ${v.error}`);
        if (v.value.status === 'ok') out.push(...callQuotes(family, v.value.picks, v.value.quotes));
      }
    }
    return ok(out);
  }
  if (label.source !== 'audit') return ok(out);
  const setRel = `rounds/${label.round}/audit-set.json`;
  const set = requiredJson<AuditSetFile>(r, setRel, (v) => {
    const parsed = parseAuditSet(v);
    return parsed === null ? err('malformed audit set') : ok(parsed);
  });
  if (!set.ok) return set;
  const pair = set.value.pairs.find((p) => p.label === label.id);
  if (pair === undefined) return err(`${setRel} has no pair for label ${label.id}`);
  for (const rel of jsonFiles(r, r.rel(pairDir(roundPaths(r.root, label.round), pair.pair)))) {
    const raw = r.json(rel);
    if (raw === null) continue;
    if (!raw.ok) return raw;
    const family = readString(raw.value, 'family');
    const picks = stringRecord(readRecord(raw.value, 'picks'));
    const quotes = stringRecord(readRecord(raw.value, 'quotes'));
    if (family === null || !isFamily(family) || picks === null || quotes === null) return err(`${rel}: family, picks and quotes are required`);
    if (readString(raw.value, 'status') === 'ok') out.push(...callQuotes(family, picks, quotes));
  }
  return ok(out);
}

/** Visible texts (by label text sha256) and judge quotes of every visible label; reserve labels are never opened. */
function visibleMaterial(r: InputReader, ledger: LabelLedger): Result<{ texts: Record<string, string>; quotes: Record<string, EvidenceQuote[]> }> {
  const texts: Record<string, string> = {};
  const quotes: Record<string, EvidenceQuote[]> = {};
  for (const label of ledger.labels.filter((l) => l.split === 'visible')) {
    for (const t of label.texts) {
      if (Object.hasOwn(texts, t.sha256)) continue;
      const text = labelText(r, t);
      if (!text.ok) return err(`label ${label.id}: ${text.error}`);
      texts[t.sha256] = text.value;
    }
    const q = labelQuotes(r, label);
    if (!q.ok) return err(`label ${label.id}: ${q.error}`);
    if (q.value.length > 0) quotes[label.id] = q.value;
  }
  return ok({ texts, quotes });
}

const CHAMPION_KINDS: ReadonlyArray<StagnationRow['champion_kind']> = ['baseline', 'owner_pick', 'golden'];

/** One round's tally as the packet reads it: per-measure points (measures that ran), whether a pair beat the champion. */
interface TallyView {
  points: Array<[EvidenceMeasure, SaturationPoint]>;
  beat: boolean;
  kind: StagnationRow['champion_kind'];
}

/**
 * Saturation events of tally.json v2 (s3 §1.5): taste = session-pair wins of the submissions over E × session_pairs;
 * hook = a mechanical hook score above 0; skin_swap = recognised; cold_reader = clarity 3 (all three questions
 * answered); surprise = surprising details of the eligible ones. A measure with n = 0 did not run that round. A tally
 * isRoundTally refuses (a field missing or renamed) is an error, never a zero count.
 */
function tallyView(round: string, value: unknown): Result<TallyView> {
  if (!isRoundTally(value)) return err('not a tally v2 (schema/tally.schema.json)');
  const count: Record<EvidenceMeasure, { n: number; top: number }> = { taste: { n: 0, top: 0 }, hook: { n: 0, top: 0 }, skin_swap: { n: 0, top: 0 }, cold_reader: { n: 0, top: 0 }, surprise: { n: 0, top: 0 } };
  let beat = false;
  for (const p of value.champion_pairs) {
    count.taste.n += p.e.length * value.session_pairs;
    count.taste.top += p.total_wins;
    if (p.beats_champion) beat = true;
  }
  for (const m of Object.values(value.measures)) {
    if (m.hook !== null) {
      count.hook.n += 1;
      if (m.hook > 0) count.hook.top += 1;
    }
    if (m.skin_swap === 'recognised' || m.skin_swap === 'not_recognised') {
      count.skin_swap.n += 1;
      if (m.skin_swap === 'recognised') count.skin_swap.top += 1;
    }
    if (m.cold_reader.status === 'ok') {
      count.cold_reader.n += 1;
      if (m.cold_reader.clarity === 3) count.cold_reader.top += 1;
    }
    count.surprise.n += m.surprise.eligible;
    count.surprise.top += m.surprise.surprising;
  }
  const points = MEASURES.flatMap((measure): Array<[EvidenceMeasure, SaturationPoint]> => (count[measure].n > 0 ? [[measure, { round, n: count[measure].n, top: count[measure].top }]] : []));
  return ok({ points, beat, kind: value.champion });
}

/** R rounds 1 … `upto` with a directory under rounds/, in order. */
function roundsUpTo(root: string, upto: number): string[] {
  const dir = join(root, 'rounds');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => {
    const k = roundNumber(n);
    return k.ok && k.value >= 1 && k.value <= upto;
  }).sort(byCodeUnit);
}

interface History {
  saturation: Record<EvidenceMeasure, SaturationPoint[]>;
  stagnation: StagnationRow[];
}

/** Saturation series and row stagnation over every round up to `round` with a tally (this round's is required). */
function roundHistory(r: InputReader, round: string): Result<History> {
  const saturationSeries: Record<EvidenceMeasure, SaturationPoint[]> = { taste: [], hook: [], skin_swap: [], cold_reader: [], surprise: [] };
  const rows = new Map<string, { streak: number; kind: StagnationRow['champion_kind'] }>();
  const upto = roundNumber(round);
  for (const id of roundsUpTo(r.root, upto.ok ? upto.value : 0)) {
    const tallyRel = `rounds/${id}/tally.json`;
    const raw = r.json(tallyRel);
    if (raw === null && id !== round) continue;
    const view = raw === null ? err<TallyView>('missing') : raw.ok ? tallyView(id, raw.value) : raw;
    if (!view.ok) return err(`${tallyRel}: ${view.error}`);
    for (const [measure, point] of view.value.points) saturationSeries[measure].push(point);
    const brief = requiredJson<string>(r, `rounds/${id}/brief.json`, (v) => {
      const row = readString(v, 'row_id');
      return row === null ? err('row_id is required') : ok(row);
    });
    if (!brief.ok) return brief;
    const prev = rows.get(brief.value)?.streak ?? 0;
    rows.set(brief.value, { streak: view.value.beat ? 0 : prev + 1, kind: view.value.kind });
  }
  const stagnation = [...rows.entries()].sort((x, y) => byCodeUnit(x[0], y[0])).map(([row_id, s]) => ({ row_id, rounds_without_beat: s.streak, champion_kind: s.kind }));
  return ok({ saturation: saturationSeries, stagnation });
}

/** A file below a round sub-directory: group 1 = `rounds/<round>/<dir>`. */
const ROUND_SUBDIR_FILE = /^(rounds\/[^/]+\/[^/]+)\/./u;

/**
 * packet.inputs from the per-file hashes: files in calibration/, benchmark/ or directly in a round directory keep their
 * own key; the files below a round sub-directory (taste pair dirs incl. aux, call records, gate records, submissions:
 * their names carry pair, submission and task ids, reserve pairs' included) fold into one key `rounds/RNN/<dir>/*` =
 * SHA-256 over the code-unit-sorted `<path>:<sha256>` lines (LF-terminated). Deterministic; any changed, added or
 * dropped file moves its directory's key.
 */
function foldedInputs(hashes: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  const groups = new Map<string, string[]>();
  for (const [path, hash] of Object.entries(hashes).sort(([a], [b]) => byCodeUnit(a, b))) {
    const dir = ROUND_SUBDIR_FILE.exec(path)?.[1];
    if (dir === undefined) {
      out[path] = hash;
      continue;
    }
    const lines = groups.get(`${dir}/*`) ?? [];
    lines.push(`${path}:${hash}\n`);
    groups.set(`${dir}/*`, lines);
  }
  for (const [key, lines] of groups) out[key] = sha256(lines.join(''));
  return out;
}

/** Gate summary files next to the per-submission gate records (gate-mech, defect, gate-llm, resubmit). */
const GATE_SUMMARIES: readonly string[] = ['mechanical.json', 'defect.json', 'llm.json', 'resubmit.json'];

/** DEF per family: defect copies it judged this round (`gate/<sub>.json` judges with a copy call) and how many it caught. */
function defectCounts(r: InputReader, round: string): Result<DefectCount[]> {
  const per = new Map<Family, DefectCount>();
  for (const rel of jsonFiles(r, `rounds/${round}/gate`)) {
    if (GATE_SUMMARIES.some((n) => rel.endsWith(`/${n}`))) continue;
    const raw = r.json(rel);
    if (raw === null) continue;
    if (!raw.ok) return raw;
    const judges = readArray(raw.value, 'judges');
    if (judges === null) return err(`${rel}: judges is required`);
    for (const j of judges) {
      const family = readString(j, 'family');
      if (family === null || !isFamily(family)) return err(`${rel}: a judge without a known family`);
      if (readRecord(j, 'copy') === null) continue;
      const c = per.get(family) ?? { family, injected: 0, caught: 0 };
      c.injected += 1;
      if (readBoolean(j, 'caught') === true) c.caught += 1;
      per.set(family, c);
    }
  }
  return ok([...per.values()].sort((x, y) => byCodeUnit(x.family, y.family)));
}

/** Nearest-rank percentile of sorted values (0 when empty). */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
}

/** COST per family from this round's call records (`calls/*.json`, attempts counted, quota tries skipped; cost.ts roundCost rules). */
function costRows(r: InputReader, round: string): Result<CostRow[]> {
  const per = new Map<Family, { usd: number; ms: number[] }>();
  for (const rel of jsonFiles(r, `rounds/${round}/calls`)) {
    const raw = r.json(rel);
    if (raw === null) continue;
    if (!raw.ok) return raw;
    if (readBoolean(raw.value, 'quota') === true) continue;
    const family = readString(raw.value, 'family');
    if (family === null || !isFamily(family)) continue;
    const c = per.get(family) ?? { usd: 0, ms: [] };
    c.usd = round10(c.usd + (readNumber(raw.value, 'cost_usd') ?? 0));
    c.ms.push(readNumber(raw.value, 'ms') ?? 0);
    per.set(family, c);
  }
  return ok([...per.entries()].sort((x, y) => byCodeUnit(x[0], y[0])).map(([family, c]) => {
    const ms = [...c.ms].sort((a, b) => a - b);
    return { family, calls: ms.length, usd: c.usd, p50_ms: percentile(ms, 0.5), p90_ms: percentile(ms, 0.9) };
  }));
}

/**
 * This round's champion pairs (pairs.json) → pairs.ts pairVerdicts, keyed by pair id. Every call file is read and
 * hashed, reserve pairs' included (ORD / VOID count them); foldedInputs keeps their pair-id paths out of the packet.
 */
function roundSessions(r: InputReader, round: string): Result<Record<string, FamilySessions[]>> {
  const paths = roundPaths(r.root, round);
  if (r.bytes(r.rel(pairsFilePath(paths, 'champion'))) === null) return err(`rounds/${round}/pairs.json is missing`);
  const file = readPairsFile(paths, 'champion');
  if (!file.ok) return err(`rounds/${round}: ${file.error}`);
  const out: Record<string, FamilySessions[]> = {};
  for (const pair of file.value.pairs) {
    for (const rel of jsonFiles(r, r.rel(pairDir(paths, pair.id)))) r.bytes(rel);
    out[pair.id] = pairVerdicts(r.root, round, pair.id);
  }
  return ok(out);
}

/** Decision reason codes of earlier rounds (owner reader, ok decisions only) and this round (the 09b pin). */
function decisionReasons(ctx: StepContext, r: InputReader): Array<{ round: string; reason: string }> {
  const out: Array<{ round: string; reason: string }> = [];
  const thisRound = roundNumber(ctx.roundId);
  for (const id of roundsUpTo(ctx.root, (thisRound.ok ? thisRound.value : 1) - 1)) {
    const d = ctx.owner.decision(id);
    if (d.state !== 'ok') continue;
    r.bytes(d.value.file);
    out.push({ round: id, reason: d.value.reason });
  }
  const current = ctx.decision();
  r.bytes(current.file);
  out.push({ round: ctx.roundId, reason: current.reason });
  return out;
}

/** The file of a version: its logged path (activate / pending_owner), else `benchmark/<version>.json`. */
function versionRel(log: readonly BenchLogEntry[], version: string): string {
  return log.find((e) => e.version === version && e.path !== null && e.path.startsWith('benchmark/'))?.path ?? `benchmark/${version}.json`;
}

/** RB rows in owner-log order; keys = maintainer / activation keys that differ between `from` and the target (changedKeys). */
function rollbackViews(ctx: StepContext, r: InputReader, log: readonly BenchLogEntry[]): Result<RollbackView[]> {
  const load = (version: string): Result<JsonRecord> => {
    if (!VERSION_ID.test(version)) return err(`rollback names ${version}, not a version id`);
    return requiredJson(r, versionRel(log, version), (v) => (isRecord(v) ? ok(v) : err('expected an object')));
  };
  const out: RollbackView[] = [];
  for (const rb of ctx.owner.rollbacks()) {
    const target = load(rb.version);
    if (!target.ok) return target;
    const from = load(rb.from);
    if (!from.ok) return from;
    out.push({ at: rb.at, version: rb.version, from: rb.from, keys: changedKeys(target.value, from.value, ctx.protocol.activation) });
  }
  return ok(out);
}

const EMPTY_SERIES: Readonly<Record<EvidenceMeasure, readonly SaturationPoint[]>> = { taste: [], hook: [], skin_swap: [], cold_reader: [], surprise: [] };

function collect(ctx: StepContext, head: VersionRef): Result<EvidenceInputs> {
  const r = inputReader(ctx.root);
  const round = ctx.roundId;
  const ledger = requiredJson(r, LABELS_FILE, parseLabelLedger);
  if (!ledger.ok) return ledger;
  const status = requiredJson(r, TRUST_STATUS, parseTrustStatus);
  if (!status.ok) return status;
  const material = visibleMaterial(r, ledger.value);
  if (!material.ok) return material;
  const log = readBenchLog(ctx.root);
  if (!log.ok) return err(`${BENCH_LOG}: ${log.error}`);
  // The append-only owner and bench logs are read (RB / PEND items) but never hashed: an owner action after the packet
  // write would otherwise change its bytes, and a rerun of 11f would fail as a rewrite.
  const rollbacks = rollbackViews(ctx, r, log.value);
  if (!rollbacks.ok) return rollbacks;
  const common = {
    round, head, ledger: ledger.value, visibleTexts: material.value.texts, status: status.value, quotes: material.value.quotes,
    rollbacks: rollbacks.value, pending: pendingVersions(log.value, ctx.owner),
  };
  if (ctx.pipeline === 'bench-r00') {
    const pin = requiredJson(r, `calibration/C00/${PIN_FILE}`, parsePin);
    if (!pin.ok) return pin;
    return ok({ ...common, benchmarkVersion: pin.value.benchmark_version, sessions: {}, saturation: EMPTY_SERIES, reasons: [], defects: [], costs: [], stagnation: [], inputs: foldedInputs(r.hashes), files: { ...r.hashes } });
  }
  if (ctx.pipeline !== 'round') return err(`collectEvidence: the ${ctx.pipeline} pipeline has no evidence packet`);
  const freeze = ctx.freeze();
  r.bytes(`rounds/${round}/freeze.json`);
  r.bytes(`rounds/${round}/audit.json`);
  const history = roundHistory(r, round);
  if (!history.ok) return history;
  const sessions = roundSessions(r, round);
  if (!sessions.ok) return sessions;
  const defects = defectCounts(r, round);
  if (!defects.ok) return defects;
  const costs = costRows(r, round);
  if (!costs.ok) return costs;
  const reasons = decisionReasons(ctx, r);
  return ok({
    ...common, benchmarkVersion: freeze.benchmark_version, sessions: sessions.value, saturation: history.value.saturation, reasons,
    defects: defects.value, costs: costs.value, stagnation: history.value.stagnation, inputs: foldedInputs(r.hashes), files: { ...r.hashes },
  });
}

/**
 * Reads and hashes every input of ctx's round (round and bench-r00 pipelines); err = a missing or malformed input.
 * Round: freeze, tally (this and earlier rounds, with their brief rows), audit, the decision reason, champion-pair taste
 * calls, gate records, call records, labels, trust status, visible label texts and quotes, owner log (rollbacks and
 * approvals), bench log and the rolled-back version files. bench-r00: the C00 pin, labels, status, the C00 visible
 * texts and verdicts, owner log, bench log (no freeze, tally or decision exist yet). `inputs` hashes every file read
 * except the append-only owner and bench logs (their facts are the RB / PEND items), the files below a round
 * sub-directory folded into one `rounds/RNN/<dir>/*` key each (foldedInputs: no pair id is serialised).
 */
export function collectEvidence(ctx: StepContext, head: VersionRef): Result<EvidenceInputs> {
  try {
    return collect(ctx, head);
  } catch (e) {
    if (e instanceof IntegrityError) return err(e.message);
    throw e;
  }
}

let cachedSchema: Schema | null = null;

/** The engine's copy of schema/evidence.schema.json (module-relative, so temp forge roots need no schema dir). */
function evidenceSchema(): Schema {
  if (cachedSchema !== null) return cachedSchema;
  const raw: unknown = JSON.parse(readFileSync(schemaFile('evidence.schema.json'), 'utf8'));
  const schema = loadSchema(raw);
  if (!schema.ok) throw new Error(`schema/evidence.schema.json: ${schema.error}`);
  cachedSchema = schema.value;
  return schema.value;
}

const HEX64 = /^[0-9a-f]{64}$/u;

function nat(value: unknown, key: string): number | null {
  const n = readNumber(value, key);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
}

function familyAt(value: unknown, key: string): Family | null {
  const f = readString(value, key);
  return f !== null && isFamily(f) ? f : null;
}

function strings(value: unknown, key: string): string[] | null {
  const list = readArray(value, key);
  return list !== null && list.every((s) => typeof s === 'string') ? list.filter((s) => typeof s === 'string') : null;
}

function matrix(value: unknown, key: string, size: number): number[][] | null {
  const rows = readArray(value, key);
  if (rows === null || rows.length !== size) return null;
  const out: number[][] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== size || !row.every((x) => typeof x === 'number' && Number.isInteger(x) && x >= 0)) return null;
    out.push(row.filter((x) => typeof x === 'number'));
  }
  return out;
}

/** The item's typed body (schema already checked field types); null names a missing or mistyped field. */
function narrowBody(round: string, v: JsonRecord): { item: EvidenceItem; id: string } | null {
  const kind = readString(v, 'kind');
  const id = readString(v, 'id') ?? '';
  const family = familyAt(v, 'family');
  const withId = (item: EvidenceItem, expected: string): { item: EvidenceItem; id: string } => ({ item, id: expected });
  if (kind === 'agreement') {
    const n = nat(v, 'n');
    const agree = nat(v, 'agree');
    const mean = readNumber(v, 'mean');
    const ci = readArray(v, 'ci90') ?? [];
    const lo = ci[0];
    const hi = ci[1];
    const state = (['ok', 'flagged', 'suspended'] satisfies Array<'ok' | 'flagged' | 'suspended'>).find((s) => s === readString(v, 'state'));
    if (family === null || n === null || agree === null || agree > n || mean === null || typeof lo !== 'number' || typeof hi !== 'number' || state === undefined) return null;
    return withId({ id, kind, family, n, agree, mean, ci90: [lo, hi], state }, evidenceId(round, 'AGR', family));
  }
  if (kind === 'order_consistency') {
    const calls = nat(v, 'calls');
    const consistent = nat(v, 'consistent');
    if (family === null || calls === null || consistent === null || consistent > calls) return null;
    return withId({ id, kind, family, calls, consistent }, evidenceId(round, 'ORD', family));
  }
  if (kind === 'void_decoy') {
    const pairs = nat(v, 'session_pairs');
    const voids = nat(v, 'void');
    const decoy = nat(v, 'decoy_fail');
    if (family === null || pairs === null || voids === null || decoy === null || voids > pairs || decoy > pairs) return null;
    return withId({ id, kind, family, session_pairs: pairs, void: voids, decoy_fail: decoy }, evidenceId(round, 'VOID', family));
  }
  if (kind === 'family_matrix') {
    const names = strings(v, 'families');
    const families = names === null ? [] : names.filter(isFamily);
    const agree = matrix(v, 'agree', families.length);
    const n = matrix(v, 'n', families.length);
    if (names === null || families.length !== names.length || agree === null || n === null) return null;
    return withId({ id, kind, families, agree, n }, evidenceId(round, 'IFA'));
  }
  return narrowMore(round, kind, id, v);
}

function narrowMore(round: string, kind: string | null, id: string, v: JsonRecord): { item: EvidenceItem; id: string } | null {
  const family = familyAt(v, 'family');
  if (kind === 'saturation') {
    const measure = MEASURES.find((m) => m === readString(v, 'measure'));
    const ceiling = readBoolean(v, 'ceiling');
    const rounds: SaturationPoint[] = [];
    for (const p of readArray(v, 'rounds') ?? []) {
      const r = readString(p, 'round');
      const n = nat(p, 'n');
      const top = nat(p, 'top');
      if (r === null || n === null || top === null || top > n) return null;
      rounds.push({ round: r, n, top });
    }
    const at = rounds.map((p) => saturationWindow(round).indexOf(p.round));
    if (at.some((k, i) => k < 0 || (i > 0 && k <= (at[i - 1] ?? -1)))) return null;
    if (measure === undefined || ceiling === null || ceiling !== windowCeiling(round, rounds)) return null;
    return { item: { id, kind, measure, rounds, ceiling }, id: evidenceId(round, 'SAT', measure) };
  }
  if (kind === 'reason_codes') {
    const counts: Record<string, number> = {};
    for (const [code, c] of Object.entries(readRecord(v, 'counts') ?? {})) {
      if (typeof c !== 'number' || !Number.isInteger(c) || c < 1) return null;
      counts[code] = c;
    }
    const rounds = nat(v, 'rounds');
    if (rounds === null) return null;
    return { item: { id, kind, counts, rounds }, id: evidenceId(round, 'RC') };
  }
  if (kind === 'disagreement') return narrowDisagreement(round, id, v);
  if (kind === 'stagnation') {
    const row = readString(v, 'row_id');
    const count = nat(v, 'rounds_without_beat');
    const champion = CHAMPION_KINDS.find((k) => k === readString(v, 'champion_kind'));
    const flagged = readBoolean(v, 'flagged');
    if (row === null || count === null || champion === undefined || flagged !== count >= 2) return null;
    return { item: { id, kind, row_id: row, rounds_without_beat: count, champion_kind: champion, flagged }, id: stagnationId(round, row) };
  }
  if (kind === 'defect_catch') {
    const injected = nat(v, 'injected');
    const caught = nat(v, 'caught');
    if (family === null || injected === null || caught === null || caught > injected) return null;
    return { item: { id, kind, family, injected, caught }, id: evidenceId(round, 'DEF', family) };
  }
  if (kind === 'cost') {
    const calls = nat(v, 'calls');
    const usd = readNumber(v, 'usd');
    const p50 = readNumber(v, 'p50_ms');
    const p90 = readNumber(v, 'p90_ms');
    if (family === null || calls === null || usd === null || p50 === null || p90 === null || p50 > p90) return null;
    return { item: { id, kind, family, calls, usd, p50_ms: p50, p90_ms: p90 }, id: evidenceId(round, 'COST', family) };
  }
  if (kind === 'rollback') {
    const at = readString(v, 'at');
    const version = readString(v, 'version');
    const from = readString(v, 'from');
    const keys = strings(v, 'keys');
    if (at === null || version === null || from === null || keys === null) return null;
    return { item: { id, kind, at, version, from, keys }, id: new RegExp(`^E-${round}-RB-[1-9]\\d*$`, 'u').test(id) ? id : `${id} (not E-${round}-RB-<n>)` };
  }
  if (kind === 'pending') {
    const version = readString(v, 'version');
    const since = readString(v, 'since');
    if (version === null || since === null) return null;
    return { item: { id, kind, version, since, activation: 'owner' }, id: evidenceId(round, 'PEND', version) };
  }
  if (kind === 'reserve_count') {
    const visible = nat(v, 'visible');
    const reserve = nat(v, 'reserve');
    if (visible === null || reserve === null) return null;
    return { item: { id, kind, visible, reserve }, id: evidenceId(round, 'RES') };
  }
  return null;
}

function narrowDisagreement(round: string, id: string, v: JsonRecord): { item: EvidenceItem; id: string } | null {
  const label = readString(v, 'label');
  const owner = readNumber(v, 'owner');
  const texts: EvidenceText[] = [];
  for (const t of readArray(v, 'texts') ?? []) {
    const textId = readString(t, 'text_id');
    const text = readString(t, 'text');
    if (textId === null || text === null) return null;
    texts.push({ text_id: textId, text });
  }
  const panel: PanelView[] = [];
  for (const p of readArray(v, 'panel') ?? []) {
    const family = familyAt(p, 'family');
    const raw = isRecord(p) ? p['choice'] : null;
    const choice = raw === 0 ? 0 : raw === 1 ? 1 : raw === 'inconsistent' ? 'inconsistent' : null;
    const quotes = strings(p, 'quotes');
    if (family === null || choice === null || quotes === null) return null;
    panel.push({ family, choice, quotes });
  }
  const [a, b] = texts;
  if (label === null || (owner !== 0 && owner !== 1) || a === undefined || b === undefined || texts.length !== 2) return null;
  return { item: { id, kind: 'disagreement', label, texts: [a, b], owner, panel }, id: evidenceId(round, 'DIS', label) };
}

/** Validates a packet read back from disk (schema/evidence.schema.json + id rules). */
export function parseEvidencePacket(value: unknown): Result<EvidencePacket> {
  const errors = validate(evidenceSchema(), value);
  if (errors.length > 0) return err(errors.join('; '));
  const round = readString(value, 'round');
  const version = readString(value, 'benchmark_version');
  const headVersion = readString(value, 'head_version');
  const ceilings = strings(value, 'ceilings');
  if (round === null || version === null || headVersion === null || ceilings === null) return err('malformed evidence packet');
  const inputs: Record<string, string> = {};
  for (const [path, hash] of Object.entries(readRecord(value, 'inputs') ?? {})) {
    if (typeof hash !== 'string' || !HEX64.test(hash)) return err(`inputs.${path}: expected a SHA-256`);
    inputs[path] = hash;
  }
  const items: EvidenceItem[] = [];
  for (const [i, raw] of (readArray(value, 'items') ?? []).entries()) {
    if (!isRecord(raw)) return err(`items[${i}]: expected an object`);
    let narrowed: { item: EvidenceItem; id: string } | null;
    try {
      narrowed = narrowBody(round, raw);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      return err(`items[${i}]: ${e.message}`);
    }
    if (narrowed === null) return err(`items[${i}] (${readString(raw, 'kind') ?? '?'}): missing or inconsistent fields`);
    if (narrowed.item.id !== narrowed.id) return err(`items[${i}]: id ${narrowed.item.id} should be ${narrowed.id}`);
    const prev = items.at(-1);
    if (prev !== undefined && prev.id >= narrowed.item.id) return err(`items[${i}]: ${narrowed.item.id} is not after ${prev.id} (code-unit order, unique ids)`);
    items.push(narrowed.item);
  }
  if (items.filter((i) => i.kind === 'disagreement').length > EVIDENCE_DISAGREEMENTS_MAX) return err(`more than ${EVIDENCE_DISAGREEMENTS_MAX} disagreement items`);
  const packet: EvidencePacket = { round, benchmark_version: version, head_version: headVersion, inputs, items, ceilings };
  const expected = ceilingIds(packet);
  if (expected.length !== ceilings.length || expected.some((id, i) => ceilings[i] !== id)) return err(`ceilings must be exactly [${expected.join(', ')}]`);
  return ok(packet);
}

/** The packet of `round` with the SHA-256 of its bytes; null when absent. */
export function readEvidencePacket(root: string, round: string): Result<{ packet: EvidencePacket; sha256: string }> | null {
  const rel = evidencePath(round);
  const path = join(root, rel);
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    return err(`${rel} is not valid JSON: ${e instanceof Error ? e.message.split(path).join(rel) : String(e)}`);
  }
  const packet = parseEvidencePacket(value);
  if (!packet.ok) return err(`${rel}: ${packet.error}`);
  if (packet.value.round !== round) return err(`${rel} holds the packet of ${packet.value.round}`);
  return ok({ packet: packet.value, sha256: sha256Bytes(bytes) });
}
