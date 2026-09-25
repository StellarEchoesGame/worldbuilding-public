import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCard, type CardSubmission } from '../card.ts';
import { isFamily, type Family } from '../config.ts';
import type { StepContext } from '../context.ts';
import { roundCost, type BackendCost, type RoundCost } from '../cost.ts';
import { readArray, readBoolean, readNumber, readRecord, readString, stringArray } from '../json.ts';
import { AUX_PAIRS_FILE, CHAMPION_SNAPSHOT, pairsFilePath, pairVerdicts, readChampionSnapshot, readPairsFile, type FamilySessions, type PairsFile } from '../pairs.ts';
import type { StepDef } from '../runner.ts';
import { sha256 } from '../store.ts';
import { displayText, loadSubmission, stableLabels } from '../submission.ts';
import { buildRoundTally, sortedRecord, type RoundTallyInput, type SkinSwapSummary, type SubmissionMeasures, type VoidCounts } from '../tally.ts';
import { IntegrityError, readTaskRecord } from '../task.ts';
import { isOneOf } from '../tasks/fenced.ts';
import type { GateOutcome } from '../tasks/gate-judge.ts';
import type { ColdRead } from '../tasks/measures.ts';
import type { SurpriseStatus } from '../tasks/surprise.ts';
import { readBriefJson } from './brief.ts';
import { passingSubmissions, type PathInstanceNote } from './gate-llm.ts';
import { readRecallFile } from './measures.ts';
import { readUnsealFile, surprisePath, unsealPath } from './surprise.ts';

/** `rounds/RNN/wild-seeds.json`: each passing submission's 3 writer seed lines, kept for F1-04's wild-round vote. */
export interface WildSeedsFile {
  round: string;
  seeds: Record<string, string[]>;
}

const GATE_OUTCOMES: readonly GateOutcome[] = ['pass', 'fail', 'split', 'unverified'];
const MEASURE_STATUSES: readonly ('ok' | 'void' | 'inactive')[] = ['ok', 'void', 'inactive'];
const PRODUCER_STATUSES: readonly ('pass' | 'fail' | 'unjudged')[] = ['pass', 'fail', 'unjudged'];
const SURPRISE_STATUSES: readonly SurpriseStatus[] = ['full', 'reused', 'match_only', 'insufficient', 'invalid', 'inactive'];

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Reads the round files 08 aggregates and records every one of them as a marker input. */
interface Inputs {
  /** Parsed JSON of an earlier step's output; null when absent; a present file that is not JSON is an integrity error. */
  optional(path: string): unknown;
  /** As optional, but a missing file is an integrity error (the earlier step always writes it). */
  required(path: string): unknown;
  /** Records a file read through another module (submissions, pairs files, taste call files). */
  note(path: string): void;
  list(): string[];
}

function inputReader(ctx: StepContext): Inputs {
  const rels = new Set<string>();
  const optional = (path: string): unknown => {
    if (!existsSync(path)) return null;
    const rel = ctx.files.rel(path);
    rels.add(rel);
    try {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      return value;
    } catch {
      throw new IntegrityError(`${rel} is not JSON`);
    }
  };
  return {
    optional,
    required(path) {
      const value = optional(path);
      if (value === null) throw new IntegrityError(`${ctx.files.rel(path)} is missing`);
      return value;
    },
    note(path) {
      if (existsSync(path)) rels.add(ctx.files.rel(path));
    },
    list: () => [...rels].sort(byCodeUnit),
  };
}

function malformed(ctx: StepContext, path: string, what: string): IntegrityError {
  return new IntegrityError(`${ctx.files.rel(path)}: ${what}`);
}

function families(value: unknown): Family[] {
  return (stringArray(value) ?? []).filter(isFamily);
}

/** Every `*.json` under `taste/` (champion and aux call files), code-unit sorted. */
function tasteFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...tasteFiles(path));
    else if (e.isFile() && e.name.endsWith('.json')) out.push(path);
  }
  return out.sort(byCodeUnit);
}

