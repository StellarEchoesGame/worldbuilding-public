import { isRecord, type JsonRecord } from '../json.ts';
import { err, ok, type Result } from '../result.ts';
import type { TaskSpec } from '../task.ts';
import { quoteIn } from '../text.ts';
import { checkTags, LAYER_LABELS, LAYERS, type Alias, type Layer } from '../thinmap.ts';
import { isOneOf, mustWrap, outputBlock, parseFencedJson, readCapped } from './fenced.ts';
import { ROLE_TAG, ROLE_TAG_REVIEW } from './roles.ts';

/**
 * 11d tagger and tag reviewer (plan §8 Bookkeeping, s5 §6; PR-D group D3; F1-05 reuses both TaskSpecs for full-canon
 * batching). Two different seed-chosen eligible families, neither an author family of the scene's sources, fresh
 * sessions (ROLE_TAG / ROLE_TAG_REVIEW). Parsers drop every quote that is not a verbatim substring of the scene.
 */

export interface TagProposal {
  row_id: string;
  layer: Layer;
  /** Verbatim substrings of the scene (others dropped by the parser). */
  quotes: string[];
  /** Named but not evidenced here (thinmap `dangling`). */
  dangling: string[];
}

export interface TagReview {
  row_id: string;
  layer: Layer;
  quote: string;
  verdict: 'keep' | 'dispute';
  /** ≤ 80 chars. */
  reason: string;
}

/** A reviewed quote that goes into map/tags.json. */
export interface KeptTag {
  row_id: string;
  layer: Layer;
  quote: string;
}

/** Quote floor (significant chars, text.ts quoteIn) and cap (code points); dangling names and review reasons cap. */
export const TAG_QUOTE_MIN = 4;
export const TAG_QUOTE_MAX = 120;
export const TAG_DANGLING_MAX = 30;
export const TAG_REASON_MAX = 80;

const VERDICTS: ReadonlyArray<TagReview['verdict']> = ['keep', 'dispute'];

function codePoints(text: string): number {
  return [...text].length;
}

/** Kept by every parser: a verbatim (exact) substring of the scene with ≥ TAG_QUOTE_MIN significant chars, ≤ TAG_QUOTE_MAX. */
function inScene(quote: string, scene: string): boolean {
  return quote !== '' && codePoints(quote) <= TAG_QUOTE_MAX && scene.includes(quote) && quoteIn(quote, scene, TAG_QUOTE_MIN);
}

/** `tag-<RNN>-<family>`. */
export function tagTaskId(round: string, family: string): string {
  return `tag-${round}-${family}`;
}

/** `tagreview-<RNN>-<family>`. */
export function tagReviewTaskId(round: string, family: string): string {
  return `tagreview-${round}-${family}`;
}

/** English layer id or its Chinese label (thinmap LAYER_LABELS). */
function layerOf(value: string): Layer | null {
  return LAYERS.find((l) => l === value || LAYER_LABELS[l] === value) ?? null;
}

function retryWith(prompt: string): (error: string) => string {
  return (error) => `${prompt}\n\n# 上一次输出未通过校验\n错误：${error}\n请针对这个错误重新作答，仍然严格按上面的输出格式。`;
}

function rowLine(a: Alias): string {
  const others = a.aliases.filter((n) => n.trim() !== '' && n !== a.primary);
  return others.length === 0 ? `${a.row_id}｜${a.primary}` : `${a.row_id}｜${a.primary}（又名：${others.join('、')}）`;
}

/** Tagger over the scene for the touched rows (Alias shape: rows + characters) and layers. */
export function tagTask(scene: string, rows: readonly Alias[], layers: readonly Layer[], id: string, seed: string): TaskSpec<TagProposal[]> {
  const prompt = [
    '下面是一篇刚并入正典的现场：',
    mustWrap('tag', '现场', scene, seed, `${id}:现场`),
    '',
    '需要标注的地图行（行编号｜名称）：',
    mustWrap('tag', '行', rows.map(rowLine).join('\n'), seed, `${id}:行`),
    '',
    '需要标注的层（层编号｜含义）：',
    ...layers.map((l) => `- ${l}｜${LAYER_LABELS[l]}`),
    '',
    '对每一行、每一层，找出现场里能证明这一行在这一层写出了具体内容的句子，逐字摘录为引文。',
    '要求：',
    `- 每条引文必须是现场原文中连续的一段，一字不改，${TAG_QUOTE_MIN}–${TAG_QUOTE_MAX} 字；不是原文的引文会被丢弃；`,
    `- 现场只点了名、却没有写出具体内容的东西，把它的名称（不超过 ${TAG_DANGLING_MAX} 字）写进 dangling；`,
    '- row_id 和 layer 只能取上面列出的编号；没有证据的行与层不要列出；',
    '- 只标注现场本身写出的内容，不引用你对这个世界的其他了解。',
    '',
    outputBlock({ tags: [{ row_id: '行编号', layer: '层编号', quotes: ['逐字引文'], dangling: ['只被点名的东西'] }] }),
  ].join('\n');
  return { id, role: ROLE_TAG, prompt, parse: (text) => parseTagProposals(text, scene, rows, layers), retryPrompt: retryWith(prompt) };
}

