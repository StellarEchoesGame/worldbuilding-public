import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';
import type { RunHooks, StepContext } from './context.ts';
import { parseFreeze } from './freeze.ts';
import { isRecord, stringArray } from './json.ts';
import { ALLOWED_AMENDMENTS, hashListed, isDone, isLocalPath, parseMarker, preAmendmentSha256, readMarker, sha256Bytes, verifyMarker, writeMarker, type Marker, type MarkerResult } from './marker.ts';
import { err, ok, type Result } from './result.ts';
import { createExclusive, moveFileIfPresent, readRecords, removeFile, sha256 } from './store.ts';
import { IntegrityError, QuotaExhausted } from './calls.ts';

/** The 42 round-pipeline steps in order (plan §4). The production registry ROUND_STEPS is always a prefix. */
export type RoundStepId =
  | '00-start' | '01-topic' | '02a-brief' | '02b-baseline' | '02c-freeze'
  | '03a-forecast' | '03b-seal' | '03c-probe-mirror' | '04-write' | '05a-gate-mech'
  | '05b-defect' | '05c-gate-llm' | '05d-resubmit'
  | '06a-decoy' | '06b-champion-pairs' | '06c-aux-pairs' | '06d-measures'
  | '07a-unseal' | '07b-surprise' | '08-aggregate' | '09a-audit' | '09b-decision'
  | '10a-regate' | '10b-merge-edit' | '10c-apply' | '10d-post-merge-freeze' | '10e-post-merge-gate' | '10f-commit'
  | '11a-unseal-publish' | '11b-forecast-pool' | '11c-champion' | '11d-tagging' | '11e-agreement'
  | '11f-bench-evidence' | '11g-bench-propose' | '11h-bench-validate' | '11i-bench-replay' | '11j-bench-outcome'
  | '11k-wiki' | '11l-commit' | '12a-prepare' | '12b-diff-approval';

/** Calibration pipeline (dir `calibration/<set>/` via calibPaths). */
export type CalibStepId = 'c1-build' | 'c2-gate-dryrun' | 'c3-owner-answers' | 'c4-judge' | 'c5-score';

/** Bench-initial pipeline (v1 under `benchmark/initial/`, cycle `R00-init`). */
export type InitialStepId = 'i1-propose' | 'i2-validate' | 'i3-outcome';

export type StepId = RoundStepId | CalibStepId | InitialStepId;

export const STEP_IDS: readonly RoundStepId[] = [
  '00-start', '01-topic', '02a-brief', '02b-baseline', '02c-freeze',
  '03a-forecast', '03b-seal', '03c-probe-mirror', '04-write', '05a-gate-mech',
  '05b-defect', '05c-gate-llm', '05d-resubmit',
  '06a-decoy', '06b-champion-pairs', '06c-aux-pairs', '06d-measures',
  '07a-unseal', '07b-surprise', '08-aggregate', '09a-audit', '09b-decision',
  '10a-regate', '10b-merge-edit', '10c-apply', '10d-post-merge-freeze', '10e-post-merge-gate', '10f-commit',
  '11a-unseal-publish', '11b-forecast-pool', '11c-champion', '11d-tagging', '11e-agreement',
  '11f-bench-evidence', '11g-bench-propose', '11h-bench-validate', '11i-bench-replay', '11j-bench-outcome',
  '11k-wiki', '11l-commit', '12a-prepare', '12b-diff-approval',
];

export const CALIB_STEP_IDS: readonly CalibStepId[] = ['c1-build', 'c2-gate-dryrun', 'c3-owner-answers', 'c4-judge', 'c5-score'];

export const INITIAL_STEP_IDS: readonly InitialStepId[] = ['i1-propose', 'i2-validate', 'i3-outcome'];

/** The bench-r00 pipeline runs 11f–11j on `rounds/R00/` (registered in PR-E). */
export const BENCH_R00_STEP_IDS: readonly RoundStepId[] = ['11f-bench-evidence', '11g-bench-propose', '11h-bench-validate', '11i-bench-replay', '11j-bench-outcome'];

const ALL_STEP_IDS: readonly StepId[] = [...STEP_IDS, ...CALIB_STEP_IDS, ...INITIAL_STEP_IDS];

export function isStepId(value: string): value is StepId {
  return ALL_STEP_IDS.some((id) => id === value);
}

export type Pipeline = 'round' | 'calibration' | 'bench-initial' | 'bench-r00';

export type WaitReason =
  | 'protocol_approval'
  | 'benchmark_approval'
  | 'topic'
  | 'audit'
  | 'decision'
  | 'calib_answers'
  | 'diff_approval'
  | 'owner_log_repair';

/**
 * What a step returns; WAIT is always an outcome, never an exception. Paths are forge-root-relative
 * (RoundFiles.rel). Any thrown non-outcome exception is a crash: no status write, lock kept.
 */
