import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonFiles, factRowsFrom, parseMergeDecision, parseRegister07, sourcesFromRound } from './inputs.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('canonFiles reads world/current and its reference folder, keyed relative to world/current', () => {
  const canon = canonFiles(REPO);
  assert.ok((canon['BOOK.md'] ?? '').length > 0);
  assert.ok((canon['reference/07-register-and-creation.md'] ?? '').includes('## 2.'));
  assert.ok(Object.keys(canon).some((k) => /^0\d-/u.test(k)));
  assert.equal(canon['reference/REFERENCE.md'], undefined, 'the assembled bundle is not a source file');
});

test('parseRegister07 reads §8 rows only, in file order', () => {
  const text = [
    '## 7. 其他',
    '| R99-01 | SHIP | 不在第8节 | x | 05 | y | z | R99 |',
    '## 8. 现场登记',
    '| R-ID | 行 | 事实 | 地位 | 挂靠 | 延伸自 | 误用 | 来源 |',
    '|---|---|---|---|---|---|---|---|',
    '| R01-01 | SHIP | 工具柜不上锁 | 状态与路径实例 | 05-ecology | 状态牌显示设备可用程度 | 写成上锁 | R01 |',
    '| R01-02 | S1-冷湾 | 冷湾有夜市 | 状态与路径实例 | 04 | F09 | 写成常设 | R01 |',
  ].join('\n');
  assert.deepEqual(parseRegister07(text), [
    { rxx: 'R01-01', rowId: 'SHIP', extends: '状态牌显示设备可用程度' },
    { rxx: 'R01-02', rowId: 'S1-冷湾', extends: 'F09' },
  ]);
  assert.deepEqual(parseRegister07('## 1. 无登记\n'), []);
});

test('factRowsFrom maps F-IDs to their rows and rejects a malformed file', () => {
  const r = factRowsFrom({ facts: [{ id: 'F01', rows: ['ALL'] }, { id: 'F09', rows: ['S1-冷湾', 'S1-赤脊'] }] });
  assert.ok(r.ok);
  assert.deepEqual(r.value, { F01: ['ALL'], F09: ['S1-冷湾', 'S1-赤脊'] });
  assert.equal(factRowsFrom({ facts: [{ id: 'F01' }] }).ok, false);
  assert.equal(factRowsFrom({}).ok, false);
});

test('parseMergeDecision validates the decision shape', () => {
  const good = { round: 'R01', baseLabel: 'A', title: '冷湾的夜', rows: ['S1-冷湾'], registered: [{ rxx: 'R01-01', label: 'A', factId: 'A-01' }] };
  const r = parseMergeDecision(good);
  assert.ok(r.ok);
  assert.deepEqual(r.value, good);
  assert.equal(parseMergeDecision({ ...good, registered: [{ rxx: 'R01-01' }] }).ok, false);
  assert.equal(parseMergeDecision({ ...good, round: 7 }).ok, false);
});

function submission(dir: string, id: string, body: string, claims: string): void {
  const text = ['```submission', body, '```', '```delta', `{"new_proper_nouns":[],"claims":${claims}}`, '```', '```interface', '{"shots":[{},{},{}],"object":{"n":1},"hook":{"h":1}}', '```'].join('\n');
  writeFileSync(join(dir, 'submissions', `${id}.json`), JSON.stringify({ id, kind: id === 'BASE' ? 'baseline' : 'writer', model: 'm', family: 'DeepSeek', ok: true, text }));
}

test('sourcesFromRound gives every labelled candidate plus the baseline, with its facts', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-inputs-'));
  const dir = join(root, 'rounds', 'R01');
  mkdirSync(join(dir, 'submissions'), { recursive: true });
  writeFileSync(join(dir, 'labels.json'), JSON.stringify({ A: 'W1' }));
  const fact = '[{"id":"A-01","kind":"author_fact","claim":"c","status":"状态与路径实例","row_id":"SHIP","attaches_to":"05","extends":"F07","misuse":"m","source_quote":"温芮把旧水壶","register":true}]';
  submission(dir, 'W1', '温芮把旧水壶放回架上。', fact);
  submission(dir, 'BASE', '陈颂打开储物格。', '[]');
  const r = sourcesFromRound(root, 'R01');
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.deepEqual(r.value.map((s) => s.label), ['A', 'BASE']);
  assert.equal(r.value[0]?.facts[0]?.sourceQuote, '温芮把旧水壶');
  assert.equal(r.value[0]?.facts[0]?.rowId, 'SHIP');
  rmSync(root, { recursive: true });
});

test('sourcesFromRound reports a round without labels', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-inputs-'));
  const r = sourcesFromRound(root, 'R01');
  assert.equal(r.ok, false);
  rmSync(root, { recursive: true });
});
