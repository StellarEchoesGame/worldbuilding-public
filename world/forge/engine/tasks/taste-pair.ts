import { anonymizeText } from '../anonymize.ts';
import { isRecord, type JsonRecord } from '../json.ts';
import { err, ok, type Result } from '../result.ts';
import type { Benchmark, Pick } from '../taste.ts';
import { renderTasteTemplate } from '../taste-template.ts';
import { IntegrityError, type TaskSpec } from '../task.ts';
import { citedIn, mustWrap, outputBlock, parseFencedJson, readCapped } from './fenced.ts';

export { PROMPT_SLOTS, renderTasteTemplate } from '../taste-template.ts';
export type { TasteSlot, TasteSlots } from '../taste-template.ts';

/**
 * Taste call for champion and aux pairs (06b / 06c), bench replay (PR-E) and calibration (PR-C). The prompt is the
 * benchmark's `taste.template` (or DEFAULT_TASTE_TEMPLATE) with the four slots substituted, then
 * `bench.instructions`, then the engine-owned outputBlock — the maintainer changes wording, never the schema.
 * Replay and calibration pass `decoy: null`, so {DECOY_PAIR} renders empty.
 */

/** Used when bench.template is null (v0.1-prototype, v1 unless the maintainer writes one). */
export const DEFAULT_TASTE_TEMPLATE: string = [
  '下面是两篇匿名现场：第 1 篇与第 2 篇。',
  '',
  '第 1 篇：',
  '{TEXT_1}',
  '',
  '第 2 篇：',
  '{TEXT_2}',
  '',
  '问题（每题二选一，填 1 或 2，并逐字引用所选那篇的原文）：',
  '{QUESTIONS}',
  '{DECOY_PAIR}',
].join('\n');

/** Answer quotes are capped at this many code points. */
export const TASTE_QUOTE_MAX = 200;

/** The decoy pair (champion vs decoy) shown after the real pair; `decoyAt` = the decoy's position. */
export interface DecoyPairInput {
  text3: string;
  text4: string;
  decoyAt: 3 | 4;
}

export interface TasteInput {
  text1: string;
  text2: string;
  decoy: DecoyPairInput | null;
}

export interface TasteVerdict {
  /** Question id → position picked (1 = text1). */
  picks: Record<string, Pick>;
  quotes: Record<string, string>;
  /** Decoy-pair answer on bench.decisive; null without a decoy pair. */
  decoyPick: 3 | 4 | null;
  decoyQuote: string | null;
  /** decoyPick === decoy.decoyAt (voids the session-pair). */
  preferredDecoy: boolean;
}


/** Precedes the engine's output block: any output-format wording in bench.instructions yields to it. */
export const TASTE_OUTPUT_OVERRIDE = '（上文如对输出格式另有说法，一律以下面这条为准。）';

/** Prompt labels of positions 1–4 (wrapText labels; fakes read the texts back with `unwrap(prompt, label)`). */
export const TASTE_TEXT_LABELS: readonly [string, string, string, string] = ['文本甲', '文本乙', '文本丙', '文本丁'];

/** The four texts as judges see them: every text goes through anonymize.ts (idempotent on display text). */
interface Shown {
  text1: string;
  text2: string;
  text3: string | null;
  text4: string | null;
}

function shownTexts(input: TasteInput): Shown {
  return {
    text1: anonymizeText(input.text1),
    text2: anonymizeText(input.text2),
    text3: input.decoy === null ? null : anonymizeText(input.decoy.text3),
    text4: input.decoy === null ? null : anonymizeText(input.decoy.text4),
  };
}

function wrapped(label: string, text: string, seed: string, key: string): string {
  return mustWrap('taste', label, text, seed, `${key}:${label}`);
}

function shape(bench: Benchmark, withDecoy: boolean): JsonRecord {
  const answers: JsonRecord = {};
  for (const q of bench.questions) answers[q.id] = { pick: '1 或 2', quote: '所选那篇中的逐字原文' };
  return withDecoy ? { answers, decoy: { pick: '3 或 4', quote: '所选那篇中的逐字原文' } } : { answers };
}

/**
 * The taste TaskSpec: id = `key` (a tasks/ids.ts tasteTaskId, also the wrapText key base), role = bench.role, texts
 * wrapped 〔文本甲〕〔文本乙〕(〔文本丙〕〔文本丁〕 inside {DECOY_PAIR}); no retryPrompt (judges retry identically).
 */
