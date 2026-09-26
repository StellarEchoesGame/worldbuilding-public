import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveBenchmark, AUTO_DELAY_MS, type Resolution } from './bench-active.ts';
import { roundNumber, validateBenchFile } from './bench-check.ts';
import type { RollbackEntry } from './bench-validate.ts';
import { BENCH_R00_STEPS, initialPaths, initialRefusal, INITIAL_STEPS } from './bench-cycle.ts';
import { pendingVersions } from './bench-evidence.ts';
import { readBenchLog } from './bench-log.ts';
import { calibPaths } from './calib-build.ts';
import type { MergecheckSinks } from './cli-merge.ts';
import { parseArgs, quotaBudget, report, roundContext, type ForgeRoots } from './cli-round.ts';
import { loadConfig } from './config.ts';
import { latestFrozenRound } from './freeze.ts';
import { buildContext, type EngineDeps, type StepContext } from './context.ts';
import { readString } from './json.ts';
import { isDone, readMarker } from './marker.ts';
import { postedBenchNotices } from './mirror-log.ts';
import { ownerInputs, readOwnerLog } from './owner-inputs.ts';
import { err, ok, type Result } from './result.ts';
import { findBenchmark, loadProtocolBundle, parseRollbacks } from './rules.ts';
import { acquireEngineLock, EXIT, runSteps, type RoundStepId, type RunReport } from './runner.ts';
import { ROUND_STEPS } from './steps/index.ts';
import { roundPaths } from './store.ts';
import { IntegrityError } from './task.ts';

/*
 * `forge bench …` (plan §6, s3 §5) on the shared runner: `evidence|propose|validate|replay|activate RNN` run one cycle
 * step each (`--from X --until X`; round pipeline for R01+, bench-r00 for R00 after `forge calib score`),
 * `propose R00 --initial` runs the bench-initial pipeline (i1–i3), `activate --status` prints the resolution and
 * writes nothing, and `validate <file>` is the F1-01 file check (no local.json, no lock). Round-0 commands put the tree
 * on forge/r00 first (created from the base branch when absent), as cli-calib.ts does for calibration sets.
 */

/** Branch of every round-0 command (calibration C00, R00-init, R00). */
export const R00_BRANCH = 'forge/r00';

/** Sub-command → the one step it runs. */
export const BENCH_COMMAND_STEPS: Readonly<Record<'evidence' | 'propose' | 'validate' | 'replay' | 'activate', RoundStepId>> = {
  evidence: '11f-bench-evidence',
  propose: '11g-bench-propose',
  validate: '11h-bench-validate',
  replay: '11i-bench-replay',
  activate: '11j-bench-outcome',
};

export type BenchArgs =
  | { cmd: 'step'; step: RoundStepId; round: string; quotaBudgetMs: number | null }
  | { cmd: 'initial'; quotaBudgetMs: number | null }
  | { cmd: 'status' }
  /** round null = --round omitted (benchValidateCommand: newest frozen round + 1 with owner-log holds, else 0). */
  | { cmd: 'validate-file'; file: string; parent: string | null; round: number | null; rollbacks: string | null };

const ROUND_ID = /^R\d{2}$/u;
const EVIDENCE_USAGE = 'usage: forge bench evidence <RNN>';
const PROPOSE_USAGE = 'usage: forge bench propose <RNN> [--quota-budget-min <n>] | forge bench propose R00 --initial [--quota-budget-min <n>]';
const VALIDATE_USAGE = 'usage: forge bench validate <RNN> | forge bench validate <candidate.json> [--parent <parent.json>] [--round <n>] [--rollbacks <file>]';
const REPLAY_USAGE = 'usage: forge bench replay <RNN> [--quota-budget-min <n>]';
const ACTIVATE_USAGE = 'usage: forge bench activate <RNN> | forge bench activate --status';
const USAGE = [EVIDENCE_USAGE, PROPOSE_USAGE, VALIDATE_USAGE, REPLAY_USAGE, ACTIVATE_USAGE].join('\n');

type Sub = keyof typeof BENCH_COMMAND_STEPS;

function isSub(value: string | undefined): value is Sub {
  return value === 'evidence' || value === 'propose' || value === 'validate' || value === 'replay' || value === 'activate';
}

/** The one round id positional of a step sub-command. */
function roundArg(positional: readonly string[], usage: string): Result<string> {
  const id = positional[0];
  if (id === undefined || positional.length > 1) return err(usage);
  if (!ROUND_ID.test(id)) return err(`${id}: round ids look like R00 or R01\n${usage}`);
  return ok(id);
}