export type StepOutcome =
  | { kind: 'done'; inputs: string[]; outputs: string[]; external: string[] }
  | { kind: 'skip'; reason: string }
  | { kind: 'wait'; waitingFor: WaitReason; detail: string; inputs: string[]; outputs: string[] }
  | { kind: 'blocked'; detail: string }
  | { kind: 'failed'; detail: string }
  | { kind: 'rewind'; to: StepId; detail: string; outputs: string[] };

export interface StepDef {
  id: StepId;
  /** `pending` = this step's own `result: "waiting"` marker; re-entry reuses its outputs. */
  run(ctx: StepContext, pending: Marker | null): Promise<StepOutcome>;
}

export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5;

export const EXIT: { readonly done: 0; readonly usage: 1; readonly waiting: 2; readonly integrity: 3; readonly blocked: 4; readonly failed: 5 } = {
  done: 0,
  usage: 1,
  waiting: 2,
  integrity: 3,
  blocked: 4,
  failed: 5,
};

/** Final state of one runner invocation; `usage` = exit 1 (lock held, wrong branch with a dirty tree, refused redo, …). */
export type RunState = 'done' | 'usage' | 'waiting' | 'integrity' | 'blocked' | 'failed';

export interface RunOptions {
  pipeline: Pipeline;
  /** The registered steps of this pipeline, in order; `steps_sha256` hashes their ids. */
  steps: readonly StepDef[];
  until: StepId | null;
  /** Every earlier step must already be marked. */
  from: StepId | null;
  redoFrom: StepId | null;
  pid: number;
  isAlive: (pid: number) => boolean;
}

export interface RunReport {
  state: RunState;
  step: StepId | null;
  waitingFor: WaitReason | null;
  detail: string;
  exitCode: ExitCode;
}

/** `status.json` (engine-written; `state: "running"` at start so a crash is never shown as the previous state). */
export type StatusState = 'running' | 'done' | 'waiting' | 'integrity' | 'blocked' | 'failed';

export interface RoundStatus {
  round: string;
  state: StatusState;
  step: StepId | null;
  waiting_for: WaitReason | null;
  detail: string;
  since: string;
  exit_code: ExitCode | null;
  done: StepId[];
}

/** Token of `.forge.lock` (created with `wx`, content `{pid, started_at}`). */
export interface EngineLock {
  path: string;
  pid: number;
  startedAt: string;
  /** pid of a dead holder whose lock was taken over, else null. */
  takenOverFrom: number | null;
  release(): void;
}


/** The engine lock file at the forge root (git-ignored). */
export const LOCK_FILE = '.forge.lock';

/** SHA-256 of the pipeline's step ids joined by LF (`freeze.json.steps_sha256`; R00: `start.json`). */
export function stepsSha256(ids: readonly StepId[]): string {
  return sha256(ids.join('\n'));
}

/** What runSteps is running for a context: freeze pins `stepsSha256`; runTask reads `redoStale`. */
export interface ActiveRun {
  pipeline: Pipeline;
  ids: readonly StepId[];
  stepsSha256: string;
  /** `n` of `markers/stale/<n>/` when this run was started with `--redo-from` (mismatching task records go to `tasks/stale/<n>/`), else null. */
  redoStale: number | null;
  /** Task records the running step wrote or reused through runTask (reset per step; its marker counts them). */
  taskRecords: Set<string>;
}

const activeRuns = new WeakMap<StepContext, ActiveRun>();
const abortedContexts = new WeakSet<StepContext>();

/** The run in progress on `ctx`, else null (a step called outside runSteps, e.g. a unit test). */
export function activeRun(ctx: StepContext): ActiveRun | null {
  return activeRuns.get(ctx) ?? null;
}

/** Thrown into a job that would start its backend call after a sibling crashed. */
export class RunAborted extends Error {}

/** Throws RunAborted once a job of this run has failed (queued siblings of a crash never call). */
export function throwIfAborted(ctx: StepContext): void {
  if (abortedContexts.has(ctx)) throw new RunAborted('run aborted: a sibling job crashed');
}

/**
 * runTask wraps each backend call in this, inside the limiter: it refuses to start after a sibling failed, and a
 * throw marks the run aborted before the limiter's release wakes the next queued job (runAll alone would learn
 * of the failure only after the rejection has travelled back through the limiter).
 */
export async function abortable<T>(ctx: StepContext, fn: () => Promise<T>): Promise<T> {
  throwIfAborted(ctx);
  try {
    return await fn();
  } catch (e) {
    abortedContexts.add(ctx);
    throw e;
  }
}

function markingAbort<T>(ctx: StepContext, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    abortedContexts.add(ctx);
    throw e;
  }
}

/**
 * `ctx.hooks` wrapped so a throwing hook (a simulated kill, any crash) marks the run aborted synchronously, before
 * the limiter can wake a queued sibling; runTask passes these to callWithRetry instead of `ctx.hooks`.
 */
