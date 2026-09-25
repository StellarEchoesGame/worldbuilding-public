import { existsSync, readFileSync } from 'node:fs';
import type { Backend } from './adapters/types.ts';
import { anonymizeText, assignLabels } from './anonymize.ts';
import { baselinePrompt, cellToJson, WRITER_ROLE, writerPrompt, type Canon, type Cell } from './brief.ts';
import type { Family } from './config.ts';
import { buildFreeze, diffFreeze, parseFreeze, type FreezeRecord } from './freeze.ts';
import { mechanicalGate, type ForbiddenWord, type GateLimits, type GateResult } from './gate.ts';
import { isRecord, readBoolean, readNumber, readString } from './json.ts';
import { callWithRetry, limiter } from './calls.ts';
import { err, ok } from './result.ts';
import { progress, readJson, roundPaths, seeded, seededShuffle, writeJson, type RoundPaths } from './store.ts';
import { tallyChampionPair, type PairTally, type SessionPair } from './tally.ts';
import { parseVerdict, tastePrompt, type Benchmark, type Pick, type Verdict } from './taste.ts';
import { parseWriterOutput, type WriterOutput } from './writer-output.ts';

export interface JudgeSlot {
  backend: Backend;
  concurrency: number;
}

/** Gate rules taken from the PROTOCOL.md `limits`, `forbidden-words`, `negations` and `negation-exceptions` blocks. */
export interface RoundRules {
  limits: GateLimits;
  forbidden: readonly ForbiddenWord[];
  negations: readonly string[];
  negationExceptions: readonly string[];
  /** Wins needed when four families are eligible: the stricter of the protocol and benchmark bars. */
  barFourFamilies: 7 | 8;
}

/** Raw inputs pinned by content hash in freeze.json when a round starts. */
export interface RoundPins {
  benchmarkText: string;
  writersText: string;
  protocolBundleSha256: string;
}

export interface RoundDeps {
  root: string;
  cell: Cell;
  canon: Canon;
  bench: Benchmark;
  seed: string;
  sessionPairs: number;
  writers: Backend[];
  baselineWriter: Backend;
  judges: JudgeSlot[];
  judgeTimeoutMs: number;
  writerTimeoutMs: number;
  rules: RoundRules;
  pins: RoundPins;
  log: (message: string) => void;
}

export const CHAMPION_ID = 'BASE';

export interface LoadedSubmission {
  id: string;
  kind: 'writer' | 'baseline';
  model: string;
  family: string;
  stance: string | null;
  ok: boolean;
  error: string | null;
  output: WriterOutput | null;
}

function loadSubmission(paths: RoundPaths, id: string): LoadedSubmission | null {
  const rec = readJson(`${paths.submissions}/${id}.json`);
  const kind = readString(rec, 'kind');
  const model = readString(rec, 'model');
  const family = readString(rec, 'family');
  if (kind === null || model === null || family === null || (kind !== 'writer' && kind !== 'baseline')) return null;
  const text = readString(rec, 'text') ?? '';
  const parsed = readBoolean(rec, 'ok') === true ? parseWriterOutput(text) : null;
  return {
    id,
    kind,
    model,
    family,
    stance: readString(rec, 'stance'),
    ok: parsed !== null && parsed.ok,
    error: parsed !== null && !parsed.ok ? parsed.error : readString(rec, 'error'),
    output: parsed !== null && parsed.ok ? parsed.value : null,
  };
}

