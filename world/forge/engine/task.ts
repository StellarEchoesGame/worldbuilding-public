import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Backend, CallResult } from './adapters/types.ts';
import { callWithRetry, IntegrityError, QuotaExhausted, readRecordedCall, type Attempted, type CallRetryOptions } from './calls.ts';
import { isFamily, type Family } from './config.ts';
import type { Limiter, QuotaPolicy, RoundBackends, RoundFiles, RunHooks, StepContext, Timeouts } from './context.ts';
import { isRecord, readNumber, readString, stringArray } from './json.ts';
import type { Clock } from './ports.ts';
import { err, ok, type Result } from './result.ts';
import { abortable, activeRun, guardedHooks, throwIfAborted } from './runner.ts';
import { isIsoTimestamp, sha256, type ProgressStatus, type RoundPaths } from './store.ts';

export { QuotaExhausted };

/**
 * One LLM task. `id` is the provenance label (TASK_ID; convention
 * `<kind>-<subject>-<family or backendId>[-s<k>[r]-<fwd|rev>][-rerun|-re|-2|-t<n>]`, subjects are slot ids).
 * `parse` owns the one-fenced-block rule and returns ASCII error strings; `retryPrompt` (writers, baseline,
 * decoy, defect, merge editor, maintainer) builds attempt 2 from the validation error; judges leave it unset.
 */
export interface TaskSpec<T> {
  id: string;
  role: string;
  prompt: string;
  parse: (text: string) => Result<T>;
  retryPrompt?: (error: string) => string;
}

/** `tasks/<id>.json` (sealed tasks: `.sealed/RNN/tasks/<id>.json`). On resume `spec.parse(text)` rebuilds T. */
export interface TaskRecord {
  id: string;
  backend: string;
  family: Family;
  model: string;
  role_sha256: string;
  /** Hash of the first prompt only; the retry prompt's hash is in its call record. */
  prompt_sha256: string;
  status: 'ok' | 'void';
  attempts: number;
  /** Redacted ASCII error of the last failure, else null. */
  error: string | null;
  /** The accepted raw output ('' when void). */
  text: string;
  text_sha256: string;
  served_model: string | null;
  version: string | null;
  /** Call labels `<id>-a1`, `<id>-a2` (quota tries `-a<k>-q<n>` are not listed). */
  calls: string[];
  finished_at: string;
}

export const TASK_ID: RegExp = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/u;

/** A stored record whose prompt, role or backend differs, or a tampered output (exit 3). */
export { IntegrityError };

/**
 * The part of StepContext the task runner uses (a StepContext always satisfies it; unit tests build it
 * directly). `files` is the only writer; `redact` is applied to every error before it is written.
 */
export interface TaskContext {
  paths: RoundPaths;
  files: RoundFiles;
  backends: Pick<RoundBackends, 'judges' | 'maintainer' | 'mergeEditor'>;
  ports: { clock: Clock };
  timeouts: Timeouts;
  quota: QuotaPolicy;
  hooks: RunHooks;
  limiters: ReadonlyMap<string, Limiter>;
  redact(text: string): string;
  log(message: string): void;
  progress(step: string, status: ProgressStatus, detail: string): void;
}

/** Judges → judgeMs; maintainer and merge editor → maintainerMs; gateway writers, decoy, defect → writerMs. */
export function timeoutFor(ctx: Pick<TaskContext, 'backends' | 'timeouts'>, backend: Backend): number {
  if (backend.id === ctx.backends.maintainer.id || backend.id === ctx.backends.mergeEditor.id) return ctx.timeouts.maintainerMs;
  if (ctx.backends.judges.some((j) => j.backend.id === backend.id)) return ctx.timeouts.judgeMs;
  return ctx.timeouts.writerMs;
}

/** Run-scoped controls the runner supplies for one task. */
export interface TaskRunControl {
  /** Throws (runner.ts RunAborted) once a sibling job crashed; called before every backend call and quota wait. */
  checkpoint(): void;
  /**
   * Runs one backend call (inside the limiter): refuses to start after a sibling crashed, and a throw marks the
   * run aborted before the limiter wakes the next queued job (runner.ts `abortable`).
   */
  guard<T>(fn: () => Promise<T>): Promise<T>;
  /** The hooks callWithRetry fires: a throwing hook marks the run aborted synchronously (runner.ts `guardedHooks`). */
  hooks(ctx: TaskContext): RunHooks;
  /** `n` of `tasks/stale/<n>/` when the run was started with `--redo-from`, else null. */
  redoStale: number | null;
  /** The task record this task wrote or reused (the runner counts a step's records into its marker). */
  recorded(path: string): void;
}

