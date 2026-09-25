import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Backend } from '../adapters/types.ts';
import { anonymizeText } from '../anonymize.ts';
import type { Attempted } from '../calls.ts';
import { readChampions, type Champion } from '../champions.ts';
import { isFamily, type Family } from '../config.ts';
import type { StepContext } from '../context.ts';
import { isRecord, readArray, readNumber, readString } from '../json.ts';
import {
  ANCHOR_IDS, CHAMPION_SNAPSHOT, championSchedule, DECOY_ID, effectiveFamilies, familySessionsOf, pairDir, pairsFilePath,
  readChampionSnapshot, rerunPlan, sessionCallOf, sessionVoid, tasteCallPath,
  type FamilySessions, type PairEntry, type PairKind, type PairsFile, type SessionCallPlan, type SessionPlan, type TasteCallFile, type TextRef,
} from '../pairs.ts';
import { err, ok, type Result } from '../result.ts';
import { runAll, type StepDef, type StepOutcome } from '../runner.ts';
import { roundPaths, sha256 } from '../store.ts';
import { CHAMPION_ID, displayText, loadSubmission } from '../submission.ts';
import { IntegrityError, runTask } from '../task.ts';
import { eligibleFamilies, familyStates, pickFamilies, type FamilyState, type JudgedText } from '../tasks/assign.ts';
import { applyDecoy, decoyTask, type DecoyReplacement } from '../tasks/decoy.ts';
import { auxPairId, decoyTaskId, tasteTaskId } from '../tasks/ids.ts';
import { tasteTask, type TasteInput, type TasteVerdict } from '../tasks/taste-pair.ts';
import type { Benchmark } from '../taste.ts';
import type { StepAttempt } from './baseline.ts';
import { readBriefJson } from './brief.ts';
import { judgeBackend, passingSubmissions } from './gate-llm.ts';

/** `rounds/RNN/decoy.json` (06a): the replacement map and what it was applied to. */
export interface DecoyFile {
  round: string;
  /** decoyTaskId(n). */
  task: string;
  replacements: DecoyReplacement[];
  champion_sha256: string;
  recipe_version: string;
  /** SHA-256 of the decoy display text (`submissions/DECOY.json`). */
  text_sha256: string;
}

/** `rounds/RNN/submissions/DECOY.json` (06a): the decoy display text (kind `decoy`, never read as a writer submission). */
export interface DecoySubmission {
  id: string;
  kind: 'decoy';
  task: string;
  model: string;
  served_model: string | null;
  /** The decoy writer's family (a decoy author besides the champion's authors). */
  family: Family;
  champion_sha256: string;
  recipe_version: string;
  text: string;
  text_sha256: string;
}

const STEP_DECOY = '06a-decoy';
const STEP_CHAMPION = '06b-champion-pairs';
const STEP_AUX = '06c-aux-pairs';
const HEX64 = /^[0-9a-f]{64}$/u;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function decoyPath(ctx: StepContext): string {
  return join(ctx.paths.submissions, `${DECOY_ID}.json`);
}

/** `submissions/DECOY.json`; err when missing or malformed, or when its text does not match its hash. */
export function readDecoySubmission(paths: StepContext['paths']): Result<DecoySubmission> {
  const path = join(paths.submissions, `${DECOY_ID}.json`);
  const rel = `rounds/${paths.id}/submissions/${DECOY_ID}.json`;
  if (!existsSync(path)) return err(`${rel} is missing`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return err(`${rel} is not valid JSON`);
  }
  const id = readString(raw, 'id');
  const task = readString(raw, 'task');
  const model = readString(raw, 'model');
  const family = readString(raw, 'family');
  const champ = readString(raw, 'champion_sha256');
  const version = readString(raw, 'recipe_version');
  const text = readString(raw, 'text');
  const textSha = readString(raw, 'text_sha256');
  const served = isRecord(raw) ? raw['served_model'] : undefined;
  if (id !== DECOY_ID || readString(raw, 'kind') !== 'decoy' || task === null || model === null || version === null || text === null || (served !== null && typeof served !== 'string')) {
    return err(`${rel}: id, kind, task, model, served_model, recipe_version and text are required`);
  }
  if (family === null || !isFamily(family)) return err(`${rel}: family is not a known family`);
  if (champ === null || !HEX64.test(champ) || textSha === null || textSha !== sha256(text)) return err(`${rel}: champion_sha256 / text_sha256 do not match`);
  return ok({ id, kind: 'decoy', task, model, served_model: typeof served === 'string' ? served : null, family, champion_sha256: champ, recipe_version: version, text, text_sha256: textSha });
}

