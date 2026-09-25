import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Backend } from '../adapters/types.ts';
import { isFamily, type Family } from '../config.ts';
import type { StepContext } from '../context.ts';
import { isRecord, readArray, readString } from '../json.ts';
import { err, ok, type Result } from '../result.ts';
import { runAll, type StepDef, type StepOutcome } from '../runner.ts';
import { readJson } from '../store.ts';
import { displayText, loadSubmission } from '../submission.ts';
import { runTask } from '../task.ts';
import { eligibleFamilies, familyStates, pickFamilies } from '../tasks/assign.ts';
import { measureTaskId } from '../tasks/ids.ts';
import {
  checklistItems, coldReaderTask, hookScore, interfaceChecks, makeDistractor, producerTask, recallDetails, recallTask, renderMeasurePrompt, skinLineup,
  skinSwapTask, skinSwapText, type ColdRead, type Detail, type ProducerItem, type ProducerVerdict, type Recall, type SkinLabel, type SkinNoun, type SkinVerdict,
} from '../tasks/measures.ts';
import type { WriterOutput } from '../writer-output.ts';
import { ALIASES_FILE, loadAliasFile, loadRowAliases, loadRows, readBriefJson, ROWS_FILE, type BriefJson } from './brief.ts';
import { judgeBackend, judgeFamilies, passingSubmissions } from './gate-llm.ts';

/** One recall call. */
export interface RecallCall {
  family: Family;
  task: string;
  status: 'ok' | 'void';
  image: string | null;
  quote: string | null;
  error: string | null;
}

/** `rounds/RNN/measures/recall/<sub>.json`: every measure-eligible family's call and the grouped details. */
export interface RecallFile {
  round: string;
  submission: string;
  calls: RecallCall[];
  details: Detail[];
  /** Mechanical memory-hook score: share of valid families whose image is in a detail named by ≥ 2 families; null when no valid call. */
  hook: number | null;
}

export type MeasureStatus = 'ok' | 'void' | 'inactive';

/** `rounds/RNN/measures/skin-swap/<sub>.json`. */
export interface SkinSwapFile {
  round: string;
  submission: string;
  status: MeasureStatus;
  family: Family | null;
  task: string | null;
  lineup: Array<{ label: SkinLabel; row_id: string }>;
  answer: SkinLabel | null;
  verdict: SkinVerdict | null;
}

/** `rounds/RNN/measures/cold-reader/<sub>.json` (its `who` fills the card's protagonist line, labelled 冷读者理解). */
export interface ColdReaderFile {
  round: string;
  submission: string;
  status: MeasureStatus;
  family: Family | null;
  task: string | null;
  read: ColdRead | null;
}

/** `rounds/RNN/measures/producer/<sub>.json`: pass iff every item ok and interfaceChecks is empty; unjudged (red) after two void families. */
export interface ProducerFile {
  round: string;
  submission: string;
  status: 'pass' | 'fail' | 'unjudged';
  /** Failed engine interface checks ([] = pass). */
  mechanical: string[];
  calls: Array<{ family: Family; task: string; status: 'ok' | 'void' }>;
  items: ProducerItem[];
}


export type MeasureDir = 'recall' | 'skin-swap' | 'cold-reader' | 'producer';

/** `rounds/RNN/measures/<dir>/<sub>.json`. */
export function measurePath(ctx: Pick<StepContext, 'paths'>, dir: MeasureDir, submission: string): string {
  return join(ctx.paths.measures, dir, `${submission}.json`);
}

/** Measure-eligible families for one submission (`'measure'` over {submission} with the pinned freeze states). */
export function measurePool(ctx: StepContext, submission: string, authors: readonly Family[]): Family[] {
  return eligibleFamilies(familyStates(ctx.freeze(), judgeFamilies(ctx)), [{ id: submission, authors: [...authors] }], 'measure');
}

/** A gate-passing submission as the measures see it: anonymized display text, author family and model. */
export interface MeasuredText {
  id: string;
  family: Family;
  model: string;
  text: string;
  output: WriterOutput;
  /** Forge-root-relative path of the submission file (a marker input). */
  file: string;
}