/** Outside runSteps (a unit test, a CLI helper): never aborted, no redo, the context's own hooks. */
export const NO_RUN_CONTROL: TaskRunControl = { checkpoint: () => undefined, guard: (fn) => fn(), hooks: (ctx) => ctx.hooks, redoStale: null, recorded: () => undefined };

function stepControl(ctx: StepContext): TaskRunControl {
  return {
    checkpoint: () => throwIfAborted(ctx),
    guard: (fn) => abortable(ctx, fn),
    hooks: () => guardedHooks(ctx),
    redoStale: activeRun(ctx)?.redoStale ?? null,
    recorded: (path) => activeRun(ctx)?.taskRecords.add(path),
  };
}

export type TaskPlace = 'round' | 'sealed';

interface TaskDirs {
  /** calls/ and .runs/ of this task kind (sealed: under `.sealed/RNN/`). */
  paths: RoundPaths;
  tasks: string;
  sealed: boolean;
}

function taskDirs(ctx: TaskContext, place: TaskPlace): TaskDirs {
  if (place === 'round') return { paths: ctx.paths, tasks: ctx.paths.tasks, sealed: false };
  const paths: RoundPaths = { ...ctx.paths, calls: join(ctx.paths.sealed, 'calls'), runs: join(ctx.paths.sealed, 'runs') };
  return { paths, tasks: ctx.paths.sealedTasks, sealed: true };
}

/**
 * validate id → reuse record (hash + backend check, else IntegrityError; under `--redo-from` a mismatching
 * record moves to `tasks/stale/<n>/`) → limiter(backend) → callWithRetry (recovery, quota backoff, hooks,
 * redaction, abort checkpoint) → write TaskRecord → progress.
 */
export function runTask<T>(ctx: StepContext, backend: Backend, spec: TaskSpec<T>): Promise<Attempted<T>> {
  return runTaskWith(ctx, stepControl(ctx), backend, spec, 'round');
}

/**
 * As runTask, but records, call files and transcripts live under `.sealed/RNN/`; nothing is written under
 * `rounds/` (progress goes to ctx.log instead of progress.jsonl).
 */
export function runSealedTask<T>(ctx: StepContext, backend: Backend, spec: TaskSpec<T>): Promise<Attempted<T>> {
  return runTaskWith(ctx, stepControl(ctx), backend, spec, 'sealed');
}

/** runTask / runSealedTask on the narrower TaskContext with explicit run controls (unit tests use NO_RUN_CONTROL). */
/**
 * Another step's stored record of `spec`, rebuilt without any call and checked like runTask's reuse; null when
 * absent; IntegrityError when it does not match. The reading step's marker does not count it (03b reads 03a's).
 */
export function storedTaskResult<T>(ctx: TaskContext, backend: Backend, spec: TaskSpec<T>, place: TaskPlace): Attempted<T> | null {
  const recordPath = join(taskDirs(ctx, place).tasks, `${spec.id}.json`);
  const stored = readTaskRecord(recordPath);
  if (stored === null) return null;
  const checked = checkStored(ctx, backend, spec, stored);
  if (checked.kind === 'reuse') return checked.result;
  throw new IntegrityError(`task record ${ctx.files.rel(recordPath)} ${checked.detail}`);
}

export function runTaskWith<T>(ctx: TaskContext, control: TaskRunControl, backend: Backend, spec: TaskSpec<T>, place: TaskPlace): Promise<Attempted<T>> {
  return run(ctx, control, backend, spec, taskDirs(ctx, place));
}

function report(ctx: TaskContext, dirs: TaskDirs, status: ProgressStatus, detail: string): void {
  const safe = ctx.redact(detail);
  if (dirs.sealed) ctx.log(`sealed task ${safe}`);
  else ctx.progress('task', status, safe);
}

function lastFromRecord(rec: TaskRecord): CallResult {
  return {
    ok: rec.status === 'ok', text: rec.text, servedModel: rec.served_model, version: rec.version,
    ms: 0, tokensIn: null, tokensOut: null, costUsd: null, error: rec.error, raw: '',
  };
}

type Stored<T> = { kind: 'reuse'; result: Attempted<T> } | { kind: 'mismatch'; detail: string };