/** The writer slot of a submission id (`W1` for `W1-r2`) and whether it is the 05d resubmission. */
function slotOf(submission: string): { slot: string; resubmitted: boolean } {
  const m = /^(.+)-r2$/u.exec(submission);
  return m === null ? { slot: submission, resubmitted: false } : { slot: m[1] ?? submission, resubmitted: true };
}

/** The card's view of `gate/<sub>.json` (GateSubmissionFile). */
function readGate(ctx: StepContext, io: Inputs, sub: string): CardSubmission['gate'] {
  const path = join(ctx.paths.gate, `${sub}.json`);
  const file = io.required(path);
  const outcome = readString(file, 'outcome');
  const defect = readBoolean(file, 'defect_unverified');
  const rawNotes = readArray(file, 'path_instance_notes');
  if (outcome === null || !isOneOf(outcome, GATE_OUTCOMES) || defect === null || rawNotes === null) throw malformed(ctx, path, 'expected outcome, defect_unverified and path_instance_notes');
  const notes: PathInstanceNote[] = [];
  for (const n of rawNotes) {
    const family = readString(n, 'family');
    const quote = readString(n, 'quote');
    const against = readString(n, 'against');
    const reason = readString(n, 'reason');
    if (family === null || !isFamily(family) || quote === null || against === null || reason === null) throw malformed(ctx, path, 'malformed path_instance_notes entry');
    notes.push({ family, quote, against, reason });
  }
  return { outcome, counted: families(readArray(file, 'counted')), defectUnverified: defect, pathInstanceNotes: notes };
}

function measureStatus(ctx: StepContext, path: string, file: unknown): 'ok' | 'void' | 'inactive' {
  const status = readString(file, 'status');
  if (status === null || !isOneOf(status, MEASURE_STATUSES)) throw malformed(ctx, path, 'status must be ok, void or inactive');
  return status;
}

function skinSwap(ctx: StepContext, io: Inputs, sub: string): SkinSwapSummary {
  const path = join(ctx.paths.measures, 'skin-swap', `${sub}.json`);
  const file = io.required(path);
  const status = measureStatus(ctx, path, file);
  if (status !== 'ok') return status;
  const recognised = readBoolean(readRecord(file, 'verdict'), 'recognised');
  if (recognised === null) throw malformed(ctx, path, 'an ok skin-swap needs verdict.recognised');
  return recognised ? 'recognised' : 'not_recognised';
}

function parseColdRead(value: unknown): ColdRead | null {
  const where = readRecord(value, 'where');
  const who = readRecord(value, 'who');
  const go = readRecord(value, 'go');
  const clarity = readNumber(value, 'clarity');
  const whereAnswer = readString(where, 'answer');
  const whereQuote = readString(where, 'quote');
  const name = readString(who, 'name');
  const wants = readString(who, 'wants');
  const whoQuote = readString(who, 'quote');
  if (whereAnswer === null || whereQuote === null || name === null || wants === null || whoQuote === null || go === null || clarity === null) return null;
  return {
    where: { answer: whereAnswer, quote: whereQuote },
    who: { name, wants, cost: readString(who, 'cost'), quote: whoQuote },
    go: { answer: readString(go, 'answer'), quote: readString(go, 'quote') },
    clarity,
  };
}

function coldReader(ctx: StepContext, io: Inputs, sub: string): { status: 'ok' | 'void' | 'inactive'; read: ColdRead | null } {
  const path = join(ctx.paths.measures, 'cold-reader', `${sub}.json`);
  const file = io.required(path);
  const status = measureStatus(ctx, path, file);
  if (status !== 'ok') return { status, read: null };
  const read = parseColdRead(readRecord(file, 'read'));
  if (read === null) throw malformed(ctx, path, 'an ok cold read needs read.{where, who, go, clarity}');
  return { status, read };
}