export function guardedHooks(ctx: StepContext): RunHooks {
  const { beforeCall, afterCall } = ctx.hooks;
  const out: RunHooks = {};
  if (beforeCall !== undefined) out.beforeCall = (taskId, attempt) => markingAbort(ctx, () => beforeCall(taskId, attempt));
  if (afterCall !== undefined) out.afterCall = (taskId, attempt) => markingAbort(ctx, () => afterCall(taskId, attempt));
  return out;
}

/**
 * Runs jobs concurrently (limiters inside runTask bound the parallelism). A job that throws aborts every
 * job not yet dispatched, awaits the in-flight ones, then rethrows the first error (the crash itself, never the
 * RunAborted of a sibling it stopped).
 */
export async function runAll<T>(ctx: StepContext, jobs: ReadonlyArray<() => Promise<T>>): Promise<T[]> {
  const settled: Array<{ value: T } | null> = jobs.map(() => null);
  const state: { failure: { error: unknown } | null } = { failure: null };
  await Promise.all(
    jobs.map(async (job, i) => {
      try {
        throwIfAborted(ctx);
        settled[i] = { value: await job() };
      } catch (e) {
        abortedContexts.add(ctx);
        if (state.failure === null || (state.failure.error instanceof RunAborted && !(e instanceof RunAborted))) state.failure = { error: e };
      }
    }),
  );
  if (state.failure !== null) throw state.failure.error;
  const out: T[] = [];
  for (const s of settled) {
    if (s === null) throw new Error('runAll: a job neither settled nor failed');
    out.push(s.value);
  }
  return out;
}

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function parseLockToken(text: string): { pid: number; startedAt: string } | null {
  try {
    const v: unknown = JSON.parse(text);
    if (!isRecord(v)) return null;
    const { pid, started_at: startedAt } = v;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || typeof startedAt !== 'string') return null;
    return { pid, startedAt };
  } catch {
    return null;
  }
}

/**
 * One mutating engine process per forge root; err when a live pid holds the lock (exit 1). The lock is created
 * with `wx` and holds `{pid, started_at}`. A token whose pid `isAlive` denies is renamed aside (atomic, so only one
 * taker moves it); the taker checks the moved bytes are the dead token it read (else it put back another taker's
 * live lock and retries) and creates the lock again with `wx`, so two takers cannot both win.
 */
export function acquireEngineLock(root: string, pid: number, isAlive: (pid: number) => boolean, now: string): Result<EngineLock> {
  const path = join(root, LOCK_FILE);
  const token = `${JSON.stringify({ pid, started_at: now })}\n`;
  let takenOverFrom: number | null = null;
  for (let tries = 0; tries < 3; tries += 1) {
    if (createExclusive(path, token)) {
      const release = (): void => {
        if (readTextOrNull(path) === token) removeFile(path);
      };
      return ok({ path, pid, startedAt: now, takenOverFrom, release });
    }
    const held = readTextOrNull(path);
    if (held === null) continue;
    const holder = parseLockToken(held);
    if (holder === null) return err(`engine lock ${LOCK_FILE} is unreadable; delete it if no forge process is running`);
    if (isAlive(holder.pid)) return err(`engine lock held by pid ${holder.pid} since ${holder.startedAt}`);
    const aside = `${path}.${String(pid)}.stale`;
    if (!moveFileIfPresent(path, aside)) continue;
    const moved = readTextOrNull(aside);
    if (moved !== held) {
      // Another taker replaced the dead token between our read and the rename: put its live lock back.
      const restored = moved !== null && createExclusive(path, moved);
      removeFile(aside);
      if (!restored) return err('engine lock contended by another process; retry');
      continue;
    }
    removeFile(aside);
    takenOverFrom = holder.pid;
  }
  return err('engine lock contended by another process; retry');
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function isFinal(result: MarkerResult): boolean {
  return result === 'done' || result === 'skip';
}

/**
 * Problems with the marker chain under `<dir>/markers/` for `ids` in order (`stale/` ignored); [] = verifiable.
 * `dir` is forge-root-relative (or absolute) and `ids` start at the pipeline's first step. Checks: marker shape,
 * step id, one round, no gaps, `prev` chain, a waiting marker only last, no rewind marker left behind, the
 * amendment rule (a path re-listed with a new hash only as an allowed output), and every listed file against the
 * hash of the latest marker listing it (`local` only where present; `external` never). When the amending step is the
 * first unmarked one, its file may also differ from that hash by exactly the amendment (a kill between the amendment
 * and the marker; preAmendmentSha256), and the rerun step re-checks the amended value.
 */
export function verifyChain(root: string, dir: string, ids: readonly StepId[]): string[] {
  const problems: string[] = [];
  const base = resolve(root, dir);
  const dirRel = toPosix(relative(root, base));
  const present: Marker[] = [];
  const shaOf = new Map<StepId, string>();
  let gap: StepId | null = null;
  let round: string | null = null;
  let waiting: StepId | null = null;
  for (const [i, id] of ids.entries()) {
    const file = join(base, 'markers', `${id}.json`);
    const label = `${dirRel}/markers/${id}.json`;
    if (!existsSync(file)) {
      gap ??= id;
      continue;
    }
    const bytes = readFileSync(file);
    shaOf.set(id, sha256Bytes(bytes));
    if (gap !== null) problems.push(`${label}: present although ${gap} has no marker`);
    if (waiting !== null) problems.push(`${label}: present after the waiting step ${waiting}`);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      problems.push(`${label}: not JSON`);
      continue;
    }
    const parsed = parseMarker(value);
    if (!parsed.ok) {
      problems.push(`${label}: ${parsed.error}`);
      continue;
    }
    const m = parsed.value;
    if (m.step !== id) problems.push(`${label}: names step ${m.step}`);
    round ??= m.round;
    if (m.round !== round) problems.push(`${label}: names round ${m.round}, not ${round}`);
    const before = i === 0 ? undefined : ids[i - 1];
    const expectedPrev = before === undefined ? null : (shaOf.get(before) ?? null);
    if (m.prev !== expectedPrev) problems.push(`${label}: prev does not match ${before ?? 'the chain start'}`);
    if (m.result === 'rewind') problems.push(`${label}: rewind marker left outside markers/stale/`);
    if (m.result === 'waiting') waiting = id;
    present.push(m);
  }
  const latest = new Map<string, string>();
  const listedBy = new Map<string, StepId>();
  for (const m of present) {
    const amendable = (ALLOWED_AMENDMENTS[m.step] ?? []).map((p) => posix.join(dirRel, p));
    for (const [path, hash] of [...Object.entries(m.inputs), ...Object.entries(m.outputs), ...Object.entries(m.local)]) {
      const was = latest.get(path);
      if (was !== undefined && was !== hash && !(Object.hasOwn(m.outputs, path) && amendable.includes(path))) {
        problems.push(`${path}: re-listed by ${m.step} with a hash that differs from ${listedBy.get(path) ?? 'an earlier step'}`);
      }
      latest.set(path, hash);
      listedBy.set(path, m.step);
    }
  }
  // A kill between an allowed amendment and the amending step's marker (03c set freeze.json.probe_created_at):
  // when that step is the first unmarked one, the file may differ from its latest listing only by the amendment.
  for (const p of gap === null ? [] : (ALLOWED_AMENDMENTS[gap] ?? [])) {
    const path = posix.join(dirRel, p);
    const listed = latest.get(path);
    const abs = join(root, path);
    if (gap === null || listed === undefined || !existsSync(abs)) continue;
    const bytes = readFileSync(abs);
    const actual = sha256Bytes(bytes);
    if (actual !== listed && preAmendmentSha256(gap, p, bytes) === listed) latest.set(path, actual);
  }
  for (const m of present) problems.push(...verifyMarker(root, m, latest));
  return [...new Set(problems)];
}

