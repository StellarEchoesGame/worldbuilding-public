import { extractJsonObject, isRecord, readArray, readBoolean, readNumber, readRecord, readString, stringArray } from './json.ts';
import { err, ok, type Result } from './result.ts';
import { renderTasteTemplate, TEMPLATE_PROBE_SLOTS } from './taste-template.ts';
import { quoteIn } from './text.ts';

export { TASTE_TEMPLATE_MAX } from './taste-template.ts';

export interface Question {
  id: string;
  text: string;
}

/** Benchmark `measures.<key>` (maintainer-owned); an absent block reads as active with the engine default wording. */
export interface MeasureBlock {
  active: boolean;
  /** Maintainer instruction paragraph (no `{`-slots, no fences; see tasks/measures.ts renderMeasurePrompt); null = engine default. */
  prompt: string | null;
}

export type MeasureKey = 'hook' | 'skin_swap' | 'cold_reader' | 'surprise';

export const MEASURE_KEYS: readonly MeasureKey[] = ['hook', 'skin_swap', 'cold_reader', 'surprise'];

export const DEFAULT_MEASURES: Readonly<Record<MeasureKey, MeasureBlock>> = {
  hook: { active: true, prompt: null },
  skin_swap: { active: true, prompt: null },
  cold_reader: { active: true, prompt: null },
  surprise: { active: true, prompt: null },
};

/** Benchmark `decoy_recipe` (owner-class): how many details the decoy writer genericizes, and how. */
export interface DecoyRecipe {
  details: number;
  instructions: string;
}

export interface Benchmark {
  version: string;
  decisive: string;
  minQuoteChars: number;
  role: string;
  instructions: string;
  questions: Question[];
  /** `taste.template` (replay class, ≤ 2,000 chars, slots checked by tasks/taste-pair.ts renderTasteTemplate); null = DEFAULT_TASTE_TEMPLATE. */
  template: string | null;
  /** `measures` blocks; absent keys read as DEFAULT_MEASURES. Recall and the producer judge always run. */
  measures: Readonly<Record<MeasureKey, MeasureBlock>>;
  /** `decoy_recipe`; null when the version has none (06a then fails). */
  decoyRecipe: DecoyRecipe | null;
  /** `interface_checklist_extra` (producer items X1…, additions only); [] when absent. */
  checklistExtra: string[];
}

export type Pick = 1 | 2;

export interface Verdict {
  picks: Record<string, Pick>;
  quotes: Record<string, string>;
}

/** Reads the taste section of a benchmark version file (see schema/benchmark.schema.json). */
export function parseBenchmark(value: unknown): Result<Benchmark> {
  const version = readString(value, 'version');
  const taste = readRecord(value, 'taste');
  const decisive = readString(taste, 'decisive');
  const role = readString(taste, 'role');
  const instructions = readString(taste, 'instructions');
  const list = readArray(taste, 'questions');
  const minQuoteChars = readNumber(taste, 'min_quote_chars');
  if (version === null || decisive === null || role === null || instructions === null || list === null || minQuoteChars === null) {
    return err('benchmark: version and taste.{role, instructions, questions, decisive, min_quote_chars} are required');
  }
  const questions: Question[] = [];
  for (const q of list) {
    const id = readString(q, 'id');
    const text = readString(q, 'text');
    if (id === null || text === null) return err('benchmark: every question needs id and text');
    questions.push({ id, text });
  }
  if (!questions.some((q) => q.id === decisive)) return err(`benchmark: decisive question ${decisive} is not defined`);
  const template = parseTemplate(taste);
  if (!template.ok) return template;
  const measures = parseMeasures(value);
  if (!measures.ok) return measures;
  const decoyRecipe = parseDecoyRecipe(value);
  if (!decoyRecipe.ok) return decoyRecipe;
  const checklistExtra = parseChecklistExtra(value);
  if (!checklistExtra.ok) return checklistExtra;
  return ok({
    version,
    decisive,
    minQuoteChars,
    role,
    instructions,
    questions,
    template: template.value,
    measures: measures.value,
    decoyRecipe: decoyRecipe.value,
    checklistExtra: checklistExtra.value,
  });
}

