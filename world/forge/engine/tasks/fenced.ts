import { createHash } from 'node:crypto';
import { isRecord, type JsonRecord } from '../json.ts';
import { err, ok, type Result } from '../result.ts';
import { normalizeForQuote, quoteIn, sentenceKey } from '../text.ts';

/**
 * Fence and field helpers shared by every task parser. Error strings are ASCII (they are quoted into retry
 * prompts and calls/ records) and never echo model text.
 */

export interface Span {
  start: number;
  end: number;
}

const FENCE_OPEN = /^ {0,3}```[ \t]*([^`\s]*)[ \t]*$/u;
const FENCE_CLOSE = /^ {0,3}```[ \t]*$/u;

interface FencedBlock {
  info: string;
  body: string;
}

function fencedBlocks(text: string): Result<FencedBlock[]> {
  const blocks: FencedBlock[] = [];
  let open: { info: string; lines: string[] } | null = null;
  for (const line of text.split(/\r?\n/u)) {
    if (open === null) {
      const m = FENCE_OPEN.exec(line);
      if (m !== null) open = { info: (m[1] ?? '').toLowerCase(), lines: [] };
    } else if (FENCE_CLOSE.test(line)) {
      blocks.push({ info: open.info, body: open.lines.join('\n') });
      open = null;
    } else {
      open.lines.push(line);
    }
  }
  if (open !== null) return err('unclosed code fence');
  return ok(blocks);
}

/** Exactly one ```json fenced block whose body is a JSON object; zero or ≥ 2 fenced blocks → err (the call is retried). */
export function parseFencedJson(text: string): Result<JsonRecord> {
  const blocks = fencedBlocks(text);
  if (!blocks.ok) return err(blocks.error);
  if (blocks.value.length !== 1) return err(`expected exactly one fenced json block, found ${blocks.value.length} fenced blocks`);
  const block = blocks.value[0];
  if (block === undefined || block.info !== 'json') return err('the fenced block is not marked json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(block.body);
  } catch {
    return err('the json block does not parse');
  }
  if (!isRecord(parsed)) return err('the json block is not an object');
  return ok(parsed);
}

function codePoints(text: string): number {
  return [...text].length;
}

/** Non-empty after trim and ≤ max code points; returns the trimmed value (NFKC is not applied). */
export function readCapped(obj: JsonRecord, key: string, max: number): Result<string> {
  const v = obj[key];
  if (typeof v !== 'string') return err(`${key}: missing or not a string`);
  const trimmed = v.trim();
  if (trimmed === '') return err(`${key}: empty`);
  if (codePoints(trimmed) > max) return err(`${key}: longer than ${max} chars`);
  return ok(trimmed);
}

/** As readCapped, but an explicit null is accepted; a missing key is still an error. */
export function readCappedOrNull(obj: JsonRecord, key: string, max: number): Result<string | null> {
  if (!Object.hasOwn(obj, key)) return err(`${key}: missing`);
  if (obj[key] === null) return ok(null);
  return readCapped(obj, key, max);
}

export function isOneOf<T extends string>(v: string, allowed: readonly T[]): v is T {
  return allowed.some((a) => a === v);
}

/** Tolerant citation check = text.ts quoteIn (NFKC, whitespace and punctuation ignored, ≥ minChars). */
export function citedIn(quote: string, text: string, minChars: number): boolean {
  return quoteIn(quote, text, minChars);
}

/** Strict check for engine-applied edits: sentenceKey(text) contains sentenceKey(needle) exactly `times` times (overlaps count). */
export function occursExactly(needle: string, text: string, times: number): boolean {
  const n = sentenceKey(needle);
  if (n === '') return false;
  const hay = sentenceKey(text);
  let count = 0;
  for (let i = hay.indexOf(n); i !== -1; i = hay.indexOf(n, i + 1)) count += 1;
  return count === times;
}

/** Span (code points) of a cited quote in normalizeForQuote(text) coordinates; null when absent or empty. */
export function quoteSpan(quote: string, text: string): Span | null {
  const q = normalizeForQuote(quote);
  if (q === '') return null;
  const hay = normalizeForQuote(text);
  const at = hay.indexOf(q);
  if (at === -1) return null;
  const start = codePoints(hay.slice(0, at));
  return { start, end: start + codePoints(q) };
}

/** True when the two spans share at least `minChars` positions. */
export function spansOverlap(a: Span, b: Span, minChars: number): boolean {
  return Math.min(a.end, b.end) - Math.max(a.start, b.start) >= minChars;
}

const TAG = /^[0-9a-f]{4}$/u;

function wrapTag(seed: string, key: string): string {
  return createHash('sha256').update(`${seed}\u0000wrap:${key}`, 'utf8').digest('hex').slice(0, 4);
}

/**
 * Wraps prompt material in seed-derived delimiters `〔<label>·3f9a〕…〔<label>完·3f9a〕`; err when the text already
 * holds the delimiter token (injection guard). Builders embed structured input only this way (fakes use unwrap).
 */
export function wrapText(label: string, text: string, seed: string, key: string): Result<string> {
  const tag = wrapTag(seed, key);
  if (text.includes(`·${tag}〕`)) return err('text contains its delimiter token');
  return ok(`〔${label}·${tag}〕\n${text}\n〔${label}完·${tag}〕`);
}

/** The material wrapped under `label` by wrapText (first occurrence), or null; the only way fakes read prompt material. */
export function unwrap(prompt: string, label: string): string | null {
  const openPrefix = `〔${label}·`;
  for (let at = prompt.indexOf(openPrefix); at !== -1; at = prompt.indexOf(openPrefix, at + 1)) {
    const tagStart = at + openPrefix.length;
    const tagEnd = prompt.indexOf('〕', tagStart);
    if (tagEnd === -1) return null;
    const tag = prompt.slice(tagStart, tagEnd);
    if (!TAG.test(tag)) continue;
    const bodyStart = tagEnd + 1;
    const closeAt = prompt.indexOf(`〔${label}完·${tag}〕`, bodyStart);
    if (closeAt === -1) continue;
    let body = prompt.slice(bodyStart, closeAt);
    if (body.startsWith('\n')) body = body.slice(1);
    if (body.endsWith('\n')) body = body.slice(0, -1);
    return body;
  }
  return null;
}

/** The engine-owned Chinese output instruction every JSON task prompt ends with. */
export function outputBlock(shape: JsonRecord): string {
  return `只输出一个 \`\`\`json 代码块，代码块外不写任何文字；形状如下：\n\`\`\`json\n${JSON.stringify(shape, null, 2)}\n\`\`\``;
}
