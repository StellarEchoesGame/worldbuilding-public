import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSchema, validate } from '../../../engine/schema.ts';
import { loadRows } from '../../../engine/steps/brief.ts';
import { createExclusive } from '../../../engine/store.ts';
import { parseGameNeed } from '../../../engine/thinmap.ts';
import { codeRoot } from './data.ts';
import type { OwnerResult } from './owner.ts';

export const GAME_NEED_FILE = 'map/game-need.json';

/** schema/game-need.schema.json of the code (not the data root: fixture roots need no schema dir). */
function schemaErrors(value: unknown): string[] {
  const schema = loadSchema(JSON.parse(readFileSync(join(codeRoot(), 'schema', 'game-need.schema.json'), 'utf8')));
  if (!schema.ok) return [`schema/game-need.schema.json: ${schema.error}`];
  return validate(schema.value, value);
}

/**
 * One-time write of map/game-need.json `{weights}`: every key a map/rows.json row_id, every value a finite number ≥ 0
 * (parseGameNeed) and the value schema-valid (schema/game-need.schema.json); created exclusively (createExclusive),
 * 409 when the file exists. Not an owner-only file and not owner-logged.
 */
export function writeGameNeed(root: string, weights: Record<string, number>): OwnerResult {
  const file = join(root, GAME_NEED_FILE);
  if (existsSync(file)) return { ok: false, status: 409, error: '游戏需求权重已经设定过，不能修改。' };
  const rows = loadRows(root);
  if (!rows.ok) return { ok: false, status: 409, error: `行表无法读取：${rows.error}` };
  const rowIds = new Set(rows.value.map((r) => r.row_id));
  const keys = Object.keys(weights);
  if (keys.length === 0) return { ok: false, status: 400, error: '没有任何权重。' };
  const unknown = keys.filter((k) => !rowIds.has(k));
  if (unknown.length > 0) return { ok: false, status: 400, error: `不在行表中：${unknown.join('、')}` };
  const value = { weights: Object.fromEntries(keys.map((k) => [k, weights[k]])) };
  const parsed = parseGameNeed(value);
  if (!parsed.ok) return { ok: false, status: 400, error: `权重不对：${parsed.error}` };
  const errors = schemaErrors(value);
  if (errors.length > 0) return { ok: false, status: 400, error: `不符合 schema：${errors.join('；')}` };
  if (!createExclusive(file, `${JSON.stringify(value, null, 2)}\n`)) return { ok: false, status: 409, error: '游戏需求权重已经设定过，不能修改。' };
  return { ok: true, file };
}
