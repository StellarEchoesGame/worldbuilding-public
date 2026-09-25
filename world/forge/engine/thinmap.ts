import { isRecord, readArray, readRecord, readString, stringArray, type JsonRecord } from './json.ts';
import { err, ok, type Result } from './result.ts';

export type RowKind = 'area' | 'ship' | 'civilization';
export type AliasKind = RowKind | 'character';
export type Layer = 'mechanism' | 'sensory_scene' | 'character_want' | 'object' | 'quest_hook' | 'paintable_shot' | 'play_interface';
export type CellValue = 0 | 1 | 2 | 3;

export const LAYERS: readonly Layer[] = ['mechanism', 'sensory_scene', 'character_want', 'object', 'quest_hook', 'paintable_shot', 'play_interface'];

export const LAYER_LABELS: Record<Layer, string> = {
  mechanism: '机制',
  sensory_scene: '感官场景',
  character_want: '人物愿望',
  object: '物件',
  quest_hook: '任务钩子',
  paintable_shot: '可画镜头',
  play_interface: '玩法接口',
};

export const DEFAULT_GAME_NEED: Record<string, number> = {
  SHIP: 2,
  'S0-外围接应区': 2,
  'S1-冷湾': 2,
  'S1-赤脊': 2,
  'S1-帘影': 2,
};

export interface Row {
  row_id: string;
  kind: RowKind;
  primary: string;
  system: string;
  aliases: string[];
}

export interface Quote {
  file: string;
  quote: string;
}

export interface Alias {
  row_id: string;
  kind: AliasKind;
  primary: string;
  aliases: string[];
  first_quote: Quote;
}

/** A 07 §8 registered fact. */
export interface RegisteredFact {
  rxx: string;
  rowId: string;
  extends: string;
}

export interface Cell {
  rowId: string;
  layer: Layer;
  live: number;
  dropped: Quote[];
  dangling: string[];
  value: CellValue;
  priority: number;
}

export interface ThinmapInput {
  rows: Row[];
  aliases: Alias[];
  tags: unknown;
  canon: Record<string, string>;
  registered: RegisteredFact[];
  factRows: Record<string, string[]>;
  gameNeed: Record<string, number>;
  mentions: Record<string, number>;
}

export interface ThinmapResult {
  rows: string[];
  cells: Cell[];
  connectivity: Record<string, number>;
  ranking: Cell[];
}

const CHARACTER_ID = /^P-.+$/u;
const R_ID = /^R\d{2}-\d{2}$/u;
const F_ID = /^F\d{2}$/u;
const ALL_ROWS = 'ALL';

function isLayer(v: string): v is Layer {
  return LAYERS.some((l) => l === v);
}

function isRowKind(v: string): v is RowKind {
  return v === 'area' || v === 'ship' || v === 'civilization';
}

function isAliasKind(v: string): v is AliasKind {
  return isRowKind(v) || v === 'character';
}

/** Own-property lookup, so ids such as "constructor" never hit Object.prototype. */
function lookup<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function ownRecord(value: JsonRecord | null, key: string): JsonRecord | null {
  return value !== null && Object.hasOwn(value, key) ? readRecord(value, key) : null;
}

export function cellValue(liveQuotes: number, dangling: number): CellValue {
  if (liveQuotes >= 4) return dangling === 0 ? 3 : 2;
  if (liveQuotes >= 2) return 2;
  if (liveQuotes >= 1) return 1;
  return 0;
}

export function parseRows(value: unknown): Result<Row[]> {
  const list = readArray(value, 'rows');
  if (list === null) return err('rows: expected { "rows": [...] }');
  const out: Row[] = [];
  const seen = new Set<string>();
  for (const [i, item] of list.entries()) {
    const rowId = readString(item, 'row_id');
    const kind = readString(item, 'kind');
    const primary = readString(item, 'primary');
    const system = readString(item, 'system');
    const aliases = stringArray(isRecord(item) ? item['aliases'] : null);
    if (rowId === null || rowId === '' || kind === null || !isRowKind(kind) || primary === null || primary === '' || system === null || aliases === null) {
      return err(`rows[${i}]: needs row_id, kind (area|ship|civilization), primary, system and aliases[]`);
    }
    if (seen.has(rowId)) return err(`rows[${i}]: duplicate row_id ${rowId}`);
    seen.add(rowId);
    out.push({ row_id: rowId, kind, primary, system, aliases });
  }
  return ok(out);
}