function attemptsPath(ctx: StepContext): string {
  return join(ctx.paths.dir, 'attempts', `${STEP_DECOY}.json`);
}

/** Recorded void 06a attempts, oldest first (missing file → []); a malformed file is an integrity error. */
export function readDecoyAttempts(ctx: StepContext): StepAttempt[] {
  const path = attemptsPath(ctx);
  const rel = `rounds/${ctx.roundId}/attempts/${STEP_DECOY}.json`;
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new IntegrityError(`${rel} is not JSON`);
  }
  const list = readArray(raw, 'attempts');
  if (list === null) throw new IntegrityError(`${rel}: attempts[] is required`);
  const out: StepAttempt[] = [];
  for (const a of list) {
    const n = readNumber(a, 'n');
    const task = readString(a, 'task');
    const at = readString(a, 'at');
    const error = isRecord(a) ? a['error'] : undefined;
    if (n !== out.length + 1 || task !== decoyTaskId(n) || at === null || readString(a, 'status') !== 'void' || (error !== null && typeof error !== 'string')) {
      throw new IntegrityError(`${rel}: attempt ${out.length + 1} is malformed`);
    }
    out.push({ n, task, status: 'void', error: typeof error === 'string' ? error : null, at });
  }
  return out;
}

/**
 * The round's champion, snapshotted once into `champion.json` so 06b–09a and the UI never read the mutable
 * `champions.json` (11c may change it): verified against freeze.sha256.champion; drift → IntegrityError.
 */
function snapshotChampion(ctx: StepContext, rowId: string): Champion {
  const pinned = ctx.freeze().sha256['champion'];
  if (pinned === undefined) throw new IntegrityError(`rounds/${ctx.roundId}/freeze.json pins no champion`);
  const path = join(ctx.paths.dir, CHAMPION_SNAPSHOT);
  if (existsSync(path)) {
    const snap = readChampionSnapshot(ctx.paths);
    if (!snap.ok) throw new IntegrityError(snap.error);
    if (snap.value.row_id !== rowId || snap.value.text_sha256 !== pinned) throw new IntegrityError(`rounds/${ctx.roundId}/${CHAMPION_SNAPSHOT} is not the champion 02c-freeze pinned`);
    return snap.value;
  }
  const champions = readChampions(ctx.root);
  if (!champions.ok) throw new IntegrityError(champions.error);
  const champion = Object.hasOwn(champions.value, rowId) ? champions.value[rowId] : undefined;
  if (champion === undefined) throw new IntegrityError(`champions.json has no champion for row ${rowId}`);
  if (champion.text_sha256 !== pinned) throw new IntegrityError(`champions.json row ${rowId} changed since 02c-freeze pinned it`);
  ctx.files.writeJson(path, champion);
  return champion;
}

/**
 * 06a-decoy: champion snapshot `champion.json` (verified against freeze.sha256.champion), one decoyTask on
 * ctx.backends.decoy with bench.decoyRecipe, engine-applied map → `decoy.json`, `submissions/DECOY.json`. Void (or
 * no recipe) → failed (5); a void attempt is recorded, so the rerun calls afresh as `decoy-DECOY-t<n>`.
 */
