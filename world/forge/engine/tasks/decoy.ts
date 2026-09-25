import { anonymizeText } from '../anonymize.ts';
import { isRecord } from '../json.ts';
import { err, ok, type Result } from '../result.ts';
import { sha256 } from '../store.ts';
import type { DecoyRecipe } from '../taste.ts';
import type { TaskSpec } from '../task.ts';
import { isOneOf, occursExactly, outputBlock, parseFencedJson, mustWrap, readCapped } from './fenced.ts';
import { ROLE_DECOY } from './roles.ts';

/**
 * Decoy writer (s2 §3.3): the model returns a replacement map, the engine applies it, so length and format hold by
 * construction and `decoy.json` is the map itself. One per round (06a), gateway `ctx.backends.decoy`.
 */

export type { DecoyRecipe };

export type DecoyKind = '专名' | '物件' | '动作' | '感官' | '习俗' | '其他';

export const DECOY_KINDS: readonly DecoyKind[] = ['专名', '物件', '动作', '感官', '习俗', '其他'];

/** `original` 2–30 chars (verbatim, occurs exactly once), `generic` 1–30 chars. */
export const DECOY_ORIGINAL_MAX = 30;
export const DECOY_GENERIC_MAX = 30;
/** Applied text length must stay within ±5 % of the champion (code points). */
export const DECOY_LENGTH_TOLERANCE = 0.05;

const ORIGINAL_MIN = 2;
/** Newlines and the Markdown markers anonymizeText would strip or reinterpret. */
const FORMAT_CHARS = /[\r\n`*_#>|~[\]]/u;

export interface DecoyReplacement {
  original: string;
  generic: string;
  kind: DecoyKind;
}

export interface DecoyPlan {
  replacements: DecoyReplacement[];
}

/** The applied decoy; `decoy.json` = replacements + championSha256 + recipeVersion (+ task id, text sha256). */
export interface Decoy {
  /** Champion display text with every original replaced by its generic. */
  text: string;
  replacements: DecoyReplacement[];
  /** SHA-256 of the champion display text the map was applied to. */
  championSha256: string;
  /** Benchmark version whose decoy_recipe was used. */
  recipeVersion: string;
}

function codePoints(text: string): number {
  return [...text].length;
}

/** Literal occurrences of `needle` in `text`, overlaps counted. */
function literalCount(needle: string, text: string): number {
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) n += 1;
  return n;
}

/**
 * The champion with every original replaced (the one application rule shared by the parser and applyDecoy): each
 * original occurs exactly once (literally and after NFKC), originals are pairwise non-overlapping, the result
 * differs from the champion. Errors name the replacement index, never model text.
 */
function applyReplacements(champion: string, replacements: readonly DecoyReplacement[]): Result<string> {
  const spans: Array<{ start: number; end: number; generic: string; i: number }> = [];
  for (const [i, r] of replacements.entries()) {
    if (literalCount(r.original, champion) !== 1 || !occursExactly(r.original, champion, 1)) {
      return err(`replacements[${i}].original: must occur exactly once, verbatim, in the text`);
    }
    const start = champion.indexOf(r.original);
    spans.push({ start, end: start + r.original.length, generic: r.generic, i });
  }
  spans.sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const s of spans) {
    if (s.start < at) return err(`replacements[${s.i}].original: overlaps another original`);
    out += champion.slice(at, s.start) + s.generic;
    at = s.end;
  }
  out += champion.slice(at);
  if (out === champion) return err('the replacements leave the text unchanged');
  return ok(out);
}

function readReplacement(value: unknown, i: number): Result<DecoyReplacement> {
  if (!isRecord(value)) return err(`replacements[${i}]: expected an object`);
  const original = readCapped(value, 'original', DECOY_ORIGINAL_MAX);
  if (!original.ok) return err(`replacements[${i}].${original.error}`);
  if (codePoints(original.value) < ORIGINAL_MIN) return err(`replacements[${i}].original: shorter than ${ORIGINAL_MIN} chars`);
  if (/[\r\n]/u.test(original.value)) return err(`replacements[${i}].original: must not span lines`);
  const generic = readCapped(value, 'generic', DECOY_GENERIC_MAX);
  if (!generic.ok) return err(`replacements[${i}].${generic.error}`);
  if (FORMAT_CHARS.test(generic.value)) return err(`replacements[${i}].generic: no newline or Markdown markers`);
  if (generic.value === original.value || generic.value.includes(original.value)) {
    return err(`replacements[${i}].generic: must differ from and not contain the original`);
  }
  const kind = value['kind'];
  if (typeof kind !== 'string' || !isOneOf(kind, DECOY_KINDS)) return err(`replacements[${i}].kind: not one of the six kinds`);
  return ok({ original: original.value, generic: generic.value, kind });
}

/**
 * Exactly recipe.details entries; each original occursExactly once in the champion, originals pairwise
 * non-overlapping; generic ≠ original, does not contain it, no Markdown or newline; applied length within ±5 %; when
 * the champion is display text (an anonymizeText fixed point) the applied text must stay one, so judges see it as stored.
 */
export function parseDecoyPlan(text: string, championDisplay: string, recipe: DecoyRecipe): Result<DecoyPlan> {
  const obj = parseFencedJson(text);
  if (!obj.ok) return obj;
  const list = obj.value['replacements'];
  if (!Array.isArray(list)) return err('replacements: missing or not an array');
  if (list.length !== recipe.details) return err(`replacements: expected exactly ${recipe.details} entries, got ${list.length}`);
  const replacements: DecoyReplacement[] = [];
  for (const [i, item] of list.entries()) {
    const r = readReplacement(item, i);
    if (!r.ok) return r;
    replacements.push(r.value);
  }
  const applied = applyReplacements(championDisplay, replacements);
  if (!applied.ok) return applied;
  if (anonymizeText(championDisplay) === championDisplay && anonymizeText(applied.value) !== applied.value) {
    return err('the applied text must stay plain display text (no quotes, ellipses or markup that typesetting changes)');
  }
  const base = codePoints(championDisplay);
  if (Math.abs(codePoints(applied.value) - base) > base * DECOY_LENGTH_TOLERANCE) {
    return err(`the applied text length must stay within ${DECOY_LENGTH_TOLERANCE * 100}% of the original`);
  }
  return ok({ replacements });
}

/** Applies a validated plan; err when an original no longer occurs exactly once or the result equals the champion. */
export function applyDecoy(champion: string, plan: DecoyPlan, recipeVersion: string): Result<Decoy> {
  const applied = applyReplacements(champion, plan.replacements);
  if (!applied.ok) return applied;
  return ok({ text: applied.value, replacements: plan.replacements.map((r) => ({ ...r })), championSha256: sha256(champion), recipeVersion });
}

function retryWith(prompt: string): (error: string) => string {
  return (error) => `${prompt}\n\n# 上一次输出未通过校验\n错误：${error}\n请针对这个错误重新给出完整的替换表，仍然严格按上面的输出格式作答。`;
}