async function writeStep(deps: RoundDeps, paths: RoundPaths): Promise<void> {
  const jobs: Array<{ backend: Backend; kind: 'writer' | 'baseline'; stance: string | null; prompt: string }> = [];
  deps.writers.forEach((backend, i) => {
    const stance = deps.cell.stances.length === 0 ? null : (deps.cell.stances[i % deps.cell.stances.length]?.id ?? null);
    jobs.push({ backend, kind: 'writer', stance, prompt: writerPrompt(deps.cell, deps.canon, stance ?? '') });
  });
  jobs.push({ backend: deps.baselineWriter, kind: 'baseline', stance: null, prompt: baselinePrompt(deps.cell, deps.canon) });
  await Promise.all(
    jobs.map(async (job) => {
      const id = job.kind === 'baseline' ? CHAMPION_ID : job.backend.id;
      const existing = loadSubmission(paths, id);
      if (existing !== null && existing.ok) return;
      progress(paths, 'write', 'start', `${id} (${job.backend.model})`);
      const r = await callWithRetry(paths, job.backend, `write-${id}`, job.prompt, WRITER_ROLE, deps.writerTimeoutMs, (text) => {
        const parsed = parseWriterOutput(text);
        return parsed.ok ? ok(text) : err(parsed.error);
      });
      writeJson(`${paths.submissions}/${id}.json`, {
        id,
        kind: job.kind,
        model: job.backend.model,
        served_model: r.last?.servedModel ?? null,
        family: job.backend.family,
        stance: job.stance,
        ok: r.value !== null,
        error: r.error,
        attempts: r.attempts,
        text: r.value ?? r.last?.text ?? '',
      });
      progress(paths, 'write', r.value !== null ? 'done' : 'error', `${id}${r.error === null ? '' : `: ${r.error}`}`);
    }),
  );
}

function gateStep(deps: RoundDeps, paths: RoundPaths): Record<string, GateResult> {
  const results: Record<string, GateResult> = {};
  for (const id of [...deps.writers.map((w) => w.id), CHAMPION_ID]) {
    const sub = loadSubmission(paths, id);
    if (sub === null || sub.output === null) continue;
    results[id] = mechanicalGate(sub.output, {
      baseline: sub.kind === 'baseline',
      limits: deps.rules.limits,
      forbidden: deps.rules.forbidden,
      negations: deps.rules.negations,
      negationExceptions: deps.rules.negationExceptions,
    });
  }
  writeJson(`${paths.dir}/gate.json`, results);
  progress(paths, 'gate', 'done', Object.entries(results).map(([id, g]) => `${id}:${g.pass ? '通过' : '未过'}`).join(' '));
  return results;
}

/** The text judges and the owner see: Markdown and typographic tells removed. */
export function displayText(out: WriterOutput): string {
  return anonymizeText(out.submission);
}

interface TasteRecord {
  ok: boolean;
  pick: Pick | null;
}

function loadTaste(path: string): TasteRecord | null {
  const rec = readJson(path);
  const okFlag = readBoolean(rec, 'ok');
  if (okFlag === null) return null;
  const pick = readNumber(rec, 'decisive_pick');
  return { ok: okFlag, pick: pick === 1 || pick === 2 ? pick : null };
}

async function tasteStep(deps: RoundDeps, paths: RoundPaths, candidates: LoadedSubmission[], champion: LoadedSubmission): Promise<void> {
  if (champion.output === null) return;
  const championText = displayText(champion.output);
  const limits = new Map(deps.judges.map((j) => [j.backend.id, limiter(j.concurrency)]));
  const tasks: Array<Promise<void>> = [];
  for (const cand of candidates) {
    if (cand.output === null) continue;
    const candText = displayText(cand.output);
    for (const judge of deps.judges) {
      if (judge.backend.family === cand.family || judge.backend.family === champion.family) continue;
      const limit = limits.get(judge.backend.id);
      if (limit === undefined) continue;
      for (let s = 0; s < deps.sessionPairs; s += 1) {
        for (const order of ['fwd', 'rev']) {
          const path = `${paths.taste}/${cand.id}/${judge.backend.id}-s${s}-${order}.json`;
          const existing = loadTaste(path);
          if (existing !== null && existing.ok) continue;
          const [t1, t2] = order === 'fwd' ? [candText, championText] : [championText, candText];
          const prompt = tastePrompt(deps.bench, t1, t2);
          tasks.push(
            limit(async () => {
              const label = `taste-${cand.id}-${judge.backend.id}-s${s}-${order}`;
              const r = await callWithRetry(paths, judge.backend, label, prompt, deps.bench.role, deps.judgeTimeoutMs, (text) => parseVerdict(text, deps.bench, t1, t2));
              const verdict: Verdict | null = r.value;
              writeJson(path, {
                candidate: cand.id,
                judge: judge.backend.id,
                family: judge.backend.family,
                session: s,
                order,
                ok: verdict !== null,
                error: r.error,
                attempts: r.attempts,
                decisive_pick: verdict === null ? null : (verdict.picks[deps.bench.decisive] ?? null),
                verdict,
                served_model: r.last?.servedModel ?? null,
                version: r.last?.version ?? null,
              });
              progress(paths, 'taste', verdict === null ? 'error' : 'info', `${label}${r.error === null ? '' : `: ${r.error}`}`);
            }),
          );
        }
      }
    }
  }
  progress(paths, 'taste', 'start', `${tasks.length} 次评委调用`);
  await Promise.all(tasks);
}