export const decoyStep: StepDef = {
  id: '06a-decoy',
  run: async (ctx) => {
    const brief = readBriefJson(ctx);
    const champion = snapshotChampion(ctx, brief.row_id);
    const bench = ctx.benchmark();
    const recipe = bench.decoyRecipe;
    if (recipe === null) return { kind: 'failed', detail: `decoy_missing: benchmark ${bench.version} has no decoy_recipe` };
    const attempts = readDecoyAttempts(ctx);
    const n = attempts.length + 1;
    const id = decoyTaskId(n);
    const backend = ctx.backends.decoy;
    const shown = anonymizeText(champion.text);
    const r = await runTask(ctx, backend, decoyTask(shown, recipe, id, ctx.seed()));
    const applied = r.value === null ? err<never>(r.error ?? 'void') : applyDecoy(shown, r.value, bench.version);
    if (!applied.ok) {
      const error = ctx.redact(applied.error);
      const attempt: StepAttempt = { n, task: id, status: 'void', error, at: ctx.ports.clock.now() };
      ctx.files.writeJson(attemptsPath(ctx), { step: STEP_DECOY, attempts: [...attempts, attempt] });
      return { kind: 'failed', detail: `decoy_missing: ${id} is void (${error}); a rerun calls afresh as ${decoyTaskId(n + 1)}` };
    }
    const decoy = applied.value;
    const textSha = sha256(decoy.text);
    const submission: DecoySubmission = {
      id: DECOY_ID, kind: 'decoy', task: id, model: backend.model, served_model: r.last?.servedModel ?? null, family: backend.family,
      champion_sha256: decoy.championSha256, recipe_version: decoy.recipeVersion, text: decoy.text, text_sha256: textSha,
    };
    const file: DecoyFile = {
      round: ctx.roundId, task: id, replacements: decoy.replacements, champion_sha256: decoy.championSha256, recipe_version: decoy.recipeVersion, text_sha256: textSha,
    };
    const outputs = [ctx.files.rel(join(ctx.paths.dir, CHAMPION_SNAPSHOT)), ctx.files.writeJson(join(ctx.paths.dir, 'decoy.json'), file), ctx.files.writeJson(decoyPath(ctx), submission)];
    ctx.progress(STEP_DECOY, 'info', `decoy written (${id}, ${decoy.replacements.length} replacements)`);
    return { kind: 'done', inputs: [ctx.files.rel(ctx.paths.brief), ctx.files.rel(ctx.paths.freeze)], outputs, external: [] };
  },
};

/** A judged text with the display text judges see. */
interface Judged {
  ref: TextRef;
  text: string;
}

/** One planned taste call: positions 1 / 2 and, on champion pairs, the champion vs decoy pair. */
interface CallJob {
  pair: string;
  kind: PairKind;
  family: Family;
  shadow: boolean;
  session: number;
  rerun: boolean;
  plan: SessionCallPlan;
  text1: Judged;
  text2: Judged;
  decoyPair: { champion: string; decoy: string } | null;
}

function requireOk<T>(r: Result<T>): T {
  if (!r.ok) throw new IntegrityError(r.error);
  return r.value;
}

/** The pinned family states of this round's judges (freeze.json). */
function judgeStates(ctx: StepContext): FamilyState[] {
  return familyStates(ctx.freeze(), ctx.backends.judges.map((j) => j.backend.family));
}

/** Taste-qualified `flagged` families minus the authors of `texts`: they judge champion pairs as shadow only. */
function shadowFamilies(states: readonly FamilyState[], texts: readonly JudgedText[]): Family[] {
  const authors = new Set<Family>(texts.flatMap((t) => t.authors));
  return states.filter((s) => s.tasteQualified && s.flag === 'flagged' && !authors.has(s.family)).map((s) => s.family).sort(byCodeUnit);
}