function producer(ctx: StepContext, io: Inputs, sub: string): 'pass' | 'fail' | 'unjudged' {
  const path = join(ctx.paths.measures, 'producer', `${sub}.json`);
  const status = readString(io.required(path), 'status');
  if (status === null || !isOneOf(status, PRODUCER_STATUSES)) throw malformed(ctx, path, 'status must be pass, fail or unjudged');
  return status;
}

/** Mechanical memory-hook score of recall (RecallFile.hook); null when the benchmark retired the measure. */
function hook(ctx: StepContext, io: Inputs, sub: string, active: boolean): number | null {
  io.note(join(ctx.paths.measures, 'recall', `${sub}.json`));
  const file = readRecallFile(ctx, sub);
  if (!file.ok) throw new IntegrityError(file.error);
  return active ? file.value.hook : null;
}

interface RoundSurprise {
  unseal: { status: 'valid' | 'invalid'; remote: 'verified' | 'unavailable' | 'mismatch' };
  /** surprise.json; null when 07b skipped (unseal invalid or the measure inactive). */
  file: unknown;
  active: boolean;
}

function readRoundSurprise(ctx: StepContext, io: Inputs, active: boolean): RoundSurprise {
  io.note(unsealPath(ctx));
  const unseal = readUnsealFile(ctx);
  if (!unseal.ok) throw new IntegrityError(unseal.error);
  const { status, remote } = unseal.value;
  // 07b ran exactly when the unseal is valid and the measure active; otherwise any surprise.json is an earlier run's.
  return { unseal: { status, remote }, file: status === 'valid' && active ? io.required(surprisePath(ctx)) : null, active };
}

/**
 * A submission's surprise summary and whether its chain was accepted by a fresh session of a matcher family
 * (inactive / invalid when 07b skipped). A passing submission without a report is an integrity error.
 */
function surpriseOf(ctx: StepContext, round: RoundSurprise, sub: string): { summary: SubmissionMeasures['surprise']; acceptorReused: boolean } {
  if (!round.active) return { summary: { status: 'inactive', surprising: 0, eligible: 0 }, acceptorReused: false };
  if (round.file === null) return { summary: { status: 'invalid', surprising: 0, eligible: 0 }, acceptorReused: false };
  const report = readRecord(readRecord(round.file, 'submissions'), sub);
  if (report === null) throw malformed(ctx, surprisePath(ctx), `no report for gate-passing submission ${sub}`);
  const status = readString(report, 'status');
  const surprising = readNumber(report, 'surprising');
  const eligible = readNumber(report, 'eligible');
  const acceptorReused = readBoolean(report, 'acceptor_reused');
  if (status === null || !isOneOf(status, SURPRISE_STATUSES) || surprising === null || eligible === null || acceptorReused === null) throw malformed(ctx, surprisePath(ctx), `malformed report for ${sub}`);
  return { summary: { status, surprising, eligible }, acceptorReused };
}

/** Void and retry counts: call records from cost.json, task records of the round (sealed ones too), champion-pair reruns and drops. */
function voidCounts(ctx: StepContext, calls: number, championSessions: readonly (readonly FamilySessions[])[]): VoidCounts {
  let voidTasks = 0;
  let retried = 0;
  const records = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')).sort(byCodeUnit).map((n) => join(dir, n)) : []);
  for (const path of [...records(ctx.paths.tasks), ...records(ctx.paths.sealedTasks)]) {
    const rec = readTaskRecord(path);
    if (rec === null) continue;
    if (!rec.ok) throw malformed(ctx, path, rec.error);
    if (rec.value.status === 'void') voidTasks += 1;
    if (rec.value.attempts >= 2) retried += 1;
  }
  // Shadow families never count: neither their reruns nor their drops.
  const counted = championSessions.flat().filter((fs) => !fs.shadow);
  return {
    calls,
    void_tasks: voidTasks,
    retried_tasks: retried,
    session_reruns: counted.reduce((sum, fs) => sum + fs.reruns.length, 0),
    dropped_families: counted.filter((fs) => fs.dropped !== null).length,
  };
}

const round10 = (x: number): number => Math.round(x * 1e10) / 1e10;