/** Absent or null → null; otherwise a string passing the slot rules (renderTasteTemplate with probe slots), so no invalid template becomes a version. */
function parseTemplate(taste: unknown): Result<string | null> {
  if (!isRecord(taste) || !Object.hasOwn(taste, 'template') || taste['template'] === null) return ok(null);
  const t = taste['template'];
  if (typeof t !== 'string') return err('benchmark: taste.template must be a string');
  const probe = renderTasteTemplate(t, TEMPLATE_PROBE_SLOTS);
  if (!probe.ok) return err(`benchmark: taste.${probe.error}`);
  return ok(t);
}

function parseMeasures(value: unknown): Result<Readonly<Record<MeasureKey, MeasureBlock>>> {
  const raw = readRecord(value, 'measures');
  const out: Record<MeasureKey, MeasureBlock> = { ...DEFAULT_MEASURES };
  if (raw === null) return ok(out);
  for (const key of MEASURE_KEYS) {
    if (!Object.hasOwn(raw, key)) continue;
    const block = raw[key];
    const active = readBoolean(block, 'active');
    if (!isRecord(block) || active === null) return err(`benchmark: measures.${key}.active must be a boolean`);
    const prompt = block['prompt'];
    if (prompt !== undefined && prompt !== null && typeof prompt !== 'string') return err(`benchmark: measures.${key}.prompt must be a string`);
    out[key] = { active, prompt: typeof prompt === 'string' ? prompt : null };
  }
  return ok(out);
}

function parseDecoyRecipe(value: unknown): Result<DecoyRecipe | null> {
  if (!isRecord(value) || !Object.hasOwn(value, 'decoy_recipe') || value['decoy_recipe'] === null) return ok(null);
  const raw = value['decoy_recipe'];
  const details = readNumber(raw, 'details');
  const instructions = readString(raw, 'instructions');
  if (details === null || !Number.isInteger(details) || details < 1 || instructions === null) {
    return err('benchmark: decoy_recipe needs an integer details >= 1 and instructions');
  }
  return ok({ details, instructions });
}

function parseChecklistExtra(value: unknown): Result<string[]> {
  if (!isRecord(value) || !Object.hasOwn(value, 'interface_checklist_extra')) return ok([]);
  const list = stringArray(value['interface_checklist_extra']);
  return list === null ? err('benchmark: interface_checklist_extra must be an array of strings') : ok(list);
}

export function tastePrompt(bench: Benchmark, text1: string, text2: string): string {
  const shape: Record<string, { pick: string; quote: string }> = {};
  for (const q of bench.questions) shape[q.id] = { pick: '1 或 2', quote: '所选那篇中的原文' };
  return [
    '下面是两篇匿名现场。',
    '',
    '【第 1 篇】',
    text1,
    '【第 1 篇完】',
    '',
    '【第 2 篇】',
    text2,
    '【第 2 篇完】',
    '',
    '问题：',
    ...bench.questions.map((q) => `- ${q.id}：${q.text}`),
    '',
    bench.instructions,
    '',
    `输出格式：${JSON.stringify(shape)}`,
  ].join('\n');
}

function isPick(n: number | null): n is Pick {
  return n === 1 || n === 2;
}

export function parseVerdict(raw: string, bench: Benchmark, text1: string, text2: string): Result<Verdict> {
  const obj = extractJsonObject(raw);
  if (obj === null) return err('no JSON object in judge output');
  const picks: Record<string, Pick> = {};
  const quotes: Record<string, string> = {};
  for (const q of bench.questions) {
    const answer = readRecord(obj, q.id);
    if (!isRecord(answer)) return err(`${q.id}: missing answer`);
    const pickNum = readNumber(answer, 'pick') ?? Number(readString(answer, 'pick'));
    const pick = Number.isFinite(pickNum) ? pickNum : null;
    if (!isPick(pick)) return err(`${q.id}: pick must be 1 or 2`);
    const quote = readString(answer, 'quote') ?? '';
    if (!quoteIn(quote, pick === 1 ? text1 : text2, bench.minQuoteChars)) return err(`${q.id}: quote is not a verbatim passage of text ${pick} with at least ${bench.minQuoteChars} characters`);
    picks[q.id] = pick;
    quotes[q.id] = quote;
  }
  return ok({ picks, quotes });
}