/** A passing submission as judges see it (display text); an unreadable file is an integrity error. */
function judgedSubmission(ctx: StepContext, id: string): Judged {
  const sub = loadSubmission(ctx.paths, id);
  const rel = `rounds/${ctx.roundId}/submissions/${id}.json`;
  if (sub === null || sub.output === null) throw new IntegrityError(`${rel} is not a readable submission`);
  if (!isFamily(sub.family)) throw new IntegrityError(`${rel}: family ${sub.family} is not a known family`);
  const text = displayText(sub.output);
  return { ref: { id, kind: 'submission', file: rel, sha256: sha256(text), authors: [sub.family] }, text };
}

function inputOf(job: CallJob): TasteInput {
  const at = job.plan.decoyAt;
  if (job.decoyPair === null || at === null) return { text1: job.text1.text, text2: job.text2.text, decoy: null };
  const [text3, text4] = at === 3 ? [job.decoyPair.decoy, job.decoyPair.champion] : [job.decoyPair.champion, job.decoyPair.decoy];
  return { text1: job.text1.text, text2: job.text2.text, decoy: { text3, text4, decoyAt: at } };
}

function callFileOf(ctx: StepContext, bench: Benchmark, job: CallJob, r: Attempted<TasteVerdict>): TasteCallFile {
  const base = {
    round: ctx.roundId, pair: job.pair, kind: job.kind, family: job.family, shadow: job.shadow, session: job.session, rerun: job.rerun,
    order: job.plan.order, task: job.plan.taskId, text1: job.text1.ref.id, text2: job.text2.ref.id, decoy_at: job.plan.decoyAt,
  };
  const v = r.value;
  if (v === null) {
    return { ...base, status: 'void', picks: {}, quotes: {}, decisive: null, decoy_pick: null, preferred_decoy: false, error: ctx.redact(r.error ?? 'void') };
  }
  const picks: Record<string, string> = {};
  for (const [q, pick] of Object.entries(v.picks)) picks[q] = pick === 1 ? job.text1.ref.id : job.text2.ref.id;
  const decisive = Object.hasOwn(picks, bench.decisive) ? picks[bench.decisive] : undefined;
  if (decisive === undefined) throw new Error(`${job.plan.taskId}: the verdict has no answer to ${bench.decisive}`);
  return { ...base, status: 'ok', picks, quotes: { ...v.quotes }, decisive, decoy_pick: v.decoyPick, preferred_decoy: v.preferredDecoy, error: null };
}

/** Runs every job (fresh calls; recorded tasks are reused on resume) and returns one call file per job, in order. */
async function runCalls(ctx: StepContext, bench: Benchmark, seed: string, jobs: readonly CallJob[]): Promise<TasteCallFile[]> {
  const results = await runAll(ctx, jobs.map((j) => () => runTask(ctx, judgeBackend(ctx, j.family), tasteTask(bench, inputOf(j), seed, j.plan.taskId))));
  return jobs.map((job, i) => {
    const r = results[i];
    if (r === undefined) throw new Error(`runAll returned no result for ${job.plan.taskId}`);
    return callFileOf(ctx, bench, job, r);
  });
}

/** Writes the call files and removes any other file in the pair directories they touch (left by a redone step). */
function writeCallFiles(ctx: StepContext, files: readonly TasteCallFile[]): string[] {
  const written = new Set<string>();
  const outputs: string[] = [];
  for (const f of files) {
    const path = tasteCallPath(ctx.paths, f.kind, f.pair, f.family, f.session, f.rerun, f.order);
    written.add(path);
    outputs.push(ctx.files.writeJson(path, f));
  }
  for (const pair of new Set(files.map((f) => f.pair))) {
    const dir = pairDir(ctx.paths, pair);
    for (const name of readdirSync(dir)) if (!written.has(join(dir, name))) ctx.files.remove(join(dir, name));
  }
  return outputs;
}

