import { extractJsonObject, isRecord, readArray, readNumber, readRecord, readString } from './json.ts';
import { err, ok, type Result } from './result.ts';
import { quoteIn } from './text.ts';

export interface Question {
  id: string;
  text: string;
}

export interface Benchmark {
  version: string;
  decisive: string;
  minQuoteChars: number;
  role: string;
  instructions: string;
  questions: Question[];
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
  return ok({ version, decisive, minQuoteChars, role, instructions, questions });
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