/** A stored record is reused only for the same id, backend, prompt and role, with intact text that still parses. */
function checkStored<T>(ctx: TaskContext, backend: Backend, spec: TaskSpec<T>, stored: Result<TaskRecord>): Stored<T> {
  if (!stored.ok) return { kind: 'mismatch', detail: `is malformed: ${stored.error}` };
  const rec = stored.value;
  const problems: string[] = [];
  if (rec.id !== spec.id) problems.push('id');
  if (rec.backend !== backend.id) problems.push(`backend ${rec.backend} (now ${backend.id})`);
  if (rec.model !== backend.model) problems.push(`model ${rec.model} (now ${backend.model})`);
  if (rec.family !== backend.family) problems.push(`family ${rec.family} (now ${backend.family})`);
  if (rec.prompt_sha256 !== sha256(spec.prompt)) problems.push('prompt_sha256');
  if (rec.role_sha256 !== sha256(spec.role)) problems.push('role_sha256');
  if (rec.text_sha256 !== sha256(rec.text)) problems.push('text_sha256');
  if (problems.length > 0) return { kind: 'mismatch', detail: `does not match its task: ${problems.join(', ')}` };
  if (rec.status === 'void') return { kind: 'reuse', result: { value: null, error: rec.error, attempts: rec.attempts, last: lastFromRecord(rec) } };
  const v = spec.parse(rec.text);
  if (!v.ok) return { kind: 'mismatch', detail: `no longer parses: ${ctx.redact(v.error)}` };
  return { kind: 'reuse', result: { value: v.value, error: null, attempts: rec.attempts, last: lastFromRecord(rec) } };
}

/** A recorded attempt of this task on this backend with the prompt it would send now; anything else is called afresh. */
function recoverChecked(ctx: TaskContext, dirs: TaskDirs, backend: Backend, id: string, attempt: 1 | 2, prompt: string): CallResult | null {
  const rec = readRecordedCall(dirs.paths, `${id}-a${attempt}`);
  if (rec === null) return null;
  if (rec.backend !== backend.id || rec.model !== backend.model || rec.family !== backend.family || rec.promptSha256 !== sha256(prompt)) {
    ctx.log(`task ${id}: recorded attempt ${attempt} is for another backend, model or prompt; calling afresh`);
    return null;
  }
  return rec.result;
}

/** `<id>-a1`, `<id>-a2` and quota tries `<id>-a<k>-q<n>`: the call labels of task `id`. */
function isCallLabelOf(id: string, label: string): boolean {
  return label.startsWith(`${id}-a`) && /^[12](?:-q[1-9][0-9]*)?$/u.test(label.slice(id.length + 2));
}

/**
 * Under `--redo-from`, the call records, outputs and raw transcripts of a task whose record went stale move to
 * `calls/stale/<n>/` and `.runs/…/stale/<n>/`: the fresh calls reuse the labels, and the paid calls stay as cost
 * and provenance evidence instead of being overwritten. Returns how many files moved.
 */
function moveCallsToStale(ctx: TaskContext, dirs: TaskDirs, id: string, n: number): number {
  let moved = 0;
  const places: ReadonlyArray<readonly [string, string]> = [[dirs.paths.calls, '.json'], [dirs.paths.runs, '.out.txt'], [dirs.paths.runs, '.txt']];
  for (const [dir, ext] of places) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(ext) || !isCallLabelOf(id, name.slice(0, -ext.length))) continue;
      ctx.files.move(join(dir, name), join(dir, 'stale', String(n), name));
      moved += 1;
    }
  }
  return moved;
}