function sessionJobs(plan: SessionPlan, sub: Judged, champion: Judged, decoyPair: CallJob['decoyPair']): [CallJob, CallJob] {
  const common: Omit<CallJob, 'plan' | 'text1' | 'text2'> = { pair: plan.pairId, kind: 'champion', family: plan.family, shadow: plan.shadow, session: plan.session, rerun: plan.rerun, decoyPair };
  return [
    { ...common, plan: plan.fwd, text1: sub, text2: champion },
    { ...common, plan: plan.rev, text1: champion, text2: sub },
  ];
}

function pairEntry(id: string, kind: PairKind, left: string, right: string, families: readonly Family[], shadow: readonly Family[], sessions: readonly FamilySessions[]): PairEntry {
  const counted = sessions.filter((s) => !s.shadow);
  const effective = kind === 'champion' ? effectiveFamilies(sessions) : counted.filter((s) => s.sessions.some(([f, r]) => f.status === 'ok' || r.status === 'ok')).map((s) => s.family).sort(byCodeUnit);
  return { id, kind, left, right, families: [...families], shadow: [...shadow], effective, dropped: families.filter((f) => !effective.includes(f)) };
}

/**
 * 06b for an explicit passing list (the StepDef passes `passingSubmissions(ctx)`): per submission E = taste-eligible
 * families minus authors of {submission, champion, decoy}, shadow = flagged families minus the same authors;
 * championSchedule with the decoy pair after the real pair; every void session-pair (void call or decoy preferred)
 * runs once more as `s<k>r`; still void → the family drops out of E for that pair. Outputs call files + `pairs.json`.
 */
export async function runChampionPairs(ctx: StepContext, passing: readonly string[]): Promise<StepOutcome> {
  const champion = requireOk(readChampionSnapshot(ctx.paths));
  const decoy = requireOk(readDecoySubmission(ctx.paths));
  if (decoy.champion_sha256 !== sha256(anonymizeText(champion.text))) throw new IntegrityError(`rounds/${ctx.roundId}/submissions/${DECOY_ID}.json was built from another champion`);
  const bench = ctx.benchmark();
  const seed = ctx.seed();
  const states = judgeStates(ctx);
  const shown = anonymizeText(champion.text);
  const championText: Judged = {
    ref: { id: CHAMPION_ID, kind: 'champion', file: ctx.files.rel(join(ctx.paths.dir, CHAMPION_SNAPSHOT)), sha256: sha256(shown), authors: [...champion.authors] },
    text: shown,
  };
  const decoyRef: TextRef = { id: DECOY_ID, kind: 'decoy', file: ctx.files.rel(decoyPath(ctx)), sha256: decoy.text_sha256, authors: [...new Set([...champion.authors, decoy.family])].sort(byCodeUnit) };
  const decoyPair = { champion: shown, decoy: decoy.text };
  const texts: Record<string, TextRef> = { [CHAMPION_ID]: championText.ref, [DECOY_ID]: decoyRef };
  const planned: Array<{ sub: Judged; E: Family[]; shadow: Family[]; plans: SessionPlan[] }> = [];
  for (const id of passing) {
    const sub = judgedSubmission(ctx, id);
    texts[id] = sub.ref;
    const judged = [sub.ref, championText.ref, decoyRef];
    const E = eligibleFamilies(states, judged, 'taste');
    const shadow = shadowFamilies(states, judged);
    planned.push({ sub, E, shadow, plans: championSchedule(E, shadow, seed, id, ctx.protocol.bars.sessionPairs) });
  }
  const firstPlans = planned.flatMap((p) => p.plans.map((plan) => ({ plan, sub: p.sub })));
  const first = await runCalls(ctx, bench, seed, firstPlans.flatMap(({ plan, sub }) => sessionJobs(plan, sub, championText, decoyPair)));
  const again = firstPlans.flatMap(({ plan, sub }, i) => {
    const fwd = first[2 * i];
    const rev = first[2 * i + 1];
    if (fwd === undefined || rev === undefined) throw new Error(`missing call files for ${plan.fwd.taskId}`);
    return sessionVoid(sessionCallOf(fwd), sessionCallOf(rev)) ? [{ plan: rerunPlan(plan, seed), sub }] : [];
  });
  const second = await runCalls(ctx, bench, seed, again.flatMap(({ plan, sub }) => sessionJobs(plan, sub, championText, decoyPair)));
  const all = [...first, ...second];
  const outputs = writeCallFiles(ctx, all);
  const pairs = planned.map((p) => {
    const sessions = familySessionsOf(all.filter((f) => f.pair === p.sub.ref.id));
    const entry = pairEntry(p.sub.ref.id, 'champion', p.sub.ref.id, CHAMPION_ID, p.E, p.shadow, sessions);
    ctx.progress(STEP_CHAMPION, 'info', `${entry.id}: E ${entry.families.join(',') || '-'} → ${entry.effective.join(',') || '-'}; shadow ${entry.shadow.join(',') || '-'}`);
    return entry;
  });
  const file: PairsFile = { round: ctx.roundId, champion: CHAMPION_ID, texts, pairs };
  outputs.push(ctx.files.writeJson(pairsFilePath(ctx.paths, 'champion'), file));
  const inputs = [championText.ref.file, ctx.files.rel(join(ctx.paths.dir, 'decoy.json')), decoyRef.file, ...planned.map((p) => p.sub.ref.file)];
  return { kind: 'done', inputs, outputs, external: [] };
}