const STATUS_STATES: readonly StatusState[] = ['running', 'done', 'waiting', 'integrity', 'blocked', 'failed'];
const WAIT_REASONS: readonly WaitReason[] = ['protocol_approval', 'benchmark_approval', 'topic', 'audit', 'decision', 'calib_answers', 'diff_approval', 'owner_log_repair'];
const EXIT_CODES: readonly ExitCode[] = [0, 1, 2, 3, 4, 5];

function isStatusState(value: unknown): value is StatusState {
  return STATUS_STATES.some((s) => s === value);
}

export function isWaitReason(value: unknown): value is WaitReason {
  return WAIT_REASONS.some((w) => w === value);
}

function isExitCode(value: unknown): value is ExitCode {
  return EXIT_CODES.some((c) => c === value);
}

/** Narrows parsed `status.json` (schema/status.schema.json). */
export function parseStatus(value: unknown): Result<RoundStatus> {
  if (!isRecord(value)) return err('status: expected an object');
  const { round, state, step, waiting_for: waitingFor, detail, since, exit_code: exitCode, done } = value;
  if (typeof round !== 'string' || round === '') return err('status.round: expected a string');
  if (!isStatusState(state)) return err('status.state: unknown state');
  if (step !== null && (typeof step !== 'string' || !isStepId(step))) return err('status.step: expected a step id or null');
  if (waitingFor !== null && !isWaitReason(waitingFor)) return err('status.waiting_for: expected a wait reason or null');
  if (typeof detail !== 'string') return err('status.detail: expected a string');
  if (typeof since !== 'string' || since === '') return err('status.since: expected a timestamp');
  if (exitCode !== null && !isExitCode(exitCode)) return err('status.exit_code: expected 0-5 or null');
  const doneIds = stringArray(done);
  if (doneIds === null) return err('status.done: expected step ids');
  const steps: StepId[] = [];
  for (const id of doneIds) {
    if (!isStepId(id)) return err(`status.done: unknown step ${id}`);
    steps.push(id);
  }
  return ok({ round, state, step, waiting_for: waitingFor, detail, since, exit_code: exitCode, done: steps });
}

