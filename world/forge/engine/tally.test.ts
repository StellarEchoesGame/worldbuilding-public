import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binomialTailP, bradleyTerry, buildRoundTally, familySigns, tallyChampionPair, type RoundTallyInput, type SessionPair } from './tally.ts';
import type { Family } from './config.ts';
import type { FamilySessions, SessionCall } from './pairs.ts';
import { IntegrityError } from './task.ts';

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

const near = (actual: number, expected: number, eps: number): boolean => Math.abs(actual - expected) <= eps;

test('binomial tail probabilities are exact for fair coins', () => {
  assert.ok(near(binomialTailP(7, 8), 9 / 256, 1e-12));
  assert.ok(near(binomialTailP(6, 6), 1 / 64, 1e-12));
  assert.ok(near(binomialTailP(13, 18), 12616 / 262144, 1e-12));
  assert.equal(binomialTailP(13, 18).toFixed(4), '0.0481');
  assert.equal(binomialTailP(0, 8), 1);
  assert.equal(binomialTailP(-2, 8), 1);
  assert.equal(binomialTailP(9, 8), 0);
  assert.equal(binomialTailP(0, 0), 1);
});

test('binomial tail honours p and rejects bad input', () => {
  assert.ok(Math.abs(binomialTailP(1, 2, 0.1) - 0.19) < 1e-12);
  assert.equal(binomialTailP(1, 3, 0), 0);
  assert.equal(binomialTailP(3, 3, 1), 1);
  assert.throws(() => binomialTailP(1, -1), RangeError);
  assert.throws(() => binomialTailP(1, 2.5), RangeError);
  assert.throws(() => binomialTailP(1.5, 3), RangeError);
  assert.throws(() => binomialTailP(1, 3, 1.5), RangeError);
  assert.throws(() => binomialTailP(1, 3, Number.NaN), RangeError);
});

/** Exact fair-coin tail P(X >= k) by BigInt arithmetic: sum of C(n, i) for i >= k over 2^n, scaled to keep 30 digits. */
function exactFairTail(k: number, n: number): number {
  let coefficient = 1n;
  let sum = k <= 0 ? 1n : 0n;
  for (let i = 1; i <= n; i += 1) {
    coefficient = (coefficient * BigInt(n - i + 1)) / BigInt(i);
    if (i >= k) sum += coefficient;
  }
  const scale = 10n ** 30n;
  return Number((sum * scale) / 2n ** BigInt(n)) / 1e30;
}

test('binomial tail stays finite and accurate for large n', () => {
  assert.ok(near(binomialTailP(1, 2000), 1, 1e-12), String(binomialTailP(1, 2000)));
  const p = binomialTailP(564, 1025);
  const reference = exactFairTail(564, 1025);
  assert.ok(Number.isFinite(p) && p > 0 && p < 0.01, String(p));
  assert.ok(Math.abs(p - reference) / reference < 0.01, `${p} vs ${reference}`);
  const q = binomialTailP(600, 1100);
  assert.ok(Number.isFinite(q) && q >= 0 && q < 0.01, String(q));
  assert.ok(near(binomialTailP(550, 1100), exactFairTail(550, 1100), 1e-12));
  const big = binomialTailP(50_500, 100_000);
  assert.ok(Number.isFinite(big) && big > 0 && big < 0.001, String(big));
  // Symmetry of the fair coin: P(X >= n/2) + P(X >= n/2 + 1) = P(X >= n/2) + P(X <= n/2 - 1) = 1.
  assert.ok(near(binomialTailP(50_000, 100_000) + binomialTailP(50_001, 100_000), 1, 1e-9));
  assert.ok(near(binomialTailP(300, 1000, 0.3), 1 - binomialTailP(701, 1000, 0.7), 1e-12));
});

test('the tally counts session-pairs per eligible family', () => {
  const s = fams.flatMap((f) => [win(f, 0), win(f, 1)]);
  s.push(win('OpenAI', 2));
  s[7] = sp('xAI', 1, 1, null);
  assert.deepEqual(tallyChampionPair(s, fams).pairsByFamily, { OpenAI: 3, Anthropic: 2, Moonshot: 2 });
});