/**
 * 06b-champion-pairs: runChampionPairs over passingSubmissions(ctx) (the one list of submissions entering taste).
 * Flagged families run the same schedule as shadow (never in E, bars or tally). Outputs `taste/<pair>/*.json`, `pairs.json`.
 */
export const championPairsStep: StepDef = {
  id: '06b-champion-pairs',
  run: async (ctx) => runChampionPairs(ctx, requireOk(passingSubmissions(ctx))),
};

/**
 * Anchors AN1, AN2: the previous two owner-picked champions of the row (Champion.previous, newest first), read from
 * their round's submission file and checked against the recorded hash (mismatch or missing file → IntegrityError).
 */
function anchorTexts(ctx: StepContext, champion: Champion): Judged[] {
  const refs = champion.previous.filter((p) => p.kind === 'owner_pick').slice(0, ANCHOR_IDS.length);
  return refs.map((ref, i) => {
    const id = ANCHOR_IDS[i] ?? `AN${i + 1}`;
    const paths = roundPaths(ctx.root, ref.round);
    const rel = `rounds/${ref.round}/submissions/${ref.submission}.json`;
    const sub = loadSubmission(paths, ref.submission);
    if (sub === null || sub.output === null) throw new IntegrityError(`anchor ${id}: ${rel} is missing or unreadable`);
    const text = displayText(sub.output);
    if (sha256(text) !== ref.text_sha256) throw new IntegrityError(`anchor ${id}: ${rel} does not match the champion record`);
    return { ref: { id, kind: 'anchor', file: rel, sha256: ref.text_sha256, authors: [ref.family] }, text };
  });
}

interface AuxPlan {
  id: string;
  kind: 'sub_sub' | 'anchor';
  left: Judged;
  right: Judged;
  families: Family[];
}

/** Sub–sub pairs (every two passing submissions) then submission–anchor pairs, each with 2 seeded families (`aux:<pair>`). */
function auxPlans(states: readonly FamilyState[], seed: string, subs: readonly Judged[], anchors: readonly Judged[]): AuxPlan[] {
  const out: AuxPlan[] = [];
  const add = (kind: 'sub_sub' | 'anchor', a: Judged, b: Judged): void => {
    const id = auxPairId(a.ref.id, b.ref.id, kind);
    const [left, right] = kind === 'sub_sub' && byCodeUnit(b.ref.id, a.ref.id) < 0 ? [b, a] : [a, b];
    const pool = eligibleFamilies(states, [left.ref, right.ref], 'taste');
    out.push({ id, kind, left, right, families: pickFamilies(pool, 2, seed, `aux:${id}`).sort(byCodeUnit) });
  };
  subs.forEach((a, i) => subs.slice(i + 1).forEach((b) => add('sub_sub', a, b)));
  for (const s of subs) for (const an of anchors) add('anchor', s, an);
  return out;
}