export function readStatus(root: string, roundId: string): Result<RoundStatus> {
  if (!/^[A-Z][0-9]{2}$/u.test(roundId)) return err(`status: bad round id ${roundId}`);
  const path = join(root, 'rounds', roundId, 'status.json');
  const text = readTextOrNull(path);
  if (text === null) return err(`status: no rounds/${roundId}/status.json`);
  try {
    return parseStatus(JSON.parse(text));
  } catch {
    return err(`status: rounds/${roundId}/status.json is not JSON`);
  }
}

const STATE_EXIT: Readonly<Record<RunState, ExitCode>> = { done: 0, usage: 1, waiting: 2, integrity: 3, blocked: 4, failed: 5 };

function markerFile(ctx: StepContext, id: StepId): string {
  return join(ctx.paths.markers, `${id}.json`);
}

function relOf(ctx: StepContext, path: string): string {
  return toPosix(relative(ctx.root, path));
}

function markerOf(ctx: StepContext, id: StepId): Marker | null {
  const m = readMarker(markerFile(ctx, id));
  return m !== null && m.ok ? m.value : null;
}

function doneIds(ctx: StepContext, ids: readonly StepId[]): StepId[] {
  return ids.filter((id) => isDone(ctx, id));
}

/** Temp files of UI writes to owner files in the round dir (the UI does not take the engine lock). */
const OWNER_TMP = /^(?:audit\.json|decision[^/]*\.json|topic\.json)\.[0-9a-f]+\.tmp$/u;

/** `*.tmp` left by a write torn by a crash (every engine write is tmp + rename), except in-flight UI owner writes. */
function strayTmp(dir: string, top = true): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...strayTmp(path, false));
    else if (entry.name.endsWith('.tmp') && !(top && OWNER_TMP.test(entry.name))) out.push(path);
  }
  return out;
}

/** `n` for the next `markers/stale/<n>/` (also past any `tasks/stale/<n>/`, which runTask fills under a redo). */
function nextStale(ctx: StepContext): number {
  let n = 1;
  for (const root of [join(ctx.paths.markers, 'stale'), join(ctx.paths.tasks, 'stale')]) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) if (/^[1-9][0-9]*$/u.test(name)) n = Math.max(n, Number(name) + 1);
  }
  return n;
}

/** Moves the present markers of `ids` to `markers/stale/<n>/`; returns the moved ids. */
function moveToStale(ctx: StepContext, ids: readonly StepId[], n: number): StepId[] {
  const moved = ids.filter((id) => existsSync(markerFile(ctx, id)));
  for (const id of moved) ctx.files.move(markerFile(ctx, id), join(ctx.paths.markers, 'stale', String(n), `${id}.json`));
  return moved;
}

/** Why `--redo-from target` is refused, else null (positions compare in STEP_IDS order). */
function redoRefusal(ctx: StepContext, target: StepId): string | null {
  const pos = STEP_IDS.findIndex((s) => s === target);
  if (pos < 0) return null;
  if (pos <= STEP_IDS.indexOf('03c-probe-mirror') && existsSync(join(ctx.paths.dir, 'probe.json'))) {
    return `--redo-from ${target}: refused, the probe is published (probe.json exists); start a new round`;
  }
  if (pos <= STEP_IDS.indexOf('06d-measures') && isDone(ctx, '07a-unseal')) {
    return `--redo-from ${target}: refused, 07a-unseal is marked (writers and the defect writer must not run after an unseal)`;
  }
  if (pos <= STEP_IDS.indexOf('09b-decision') && existsSync(join(ctx.paths.dir, 'audit.json'))) {
    return `--redo-from ${target}: refused, audit.json exists (the owner's answers refer to the current audit set)`;
  }
  return null;
}

function optionProblem(ctx: StepContext, opts: RunOptions, ids: readonly StepId[]): string | null {
  if (ids.length === 0) return `no steps registered for the ${opts.pipeline} pipeline`;
  if (new Set(ids).size !== ids.length) return 'a step id is registered twice';
  const flags: Array<[string, StepId | null]> = [['--until', opts.until], ['--from', opts.from], ['--redo-from', opts.redoFrom]];
  for (const [flag, id] of flags) if (id !== null && !ids.includes(id)) return `${flag} ${id}: not a step of the ${opts.pipeline} pipeline`;
  if (opts.from !== null) {
    const missing = ids.slice(0, ids.indexOf(opts.from)).find((id) => !isDone(ctx, id));
    if (missing !== undefined) return `--from ${opts.from}: ${missing} is not marked`;
  }
  return opts.redoFrom === null ? null : redoRefusal(ctx, opts.redoFrom);
}

/**
 * Checks out the round branch recorded in `start.json` when the tree is clean; returns why it cannot (exit 1),
 * else null. No `start.json` yet → nothing to check. Steps call it before every commit / push.
 */
