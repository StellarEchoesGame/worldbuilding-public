import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isQuotaError, type Backend, type CallResult } from './adapters/types.ts';
import { limiter } from './calls.ts';
import type { ForgeConfig } from './config.ts';
import { parseFreeze, type FreezeRecord } from './freeze.ts';
import { isRecord, readNumber, readRecord, readString } from './json.ts';
import { isDone, readMarker } from './marker.ts';
import { DECISION_FILE, ownerInputs, parseDecision, type Decision, type OwnerInputs } from './owner-inputs.ts';
import type { Ports } from './ports.ts';
import type { Protocol } from './protocol.ts';
import { publicDeny, redactPublic, scannedGit, scannedGitHub } from './public-scan.ts';
import { err, ok, type Result } from './result.ts';
import type { JudgeSlot } from './prototype.ts';
import { loadProtocolBundle, roundRules, type RoundRules } from './rules.ts';
import type { Pipeline } from './runner.ts';
import { appendRecords, createExclusive, isIsoTimestamp, removeFile, writeText, type ProgressStatus, type RoundPaths } from './store.ts';
import { IntegrityError } from './task.ts';
import { parseBenchmark, type Benchmark } from './taste.ts';

/** Same shape as calls.ts `limiter(n)`. */
export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

export interface WriterBackend {
  slot: string;
  backend: Backend;
}

export interface RoundBackends {
  writers: WriterBackend[];
  baseline: Backend;
  decoy: Backend;
  defect: Backend;
  /** {backend, concurrency}; family eligibility comes from freeze.json. */
  judges: JudgeSlot[];
  /** Non-suspended judges + one gateway backend per distinct writer model. */
  forecasters: Backend[];
  maintainer: Backend;
  mergeEditor: Backend;
  /** Model id → gateway backend (calibration rewrites / degrades only). */
  calibGateway: ReadonlyMap<string, Backend>;
}

export interface Timeouts {
  judgeMs: number;
  writerMs: number;
  maintainerMs: number;
}

/**
 * Quota (rate-limit) handling of one `forge` invocation: tries are labelled `<id>-a<k>-q<n>` and never count as
 * attempts; the backoff index and `budgetMs` restart with every invocation (a rerun after QuotaExhausted waits the
 * full budget again), the `-q<n>` labels carry the history across reruns.
 */
export interface QuotaPolicy {
  isQuota: (r: CallResult) => boolean;
  /** Backoff before each quota retry; the last value repeats until the budget is spent. */
  delaysMs: readonly number[];
  /** Per task (default 6 h, `--quota-budget-min`). */
  budgetMs: number;
}

/** Fired by callWithRetry outside safeCall's try/catch; a throw is a crash (tests use it to simulate a kill). */
export interface RunHooks {
  beforeCall?: (taskId: string, attempt: number) => void;
  afterCall?: (taskId: string, attempt: number) => void;
}

/**
 * The only filesystem writer of the engine. Every path is normalized (resolve, realpath of the parent,
 * NFC + case-fold) and checked against OWNER_ONLY (→ OwnerFileError) and the write-root allowlist
 * (forge root, `<repo>/world/current/`, `.sealed/`, `.runs/`). Writes are tmp + rename. Methods take absolute
 * paths and return the forge-root-relative key used in markers.
 */
export interface RoundFiles {
  readonly root: string;
  rel(path: string): string;
  writeJson(path: string, value: unknown): string;
  writeText(path: string, text: string): string;
  /** Engine logs only (progress, benchmark/log.jsonl, mirror.jsonl, regression pool); via store.appendRecords. */
  appendLine(path: string, value: unknown): string;
  appendLines(path: string, values: readonly unknown[]): string;
  /** Exclusive create (`wx`); false when the file already exists (nothing written). */
  createExclusive(path: string, text: string): boolean;
  /** Rename within the allowed roots (stale markers / task records). */
  move(from: string, to: string): string;
  /** Delete a file if present (stray `*.tmp`, canon restore of paths absent at base). */
  remove(path: string): void;
}

/** `start.json`, written by 00-start. */
export interface StartRecord {
  round: string;
  seed: string;
  branch: string;
  base_sha: string;
  issue: { number: number; url: string };
  bundle_sha256: string;
  doctor_sha256: string;
  started_at: string;
  /** Fixed cell file (forge-root-relative) from `round start --cell`, else null (topic offered at 01). */
  cell: string | null;
}

