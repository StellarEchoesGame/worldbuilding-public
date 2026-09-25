import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { drainAfterRun, parseArgs, quotaBudget, report, roundContext, type ForgeRoots } from './cli-round.ts';
import type { EngineDeps, StepContext } from './context.ts';
import { parseMergeDecision } from './inputs.ts';
import { isDone } from './marker.ts';
import { mergeAttempt, mergeConstants, mergecheckWith, mergeRowIds, readMergePointer } from './merge.ts';
import { acquireEngineLock, EXIT, runSteps, type Pipeline, type RoundStepId } from './runner.ts';
import { drainMirrors, pendingMirrors } from './mirror.ts';
import { checkPostMerge, POST_MERGE_FILE, readPostMerge } from './postmerge.ts';
import type { GitPort } from './ports.ts';
import { err, ok, type Result } from './result.ts';
import { loadProtocolBundle } from './rules.ts';
import { ROUND_STEPS } from './steps/index.ts';
import { IntegrityError } from './task.ts';

/**
 * `forge merge RNN`, `forge freeze --post-merge [RNN] [--check]`, `forge mirror [--round RNN] [--dry-run]` and the
 * moved `forge mergecheck` (PR-D group D4). Exit codes are the runner table (0 done … 5 failed); every command that
 * runs steps drains mirrors afterwards without changing its exit code.
 */

export const MERGE_FROM: RoundStepId = '10a-regate';
export const MERGE_UNTIL: RoundStepId = '10f-commit';

const ROUND_ID = /^R\d{2}$/u;
const MERGE_USAGE = 'usage: forge merge <RNN> [--quota-budget-min <n>]';
const POST_MERGE_USAGE = 'usage: forge freeze --post-merge [RNN] [--check]';
const MIRROR_USAGE = 'usage: forge mirror [--round <RNN>] [--dry-run]';
const MERGECHECK_USAGE = 'usage: forge mergecheck --decision <merge-decision.json> [--base <git-ref>]';

function usage(deps: Pick<EngineDeps, 'log'>, message: string): number {
  deps.log(`forge: ${message}`);
  return EXIT.usage;
}

/** runSteps from MERGE_FROM until MERGE_UNTIL; refused (usage) before 09b-decision is marked; then drainMirrors. */
export async function mergeCommand(argv: readonly string[], deps: EngineDeps, at: ForgeRoots): Promise<number> {
  const args = parseArgs(argv, ['--quota-budget-min'], []);
  if (!args.ok) return usage(deps, `${args.error}\n${MERGE_USAGE}`);
  const id = args.value.positional[0];
  if (id === undefined || args.value.positional.length > 1) return usage(deps, MERGE_USAGE);
  if (!ROUND_ID.test(id)) return usage(deps, `${id}: round ids look like R01`);
  const quota = quotaBudget(args.value);
  if (!quota.ok) return usage(deps, quota.error);
  const ctx = roundContext(at, deps, id, 'round', { cell: null, seed: null }, quota.value);
  if (!ctx.ok) return usage(deps, ctx.error);
  if (!isDone(ctx.value, '09b-decision')) {
    return usage(deps, `${id}: 09b-decision is not marked (no owner decision pinned yet, or a gate sent the round back to 09b); run forge round run ${id} after the owner decides`);
  }
  const r = await runSteps(ctx.value, {
    pipeline: 'round', steps: ROUND_STEPS, until: MERGE_UNTIL, from: MERGE_FROM, redoFrom: null, pid: deps.pid, isAlive: (pid) => deps.isAlive(pid),
  });
  const code = report(deps, id, r);
  await drainAfterRun(ctx.value, deps);
  return code;
}

type Probe<T> = { ok: true; value: T } | { ok: false; code: number };

