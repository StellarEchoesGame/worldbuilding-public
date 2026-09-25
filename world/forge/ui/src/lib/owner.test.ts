import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { submitAudit, submitDecision } from './owner.ts';

function sub(body: string, facts: number): string {
  const claims = Array.from({ length: facts }, (_, i) => ({ id: `A-0${i + 1}`, kind: 'author_fact', claim: `事实${i + 1}`, status: '状态与路径实例', row_id: 'SHIP', attaches_to: '04', extends: 'F07', misuse: 'm', source_quote: body.slice(0, 8), register: true }));
  const text = ['```submission', body, '```', '```delta', JSON.stringify({ new_proper_nouns: [], claims }), '```', '```interface', '{"shots":[{},{},{}],"object":{},"hook":{}}', '```'].join('\n');
  return JSON.stringify({ id: 'x', kind: 'writer', model: 'm', family: 'DeepSeek', stance: 's', ok: true, error: null, text });
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-owner-'));
  const dir = join(root, 'rounds', 'P01');
  mkdirSync(join(dir, 'submissions'), { recursive: true });
  writeFileSync(join(dir, 'labels.json'), JSON.stringify({ A: 'W1', B: 'W2' }));
  writeFileSync(join(dir, 'audit-set.json'), JSON.stringify({ pairs: [{ id: 'audit-1', left: 'A', right: 'BASE' }, { id: 'audit-2', left: 'BASE', right: 'B' }] }));
  writeFileSync(join(dir, 'submissions', 'W1.json'), sub('温芮把旧水壶放回架上，炉子还热着。', 7));
  writeFileSync(join(dir, 'submissions', 'W2.json'), sub('林澈在走廊尽头停下，听见循环泵换了节拍。', 2));
  return root;
}

const now = '2026-09-25T00:00:00.000Z';

test('the audit needs an answer for every pair and is written once', () => {
  const root = fixture();
  const partial = submitAudit(root, 'P01', { 'audit-1': 'left' }, now);
  assert.ok(!partial.ok && partial.status === 400);
  const good = submitAudit(root, 'P01', { 'audit-1': 'left', 'audit-2': 'right' }, now);
  assert.equal(good.ok, true);
  const audit: unknown = JSON.parse(readFileSync(join(root, 'rounds/P01/audit.json'), 'utf8'));
  assert.match(JSON.stringify(audit), /"chosen":"A".*"chosen":"B"/u);
  assert.match(JSON.stringify(audit), /"source":"ui"/u);
  assert.match(readFileSync(join(root, 'owner-log.jsonl'), 'utf8'), /"action":"audit"/u);
  const again = submitAudit(root, 'P01', { 'audit-1': 'right', 'audit-2': 'right' }, now);
  assert.ok(!again.ok && again.status === 409);
  rmSync(root, { recursive: true });
});

test('a decision before the audit is refused', () => {
  const root = fixture();
  const r = submitDecision(root, 'P01', { pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: [] }, now);
  assert.ok(!r.ok && r.status === 409);
  rmSync(root, { recursive: true });
});

test('a decision validates pick, reason and at most six facts', () => {
  const root = fixture();
  submitAudit(root, 'P01', { 'audit-1': 'left', 'audit-2': 'right' }, now);
  const seven = Array.from({ length: 7 }, (_, i) => `A:A-0${i + 1}`);
  const tooMany = submitDecision(root, 'P01', { pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: seven }, now);
  assert.ok(!tooMany.ok && tooMany.status === 400);
  const unknown = submitDecision(root, 'P01', { pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: ['B:A-09'] }, now);
  assert.ok(!unknown.ok && unknown.status === 400);
  const badPick = submitDecision(root, 'P01', { pick: 'Z', reason: '平', fav: 'A', publish: 'no', facts: [] }, now);
  assert.ok(!badPick.ok && badPick.status === 400);
  const good = submitDecision(root, 'P01', { pick: 'A', reason: '偏', fav: 'B', publish: 'no', happened: 'on', facts: ['A:A-01', 'B:A-02'] }, now);
  assert.equal(good.ok, true);
  const decision: unknown = JSON.parse(readFileSync(join(root, 'rounds/P01/decision.json'), 'utf8'));
  assert.match(JSON.stringify(decision), /"pick_submission":"W1"/u);
  assert.match(JSON.stringify(decision), /"happened":true/u);
  assert.ok(existsSync(join(root, 'owner-log.jsonl')));
  const again = submitDecision(root, 'P01', { pick: 'none', reason: '平', fav: 'none', publish: 'no', facts: [] }, now);
  assert.ok(!again.ok && again.status === 409);
  rmSync(root, { recursive: true });
});