export async function ensureRoundBranch(ctx: StepContext): Promise<string | null> {
  if (!existsSync(ctx.paths.start)) return null;
  let want: string;
  try {
    want = ctx.start().branch;
  } catch (e) {
    return `start.json: ${e instanceof Error ? e.message : String(e)}`;
  }
  const current = await ctx.ports.git.currentBranch();
  if (!current.ok) return `git: ${current.error}`;
  if (current.value === want) return null;
  const clean = await ctx.ports.git.isClean([]);
  if (!clean.ok) return `git: ${clean.error}`;
  if (!clean.value) return `on branch ${current.value} with a dirty working tree; the round runs on ${want}`;
  const checkout = await ctx.ports.git.checkout(want);
  if (!checkout.ok) return `git checkout ${want}: ${checkout.error}`;
  ctx.log(`checked out ${want} (was ${current.value})`);
  return null;
}

/**
 * The append-only JSON-line engine logs a run touches (absolute paths): read line by line on resume, and never listed
 * in a marker, since a later append would break the hash. One list, so the two rules cannot diverge.
 */
export function engineJsonlLogs(ctx: StepContext): string[] {
  return [ctx.paths.progress, join(ctx.paths.dir, 'mirror.jsonl'), join(ctx.root, 'benchmark', 'log.jsonl'), join(ctx.root, 'regression', 'forecast-pool.jsonl')];
}

/** Engine logs of this run that must parse line by line (a torn last line is fine; appendRecords cuts it). */
function engineLogProblems(ctx: StepContext): string[] {
  const problems: string[] = [];
  for (const path of engineJsonlLogs(ctx)) {
    const r = readRecords(path);
    if (!r.ok) problems.push(r.error.replace(path, relOf(ctx, path)));
  }
  return problems;
}

/**
 * `steps_sha256` against this build's pipeline (start.json when it pins one, e.g. R00), and once 02c is marked
 * (a crash inside 02c or a redo of it leaves freeze.json unpinned) freeze.json's `steps_sha256`, protocol bundle,
 * pinned benchmark file and skill snapshots. The other pinned files are inputs of
 * the 02c marker and are re-hashed by verifyChain. Owner-log appends (a rollback) are not drift.
 */
function freezeProblems(ctx: StepContext, ids: readonly StepId[]): string[] {
  const problems: string[] = [];
  const want = stepsSha256(ids);
  const startText = readTextOrNull(ctx.paths.start);
  if (startText !== null) {
    try {
      const start: unknown = JSON.parse(startText);
      const pinned = isRecord(start) ? start['steps_sha256'] : undefined;
      if (typeof pinned === 'string' && pinned !== want) problems.push('steps_sha256: start.json pins a different step list than this build runs');
    } catch {
      problems.push('start.json: not JSON');
    }
  }
  const freezeText = readTextOrNull(ctx.paths.freeze);
  if (freezeText === null || !isDone(ctx, '02c-freeze')) return problems;
  let raw: unknown;
  try {
    raw = JSON.parse(freezeText);
  } catch {
    return [...problems, 'freeze.json: not JSON'];
  }
  const parsed = parseFreeze(raw);
  if (!parsed.ok) return [...problems, `freeze.json: ${parsed.error}`];
  const freeze = parsed.value;
  if (freeze.steps_sha256 !== null && freeze.steps_sha256 !== want) problems.push('steps_sha256: freeze.json pins a different step list than this build runs');
  if (freeze.protocol_bundle_sha256 !== ctx.bundleSha256) problems.push('protocol bundle changed since 02c-freeze');
  const pinned = freeze.benchmark_resolution;
  if (pinned !== null) {
    const h = hashListed(ctx.root, pinned.path);
    if (h === null || !h.ok || h.value !== pinned.sha256) problems.push(`${pinned.path}: pinned benchmark changed since 02c-freeze`);
  }
  for (const [name, hash] of Object.entries(freeze.skills)) {
    const rel = `skills/${name}.md`;
    const h = hashListed(ctx.root, rel);
    if (h === null || !h.ok || h.value !== hash) problems.push(`${rel}: pinned skill snapshot changed since 02c-freeze`);
  }
  return problems;
}

interface Listed {
  tracked: Record<string, string>;
  local: Record<string, string>;
}

/** Hashes the forge-root-relative paths a step returned; a missing or engine-log path is a step bug (crash). */
function listPaths(ctx: StepContext, step: StepId, paths: readonly string[]): Listed {
  const logs = [...engineJsonlLogs(ctx), ctx.paths.status].map((p) => relOf(ctx, p));
  const out: Listed = { tracked: {}, local: {} };
  for (const rel of paths) {
    if (rel === '' || rel.startsWith('/') || rel.includes('\\')) throw new Error(`${step}: listed path ${rel} is not forge-root-relative`);
    if (logs.includes(rel)) throw new Error(`${step}: engine log ${rel} must not be listed in a marker`);
    const h = hashListed(ctx.root, rel);
    if (h === null) throw new Error(`${step}: listed file ${rel} does not exist`);
    if (!h.ok) throw new Error(`${step}: ${h.error}`);
    if (isLocalPath(rel)) out.local[rel] = h.value;
    else out.tracked[rel] = h.value;
  }
  return out;
}

/**
 * Every task record the step produced: written in this invocation or reused from its own killed attempt (both go
 * through runTask). Another step's records a step only reads (storedTaskResult) are not counted.
 */
