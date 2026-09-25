import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededShuffle } from './store.ts';
import { seededSplit } from './split.ts';

const IDS = ['R01-audit-1', 'R01-audit-2', 'R01-audit-3', 'R01-audit-4'];

test('seededSplit: 2 visible / 2 reserve, deterministic by seed and independent of input order', () => {
  const a = seededSplit(IDS, 'seed-a', 'labels:split', 2);
  assert.deepEqual(Object.keys(a), IDS);
  assert.equal(Object.values(a).filter((s) => s === 'visible').length, 2);
  assert.equal(Object.values(a).filter((s) => s === 'reserve').length, 2);
  assert.deepEqual(seededSplit([...IDS].reverse(), 'seed-a', 'labels:split', 2), a);
  assert.deepEqual(JSON.stringify(seededSplit(IDS, 'seed-a', 'labels:split', 2)), JSON.stringify(a), 'byte-stable');
  const visible = seededShuffle(IDS, 'seed-a', 'labels:split').slice(0, 2);
  for (const id of IDS) assert.equal(a[id], visible.includes(id) ? 'visible' : 'reserve');
});

test('seededSplit: the seed and the key decide which ids are visible', () => {
  const picks = new Set<string>();
  for (const seed of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']) {
    const split = seededSplit(IDS, seed, 'labels:split', 2);
    picks.add(IDS.filter((id) => split[id] === 'visible').join(','));
  }
  assert.ok(picks.size > 1, 'different seeds give different splits');
  const keys = new Set(['k1', 'k2', 'k3', 'k4', 'k5', 'k6'].map((k) => JSON.stringify(seededSplit(IDS, 's1', k, 2))));
  assert.ok(keys.size > 1, 'the key is part of the draw');
});

test('seededSplit: fewer ids than visible → all visible; visible 0 → all reserve; bad input throws', () => {
  assert.deepEqual(seededSplit(['b', 'a'], 's', 'labels:split', 2), { a: 'visible', b: 'visible' });
  assert.deepEqual(seededSplit(['b', 'a'], 's', 'labels:split', 0), { a: 'reserve', b: 'reserve' });
  assert.deepEqual(seededSplit([], 's', 'labels:split', 2), {});
  assert.throws(() => seededSplit(['a', 'a'], 's', 'labels:split', 1), /duplicate id a/u);
  assert.throws(() => seededSplit(['a'], 's', 'labels:split', -1), /non-negative integer/u);
  assert.throws(() => seededSplit(['a'], 's', 'labels:split', 1.5), /non-negative integer/u);
});
