import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readChampions, setBaselineChampion, type Champion } from '../champions.ts';
import type { StepContext } from '../context.ts';
import { isRecord, readArray, readNumber, readString } from '../json.ts';
import type { StepDef, StepOutcome } from '../runner.ts';
import { sha256 } from '../store.ts';
import { CHAMPION_ID, displayText, loadSubmission } from '../submission.ts';
import { IntegrityError, runTask } from '../task.ts';
import { BASELINE_TASK_ID, baselineTask, canonSentences } from '../tasks/writing.ts';
import { readBriefJson } from './brief.ts';

/** One void step attempt of 02b (`attempts/02b-baseline.json`); the next attempt calls afresh as `-t<n+1>`. */
export interface StepAttempt {
  n: number;
  task: string;
  status: 'void';
  error: string | null;
  at: string;
}

const STEP = '02b-baseline';

function attemptsPath(ctx: StepContext): string {
  return join(ctx.paths.dir, 'attempts', `${STEP}.json`);
}

/** Recorded void attempts, oldest first (missing file → []). A malformed file is an integrity error. */
export function readAttempts(ctx: StepContext): StepAttempt[] {
  const path = attemptsPath(ctx);
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new IntegrityError(`rounds/${ctx.roundId}/attempts/${STEP}.json is not JSON`);
  }
  const list = readArray(raw, 'attempts');
  if (list === null) throw new IntegrityError(`rounds/${ctx.roundId}/attempts/${STEP}.json: attempts[] is required`);
  const out: StepAttempt[] = [];
  for (const a of list) {
    const n = readNumber(a, 'n');
    const task = readString(a, 'task');
    const at = readString(a, 'at');
    const error = isRecord(a) ? a['error'] : undefined;
    if (n !== out.length + 1 || task === null || at === null || readString(a, 'status') !== 'void' || (error !== null && typeof error !== 'string')) {
      throw new IntegrityError(`rounds/${ctx.roundId}/attempts/${STEP}.json: attempt ${out.length + 1} is malformed`);
    }
    out.push({ n, task, status: 'void', error: typeof error === 'string' ? error : null, at });
  }
  return out;
}

/** Task id of step attempt n: `baseline-BASE`, then `baseline-BASE-t2`, `-t3`, … */
export function baselineTaskId(n: number): string {
  return n <= 1 ? BASELINE_TASK_ID : `${BASELINE_TASK_ID}-t${n}`;
}

function done(ctx: StepContext, base: string): StepOutcome {
  return { kind: 'done', inputs: [ctx.files.rel(ctx.paths.brief)], outputs: [ctx.files.rel(base)], external: [ctx.files.rel(join(ctx.root, 'champions.json'))] };
}

/** A crash after champions.json: this round's champion must be the BASE.json it wrote first. */
function resumeAfterChampion(ctx: StepContext, champion: Champion, base: string): StepOutcome {
  const sub = loadSubmission(ctx.paths, CHAMPION_ID);
  if (champion.kind !== 'baseline' || champion.submission !== CHAMPION_ID || sub === null || sub.output === null) {
    throw new IntegrityError(`champions.json names ${ctx.roundId} for row ${champion.row_id}, but submissions/${CHAMPION_ID}.json is not its baseline`);
  }
  if (sha256(displayText(sub.output)) !== champion.text_sha256) {
    throw new IntegrityError(`champions.json row ${champion.row_id} does not match rounds/${ctx.roundId}/submissions/${CHAMPION_ID}.json`);
  }
  ctx.progress(STEP, 'info', `champion of ${champion.row_id} already set by this round`);
  return done(ctx, base);
}

/**
 * 02b-baseline (a row's first freeze only): skip when another round set the row's champion; otherwise one strict
 * baseline task (verbatim canon sentences, `authors: [baseline family]`), `submissions/BASE.json` first, then the
 * `champions.json` entry (external). Void → failed (exit 5) with the attempt recorded, so the rerun calls afresh
 * under `-t<n>` and the void record stays as evidence. No champion is ever invented.
 */
export const baselineStep: StepDef = {
  id: '02b-baseline',
  run: async (ctx) => {
    const brief = readBriefJson(ctx);
    const champions = readChampions(ctx.root);
    if (!champions.ok) throw new IntegrityError(`champions.json: ${champions.error}`);
    const base = join(ctx.paths.submissions, `${CHAMPION_ID}.json`);
    const current = champions.value[brief.row_id];
    if (current !== undefined && current.round !== ctx.roundId) {
      return { kind: 'skip', reason: `row ${brief.row_id} already has a ${current.kind} champion set by ${current.round}` };
    }
    if (current !== undefined) return resumeAfterChampion(ctx, current, base);
    const sentences = canonSentences(brief);
    if (sentences.length === 0) return { kind: 'failed', detail: 'baseline_missing: the brief has no canon sentence to build a baseline from' };
    const attempts = readAttempts(ctx);
    const n = attempts.length + 1;
    const spec = { ...baselineTask(brief, sentences, ctx.protocol.connectives), id: baselineTaskId(n) };
    const backend = ctx.backends.baseline;
    const r = await runTask(ctx, backend, spec);
    if (r.value === null) {
      const attempt: StepAttempt = { n, task: spec.id, status: 'void', error: r.error, at: ctx.ports.clock.now() };
      ctx.files.writeJson(attemptsPath(ctx), { step: STEP, attempts: [...attempts, attempt] });
      return { kind: 'failed', detail: `baseline_missing: ${spec.id} is void (${r.error ?? 'void'}); a rerun calls afresh as ${baselineTaskId(n + 1)}` };
    }
    ctx.files.writeJson(base, {
      id: CHAMPION_ID,
      kind: 'baseline',
      task: spec.id,
      model: backend.model,
      served_model: r.last?.servedModel ?? null,
      family: backend.family,
      stance: null,
      skill: null,
      ok: true,
      error: null,
      attempts: r.attempts,
      text: r.last?.text ?? '',
    });
    const text = displayText(r.value);
    const champion: Champion = {
      row_id: brief.row_id,
      kind: 'baseline',
      round: ctx.roundId,
      submission: CHAMPION_ID,
      family: backend.family,
      authors: [backend.family],
      text,
      text_sha256: sha256(text),
      set_at: ctx.ports.clock.now(),
      previous: [],
    };
    const set = setBaselineChampion(ctx.files, champion);
    if (!set.ok) return { kind: 'failed', detail: `champions.json: ${set.error}` };
    ctx.progress(STEP, 'info', `baseline champion of ${brief.row_id} set (${spec.id})`);
    return done(ctx, base);
  },
};