test('family signs compare wins with the other session-pairs of each eligible family', () => {
  const all: Family[] = [...fams, 'DeepSeek'];
  const s = [
    win('OpenAI', 0), win('OpenAI', 1),
    win('Anthropic', 0), loss('Anthropic', 1),
    loss('Moonshot', 0), inconsistent('Moonshot', 1),
    inconsistent('xAI', 0), win('xAI', 1),
    win('DeepSeek', 0), sp('DeepSeek', 1, null, 2),
  ];
  const t = tallyChampionPair(s, all);
  assert.deepEqual(t.dropped, ['DeepSeek']);
  assert.deepEqual(familySigns(t), { plus: 1, minus: 1, tie: 2 });
});

const close = (a: number | undefined, b: number, eps = 1e-9): boolean => a !== undefined && Math.abs(a - b) < eps;

test('Bradley-Terry ranks a dominant item first and normalises to geometric mean 1', () => {
  const r = bradleyTerry(['c', 'a', 'b'], [
    { a: 'a', b: 'b', winsA: 3, winsB: 1 },
    { a: 'a', b: 'c', winsA: 3, winsB: 0 },
    { a: 'b', b: 'c', winsA: 2, winsB: 1 },
  ]);
  const order = Object.entries(r).sort((x, y) => y[1] - x[1]).map(([k]) => k);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.ok(close((r['a'] ?? 0) * (r['b'] ?? 0) * (r['c'] ?? 0), 1));
});

test('Bradley-Terry is symmetric for a balanced pair, merging reversed entries', () => {
  const r = bradleyTerry(['x', 'y'], [
    { a: 'x', b: 'y', winsA: 2, winsB: 1 },
    { a: 'y', b: 'x', winsA: 1, winsB: 0 },
  ]);
  assert.ok(close(r['x'], 1));
  assert.ok(close(r['y'], 1));
});

test('Bradley-Terry stays finite on a sweep thanks to the pseudo-counts', () => {
  const r = bradleyTerry(['a', 'b'], [{ a: 'a', b: 'b', winsA: 3, winsB: 0 }]);
  assert.ok(Number.isFinite(r['a']) && Number.isFinite(r['b']));
  // With 0.5 added to both sides the fixed point is 3.5 : 0.5.
  assert.ok(close(r['a'], Math.sqrt(7)));
  assert.ok(close(r['b'], 1 / Math.sqrt(7)));
  const stronger = bradleyTerry(['a', 'b'], [{ a: 'a', b: 'b', winsA: 3, winsB: 0 }], 0.1);
  assert.ok(close(stronger['a'], Math.sqrt(31)));
});

test('Bradley-Terry gives an uncompared item the neutral score 1', () => {
  const r = bradleyTerry(['a', 'b', 'lone'], [{ a: 'a', b: 'b', winsA: 3, winsB: 1 }]);
  assert.equal(r['lone'], 1);
  assert.ok(close((r['a'] ?? 0) * (r['b'] ?? 0), 1));
  assert.deepEqual(bradleyTerry(['a', 'b'], []), { a: 1, b: 1 });
});

test('Bradley-Terry rejects unknown items, self-pairs, duplicates and bad counts', () => {
  assert.throws(() => bradleyTerry(['a'], [{ a: 'a', b: 'z', winsA: 1, winsB: 0 }]), RangeError);
  assert.throws(() => bradleyTerry(['a', 'b'], [{ a: 'a', b: 'a', winsA: 1, winsB: 0 }]), RangeError);
  assert.throws(() => bradleyTerry(['a', 'a'], []), RangeError);
  assert.throws(() => bradleyTerry(['a', 'b'], [{ a: 'a', b: 'b', winsA: -1, winsB: 0 }]), RangeError);
  assert.throws(() => bradleyTerry(['a', 'b'], [], -0.5), RangeError);
  assert.throws(() => bradleyTerry(['a', 'b'], [], Number.POSITIVE_INFINITY), RangeError);
  assert.throws(() => bradleyTerry(['a', 'b'], [], 0.5, 1.5), RangeError);
});

test('Bradley-Terry requires positive pseudo-counts, since a zero-win item would make every score NaN', () => {
  assert.throws(() => bradleyTerry(['a', 'b'], [{ a: 'a', b: 'b', winsA: 3, winsB: 0 }], 0), RangeError);
  assert.throws(() => bradleyTerry(['a', 'b'], [], 0), RangeError);
  const r = bradleyTerry(['a', 'b'], [{ a: 'a', b: 'b', winsA: 3, winsB: 0 }], 1e-6);
  assert.ok(Object.values(r).every(Number.isFinite), JSON.stringify(r));
});