export function loadMeasured(ctx: StepContext, submission: string): Result<MeasuredText> {
  const path = join(ctx.paths.submissions, `${submission}.json`);
  const loaded = existsSync(path) ? loadSubmission(ctx.paths, submission) : null;
  if (loaded === null || loaded.output === null) return err(`submissions/${submission}.json is missing or holds no valid submission`);
  if (!isFamily(loaded.family)) return err(`submissions/${submission}.json: unknown author family`);
  return ok({ id: submission, family: loaded.family, model: loaded.model, text: displayText(loaded.output), output: loaded.output, file: ctx.files.rel(path) });
}

/** Every thin-map name (aliases.json + rows.json primaries and aliases) and the submission's new proper nouns. */
function skinNouns(aliases: ReadonlyArray<{ kind: SkinNoun['kind']; primary: string; aliases: readonly string[] }>, output: WriterOutput): SkinNoun[] {
  const out: SkinNoun[] = [];
  for (const a of aliases) for (const term of [a.primary, ...a.aliases]) out.push({ term, kind: a.kind });
  for (const term of output.delta.newProperNouns) out.push({ term, kind: 'new' });
  return out;
}

interface Plan {
  m: MeasuredText;
  pool: Family[];
  recallCalls: Map<Family, RecallCall>;
  recalled: Map<Family, { family: Family; recall: Recall }>;
  skin: SkinSwapFile;
  cold: ColdReaderFile;
  producer: ProducerFile;
}

function newPlan(round: string, m: MeasuredText, pool: Family[]): Plan {
  const base = { round, submission: m.id };
  return {
    m, pool, recallCalls: new Map(), recalled: new Map(),
    skin: { ...base, status: 'void', family: null, task: null, lineup: [], answer: null, verdict: null },
    cold: { ...base, status: 'void', family: null, task: null, read: null },
    producer: { ...base, status: 'unjudged', mechanical: [], calls: [], items: [] },
  };
}

function failed(detail: string): StepOutcome {
  return { kind: 'failed', detail };
}

/**
 * The engine half of 06d for the given submissions (the step passes passingSubmissions): all calls run through
 * runAll, then one file per measure and submission is written. Exported so tests can drive it without 05c.
 */
