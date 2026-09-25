import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookkeepingCommitMessage, compareSnapshot, poolLines, touchedRows, wikiDue, type PoolSurprise } from './bookkeeping.ts';
import { parseSealedForecasts } from './probe.ts';
import type { SurpriseStatus } from './tasks/surprise.ts';
import { computeThinmap, type Alias } from './thinmap.ts';

// Pure helpers; the step-level tests (11a–11l over a fixture world) live in bookkeeping-steps.test.ts.

const SCENE = '温芮把借来的扳手挂回母舰第三邻里的工具墙。循环泵换了节拍，走廊里的灯带转成琥珀色。林澈把冷凝管的旧滤网装进编号袋。';

const report = (status: SurpriseStatus, match: ReadonlyArray<'ok' | 'void'>, details: readonly string[][]): PoolSurprise['submissions'][string] => ({
  status, match_status: match, details: details.map((forecasts) => ({ forecasts })),
});
const surprise = (...reports: ReadonlyArray<PoolSurprise['submissions'][string]>): PoolSurprise => ({ submissions: Object.fromEntries(reports.map((r, i) => [`W${i + 1}`, r])) });

test('poolLines: order and fields; forecast / unmatched only after a working matcher compared; insufficient, both-void or detail-less reports → null', () => {
  const sealed = parseSealedForecasts({
    round: 'R01', row_id: 'SHIP', brief_sha256: 'f'.repeat(64),
    forecasts: [{ forecaster: 'a', family: 'Anthropic', model: 'm', writer_model: false, items: [{ slot: '物件', value: 'x' }, { slot: '声音', value: 'y' }] }, { forecaster: 'b', family: 'DeepSeek', model: 'd', writer_model: true, items: [{ slot: '气味', value: 'z' }] }],
  });
  assert.ok(sealed.ok);
  const of = (s: PoolSurprise | null): Array<string | null> => poolLines('R01', 'SHIP', sealed.value, s).map((l) => l.surprise);
  const matched = poolLines('R01', 'SHIP', sealed.value, surprise(report('match_only', ['ok', 'ok'], [['P03'], []])));
  assert.deepEqual(matched.map((l) => [l.forecaster, l.slot, l.value, l.writer_model, l.surprise]), [['a', '物件', 'x', false, 'unmatched'], ['a', '声音', 'y', false, 'unmatched'], ['b', '气味', 'z', true, 'forecast']]);
  assert.deepEqual(matched[0], { round: 'R01', row_id: 'SHIP', forecaster: 'a', family: 'Anthropic', slot: '物件', value: 'x', writer_model: false, surprise: 'unmatched' });
  assert.deepEqual(of(null), [null, null, null], 'no surprise.json');
  assert.deepEqual(of(surprise(report('insufficient', [], [[], []]))), [null, null, null], 'insufficient: no matcher ran');
  assert.deepEqual(of(surprise(report('full', ['void', 'void'], [[], []]))), [null, null, null], 'both matchers void: nobody compared');
  assert.deepEqual(of(surprise(report('full', [], []))), [null, null, null], 'no details: no matcher ran');
  assert.deepEqual(of(surprise(report('insufficient', ['ok', 'ok'], [[]]))), [null, null, null], 'an insufficient report never counts as a comparison');
  assert.deepEqual(of(surprise(report('reused', ['ok', 'void'], [[]]))), ['unmatched', 'unmatched', 'unmatched'], 'one working matcher compared every forecast');
  assert.deepEqual(of(surprise(report('insufficient', [], [[]]), report('full', ['void', 'void'], [[]]), report('full', ['ok', 'ok'], [['P01']]))), ['forecast', 'unmatched', 'unmatched']);
});

test('compareSnapshot: present snapshot → rows + r0; missing → snapshot missing, r0 null, never above; malformed → err', () => {
  const now = computeThinmap({ rows: [], aliases: [], tags: { cells: {} }, canon: {}, registered: [], factRows: {}, gameNeed: {}, mentions: {} });
  assert.equal(compareSnapshot('R01', now, { state: 'present', value: { cells: { SHIP: { object: 4 } } } }, ['SHIP'], []).ok, false);
  assert.equal(compareSnapshot('R01', now, { state: 'present', value: { nope: {} } }, ['SHIP'], []).ok, false);
  assert.equal(compareSnapshot('R01', now, { state: 'present', value: null }, ['SHIP'], []).ok, false, 'an unreadable file is malformed, not missing');
  const empty = compareSnapshot('R01', now, { state: 'present', value: { cells: {} } }, ['SHIP'], []);
  assert.ok(empty.ok && empty.value.snapshot === 'present' && empty.value.rows.length === 7 && !empty.value.all_targets_above, 'no target → never all above');
  const present = compareSnapshot('R01', now, { state: 'present', value: { cells: { SHIP: { object: 1 } } } }, ['SHIP'], [{ row_id: 'SHIP', layer: 'object' }]);
  assert.ok(present.ok);
  assert.deepEqual(Object.keys(present.value), ['round', 'snapshot', 'rows', 'all_targets_above']);
  assert.deepEqual(present.value.rows.filter((r) => r.target), [{ row_id: 'SHIP', layer: 'object', r0: 1, now: 0, target: true, above_r0: false }]);
  const missing = compareSnapshot('R01', now, { state: 'missing' }, ['SHIP'], [{ row_id: 'SHIP', layer: 'object' }]);
  assert.ok(missing.ok);
  assert.equal(missing.value.snapshot, 'missing');
  assert.equal(missing.value.all_targets_above, false);
  assert.equal(missing.value.rows.length, 7);
  assert.ok(missing.value.rows.every((r) => r.r0 === null && !r.above_r0), 'no zero baseline is substituted');
});

test('touchedRows, wikiDue (R03 / R06 only), commit message', () => {
  const aliases: Alias[] = [
    { row_id: 'SHIP', kind: 'ship', primary: '远航号', aliases: ['母舰'], first_quote: { file: 'f', quote: '' } },
    { row_id: 'P-林澈', kind: 'character', primary: '林澈', aliases: [], first_quote: { file: 'f', quote: '' } },
    { row_id: 'S1-冷湾', kind: 'area', primary: '冷湾', aliases: [], first_quote: { file: 'f', quote: '' } },
  ];
  assert.deepEqual(touchedRows(['S1-赤脊'], ['S1-赤脊', 'S0-外围接应区'], SCENE, aliases), ['P-林澈', 'S0-外围接应区', 'S1-赤脊', 'SHIP']);
  assert.deepEqual(['R00', 'R01', 'R02', 'R03', 'R04', 'R06', 'R09', 'x'].filter(wikiDue), ['R03', 'R06', 'R09']);
  assert.equal(bookkeepingCommitMessage('R02', 7), 'chore: bookkeeping for R02 (#7)');
});
