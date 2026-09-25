import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  REQUEST_FILE, SET_ID, buildStep, calibPaths, readCalibPairs, readSetRequest, setKindOf, type BuildRequest, type RequalReason, type SetId, type SetKind,
  type SetRequest,
} from './calib-build.ts';
import { answersStep, dryrunStep, judgeStep } from './calib-run.ts';
import { scoreStep } from './calib-score.ts';
import { parseArgs, quotaBudget, type Args, type ForgeRoots } from './cli-round.ts';
import { isFamily, loadConfig } from './config.ts';
import { buildContext, type EngineDeps, type StepContext } from './context.ts';
import { readMarker } from './marker.ts';
import { err, ok, type Result } from './result.ts';
import { CALIB_STEP_IDS, EXIT, acquireEngineLock, runSteps, type CalibStepId, type RunReport, type StepDef, type StepId } from './runner.ts';
import { calibrationSets, openRoundBranches } from './steps/start.ts';
import { readTrustStatus, type TrustStatus } from './trust-status.ts';

/**
 * `forge calib build [--requal <Family> --reason calibration_fail|suspension | --gate <Family>] | run [--set <id>]
 * | score [--set <id>]` (s4 §4.6): ranges of CALIB_STEP_IDS on the runner with pipeline 'calibration' and
 * calibPaths(root, set). build = c1; run = c2–c4; score = c5. Exit codes are the runner's (0 done, 1 usage,
 * 2 waiting, 3 integrity, 4 blocked, 5 failed).
 */

export type CalibArgs =
  | { cmd: 'build'; req: BuildRequest; quotaBudgetMs: number | null }
  | { cmd: 'run'; set: SetId | null; only: CalibStepId | null; quotaBudgetMs: number | null }
  | { cmd: 'score'; set: SetId | null };

/** The calibration registry in CALIB_STEP_IDS order: buildStep, dryrunStep, answersStep, judgeStep, scoreStep. */
export const CALIB_STEPS: readonly StepDef[] = [buildStep, dryrunStep, answersStep, judgeStep, scoreStep];

const BUILD_USAGE = 'usage: forge calib build [--requal <Family> --reason calibration_fail|suspension | --gate <Family>] [--quota-budget-min <n>]';
const RUN_USAGE = 'usage: forge calib run [--set <id>] [--only c2-gate-dryrun|c3-owner-answers|c4-judge] [--quota-budget-min <n>]';
const SCORE_USAGE = 'usage: forge calib score [--set <id>]';
/** Steps `calib run --only` accepts (c1 is `calib build`, c5 is `calib score`). */
const RUN_STEPS: readonly CalibStepId[] = ['c2-gate-dryrun', 'c3-owner-answers', 'c4-judge'];

function isRequalReason(value: string): value is RequalReason {
  return value === 'calibration_fail' || value === 'suspension';
}

function buildRequest(args: Args): Result<BuildRequest> {
  const requal = args.values.get('--requal');
  const reason = args.values.get('--reason');
  const gate = args.values.get('--gate');
  if (requal !== undefined && gate !== undefined) return err('--requal and --gate exclude each other');
  if (reason !== undefined && requal === undefined) return err('--reason needs --requal');
  if (gate !== undefined) return isFamily(gate) ? ok({ kind: 'gate', family: gate }) : err(`--gate ${gate}: not a family`);
  if (requal === undefined) return ok({ kind: 'round0' });
  if (!isFamily(requal)) return err(`--requal ${requal}: not a family`);
  if (reason === undefined || !isRequalReason(reason)) return err('--requal needs --reason calibration_fail|suspension');
  return ok({ kind: 'requal', family: requal, reason });
}

function setFlag(args: Args): Result<SetId | null> {
  const v = args.values.get('--set');
  if (v === undefined) return ok(null);
  return SET_ID.test(v) ? ok(v) : err(`--set ${v}: set ids look like C00, Q01 or G01`);
}

function onlyFlag(args: Args): Result<CalibStepId | null> {
  const v = args.values.get('--only');
  if (v === undefined) return ok(null);
  const step = RUN_STEPS.find((s) => s === v);
  return step === undefined ? err(`--only ${v}: calib run steps are ${RUN_STEPS.join(', ')}`) : ok(step);
}