export async function measureSubmissions(ctx: StepContext, submissions: readonly string[]): Promise<StepOutcome> {
  const bench = ctx.benchmark();
  // hook has no LLM call (mechanical score); its paragraph is validated like the others so a bad one cannot hide.
  const custom: Array<[string, string | null]> = [['skin_swap', bench.measures.skin_swap.prompt], ['cold_reader', bench.measures.cold_reader.prompt], ['hook', bench.measures.hook.prompt]];
  for (const [key, prompt] of custom) {
    const checked = prompt === null ? null : renderMeasurePrompt(prompt);
    if (checked !== null && !checked.ok) return failed(`benchmark ${bench.version} measures.${key}.prompt: ${checked.error}`);
  }
  const brief: BriefJson = readBriefJson(ctx);
  const rows = loadRows(ctx.root);
  if (!rows.ok) return failed(rows.error);
  const aliasFile = loadAliasFile(ctx.root);
  if (!aliasFile.ok) return failed(aliasFile.error);
  const names = loadRowAliases(ctx.root);
  if (!names.ok) return failed(names.error);
  const seed = ctx.seed();
  const inputs = [ctx.files.rel(ctx.paths.brief), ROWS_FILE];
  if (existsSync(join(ctx.root, ALIASES_FILE))) inputs.push(ALIASES_FILE);
  const rowIds = new Set(rows.value.map((r) => r.row_id));
  const cardSources = aliasFile.value.filter((a) => rowIds.has(a.row_id) && a.first_quote.quote.trim() !== '');
  const items = checklistItems(bench.checklistExtra);
  const plans: Plan[] = [];
  const jobs: Array<() => Promise<void>> = [];
  for (const sub of submissions) {
    const loaded = loadMeasured(ctx, sub);
    if (!loaded.ok) return failed(loaded.error);
    const m = loaded.value;
    inputs.push(m.file);
    const pool = measurePool(ctx, sub, [m.family]);
    const plan = newPlan(ctx.roundId, m, pool);
    plans.push(plan);
    for (const family of pool) {
      jobs.push(async () => {
        const spec = recallTask(m.text, makeDistractor(seed, `distractor:${sub}:${family}`), measureTaskId('recall', sub, family, false), seed);
        const r = await runTask(ctx, judgeBackend(ctx, family), spec);
        const v = r.value;
        plan.recallCalls.set(family, { family, task: spec.id, status: v === null ? 'void' : 'ok', image: v?.image ?? null, quote: v?.quote ?? null, error: v === null ? ctx.redact(r.error ?? 'void') : null });
        if (v !== null) plan.recalled.set(family, { family, recall: v });
      });
    }
    const nouns = skinNouns(names.value, m.output);
    const skinMeasure = bench.measures.skin_swap;
    const skinFamily = pickFamilies(pool, 1, seed, `skin:${sub}`)[0];
    const cards = cardSources.map((a) => ({ rowId: a.row_id, text: skinSwapText(a.first_quote.quote, nouns) }));
    const briefCard = cards.find((c) => c.rowId === brief.row_id);
    const lineup = briefCard === undefined ? null : skinLineup(briefCard, cards, seed, `skin:${sub}`);
    if (!skinMeasure.active) plan.skin.status = 'inactive';
    else if (skinFamily === undefined || lineup === null) {
      plan.skin.family = skinFamily ?? null;
      ctx.log(`06d: skin-swap ${sub} void without a call (${skinFamily === undefined ? 'no eligible family' : 'no lineup: the brief row or every other row lacks an aliases.json first_quote'})`);
    } else {
      const spec = skinSwapTask(skinSwapText(m.text, nouns), lineup, skinMeasure, measureTaskId('skin', sub, skinFamily, false), seed);
      plan.skin = { ...plan.skin, family: skinFamily, task: spec.id, lineup: lineup.cards.map((c) => ({ label: c.label, row_id: c.rowId })), answer: lineup.answer };
      jobs.push(async () => {
        const r = await runTask(ctx, judgeBackend(ctx, skinFamily), spec);
        plan.skin.status = r.value === null ? 'void' : 'ok';
        plan.skin.verdict = r.value;
      });
    }
    const coldMeasure = bench.measures.cold_reader;
    const coldFamily = pickFamilies(pool, 1, seed, `cold:${sub}`)[0];
    if (!coldMeasure.active) plan.cold.status = 'inactive';
    else if (coldFamily !== undefined) {
      const spec = coldReaderTask(m.text, coldMeasure, measureTaskId('cold', sub, coldFamily, false), seed);
      plan.cold = { ...plan.cold, family: coldFamily, task: spec.id };
      jobs.push(async () => {
        const r = await runTask(ctx, judgeBackend(ctx, coldFamily), spec);
        plan.cold.status = r.value === null ? 'void' : 'ok';
        plan.cold.read = r.value;
      });
    }
    const producerFamilies = pickFamilies(pool, 2, seed, `producer:${sub}`);
    const mechanical = interfaceChecks(m.output.iface, brief);
    plan.producer.mechanical = mechanical;
    jobs.push(async () => {
      let verdict: ProducerVerdict | null = null;
      for (const [k, family] of producerFamilies.entries()) {
        const spec = producerTask(m.output.iface, m.text, items, measureTaskId('producer', sub, family, k > 0), seed);
        const r = await runTask(ctx, judgeBackend(ctx, family), spec);
        plan.producer.calls.push({ family, task: spec.id, status: r.value === null ? 'void' : 'ok' });
        verdict = r.value;
        if (verdict !== null) break;
      }
      plan.producer.items = verdict?.items ?? [];
      plan.producer.status = verdict === null ? 'unjudged' : verdict.allOk && mechanical.length === 0 ? 'pass' : 'fail';
    });
  }
  await runAll(ctx, jobs);
  const outputs: string[] = [];
  const summary: string[] = [];
  for (const plan of plans) {
    const sub = plan.m.id;
    const calls = plan.pool.flatMap((f) => plan.recallCalls.get(f) ?? []);
    const valid = plan.pool.flatMap((f) => plan.recalled.get(f) ?? []);
    const details = recallDetails(valid, plan.m.text, sub);
    const recall: RecallFile = { round: ctx.roundId, submission: sub, calls, details, hook: bench.measures.hook.active ? hookScore(details, valid.length) : null };
    outputs.push(ctx.files.writeJson(measurePath(ctx, 'recall', sub), recall));
    outputs.push(ctx.files.writeJson(measurePath(ctx, 'skin-swap', sub), plan.skin));
    outputs.push(ctx.files.writeJson(measurePath(ctx, 'cold-reader', sub), plan.cold));
    outputs.push(ctx.files.writeJson(measurePath(ctx, 'producer', sub), plan.producer));
    summary.push(`${sub}: recall ${valid.length}/${plan.pool.length}, ${details.length} details, skin ${plan.skin.status}, cold ${plan.cold.status}, producer ${plan.producer.status}`);
  }
  ctx.progress('06d-measures', 'info', summary.join('; '));
  return { kind: 'done', inputs, outputs, external: [] };
}

