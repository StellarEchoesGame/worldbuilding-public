import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWNER_ONLY } from '../engine/context.ts';
import { decide, isOwnerPath, OWNER_GLOBS } from './owner-files.ts';

const FORGE = '/work/repo/world/forge';
const OWNER_FORMS: readonly string[] = [
  `${FORGE}/owner-log.jsonl`,
  `${FORGE}/rounds/R01/audit.json`,
  `${FORGE}/rounds/R01/decision.json`,
  `${FORGE}/rounds/R07/decision-2.json`,
  `${FORGE}/calibration/owner-answers.json`,
  '/tmp/forge-e2e-x/repo/world/forge/rounds/P01/audit.json',
];

test('OWNER_GLOBS equals engine/context.ts OWNER_ONLY', () => {
  assert.deepEqual([...OWNER_GLOBS], [...OWNER_ONLY]);
});

test('isOwnerPath: absolute, relative, ./, ../, case and NFC forms', () => {
  for (const p of OWNER_FORMS) assert.equal(isOwnerPath(p, '/'), true, p);
  assert.equal(isOwnerPath('owner-log.jsonl', FORGE), true);
  assert.equal(isOwnerPath('./rounds/R01/audit.json', FORGE), true);
  assert.equal(isOwnerPath('../forge/rounds/R01/Decision.JSON', FORGE), true);
  assert.equal(isOwnerPath('audit.json', `${FORGE}/rounds/R02`), true);
  assert.equal(isOwnerPath('world/forge/calibration/OWNER-ANSWERS.json', '/work/repo'), true);
  assert.equal(isOwnerPath('rounds/*/audit.json', FORGE), true);
  assert.equal(isOwnerPath('rounds/R01/decision*.json', FORGE), true);
  assert.equal(isOwnerPath('rounds/R01/*.json', FORGE), true);
  assert.equal(isOwnerPath('rounds/**/audit.json', FORGE), true);
  assert.equal(isOwnerPath('owner-log.jsonl', FORGE), true);
});

test('isOwnerPath: unrelated paths are not owner paths', () => {
  for (const p of ['writers.json', 'rounds/R01/status.json', 'rounds/R01/topic.json', 'rounds/R01/audit-set.json', 'rounds/R01/calls/audit.json.bak', 'calibration/status.json', 'owner-log.jsonl.bak', 'audit.json', 'engine/owner-inputs.ts', 'rounds/R01/decisions.md']) {
    assert.equal(isOwnerPath(p, FORGE), false, p);
  }
});

function input(tool: string, toolInput: Record<string, unknown>, cwd = FORGE): unknown {
  return { session_id: 's', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, cwd };
}

test('Edit / Write / MultiEdit / NotebookEdit on each owner path form → deny', () => {
  for (const p of OWNER_FORMS) {
    for (const tool of ['Edit', 'Write', 'MultiEdit']) assert.equal(decide(input(tool, { file_path: p })).decision, 'deny', `${tool} ${p}`);
    assert.equal(decide(input('NotebookEdit', { notebook_path: p })).decision, 'deny', p);
  }
  assert.equal(decide(input('Write', { file_path: 'rounds/R03/audit.json' })).decision, 'deny');
  assert.match(decide(input('Edit', { file_path: 'owner-log.jsonl' })).reason, /owner-only/u);
});

test('file tools on unrelated paths → allow', () => {
  for (const p of ['writers.json', 'ui/src/lib/owner.ts', 'rounds/R01/status.json', '/tmp/notes.md']) {
    assert.equal(decide(input('Write', { file_path: p })).decision, 'allow', p);
  }
  assert.equal(decide(input('Read', { file_path: 'owner-log.jsonl' })).decision, 'allow');
});

test('file tools and Bash writes through a symlink to an owner file or tree → deny', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-hook-link-'));
  mkdirSync(join(dir, 'rounds', 'R01'), { recursive: true });
  writeFileSync(join(dir, 'rounds', 'R01', 'audit.json'), '{}');
  writeFileSync(join(dir, 'notes.md'), '');
  symlinkSync(join(dir, 'rounds', 'R01', 'audit.json'), join(dir, 'notes.json'));
  symlinkSync('rounds/R02/decision.json', join(dir, 'next.json'));
  symlinkSync('rounds', join(dir, 'r'));
  symlinkSync('next.json', join(dir, 'chain.json'));
  symlinkSync('notes.md', join(dir, 'plain.md'));
  for (const p of ['notes.json', join(dir, 'notes.json'), 'next.json', 'chain.json', 'r/R01/audit.json', 'r/R03/decision-2.json']) {
    for (const tool of ['Edit', 'Write', 'MultiEdit']) assert.equal(decide(input(tool, { file_path: p }, dir)).decision, 'deny', `${tool} ${p}`);
    assert.equal(decide(input('NotebookEdit', { notebook_path: p }, dir)).decision, 'deny', p);
    assert.equal(decide(input('Bash', { command: `echo x > ${p}` }, dir)).decision, 'deny', `Bash > ${p}`);
  }
  for (const p of ['plain.md', 'notes.md', 'r/R01/status.json']) assert.equal(decide(input('Write', { file_path: p }, dir)).decision, 'allow', p);
  rmSync(dir, { recursive: true });
});