export function parseCalibArgs(argv: readonly string[]): Result<CalibArgs> {
  const [sub, ...rest] = argv;
  if (sub === 'build') {
    const args = parseArgs(rest, ['--requal', '--reason', '--gate', '--quota-budget-min'], []);
    if (!args.ok) return err(`${args.error}\n${BUILD_USAGE}`);
    if (args.value.positional.length > 0) return err(BUILD_USAGE);
    const req = buildRequest(args.value);
    const quota = quotaBudget(args.value);
    if (!req.ok) return req;
    if (!quota.ok) return quota;
    return ok({ cmd: 'build', req: req.value, quotaBudgetMs: quota.value });
  }
  if (sub === 'run') {
    const args = parseArgs(rest, ['--set', '--only', '--quota-budget-min'], []);
    if (!args.ok) return err(`${args.error}\n${RUN_USAGE}`);
    if (args.value.positional.length > 0) return err(RUN_USAGE);
    const set = setFlag(args.value);
    const only = onlyFlag(args.value);
    const quota = quotaBudget(args.value);
    if (!set.ok) return set;
    if (!only.ok) return only;
    if (!quota.ok) return quota;
    return ok({ cmd: 'run', set: set.value, only: only.value, quotaBudgetMs: quota.value });
  }
  if (sub === 'score') {
    const args = parseArgs(rest, ['--set'], []);
    if (!args.ok) return err(`${args.error}\n${SCORE_USAGE}`);
    if (args.value.positional.length > 0) return err(SCORE_USAGE);
    const set = setFlag(args.value);
    return set.ok ? ok({ cmd: 'score', set: set.value }) : set;
  }
  return err([BUILD_USAGE, RUN_USAGE, SCORE_USAGE].join('\n'));
}

/** C00 → `forge/r00`; Qnn / Gnn → `forge/calib-<set lowercased>` (steps/start.ts CALIB_BRANCH_PREFIX). */
export function calibBranch(set: SetId): string {
  return setKindOf(set) === 'round0' ? 'forge/r00' : `forge/calib-${set.toLowerCase()}`;
}

/** Set ids with a `calibration/<set>/` directory. */
function setDirs(root: string): SetId[] {
  const dir = join(root, 'calibration');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && SET_ID.test(e.name)).map((e) => e.name).sort();
}

const KIND_LETTER: Readonly<Record<SetKind, string>> = { round0: 'C', requal: 'Q', gate: 'G' };

/** Next free id of the kind: C00 once; Q / G = 1 + max over pairs.json keys and calibration/<set>/ dirs. */
export function nextSetId(root: string, kind: SetKind): Result<SetId> {
  const file = readCalibPairs(root);
  if (!file.ok) return file;
  const known = [...new Set([...Object.keys(file.value.sets), ...setDirs(root)])];
  if (kind === 'round0') return known.includes('C00') ? err('C00 already exists; round 0 is calibrated once') : ok('C00');
  const letter = KIND_LETTER[kind];
  const n = Math.max(0, ...known.filter((s) => s.startsWith(letter)).map((s) => Number(s.slice(1)))) + 1;
  if (n > 99) return err(`no ${letter} set id left (${letter}99 exists)`);
  return ok(`${letter}${String(n).padStart(2, '0')}`);
}

/** Final (done or skip) marker of a calibration step of `set`. */
function stepFinal(root: string, set: SetId, id: StepId): boolean {
  const m = readMarker(join(calibPaths(root, set).markers, `${id}.json`));
  return m !== null && m.ok && (m.value.result === 'done' || m.value.result === 'skip');
}

/** The set whose request.json exists but whose c1-build is unmarked (a killed build), else null. */
export function pendingBuild(root: string): Result<SetId | null> {
  const pending = setDirs(root).filter((s) => existsSync(join(calibPaths(root, s).dir, REQUEST_FILE)) && !stepFinal(root, s, 'c1-build'));
  if (pending.length > 1) return err(`several calibration builds are unfinished (${pending.join(', ')}); calibration/<set>/request.json should exist for one at a time`);
  return ok(pending[0] ?? null);
}