function familyList(v: unknown): Family[] | null {
  if (!Array.isArray(v)) return null;
  const out: Family[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || !isFamily(x)) return null;
    out.push(x);
  }
  return out;
}

function parseDetail(v: unknown, at: string): Result<Detail> {
  const id = readString(v, 'id');
  const submission = readString(v, 'submission');
  const image = readString(v, 'image');
  const quote = readString(v, 'quote');
  const families = isRecord(v) ? familyList(v['families']) : null;
  if (id === null || submission === null || image === null || quote === null || families === null) return err(`${at}: needs id, submission, image, quote and families`);
  return ok({ id, submission, image, quote, families });
}

function parseRecallCall(v: unknown, at: string): Result<RecallCall> {
  const family = readString(v, 'family');
  const task = readString(v, 'task');
  const status = readString(v, 'status');
  if (family === null || !isFamily(family) || task === null || (status !== 'ok' && status !== 'void')) return err(`${at}: needs family, task and status ok|void`);
  return ok({ family, task, status, image: readString(v, 'image'), quote: readString(v, 'quote'), error: readString(v, 'error') });
}

/** Reads and narrows `measures/recall/<sub>.json` (07b, 08). */
export function readRecallFile(ctx: Pick<StepContext, 'paths'>, submission: string): Result<RecallFile> {
  const rel = `rounds/${ctx.paths.id}/measures/recall/${submission}.json`;
  const raw = readJson(measurePath(ctx, 'recall', submission));
  if (!isRecord(raw)) return err(`${rel} is missing or not a JSON object`);
  const round = readString(raw, 'round');
  const sub = readString(raw, 'submission');
  const hook = raw['hook'];
  if (round === null || sub !== submission || (hook !== null && typeof hook !== 'number')) return err(`${rel}: needs round, submission ${submission} and hook`);
  const details: Detail[] = [];
  for (const [i, d] of (readArray(raw, 'details') ?? []).entries()) {
    const parsed = parseDetail(d, `${rel} details[${i}]`);
    if (!parsed.ok) return parsed;
    details.push(parsed.value);
  }
  const calls: RecallCall[] = [];
  for (const [i, c] of (readArray(raw, 'calls') ?? []).entries()) {
    const parsed = parseRecallCall(c, `${rel} calls[${i}]`);
    if (!parsed.ok) return parsed;
    calls.push(parsed.value);
  }
  return ok({ round, submission: sub, calls, details, hook });
}

/**
 * 06d-measures: per passing submission — recall from every measure-eligible family (distractor first), skin-swap
 * (1 seeded family, `skin:`), cold reader (`cold:`), producer (`producer:`, one more family `-2` on a void).
 * Inactive benchmark measures write status `inactive`. Outputs `measures/{recall,skin-swap,cold-reader,producer}/<sub>.json`.
 */
export const measuresStep: StepDef = {
  id: '06d-measures',
  run: async (ctx) => {
    const passing = passingSubmissions(ctx);
    if (!passing.ok) return failed(`06d: ${passing.error}`);
    return measureSubmissions(ctx, passing.value);
  },
};