/** `forge round start` options carried into 00-start (ignored by later steps). */
export interface StartOptions {
  cell: string | null;
  /** `--seed <hex>`; null = Entropy. */
  seed: string | null;
}

/** `github.json` (tracked, no secrets, outside the protocol bundle). */
export interface GithubConfig {
  repo: string;
  epicIssue: number;
  baseBranch: string;
}

export interface StepContext {
  root: string;
  repo: string;
  roundId: string;
  pipeline: Pipeline;
  paths: RoundPaths;
  files: RoundFiles;
  startOptions: StartOptions;
  github: GithubConfig;
  config: ForgeConfig;
  protocol: Protocol;
  bundleSha256: string;
  rules: RoundRules;
  backends: RoundBackends;
  /** github and git are already wrapped in scannedGitHub / scannedGit. */
  ports: Ports;
  owner: OwnerInputs;
  timeouts: Timeouts;
  quota: QuotaPolicy;
  hooks: RunHooks;
  /** By backend id (judge concurrency; writers 3). */
  limiters: ReadonlyMap<string, Limiter>;
  /** redactPublic with this run's PublicDeny; applied to every error string before it reaches a file. */
  redact(text: string): string;
  log(message: string): void;
  /** Appends to progress.jsonl, stamped with ports.clock.now(). */
  progress(step: string, status: ProgressStatus, detail: string): void;
  /** freeze.json.seed, else start.json.seed (calibration: the pairs.json set seed; bench-r00: the C00 set seed). */
  seed(): string;
  /** Throws before 00-start is marked. */
  start(): StartRecord;
  /** Throws before 02c-freeze is marked. */
  freeze(): FreezeRecord;
  /** The pinned benchmark (freeze.benchmark_resolution path + sha, re-hashed, never re-resolved; R00: the C00 pin). */
  benchmark(): Benchmark;
  /** The decision whose hash the 09b marker pins; steps after 09b never read owner.decision(). */
  decision(): Decision;
}

export interface EngineDeps {
  ports: Ports;
  backends(pipeline: Pipeline): RoundBackends;
  hooks?: RunHooks;
  env: Record<string, string | undefined>;
  pid: number;
  isAlive(pid: number): boolean;
  log(line: string): void;
}

export interface ContextInput {
  root: string;
  repo: string;
  roundId: string;
  pipeline: Pipeline;
  /** roundPaths(root, roundId), or calibPaths(root, set) for the calibration pipeline. */
  paths: RoundPaths;
  config: ForgeConfig;
  deps: EngineDeps;
  startOptions: StartOptions;
  /** `--quota-budget-min` in ms; null = the 6 h default. */
  quotaBudgetMs: number | null;
}

/** Owner-only globs, forge-root-relative; matched after normalizeForGuard. Only the UI and owner-sim write these. */
export const OWNER_ONLY: readonly string[] = ['owner-log.jsonl', 'rounds/*/audit.json', 'rounds/*/decision*.json', 'calibration/owner-answers.json'];

/** Thrown by RoundFiles for any write, append, move or removal of an OWNER_ONLY file. */
export class OwnerFileError extends Error {}

/** Thrown by RoundFiles for a path outside the allowed write roots, or a target that is a symlink or has extra hard links. */
export class WriteRootError extends Error {}

/** Gateway backends (writers, baseline, decoy, defect, gateway forecasters, calibration models) share one limiter. */
export const GATEWAY_CONCURRENCY = 3;
/** Quota backoff before each retry; the last value repeats until the budget is spent. */
export const QUOTA_DELAYS_MS: readonly number[] = [60, 120, 240, 480, 960, 1800].map((s) => s * 1000);
/** Per task (`--quota-budget-min` overrides). */
export const QUOTA_BUDGET_MS = 6 * 3600 * 1000;

const HEX64 = /^[0-9a-f]{64}$/u;
const ROUND_ID = /^[A-Z]\d{2}$/u;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** NFC + lower case: APFS is normalization- and (by default) case-insensitive, so both spellings name one file. */
function fold(text: string): string {
  return text.normalize('NFC').toLowerCase();
}

function toSlash(path: string): string {
  return path.split(sep).join('/');
}

/** `path` against `base` without lexical `..` collapsing, so symlinked directories resolve the way the OS does. */
function rawJoin(base: string, path: string): string {
  return isAbsolute(path) ? path : `${base}${sep}${path}`;
}