/** One champion-pair family: `picks[k]` = [fwd, rev] text ids picked in session k ('DECOY' = preferred the decoy). */
function fam(family: Family, picks: ReadonlyArray<readonly [string, string]>, opts: { shadow?: boolean; dropped?: boolean } = {}): FamilySessions {
  const call = (pick: string, order: 'fwd' | 'rev', k: number): SessionCall => ({
    taskId: `taste-W1-${family}-s${k}-${order}`, order, status: 'ok', decisive: pick === 'DECOY' ? 'W1' : pick, preferredDecoy: pick === 'DECOY',
  });
  return {
    family, shadow: opts.shadow === true, sessions: picks.map(([f, r], k): [SessionCall, SessionCall] => [call(f, 'fwd', k), call(r, 'rev', k)]),
    reruns: opts.dropped === true ? [1] : [], dropped: opts.dropped === true ? 'void_after_rerun' : null,
  };
}

function roundInput(pairs: RoundTallyInput['championPairs'], bar: 7 | 8 = 7): RoundTallyInput {
  return {
    round: 'R01', benchmark: 'v1', champion: 'owner_pick', sessionPairs: 2, barFourFamilies: bar, labels: { W1: 'B', W2: 'A', W3: 'C' },
    championPairs: pairs, auxPairs: [], gate: { W1: 'pass', W2: 'pass', W3: 'split' }, measures: {},
    voids: { calls: 0, void_tasks: 0, retried_tasks: 0, session_reruns: 0, dropped_families: 0 },
  };
}

test('buildRoundTally: decoy-preferred sessions void the family (|E| 4 → 3, bar 6/6); shadow never counts; ≤ 2 → trial; 8/8 only tightens', () => {
  const win = (sub: string): ReadonlyArray<readonly [string, string]> => [[sub, sub], [sub, sub]];
  const w1 = { pair: 'W1', submission: 'W1', sessions: [fam('Anthropic', win('W1')), fam('OpenAI', win('W1')), fam('xAI', win('W1')), fam('Moonshot', [['W1', 'W1'], ['DECOY', 'W1']], { dropped: true })] };
  const w2 = { pair: 'W2', submission: 'W2', sessions: [fam('Anthropic', win('W2')), fam('OpenAI', win('W2')), fam('xAI', win('W2')), fam('Moonshot', [['W2', 'W2'], ['BASE', 'W2']])] };
  const w3 = { pair: 'W3', submission: 'W3', sessions: [fam('Anthropic', [['BASE', 'W3'], ['W3', 'BASE']]), fam('OpenAI', win('W3')), fam('xAI', win('W3'), { shadow: true })] };
  const seven = buildRoundTally(roundInput([w1, w2, w3]));
  assert.deepEqual(seven.champion_pairs.map((p) => [p.pair, p.label, p.e.length, p.bar, p.total_wins, p.beats_champion, p.trial]), [
    ['W2', 'A', 4, '7/8', 7, true, false],
    ['W1', 'B', 3, '6/6', 6, true, false],
    ['W3', 'C', 2, 'trial', 2, false, true],
  ]);
  const p1 = seven.champion_pairs[1];
  assert.deepEqual([p1?.dropped, p1?.e], [['Moonshot'], ['Anthropic', 'OpenAI', 'xAI']]);
  assert.deepEqual(seven.champion_pairs[2]?.shadow, ['xAI']);
  assert.equal(buildRoundTally(roundInput([w1, w2, w3], 8)).champion_pairs[0]?.beats_champion, false, '8/8 needs every session');
});

test('buildRoundTally refuses bars.session_pairs other than 2 (the 7/8 and 6/6 bars are defined for 2 session-pairs)', () => {
  assert.throws(() => buildRoundTally({ ...roundInput([]), sessionPairs: 3 }), (e: unknown) => e instanceof IntegrityError && /session_pairs must be 2, got 3/u.test(e.message));
  assert.equal(buildRoundTally(roundInput([])).session_pairs, 2);
});
