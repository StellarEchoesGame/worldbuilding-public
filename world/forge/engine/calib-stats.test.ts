import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agreementState,
  betaCdfInt,
  betaQuantileInt,
  binomialUpper,
  posterior,
  qualifyNeed,
  round4,
  wilson,
} from './calib-stats.ts';
import type { ProtocolCalibration } from './protocol.ts';

const RULE: ProtocolCalibration['agreement'] = { threshold: 0.6, flagN: 12, flagP: 0.8, suspendN: 24, suspendP: 0.95 };

function near(actual: number, expected: number, tol: number, what: string): void {
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} not within ${tol} of ${expected}`);
}

test('qualifyNeed: integer ceiling of pct·m/100 (s4 §5 table)', () => {
  const table: Array<[number, number]> = [[9, 7], [12, 9], [15, 11], [18, 13], [25, 18], [50, 36]];
  for (const [m, need] of table) assert.equal(qualifyNeed(m, 72), need, `m=${m}`);
  assert.equal(qualifyNeed(0, 72), 0);
  assert.equal(qualifyNeed(10, 100), 10);
  assert.equal(qualifyNeed(10, 50), 5, 'exact multiple is not rounded up');
});

test('binomialUpper: exact upper tails', () => {
  near(binomialUpper(18, 0.5, 13), 0.0481, 5e-5, 'Bin(18,.5) ≥ 13');
  near(binomialUpper(12, 0.5, 9), 0.0730, 5e-5, 'Bin(12,.5) ≥ 9');
  near(binomialUpper(9, 0.5, 8), 0.0195, 5e-5, 'Bin(9,.5) ≥ 8');
  assert.equal(binomialUpper(10, 0.3, 0), 1, 'k ≤ 0 → 1');
  assert.equal(binomialUpper(10, 0.3, 11), 0, 'k > n → 0');
  assert.equal(binomialUpper(5, 0, 1), 0, 'p = 0');
  assert.equal(binomialUpper(5, 1, 5), 1, 'p = 1');
  near(binomialUpper(4, 0.5, 4), 1 / 16, 1e-15, 'Bin(4,.5) = 4');
});

test('betaCdfInt / betaQuantileInt: round-trip within 1e-9 and edge values', () => {
  const shapes: Array<[number, number]> = [[1, 1], [6, 8], [10, 4], [1, 12], [25, 3]];
  for (const [a, b] of shapes) {
    assert.equal(betaCdfInt(0, a, b), 0);
    assert.equal(betaCdfInt(1, a, b), 1);
    for (const p of [0.01, 0.05, 0.3, 0.5, 0.95, 0.99]) {
      const x = betaQuantileInt(p, a, b);
      near(betaCdfInt(x, a, b), p, 1e-9, `Beta(${a},${b}) p=${p}`);
    }
  }
  near(betaCdfInt(0.25, 1, 1), 0.25, 1e-15, 'Beta(1,1) is uniform');
  near(betaCdfInt(0.5, 2, 1), 0.25, 1e-15, 'Beta(2,1) cdf = x²');
  assert.equal(betaQuantileInt(0, 3, 3), 0);
  assert.equal(betaQuantileInt(1, 3, 3), 1);
});

test('betaQuantileInt: Beta(10,4) equal-tailed 90 % interval', () => {
  near(betaQuantileInt(0.05, 10, 4), 0.5054, 5e-5, 'q05');
  near(betaQuantileInt(0.95, 10, 4), 0.8873, 5e-5, 'q95');
});

test('wilson: score interval, clamped, n = 0 → [0, 1]', () => {
  const w = wilson(13, 18, 1.645);
  near(w.lo, 0.5287, 5e-5, 'lo');
  near(w.hi, 0.8577, 5e-5, 'hi');
  assert.equal(wilson(0, 4, 1.645).lo, 0);
  assert.equal(wilson(4, 4, 1.645).hi, 1);
  assert.deepEqual(wilson(0, 0, 1.645), { lo: 0, hi: 1 });
  const cases: Array<[number, number]> = [[0, 1], [1, 1], [3, 7], [7, 7]];
  for (const [k, n] of cases) {
    const i = wilson(k, n, 1.645);
    assert.ok(i.lo >= 0 && i.hi <= 1 && i.lo <= k / n && k / n <= i.hi, `(${k},${n})`);
  }
});

test('posterior: Beta(1,1) prior, pBelow and state (s4 §5 table)', () => {
  const table: Array<[number, number, number | null, string]> = [
    [5, 12, 0.9023, 'flagged'],
    [6, 12, 0.7712, 'ok'],
    [10, 24, 0.9656, 'suspended'],
    [11, 24, 0.9222, 'flagged'],
    [13, 24, 0.7323, 'ok'],
    [4, 11, null, 'ok'],
  ];
  for (const [k, n, pBelow, state] of table) {
    const p = posterior(k, n, RULE.threshold);
    if (pBelow !== null) near(p.pBelow, pBelow, 5e-5, `(${k},${n}) pBelow`);
    assert.equal(agreementState(p, RULE), state, `(${k},${n}) state`);
  }
  const p = posterior(5, 12, 0.6);
  assert.equal(p.n, 12);
  assert.equal(p.k, 5);
  assert.equal(p.alpha, 6);
  assert.equal(p.beta, 8);
  near(p.mean, 6 / 14, 1e-12, 'mean');
  near(p.ci90.lo, betaQuantileInt(0.05, 6, 8), 1e-12, 'ci90 lo');
  near(p.ci90.hi, betaQuantileInt(0.95, 6, 8), 1e-12, 'ci90 hi');
  near(p.pBelow, betaCdfInt(0.6, 6, 8), 1e-12, 'pBelow = I_θ(α, β)');
});

test('posterior: no trials is the uniform prior', () => {
  const p = posterior(0, 0, 0.6);
  assert.equal(p.alpha, 1);
  assert.equal(p.beta, 1);
  near(p.pBelow, 0.6, 1e-12, 'pBelow');
  near(p.ci90.lo, 0.05, 1e-12, 'lo');
  near(p.ci90.hi, 0.95, 1e-12, 'hi');
  assert.equal(agreementState(p, RULE), 'ok');
});

test('agreementState: thresholds are inclusive and suspension outranks flagging', () => {
  const at = (n: number, pBelow: number): string =>
    agreementState({ n, k: 0, alpha: 1, beta: 1, mean: 0, ci90: { lo: 0, hi: 1 }, pBelow }, RULE);
  assert.equal(at(24, 0.95), 'suspended');
  assert.equal(at(23, 0.99), 'flagged', 'n below suspendN');
  assert.equal(at(12, 0.8), 'flagged');
  assert.equal(at(11, 0.99), 'ok', 'n below flagN');
  assert.equal(at(30, 0.79), 'ok');
});

test('round4: four decimals', () => {
  assert.equal(round4(0.90234567), 0.9023);
  assert.equal(round4(0.77126), 0.7713);
  assert.equal(round4(1), 1);
  assert.equal(round4(0), 0);
});
