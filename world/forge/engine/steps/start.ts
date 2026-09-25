import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCell } from '../brief.ts';
import { parseStartRecord, type StartRecord, type StepContext } from '../context.ts';
import { isRecord, readRecord } from '../json.ts';
import { protocolGate } from '../owner-inputs.ts';
import type { GitPort } from '../ports.ts';
import { err, ok, type Result } from '../result.ts';
import type { StepDef, StepOutcome } from '../runner.ts';
import { sha256 } from '../store.ts';

/** Labels of the round sub-issue (none: `gh api` would fail on a label the repository lacks). */
export const ROUND_ISSUE_LABELS: readonly string[] = [];
/** `--seed <hex>`: 8–64 lowercase hex digits. */
export const SEED_PATTERN = /^[0-9a-f]{8,64}$/u;
/** Entropy bytes of a drawn seed (16 hex digits). */
export const SEED_BYTES = 8;

const ROUND_ID = /^[A-Z]\d{2}$/u;
const CALIB_SET = /^[QG]\d{2}$/u;

/** `forge/rNN` (R01 → forge/r01). */
export function roundBranch(roundId: string): string {
  return `forge/${roundId.toLowerCase()}`;
}

/** The sub-issue marker: its body carries `<!-- forge:round RNN -->` (GitHubPort.findIssue). */
export function roundIssueMarker(roundId: string): string {
  return `round ${roundId}`;
}

/** English body (public repository): marker line, branch, what gets mirrored. */
export function roundIssueBody(roundId: string, epicIssue: number): string {
  return [
    `<!-- forge:${roundIssueMarker(roundId)} -->`,
    `WB-F1 forge round ${roundId} (epic #${String(epicIssue)}), opened by the round engine.`,
    '',
    `- Engine branch: \`${roundBranch(roundId)}\``,
    '- The engine posts the blocking probe, the decision card and the decision here as comments.',
  ].join('\n');
}

/** Requal / gate calibration sets (`calibration/pairs.json` keys Qnn / Gnn), whose branches are `forge/calib-<set>`. */
export function calibrationSets(root: string): Result<string[]> {
  const path = join(root, 'calibration', 'pairs.json');
  if (!existsSync(path)) return ok([]);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return err('calibration/pairs.json: not valid JSON');
  }
  const sets = readRecord(raw, 'sets');
  return ok(sets === null ? [] : Object.keys(sets).filter((s) => CALIB_SET.test(s)).sort());
}

/** An engine branch that must be merged before a round starts, and the file whose presence on the base branch proves it. */
export interface EngineBranch {
  branch: string;
  /** Absolute path (GitPort converts it to repository-relative) of a file the branch's PR always brings. */
  evidence: string;
}

/**
 * `forge/r00` … the previous round (evidence `rounds/RNN/start.json`, committed at 03c) and `forge/calib-<set>`
 * for the given sets (evidence `calibration/<set>/markers/c1-build.json`).
 */
export function earlierEngineBranches(root: string, roundId: string, calibSets: readonly string[]): Result<EngineBranch[]> {
  if (!ROUND_ID.test(roundId)) return err(`round id must look like R01, got ${roundId}`);
  const n = Number(roundId.slice(1));
  const out: EngineBranch[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = `R${String(i).padStart(2, '0')}`;
    out.push({ branch: roundBranch(id), evidence: join(root, 'rounds', id, 'start.json') });
  }
  for (const set of calibSets) out.push({ branch: `forge/calib-${set.toLowerCase()}`, evidence: join(root, 'calibration', set, 'markers', 'c1-build.json') });
  return ok(out);
}

const CALIB_BRANCH_PREFIX = 'forge/calib-';

/**
 * Engine branches that must be merged into `base` before `roundId` starts (earlierEngineBranches). The calibration
 * sets are `calibSets` (the working tree's pairs.json) plus every local `forge/calib-<set>` branch: an unmerged
 * set's pairs.json entry lives only on its own branch. A branch counts as merged when it is an ancestor of `base`
 * or when `base` holds its evidence file: PRs are squash-merged, which never makes the branch an ancestor. Returns
 * the existing branches that are not merged. `base` is the local branch, so pull it after merging a round's PR.
 */
export async function openRoundBranches(git: GitPort, root: string, roundId: string, base: string, calibSets: readonly string[]): Promise<Result<string[]>> {
  const listed = await git.listBranches(CALIB_BRANCH_PREFIX);
  if (!listed.ok) return err(listed.error);
  const branchSets = listed.value.map((b) => b.slice(CALIB_BRANCH_PREFIX.length).toUpperCase()).filter((s) => CALIB_SET.test(s));
  const sets = [...new Set([...calibSets, ...branchSets])].sort();
  const candidates = earlierEngineBranches(root, roundId, sets);
  if (!candidates.ok) return candidates;
  const open: string[] = [];
  for (const { branch, evidence } of candidates.value) {
    const exists = await git.branchExists(branch);
    if (!exists.ok) return err(exists.error);
    if (!exists.value) continue;
    const merged = await git.isAncestor(branch, base);
    if (!merged.ok) return err(merged.error);
    if (merged.value) continue;
    const squashed = await git.show(base, evidence);
    if (!squashed.ok) return err(squashed.error);
    if (squashed.value === null) open.push(branch);
  }
  return ok(open);
}

function blocked(detail: string): StepOutcome {
  return { kind: 'blocked', detail };
}

function failed(detail: string): StepOutcome {
  return { kind: 'failed', detail };
}