/** realpath of the deepest existing prefix (OS semantics, canonical case), then the missing tail resolved lexically. */
function physicalPath(raw: string): string {
  const parts = raw.split(sep);
  for (let k = parts.length; k > 0; k -= 1) {
    const prefix = parts.slice(0, k).join(sep);
    const probe = prefix === '' ? sep : prefix;
    if (!existsSync(probe)) continue;
    const tail = parts.slice(k).filter((s) => s !== '');
    return resolve(realpathSync.native(probe), ...tail);
  }
  return resolve(raw);
}

/** realpath of the parent plus the final name; a final `.` / `..` / trailing separator resolves as a directory. */
function physicalTarget(raw: string): string {
  const trimmed = raw.length > 1 && raw.endsWith(sep) ? raw.slice(0, -1) : raw;
  const name = basename(trimmed);
  if (name === '' || name === '.' || name === '..') return physicalPath(trimmed);
  return join(physicalPath(dirname(trimmed)), name);
}

function within(path: string, dir: string): boolean {
  const p = fold(path);
  const d = fold(dir);
  return p === d || p.startsWith(d.endsWith(sep) ? d : `${d}${sep}`);
}

/** `*` matches within one path segment. */
function globRegex(glob: string): RegExp {
  const body = fold(glob)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\/]/gu, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${body}$`, 'u');
}

const OWNER_PATTERNS: readonly RegExp[] = OWNER_ONLY.map(globRegex);

function isOwnerOnly(key: string): boolean {
  return OWNER_PATTERNS.some((re) => re.test(key));
}

function guardKey(realRoot: string, abs: string): string {
  return toSlash(relative(fold(realRoot), fold(abs)));
}

/** Forge-root-relative, NFC, case-folded form of `path` (realpath of the parent) used for the OWNER_ONLY match. */
export function normalizeForGuard(root: string, path: string): string {
  const base = resolve(root);
  return guardKey(physicalPath(base), physicalTarget(rawJoin(base, path)));
}

/** A final symlink or an extra hard link could alias an owner file (appends follow both), so neither is written. */
function aliasKind(path: string): 'symlink' | 'hard link' | null {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return 'symlink';
    return st.isFile() && st.nlink > 1 ? 'hard link' : null;
  } catch {
    return null;
  }
}

/**
 * The engine's only filesystem writer. Allowed write roots: the forge root (with `.sealed/` and `.runs/`) and
 * `<repo>/world/current/`. The I/O is store.ts (writeText = tmp + rename, appendRecords, createExclusive, removeFile);
 * every call acts on the physical path it checked.
 */
export function roundFiles(root: string, repo: string): RoundFiles {
  const base = resolve(root);
  const allowed = [physicalPath(base), join(physicalPath(resolve(repo)), 'world', 'current')];

  /** The checked physical path of a write (owner-only → OwnerFileError; outside the roots or aliased → WriteRootError). */
  function target(path: string): { abs: string; rel: string } {
    const realRoot = physicalPath(base);
    const abs = physicalTarget(rawJoin(base, path));
    const key = guardKey(realRoot, abs);
    if (isOwnerOnly(key)) throw new OwnerFileError(`the engine never writes owner-only files: ${key}`);
    if (!allowed.some((dir) => within(abs, dir))) throw new WriteRootError(`write outside the allowed roots: ${key}`);
    const alias = aliasKind(abs);
    if (alias !== null) throw new WriteRootError(`refusing to write through a ${alias}: ${key}`);
    return { abs, rel: toSlash(relative(realRoot, abs)) };
  }

  function writeTextAt(path: string, text: string): string {
    const t = target(path);
    writeText(t.abs, text);
    return t.rel;
  }

  function appendLines(path: string, values: readonly unknown[]): string {
    const t = target(path);
    appendRecords(t.abs, values);
    return t.rel;
  }

  return {
    root: base,
    rel: (path) => toSlash(relative(physicalPath(base), physicalTarget(rawJoin(base, path)))),
    writeText: writeTextAt,
    writeJson: (path, value) => writeTextAt(path, `${JSON.stringify(value, null, 2)}\n`),
    appendLine: (path, value) => appendLines(path, [value]),
    appendLines,
    createExclusive: (path, text) => createExclusive(target(path).abs, text),
    move(from, to) {
      const src = target(from);
      // Files only: a directory move would carry the owner-only files inside it past the guard.
      if (!lstatSync(src.abs).isFile()) throw new WriteRootError(`refusing to move a non-file: ${src.rel}`);
      const dst = target(to);
      mkdirSync(dirname(dst.abs), { recursive: true });
      renameSync(src.abs, dst.abs);
      return dst.rel;
    },
    remove(path) {
      removeFile(target(path).abs);
    },
  };
}

/** `github.json` → GithubConfig (repo `owner/name`, epic issue ≥ 1, non-empty base branch). */
export function parseGithubConfig(value: unknown): Result<GithubConfig> {
  const repo = readString(value, 'repo');
  const epicIssue = readNumber(value, 'epic_issue');
  const baseBranch = readString(value, 'base_branch');
  if (repo === null || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) return err('github.json: repo must look like owner/name');
  if (epicIssue === null || !Number.isInteger(epicIssue) || epicIssue < 1) return err('github.json: epic_issue must be a positive integer');
  if (baseBranch === null || !/^[^\s]+$/u.test(baseBranch)) return err('github.json: base_branch must be a non-empty branch name');
  return ok({ repo, epicIssue, baseBranch });
}

export function readGithubConfig(root: string): Result<GithubConfig> {
  const path = join(root, 'github.json');
  if (!existsSync(path)) return err('github.json not found in the forge root');
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parseGithubConfig(raw);
  } catch (e) {
    return err(`github.json is not valid JSON: ${message(e)}`);
  }
}

function nonEmpty(value: unknown, key: string): string | null {
  const v = readString(value, key);
  return v === null || v.trim() === '' ? null : v;
}

/** Absent keys (older files) read as null; a present key of the wrong type is an error. */
function nullableString(value: unknown, key: string): { ok: true; value: string | null } | { ok: false } {
  if (!isRecord(value) || !Object.hasOwn(value, key) || value[key] === null) return { ok: true, value: null };
  const v = value[key];
  return typeof v === 'string' ? { ok: true, value: v } : { ok: false };
}

export function parseStartRecord(value: unknown): Result<StartRecord> {
  const round = readString(value, 'round');
  const seed = nonEmpty(value, 'seed');
  const branch = nonEmpty(value, 'branch');
  const baseSha = nonEmpty(value, 'base_sha');
  const issue = readRecord(value, 'issue');
  const issueNumber = readNumber(issue, 'number');
  const issueUrl = readString(issue, 'url');
  const bundle = readString(value, 'bundle_sha256');
  const doctor = readString(value, 'doctor_sha256');
  const startedAt = readString(value, 'started_at');
  const cell = nullableString(value, 'cell');
  if (round === null || !ROUND_ID.test(round)) return err('start.json: round must look like R01');
  if (seed === null || branch === null || baseSha === null) return err('start.json: seed, branch and base_sha are required strings');
  if (issueNumber === null || !Number.isInteger(issueNumber) || issueNumber < 1 || issueUrl === null) return err('start.json: issue needs a positive number and a url');
  if (bundle === null || !HEX64.test(bundle) || doctor === null || !HEX64.test(doctor)) return err('start.json: bundle_sha256 and doctor_sha256 must be SHA-256 hex');
  if (startedAt === null || !isIsoTimestamp(startedAt)) return err('start.json: started_at must be an ISO 8601 UTC timestamp');
  if (!cell.ok) return err('start.json: cell must be a string or null');
  return ok({
    round,
    seed,
    branch,
    base_sha: baseSha,
    issue: { number: issueNumber, url: issueUrl },
    bundle_sha256: bundle,
    doctor_sha256: doctor,
    started_at: startedAt,
    cell: cell.value,
  });
}

interface PinnedBenchmark {
  version: string;
  sha256: string;
  /** Forge-root-relative. */
  path: string;
}

/** Error texts name forge-root-relative files only: they can reach status.json, where an absolute path would be redacted to nothing useful. */
function readJsonOrThrow(path: string, what: string): unknown {
  if (!existsSync(path)) throw new Error(`${what} is missing`);
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return raw;
  } catch (e) {
    throw new IntegrityError(`${what} is not valid JSON: ${message(e)}`);
  }
}

/** `calibration/<set>/pin.json` → the benchmark it pinned (s4: `{set, benchmark_version, benchmark_sha256, …}`); null before c4. */
function calibrationPin(root: string, set: string): PinnedBenchmark | null {
  const path = join(root, 'calibration', set, 'pin.json');
  if (!existsSync(path)) return null;
  const raw = readJsonOrThrow(path, `calibration/${set}/pin.json`);
  const version = readString(raw, 'benchmark_version');
  const sha = readString(raw, 'benchmark_sha256');
  if (version === null || !/^v\d+$/u.test(version) || sha === null || !HEX64.test(sha)) {
    throw new IntegrityError(`calibration/${set}/pin.json: benchmark_version and benchmark_sha256 are required`);
  }
  return { version, sha256: sha, path: `benchmark/${version}.json` };
}

/** Re-hashes the pinned file (never re-resolves); a changed file is an integrity error. */
function loadPinnedBenchmark(root: string, pin: PinnedBenchmark): { raw: unknown; bench: Benchmark } {
  const path = join(root, pin.path);
  if (!existsSync(path)) throw new IntegrityError(`pinned benchmark ${pin.path} is missing`);
  const bytes = readFileSync(path);
  if (sha256Bytes(bytes) !== pin.sha256) throw new IntegrityError(`pinned benchmark ${pin.path} changed since it was pinned`);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    throw new IntegrityError(`pinned benchmark ${pin.path} is not valid JSON: ${message(e)}`);
  }
  const bench = parseBenchmark(raw);
  if (!bench.ok) throw new IntegrityError(`pinned benchmark ${pin.path}: ${bench.error}`);
  if (bench.value.version !== pin.version) throw new IntegrityError(`pinned benchmark ${pin.path} is ${bench.value.version}, not ${pin.version}`);
  return { raw, bench: bench.value };
}

/** Latest decision file (`decision.json` < `decision-2.json` < …) listed by the 09b marker, with its pinned hash. */
function pinnedDecision(markers: string, roundId: string): { file: string; sha256: string } {
  const marker = readMarker(join(markers, '09b-decision.json'));
  if (marker === null || !marker.ok || marker.value.result !== 'done') throw new Error('decision() before 09b-decision is marked');
  const dir = `rounds/${roundId}/`;
  let best: { file: string; sha256: string; n: number } | null = null;
  for (const [file, hash] of [...Object.entries(marker.value.inputs), ...Object.entries(marker.value.outputs)]) {
    const m = file.startsWith(dir) ? DECISION_FILE.exec(file.slice(dir.length)) : null;
    if (m === null) continue;
    const n = m[1] === undefined ? 1 : Number(m[1]);
    if (best === null || n > best.n) best = { file, sha256: hash, n };
  }
  if (best === null) throw new IntegrityError(`09b-decision marker of ${roundId} pins no decision file`);
  return { file: best.file, sha256: best.sha256 };
}

function buildLimiters(backends: RoundBackends, config: ForgeConfig): ReadonlyMap<string, Limiter> {
  const out = new Map<string, Limiter>();
  const put = (id: string, l: Limiter): void => {
    if (!out.has(id)) out.set(id, l);
  };
  for (const j of backends.judges) put(j.backend.id, limiter(j.concurrency));
  put(backends.maintainer.id, limiter(config.maintainer.concurrency));
  put(backends.mergeEditor.id, limiter(config.mergeEditor.concurrency));
  const gateway = limiter(GATEWAY_CONCURRENCY);
  for (const w of backends.writers) put(w.backend.id, gateway);
  // Forecasters that are judges keep their judge limiter (set above); gateway forecasters share the pool.
  for (const b of [backends.baseline, backends.decoy, backends.defect, ...backends.forecasters, ...backends.calibGateway.values()]) put(b.id, gateway);
  return out;
}

/**
 * Loads the protocol bundle and github.json; builds RoundFiles and the limiters; wraps github / git in
 * scannedGitHub / scannedGit with publicDeny(config.local, deps.env). `rules` follows the pinned benchmark once
 * 02c is marked; `owner` is a fresh reader on every access (the UI may write between steps).
 */
export function buildContext(input: ContextInput): Result<StepContext> {
  const { root, repo, roundId, pipeline, paths, config, deps } = input;
  if (paths.id !== roundId) return err(`context: paths are for ${paths.id}, not ${roundId}`);
  const bundle = loadProtocolBundle(root);
  if (!bundle.ok) return bundle;
  const github = readGithubConfig(root);
  if (!github.ok) return github;
  let backends: RoundBackends;
  try {
    backends = deps.backends(pipeline);
  } catch (e) {
    return err(`backends: ${message(e)}`);
  }
  const deny = publicDeny(config.local, deps.env);
  const redact = (text: string): string => redactPublic(text, deny);
  const files = roundFiles(root, repo);
  const ports: Ports = { ...deps.ports, github: scannedGitHub(deps.ports.github, deny), git: scannedGit(deps.ports.git, repo, deny) };
  const protocol = bundle.value.protocol;
  let pinnedRules: RoundRules | null = null;

  const readFreeze = (): FreezeRecord => {
    const parsed = parseFreeze(readJsonOrThrow(paths.freeze, `rounds/${roundId}/freeze.json`));
    if (!parsed.ok) throw new IntegrityError(`rounds/${roundId}/freeze.json: ${parsed.error}`);
    return parsed.value;
  };
  const benchmarkPin = (): PinnedBenchmark | null => {
    if (pipeline === 'bench-initial') return null;
    if (pipeline === 'calibration') return calibrationPin(root, roundId);
    if (pipeline === 'bench-r00') return calibrationPin(root, 'C00');
    if (!isDone(ctx, '02c-freeze')) return null;
    const res = readFreeze().benchmark_resolution;
    if (res === null) throw new IntegrityError(`rounds/${roundId}/freeze.json has no benchmark_resolution (prototype freeze)`);
    return { version: res.version, sha256: res.sha256, path: res.path };
  };

  const ctx: StepContext = {
    root,
    repo,
    roundId,
    pipeline,
    paths,
    files,
    startOptions: input.startOptions,
    github: github.value,
    config,
    protocol,
    bundleSha256: bundle.value.bundleSha256,
    get rules(): RoundRules {
      if (pinnedRules !== null) return pinnedRules;
      const pin = benchmarkPin();
      if (pin === null) return roundRules(protocol, null);
      pinnedRules = roundRules(protocol, loadPinnedBenchmark(root, pin).raw);
      return pinnedRules;
    },
    backends,
    ports,
    get owner(): OwnerInputs {
      return ownerInputs(root);
    },
    timeouts: { judgeMs: config.judgeTimeoutMs, writerMs: config.writerTimeoutMs, maintainerMs: config.judgeTimeoutMs },
    quota: { isQuota: isQuotaError, delaysMs: QUOTA_DELAYS_MS, budgetMs: input.quotaBudgetMs ?? QUOTA_BUDGET_MS },
    hooks: deps.hooks ?? {},
    limiters: buildLimiters(backends, config),
    redact,
    log: (m) => deps.log(m),
    progress(step, status, detail) {
      files.appendLine(paths.progress, { at: ports.clock.now(), step, status, detail: redact(detail) });
    },
    seed(): string {
      if (pipeline === 'calibration' || pipeline === 'bench-r00') {
        const set = pipeline === 'calibration' ? roundId : 'C00';
        const raw = readJsonOrThrow(join(root, 'calibration', 'pairs.json'), 'calibration/pairs.json');
        const seed = readString(readRecord(readRecord(raw, 'sets'), set), 'seed');
        if (seed === null || seed === '') throw new IntegrityError(`calibration/pairs.json has no seed for ${set}`);
        return seed;
      }
      if (pipeline === 'round' && isDone(ctx, '02c-freeze')) {
        const seed = readFreeze().seed;
        if (seed !== null) return seed;
      }
      return ctx.start().seed;
    },
    start(): StartRecord {
      const parsed = parseStartRecord(readJsonOrThrow(paths.start, `rounds/${roundId}/start.json`));
      if (!parsed.ok) throw new IntegrityError(parsed.error);
      return parsed.value;
    },
    freeze(): FreezeRecord {
      if (!isDone(ctx, '02c-freeze')) throw new Error('freeze() before 02c-freeze is marked');
      return readFreeze();
    },
    benchmark(): Benchmark {
      const pin = benchmarkPin();
      if (pin === null) {
        if (pipeline === 'bench-initial') throw new Error('bench-initial has no pinned benchmark');
        if (pipeline === 'round') throw new Error('benchmark() before 02c-freeze is marked');
        throw new Error(`benchmark() before calibration/${pipeline === 'calibration' ? roundId : 'C00'}/pin.json exists`);
      }
      return loadPinnedBenchmark(root, pin).bench;
    },
    decision(): Decision {
      const pin = pinnedDecision(paths.markers, roundId);
      const path = join(root, pin.file);
      if (!existsSync(path)) throw new IntegrityError(`${pin.file} pinned by 09b-decision is missing`);
      const bytes = readFileSync(path);
      if (sha256Bytes(bytes) !== pin.sha256) throw new IntegrityError(`${pin.file} changed after 09b-decision pinned it`);
      let raw: unknown;
      try {
        raw = JSON.parse(bytes.toString('utf8'));
      } catch (e) {
        throw new IntegrityError(`${pin.file} is not valid JSON: ${message(e)}`);
      }
      const parsed = parseDecision(raw, pin.file);
      if (!parsed.ok) throw new IntegrityError(parsed.error);
      return parsed.value;
    },
  };
  return ok(ctx);
}