/** roundCost over `calls/` plus the sealed call records (forecasters, matchers) under `.sealed/RNN/calls/`. */
function allCallsCost(ctx: StepContext): RoundCost {
  const open = roundCost(ctx.paths);
  const sealed = roundCost({ ...ctx.paths, calls: join(ctx.paths.sealed, 'calls') });
  const by: Record<string, BackendCost> = {};
  for (const backend of [...new Set([...Object.keys(open.by_backend), ...Object.keys(sealed.by_backend)])].sort(byCodeUnit)) {
    const parts = [open.by_backend[backend], sealed.by_backend[backend]].flatMap((b) => (b === undefined ? [] : [b]));
    const sum = (key: 'attempts' | 'tokens_in' | 'tokens_out' | 'cost_usd' | 'unpriced_calls'): number => round10(parts.reduce((n, b) => n + b[key], 0));
    by[backend] = { attempts: sum('attempts'), tokens_in: sum('tokens_in'), tokens_out: sum('tokens_out'), cost_usd: sum('cost_usd'), unpriced_calls: sum('unpriced_calls') };
  }
  return { total_usd: round10(open.total_usd + sealed.total_usd), unpriced_calls: open.unpriced_calls + sealed.unpriced_calls, by_backend: by };
}

function readPairs(ctx: StepContext, io: Inputs, which: 'champion' | 'aux'): PairsFile {
  const read = readPairsFile(ctx.paths, which);
  if (!read.ok) throw new IntegrityError(read.error);
  io.note(pairsFilePath(ctx.paths, which));
  return read.value;
}

/** The passing submissions with their parsed writer output, display hash and gate view. */
function loadCandidates(ctx: StepContext, io: Inputs, passing: readonly string[]): Array<{ id: string; sub: Omit<CardSubmission, 'label' | 'cold' | 'acceptorReused'>; seeds: string[] }> {
  return passing.map((id) => {
    const path = join(ctx.paths.submissions, `${id}.json`);
    const loaded = loadSubmission(ctx.paths, id);
    if (loaded === null || loaded.output === null) throw new IntegrityError(`${ctx.files.rel(path)}: gate-passing submission does not parse`);
    io.note(path);
    const { slot, resubmitted } = slotOf(id);
    return {
      id,
      sub: { submission: id, slot, resubmitted, output: loaded.output, displaySha256: sha256(displayText(loaded.output)), gate: readGate(ctx, io, id) },
      seeds: [...loaded.output.seeds],
    };
  });
}

/**
 * 08-aggregate: `labels.json` (label → submission id; stableLabels over the passing submissions), `tally.json` v2
 * (buildRoundTally), `cost.json` (cost.ts roundCost over `calls/` and `.sealed/RNN/calls/`), `card.json` (buildCard), `wild-seeds.json`. No calls. Every
 * input is an earlier step's output: a missing or malformed one is an integrity error (exit 3); `surprise.json`
 * (07b skip) and `taste/aux/pairs.json` (06c skip) may be absent.
 */