function taskCounts(records: ReadonlySet<string>): Marker['tasks'] {
  const counts = { ok: 0, void: 0, calls: 0 };
  for (const path of records) {
    const text = readTextOrNull(path);
    if (text === null) continue;
    try {
      const record: unknown = JSON.parse(text);
      if (!isRecord(record)) continue;
      if (record['status'] === 'ok') counts.ok += 1;
      else if (record['status'] === 'void') counts.void += 1;
      const calls = record['calls'];
      if (Array.isArray(calls)) counts.calls += calls.length;
    } catch {
      // a malformed record is runTask's integrity problem, not a count
    }
  }
  return counts;
}

interface MarkerInput {
  result: MarkerResult;
  skipped: string | null;
  inputs: readonly string[];
  outputs: readonly string[];
  external: readonly string[];
  tasks: Marker['tasks'];
}

/** Writes `markers/<ids[i]>.json` with `prev` = SHA-256 of the previous step's marker bytes. */
function writeStepMarker(ctx: StepContext, ids: readonly StepId[], i: number, input: MarkerInput): void {
  const id = ids[i];
  if (id === undefined) throw new Error(`runner: no step at index ${i}`);
  const before = i === 0 ? undefined : ids[i - 1];
  let prev: string | null = null;
  if (before !== undefined) {
    const file = markerFile(ctx, before);
    if (!existsSync(file)) throw new Error(`runner: ${id} would be marked while ${before} has no marker`);
    prev = sha256Bytes(readFileSync(file));
  }
  const inputs = listPaths(ctx, id, input.inputs);
  const outputs = listPaths(ctx, id, input.outputs);
  const external = listPaths(ctx, id, input.external);
  writeMarker(ctx.files, markerFile(ctx, id), {
    v: 1,
    round: ctx.roundId,
    step: id,
    completed_at: ctx.ports.clock.now(),
    result: input.result,
    skipped: input.skipped,
    inputs: inputs.tracked,
    outputs: outputs.tracked,
    external: { ...external.tracked, ...external.local },
    local: { ...inputs.local, ...outputs.local },
    tasks: input.tasks,
    prev,
  });
}

interface Invocation {
  ctx: StepContext;
  ids: readonly StepId[];
  lock: EngineLock;
  /** status.json bytes before this run wrote `running` (restored on a usage exit), null when absent. */
  previousStatus: string | null;
  runningWritten: boolean;
  /** Steps this invocation ran (a usage exit after one ran reports the real state instead of restoring). */
  stepsRun: number;
}

function writeStatus(ctx: StepContext, ids: readonly StepId[], state: StatusState, step: StepId | null, waitingFor: WaitReason | null, detail: string, exitCode: ExitCode | null): void {
  const status: RoundStatus = { round: ctx.roundId, state, step, waiting_for: waitingFor, detail, since: ctx.ports.clock.now(), exit_code: exitCode, done: doneIds(ctx, ids) };
  ctx.files.writeJson(ctx.paths.status, status);
}

/**
 * Ends a run with an outcome: status.json, progress, lock release. A usage exit before any step ran restores the
 * previous status.json (a bad flag never clobbers a waiting round); after a step ran it is written as `blocked`
 * with exit code 1, so `step` and `done[]` show where the run really stopped.
 */
function finish(run: Invocation, state: RunState, step: StepId | null, waitingFor: WaitReason | null, detail: string): RunReport {
  const { ctx } = run;
  const exitCode = STATE_EXIT[state];
  const clean = ctx.redact(detail);
  if (state === 'usage' && run.stepsRun > 0) {
    writeStatus(ctx, run.ids, 'blocked', step, null, clean, exitCode);
  } else if (state === 'usage') {
    if (run.runningWritten) {
      if (run.previousStatus === null) ctx.files.remove(ctx.paths.status);
      else ctx.files.writeText(ctx.paths.status, run.previousStatus);
    }
  } else {
    writeStatus(ctx, run.ids, state, step, waitingFor, clean, exitCode);
  }
  ctx.progress(step ?? 'runner', state === 'done' ? 'done' : state === 'waiting' ? 'info' : 'error', `${state}: ${clean}`);
  run.lock.release();
  activeRuns.delete(ctx);
  return { state, step, waitingFor, detail: clean, exitCode };
}

function usage(detail: string): RunReport {
  return { state: 'usage', step: null, waitingFor: null, detail, exitCode: EXIT.usage };
}