/** Why a build request is refused, else null: C00 twice; requal unless unqualified (calibration_fail) / suspended (suspension) and requal_used[reason] false; gate for a non-judge family. */
export function buildRefusal(status: TrustStatus | null, req: BuildRequest, existingSets: readonly SetId[]): string | null {
  if (req.kind === 'round0') return existingSets.includes('C00') ? 'C00 is already built; round 0 is calibrated once (continue it with forge calib run / score)' : null;
  const what = req.kind === 'gate' ? `--gate ${req.family}` : `--requal ${req.family}`;
  if (!existingSets.includes('C00')) return `${what}: build, answer and score C00 first`;
  if (status === null) return `${what}: calibration/status.json is missing (score C00 first: forge calib score --set C00)`;
  const fam = Object.hasOwn(status.families, req.family) ? status.families[req.family] : undefined;
  if (fam === undefined) return `${what}: ${req.family} is not a judge family of calibration/status.json`;
  if (req.kind === 'gate') return null;
  if (req.reason === 'calibration_fail' && fam.qualified) return `${what}: ${req.family} is qualified; --reason calibration_fail is for a family that failed calibration`;
  if (req.reason === 'suspension' && fam.suspended_at === null && fam.agreement.state !== 'suspended') return `${what}: ${req.family} is not suspended`;
  if (fam.requal_used[req.reason]) return `${what}: ${req.family} already used its ${req.reason} re-qualification`;
  return null;
}

/** Sets with an unmarked calibration step, among those with a request.json. */
function unfinishedSets(root: string): SetId[] {
  return setDirs(root).filter((s) => existsSync(join(calibPaths(root, s).dir, REQUEST_FILE)) && CALIB_STEP_IDS.some((id) => !stepFinal(root, s, id)));
}

/**
 * Default `--set` for run / score: the one set with an unmarked calibration step (several → err); when every set is
 * finished, the newest built set of pairs.json (by built_at, then id), else C00.
 */
export function defaultSet(root: string): Result<SetId> {
  const open = unfinishedSets(root);
  if (open.length > 1) return err(`several calibration sets are unfinished (${open.join(', ')}); pick one with --set`);
  const first = open[0];
  if (first !== undefined) return ok(first);
  const file = readCalibPairs(root);
  if (!file.ok) return file;
  const built = Object.entries(file.value.sets).sort(([a, x], [b, y]) => (x.built_at === y.built_at ? (a < b ? -1 : a > b ? 1 : 0) : x.built_at < y.built_at ? -1 : 1));
  return ok(built.at(-1)?.[0] ?? 'C00');
}

function sameRequest(stored: SetRequest, req: BuildRequest): boolean {
  if (stored.kind !== req.kind) return false;
  if (req.kind === 'round0') return true;
  if (req.kind === 'gate') return stored.family === req.family;
  return stored.family === req.family && stored.reason === req.reason;
}

function describe(r: SetRequest): string {
  if (r.kind === 'round0') return 'forge calib build';
  if (r.kind === 'gate') return `forge calib build --gate ${r.family ?? '?'}`;
  return `forge calib build --requal ${r.family ?? '?'} --reason ${r.reason ?? '?'}`;
}

/** Entropy bytes of a set seed (64 hex digits, within steps/start.ts SEED_PATTERN). */
const SET_SEED_BYTES = 32;

function usage(deps: EngineDeps, message: string): number {
  deps.log(`forge: ${message}`);
  return EXIT.usage;
}

function report(deps: EngineDeps, set: SetId, r: RunReport): number {
  const where = r.step === null ? '' : ` at ${r.step}`;
  const waiting = r.waitingFor === null ? '' : ` (waiting for ${r.waitingFor})`;
  deps.log(`${set}: ${r.state}${where}${waiting}${r.detail === '' ? '' : `: ${r.detail}`}`);
  return r.exitCode;
}

