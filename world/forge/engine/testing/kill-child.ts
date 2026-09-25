/**
 * Toy harness for the runner tests and the child-process entry of `runner.kill.test.ts`
 * (`node engine/testing/kill-child.ts <dir>`). Toy steps stand in for real ones; `toyTask` runs the real runTask
 * (`.runs/<RNN>/<label>.out.txt` → `calls/<label>.json` → hooks → `tasks/<id>.json`) on a toy backend.
 * Test-only: nothing outside tests imports it.
 */
import { copyFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Backend } from '../adapters/types.ts';
import { limiter } from '../calls.ts';
import { loadConfig } from '../config.ts';
import type { Limiter, RoundBackends, RoundFiles, RunHooks, StartRecord, StepContext } from '../context.ts';
import { parseFreeze } from '../freeze.ts';
import { isRecord, readString } from '../json.ts';
import type { OwnerInputs } from '../owner-inputs.ts';
import type { GitHubComment, GitHubIssue, GitHubPort, GitPort, Ports } from '../ports.ts';
import { err, ok, type Result } from '../result.ts';
import { loadProtocolBundle, roundRules } from '../rules.ts';
import { runAll, runSteps, type StepDef, type StepId } from '../runner.ts';
import { runTask, type TaskSpec } from '../task.ts';
import { appendRecords, createExclusive, progress, readJson, roundPaths, writeJson, writeText } from '../store.ts';
import { fakeClock, type FakeClock } from './fakes.ts';

const FORGE = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BUNDLE_COPY: readonly string[] = ['PROTOCOL.md', 'families.json', 'judges.json', 'writers.json'];

export const TOY_ROUND = 'R01';
export const TOY_BRANCH = 'forge/r01';
export const TOY_START_ISO = '2026-10-01T00:00:00.000Z';

export interface ToyWorld {
  dir: string;
  repo: string;
  root: string;
  /** File log of every backend call (`taskId#attempt` JSON lines). */
  callLog: string;
}

/** `<dir>/repo/world/forge` with copies of the bundle and writers.json, a toy fact table and benchmark v1. */
export function toyWorld(dir: string): ToyWorld {
  const world = openToyWorld(dir);
  mkdirSync(world.root, { recursive: true });
  for (const name of BUNDLE_COPY) copyFileSync(join(FORGE, name), join(world.root, name));
  writeText(join(world.root, 'fact-status.json'), '{"facts":[]}\n');
  writeText(join(world.root, 'benchmark', 'v1.json'), '{"version":"v1"}\n');
  return world;
}

export function openToyWorld(dir: string): ToyWorld {
  const repo = join(dir, 'repo');
  return { dir, repo, root: join(repo, 'world', 'forge'), callLog: join(dir, 'calls.log') };
}

export function toyFiles(root: string): RoundFiles {
  const rel = (path: string): string => relative(root, path).split(sep).join('/');
  return {
    root,
    rel,
    writeJson: (path, value) => {
      writeJson(path, value);
      return rel(path);
    },
    writeText: (path, text) => {
      writeText(path, text);
      return rel(path);
    },
    appendLine: (path, value) => {
      appendRecords(path, [value]);
      return rel(path);
    },
    appendLines: (path, values) => {
      appendRecords(path, values);
      return rel(path);
    },
    createExclusive: (path, text) => createExclusive(path, text),
    move: (from, to) => {
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      return rel(to);
    },
    remove: (path) => rmSync(path, { force: true }),
  };
}

export interface ToyGitState {
  branch: string;
  clean: boolean;
  checkouts: string[];
}

function unused<T>(): Promise<Result<T>> {
  return Promise.resolve(err('toy port: not used by runner tests'));
}

export function toyGit(state: ToyGitState): GitPort {
  return {
    currentBranch: async () => ok(state.branch),
    branchExists: () => unused(),
    listBranches: () => unused(),
    createBranch: () => unused(),
    checkout: async (name) => {
      state.checkouts.push(name);
      state.branch = name;
      return ok(undefined);
    },
    show: () => unused(),
    isClean: async () => ok(state.clean),
    diff: () => unused(),
    commit: () => unused(),
    push: () => unused(),
    changedPaths: () => unused(),
    untracked: () => unused(),
    resolveRef: () => unused(),
    isAncestor: () => unused(),
  };
}

