import type { Backend, CallResult } from './adapters/types.ts';
import { baselinePrompt, cellToJson, WRITER_ROLE, writerPrompt, type Canon, type Cell } from './brief.ts';
import type { Family } from './config.ts';
import { mechanicalGate, type GateResult } from './gate.ts';
import { readBoolean, readNumber, readString } from './json.ts';
import { err, ok, type Result } from './result.ts';
import { progress, readJson, roundPaths, seeded, seededShuffle, sha256, writeJson, writeText, type RoundPaths } from './store.ts';
import { tallyChampionPair, type PairTally, type SessionPair } from './tally.ts';
import { parseVerdict, tastePrompt, type Benchmark, type Pick, type Verdict } from './taste.ts';
import { stripMarkdown } from './text.ts';
import { parseWriterOutput, type WriterOutput } from './writer-output.ts';

export interface JudgeSlot {
  backend: Backend;
  concurrency: number;
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
  log: (message: string) => void;
}

export const CHAMPION_ID = 'BASE';
const LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

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

function limiter(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    while (active >= n) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}

function recordCall(paths: RoundPaths, label: string, backend: Backend, prompt: string, r: CallResult): void {
  writeJson(`${paths.calls}/${label}.json`, {
    label,
    backend: backend.id,
    family: backend.family,
    requested_model: backend.model,
    served_model: r.servedModel,
    version: r.version,
    ok: r.ok,
    error: r.error,
    ms: r.ms,
    tokens_in: r.tokensIn,
    tokens_out: r.tokensOut,
    cost_usd: r.costUsd,
    prompt_sha256: sha256(prompt),
    output_sha256: sha256(r.text),
    at: new Date().toISOString(),
  });
  writeText(`${paths.runs}/${label}.txt`, `${r.raw}\n\n=== prompt ===\n${prompt}\n`);
}

interface Attempted<T> {
  value: T | null;
  error: string | null;
  attempts: number;
  last: CallResult | null;
}

async function callWithRetry<T>(
  paths: RoundPaths,
  backend: Backend,
  label: string,
  prompt: string,
  role: string,
  timeoutMs: number,
  validate: (text: string) => Result<T>,
): Promise<Attempted<T>> {
  let error: string | null = null;
  let last: CallResult | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const r = await backend.call(prompt, { role, timeoutMs });
    last = r;
    recordCall(paths, `${label}-a${attempt}`, backend, prompt, r);
    if (!r.ok) {
      error = r.error;
      continue;
    }
    const v = validate(r.text);
    if (v.ok) return { value: v.value, error: null, attempts: attempt, last };
    error = v.error;
  }
  return { value: null, error, attempts: 2, last };
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
    results[id] = mechanicalGate(sub.output, { baseline: sub.kind === 'baseline' });
  }
  writeJson(`${paths.dir}/gate.json`, results);
  progress(paths, 'gate', 'done', Object.entries(results).map(([id, g]) => `${id}:${g.pass ? '通过' : '未过'}`).join(' '));
  return results;
}

export function displayText(out: WriterOutput): string {
  return stripMarkdown(out.submission);
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
          if (existing !== null) continue;
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
  const ordered = seededShuffle(candidates.map((c) => c.id), deps.seed, 'labels');
  const labels: Record<string, string> = {};
  ordered.forEach((id, i) => {
    labels[LABELS[i] ?? `X${i}`] = id;
  });
  writeJson(`${paths.dir}/labels.json`, labels);
  const out: CandidateTally[] = [];
  for (const [label, id] of Object.entries(labels)) {
    const cand = candidates.find((c) => c.id === id);
    if (cand === undefined) continue;
    const families: Family[] = deps.judges.map((j) => j.backend.family).filter((f) => f !== cand.family && f !== champion.family);
    const sessions: SessionPair[] = [];
    for (const judge of deps.judges) {
      if (!families.includes(judge.backend.family)) continue;
      for (let s = 0; s < deps.sessionPairs; s += 1) {
        const fwd = loadTaste(`${paths.taste}/${id}/${judge.backend.id}-s${s}-fwd.json`);
        const rev = loadTaste(`${paths.taste}/${id}/${judge.backend.id}-s${s}-rev.json`);
        sessions.push({ family: judge.backend.family, index: s, forward: fwd?.pick ?? null, reverse: rev?.pick ?? null });
      }
    }
    out.push({ label, submission: id, tally: tallyChampionPair(sessions, families), sessions });
  }
  writeJson(`${paths.dir}/tally.json`, { benchmark: deps.bench.version, champion: CHAMPION_ID, session_pairs: deps.sessionPairs, candidates: out });
  progress(paths, 'tally', 'done', out.map((c) => `${c.label}:${c.tally.totalWins}/${c.tally.needed}${c.tally.beatsChampion ? ' 胜擂' : ''}`).join(' '));
  return out;
}

function auditStep(deps: RoundDeps, paths: RoundPaths, tallies: CandidateTally[]): void {
  const pairs = tallies.map((t, i) => {
    const swap = seeded(deps.seed, `audit:${t.label}`) < 0.5;
    return { id: `audit-${i + 1}`, left: swap ? CHAMPION_ID : t.label, right: swap ? t.label : CHAMPION_ID };
  });
  writeJson(`${paths.dir}/audit-set.json`, { pairs: seededShuffle(pairs, deps.seed, 'audit-order') });
  progress(paths, 'audit-set', 'done', `${pairs.length} 对盲审`);
}

export async function runRound(deps: RoundDeps, roundId: string): Promise<CandidateTally[]> {
  const paths = roundPaths(deps.root, roundId);
  if (readJson(`${paths.dir}/brief.json`) === null) {
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

export function readRoundFile(root: string, roundId: string, name: string): unknown {
  return readJson(`${roundPaths(root, roundId).dir}/${name}`);
}

export function submissionFor(root: string, roundId: string, id: string): LoadedSubmission | null {
  return loadSubmission(roundPaths(root, roundId), id);
}