/** A round-state read outside the runner: a throw is logged as `forge: …`; IntegrityError → integrity (3), else usage (1). */
function probe<T>(deps: Pick<EngineDeps, 'log'>, read: () => T): Probe<T> {
  try {
    return { ok: true, value: read() };
  } catch (e) {
    deps.log(`forge: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, code: e instanceof IntegrityError ? EXIT.integrity : EXIT.usage };
  }
}

/** `forge/r01` → R01 (the round branch 00-start creates), else null. */
function roundOfBranch(branch: string): string | null {
  const m = /^forge\/r(\d{2})$/u.exec(branch);
  return m === null ? null : `R${m[1] ?? ''}`;
}

/** The attempt whose post-merge.json the command reads: merge.json's current, else the decision 09b pins. */
function attemptD8(ctx: StepContext): Result<string> {
  const pointer = readMergePointer(ctx.paths);
  if (pointer !== null) return pointer.ok ? ok(pointer.value.current) : pointer;
  if (!isDone(ctx, '09b-decision')) return err(`${ctx.roundId}: 09b-decision is not marked, so there is no merge attempt`);
  try {
    return ok(mergeAttempt(ctx).d8);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

/**
 * `forge freeze --post-merge [RNN]` runs step 10d (after 10c is marked; a marked 10d keeps its pinned file);
 * `--check` prints checkPostMerge drift lines of the tree against `merge/<d8>/post-merge.json`, exit 1 when any.
 * The round defaults to the checked-out `forge/rNN` branch.
 */
export async function postMergeCommand(argv: readonly string[], deps: EngineDeps, at: ForgeRoots): Promise<number> {
  const args = parseArgs(argv, [], ['--post-merge', '--check']);
  if (!args.ok) return usage(deps, `${args.error}\n${POST_MERGE_USAGE}`);
  const given = args.value.positional[0] ?? null;
  if (!args.value.switches.has('--post-merge') || args.value.positional.length > 1 || (given !== null && !ROUND_ID.test(given))) return usage(deps, POST_MERGE_USAGE);
  let id = given;
  if (id === null) {
    const branch = await deps.ports.git.currentBranch();
    if (!branch.ok) return usage(deps, `git: ${branch.error}`);
    id = roundOfBranch(branch.value);
    if (id === null) return usage(deps, `on branch ${branch.value}, not a round branch forge/rNN: name the round`);
  }
  const ctx = roundContext(at, deps, id, 'round', { cell: null, seed: null }, null);
  if (!ctx.ok) return usage(deps, ctx.error);
  const pick = isDone(ctx.value, '09b-decision') ? probe(deps, () => ctx.value.decision().pick) : null;
  if (pick !== null && !pick.ok) return pick.code;
  if (pick !== null && pick.value === 'none') {
    deps.log(`${id}: the owner picked none; nothing is merged, so there is no post-merge.json`);
    return EXIT.done;
  }
  const d8 = attemptD8(ctx.value);
  if (!d8.ok) return usage(deps, d8.error);
  const rel = `rounds/${id}/merge/${d8.value}/${POST_MERGE_FILE}`;
  if (!args.value.switches.has('--check')) {
    const r = await runSteps(ctx.value, {
      pipeline: 'round', steps: ROUND_STEPS, until: '10d-post-merge-freeze', from: '10d-post-merge-freeze', redoFrom: null, pid: deps.pid, isAlive: (pid) => deps.isAlive(pid),
    });
    const code = report(deps, id, r);
    if (code === EXIT.done && existsSync(join(at.root, rel))) deps.log(`${rel} pinned`);
    return code;
  }
  const pinned = readPostMerge(ctx.value.paths, d8.value);
  if (pinned === null) return usage(deps, `${rel} does not exist (10d has not run: forge freeze --post-merge ${id})`);
  if (!pinned.ok) {
    deps.log(`forge: ${rel}: ${pinned.error}`);
    return EXIT.integrity;
  }
  const drift = checkPostMerge(ctx.value, pinned.value);
  if (drift.length === 0) {
    deps.log(`${id}: world/current matches ${rel}`);
    return EXIT.done;
  }
  deps.log(`${id}: ${drift.length} post-merge drift line(s) against ${rel}:`);
  for (const line of drift) deps.log(`  ✖ ${line}`);
  return EXIT.usage;
}

/** Rounds that can hold queued mirrors: R00 (the bench round) by its directory, every other round once start.json exists. */
function mirrorRounds(root: string): string[] {
  const dir = join(root, 'rounds');
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir).filter((n) => ROUND_ID.test(n) && (n === 'R00' || existsSync(join(dir, n, 'start.json'))));
  return names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function mirrorPipeline(round: string): Pipeline {
  return round === 'R00' ? 'bench-r00' : 'round';
}

/**
 * Drains one round, or every round with a pending mirror; `--dry-run` lists pendingMirrors (kind, key, first body
 * line, failures, next try) without posting. A round whose mirror log or source does not read is reported and the
 * others still drain. Exit 0 unless usage (a mirror never changes a state or exit code).
 */
export async function mirrorCommand(argv: readonly string[], deps: EngineDeps, at: ForgeRoots): Promise<number> {
  const args = parseArgs(argv, ['--round'], ['--dry-run']);
  if (!args.ok) return usage(deps, `${args.error}\n${MIRROR_USAGE}`);
  if (args.value.positional.length > 0) return usage(deps, MIRROR_USAGE);
  const only = args.value.values.get('--round') ?? null;
  if (only !== null && !ROUND_ID.test(only)) return usage(deps, `--round ${only}: round ids look like R01`);
  if (only !== null && !mirrorRounds(at.root).includes(only)) return usage(deps, `--round ${only}: ${only === 'R00' ? 'rounds/R00 does not exist' : `rounds/${only}/start.json does not exist`}`);
  const now = deps.ports.clock.now();
  const due: string[] = [];
  for (const round of only === null ? mirrorRounds(at.root) : [only]) {
    const pending = pendingMirrors(at.root, round, now);
    if (!pending.ok) {
      deps.log(`mirror ${round}: ${pending.error}`);
      continue;
    }
    if (pending.value.length > 0) due.push(round);
    if (!args.value.switches.has('--dry-run')) continue;
    for (const p of pending.value) {
      const next = p.nextAttemptAt === null ? 'never (rejected by the public-content scan)' : p.nextAttemptAt;
      deps.log(`${round} ${p.kind} ${p.key}: ${p.body.split('\n', 1)[0] ?? ''} (failures ${p.failures}, next try ${next})`);
    }
  }
  if (args.value.switches.has('--dry-run')) {
    deps.log(`${due.length === 0 ? 'no pending mirror' : `pending mirrors in ${due.join(', ')}`} (dry run: nothing posted)`);
    return EXIT.done;
  }
  if (due.length === 0) {
    deps.log('no pending mirror');
    return EXIT.done;
  }
  const lock = acquireEngineLock(at.root, deps.pid, (pid) => deps.isAlive(pid), now);
  if (!lock.ok) return usage(deps, lock.error);
  try {
    for (const round of due) {
      const ctx = roundContext(at, deps, round, mirrorPipeline(round), { cell: null, seed: null }, null);
      if (!ctx.ok) {
        deps.log(`mirror ${round}: ${ctx.error}`);
        continue;
      }
      const r = await drainMirrors(ctx.value);
      deps.log(`${round}: ${r.posted} posted, ${r.failed} failed, ${r.rejected} rejected by the public-content scan`);
    }
  } finally {
    lock.value.release();
  }
  return EXIT.done;
}

/** Where `forge mergecheck` prints: the verdict on `out` (stdout), `forge: …` usage / read / ref errors on `err` (stderr). */
export interface MergecheckSinks {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** `forge mergecheck --decision <merge-decision.json> [--base <git-ref>]` on merge.ts mergecheckWith; exit 0 pass, 1 otherwise. */
export async function mergecheckCommand(argv: readonly string[], at: ForgeRoots, git: GitPort, sinks: MergecheckSinks): Promise<number> {
  const toErr = { log: sinks.err };
  const args = parseArgs(argv, ['--decision', '--base'], []);
  if (!args.ok) return usage(toErr, `${args.error}\n${MERGECHECK_USAGE}`);
  const decisionArg = args.value.values.get('--decision');
  if (decisionArg === undefined || args.value.positional.length > 0) return usage(toErr, MERGECHECK_USAGE);
  const path = resolve(process.cwd(), decisionArg);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return usage(toErr, `cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const decision = parseMergeDecision(raw);
  if (!decision.ok) return usage(toErr, decision.error);
  const bundle = loadProtocolBundle(at.root);
  if (!bundle.ok) return usage(toErr, bundle.error);
  const rowIds = mergeRowIds(at.root);
  if (!rowIds.ok) return usage(toErr, rowIds.error);
  const base = args.value.values.get('--base') ?? 'main';
  const result = await mergecheckWith({ root: at.root, repo: at.repo, git, constants: mergeConstants(bundle.value.protocol), rowIds: rowIds.value }, decision.value, base);
  if (!result.ok) return usage(toErr, result.error);
  if (result.value.ok) sinks.out(`mergecheck 通过（对照 ${base}）`);
  else sinks.out(`mergecheck 未通过（对照 ${base}）：\n${result.value.violations.map((v) => `- ${v}`).join('\n')}`);
  return result.value.ok ? EXIT.done : EXIT.usage;
}
