import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isFamily, type Family } from './config.ts';
import type { RoundFiles } from './context.ts';
import { isRecord, readArray, readString, type JsonRecord } from './json.ts';
import { err, ok, type Result } from './result.ts';
import { sha256 } from './store.ts';

export type ChampionKind = 'baseline' | 'owner_pick' | 'golden';

export interface ChampionRef {
  kind: ChampionKind;
  round: string;
  submission: string;
  family: Family;
  text_sha256: string;
}

/** One row of `champions.json` (keyed by row_id). */
export interface Champion {
  row_id: string;
  kind: ChampionKind;
  /** Round that set it. */
  round: string;
  /** Slot id in that round (BASE for baselines). */
  submission: string;
  family: Family;
  /** Families counted as authors for judge exclusion (baseline: the baseline writer's family only). */
  authors: Family[];
  /** Display text judged in champion pairs. */
  text: string;
  text_sha256: string;
  set_at: string;
  /** Earlier champions of the row, newest first (anchors = the previous two owner picks). */
  previous: ChampionRef[];
}

/** Forge-root-relative path of the champion table (a shared file: external in markers). */
export const CHAMPIONS_FILE = 'champions.json';

const KINDS: readonly ChampionKind[] = ['baseline', 'owner_pick', 'golden'];
const ROUND_ID = /^[A-Z]\d{2}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function kindOf(value: unknown): ChampionKind | null {
  return KINDS.find((k) => k === value) ?? null;
}

function familyOf(value: unknown): Family | null {
  return typeof value === 'string' && isFamily(value) ? value : null;
}

function parseRef(value: unknown, where: string): Result<ChampionRef> {
  const kind = kindOf(isRecord(value) ? value['kind'] : null);
  const round = readString(value, 'round');
  const submission = readString(value, 'submission');
  const family = familyOf(isRecord(value) ? value['family'] : null);
  const hash = readString(value, 'text_sha256');
  if (kind === null || round === null || !ROUND_ID.test(round) || submission === null || submission === '' || family === null) {
    return err(`${where}: kind, round, submission and family are required`);
  }
  if (hash === null || !HEX64.test(hash)) return err(`${where}.text_sha256: expected a lowercase SHA-256 hex digest`);
  return ok({ kind, round, submission, family, text_sha256: hash });
}

/** One `champions.json` entry; `text_sha256` must be the SHA-256 of `text`. */
export function parseChampion(value: unknown, rowId: string): Result<Champion> {
  const where = `champions.json.${rowId}`;
  if (!isRecord(value)) return err(`${where}: expected an object`);
  const ref = parseRef(value, where);
  if (!ref.ok) return err(ref.error);
  const row = readString(value, 'row_id');
  const text = readString(value, 'text');
  const setAt = readString(value, 'set_at');
  const authorList = readArray(value, 'authors');
  const previousList = readArray(value, 'previous');
  if (row !== rowId) return err(`${where}.row_id: must equal its key`);
  if (text === null || text.trim() === '') return err(`${where}.text: expected a non-empty string`);
  if (sha256(text) !== ref.value.text_sha256) return err(`${where}.text_sha256: does not match the text`);
  if (setAt === null || setAt === '') return err(`${where}.set_at: expected a timestamp`);
  if (authorList === null) return err(`${where}.authors: expected a family array`);
  const authors: Family[] = [];
  for (const a of authorList) {
    const f = familyOf(a);
    if (f === null) return err(`${where}.authors: unknown family`);
    authors.push(f);
  }
  if (authors.length === 0) return err(`${where}.authors: at least one author family`);
  if (previousList === null) return err(`${where}.previous: expected an array`);
  const previous: ChampionRef[] = [];
  for (const [i, p] of previousList.entries()) {
    const parsed = parseRef(p, `${where}.previous[${i}]`);
    if (!parsed.ok) return err(parsed.error);
    previous.push(parsed.value);
  }
  return ok({ row_id: rowId, ...ref.value, authors, text, set_at: setAt, previous });
}

/** Missing file → ok({}). */
export function readChampions(root: string): Result<Record<string, Champion>> {
  const path = join(root, CHAMPIONS_FILE);
  if (!existsSync(path)) return ok({});
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return err('champions.json: not valid JSON');
  }
  if (!isRecord(raw)) return err('champions.json: expected an object keyed by row_id');
  const out: Record<string, Champion> = {};
  for (const rowId of Object.keys(raw).sort(byCodeUnit)) {
    const parsed = parseChampion(raw[rowId], rowId);
    if (!parsed.ok) return err(parsed.error);
    out[rowId] = parsed.value;
  }
  return ok(out);
}

function refOf(c: Champion): ChampionRef {
  return { kind: c.kind, round: c.round, submission: c.submission, family: c.family, text_sha256: c.text_sha256 };
}

/** Same round, slot, kind, family, row and text (set_at and previous may differ on a rerun). */
function sameChampion(a: Champion, b: Champion): boolean {
  return a.row_id === b.row_id && a.kind === b.kind && a.round === b.round && a.submission === b.submission && a.family === b.family && a.text_sha256 === b.text_sha256;
}

/** Validates a champion the engine is about to write (the reader's rules, via its JSON form). */
function checked(champion: Champion): Result<Champion> {
  const copy: unknown = JSON.parse(JSON.stringify(champion));
  return parseChampion(copy, champion.row_id);
}

function writeTable(files: RoundFiles, table: Readonly<Record<string, Champion>>): void {
  const out: JsonRecord = {};
  for (const rowId of Object.keys(table).sort(byCodeUnit)) out[rowId] = table[rowId];
  files.writeJson(join(files.root, CHAMPIONS_FILE), out);
}

/** 02b: sets the row's baseline champion; 'present' when the identical entry exists (rerun); err when another champion exists. */
export function setBaselineChampion(files: RoundFiles, champion: Champion): Result<'set' | 'present'> {
  if (champion.kind !== 'baseline') return err(`setBaselineChampion: kind must be baseline, got ${champion.kind}`);
  if (champion.previous.length > 0) return err('setBaselineChampion: a baseline has no previous champions');
  const valid = checked(champion);
  if (!valid.ok) return err(valid.error);
  const table = readChampions(files.root);
  if (!table.ok) return err(table.error);
  const current = Object.hasOwn(table.value, champion.row_id) ? table.value[champion.row_id] : undefined;
  if (current !== undefined) {
    return sameChampion(current, valid.value) ? ok('present') : err(`champions.json: row ${champion.row_id} already has a ${current.kind} champion from ${current.round}`);
  }
  writeTable(files, { ...table.value, [champion.row_id]: valid.value });
  return ok('set');
}

/**
 * 11c: replaces the row's champion with an owner pick, pushing the old one onto `previous` (newest first; the
 * given `previous` is ignored); idempotent ('present' when this pick is already the champion).
 */
export function setOwnerPickChampion(files: RoundFiles, champion: Champion): Result<'set' | 'present'> {
  if (champion.kind !== 'owner_pick') return err(`setOwnerPickChampion: kind must be owner_pick, got ${champion.kind}`);
  const table = readChampions(files.root);
  if (!table.ok) return err(table.error);
  const current = Object.hasOwn(table.value, champion.row_id) ? table.value[champion.row_id] : undefined;
  if (current !== undefined && sameChampion(current, champion)) return ok('present');
  const previous = current === undefined ? [] : [refOf(current), ...current.previous];
  const valid = checked({ ...champion, previous });
  if (!valid.ok) return err(valid.error);
  writeTable(files, { ...table.value, [champion.row_id]: valid.value });
  return ok('set');
}