export function parseAliases(value: unknown): Result<Alias[]> {
  const list = readArray(value, 'entries');
  if (list === null) return err('aliases: expected { "entries": [...] }');
  const out: Alias[] = [];
  const seen = new Set<string>();
  for (const [i, item] of list.entries()) {
    const rowId = readString(item, 'row_id');
    const kind = readString(item, 'kind');
    const primary = readString(item, 'primary');
    const aliases = stringArray(isRecord(item) ? item['aliases'] : null);
    const first = readRecord(item, 'first_quote');
    const file = readString(first, 'file');
    const quote = readString(first, 'quote');
    if (rowId === null || rowId === '' || kind === null || !isAliasKind(kind) || primary === null || primary === '' || aliases === null || file === null || quote === null) {
      return err(`entries[${i}]: needs row_id, kind, primary, aliases[] and first_quote { file, quote }`);
    }
    // A P- id with another kind, or a character without one, would silently add or lose a row.
    if ((kind === 'character') !== CHARACTER_ID.test(rowId)) return err(`entries[${i}]: kind character and a P- row_id go together (${rowId}, ${kind})`);
    if (seen.has(rowId)) return err(`entries[${i}]: duplicate row_id ${rowId}`);
    seen.add(rowId);
    out.push({ row_id: rowId, kind, primary, aliases, first_quote: { file, quote } });
  }
  return ok(out);
}

export function parseGameNeed(value: unknown): Result<Record<string, number>> {
  const weights = readRecord(value, 'weights');
  if (weights === null) return err('game-need: expected { "weights": { row_id: number } }');
  const out: Record<string, number> = {};
  for (const [rowId, w] of Object.entries(weights)) {
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) return err(`game-need: weight of ${rowId} must be a non-negative number`);
    out[rowId] = w;
  }
  return ok(out);
}

/** Strict shape check for tags.json below `cells`, which the schema subset cannot express. */
export function checkTags(value: unknown, rowIds: readonly string[]): string[] {
  const cells = readRecord(value, 'cells');
  if (cells === null) return ['tags: expected { "cells": { row_id: { layer: cell } } }'];
  const errors: string[] = [];
  for (const [rowId, layers] of Object.entries(cells)) {
    const at = `cells.${rowId}`;
    if (!rowIds.includes(rowId)) {
      errors.push(`${at}: unknown row`);
      continue;
    }
    if (!isRecord(layers)) {
      errors.push(`${at}: must be an object`);
      continue;
    }
    for (const [layer, cell] of Object.entries(layers)) {
      const where = `${at}.${layer}`;
      if (!isLayer(layer)) {
        errors.push(`${where}: unknown layer`);
        continue;
      }
      if (!isRecord(cell)) {
        errors.push(`${where}: must be an object`);
        continue;
      }
      const quotes = readArray(cell, 'quotes');
      if (quotes === null) errors.push(`${where}.quotes: must be an array`);
      else {
        for (const [i, q] of quotes.entries()) {
          const file = readString(q, 'file');
          const quote = readString(q, 'quote');
          if (file === null || file === '' || quote === null || quote === '') errors.push(`${where}.quotes[${i}]: needs non-empty file and quote`);
        }
      }
      if (stringArray(cell['dangling']) === null) errors.push(`${where}.dangling: must be a string array`);
    }
  }
  return errors;
}

