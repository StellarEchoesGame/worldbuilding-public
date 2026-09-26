import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCalibPairs, SET_ID, type CalibSetRecord, type SetKind } from '../../../../engine/calib-build.ts';
import { PIN_FILE } from '../../../../engine/calib-run.ts';
import { isRecord, readArray, readNumber, readRecord, readString } from '../../../../engine/json.ts';
import { OWNER_ANSWERS, calibSet } from '../../../../engine/owner-inputs.ts';
import { readJson } from '../../../../engine/store.ts';

/** One owner-answerable set of calibration/pairs.json (kind round0 | requal; gate sets are never listed). */
export interface CalibSetSummary {
  set: string;
  kind: SetKind;
  total: number;
  answered: number;
  complete: boolean;
  /** calibration/<set>/pin.json exists (c4 has pinned the answers; the page is then read-only). */
  pinned: boolean;
}

/** One blind slot: the two texts only (no text ids, pair ids, roles, models or families). */
export interface CalibSlotView {
  slot: number;
  /** 1-based position in display order and the set size (progress). */
  position: number;
  total: number;
  leftText: string;
  rightText: string;
}

export interface CalibPageView {
  set: string;
  kind: SetKind;
  total: number;
  answered: number;
  /** Lowest display slot with no answer in calibration/owner-answers.json sets[set]; null when complete. */
  next: CalibSlotView | null;
  /** owner-answers pairs_sha256 differs from calibSet(...).pairsSha256 (submitCalibAnswers would refuse). */
  stale: boolean;
  error: string | null;
}

/** Raw `calibration/owner-answers.json` `sets[set]`: answered slots and pairs_sha256 (null file → no answers). */
interface RawAnswers {
  slots: Set<number>;
  pairsSha256: string | null;
  error: string | null;
}

function rawAnswers(root: string, set: string): RawAnswers {
  const file = join(root, OWNER_ANSWERS);
  if (!existsSync(file)) return { slots: new Set(), pairsSha256: null, error: null };
  const value = readJson(file);
  if (!isRecord(value)) return { slots: new Set(), pairsSha256: null, error: '校准答案文件无法读取。' };
  const entry = readRecord(readRecord(value, 'sets'), set);
  const slots = new Set<number>();
  for (const a of readArray(entry, 'answers') ?? []) {
    const slot = readNumber(a, 'slot');
    if (slot !== null) slots.add(slot);
  }
  return { slots, pairsSha256: readString(entry, 'pairs_sha256'), error: null };
}

/** Display slots in slot order (calibSet), or the reason they cannot be read. */
function displaySlots(root: string, set: string): { slots: number[]; pairsSha256: string } | { error: string } {
  const pairs = calibSet(root, set);
  if (!pairs.ok) return { error: pairs.error };
  return { slots: [...pairs.value.display.keys()].sort((a, b) => a - b), pairsSha256: pairs.value.pairsSha256 };
}

function pinned(root: string, set: string): boolean {
  return existsSync(join(root, 'calibration', set, PIN_FILE));
}

function answerable(record: CalibSetRecord): boolean {
  return record.kind === 'round0' || record.kind === 'requal';
}

export function calibSets(root: string): CalibSetSummary[] {
  const file = readCalibPairs(root);
  if (!file.ok) return [];
  const out: CalibSetSummary[] = [];
  for (const [set, record] of Object.entries(file.value.sets).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!answerable(record)) continue;
    const display = displaySlots(root, set);
    const slots = 'error' in display ? [] : display.slots;
    const answered = rawAnswers(root, set).slots;
    const count = slots.filter((s) => answered.has(s)).length;
    out.push({ set, kind: record.kind, total: slots.length, answered: count, complete: slots.length > 0 && count === slots.length, pinned: pinned(root, set) });
  }
  return out;
}

/** `calibration/<texts[id].path>` (calibration-relative, as c1-build writes it); null when missing or unreadable (e.g. a directory). */
function textOf(root: string, record: CalibSetRecord, id: string): string | null {
  const t = record.texts[id];
  if (t === undefined) return null;
  const file = join(root, 'calibration', t.path);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** null when the set does not exist, is a gate set, or its id fails SET_ID. */
export function calibView(root: string, set: string): CalibPageView | null {
  if (!SET_ID.test(set)) return null;
  const file = readCalibPairs(root);
  if (!file.ok) return null;
  const record = file.value.sets[set];
  if (record === undefined || !answerable(record)) return null;
  const base = { set, kind: record.kind };
  const display = displaySlots(root, set);
  if ('error' in display) return { ...base, total: 0, answered: 0, next: null, stale: false, error: display.error };
  const raw = rawAnswers(root, set);
  const total = display.slots.length;
  const answered = display.slots.filter((s) => raw.slots.has(s)).length;
  const stale = raw.pairsSha256 !== null && raw.pairsSha256 !== display.pairsSha256;
  const view = { ...base, total, answered, stale };
  if (raw.error !== null) return { ...view, next: null, error: raw.error };
  const index = display.slots.findIndex((s) => !raw.slots.has(s));
  const slot = display.slots[index];
  if (slot === undefined) return { ...view, next: null, error: null };
  const item = record.display.find((d) => d.slot === slot);
  const leftText = item === undefined ? null : textOf(root, record, item.left);
  const rightText = item === undefined ? null : textOf(root, record, item.right);
  if (leftText === null || rightText === null) return { ...view, next: null, error: `第 ${slot} 题的校准文本缺失或无法读取，无法显示。` };
  return { ...view, next: { slot, position: index + 1, total, leftText, rightText }, error: null };
}