function validateFileArgs(rest: readonly string[]): Result<BenchArgs> {
  const args = parseArgs(rest, ['--parent', '--round', '--rollbacks'], []);
  if (!args.ok) return err(`${args.error}\n${VALIDATE_USAGE}`);
  const file = args.value.positional[0];
  if (file === undefined || args.value.positional.length > 1) return err(VALIDATE_USAGE);
  const roundText = args.value.values.get('--round');
  const round = roundText === undefined ? null : Number(roundText);
  if (round !== null && (!Number.isInteger(round) || round < 0)) return err(`--round must be a non-negative integer, got ${roundText ?? ''}`);
  return ok({ cmd: 'validate-file', file, parent: args.value.values.get('--parent') ?? null, round, rollbacks: args.value.values.get('--rollbacks') ?? null });
}

/** argv after `bench`; usage errors carry the usage text. */
export function parseBenchArgs(argv: readonly string[]): Result<BenchArgs> {
  const [sub, ...rest] = argv;
  if (!isSub(sub)) return err(USAGE);
  if (sub === 'validate' && rest[0] !== undefined && !rest[0].startsWith('--') && !ROUND_ID.test(rest[0])) return validateFileArgs(rest);
  const paid = sub === 'propose' || sub === 'replay';
  const usage = { evidence: EVIDENCE_USAGE, propose: PROPOSE_USAGE, validate: VALIDATE_USAGE, replay: REPLAY_USAGE, activate: ACTIVATE_USAGE }[sub];
  const bare = sub === 'propose' ? ['--initial'] : sub === 'activate' ? ['--status'] : [];
  const args = parseArgs(rest, paid ? ['--quota-budget-min'] : [], bare);
  if (!args.ok) return err(`${args.error}\n${usage}`);
  const quota = quotaBudget(args.value);
  if (!quota.ok) return quota;
  if (args.value.switches.has('--status')) {
    const given = args.value.positional;
    if (given.length > 1 || (given[0] !== undefined && !ROUND_ID.test(given[0]))) return err(ACTIVATE_USAGE);
    return ok({ cmd: 'status' });
  }
  const round = roundArg(args.value.positional, usage);
  if (!round.ok) return round;
  if (args.value.switches.has('--initial')) {
    if (round.value !== 'R00') return err(`--initial proposes the root version v1 of round 0: forge bench propose R00 --initial`);
    return ok({ cmd: 'initial', quotaBudgetMs: quota.value });
  }
  return ok({ cmd: 'step', step: BENCH_COMMAND_STEPS[sub], round: round.value, quotaBudgetMs: quota.value });
}

/** Final (done or skip) marker of `id` under a markers dir. */
function markedIn(markers: string, id: string): boolean {
  const m = readMarker(join(markers, `${id}.json`));
  return m !== null && m.ok && (m.value.result === 'done' || m.value.result === 'skip');
}

/** R rounds after round 0 that `forge round start` has started (rounds/RNN/start.json, NN ≥ 01). */
function startedRounds(root: string): string[] {
  const dir = join(root, 'rounds');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => ROUND_ID.test(n) && n !== 'R00' && existsSync(join(dir, n, 'start.json'))).sort();
}

/**
 * Why a bench-r00 step is refused, else null: C00 `c5-score` unmarked (the R00 cycle reads the scored C00 ledger), or
 * a later round already started (round 0 is closed once forge/r00 merged: its 11f inputs, calibration/labels.json and
 * status.json, are rewritten by the next round's 11e, so a rerun would only fail the marker chain).
 */
export function r00Refusal(root: string): string | null {
  if (!markedIn(calibPaths(root, 'C00').markers, 'c5-score')) return 'the R00 benchmark cycle runs after round-0 calibration: forge calib build / run / score (C00 c5-score is not marked)';
  const later = startedRounds(root);
  if (later.length > 0) return `round 0 is closed: ${later.join(', ')} already started (the R00 cycle cannot run again)`;
  return null;
}

function describe(label: string, r: Result<Resolution>): string {
  if (!r.ok) return `${label}: none (${r.error})`;
  const v = r.value;
  return `${label}: ${v.version} via ${v.via} since ${v.since} (${v.path}, sha256 ${v.sha256.slice(0, 12)})`;
}

