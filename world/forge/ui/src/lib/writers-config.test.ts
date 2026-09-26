import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../../engine/config.ts';
import { isRecord, readArray, readString } from '../../../engine/json.ts';
import { writeWritersConfig } from './writers-config.ts';

const FORGE = join(import.meta.dirname, '..', '..', '..');

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-writers-'));
  for (const f of ['writers.json', 'judges.json', 'families.json']) copyFileSync(join(FORGE, f), join(root, f));
  return root;
}

function status(root: string, round: string, state: string): void {
  mkdirSync(join(root, 'rounds', round), { recursive: true });
  writeFileSync(join(root, 'rounds', round, 'status.json'), JSON.stringify({ round, state, step: null, waiting_for: null, detail: '', since: '2026-09-01T00:00:00.000Z', exit_code: null, done: [] }));
}

test('sets slot models atomically and keeps every other key and value', () => {
  const root = fixture();
  const before: unknown = JSON.parse(readFileSync(join(root, 'writers.json'), 'utf8'));
  const r = writeWritersConfig(root, { W2: 'qwen/qwen-4-max', W3: 'moonshot/kimi-k3' });
  assert.deepEqual(r, { ok: true, file: join(root, 'writers.json') });
  const cfg = loadConfig(root, { requireLocal: false });
  assert.ok(cfg.ok);
  assert.deepEqual(cfg.value.slots.map((s) => s.model), ['deepseek/deepseek-v4.1-flash', 'qwen/qwen-4-max', 'moonshot/kimi-k3']);
  const after: unknown = JSON.parse(readFileSync(join(root, 'writers.json'), 'utf8'));
  const strip = (v: unknown): string => JSON.stringify(v).replaceAll('qwen/qwen-4-max', 'deepseek/deepseek-v4.1-flash').replaceAll('moonshot/kimi-k3', 'deepseek/deepseek-v4.1-flash');
  assert.equal(strip(after), JSON.stringify(before));
  rmSync(root, { recursive: true });
});

test('an unchanged submission writes nothing', () => {
  const root = fixture();
  const bytes = readFileSync(join(root, 'writers.json'), 'utf8');
  assert.equal(writeWritersConfig(root, { W1: 'deepseek/deepseek-v4.1-flash' }).ok, true);
  assert.equal(readFileSync(join(root, 'writers.json'), 'utf8'), bytes);
  rmSync(root, { recursive: true });
});

test('unknown slots, the baseline, bad model ids and empty input → 400; nothing written', () => {
  const root = fixture();
  const bytes = readFileSync(join(root, 'writers.json'), 'utf8');
  for (const models of [{ W4: 'deepseek/x' }, { BASE: 'deepseek/x' }, { W1: '' }, { W1: 'a b' }, { W1: 'x'.repeat(121) }, { W1: 'deepseek/x', W2: '<script>' }, {}]) {
    const r = writeWritersConfig(root, models);
    assert.ok(!r.ok && r.status === 400, JSON.stringify(models));
  }
  assert.equal(readFileSync(join(root, 'writers.json'), 'utf8'), bytes);
  rmSync(root, { recursive: true });
});

test('409 while a frozen round is unfinished; allowed once it is done or before its freeze', () => {
  const root = fixture();
  status(root, 'R01', 'waiting');
  assert.equal(writeWritersConfig(root, { W1: 'deepseek/a' }).ok, true, 'not frozen yet');
  writeFileSync(join(root, 'rounds', 'R01', 'freeze.json'), '{}');
  const locked = writeWritersConfig(root, { W1: 'deepseek/b' });
  assert.ok(!locked.ok && locked.status === 409 && /R01/u.test(locked.error));
  mkdirSync(join(root, 'rounds', 'R02'), { recursive: true });
  status(root, 'R01', 'done');
  assert.equal(writeWritersConfig(root, { W1: 'deepseek/c' }).ok, true);
  writeFileSync(join(root, 'rounds', 'R02', 'freeze.json'), '{}');
  const noStatus = writeWritersConfig(root, { W1: 'deepseek/d' });
  assert.ok(!noStatus.ok && noStatus.status === 409 && /R02/u.test(noStatus.error), 'a frozen round without a readable status counts as unfinished');
  rmSync(root, { recursive: true });
});

test('404 when writers.json is missing; 400 when the config does not parse', () => {
  const root = fixture();
  writeFileSync(join(root, 'families.json'), '{"prefixes": 3}');
  const bad = writeWritersConfig(root, { W1: 'deepseek/a' });
  assert.ok(!bad.ok && bad.status === 400);
  rmSync(join(root, 'writers.json'));
  const missing = writeWritersConfig(root, { W1: 'deepseek/a' });
  assert.ok(!missing.ok && missing.status === 404);
  rmSync(root, { recursive: true });
});

test('config errors name files forge-relative: the absolute root never reaches the ?error= notice', () => {
  const root = fixture();
  rmSync(join(root, 'judges.json'));
  const r = writeWritersConfig(root, { W1: 'deepseek/a' });
  assert.ok(!r.ok && r.status === 400);
  assert.match(r.error, /judges\.json/u);
  assert.ok(!r.error.includes(root) && r.error.includes('<forge>'), r.error);
  rmSync(root, { recursive: true });
});

const checkDirs = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith('forge-writers-check-'));

test('a model families.json has no prefix for is refused before any write: writers.json keeps its bytes and mtime', () => {
  const root = fixture();
  const file = join(root, 'writers.json');
  const bytes = readFileSync(file, 'utf8');
  const listing = readdirSync(root).sort();
  const past = new Date('2026-01-01T00:00:00.000Z');
  utimesSync(file, past, past);
  const r = writeWritersConfig(root, { W1: 'mystery/model-x' });
  assert.ok(!r.ok && r.status === 400 && /W1/u.test(r.error) && /families\.json/u.test(r.error), r.ok ? 'written' : r.error);
  assert.ok(!r.error.includes(root) && !r.error.includes(tmpdir()), r.error);
  assert.equal(readFileSync(file, 'utf8'), bytes);
  assert.equal(statSync(file).mtimeMs, past.getTime(), 'not written and restored: never written');
  assert.deepEqual(readdirSync(root).sort(), listing);
  assert.deepEqual(checkDirs(), []);
  rmSync(root, { recursive: true });
});

test('a valid change is one atomic write of the validated candidate; no temp file or check directory is left', () => {
  const root = fixture();
  const file = join(root, 'writers.json');
  const listing = readdirSync(root).sort();
  const before: unknown = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(isRecord(before));
  assert.ok(writeWritersConfig(root, { W2: 'gpt-6' }).ok);
  const expected = { ...before, slots: (readArray(before, 'slots') ?? []).map((s) => (isRecord(s) && readString(s, 'id') === 'W2' ? { ...s, model: 'gpt-6' } : s)) };
  assert.equal(readFileSync(file, 'utf8'), `${JSON.stringify(expected, null, 2)}\n`);
  assert.deepEqual(readdirSync(root).sort(), listing);
  assert.deepEqual(checkDirs(), []);
  rmSync(root, { recursive: true });
});
