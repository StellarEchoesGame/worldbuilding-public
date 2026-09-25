import type { ProtocolCalibration } from './protocol.ts';
import type { AgreementState } from './trust-status.ts';

/**
 * Pure calibration math (s4 §4.1): qualification counts, exact binomial tails, integer Beta CDF / quantiles,
 * Wilson intervals and the Beta(1,1) agreement posterior. No I/O; every number the reports and
 * `calibration/status.json` carry comes from here.
 */

export type { AgreementState };

/** ln n! by summation, cached (n stays small: calibration counts are tens to hundreds). */
const LOG_FACT: number[] = [0];

function logFactorial(n: number): number {
  let last = LOG_FACT[LOG_FACT.length - 1] ?? 0;
  for (let i = LOG_FACT.length; i <= n; i++) {
    last += Math.log(i);
    LOG_FACT.push(last);
  }
  return LOG_FACT[n] ?? 0;
}

function logChoose(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function checkShape(a: number, b: number): void {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1) throw new RangeError(`beta shape must be integers ≥ 1, got a=${a} b=${b}`);
}

/** A closed interval inside [0, 1]. */
export interface Interval {
  lo: number;
  hi: number;
}

/** Beta(1,1) posterior over k agreements in n trials. */
export interface Posterior {
  n: number;
  k: number;
  alpha: number;
  beta: number;
  mean: number;
  /** Equal-tailed 90 % credible interval (betaQuantileInt at 0.05 / 0.95). */
  ci90: Interval;
  /** P(θ < threshold). */
  pBelow: number;
}

/** ⌈pct·m/100⌉ in integer arithmetic (0.72·25 gives 18, not 19). */
export function qualifyNeed(m: number, pct: number): number {
  if (!Number.isInteger(m) || m < 0) throw new RangeError(`qualifyNeed: m must be a non-negative integer, got ${m}`);
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) throw new RangeError(`qualifyNeed: pct must be an integer in 0..100, got ${pct}`);
  return Math.floor((pct * m + 99) / 100);
}

/** P(Bin(n, p) ≥ k), exact sum with log-space coefficients. */
export function binomialUpper(n: number, p: number, k: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const lp = Math.log(p);
  const lq = Math.log1p(-p);
  let sum = 0;
  for (let i = k; i <= n; i++) sum += Math.exp(logChoose(n, i) + i * lp + (n - i) * lq);
  return Math.min(1, sum);
}

/** Beta CDF for integer a, b ≥ 1: I_x(a, b) = P(Bin(a + b − 1, x) ≥ a). */
export function betaCdfInt(x: number, a: number, b: number): number {
  checkShape(a, b);
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return binomialUpper(a + b - 1, x, a);
}

/** Inverse of betaCdfInt by bisection (60 iterations). */
export function betaQuantileInt(p: number, a: number, b: number): number {
  checkShape(a, b);
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (betaCdfInt(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Wilson score interval; n = 0 → {lo: 0, hi: 1}; clamped to [0, 1]. */
export function wilson(k: number, n: number, z: number): Interval {
  if (n <= 0) return { lo: 0, hi: 1 };
  const phat = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (phat + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))) / denom;
  return { lo: k === 0 ? 0 : clamp01(centre - half), hi: k === n ? 1 : clamp01(centre + half) };
}

/** Beta(1,1) prior; pBelow = P(Bin(n + 1, threshold) ≥ k + 1). */
export function posterior(k: number, n: number, threshold: number): Posterior {
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 0 || k > n) throw new RangeError(`posterior: need integers 0 ≤ k ≤ n, got k=${k} n=${n}`);
  const alpha = k + 1;
  const beta = n - k + 1;
  return {
    n,
    k,
    alpha,
    beta,
    mean: alpha / (alpha + beta),
    ci90: { lo: betaQuantileInt(0.05, alpha, beta), hi: betaQuantileInt(0.95, alpha, beta) },
    pBelow: binomialUpper(n + 1, threshold, k + 1),
  };
}

/** suspended iff n ≥ suspendN && pBelow ≥ suspendP; else flagged iff n ≥ flagN && pBelow ≥ flagP; else ok (memoryless). */
export function agreementState(p: Posterior, rule: ProtocolCalibration['agreement']): AgreementState {
  if (p.n >= rule.suspendN && p.pBelow >= rule.suspendP) return 'suspended';
  if (p.n >= rule.flagN && p.pBelow >= rule.flagP) return 'flagged';
  return 'ok';
}

/** Rounds to 4 decimals (the precision of reports and status.json; parseTrustStatus allows 1e-4 on mean). */
export function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}