/** `activate --status`: effective and head resolution at `at` plus pending versions (pendingVersions); err = unreadable logs. */
export function benchStatusLines(root: string, at: string): Result<string[]> {
  const log = readBenchLog(root);
  if (!log.ok) return log;
  const owner = readOwnerLog(root);
  if (!owner.ok) return err(`owner-log.jsonl needs repair: ${owner.error}`);
  const files = (path: string): string | null => {
    const abs = join(root, path);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  };
  const inputs = { log: log.value, owner: owner.value, posted: postedBenchNotices(root), files, autoDelayMs: AUTO_DELAY_MS };
  const lines = [`benchmark at ${at}`];
  try {
    lines.push(describe('effective (the next freeze pins it)', resolveBenchmark(inputs, at, 'effective')));
    lines.push(describe('head (the next proposal builds on it)', resolveBenchmark(inputs, at, 'head')));
  } catch (e) {
    if (e instanceof IntegrityError) return err(e.message);
    throw e;
  }
  const pending = pendingVersions(log.value, ownerInputs(root));
  if (pending.length === 0) lines.push('pending owner approval: none');
  for (const p of pending) lines.push(`pending owner approval: ${p.version} (logged ${p.since}); 基准 ${p.version} 待 owner 批准`);
  return ok(lines);
}

function usage(deps: EngineDeps, message: string): number {
  deps.log(`forge: ${message}`);
  return EXIT.usage;
}

/** Context of a round-0 pipeline (bench-initial under benchmark/initial/, bench-r00 on rounds/R00/). */
function round0Context(at: ForgeRoots, deps: EngineDeps, pipeline: 'bench-initial' | 'bench-r00', quotaBudgetMs: number | null): Result<StepContext> {
  const config = loadConfig(at.root, { requireLocal: true });
  if (!config.ok) return config;
  const paths = pipeline === 'bench-initial' ? initialPaths(at.root) : roundPaths(at.root, 'R00');
  return buildContext({ root: at.root, repo: at.repo, roundId: 'R00', pipeline, paths, config: config.value, deps, startOptions: { cell: null, seed: null }, quotaBudgetMs });
}

/**
 * Puts the working tree on forge/r00 (created from the base branch when absent) under the engine lock; the reason it
 * cannot, else null. Round 0 has no start.json, so the runner's own branch check never fires for it.
 */
async function ensureR00Branch(ctx: StepContext, deps: EngineDeps): Promise<string | null> {
  const lock = acquireEngineLock(ctx.root, deps.pid, (pid) => deps.isAlive(pid), ctx.ports.clock.now());
  if (!lock.ok) return lock.error;
  try {
    const git = ctx.ports.git;
    const current = await git.currentBranch();
    if (!current.ok) return `git: ${current.error}`;
    if (current.value === R00_BRANCH) return null;
    const clean = await git.isClean([]);
    if (!clean.ok) return `git: ${clean.error}`;
    if (!clean.value) return `on branch ${current.value} with a dirty working tree; round 0 runs on ${R00_BRANCH}`;
    const exists = await git.branchExists(R00_BRANCH);
    if (!exists.ok) return `git: ${exists.error}`;
    if (!exists.value) {
      const base = await git.resolveRef(ctx.github.baseBranch);
      if (!base.ok) return `git: ${base.error}`;
      const created = await git.createBranch(R00_BRANCH, base.value);
      if (!created.ok) return `git: ${created.error}`;
    }
    const checkout = await git.checkout(R00_BRANCH);
    if (!checkout.ok) return `git checkout ${R00_BRANCH}: ${checkout.error}`;
    ctx.log(`checked out ${R00_BRANCH} (was ${current.value})`);
    return null;
  } finally {
    lock.value.release();
  }
}

function run(ctx: StepContext, deps: EngineDeps, pipeline: 'round' | 'bench-initial' | 'bench-r00', step: RoundStepId | null): Promise<RunReport> {
  const steps = pipeline === 'round' ? ROUND_STEPS : pipeline === 'bench-r00' ? BENCH_R00_STEPS : INITIAL_STEPS;
  return runSteps(ctx, { pipeline, steps, until: step, from: step, redoFrom: null, pid: deps.pid, isAlive: (pid) => deps.isAlive(pid) });
}