/**
 * The decoy TaskSpec (role ROLE_DECOY; Chinese prompt: champion wrapped as 〔文本甲〕, 「按以下配方把其中最具体的 N 处细节
 * 换成泛泛的同类说法：…只给出替换表，不要重写全文。」, outputBlock); retryPrompt quotes the validation error.
 */
export function decoyTask(championDisplay: string, recipe: DecoyRecipe, id: string, seed: string): TaskSpec<DecoyPlan> {
  const instructions = recipe.instructions.trim().replace(/[。.]+$/u, '');
  const prompt = [
    '下面是一篇现场（文本甲）：',
    mustWrap('decoy', '文本甲', championDisplay, seed, `${id}:文本甲`),
    '',
    `按以下配方把其中最具体的 ${recipe.details} 处细节换成泛泛的同类说法：${instructions}。只给出替换表，不要重写全文。`,
    '',
    '要求：',
    `- 恰好 ${recipe.details} 条替换；`,
    `- original 逐字摘自文本甲，${ORIGINAL_MIN}–${DECOY_ORIGINAL_MAX} 字，在全文中只出现一次，且各条 original 互不重叠；`,
    `- generic 是 1–${DECOY_GENERIC_MAX} 字的泛化说法，不包含原文，不含换行或 Markdown 符号；`,
    `- kind 取 ${DECOY_KINDS.join('、')} 之一；`,
    `- 全部替换后，全文长度与原文相差不超过 ${DECOY_LENGTH_TOLERANCE * 100}%。`,
    '',
    outputBlock({ replacements: [{ original: `逐字原文（${ORIGINAL_MIN}–${DECOY_ORIGINAL_MAX} 字）`, generic: `泛化说法（1–${DECOY_GENERIC_MAX} 字）`, kind: DECOY_KINDS.join('|') }] }),
  ].join('\n');
  return { id, role: ROLE_DECOY, prompt, parse: (text) => parseDecoyPlan(text, championDisplay, recipe), retryPrompt: retryWith(prompt) };
}