export function tasteTask(bench: Benchmark, input: TasteInput, seed: string, key: string): TaskSpec<TasteVerdict> {
  const [l1, l2, l3, l4] = TASTE_TEXT_LABELS;
  const shown = shownTexts(input);
  const decoyPair =
    shown.text3 === null || shown.text4 === null
      ? ''
      : [
          '',
          `另有一组对照：第 3 篇与第 4 篇。只回答问题 ${bench.decisive}，同样二选一（填 3 或 4），并逐字引用所选那篇的原文。`,
          '',
          '第 3 篇：',
          wrapped(l3, shown.text3, seed, key),
          '',
          '第 4 篇：',
          wrapped(l4, shown.text4, seed, key),
        ].join('\n');
  const body = renderTasteTemplate(bench.template ?? DEFAULT_TASTE_TEMPLATE, {
    TEXT_1: wrapped(l1, shown.text1, seed, key),
    TEXT_2: wrapped(l2, shown.text2, seed, key),
    DECOY_PAIR: decoyPair,
    QUESTIONS: bench.questions.map((q) => `- ${q.id}：${q.text}`).join('\n'),
  });
  // parseBenchmark already ran the slot rules; a frozen benchmark that fails them here is an integrity failure (exit 3).
  if (!body.ok) throw new IntegrityError(`taste: benchmark ${bench.version} ${body.error}`);
  // bench.instructions may carry its own output wording (v0: 只输出一个 JSON 对象); the engine's block overrides it.
  const prompt = [body.value.trimEnd(), '', bench.instructions, '', TASTE_OUTPUT_OVERRIDE, outputBlock(shape(bench, input.decoy !== null))].join('\n');
  return { id: key, role: bench.role, prompt, parse: (text) => parseTasteVerdict(text, bench, input) };
}

/** A pick as a number or a numeric string (as parseVerdict accepts); anything else → null. */
function pickOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && /^\s*\d\s*$/u.test(value)) return Number(value.trim());
  return null;
}

function isPick(n: number | null): n is Pick {
  return n === 1 || n === 2;
}

function isDecoyPick(n: number | null): n is 3 | 4 {
  return n === 3 || n === 4;
}

/**
 * One fenced json block `{answers: {q: {pick, quote}}, decoy?: {pick, quote}}`: every benchmark question answered,
 * pick ∈ {1, 2} (number or numeric string), quote citedIn the picked text (≥ bench.minQuoteChars, ≤ 200);
 * `decoy` required iff input.decoy, pick ∈ {3, 4}, quote cited in the picked decoy-pair text. ASCII errors.
 */
export function parseTasteVerdict(text: string, bench: Benchmark, input: TasteInput): Result<TasteVerdict> {
  const obj = parseFencedJson(text);
  if (!obj.ok) return obj;
  const answers = obj.value['answers'];
  if (!isRecord(answers)) return err('answers: missing or not an object');
  const shown = shownTexts(input);
  const picks: Record<string, Pick> = {};
  const quotes: Record<string, string> = {};
  for (const q of bench.questions) {
    const answer = answers[q.id];
    if (!isRecord(answer)) return err(`answers.${q.id}: missing answer`);
    const pick = pickOf(answer['pick']);
    if (!isPick(pick)) return err(`answers.${q.id}.pick: must be 1 or 2`);
    const quote = readCapped(answer, 'quote', TASTE_QUOTE_MAX);
    if (!quote.ok) return err(`answers.${q.id}.${quote.error}`);
    if (!citedIn(quote.value, pick === 1 ? shown.text1 : shown.text2, bench.minQuoteChars)) {
      return err(`answers.${q.id}.quote: not a verbatim passage of text ${pick} with at least ${bench.minQuoteChars} chars`);
    }
    picks[q.id] = pick;
    quotes[q.id] = quote.value;
  }
  const rawDecoy = Object.hasOwn(obj.value, 'decoy') ? obj.value['decoy'] : null;
  if (input.decoy === null || shown.text3 === null || shown.text4 === null) {
    if (rawDecoy !== null) return err('decoy: this call has no decoy pair, expected no decoy answer');
    return ok({ picks, quotes, decoyPick: null, decoyQuote: null, preferredDecoy: false });
  }
  if (!isRecord(rawDecoy)) return err('decoy: missing answer for the decoy pair');
  const decoyPick = pickOf(rawDecoy['pick']);
  if (!isDecoyPick(decoyPick)) return err('decoy.pick: must be 3 or 4');
  const decoyQuote = readCapped(rawDecoy, 'quote', TASTE_QUOTE_MAX);
  if (!decoyQuote.ok) return err(`decoy.${decoyQuote.error}`);
  if (!citedIn(decoyQuote.value, decoyPick === 3 ? shown.text3 : shown.text4, bench.minQuoteChars)) {
    return err(`decoy.quote: not a verbatim passage of text ${decoyPick} with at least ${bench.minQuoteChars} chars`);
  }
  return ok({ picks, quotes, decoyPick, decoyQuote: decoyQuote.value, preferredDecoy: decoyPick === input.decoy.decoyAt });
}