export const aggregateStep: StepDef = {
  id: '08-aggregate',
  run: async (ctx) => {
    const io = inputReader(ctx);
    const brief = readBriefJson(ctx);
    io.note(ctx.paths.brief);
    const bench = ctx.benchmark();
    const passing = passingSubmissions(ctx);
    if (!passing.ok) throw new IntegrityError(passing.error);
    if (passing.value.length === 0) return { kind: 'failed', detail: 'no gate-passing submission to aggregate' };
    for (const name of ['mechanical.json', 'llm.json', 'resubmit.json']) io.note(join(ctx.paths.gate, name));
    const candidates = loadCandidates(ctx, io, passing.value);
    const labels = stableLabels(ctx.paths, passing.value, ctx.seed());
    const labelOf: Record<string, string> = {};
    for (const [label, id] of Object.entries(labels)) labelOf[id] = label;
    const label = (id: string): string => {
      const l = labelOf[id];
      if (l === undefined) throw new IntegrityError(`labels.json names no label for ${id}`);
      return l;
    };

    const champion = readPairs(ctx, io, 'champion');
    // pairs.json names the judged text (BASE); tally and card carry the champion's kind (baseline / owner_pick / golden).
    const snapshot = readChampionSnapshot(ctx.paths);
    if (!snapshot.ok) throw new IntegrityError(snapshot.error);
    io.note(join(ctx.paths.dir, CHAMPION_SNAPSHOT));
    const championKind = snapshot.value.kind;
    const aux = existsSync(pairsFilePath(ctx.paths, 'aux')) ? readPairs(ctx, io, 'aux') : null;
    const championPairs = champion.pairs
      .filter((p) => p.kind === 'champion')
      .map((p) => ({ pair: p.id, submission: p.left, sessions: pairVerdicts(ctx.root, ctx.roundId, p.id) }));
    const auxPairs: RoundTallyInput['auxPairs'][number][] = (aux?.pairs ?? []).map((p) => {
      if (p.kind === 'champion') throw new IntegrityError(`${AUX_PAIRS_FILE}: champion pair ${p.id} in the aux index`);
      return { pair: p.id, kind: p.kind, left: p.left, right: p.right, sessions: pairVerdicts(ctx.root, ctx.roundId, p.id) };
    });
    for (const path of tasteFiles(ctx.paths.taste)) io.note(path);

    const round = readRoundSurprise(ctx, io, bench.measures.surprise.active);
    const measures: Record<string, SubmissionMeasures> = {};
    const colds: Record<string, ColdRead | null> = {};
    const acceptorReused: Record<string, boolean> = {};
    const gate: Record<string, GateOutcome> = {};
    for (const c of candidates) {
      const cold = coldReader(ctx, io, c.id);
      const surprise = surpriseOf(ctx, round, c.id);
      acceptorReused[c.id] = surprise.acceptorReused;
      colds[c.id] = cold.read;
      gate[c.id] = c.sub.gate.outcome;
      measures[c.id] = {
        hook: hook(ctx, io, c.id, bench.measures.hook.active),
        skin_swap: skinSwap(ctx, io, c.id),
        cold_reader: { status: cold.status, clarity: cold.read === null ? null : cold.read.clarity },
        interface: producer(ctx, io, c.id),
        surprise: surprise.summary,
      };
    }

    const cost = allCallsCost(ctx);
    const calls = Object.values(cost.by_backend).reduce((sum, b) => sum + b.attempts, 0);
    const tally = buildRoundTally({
      round: ctx.roundId,
      benchmark: bench.version,
      champion: championKind,
      sessionPairs: ctx.protocol.bars.sessionPairs,
      barFourFamilies: ctx.rules.barFourFamilies,
      labels: labelOf,
      championPairs,
      auxPairs,
      gate,
      measures,
      voids: voidCounts(ctx, calls, championPairs.map((p) => p.sessions)),
    });
    const card = buildCard({
      round: ctx.roundId,
      rowId: brief.row_id,
      benchmark: bench.version,
      champion: championKind,
      tally,
      unseal: round.unseal,
      submissions: candidates.map((c) => ({ ...c.sub, label: label(c.id), cold: colds[c.id] ?? null, acceptorReused: acceptorReused[c.id] ?? false })),
    });
    const wild: WildSeedsFile = { round: ctx.roundId, seeds: sortedRecord(Object.fromEntries(candidates.map((c) => [c.id, c.seeds]))) };
    const outputs = [
      ctx.files.writeJson(join(ctx.paths.dir, 'labels.json'), sortedRecord(labels)),
      ctx.files.writeJson(join(ctx.paths.dir, 'tally.json'), tally),
      ctx.files.writeJson(join(ctx.paths.dir, 'cost.json'), cost),
      ctx.files.writeJson(join(ctx.paths.dir, 'card.json'), card),
      ctx.files.writeJson(join(ctx.paths.dir, 'wild-seeds.json'), wild),
    ];
    return { kind: 'done', inputs: io.list(), outputs, external: [] };
  },
};
