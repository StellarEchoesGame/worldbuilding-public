import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { gatewayBackend } from './adapters/gateway.ts';
import { judgeBackend } from './adapters/judges.ts';
import { runProcess } from './adapters/process.ts';
import type { Backend } from './adapters/types.ts';
import { BUILD_CONFIG, parseBuildConfig } from './calib-build.ts';
import { familyOf, loadConfig, type Family, type ForgeConfig, type WriterSlot } from './config.ts';
import { buildContext, readGithubConfig, type EngineDeps, type RoundBackends, type StartOptions, type StepContext } from './context.ts';
import { parsePrices, withPrices, type Prices } from './cost.ts';
import { latestFrozenRound, parseFreeze } from './freeze.ts';
import { hashListed, isDone } from './marker.ts';
import { cliDoctor, ghPort, gitPort, pythonAssembler, systemClock, systemEntropy } from './ports-cli.ts';
import { err, ok, type Result } from './result.ts';
import { loadProtocolBundle } from './rules.ts';
import { drainMirrors, pendingMirrors } from './mirror.ts';
import { acquireEngineLock, EXIT, isStepId, readStatus, runSteps, stepsSha256, verifyChain, type Pipeline, type RunReport, type StepId } from './runner.ts';
import { ROUND_STEPS } from './steps/index.ts';
import { SEED_PATTERN, calibrationSets, openRoundBranches } from './steps/start.ts';
import { roundPaths } from './store.ts';

/** Where a command acts: the forge root (`world/forge`) and the repository holding `world/current/`. */
export interface ForgeRoots {
  root: string;
  repo: string;
}

const ROUND_ID = /^R\d{2}$/u;
const QUOTA_MAX_MIN = 7 * 24 * 60;

/** parseArgs result (also cli-calib.ts). */
export interface Args {
  positional: string[];
  values: Map<string, string>;
  switches: Set<string>;
}