function stringsAt(item: JsonRecord, key: string, at: string): Result<string[]> {
  const v = item[key];
  if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) return err(`${at}.${key}: expected a string array`);
  return ok(v.filter((s): s is string => typeof s === 'string').map((s) => s.trim()));
}

/**
 * Exactly one ```json block `{tags: [{row_id, layer, quotes, dangling}]}`; row_id among `rows`, layer among `layers`
 * (English id or Chinese label). Quotes not verbatim in the scene are dropped (never an error); entries of one
 * (row_id, layer) merge; entries left without quotes and dangling are omitted. Sorted by row order, then LAYERS.
 */
export function parseTagProposals(text: string, scene: string, rows: readonly Alias[], layers: readonly Layer[]): Result<TagProposal[]> {
  const obj = parseFencedJson(text);
  if (!obj.ok) return obj;
  const list = obj.value['tags'];
  if (!Array.isArray(list)) return err('tags: missing or not an array');
  const rowIds = rows.map((r) => r.row_id);
  const merged = new Map<string, TagProposal>();
  for (const [i, item] of list.entries()) {
    const at = `tags[${i}]`;
    if (!isRecord(item)) return err(`${at}: expected an object`);
    const rowId = item['row_id'];
    if (typeof rowId !== 'string' || !rowIds.includes(rowId)) return err(`${at}.row_id: not one of the listed rows`);
    const rawLayer = item['layer'];
    const layer = typeof rawLayer === 'string' ? layerOf(rawLayer.trim()) : null;
    if (layer === null || !layers.includes(layer)) return err(`${at}.layer: not one of the listed layers`);
    const quotes = stringsAt(item, 'quotes', at);
    if (!quotes.ok) return quotes;
    const dangling = stringsAt(item, 'dangling', at);
    if (!dangling.ok) return dangling;
    const key = `${rowId}\u0000${layer}`;
    const p = merged.get(key) ?? { row_id: rowId, layer, quotes: [], dangling: [] };
    for (const q of quotes.value) if (inScene(q, scene) && !p.quotes.includes(q)) p.quotes.push(q);
    for (const d of dangling.value) if (d !== '' && codePoints(d) <= TAG_DANGLING_MAX && !p.dangling.includes(d)) p.dangling.push(d);
    merged.set(key, p);
  }
  return ok(
    [...merged.values()]
      .filter((p) => p.quotes.length > 0 || p.dangling.length > 0)
      .sort((a, b) => rowIds.indexOf(a.row_id) - rowIds.indexOf(b.row_id) || LAYERS.indexOf(a.layer) - LAYERS.indexOf(b.layer)),
  );
}

interface ReviewItem {
  id: string;
  row_id: string;
  layer: Layer;
  quote: string;
}

/** `T1`, `T2`, … over every proposed quote still verbatim in the scene, in proposal order. */
function reviewItems(scene: string, proposals: readonly TagProposal[]): ReviewItem[] {
  const out: ReviewItem[] = [];
  for (const p of proposals) {
    for (const quote of p.quotes) if (inScene(quote, scene)) out.push({ id: `T${out.length + 1}`, row_id: p.row_id, layer: p.layer, quote });
  }
  return out;
}

/** Reviewer: one verdict per proposed quote. */
export function reviewTagTask(scene: string, proposals: readonly TagProposal[], id: string, seed: string): TaskSpec<TagReview[]> {
  const items = reviewItems(scene, proposals);
  const prompt = [
    '下面是一篇刚并入正典的现场：',
    mustWrap('tagreview', '现场', scene, seed, `${id}:现场`),
    '',
    '另一位标注员为这篇现场做了薄图标注（编号｜行编号｜层｜引文）：',
    mustWrap('tagreview', '标注', items.map((t) => `${t.id}｜${t.row_id}｜${LAYER_LABELS[t.layer]}｜${t.quote}`).join('\n'), seed, `${id}:标注`),
    '',
    '逐条判断：这条引文是否确实写出了该行在该层的具体内容。',
    '- 成立：verdict 写 keep；',
    '- 不成立（引文与该行无关、属于别的层，或只是点名而没有内容）：verdict 写 dispute；',
    `- 每条都要给出不超过 ${TAG_REASON_MAX} 字的理由；每个编号恰好判断一次。`,
    '',
    outputBlock({ reviews: [{ id: 'T1', verdict: VERDICTS.join('|'), reason: `理由（不超过 ${TAG_REASON_MAX} 字）` }] }),
  ].join('\n');
  return { id, role: ROLE_TAG_REVIEW, prompt, parse: (text) => parseTagReviews(text, scene, proposals), retryPrompt: retryWith(prompt) };
}

