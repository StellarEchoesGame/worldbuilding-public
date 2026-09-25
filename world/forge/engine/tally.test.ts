import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tallyChampionPair, type SessionPair } from './tally.ts';
import type { Family } from './config.ts';

function sp(family: Family, index: number, fwd: 1 | 2 | null, rev: 1 | 2 | null): SessionPair {
  return { family, index, forward: fwd, reverse: rev };
}
// forward shows the submission as text 1; reverse shows it as text 2.
const win = (f: Family, i: number): SessionPair => sp(f, i, 1, 2);
const loss = (f: Family, i: number): SessionPair => sp(f, i, 2, 1);
const inconsistent = (f: Family, i: number): SessionPair => sp(f, i, 1, 1);
const fams: Family[] = ['OpenAI', 'Anthropic', 'Moonshot', 'xAI'];

test('7 of 8 session-pair wins with four families beats the champion', () => {
  const s = fams.flatMap((f) => [win(f, 0), win(f, 1)]);
  s[7] = loss('xAI', 1);
  const t = tallyChampionPair(s, fams);
  assert.equal(t.beatsChampion, true);
  assert.equal(t.totalWins, 7);
});

test('6 of 8 does not beat the champion, and inconsistent pairs are not wins', () => {
  const s = fams.flatMap((f) => [win(f, 0), win(f, 1)]);
  s[6] = inconsistent('xAI', 0);
  s[7] = loss('xAI', 1);
  const t = tallyChampionPair(s, fams);
  assert.equal(t.beatsChampion, false);
  assert.equal(t.totalWins, 6);
});

test('a family with a void session-pair drops out; three families need 6 of 6', () => {
  const s = fams.flatMap((f) => [win(f, 0), win(f, 1)]);
  s[7] = sp('xAI', 1, 1, null);
  const t = tallyChampionPair(s, fams);
  assert.deepEqual(t.eligible, ['OpenAI', 'Anthropic', 'Moonshot']);
  assert.equal(t.beatsChampion, true);
  assert.equal(t.trial, false);
});

test('two eligible families make a trial pair', () => {
  const s = fams.flatMap((f) => [win(f, 0), win(f, 1)]);
  s[5] = sp('Moonshot', 1, null, 2);
  s[7] = sp('xAI', 1, 1, null);
  const t = tallyChampionPair(s, fams);
  assert.equal(t.trial, true);
  assert.equal(t.beatsChampion, false);
});

test('the bar can be tightened to 8 of 8', () => {
  const s = fams.flatMap((f) => [win(f, 0), win(f, 1)]);
  s[7] = loss('xAI', 1);
  assert.equal(tallyChampionPair(s, fams, { barFourFamilies: 8 }).beatsChampion, false);
});