/** `--name value` for names in `valued`, bare `--name` for names in `bare`; anything else is a usage error. */
export function parseArgs(argv: readonly string[], valued: readonly string[], bare: readonly string[]): Result<Args> {
  const out: Args = { positional: [], values: new Map(), switches: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) {
      out.positional.push(a);
      continue;
    }
    if (bare.includes(a)) {
      out.switches.add(a);
      continue;
    }
    if (!valued.includes(a)) return err(`unknown option ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) return err(`${a} needs a value`);
    if (out.values.has(a)) return err(`${a} given twice`);
    out.values.set(a, v);
    i += 1;
  }
  return ok(out);
}

function stepFlag(args: Args, name: string): Result<StepId | null> {
  const v = args.values.get(name);
  if (v === undefined) return ok(null);
  return isStepId(v) ? ok(v) : err(`${name} ${v}: not a step id`);
}

/** `--quota-budget-min <n>` → ms (1 min … 7 days), null when absent. */
export function quotaBudget(args: Args): Result<number | null> {
  const v = args.values.get('--quota-budget-min');
  if (v === undefined) return ok(null);
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > QUOTA_MAX_MIN) return err(`--quota-budget-min must be an integer from 1 to ${QUOTA_MAX_MIN}`);
  return ok(n * 60_000);
}

function roundId(args: Args, usage: string): Result<string> {
  const id = args.positional[0];
  if (id === undefined || args.positional.length > 1) return err(usage);
  if (!ROUND_ID.test(id)) return err(`${id}: round ids look like R01 (P rounds run on the prototype runner)`);
  return ok(id);
}

function toSlash(path: string): string {
  return path.split(sep).join('/');
}

/** `--cell` → forge-root-relative path of an existing file inside the forge root. */
function cellOption(root: string, value: string | undefined): Result<string | null> {
  if (value === undefined) return ok(null);
  const abs = resolve(root, value);
  const rel = toSlash(relative(resolve(root), abs));
  if (rel === '' || rel.startsWith('..') || rel.startsWith('/')) return err(`--cell ${value}: must name a file inside the forge root`);
  if (!existsSync(abs)) return err(`--cell ${value}: no such file`);
  return ok(rel);
}

/** StepContext of round `id` (rounds/<id>/) from the forge root's configuration (local.json required). */
export function roundContext(at: ForgeRoots, deps: EngineDeps, id: string, pipeline: Pipeline, startOptions: StartOptions, quotaBudgetMs: number | null): Result<StepContext> {
  const config = loadConfig(at.root, { requireLocal: true });
  if (!config.ok) return config;
  return buildContext({ root: at.root, repo: at.repo, roundId: id, pipeline, paths: roundPaths(at.root, id), config: config.value, deps, startOptions, quotaBudgetMs });
}

/** Logs the run's end state (`R01: waiting at 09b-decision (waiting for decision): …`); returns its exit code. */
export function report(deps: EngineDeps, id: string, r: RunReport): number {
  const where = r.step === null ? '' : ` at ${r.step}`;
  const waiting = r.waitingFor === null ? '' : ` (waiting for ${r.waitingFor})`;
  deps.log(`${id}: ${r.state}${where}${waiting}${r.detail === '' ? '' : `: ${r.detail}`}`);
  return r.exitCode;
}

/**
 * Round 0's pending bench notices (cycles R00-init and R00, on the epic issue): no round run is R00's own, so every run
 * drains them too (plan §8 E1). Only while rounds/R00 exists, as `forge mirror`; problems are logged.
 */
async function drainRound0(ctx: StepContext, deps: EngineDeps): Promise<void> {
  if (ctx.roundId === 'R00' || !existsSync(roundPaths(ctx.root, 'R00').dir)) return;
  const pending = pendingMirrors(ctx.root, 'R00', ctx.ports.clock.now());
  if (!pending.ok) {
    deps.log(`mirror R00: ${pending.error}`);
    return;
  }
  if (pending.value.length === 0) return;
  const r00 = roundContext({ root: ctx.root, repo: ctx.repo }, deps, 'R00', 'bench-r00', { cell: null, seed: null }, null);
  if (!r00.ok) {
    deps.log(`mirror R00: ${r00.error}`);
    return;
  }
  await drainMirrors(r00.value);
}

/**
 * drainMirrors for ctx's round, then round 0's bench notices, after a command ran its steps (plan §8: `forge round run`,
 * `forge merge`). The runner released the engine lock at its end, so the drain takes it again; a held lock or any drain
 * problem is only logged: a mirror never changes a round state or an exit code.
 */
export async function drainAfterRun(ctx: StepContext, deps: EngineDeps): Promise<void> {
  const lock = acquireEngineLock(ctx.root, deps.pid, (pid) => deps.isAlive(pid), ctx.ports.clock.now());
  if (!lock.ok) {
    deps.log(`mirror ${ctx.roundId}: not drained (${lock.error})`);
    return;
  }
  try {
    await drainMirrors(ctx);
    await drainRound0(ctx, deps);
  } finally {
    lock.value.release();
  }
}

/** One round at a time (steps/start.ts openRoundBranches, squash merges included); the reason to refuse, else null. */
export async function openRoundProblem(ctx: StepContext): Promise<string | null> {
  const base = ctx.github.baseBranch;
  const sets = calibrationSets(ctx.root);
  if (!sets.ok) return sets.error;
  const open = await openRoundBranches(ctx.ports.git, ctx.root, ctx.roundId, base, sets.value);
  if (!open.ok) return `git: ${open.error}`;
  if (open.value.length === 0) return null;
  return `${open.value.join(', ')} not merged into ${base} yet; one round is open at a time (merge its PR and pull ${base} first)`;
}

const START_USAGE = 'usage: forge round start <RNN> [--cell <cells/file.json>] [--seed <hex>] [--quota-budget-min <n>]';
const RUN_USAGE = 'usage: forge round run <RNN> [--until <step>] [--from <step>] [--redo-from <step>] [--quota-budget-min <n>]';
const STATUS_USAGE = 'usage: forge round status <RNN> [--json] [--verify]';

function usage(deps: EngineDeps, message: string): number {
  deps.log(`forge: ${message}`);
  return EXIT.usage;
}

/** `round start`: refuses R00 and a started round; checks the one-open-round rule; runs 00-start and 01-topic. */
async function start(argv: readonly string[], deps: EngineDeps, at: ForgeRoots): Promise<number> {
  const args = parseArgs(argv, ['--cell', '--seed', '--quota-budget-min'], []);
  if (!args.ok) return usage(deps, `${args.error}\n${START_USAGE}`);
  const id = roundId(args.value, START_USAGE);
  if (!id.ok) return usage(deps, id.error);
  const n = Number(id.value.slice(1));
  if (n === 0) return usage(deps, 'R00 is round 0 (calibration and the benchmark cycle): use forge calib / forge bench');
  const cell = cellOption(at.root, args.value.values.get('--cell'));
  if (!cell.ok) return usage(deps, cell.error);
  const seed = args.value.values.get('--seed') ?? null;
  if (seed !== null && !SEED_PATTERN.test(seed)) return usage(deps, '--seed must be 8-64 lowercase hex digits');
  const quota = quotaBudget(args.value);
  if (!quota.ok) return usage(deps, quota.error);
  const ctx = roundContext(at, deps, id.value, 'round', { cell: cell.value, seed }, quota.value);
  if (!ctx.ok) return usage(deps, ctx.error);
  if (isDone(ctx.value, '00-start')) return usage(deps, `${id.value} is already started; continue it with forge round run ${id.value}`);
  const open = await openRoundProblem(ctx.value);
  if (open !== null) return usage(deps, open);
  const r = await runSteps(ctx.value, { pipeline: 'round', steps: ROUND_STEPS, until: '01-topic', from: null, redoFrom: null, pid: deps.pid, isAlive: (pid) => deps.isAlive(pid) });
  return report(deps, id.value, r);
}

/** `round run`: resumes at the first unmarked step (refused before `round start` marked 00-start); then drains mirrors. */
async function run(argv: readonly string[], deps: EngineDeps, at: ForgeRoots): Promise<number> {
  const args = parseArgs(argv, ['--until', '--from', '--redo-from', '--quota-budget-min'], []);
  if (!args.ok) return usage(deps, `${args.error}\n${RUN_USAGE}`);
  const id = roundId(args.value, RUN_USAGE);
  if (!id.ok) return usage(deps, id.error);
  const until = stepFlag(args.value, '--until');
  const from = stepFlag(args.value, '--from');
  const redoFrom = stepFlag(args.value, '--redo-from');
  const quota = quotaBudget(args.value);
  if (!until.ok) return usage(deps, until.error);
  if (!from.ok) return usage(deps, from.error);
  if (!redoFrom.ok) return usage(deps, redoFrom.error);
  if (!quota.ok) return usage(deps, quota.error);
  if (from.value !== null && redoFrom.value !== null) return usage(deps, '--from and --redo-from exclude each other');
  const ctx = roundContext(at, deps, id.value, 'round', { cell: null, seed: null }, quota.value);
  if (!ctx.ok) return usage(deps, ctx.error);
  if (!isDone(ctx.value, '00-start')) return usage(deps, `${id.value} is not started; run forge round start ${id.value} first`);
  const r = await runSteps(ctx.value, {
    pipeline: 'round', steps: ROUND_STEPS, until: until.value, from: from.value, redoFrom: redoFrom.value, pid: deps.pid, isAlive: (pid) => deps.isAlive(pid),
  });
  const code = report(deps, id.value, r);
  await drainAfterRun(ctx.value, deps);
  return code;
}

const ROUND_STEP_IDS: readonly StepId[] = ROUND_STEPS.map((s) => s.id);

/** `round status`: status.json (engine-written), optionally the marker chain; exits with the recorded exit code. */
function status(argv: readonly string[], deps: EngineDeps, at: ForgeRoots): number {
  const args = parseArgs(argv, [], ['--json', '--verify']);
  if (!args.ok) return usage(deps, `${args.error}\n${STATUS_USAGE}`);
  const id = roundId(args.value, STATUS_USAGE);
  if (!id.ok) return usage(deps, id.error);
  const st = readStatus(at.root, id.value);
  if (!st.ok) return usage(deps, `${st.error} (not started? forge round start ${id.value})`);
  const s = st.value;
  if (args.value.switches.has('--json')) deps.log(JSON.stringify(s));
  else {
    deps.log(`${s.round}: ${s.state}${s.step === null ? '' : ` at ${s.step}`}${s.waiting_for === null ? '' : ` — waiting for ${s.waiting_for}`}`);
    if (s.detail !== '') deps.log(`  ${s.detail}`);
    deps.log(`  since ${s.since}; ${s.done.length}/${ROUND_STEP_IDS.length} steps done${s.exit_code === null ? '' : `; exit ${s.exit_code}`}`);
  }
  if (args.value.switches.has('--verify')) {
    const problems = verifyChain(at.root, `rounds/${id.value}`, ROUND_STEP_IDS);
    for (const p of problems) deps.log(`  ✖ ${p}`);
    if (problems.length > 0) return EXIT.integrity;
    deps.log('  ✔ marker chain verified');
  }
  return s.exit_code ?? EXIT.done;
}

/**
 * `forge round start|run|status …` for R rounds (the CLI sends P rounds to the prototype runner before calling
 * this). Returns the exit code of the runner table (0 done, 1 usage, 2 waiting, 3 integrity, 4 blocked, 5 failed).
 */
export async function roundCommand(argv: readonly string[], deps: EngineDeps, at: ForgeRoots): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === 'start') return start(rest, deps, at);
  if (sub === 'run') return run(rest, deps, at);
  if (sub === 'status') return status(rest, deps, at);
  return usage(deps, [START_USAGE, RUN_USAGE, STATUS_USAGE].join('\n'));
}

function hashProblem(root: string, rel: string, want: string, what: string): string | null {
  const h = hashListed(root, rel);
  if (h === null) return `${rel}: ${what} is missing`;
  if (!h.ok) return `${rel}: ${h.error}`;
  return h.value === want ? null : `${rel}: ${what} changed since 02c-freeze`;
}

/**
 * Drift of a round's freeze pins against the current tree, the same checks the runner makes on resume: the step
 * list, the protocol bundle, the pinned benchmark file and skill snapshots, and every file the marker chain lists
 * (the 02c marker inputs: judges.json, writers.json, fact table, regression quotes, …). [] = clean.
 */
export function freezeDrift(root: string, id: string): Result<string[]> {
  const path = join(root, 'rounds', id, 'freeze.json');
  if (!existsSync(path)) return err(`rounds/${id}/freeze.json does not exist (02c-freeze has not run)`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return ok([`rounds/${id}/freeze.json: not JSON`]);
  }
  const freeze = parseFreeze(raw);
  if (!freeze.ok) return ok([`rounds/${id}/freeze.json: ${freeze.error}`]);
  const f = freeze.value;
  const problems: string[] = [];
  if (f.steps_sha256 !== null && f.steps_sha256 !== stepsSha256(ROUND_STEP_IDS)) problems.push('steps_sha256: freeze.json pins a different step list than this build runs');
  const bundle = loadProtocolBundle(root);
  if (!bundle.ok) problems.push(`protocol bundle: ${bundle.error}`);
  else if (bundle.value.bundleSha256 !== f.protocol_bundle_sha256) problems.push('protocol bundle changed since 02c-freeze');
  const bench = f.benchmark_resolution;
  const pinned = bench === null ? [] : [hashProblem(root, bench.path, bench.sha256, 'pinned benchmark')];
  const skills = Object.entries(f.skills).map(([name, hash]) => hashProblem(root, `skills/${name}.md`, hash, 'pinned skill snapshot'));
  for (const p of [...pinned, ...skills]) if (p !== null) problems.push(p);
  problems.push(...verifyChain(root, `rounds/${id}`, ROUND_STEP_IDS));
  return ok([...new Set(problems)]);
}

const FREEZE_USAGE = 'usage: forge freeze --check [RNN]';

/** `forge freeze --check [RNN]` (default: the newest frozen R round): exit 0 clean, 3 drift, 1 usage (cli.ts sends `--post-merge` to cli-merge.ts). */
export async function freezeCommand(argv: readonly string[], deps: EngineDeps, at: ForgeRoots): Promise<number> {
  const args = parseArgs(argv, [], ['--check']);
  if (!args.ok) return usage(deps, `${args.error}\n${FREEZE_USAGE}`);
  if (!args.value.switches.has('--check')) return usage(deps, FREEZE_USAGE);
  const given = args.value.positional[0] ?? null;
  if (args.value.positional.length > 1 || (given !== null && !ROUND_ID.test(given))) return usage(deps, FREEZE_USAGE);
  const id = given ?? latestFrozenRound(at.root);
  if (id === null) return usage(deps, 'no R round has a freeze.json yet');
  const drift = freezeDrift(at.root, id);
  if (!drift.ok) return usage(deps, drift.error);
  if (drift.value.length === 0) {
    deps.log(`${id}: freeze.json matches the current inputs`);
    return EXIT.done;
  }
  deps.log(`${id}: ${drift.value.length} drift problem(s):`);
  for (const p of drift.value) deps.log(`  ✖ ${p}`);
  return EXIT.integrity;
}

/** A task-id-safe backend id for a gateway model (`deepseek/deepseek-v4.1-flash` → `gateway-deepseek_deepseek-v4.1-flash`). */
export function gatewayId(model: string): string {
  return `gateway-${model.replace(/[^A-Za-z0-9._-]/gu, '_')}`;
}

/**
 * Distinct gateway models of `calibration/build.json` (primary, contrasts, degrade), validated by parseBuildConfig
 * (every model has a family and none is a judge or maintainer family). A missing or invalid build.json → [] (c1-build
 * then fails with the config error before any call).
 */
export function calibModels(config: ForgeConfig): string[] {
  const path = join(config.root, BUILD_CONFIG);
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
  const judgeFamilies = new Set<Family>([...config.judges.map((j) => j.family), config.maintainer.family]);
  const cfg = parseBuildConfig(raw, config.prefixes, judgeFamilies);
  if (!cfg.ok) return [];
  return [...new Set([cfg.value.primaryModel, ...cfg.value.contrastModels, cfg.value.degradeModel])];
}

/**
 * Round backends from judges.json / writers.json / local.json. Decoy and defect writers use the baseline slot's
 * gateway model until PR-B adds their own config. `calibGateway` has one gateway backend per `calibModels` entry
 * (id gatewayId(model), the baseline slot's token and temperature settings), keyed by the build.json model id.
 */
export function productionBackends(config: ForgeConfig, prices: Prices, calib: readonly string[] = []): RoundBackends {
  const local = config.local;
  if (local === null) throw new Error('local.json is required');
  const gateway = (slot: WriterSlot): Backend => {
    const family = familyOf(slot.model, config.prefixes);
    if (family === null) throw new Error(`no family for gateway model ${slot.model}; add a prefix to families.json`);
    return withPrices(gatewayBackend(slot, family, local), prices);
  };
  const judges = config.judges.map((j) => ({ backend: withPrices(judgeBackend(j, local), prices), concurrency: j.concurrency }));
  const models = new Map<string, WriterSlot>();
  for (const s of [...config.slots, config.baseline]) if (!models.has(s.model)) models.set(s.model, { ...s, id: gatewayId(s.model) });
  return {
    writers: config.slots.map((slot) => ({ slot: slot.id, backend: gateway(slot) })),
    baseline: gateway(config.baseline),
    decoy: gateway({ ...config.baseline, id: 'decoy' }),
    defect: gateway({ ...config.baseline, id: 'defect' }),
    judges,
    forecasters: [...judges.map((j) => j.backend), ...[...models.values()].map(gateway)],
    maintainer: withPrices(judgeBackend(config.maintainer, local), prices),
    mergeEditor: withPrices(judgeBackend(config.mergeEditor, local), prices),
    calibGateway: new Map(calib.map((model) => [model, gateway({ ...config.baseline, id: gatewayId(model), model })])),
  };
}

/** kill(pid, 0): alive unless the process does not exist (EPERM = alive, owned by someone else). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e instanceof Error && 'code' in e && e.code === 'EPERM';
  }
}

/** Production EngineDeps: ports-cli ports, adapters from judges.json / writers.json / local.json, process pid. */
export function productionDeps(root: string, repo: string): Result<EngineDeps> {
  const config = loadConfig(root, { requireLocal: true });
  if (!config.ok) return config;
  const github = readGithubConfig(root);
  if (!github.ok) return github;
  let rawPrices: unknown;
  try {
    rawPrices = JSON.parse(readFileSync(join(root, 'prices.json'), 'utf8'));
  } catch (e) {
    return err(`prices.json: ${e instanceof Error ? e.message : String(e)}`);
  }
  const prices = parsePrices(rawPrices);
  if (!prices.ok) return prices;
  const log = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  return ok({
    ports: {
      github: ghPort(github.value.repo, runProcess, log),
      git: gitPort(repo, runProcess),
      clock: systemClock(),
      entropy: systemEntropy(),
      doctor: cliDoctor(root),
      assembler: pythonAssembler(repo, runProcess),
    },
    backends: (pipeline) => productionBackends(config.value, prices.value, pipeline === 'calibration' ? calibModels(config.value) : []),
    env: process.env,
    pid: process.pid,
    isAlive: processAlive,
    log,
  });
}