/** The step machine: lock, tmp cleanup, branch check, freeze drift check, verify-or-run, outcomes, status. */
export async function runSteps(ctx: StepContext, opts: RunOptions): Promise<RunReport> {
  const ids = opts.steps.map((s) => s.id);
  abortedContexts.delete(ctx);
  const lock = acquireEngineLock(ctx.root, opts.pid, opts.isAlive, ctx.ports.clock.now());
  if (!lock.ok) return usage(lock.error);
  const run: Invocation = { ctx, ids, lock: lock.value, previousStatus: readTextOrNull(ctx.paths.status), runningWritten: false, stepsRun: 0 };
  if (lock.value.takenOverFrom !== null) {
    const note = `lock taken over from pid ${lock.value.takenOverFrom}`;
    ctx.log(note);
    ctx.progress('runner', 'info', note);
  }
  const strays = [...new Set([ctx.paths.dir, ctx.paths.sealed, ctx.paths.runs])].flatMap((dir) => strayTmp(dir));
  for (const path of strays) ctx.files.remove(path);
  if (strays.length > 0) ctx.log(`deleted ${strays.length} stray *.tmp file(s)`);
  const problem = optionProblem(ctx, opts, ids);
  if (problem !== null) return finish(run, 'usage', null, null, problem);
  const branch = await ensureRoundBranch(ctx);
  if (branch !== null) return finish(run, 'usage', null, null, branch);
  writeStatus(ctx, ids, 'running', ids.find((id) => !isDone(ctx, id)) ?? null, null, '', null);
  run.runningWritten = true;
  const redoAt = opts.redoFrom === null ? ids.length : ids.indexOf(opts.redoFrom);
  const integrity = [...engineLogProblems(ctx), ...verifyChain(ctx.root, ctx.paths.dir, ids.slice(0, redoAt))];
  let redoStale: number | null = null;
  if (opts.redoFrom !== null && integrity.length === 0) {
    redoStale = nextStale(ctx);
    const moved = moveToStale(ctx, ids.slice(redoAt), redoStale);
    ctx.log(`--redo-from ${opts.redoFrom}: moved ${moved.length} marker(s) to markers/stale/${redoStale}/`);
  }
  integrity.push(...freezeProblems(ctx, ids));
  if (integrity.length > 0) return finish(run, 'integrity', null, null, integrity.join('; '));
  const state: ActiveRun = { pipeline: opts.pipeline, ids, stepsSha256: stepsSha256(ids), redoStale, taskRecords: new Set() };
  activeRuns.set(ctx, state);
  let first = true;
  for (const [i, step] of opts.steps.entries()) {
    const existing = markerOf(ctx, step.id);
    if (existing !== null && isFinal(existing.result)) {
      if (opts.until === step.id) return finish(run, 'done', step.id, null, `--until ${step.id} reached`);
      continue;
    }
    if (!first) {
      const moved = await ensureRoundBranch(ctx);
      if (moved !== null) return finish(run, 'usage', step.id, null, moved);
    }
    first = false;
    const pending = existing !== null && existing.result === 'waiting' ? existing : null;
    ctx.progress(step.id, 'start', pending === null ? '' : 'resume');
    state.taskRecords = new Set();
    run.stepsRun += 1;
    let outcome: StepOutcome;
    try {
      outcome = await step.run(ctx, pending);
    } catch (e) {
      if (e instanceof IntegrityError) return finish(run, 'integrity', step.id, null, e.message);
      if (e instanceof QuotaExhausted) return finish(run, 'blocked', step.id, null, e.message);
      throw e;
    }
    const tasks = taskCounts(state.taskRecords);
    switch (outcome.kind) {
      case 'done':
        writeStepMarker(ctx, ids, i, { result: 'done', skipped: null, inputs: outcome.inputs, outputs: outcome.outputs, external: outcome.external, tasks });
        ctx.progress(step.id, 'done', '');
        break;
      case 'skip':
        writeStepMarker(ctx, ids, i, { result: 'skip', skipped: outcome.reason, inputs: [], outputs: [], external: [], tasks });
        ctx.progress(step.id, 'done', `skip: ${outcome.reason}`);
        break;
      case 'wait':
        writeStepMarker(ctx, ids, i, { result: 'waiting', skipped: null, inputs: outcome.inputs, outputs: outcome.outputs, external: [], tasks });
        return finish(run, 'waiting', step.id, outcome.waitingFor, outcome.detail);
      case 'blocked':
        return finish(run, 'blocked', step.id, null, outcome.detail);
      case 'failed':
        return finish(run, 'failed', step.id, null, outcome.detail);
      case 'rewind': {
        const to = ids.indexOf(outcome.to);
        if (to < 0 || to > i) throw new Error(`${step.id}: rewind target ${outcome.to} is not an earlier step of this pipeline`);
        writeStepMarker(ctx, ids, i, { result: 'rewind', skipped: null, inputs: [], outputs: outcome.outputs, external: [], tasks });
        const n = nextStale(ctx);
        moveToStale(ctx, ids.slice(to, i + 1), n);
        ctx.log(`${step.id} rewound to ${outcome.to}: markers moved to markers/stale/${n}/`);
        return finish(run, 'waiting', outcome.to, outcome.to === '09b-decision' ? 'decision' : null, outcome.detail);
      }
    }
    if (opts.until === step.id) return finish(run, 'done', step.id, null, `--until ${step.id} reached`);
  }
  return finish(run, 'done', ids[ids.length - 1] ?? null, null, 'pipeline complete');
}