/** Lenient read of one cell: malformed entries are skipped (checkTags reports them) and exact duplicates count once. */
function readCell(cells: JsonRecord | null, rowId: string, layer: Layer): { quotes: Quote[]; dangling: string[] } {
  const cell = ownRecord(ownRecord(cells, rowId), layer);
  const quotes: Quote[] = [];
  const seen = new Set<string>();
  for (const item of readArray(cell, 'quotes') ?? []) {
    const file = readString(item, 'file');
    const quote = readString(item, 'quote');
    if (file === null || quote === null) continue;
    const key = `${file}\u0000${quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    quotes.push({ file, quote });
  }
  const dangling = (readArray(cell, 'dangling') ?? []).filter((d): d is string => typeof d === 'string');
  return { quotes, dangling };
}

function isLive(q: Quote, canon: Record<string, string>): boolean {
  const text = lookup(canon, q.file);
  // An empty quote is a substring of every file; it proves nothing, so it is dropped.
  return typeof text === 'string' && q.quote !== '' && text.includes(q.quote);
}

interface NameHit {
  start: number;
  end: number;
  size: number;
  name: string;
}

/** Name to the rows that carry it (several rows may share one spelling). */
function nameOwners(names: ReadonlyMap<string, readonly string[]>): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const [rowId, list] of names) {
    for (const name of list) {
      const rowIds = owners.get(name) ?? [];
      if (!rowIds.includes(rowId)) rowIds.push(rowId);
      owners.set(name, rowIds);
    }
  }
  return owners;
}

/**
 * Rows named in a sentence, by longest match: occurrences of all names are taken longest first (then leftmost),
 * an occurrence overlapping an already-taken span is skipped, and a row is credited only through taken occurrences.
 * So 回纹地方共同体 credits its own row and masks the 回纹 inside it.
 */
function rowsNamedIn(sentence: string, owners: ReadonlyMap<string, readonly string[]>): Set<string> {
  const hits: NameHit[] = [];
  for (const name of owners.keys()) {
    const size = [...name].length;
    for (let at = sentence.indexOf(name); at !== -1; at = sentence.indexOf(name, at + 1)) hits.push({ start: at, end: at + name.length, size, name });
  }
  hits.sort((a, b) => b.size - a.size || a.start - b.start);
  const taken: NameHit[] = [];
  const credited = new Set<string>();
  for (const hit of hits) {
    if (taken.some((t) => hit.start < t.end && t.start < hit.end)) continue;
    taken.push(hit);
    for (const rowId of owners.get(hit.name) ?? []) credited.add(rowId);
  }
  return credited;
}

export function computeThinmap(input: ThinmapInput): ThinmapResult {
  const rows: string[] = [];
  const names = new Map<string, string[]>();
  const addNames = (rowId: string, list: readonly string[]): void => {
    names.set(rowId, [...(names.get(rowId) ?? []), ...list.filter((n) => n !== '')]);
  };
  for (const r of input.rows) {
    if (rows.includes(r.row_id)) continue;
    rows.push(r.row_id);
    addNames(r.row_id, [r.primary, ...r.aliases]);
  }
  for (const a of input.aliases) {
    if (a.kind === 'character' && !rows.includes(a.row_id)) rows.push(a.row_id);
  }
  for (const a of input.aliases) {
    if (rows.includes(a.row_id)) addNames(a.row_id, [a.primary, ...a.aliases]);
  }

  const tagCells = readRecord(input.tags, 'cells');
  const cells: Cell[] = [];
  const liveQuotes = new Map<string, string[]>();
  for (const rowId of rows) {
    const rowLive: string[] = [];
    for (const layer of LAYERS) {
      const { quotes, dangling } = readCell(tagCells, rowId, layer);
      const live = quotes.filter((q) => isLive(q, input.canon));
      const dropped = quotes.filter((q) => !isLive(q, input.canon));
      rowLive.push(...live.map((q) => q.quote));
      const value = cellValue(live.length, dangling.length);
      const priority = (lookup(input.gameNeed, rowId) ?? 1) * (3 - value) * (1 + (lookup(input.mentions, rowId) ?? 0));
      cells.push({ rowId, layer, live: live.length, dropped, dangling, value, priority });
    }
    liveQuotes.set(rowId, rowLive);
  }

  const owners = nameOwners(names);
  const resolve = (ext: string): string[] => {
    // An empty extends would match every live quote.
    if (ext === '') return [];
    if (R_ID.test(ext)) return input.registered.filter((f) => f.rxx === ext).map((f) => f.rowId);
    if (F_ID.test(ext)) {
      const listed = lookup(input.factRows, ext) ?? [];
      return listed.includes(ALL_ROWS) ? rows : listed;
    }
    const named = rowsNamedIn(ext, owners);
    return rows.filter((id) => named.has(id) || (liveQuotes.get(id) ?? []).some((q) => q.includes(ext)));
  };

  const connectivity: Record<string, number> = {};
  for (const id of rows) connectivity[id] = 0;
  for (const fact of input.registered) {
    for (const target of new Set(resolve(fact.extends.trim()))) {
      const current = lookup(connectivity, target);
      if (target !== fact.rowId && current !== undefined) connectivity[target] = current + 1;
    }
  }

  const rowIndex = new Map(rows.map((id, i) => [id, i]));
  const ranking = [...cells].sort(
    (a, b) => b.priority - a.priority || (rowIndex.get(a.rowId) ?? 0) - (rowIndex.get(b.rowId) ?? 0) || LAYERS.indexOf(a.layer) - LAYERS.indexOf(b.layer),
  );
  return { rows, cells, connectivity, ranking };
}

export function formatThinmap(r: ThinmapResult, top: number): string {
  const lines = [`rows=${r.rows.length}`];
  for (const c of r.ranking.slice(0, Math.max(0, top))) lines.push(`${c.rowId} ${c.layer} ${c.value} ${c.priority}`);
  return lines.join('\n');
}