function context(at: ForgeRoots, deps: EngineDeps, set: SetId, quotaBudgetMs: number | null): Result<StepContext> {
  const config = loadConfig(at.root, { requireLocal: true });
  if (!config.ok) return config;
  return buildContext({
    root: at.root, repo: at.repo, roundId: set, pipeline: 'calibration', paths: calibPaths(at.root, set), config: config.value, deps,
    startOptions: { cell: null, seed: null }, quotaBudgetMs,
  });
}

/**
 * Puts the working tree on calibBranch(set): checkout when the tree is clean (created from the base branch first when
 * `create` and it does not exist); the reason it cannot, else null. calibPaths has no start.json, so the runner's
 * own branch check (ensureRoundBranch) never fires for calibration: this is the calibration pipeline's.
 */
async function ensureCalibBranch(ctx: StepContext, set: SetId, create: boolean): Promise<string | null> {
  const git = ctx.ports.git;
  const want = calibBranch(set);
  const current = await git.currentBranch();
  if (!current.ok) return `git: ${current.error}`;
  if (current.value === want) return null;
  const clean = await git.isClean([]);
  if (!clean.ok) return `git: ${clean.error}`;
  if (!clean.value) return `on branch ${current.value} with a dirty working tree; calibration set ${set} runs on ${want}`;
  const exists = await git.branchExists(want);
  if (!exists.ok) return `git: ${exists.error}`;
  if (!exists.value) {
    if (!create) return `branch ${want} of calibration set ${set} does not exist`;
    const base = await git.resolveRef(ctx.github.baseBranch);
    if (!base.ok) return `git: ${base.error}`;
    const created = await git.createBranch(want, base.value);
    if (!created.ok) return `git: ${created.error}`;
  }
  const checkout = await git.checkout(want);
  if (!checkout.ok) return `git checkout ${want}: ${checkout.error}`;
  ctx.log(`checked out ${want} (was ${current.value})`);
  return null;
}

/** The R round a round started now would be (1 + the newest `rounds/RNN/`, at least R01). */
function nextRound(root: string): string {
  const dir = join(root, 'rounds');
  const ns = existsSync(dir) ? readdirSync(dir).filter((n) => /^R\d{2}$/u.test(n)).map((n) => Number(n.slice(1))) : [];
  return `R${String(Math.max(0, ...ns) + 1).padStart(2, '0')}`;
}

/** A requal / gate build runs between rounds: every earlier engine branch (forge/rNN, forge/calib-*) must be merged. */
async function openRoundRefusal(ctx: StepContext): Promise<string | null> {
  const base = ctx.github.baseBranch;
  const sets = calibrationSets(ctx.root);
  if (!sets.ok) return sets.error;
  const open = await openRoundBranches(ctx.ports.git, ctx.root, nextRound(ctx.root), base, sets.value);
  if (!open.ok) return `git: ${open.error}`;
  if (open.value.length === 0) return null;
  return `${open.value.join(', ')} not merged into ${base} yet; a re-qualification or gate set is built between rounds (merge the PR and pull ${base} first)`;
}

/** Runs `prep` under the engine lock (released before runSteps takes it again); a refusal → exit 1 text. */
async function locked(ctx: StepContext, deps: EngineDeps, prep: () => Promise<string | null>): Promise<string | null> {
  const lock = acquireEngineLock(ctx.root, deps.pid, (pid) => deps.isAlive(pid), ctx.ports.clock.now());
  if (!lock.ok) return lock.error;
  try {
    return await prep();
  } finally {
    lock.value.release();
  }
}

function runRange(ctx: StepContext, deps: EngineDeps, from: CalibStepId | null, until: CalibStepId | null): Promise<RunReport> {
  return runSteps(ctx, { pipeline: 'calibration', steps: CALIB_STEPS, until, from, redoFrom: null, pid: deps.pid, isAlive: (pid) => deps.isAlive(pid) });
}

