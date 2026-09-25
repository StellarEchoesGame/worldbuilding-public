import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { familyOf, loadConfig, type PrefixRule } from './config.ts';

const here = new URL('..', import.meta.url).pathname;

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-config-'));
  for (const f of ['judges.json', 'writers.json', 'families.json', 'prices.json']) cpSync(join(here, f), join(dir, f));
  return dir;
}

test('loads the committed configuration without local.json when not required', () => {
  const dir = tempRoot();
  const r = loadConfig(dir, { requireLocal: false });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.value.judges.map((j) => j.family), ['OpenAI', 'Anthropic', 'Moonshot', 'xAI']);
    assert.equal(r.value.slots.length, 3);
    assert.equal(r.value.local, null);
  }
  rmSync(dir, { recursive: true });
});

test('the merge editor is read from judges.json like the maintainer', () => {
  const dir = tempRoot();
  const r = loadConfig(dir, { requireLocal: false });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.mergeEditor.id, 'merge_editor');
    assert.equal(r.value.mergeEditor.family, 'Anthropic');
    assert.equal(r.value.mergeEditor.cli, 'claude');
  }
  rmSync(dir, { recursive: true });
});

test('a judges.json without merge_editor is rejected naming it', () => {
  const dir = tempRoot();
  const spec = { id: 'm', family: 'Anthropic', cli: 'claude', model: 'fable', effort: 'max', concurrency: 1, accepted_served: [] };
  writeFileSync(join(dir, 'judges.json'), JSON.stringify({ timeout_ms: 1, judges: [{ ...spec, id: 'claude', model: 'opus' }], maintainer: spec }));
  const r = loadConfig(dir, { requireLocal: false });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /merge_editor/u);
  rmSync(dir, { recursive: true });
});

test('missing file is reported by name', () => {
  const dir = tempRoot();
  rmSync(join(dir, 'writers.json'));
  const r = loadConfig(dir, { requireLocal: false });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /writers\.json/);
  rmSync(dir, { recursive: true });
});

test('unknown judge family is rejected', () => {
  const dir = tempRoot();
  writeFileSync(join(dir, 'judges.json'), JSON.stringify({ timeout_ms: 1, judges: [{ id: 'x', family: 'Nope', cli: 'codex', model: 'm', effort: 'max', concurrency: 1, accepted_served: [] }], maintainer: { id: 'm', family: 'Anthropic', cli: 'claude', model: 'fable', effort: 'max', concurrency: 1, accepted_served: [] } }));
  const r = loadConfig(dir, { requireLocal: false });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /family/);
  rmSync(dir, { recursive: true });
});

test('required local.json must exist', () => {
  const dir = tempRoot();
  const r = loadConfig(dir, { requireLocal: true });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /local\.json/);
  rmSync(dir, { recursive: true });
});

test('familyOf uses the longest matching prefix', () => {
  const prefixes: PrefixRule[] = [
    { prefix: 'claude', family: 'Anthropic' },
    { prefix: 'deepseek', family: 'DeepSeek' },
  ];
  assert.equal(familyOf('deepseek/deepseek-v4.1-flash', prefixes), 'DeepSeek');
  assert.equal(familyOf('claude-code/claude-opus-5-5', prefixes), 'Anthropic');
  assert.equal(familyOf('mystery', prefixes), null);
});