/** start.json of an unmarked earlier attempt of this round (a crash after writing it), else null. */
function previousStart(ctx: StepContext): StartRecord | null {
  if (!existsSync(ctx.paths.start)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(ctx.paths.start, 'utf8'));
    const parsed = parseStartRecord(raw);
    return parsed.ok && parsed.value.round === ctx.roundId ? parsed.value : null;
  } catch {
    return null;
  }
}

function checkCell(root: string, rel: string): Result<string> {
  const path = join(root, rel);
  if (!existsSync(path)) return err(`cell file ${rel} not found in the forge root`);
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(raw)) return err(`${rel}: expected a cell object`);
    const cell = parseCell(raw);
    return cell.ok ? ok(rel) : err(`${rel}: ${cell.error}`);
  } catch {
    return err(`${rel}: not valid JSON`);
  }
}

/** Seed: the earlier attempt's, else `--seed`, else SEED_BYTES of Entropy as hex. */
function roundSeed(ctx: StepContext, previous: StartRecord | null): Result<string> {
  if (previous !== null) return ok(previous.seed);
  const given = ctx.startOptions.seed;
  if (given !== null) return SEED_PATTERN.test(given) ? ok(given) : err(`--seed must be 8-64 lowercase hex digits`);
  return ok(ctx.ports.entropy.bytes(SEED_BYTES).toString('hex'));
}

/** The fixed cell (`round start --cell`), forge-root-relative; an earlier attempt's choice wins. */
function roundCell(ctx: StepContext, previous: StartRecord | null): Result<string | null> {
  const cell = previous !== null ? previous.cell : ctx.startOptions.cell;
  if (cell === null) return ok(null);
  const rel = cell.replace(/^\.\//u, '');
  if (rel.startsWith('/') || rel.split('/').includes('..')) return err(`--cell must be a forge-root-relative path, got ${cell}`);
  return checkCell(ctx.root, rel);
}

/**
 * 00-start: protocol gate, doctor, one-open-round check, branch `forge/rNN` from main, round sub-issue
 * (idempotent by its `<!-- forge:round RNN -->` marker), seed → start.json.
 */
export const startStep: StepDef = {
  id: '00-start',
  run: async (ctx) => {
    const gate = protocolGate(ctx);
    if (gate !== null) return gate;
    const previous = previousStart(ctx);
    const seed = roundSeed(ctx, previous);
    if (!seed.ok) return failed(seed.error);
    const cell = roundCell(ctx, previous);
    if (!cell.ok) return failed(cell.error);
    const doctor = await ctx.ports.doctor.run();
    if (!doctor.ok) return failed(`doctor: ${doctor.error}`);
    const { git, github } = ctx.ports;
    const base = ctx.github.baseBranch;
    const sets = calibrationSets(ctx.root);
    if (!sets.ok) return failed(sets.error);
    const open = await openRoundBranches(git, ctx.root, ctx.roundId, base, sets.value);
    if (!open.ok) return blocked(`git: ${open.error}`);
    // cli-round.ts refuses this with exit 1 before the step runs (plan §3.4); blocked (4) only if a branch appeared in between.
    if (open.value.length > 0) return blocked(`another round is open: ${open.value.join(', ')} not merged into ${base}`);
    const branch = roundBranch(ctx.roundId);
    const exists = await git.branchExists(branch);
    if (!exists.ok) return blocked(`git: ${exists.error}`);
    let baseSha: string;
    if (exists.value) {
      const sha = previous?.base_sha ?? null;
      const resolved = sha === null ? await git.resolveRef(branch) : ok(sha);
      if (!resolved.ok) return blocked(`git: ${resolved.error}`);
      baseSha = resolved.value;
    } else {
      const resolved = await git.resolveRef(base);
      if (!resolved.ok) return blocked(`git: ${resolved.error}`);
      const created = await git.createBranch(branch, resolved.value);
      if (!created.ok) return blocked(`git: ${created.error}`);
      baseSha = resolved.value;
    }
    const current = await git.currentBranch();
    if (!current.ok) return blocked(`git: ${current.error}`);
    if (current.value !== branch) {
      const switched = await git.checkout(branch);
      if (!switched.ok) return blocked(`checkout ${branch}: ${switched.error}`);
    }
    const marker = roundIssueMarker(ctx.roundId);
    const found = await github.findIssue(marker);
    if (!found.ok) return blocked(`github: ${found.error}`);
    let issue = found.value;
    if (issue === null) {
      const created = await github.createIssue({ title: `WB-F1 round ${ctx.roundId}`, body: roundIssueBody(ctx.roundId, ctx.github.epicIssue), labels: [...ROUND_ISSUE_LABELS], parent: ctx.github.epicIssue });
      if (!created.ok) return blocked(`github: ${created.error}`);
      issue = created.value;
    }
    const record: StartRecord = {
      round: ctx.roundId,
      seed: seed.value,
      branch,
      base_sha: baseSha,
      issue: { number: issue.number, url: issue.url },
      bundle_sha256: ctx.bundleSha256,
      doctor_sha256: sha256(doctor.value),
      started_at: previous?.started_at ?? ctx.ports.clock.now(),
      cell: cell.value,
    };
    const out = ctx.files.writeJson(ctx.paths.start, record);
    // The bundle is pinned only by start.json.bundle_sha256: a bundle edit before 02c is the 02c protocol gate's
    // WAIT protocol_approval, not a marker mismatch (drift checks start after 02c).
    const inputs = ['github.json', ...(cell.value === null ? [] : [cell.value])];
    return { kind: 'done', inputs, outputs: [out], external: [] };
  },
};