export interface CandidateTally {
  label: string;
  submission: string;
  tally: PairTally;
  sessions: SessionPair[];
}

function tallyStep(deps: RoundDeps, paths: RoundPaths, candidates: LoadedSubmission[], champion: LoadedSubmission): CandidateTally[] {
  const labels = stableLabels(paths, candidates.map((c) => c.id), deps.seed);
  writeJson(`${paths.dir}/labels.json`, labels);
  const out: CandidateTally[] = [];
  for (const [label, id] of Object.entries(labels)) {
    const cand = candidates.find((c) => c.id === id);
    if (cand === undefined) continue;
    const families: Family[] = [...new Set(deps.judges.map((j) => j.backend.family))].filter((f) => f !== cand.family && f !== champion.family);
    const sessions: SessionPair[] = [];
    for (const judge of deps.judges) {
      if (!families.includes(judge.backend.family)) continue;
      for (let s = 0; s < deps.sessionPairs; s += 1) {
        const fwd = loadTaste(`${paths.taste}/${id}/${judge.backend.id}-s${s}-fwd.json`);
        const rev = loadTaste(`${paths.taste}/${id}/${judge.backend.id}-s${s}-rev.json`);
        sessions.push({ family: judge.backend.family, index: s, forward: fwd?.pick ?? null, reverse: rev?.pick ?? null });
      }
    }
    out.push({ label, submission: id, tally: tallyChampionPair(sessions, families, { barFourFamilies: deps.rules.barFourFamilies }), sessions });
  }
  writeJson(`${paths.dir}/tally.json`, { benchmark: deps.bench.version, champion: CHAMPION_ID, session_pairs: deps.sessionPairs, candidates: out });
  progress(paths, 'tally', 'done', out.map((c) => `${c.label}:${c.tally.totalWins}/${c.tally.needed}${c.tally.beatsChampion ? ' 胜擂' : ''}`).join(' '));
  return out;
}

/** Keeps an existing label file when it names exactly these candidates, so labels never move under the owner. */
function stableLabels(paths: RoundPaths, ids: readonly string[], seed: string): Record<string, string> {
  const existing = readJson(`${paths.dir}/labels.json`);
  if (isRecord(existing)) {
    const kept: Record<string, string> = {};
    for (const [label, id] of Object.entries(existing)) if (typeof id === 'string') kept[label] = id;
    const keptIds = Object.values(kept).sort();
    const wanted = [...ids].sort();
    if (keptIds.length === wanted.length && keptIds.every((id, i) => id === wanted[i])) return kept;
  }
  const byId = assignLabels(ids, seed);
  return Object.fromEntries(Object.entries(byId).map(([id, label]) => [label, id]));
}

function auditStep(deps: RoundDeps, paths: RoundPaths, tallies: CandidateTally[]): void {
  const pairs = tallies.map((t, i) => {
    const swap = seeded(deps.seed, `audit:${t.label}`) < 0.5;
    return { id: `audit-${i + 1}`, left: swap ? CHAMPION_ID : t.label, right: swap ? t.label : CHAMPION_ID };
  });
  writeJson(`${paths.dir}/audit-set.json`, { pairs: seededShuffle(pairs, deps.seed, 'audit-order') });
  progress(paths, 'audit-set', 'done', `${pairs.length} 对盲审`);
}

