import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readChampions, setBaselineChampion, setOwnerPickChampion, type Champion } from './champions.ts';
import { roundFiles, type RoundFiles } from './context.ts';
import { sha256 } from './store.ts';

function temp(): { root: string; files: RoundFiles } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-champions-'));
  const repo = join(dir, 'repo');
  const root = join(repo, 'world', 'forge');
  mkdirSync(join(repo, 'world', 'current'), { recursive: true });
  mkdirSync(root, { recursive: true });
  return { root, files: roundFiles(root, repo) };
}

function baseline(text: string, over: Partial<Champion> = {}): Champion {
  return {
    row_id: 'SHIP',
    kind: 'baseline',
    round: 'R01',
    submission: 'BASE',
    family: 'DeepSeek',
    authors: ['DeepSeek'],
    text,
    text_sha256: sha256(text),
    set_at: '2026-10-01T00:00:00.000Z',
    previous: [],
    ...over,
  };
}

function pick(text: string, round: string): Champion {
  return { ...baseline(text), kind: 'owner_pick', round, submission: 'W2', family: 'Alibaba', authors: ['Alibaba'], set_at: `2026-10-0${round.slice(2)}T00:00:00.000Z` };
}

test('readChampions: a missing file is an empty table', () => {
  const { root } = temp();
  assert.deepEqual(readChampions(root), { ok: true, value: {} });
});

test('setBaselineChampion sets once, a rerun with the same text is present, another champion is refused', () => {
  const { root, files } = temp();
  assert.deepEqual(setBaselineChampion(files, baseline('温芮把扳手挂回墙上。')), { ok: true, value: 'set' });
  const read = readChampions(root);
  assert.ok(read.ok);
  assert.deepEqual(read.value['SHIP'], baseline('温芮把扳手挂回墙上。'));
  const rerun = setBaselineChampion(files, baseline('温芮把扳手挂回墙上。', { set_at: '2026-10-02T00:00:00.000Z' }));
  assert.deepEqual(rerun, { ok: true, value: 'present' });
  const other = setBaselineChampion(files, baseline('林澈换了滤网。', { round: 'R02' }));
  assert.equal(other.ok, false);
  assert.equal(setBaselineChampion(files, baseline('x', { kind: 'owner_pick' })).ok, false);
  assert.equal(setBaselineChampion(files, baseline('冷湾的码头。', { row_id: 'S1-冷湾', text_sha256: sha256('别的') })).ok, false);
});

test('setOwnerPickChampion pushes the old champion onto previous, newest first, and is idempotent', () => {
  const { root, files } = temp();
  assert.ok(setBaselineChampion(files, baseline('基线稿。')).ok);
  assert.deepEqual(setOwnerPickChampion(files, pick('第一任擂主。', 'R01')), { ok: true, value: 'set' });
  assert.deepEqual(setOwnerPickChampion(files, pick('第一任擂主。', 'R01')), { ok: true, value: 'present' });
  assert.deepEqual(setOwnerPickChampion(files, pick('第二任擂主。', 'R04')), { ok: true, value: 'set' });
  const read = readChampions(root);
  assert.ok(read.ok);
  const ship = read.value['SHIP'];
  assert.equal(ship?.text, '第二任擂主。');
  assert.deepEqual(
    ship?.previous.map((p) => [p.kind, p.round, p.text_sha256]),
    [
      ['owner_pick', 'R01', sha256('第一任擂主。')],
      ['baseline', 'R01', sha256('基线稿。')],
    ],
  );
  assert.equal(setOwnerPickChampion(files, baseline('x')).ok, false);
});

test('the table is written with sorted row keys and two-space JSON', () => {
  const { root, files } = temp();
  assert.ok(setBaselineChampion(files, baseline('冷湾的码头。', { row_id: 'S1-冷湾' })).ok);
  assert.ok(setBaselineChampion(files, baseline('母舰的邻里。')).ok);
  const text = readFileSync(join(root, 'champions.json'), 'utf8');
  const parsed: unknown = JSON.parse(text);
  assert.ok(typeof parsed === 'object' && parsed !== null);
  assert.deepEqual(Object.keys(parsed), ['S1-冷湾', 'SHIP'].sort());
  assert.ok(text.endsWith('}\n') && text.includes('\n  "'));
});

test('readChampions rejects tampered or malformed entries', () => {
  const { root } = temp();
  const good = baseline('母舰的邻里。');
  const cases: Array<[unknown, RegExp]> = [
    [[], /object keyed by row_id/u],
    [{ SHIP: { ...good, text: '改过的正文。' } }, /text_sha256/u],
    [{ SHIP: { ...good, row_id: 'S1-冷湾' } }, /row_id/u],
    [{ SHIP: { ...good, family: 'Nobody' } }, /family/u],
    [{ SHIP: { ...good, authors: [] } }, /authors/u],
    [{ SHIP: { ...good, kind: 'champion' } }, /kind/u],
    [{ SHIP: { ...good, previous: [{ kind: 'baseline' }] } }, /previous\[0\]/u],
  ];
  for (const [value, pattern] of cases) {
    writeFileSync(join(root, 'champions.json'), JSON.stringify(value));
    const r = readChampions(root);
    assert.equal(r.ok, false, JSON.stringify(value).slice(0, 60));
    if (!r.ok) assert.match(r.error, pattern);
  }
  writeFileSync(join(root, 'champions.json'), '{');
  assert.equal(readChampions(root).ok, false);
});
