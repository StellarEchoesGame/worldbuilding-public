import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitignoreMatcher, killSwitch, reserveLeaks, SimulatedKill, type ReserveText } from './guards.ts';

test('gitignoreMatcher: the forge .gitignore rules (dir-only, anchored, globs, negation, paths under ignored dirs)', () => {
  const ignored = gitignoreMatcher(['# comment', 'node_modules/', 'local.json', '.runs/', 'ui/dist/', '.forge.lock.*.tmp', 'rounds/*/mirror.jsonl', '*.log', '!keep.log', ''].join('\n'));
  for (const rel of ['local.json', 'map/local.json', '.runs/R01/x.out.txt', 'node_modules/a/b.js', 'ui/dist/index.html', '.forge.lock.12.tmp', 'rounds/R01/mirror.jsonl', 'a/b.log']) assert.equal(ignored(rel), true, rel);
  for (const rel of ['rounds/R01/status.json', 'x/ui/dist/y', 'rounds/R01/sub/mirror.jsonl', 'keep.log', 'runs/x', 'local.json.bak']) assert.equal(ignored(rel), false, rel);
});

test('killSwitch: throws at the nth distinct matching id and at every later hook; paidLog keeps completed calls, in-flight ones included', () => {
  const k = killSwitch({ phase: 'before', match: /^taste-/u, nth: 2 });
  const before = k.hooks.beforeCall;
  const after = k.hooks.afterCall;
  assert.ok(before !== undefined && after !== undefined);
  before('write-W1', 1);
  before('taste-a', 1);
  before('taste-a', 2);
  assert.throws(() => before('taste-b', 1), (e: unknown) => e instanceof SimulatedKill);
  assert.equal(k.killedAt(), 'taste-b');
  assert.throws(() => before('write-W2', 1), SimulatedKill);
  assert.throws(() => after('taste-a', 1), SimulatedKill);
  assert.deepEqual(k.paidLog(), ['taste-a#1']);
});

const TEXT = '夜班的灯一直亮到凌晨三点半。嗯。她把配给簿翻到最后一页，说"数字对不上"，又合上了。\n补给船晚了整整两天！';
const HEAD = '夜班的灯一直亮到凌晨三点';
const MID = '她把配给簿翻到最后一页，说"数字对不上"，又合上了。';
const LAST = '补给船晚了整整两天！';
const RESERVE: readonly ReserveText[] = [{ id: 'C00-T07', label: 'C00-P05', text: `${TEXT}\n` }];
/** A packet-shaped prompt: a 7-character fragment, a 2-character sentence and look-alike ids (C00-T070, C00-P050) are no leak. */
const CLEAN = JSON.stringify({ items: [{ id: 'E-R01-RES', kind: 'reserve_count' }, { id: 'E-R01-DIS-C00-P050', texts: [{ text_id: 'C00-T070', text: '夜班的灯一直亮。嗯。' }] }] }, null, 2);

test('reserveLeaks: a clean packet-shaped prompt holds no reserve material', () => {
  assert.deepEqual(reserveLeaks(CLEAN, RESERVE, []), []);
});

test('reserveLeaks: catches the 12-character head a fake judge quotes, which the old 40-character probe missed', () => {
  const withHead = `${CLEAN}\n${HEAD}`;
  assert.equal(withHead.includes([...TEXT].slice(0, 40).join('')), false, 'the former E7 probe passes this prompt');
  assert.deepEqual(reserveLeaks(withHead, RESERVE, []), [`C00-T07: head 「${HEAD}」`]);
});

test('reserveLeaks: catches a mid-text sentence, raw or JSON-escaped as the evidence packet carries it', () => {
  assert.deepEqual(reserveLeaks(`${CLEAN}\n${LAST}`, RESERVE, []), [`C00-T07: sentence 「${LAST}」`]);
  const escaped = `${CLEAN}\n${JSON.stringify({ quote: MID })}`;
  assert.equal(escaped.includes(MID), false, 'only the escaped form is in the prompt');
  assert.deepEqual(reserveLeaks(escaped, RESERVE, []), [`C00-T07: sentence 「${MID}」`]);
});

test('reserveLeaks: catches the text id and the label id (inside an evidence id too)', () => {
  assert.deepEqual(reserveLeaks(`${CLEAN}\n文本C00-T07`, RESERVE, []), ['C00-T07: text id']);
  assert.deepEqual(reserveLeaks(`${CLEAN}\n"E-R01-DIS-C00-P05",`, RESERVE, []), ['C00-P05: label id']);
});

test('reserveLeaks: material a shown (visible) text also carries is not attributable; the label id still counts', () => {
  assert.deepEqual(reserveLeaks(`${CLEAN}\n${LAST}`, RESERVE, [`另一段。${LAST}`]), []);
  assert.deepEqual(reserveLeaks(`${CLEAN}\nC00-T07 ${TEXT}`, RESERVE, [TEXT]), []);
  assert.deepEqual(reserveLeaks(`${CLEAN}\nC00-P05 ${TEXT}`, RESERVE, [TEXT]), ['C00-P05: label id']);
});