function toyOwner(): OwnerInputs {
  return {
    entries: () => [],
    protocolApproval: () => null,
    topic: () => ({ state: 'missing' }),
    audit: () => ({ state: 'missing' }),
    decision: () => ({ state: 'missing' }),
    diffApproved: () => null,
    calibAnswers: () => ({ state: 'missing' }),
    benchDiffViewed: () => null,
    benchApproved: () => null,
    rollbacks: () => [],
  };
}

/** Logs `taskId#attempt` to the world's call log file, then answers `out:<prompt>`. */
export function toyBackend(callLog: string): Backend {
  return {
    id: 'toy',
    family: 'Moonshot',
    model: 'toy-model',
    call: async (prompt, opts) => {
      appendRecords(callLog, [`${opts.taskId}#${opts.attempt}`]);
      return { ok: true, text: `out:${prompt}`, servedModel: 'toy-model', version: null, ms: 1, tokensIn: null, tokensOut: null, costUsd: null, error: null, raw: '' };
    },
  };
}

export interface ToyContextOptions {
  hooks?: RunHooks;
  git?: ToyGitState;
  clock?: FakeClock;
  logs?: string[];
  concurrency?: number;
}

function toyStart(path: string): StartRecord {
  const v = readJson(path);
  const branch = readString(v, 'branch');
  if (!isRecord(v) || branch === null) throw new Error('toy start.json: no branch');
  return {
    round: readString(v, 'round') ?? TOY_ROUND,
    seed: readString(v, 'seed') ?? 'toy-seed',
    branch,
    base_sha: readString(v, 'base_sha') ?? '0'.repeat(40),
    issue: { number: 2, url: 'https://example.invalid/issues/2' },
    bundle_sha256: readString(v, 'bundle_sha256') ?? '',
    doctor_sha256: readString(v, 'doctor_sha256') ?? '',
    started_at: readString(v, 'started_at') ?? TOY_START_ISO,
    cell: null,
  };
}

/** A full StepContext over the toy world (bundle hash recomputed from the world's files, like a new process). */
export function toyContext(world: ToyWorld, opts: ToyContextOptions = {}): StepContext {
  const config = loadConfig(world.root, { requireLocal: false });
  if (!config.ok) throw new Error(config.error);
  const bundle = loadProtocolBundle(world.root);
  if (!bundle.ok) throw new Error(bundle.error);
  const paths = roundPaths(world.root, TOY_ROUND);
  const clock = opts.clock ?? fakeClock(TOY_START_ISO);
  const git = opts.git ?? { branch: TOY_BRANCH, clean: true, checkouts: [] };
  const logs = opts.logs ?? [];
  const backend = toyBackend(world.callLog);
  const github: GitHubPort = {
    findIssue: () => unused<GitHubIssue | null>(),
    createIssue: () => unused<GitHubIssue>(),
    listComments: () => unused<GitHubComment[]>(),
    createComment: () => unused<GitHubComment>(),
  };
  const ports: Ports = {
    github,
    git: toyGit(git),
    clock,
    entropy: { bytes: (n) => Buffer.alloc(n, 7) },
    doctor: { run: async () => ok('toy doctor') },
    assembler: { assemble: () => unused() },
  };
  const backends: RoundBackends = { writers: [], baseline: backend, decoy: backend, defect: backend, judges: [], forecasters: [], maintainer: backend, mergeEditor: backend, calibGateway: new Map() };
  const limiters = new Map<string, Limiter>([[backend.id, limiter(opts.concurrency ?? 2)]]);
  return {
    root: world.root,
    repo: world.repo,
    roundId: TOY_ROUND,
    pipeline: 'round',
    paths,
    files: toyFiles(world.root),
    startOptions: { cell: null, seed: null },
    github: { repo: 'toy/toy', epicIssue: 1, baseBranch: 'main' },
    config: config.value,
    protocol: bundle.value.protocol,
    bundleSha256: bundle.value.bundleSha256,
    rules: roundRules(bundle.value.protocol, null),
    backends,
    ports,
    owner: toyOwner(),
    timeouts: { judgeMs: 1000, writerMs: 1000, maintainerMs: 1000 },
    quota: { isQuota: () => false, delaysMs: [1000], budgetMs: 1000 },
    hooks: opts.hooks ?? {},
    limiters,
    redact: (text) => text.replaceAll('fixture-gateway.invalid', '[redacted:gateway-host]'),
    log: (message) => {
      logs.push(message);
    },
    progress: (step, status, detail) => progress(paths, step, status, detail, clock.now()),
    seed: () => 'toy-seed',
    start: () => toyStart(paths.start),
    freeze: () => {
      const f = parseFreeze(readJson(paths.freeze));
      if (!f.ok) throw new Error(f.error);
      return f.value;
    },
    benchmark: () => {
      throw new Error('toy context: no benchmark');
    },
    decision: () => {
      throw new Error('toy context: no decision');
    },
  };
}