/** Exactly one verdict per review item (T1…), in item order; unknown, repeated or missing ids are errors. */
export function parseTagReviews(text: string, scene: string, proposals: readonly TagProposal[]): Result<TagReview[]> {
  const obj = parseFencedJson(text);
  if (!obj.ok) return obj;
  const list = obj.value['reviews'];
  if (!Array.isArray(list)) return err('reviews: missing or not an array');
  const items = reviewItems(scene, proposals);
  const byId = new Map(items.map((t) => [t.id, t]));
  const got = new Map<string, TagReview>();
  for (const [i, entry] of list.entries()) {
    const at = `reviews[${i}]`;
    if (!isRecord(entry)) return err(`${at}: expected an object`);
    const id = entry['id'];
    const item = typeof id === 'string' ? byId.get(id.trim()) : undefined;
    if (item === undefined) return err(`${at}.id: unknown item id`);
    if (got.has(item.id)) return err(`${at}.id: ${item.id} reviewed twice`);
    const verdict = entry['verdict'];
    if (typeof verdict !== 'string' || !isOneOf(verdict, VERDICTS)) return err(`${at}.verdict: expected keep or dispute`);
    const reason = readCapped(entry, 'reason', TAG_REASON_MAX);
    if (!reason.ok) return err(`${at}.${reason.error}`);
    got.set(item.id, { row_id: item.row_id, layer: item.layer, quote: item.quote, verdict, reason: reason.value });
  }
  const missing = items.filter((t) => !got.has(t.id)).map((t) => t.id);
  if (missing.length > 0) return err(`reviews: no verdict for ${missing.join(', ')}`);
  return ok(items.map((t) => got.get(t.id)).filter((r): r is TagReview => r !== undefined));
}

/** The cell record of (row, layer), created `{quotes: [], dangling: []}` when absent (checkTags already passed). */
function cellOf(cells: JsonRecord, rowId: string, layer: Layer): { quotes: unknown[] } {
  const row = Object.hasOwn(cells, rowId) && isRecord(cells[rowId]) ? cells[rowId] : {};
  cells[rowId] = row;
  const cell = Object.hasOwn(row, layer) && isRecord(row[layer]) ? row[layer] : { quotes: [], dangling: [] };
  row[layer] = cell;
  const quotes = Array.isArray(cell['quotes']) ? cell['quotes'] : [];
  cell['quotes'] = quotes;
  return { quotes };
}

/**
 * map/tags.json after adding `kept` quotes as `{file, quote}` (file = the 09 reference key, e.g.
 * `reference/09-scenes-and-people.md`); deduped, result passes thinmap.ts checkTags(rowIds). err = input tags invalid.
 * `null` / `undefined` (no file yet) starts from `{cells: {}}`; the input is never mutated.
 */
export function applyTags(tags: unknown, kept: readonly KeptTag[], file: string, rowIds: readonly string[]): Result<JsonRecord> {
  const base: unknown = tags === null || tags === undefined ? { cells: {} } : tags;
  const problems = checkTags(base, rowIds);
  if (problems.length > 0) return err(`map/tags.json: ${problems.join('; ')}`);
  const copy: unknown = JSON.parse(JSON.stringify(base));
  if (!isRecord(copy) || !isRecord(copy['cells'])) return err('map/tags.json: expected { "cells": { … } }');
  const cells = copy['cells'];
  for (const k of kept) {
    if (!rowIds.includes(k.row_id)) return err(`kept tag: unknown row ${k.row_id}`);
    const cell = cellOf(cells, k.row_id, k.layer);
    const present = cell.quotes.some((q) => isRecord(q) && q['file'] === file && q['quote'] === k.quote);
    if (!present) cell.quotes.push({ file, quote: k.quote });
  }
  const after = checkTags(copy, rowIds);
  return after.length === 0 ? ok(copy) : err(`map/tags.json after tagging: ${after.join('; ')}`);
}