async function run<T>(ctx: TaskContext, control: TaskRunControl, backend: Backend, spec: TaskSpec<T>, dirs: TaskDirs): Promise<Attempted<T>> {
  if (!TASK_ID.test(spec.id)) throw new Error(`invalid task id: ${JSON.stringify(spec.id)}`);
  const recordPath = join(dirs.tasks, `${spec.id}.json`);
  const stored = readTaskRecord(recordPath);
  if (stored !== null) {
    const checked = checkStored(ctx, backend, spec, stored);
    if (checked.kind === 'reuse') {
      control.recorded(recordPath);
      return checked.result;
    }
    const what = `task record ${ctx.files.rel(recordPath)} ${checked.detail}`;
    if (control.redoStale === null) throw new IntegrityError(what);
    const moved = ctx.files.move(recordPath, join(dirs.tasks, 'stale', String(control.redoStale), `${spec.id}.json`));
    const calls = moveCallsToStale(ctx, dirs, spec.id, control.redoStale);
    ctx.log(`${what}; moved to ${moved} with ${calls} call file(s) (--redo-from), calling afresh`);
  }
  const opts: CallRetryOptions = {
    checkpoint: () => control.checkpoint(),
    recover: (attempt, prompt) => recoverChecked(ctx, dirs, backend, spec.id, attempt, prompt),
    quota: ctx.quota,
    sleep: (ms) => ctx.ports.clock.sleep(ms),
    now: () => ctx.ports.clock.now(),
    hooks: control.hooks(ctx),
    files: ctx.files,
    redact: (text) => ctx.redact(text),
    onQuota: (label, delayMs, error) => report(ctx, dirs, 'info', `${label}: quota, waiting ${Math.round(delayMs / 1000)} s: ${error}`),
  };
  const retryPrompt = spec.retryPrompt;
  if (retryPrompt !== undefined) opts.retryPrompt = retryPrompt;
  const call = (): Promise<Attempted<T>> => control.guard(() => callWithRetry(dirs.paths, backend, spec.id, spec.prompt, spec.role, timeoutFor(ctx, backend), spec.parse, opts));
  const limit = ctx.limiters.get(backend.id);
  let r: Attempted<T>;
  try {
    r = limit === undefined ? await call() : await limit(call);
  } catch (e) {
    if (e instanceof QuotaExhausted) report(ctx, dirs, 'error', `${spec.id}: ${e.message}`);
    throw e;
  }
  const done = r.value !== null;
  const text = done ? (r.last?.text ?? '') : '';
  const error = done ? null : ctx.redact(r.error ?? 'void');
  const record: TaskRecord = {
    id: spec.id,
    backend: backend.id,
    family: backend.family,
    model: backend.model,
    role_sha256: sha256(spec.role),
    prompt_sha256: sha256(spec.prompt),
    status: done ? 'ok' : 'void',
    attempts: r.attempts,
    error,
    text,
    text_sha256: sha256(text),
    served_model: r.last?.servedModel ?? null,
    version: r.last?.version ?? null,
    calls: Array.from({ length: r.attempts }, (_, i) => `${spec.id}-a${i + 1}`),
    finished_at: ctx.ports.clock.now(),
  };
  ctx.files.writeJson(recordPath, record);
  control.recorded(recordPath);
  report(ctx, dirs, done ? 'info' : 'error', done ? `${spec.id}: ok after ${r.attempts} attempt(s)` : `${spec.id}: void: ${error ?? 'void'}`);
  return { ...r, error };
}

const HEX64 = /^[0-9a-f]{64}$/u;

function readStringOrNull(rec: Record<string, unknown>, key: string): { ok: true; value: string | null } | { ok: false } {
  const v = rec[key];
  if (v === null) return { ok: true, value: null };
  return typeof v === 'string' ? { ok: true, value: v } : { ok: false };
}

/** Parses a task record; every field is required (null where the type allows it). */
export function parseTaskRecord(value: unknown): Result<TaskRecord> {
  if (!isRecord(value)) return err('task record must be an object');
  const id = readString(value, 'id');
  if (id === null || !TASK_ID.test(id)) return err('id must be a task id');
  const backend = readString(value, 'backend');
  const family = readString(value, 'family');
  const model = readString(value, 'model');
  if (backend === null || model === null) return err('backend and model must be strings');
  if (family === null || !isFamily(family)) return err('family must be a known family');
  const roleSha = readString(value, 'role_sha256');
  const promptSha = readString(value, 'prompt_sha256');
  const textSha = readString(value, 'text_sha256');
  if (roleSha === null || promptSha === null || textSha === null || ![roleSha, promptSha, textSha].every((h) => HEX64.test(h))) {
    return err('role_sha256, prompt_sha256 and text_sha256 must be SHA-256 hex');
  }
  const status = readString(value, 'status');
  if (status !== 'ok' && status !== 'void') return err('status must be ok or void');
  const attempts = readNumber(value, 'attempts');
  if (attempts !== 1 && attempts !== 2) return err('attempts must be 1 or 2');
  const error = readStringOrNull(value, 'error');
  const served = readStringOrNull(value, 'served_model');
  const version = readStringOrNull(value, 'version');
  if (!error.ok || !served.ok || !version.ok) return err('error, served_model and version must be strings or null');
  const text = readString(value, 'text');
  if (text === null) return err('text must be a string');
  const calls = stringArray(value['calls']);
  if (calls === null || calls.length !== attempts || !calls.every((c, i) => c === `${id}-a${i + 1}`)) return err('calls must list <id>-a1 … <id>-a<attempts>');
  const finishedAt = readString(value, 'finished_at');
  if (finishedAt === null || !isIsoTimestamp(finishedAt)) return err('finished_at must be an ISO timestamp');
  return ok({
    id, backend, family, model, role_sha256: roleSha, prompt_sha256: promptSha, status, attempts, error: error.value, text,
    text_sha256: textSha, served_model: served.value, version: version.value, calls, finished_at: finishedAt,
  });
}

/** null when absent; err when present but malformed. */
export function readTaskRecord(path: string): Result<TaskRecord> | null {
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return err('task record is not JSON');
  }
  return parseTaskRecord(value);
}