/**
 * A paid toy task through the real runTask (baseline backend, limiter, abortable call, guarded hooks, call-record
 * recovery, task record): reuse `tasks/<id>.json`; else recover `calls/<id>-a1.json` whose `output_sha256`
 * matches `.runs/<RNN>/<id>-a1.out.txt`; else call. The toy backend answers `out:<prompt>`.
 */
export async function toyTask(ctx: StepContext, id: string, prompt: string): Promise<string> {
  const spec: TaskSpec<string> = { id, role: 'toy', prompt, parse: (text) => (text === `out:${prompt}` ? ok(text) : err('expected out:<prompt>')) };
  const r = await runTask(ctx, ctx.backends.baseline, spec);
  if (r.value === null) throw new Error(`toy task ${id} is void: ${r.error ?? 'void'}`);
  return r.value;
}

/** Writes `rounds/R01/<file>` (content `text`) and returns done listing it; `inputs` are listed as read. */
export function toyWriteStep(id: StepId, file: string, text: string, inputs: readonly string[] = []): StepDef {
  return {
    id,
    run: async (ctx) => {
      const rel = ctx.files.writeText(join(ctx.paths.dir, file), text);
      return { kind: 'done', inputs: [...inputs], outputs: [rel], external: [] };
    },
  };
}

/** 00-start: writes start.json on the toy branch. */
export const toyStartStep: StepDef = {
  id: '00-start',
  run: async (ctx) => {
    const rel = ctx.files.writeJson(ctx.paths.start, { round: TOY_ROUND, seed: 'toy-seed', branch: TOY_BRANCH, started_at: ctx.ports.clock.now() });
    return { kind: 'done', inputs: [], outputs: [rel], external: [] };
  },
};

/** Runs `taskIds` through runAll + toyTask and writes their outputs to `rounds/R01/<id>.json`. */
export function toyPaidStep(id: StepId, taskIds: readonly string[]): StepDef {
  return {
    id,
    run: async (ctx) => {
      const texts = await runAll(ctx, taskIds.map((t) => () => toyTask(ctx, t, `prompt ${t}`)));
      const rel = ctx.files.writeJson(join(ctx.paths.dir, `${id}.json`), texts);
      return { kind: 'done', inputs: [], outputs: [rel], external: [] };
    },
  };
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The task whose afterCall blocks the child (call record written, task record not yet). */
export const KILL_TASK = 'toy-t3';
export const KILL_TASKS: readonly string[] = ['toy-t1', 'toy-t2', KILL_TASK, 'toy-t4'];
export const KILL_STEPS: readonly StepDef[] = [toyStartStep, toyPaidStep('01-topic', KILL_TASKS)];
export const KILL_SIGNAL = 'blocked.signal';
export const KILL_STRAY = 'rounds/R01/topic-offer.json.dead.tmp';

async function childMain(dir: string): Promise<void> {
  const world = openToyWorld(dir);
  const hooks: RunHooks = {
    afterCall: (taskId) => {
      if (taskId !== KILL_TASK) return;
      writeFileSync(join(world.root, KILL_STRAY), '{"torn":');
      writeFileSync(join(dir, KILL_SIGNAL), String(process.pid));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
      process.exit(99);
    },
  };
  const ctx = toyContext(world, { hooks, concurrency: 1 });
  await runSteps(ctx, { pipeline: 'round', steps: KILL_STEPS, until: null, from: null, redoFrom: null, pid: process.pid, isAlive: processAlive });
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (dir === undefined) throw new Error('usage: node engine/testing/kill-child.ts <dir>');
  await childMain(dir);
}