function currentFreeze(deps: RoundDeps, paths: RoundPaths, roundId: string): FreezeRecord {
  return buildFreeze({
    round: roundId,
    files: {
      'BOOK.md': deps.canon.book,
      'REFERENCE.md': deps.canon.reference,
      'brief.json': readFileSync(`${paths.dir}/brief.json`, 'utf8'),
      benchmark: deps.pins.benchmarkText,
      'writers.json': deps.pins.writersText,
    },
    benchmarkVersion: deps.bench.version,
    eligibleFamilies: [...new Set(deps.judges.map((j) => j.backend.family))].sort(),
    flags: {},
    protocolBundleSha256: deps.pins.protocolBundleSha256,
    probeCreatedAt: null,
  });
}

/** Writes freeze.json for a new round; for an existing one, refuses to resume if any pinned input drifted. */
function freezeStep(deps: RoundDeps, paths: RoundPaths, roundId: string, isNew: boolean): void {
  const file = `${paths.dir}/freeze.json`;
  const current = currentFreeze(deps, paths, roundId);
  if (isNew) {
    writeJson(file, current);
    progress(paths, 'freeze', 'done', `benchmark ${current.benchmark_version}`);
    return;
  }
  if (!existsSync(file)) {
    deps.log(`注意：${roundId} 没有 freeze.json（原型轮次），续跑时不校验输入是否变化。`);
    return;
  }
  const pinned = parseFreeze(readJson(file));
  if (!pinned.ok) throw new Error(`round ${roundId}: freeze.json is invalid: ${pinned.error}`);
  const drift = diffFreeze(pinned.value, current);
  // The frozen family set decides the bar; a different judge set on resume would score against another bar.
  const was = [...pinned.value.eligible_families].sort().join('、');
  const now = current.eligible_families.join('、');
  if (was !== now) drift.push(`eligible families changed: ${was} → ${now}`);
  if (drift.length > 0) {
    progress(paths, 'freeze', 'error', drift.join('; '));
    throw new Error(`round ${roundId} inputs changed since it was frozen (${drift.join('; ')}); start a new round instead`);
  }
}

export async function runRound(deps: RoundDeps, roundId: string): Promise<CandidateTally[]> {
  const paths = roundPaths(deps.root, roundId);
  const isNew = readJson(`${paths.dir}/brief.json`) === null;
  if (isNew) {
    writeJson(`${paths.dir}/brief.json`, {
      round: roundId,
      kind: 'prototype',
      cell: cellToJson(deps.cell),
      canon: { book_sha256: deps.canon.bookSha256, reference_sha256: deps.canon.referenceSha256 },
      benchmark: { version: deps.bench.version, questions: deps.bench.questions, decisive: deps.bench.decisive },
      writers: deps.writers.map((w, i) => ({ id: w.id, model: w.model, stance: deps.cell.stances[i % Math.max(1, deps.cell.stances.length)]?.id ?? null })),
      baseline: { id: CHAMPION_ID, model: deps.baselineWriter.model },
      judges: deps.judges.map((j) => ({ id: j.backend.id, family: j.backend.family, model: j.backend.model })),
      seed: deps.seed,
      session_pairs: deps.sessionPairs,
      created_at: new Date().toISOString(),
    });
    progress(paths, 'brief', 'done', deps.cell.title);
  }
  freezeStep(deps, paths, roundId, isNew);
  deps.log('写手写稿中…');
  await writeStep(deps, paths);
  const gates = gateStep(deps, paths);
  const champion = loadSubmission(paths, CHAMPION_ID);
  if (champion === null || champion.output === null) {
    progress(paths, 'taste', 'error', '基线稿缺失，无法比较');
    throw new Error('baseline submission is missing; rerun the round to retry it');
  }
  const candidates = deps.writers
    .map((w) => loadSubmission(paths, w.id))
    .filter((s): s is LoadedSubmission => s !== null && s.output !== null && gates[s.id]?.pass === true);
  deps.log(`评委比较中：${candidates.length} 篇候选稿对基线…`);
  await tasteStep(deps, paths, candidates, champion);
  const tallies = tallyStep(deps, paths, candidates, champion);
  auditStep(deps, paths, tallies);
  progress(paths, 'round', 'done', '可以在 UI 中盲审和决策');
  return tallies;
}

export function submissionFor(root: string, roundId: string, id: string): LoadedSubmission | null {
  return loadSubmission(roundPaths(root, roundId), id);
}

