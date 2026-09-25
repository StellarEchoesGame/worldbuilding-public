import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Family } from '../config.ts';
import { eligibleFamilies, familyStates, gateRoles, pickFamilies, surpriseRoles, type FamilyState, type JudgedText } from './assign.ts';

const FOUR: readonly Family[] = ['OpenAI', 'Anthropic', 'xAI', 'Moonshot'];

function state(family: Family, over: Partial<FamilyState> = {}): FamilyState {
  return { family, tasteQualified: true, gateQualified: true, flag: 'ok', ...over };
}

test('eligibleFamilies: taste and measure need taste-qualified and ok; every author family is excluded', () => {
  const states = [state('Anthropic'), state('OpenAI'), state('Moonshot', { flag: 'flagged' }), state('xAI', { tasteQualified: false }), state('DeepSeek')];
  const texts: JudgedText[] = [
    { id: 'W1', authors: ['DeepSeek'] },
    { id: 'CHAMPION', authors: ['OpenAI'] },
  ];
  assert.deepEqual(eligibleFamilies(states, texts, 'taste'), ['Anthropic']);
  assert.deepEqual(eligibleFamilies(states, texts, 'measure'), ['Anthropic']);
  assert.deepEqual(eligibleFamilies(states, [], 'taste'), ['Anthropic', 'DeepSeek', 'OpenAI']);
});

test('eligibleFamilies: gate allows flagged and taste-unqualified gate judges, never suspended ones', () => {
  const states = [state('Anthropic', { flag: 'flagged' }), state('OpenAI', { tasteQualified: false }), state('Moonshot', { flag: 'suspended' }), state('xAI', { gateQualified: false })];
  assert.deepEqual(eligibleFamilies(states, [], 'gate'), ['Anthropic', 'OpenAI']);
  assert.deepEqual(eligibleFamilies(states, [{ id: 'W2', authors: ['OpenAI'] }], 'gate'), ['Anthropic']);
});

test('the baseline counts as its writer family only, so all four judge families stay eligible', () => {
  const states = FOUR.map((f) => state(f));
  assert.deepEqual(eligibleFamilies(states, [{ id: 'W1', authors: ['DeepSeek'] }, { id: 'BASE', authors: ['DeepSeek'] }], 'taste'), ['Anthropic', 'Moonshot', 'OpenAI', 'xAI']);
});

test('familyStates reads the freeze pins: eligible, flagged (shadow), unqualified, suspended, gate', () => {
  const states = familyStates(
    {
      flags: { Anthropic: 'ok', OpenAI: 'unqualified', Moonshot: 'flagged', xAI: 'suspended' },
      eligible_families: ['Anthropic'],
      gate_families: ['Anthropic', 'OpenAI', 'Moonshot'],
    },
    ['xAI', 'Moonshot', 'OpenAI', 'Anthropic', 'DeepSeek'],
  );
  assert.deepEqual(states, [
    { family: 'Anthropic', tasteQualified: true, gateQualified: true, flag: 'ok' },
    { family: 'DeepSeek', tasteQualified: false, gateQualified: false, flag: 'ok' },
    { family: 'Moonshot', tasteQualified: true, gateQualified: true, flag: 'flagged' },
    { family: 'OpenAI', tasteQualified: false, gateQualified: true, flag: 'ok' },
    { family: 'xAI', tasteQualified: false, gateQualified: false, flag: 'suspended' },
  ]);
  assert.deepEqual(eligibleFamilies(states, [], 'taste'), ['Anthropic']);
  assert.deepEqual(eligibleFamilies(states, [], 'gate'), ['Anthropic', 'Moonshot', 'OpenAI']);
});

test('pickFamilies is seeded, independent of input order, keyed and bounded', () => {
  const a = pickFamilies(FOUR, 2, 'seed-1', 'cold:W1');
  assert.equal(a.length, 2);
  assert.deepEqual(pickFamilies([...FOUR].reverse(), 2, 'seed-1', 'cold:W1'), a);
  assert.deepEqual(pickFamilies(FOUR, 2, 'seed-1', 'cold:W1'), a);
  assert.deepEqual(new Set(pickFamilies(FOUR, 9, 'seed-1', 'k')), new Set(FOUR));
  assert.deepEqual(pickFamilies(FOUR, 0, 'seed-1', 'k'), []);
  assert.deepEqual(pickFamilies([], 2, 'seed-1', 'k'), []);
  assert.deepEqual(pickFamilies(['xAI', 'xAI'], 2, 'seed-1', 'k'), ['xAI']);
  const keys = new Set<string>();
  for (let i = 0; i < 12; i += 1) keys.add(pickFamilies(FOUR, 2, 'seed-1', `key-${i}`).join(','));
  assert.ok(keys.size > 1, 'different keys give different picks');
});

test('gateRoles: two seeded judges, the rest as reserve in seeded order, per submission', () => {
  const r = gateRoles(FOUR, 'seed-2', 'W1');
  assert.equal(r.judges.length, 2);
  assert.equal(r.reserve.length, 2);
  assert.deepEqual(new Set([...r.judges, ...r.reserve]), new Set(FOUR));
  assert.deepEqual(gateRoles([...FOUR].reverse(), 'seed-2', 'W1'), r);
  const bySub = new Set<string>();
  for (const sub of ['W1', 'W2', 'W3', 'W1-r2', 'W2-r2', 'W3-r2']) bySub.add(gateRoles(FOUR, 'seed-2', sub).judges.join(','));
  assert.ok(bySub.size > 1);
  assert.deepEqual(gateRoles(['OpenAI'], 'seed-2', 'W1'), { judges: ['OpenAI'], reserve: [] });
});

test('surpriseRoles: 4 / 3 / 2 / 1 eligible families → full / reused / match_only / insufficient', () => {
  const full = surpriseRoles(FOUR, 'seed-3', 'W1');
  assert.equal(full.status, 'full');
  assert.equal(full.acceptorReused, false);
  assert.equal(full.matchers.length, 2);
  assert.ok(full.chainWriter !== null && full.acceptor !== null);
  assert.equal(new Set([...full.matchers, full.chainWriter, full.acceptor]).size, 4);
  const three = surpriseRoles(['OpenAI', 'Anthropic', 'xAI'], 'seed-3', 'W1');
  assert.equal(three.status, 'reused');
  assert.equal(three.acceptorReused, true);
  assert.equal(three.acceptor, three.matchers[0]);
  assert.ok(three.chainWriter !== null && !three.matchers.includes(three.chainWriter));
  assert.deepEqual(surpriseRoles(['OpenAI', 'xAI'], 'seed-3', 'W1'), { matchers: surpriseRoles(['xAI', 'OpenAI'], 'seed-3', 'W1').matchers, chainWriter: null, acceptor: null, acceptorReused: false, status: 'match_only' });
  assert.deepEqual(surpriseRoles(['OpenAI'], 'seed-3', 'W1'), { matchers: [], chainWriter: null, acceptor: null, acceptorReused: false, status: 'insufficient' });
  assert.equal(surpriseRoles([], 'seed-3', 'W1').status, 'insufficient');
});