function auxJobs(p: AuxPlan): CallJob[] {
  return p.families.flatMap((family) => {
    const common: Omit<CallJob, 'plan' | 'text1' | 'text2'> = { pair: p.id, kind: p.kind, family, shadow: false, session: 0, rerun: false, decoyPair: null };
    return [
      { ...common, plan: { taskId: tasteTaskId(p.id, family, 0, false, 'fwd'), order: 'fwd', decoyAt: null }, text1: p.left, text2: p.right },
      { ...common, plan: { taskId: tasteTaskId(p.id, family, 0, false, 'rev'), order: 'rev', decoyAt: null }, text1: p.right, text2: p.left },
    ];
  });
}

/** A skipping 06c removes the aux output of an earlier run (`taste/aux/**`): 08 and 09a read whatever is there. */
function clearAux(ctx: StepContext): void {
  const dir = join(ctx.paths.taste, 'aux');
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) if (e.isFile()) ctx.files.remove(join(e.parentPath, e.name));
}

/**
 * 06c for an explicit passing list: sub–sub and submission–anchor pairs, 2 seeded families × 1 call per order, no
 * decoy, no rerun (a void call is simply missing: ordering only). skip when there is no aux pair (stale aux output removed).
 */
export async function runAuxPairs(ctx: StepContext, passing: readonly string[]): Promise<StepOutcome> {
  const champion = requireOk(readChampionSnapshot(ctx.paths));
  const subs = passing.map((id) => judgedSubmission(ctx, id));
  const anchors = anchorTexts(ctx, champion);
  const seed = ctx.seed();
  const plans = auxPlans(judgeStates(ctx), seed, subs, anchors);
  if (plans.length === 0) {
    clearAux(ctx);
    return { kind: 'skip', reason: `no aux pair (${subs.length} passing submission(s), no anchor)` };
  }
  const files = await runCalls(ctx, ctx.benchmark(), seed, plans.flatMap(auxJobs));
  const outputs = files.length === 0 ? [] : writeCallFiles(ctx, files);
  const texts: Record<string, TextRef> = {};
  for (const j of [...subs, ...anchors]) texts[j.ref.id] = j.ref;
  const pairs = plans.map((p) => pairEntry(p.id, p.kind, p.left.ref.id, p.right.ref.id, p.families, [], familySessionsOf(files.filter((f) => f.pair === p.id))));
  const file: PairsFile = { round: ctx.roundId, champion: CHAMPION_ID, texts, pairs };
  outputs.push(ctx.files.writeJson(pairsFilePath(ctx.paths, 'aux'), file));
  ctx.progress(STEP_AUX, 'info', `${pairs.length} aux pair(s), ${files.length} call(s), ${files.filter((f) => f.status === 'void').length} void`);
  return { kind: 'done', inputs: [ctx.files.rel(join(ctx.paths.dir, CHAMPION_SNAPSHOT)), ...[...subs, ...anchors].map((j) => j.ref.file)], outputs, external: [] };
}

/**
 * 06c-aux-pairs: runAuxPairs over passingSubmissions(ctx). Outputs `taste/aux/<pair>/*.json`, `taste/aux/pairs.json`
 * (AUX_PAIRS_FILE).
 */
export const auxPairsStep: StepDef = {
  id: '06c-aux-pairs',
  run: async (ctx) => runAuxPairs(ctx, requireOk(passingSubmissions(ctx))),
};