/** The set a build acts on: the pending build when its request matches (resume), else a fresh id after the refusals. */
function buildTarget(root: string, req: BuildRequest): Result<{ set: SetId; fresh: boolean }> {
  const pending = pendingBuild(root);
  if (!pending.ok) return pending;
  if (pending.value !== null) {
    const stored = readSetRequest(calibPaths(root, pending.value));
    if (!stored.ok) return stored;
    if (!sameRequest(stored.value, req)) return err(`${pending.value} is still being built (${describe(stored.value)}); finish it with that command first`);
    return ok({ set: pending.value, fresh: false });
  }
  const status = readTrustStatus(root);
  if (status !== null && !status.ok) return status;
  const file = readCalibPairs(root);
  if (!file.ok) return file;
  const refusal = buildRefusal(status === null ? null : status.value, req, [...new Set([...Object.keys(file.value.sets), ...setDirs(root)])]);
  if (refusal !== null) return err(refusal);
  const id = nextSetId(root, req.kind);
  return id.ok ? ok({ set: id.value, fresh: true }) : id;
}

/**
 * `calib build`: refusals (buildRefusal; a requal / gate set while an engine branch is unmerged), resume of a killed
 * build with the same request, else a new set id and `<set>/request.json` (seed from Entropy, exclusive create) on
 * calibBranch(set); then c1-build. The engine never commits calibration files (the set's PR carries them).
 */
async function build(req: BuildRequest, quotaBudgetMs: number | null, deps: EngineDeps, at: ForgeRoots): Promise<number> {
  const target = buildTarget(at.root, req);
  if (!target.ok) return usage(deps, target.error);
  const { set, fresh } = target.value;
  const ctx = context(at, deps, set, quotaBudgetMs);
  if (!ctx.ok) return usage(deps, ctx.error);
  const c = ctx.value;
  const refused = await locked(c, deps, async () => {
    if (fresh && req.kind !== 'round0') {
      const open = await openRoundRefusal(c);
      if (open !== null) return open;
    }
    const branch = await ensureCalibBranch(c, set, true);
    if (branch !== null || !fresh) return branch;
    const request: SetRequest = {
      set, kind: req.kind, family: req.kind === 'round0' ? null : req.family, reason: req.kind === 'requal' ? req.reason : null,
      seed: c.ports.entropy.bytes(SET_SEED_BYTES).toString('hex'), requested_at: c.ports.clock.now(),
    };
    const path = join(c.paths.dir, REQUEST_FILE);
    if (!c.files.createExclusive(path, `${JSON.stringify(request, null, 2)}\n`)) return `${c.files.rel(path)} already exists`;
    c.log(`${set}: ${describe(request)} (seed in ${c.files.rel(path)})`);
    return null;
  });
  if (refused !== null) return usage(deps, refused);
  return report(deps, set, await runRange(c, deps, null, 'c1-build'));
}

/** `calib run` (c2–c4, or one of them with --only) and `calib score` (c5) on a built set. */
async function runSet(set: SetId | null, from: CalibStepId, until: CalibStepId | null, quotaBudgetMs: number | null, deps: EngineDeps, at: ForgeRoots): Promise<number> {
  const id = set === null ? defaultSet(at.root) : ok(set);
  if (!id.ok) return usage(deps, id.error);
  if (!stepFinal(at.root, id.value, 'c1-build')) return usage(deps, `${id.value} is not built; run forge calib build first`);
  const ctx = context(at, deps, id.value, quotaBudgetMs);
  if (!ctx.ok) return usage(deps, ctx.error);
  const c = ctx.value;
  const refused = await locked(c, deps, () => ensureCalibBranch(c, id.value, false));
  if (refused !== null) return usage(deps, refused);
  return report(deps, id.value, await runRange(c, deps, from, until));
}

/** `forge calib …` entry (cli.ts dispatches `calib` here like `round` → roundCommand). */
export async function calibCommand(argv: readonly string[], deps: EngineDeps, at: ForgeRoots): Promise<number> {
  const args = parseCalibArgs(argv);
  if (!args.ok) return usage(deps, args.error);
  const a = args.value;
  if (a.cmd === 'build') return build(a.req, a.quotaBudgetMs, deps, at);
  if (a.cmd === 'run') return runSet(a.set, a.only ?? 'c2-gate-dryrun', a.only ?? 'c4-judge', a.quotaBudgetMs, deps, at);
  return runSet(a.set, 'c5-score', null, null, deps, at);
}
