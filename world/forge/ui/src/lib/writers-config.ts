import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { familyOf, loadConfig, type ForgeConfig } from '../../../engine/config.ts';
import { isRecord, readArray, readString } from '../../../engine/json.ts';
import { err, type Result } from '../../../engine/result.ts';
import { readStatus } from '../../../engine/runner.ts';
import { writeText } from '../../../engine/store.ts';
import { redactRoot } from './data.ts';
import type { OwnerResult } from './owner.ts';

/** Model ids the 配置 page accepts (gateway ids like `deepseek/deepseek-v4.1-flash`). */
const MODEL_ID = /^[\w./:@-]{1,120}$/u;

/**
 * Why writers.json cannot change now: a round with freeze.json whose status.json is not `done` (an unreadable status
 * counts as unfinished) pinned its SHA-256; else null.
 */
export function writersLock(root: string): string | null {
  const dir = join(root, 'rounds');
  if (!existsSync(dir)) return null;
  for (const round of readdirSync(dir).filter((n) => /^[A-Z]\d{2}$/u.test(n)).sort()) {
    if (!existsSync(join(dir, round, 'freeze.json'))) continue;
    const status = readStatus(root, round);
    if (!status.ok || status.value.state !== 'done') return `轮次 ${round} 已冻结但尚未完成，它钉住了 writers.json；等这一轮结束后再改写手模型。`;
  }
  return null;
}

/**
 * loadConfig over the exact candidate writers.json bytes, next to copies of judges.json and families.json in a
 * throwaway directory (loadConfig reads only from disk; the forge root is not touched before the candidate passes).
 */
function checkCandidate(root: string, text: string): Result<ForgeConfig> {
  const dir = mkdtempSync(join(tmpdir(), 'forge-writers-check-'));
  try {
    for (const name of ['judges.json', 'families.json']) copyFileSync(join(root, name), join(dir, name));
    writeFileSync(join(dir, 'writers.json'), text);
    const cfg = loadConfig(dir, { requireLocal: false });
    return cfg.ok ? cfg : err(cfg.error.split(dir).join('<forge>'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Sets the model of writer slots in writers.json (`models`: slot id → model id; only existing slot ids W1…; baseline,
 * timeout_ms, max_tokens, temperature kept byte-for-byte in value). The candidate is validated before anything is
 * written (loadConfig over its bytes, and every changed model needs a families.json prefix: the engine's backends
 * refuse a writer without a family), then written once atomically (store.writeText: temp file + rename). 409 while a
 * round between freeze and done pins writers.json; 400 on an unknown slot, a model id outside /^[\w./:@-]{1,120}$/u
 * or a model without a family. Not an owner-only file and not owner-logged.
 */
export function writeWritersConfig(root: string, models: Record<string, string>): OwnerResult {
  const file = join(root, 'writers.json');
  if (!existsSync(file)) return { ok: false, status: 404, error: '没有 writers.json。' };
  const entries = Object.entries(models);
  if (entries.length === 0) return { ok: false, status: 400, error: '没有提交任何写手槽位。' };
  for (const [slot, model] of entries) {
    if (!MODEL_ID.test(model)) return { ok: false, status: 400, error: `槽位 ${slot} 的模型编号无效（只允许字母、数字和 ./:@-，最长 120 字符）。` };
  }
  const lock = writersLock(root);
  if (lock !== null) return { ok: false, status: 409, error: lock };
  const current = loadConfig(root, { requireLocal: false });
  if (!current.ok) return { ok: false, status: 400, error: `配置读不通，先修好再改：${redactRoot(current.error, root)}` };
  const original = readFileSync(file, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(original);
  } catch {
    return { ok: false, status: 400, error: 'writers.json 不是合法 JSON。' };
  }
  const slots = readArray(raw, 'slots');
  if (!isRecord(raw) || slots === null) return { ok: false, status: 400, error: 'writers.json 缺少 slots[]。' };
  const ids = slots.map((s) => readString(s, 'id'));
  for (const [slot] of entries) {
    if (!ids.includes(slot)) return { ok: false, status: 400, error: `没有写手槽位 ${slot}（基线模型不在这里改）。` };
  }
  const changed: string[] = [];
  const nextSlots = slots.map((s) => {
    const id = readString(s, 'id');
    const model = id === null ? undefined : models[id];
    if (id === null || !isRecord(s) || model === undefined || s['model'] === model) return s;
    changed.push(id);
    return { ...s, model };
  });
  if (changed.length === 0) return { ok: true, file };
  const text = `${JSON.stringify({ ...raw, slots: nextSlots }, null, 2)}\n`;
  const check = checkCandidate(root, text);
  if (!check.ok) return { ok: false, status: 400, error: `新配置校验失败，没有写入：${redactRoot(check.error, root)}` };
  // only the models this submission changes: a hand-edited slot without a family keeps its config-page warning
  const orphans = check.value.slots.filter((s) => changed.includes(s.id) && familyOf(s.model, check.value.prefixes) === null);
  if (orphans.length > 0) {
    const which = orphans.map((s) => `槽位 ${s.id} 的 ${s.model}`).join('、');
    return { ok: false, status: 400, error: `${which} 在 families.json 里没有匹配的前缀：引擎不知道它属于哪个家族，开轮时会失败。先在 families.json 加上前缀再改。` };
  }
  writeText(file, text);
  return { ok: true, file };
}