/** `forge bench …` except the file form of validate; returns the runner exit code (0–5). */
export async function benchCommand(argv: readonly string[], deps: EngineDeps, at: ForgeRoots): Promise<number> {
  const args = parseBenchArgs(argv);
  if (!args.ok) return usage(deps, args.error);
  const a = args.value;
  if (a.cmd === 'validate-file') return usage(deps, 'the file form of forge bench validate runs without local.json (cli.ts benchValidateCommand)');
  if (a.cmd === 'status') {
    const lines = benchStatusLines(at.root, deps.ports.clock.now());
    if (!lines.ok) {
      deps.log(`forge: ${lines.error}`);
      return EXIT.integrity;
    }
    for (const line of lines.value) deps.log(line);
    return EXIT.done;
  }
  if (a.cmd === 'initial') {
    const refusal = initialRefusal(at.root, ownerInputs(at.root));
    if (refusal !== null) return usage(deps, refusal);
    const ctx = round0Context(at, deps, 'bench-initial', a.quotaBudgetMs);
    if (!ctx.ok) return usage(deps, ctx.error);
    const branch = await ensureR00Branch(ctx.value, deps);
    if (branch !== null) return usage(deps, branch);
    return report(deps, 'R00-init', await run(ctx.value, deps, 'bench-initial', null));
  }
  if (a.round === 'R00') {
    const refusal = r00Refusal(at.root);
    if (refusal !== null) return usage(deps, refusal);
    const ctx = round0Context(at, deps, 'bench-r00', a.quotaBudgetMs);
    if (!ctx.ok) return usage(deps, ctx.error);
    const branch = await ensureR00Branch(ctx.value, deps);
    if (branch !== null) return usage(deps, branch);
    return report(deps, 'R00', await run(ctx.value, deps, 'bench-r00', a.step));
  }
  const ctx = roundContext(at, deps, a.round, 'round', { cell: null, seed: null }, a.quotaBudgetMs);
  if (!ctx.ok) return usage(deps, ctx.error);
  if (!isDone(ctx.value, '00-start')) return usage(deps, `${a.round} is not started; run forge round start ${a.round} first`);
  return report(deps, a.round, await run(ctx.value, deps, 'round', a.step));
}

function readJsonFile(path: string): Result<unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return ok(value);
  } catch (e) {
    return err(`cannot read ${path} as JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The parent to validate against: --parent (a file), else the candidate's named parent from benchmark/, else null. */
function parentOf(at: ForgeRoots, cwd: string, parentArg: string | null, candidate: unknown, sinks: MergecheckSinks): Result<unknown> {
  if (parentArg !== null) return readJsonFile(resolve(cwd, parentArg));
  const named = readString(candidate, 'parent');
  if (named === null) return ok(null);
  const found = findBenchmark(at.root, named);
  if (!found.ok) return err(`candidate names parent ${named}: ${found.error}`);
  sinks.err(`parent ${named}: ${found.value.path}`);
  return ok(found.value.value);
}

/**
 * `forge bench validate <file> [--parent f] [--round n] [--rollbacks f]` (paths relative to `cwd`): verdict JSON on out,
 * exit 0 / 1. Without --rollbacks the holds come from the owner log's rollbacks (bench-check validateBenchFile), and
 * without --round they are judged at the newest frozen R round + 1 (1 when none is frozen; the UI stamps a rollback
 * with the newest frozen round, so round 0 would keep every hold active), printed on err. With --rollbacks the round
 * still defaults to 0.
 */
export function benchValidateCommand(argv: readonly string[], at: ForgeRoots, cwd: string, sinks: MergecheckSinks): number {
  const fail = (message: string): number => {
    sinks.err(`forge: ${message}`);
    return EXIT.usage;
  };
  const args = parseBenchArgs(['validate', ...argv]);
  if (!args.ok) return fail(args.error);
  const a = args.value;
  if (a.cmd !== 'validate-file') return fail(VALIDATE_USAGE);
  const bundle = loadProtocolBundle(at.root);
  if (!bundle.ok) return fail(bundle.error);
  const candidate = readJsonFile(resolve(cwd, a.file));
  if (!candidate.ok) return fail(candidate.error);
  const parent = parentOf(at, cwd, a.parent, candidate.value, sinks);
  if (!parent.ok) return fail(parent.error);
  let rollbacks: RollbackEntry[] | null = null;
  if (a.rollbacks !== null) {
    const raw = readJsonFile(resolve(cwd, a.rollbacks));
    if (!raw.ok) return fail(raw.error);
    const parsed = parseRollbacks(raw.value);
    if (!parsed.ok) return fail(parsed.error);
    rollbacks = parsed.value;
  }
  let round = a.round ?? 0;
  if (a.round === null && rollbacks === null) {
    const newest = latestFrozenRound(at.root);
    const n = newest === null ? ok(0) : roundNumber(newest);
    if (!n.ok) return fail(n.error);
    round = n.value + 1;
    sinks.err(`round ${round} (${newest === null ? 'no frozen round' : `newest frozen round ${newest} + 1`}); --round <n> judges the holds at another round`);
  }
  const verdict = validateBenchFile(at.root, bundle.value.protocol, { candidate: candidate.value, parent: parent.value, round, rollbacks });
  if (!verdict.ok) return fail(verdict.error);
  sinks.out(JSON.stringify(verdict.value, null, 2));
  return verdict.value.ok ? EXIT.done : EXIT.usage;
}
