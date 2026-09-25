import type { Family } from './config.ts';
import type { Pick } from './taste.ts';

/** One session-pair of a family: the decisive pick when the submission was shown first (forward) and second (reverse); null = void after retry. */
export interface SessionPair {
  family: Family;
  index: number;
  forward: Pick | null;
  reverse: Pick | null;
}

export interface PairTally {
  eligible: Family[];
  dropped: Family[];
  winsByFamily: Record<string, number>;
  /** Session-pairs recorded per eligible family (the denominator for family signs). */
  pairsByFamily: Record<string, number>;
  totalWins: number;
  needed: number;
  beatsChampion: boolean;
  trial: boolean;
}

export function isWin(s: SessionPair): boolean {
  return s.forward === 1 && s.reverse === 2;
}

export function isVoid(s: SessionPair): boolean {
  return s.forward === null || s.reverse === null;
}

export function tallyChampionPair(
  sessions: readonly SessionPair[],
  families: readonly Family[],
  opts: { barFourFamilies: 7 | 8 } = { barFourFamilies: 7 },
): PairTally {
  const dropped = families.filter((f) => sessions.some((s) => s.family === f && isVoid(s)));
  const eligible = families.filter((f) => !dropped.includes(f));
  const winsByFamily: Record<string, number> = {};
  const pairsByFamily: Record<string, number> = {};
  for (const f of eligible) {
    winsByFamily[f] = sessions.filter((s) => s.family === f && isWin(s)).length;
    pairsByFamily[f] = sessions.filter((s) => s.family === f).length;
  }
  const totalWins = eligible.reduce((sum, f) => sum + (winsByFamily[f] ?? 0), 0);
  const trial = eligible.length <= 2;
  const needed = eligible.length >= 4 ? opts.barFourFamilies : eligible.length * 2;
  return { eligible, dropped, winsByFamily, pairsByFamily, totalWins, needed, beatsChampion: !trial && totalWins >= needed, trial };
}

/**
 * One-sided P(X >= k) for X ~ Binomial(n, p), computed in log space so it stays finite for large n.
 * log(P(X = i) / P(X = mode)) is accumulated outward from the mode through the term ratios
 * P(i + 1) / P(i) = (n - i) / (i + 1) * p / (1 - p); the mode term is the largest, so log-sum-exp shifted by it
 * never overflows. Dividing the tail by the sum over all terms normalises without computing log C(n, mode).
 */
export function binomialTailP(k: number, n: number, p = 0.5): number {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`binomialTailP: n must be a non-negative integer, got ${n}`);
  if (!Number.isInteger(k)) throw new RangeError(`binomialTailP: k must be an integer, got ${k}`);
  if (!(p >= 0 && p <= 1)) throw new RangeError(`binomialTailP: p must lie in [0, 1], got ${p}`);
  if (k <= 0) return 1;
  if (k > n) return 0;
  // Degenerate coins put all mass on 0 or n; 1 <= k <= n here.
  if (p === 0) return 0;
  if (p === 1) return 1;
  const logOdds = Math.log(p) - Math.log1p(-p);
  const mode = Math.min(n, Math.floor((n + 1) * p));
  let upper = 0;
  let lower = 0;
  let logTerm = 0;
  for (let i = mode; i <= n; i += 1) {
    if (i >= k) upper += Math.exp(logTerm);
    else lower += Math.exp(logTerm);
    logTerm += Math.log((n - i) / (i + 1)) + logOdds;
  }
  logTerm = 0;
  for (let i = mode - 1; i >= 0; i -= 1) {
    logTerm += Math.log((i + 1) / (n - i)) - logOdds;
    if (i >= k) upper += Math.exp(logTerm);
    else lower += Math.exp(logTerm);
  }
  return upper / (upper + lower);
}

export interface FamilySigns {
  plus: number;
  minus: number;
  tie: number;
}

export function familySigns(t: PairTally): FamilySigns {
  const signs: FamilySigns = { plus: 0, minus: 0, tie: 0 };
  for (const f of t.eligible) {
    const wins = t.winsByFamily[f] ?? 0;
    const losses = (t.pairsByFamily[f] ?? 0) - wins;
    if (wins > losses) signs.plus += 1;
    else if (wins < losses) signs.minus += 1;
    else signs.tie += 1;
  }
  return signs;
}

export interface Comparison {
  a: string;
  b: string;
  winsA: number;
  winsB: number;
}

interface PairCount {
  lo: number;
  hi: number;
  winsLo: number;
  winsHi: number;
}

function isCount(v: number): boolean {
  return Number.isFinite(v) && v >= 0;
}

/**
 * Bradley-Terry strengths by the MM algorithm. Entries for the same pair (in either order) are summed, then
 * `pseudo` (> 0) is added once to each side of every compared pair. Items that were never compared score 1; the
 * compared items are normalised to geometric mean 1, so the whole result has geometric mean 1.
 */
export function bradleyTerry(items: string[], comparisons: Comparison[], pseudo = 0.5, iterations = 200): Record<string, number> {
  const index = new Map<string, number>();
  items.forEach((id, i) => index.set(id, i));
  if (index.size !== items.length) throw new RangeError('bradleyTerry: duplicate item');
  // Zero pseudo-counts let an item with no wins reach score 0, and the geometric-mean step then gives NaN everywhere.
  if (!(Number.isFinite(pseudo) && pseudo > 0)) throw new RangeError(`bradleyTerry: pseudo must be a positive number, got ${pseudo}`);
  if (!Number.isInteger(iterations) || iterations < 0) throw new RangeError(`bradleyTerry: iterations must be a non-negative integer, got ${iterations}`);

  const pairs = new Map<string, PairCount>();
  for (const c of comparisons) {
    const i = index.get(c.a);
    const j = index.get(c.b);
    if (i === undefined || j === undefined) throw new RangeError(`bradleyTerry: unknown item in ${c.a} vs ${c.b}`);
    if (i === j) throw new RangeError(`bradleyTerry: ${c.a} compared with itself`);
    if (!isCount(c.winsA) || !isCount(c.winsB)) throw new RangeError(`bradleyTerry: bad win counts for ${c.a} vs ${c.b}`);
    const lo = Math.min(i, j);
    const hi = Math.max(i, j);
    const key = `${lo}:${hi}`;
    const pair = pairs.get(key) ?? { lo, hi, winsLo: pseudo, winsHi: pseudo };
    pair.winsLo += i === lo ? c.winsA : c.winsB;
    pair.winsHi += i === lo ? c.winsB : c.winsA;
    pairs.set(key, pair);
  }

  const totalWins = items.map(() => 0);
  const compared = items.map(() => false);
  for (const pr of pairs.values()) {
    totalWins[pr.lo] = (totalWins[pr.lo] ?? 0) + pr.winsLo;
    totalWins[pr.hi] = (totalWins[pr.hi] ?? 0) + pr.winsHi;
    compared[pr.lo] = true;
    compared[pr.hi] = true;
  }
  const comparedCount = compared.filter((c) => c).length;

  let scores = items.map(() => 1);
  for (let it = 0; it < iterations && comparedCount > 0; it += 1) {
    const denominators = items.map(() => 0);
    for (const pr of pairs.values()) {
      const share = (pr.winsLo + pr.winsHi) / ((scores[pr.lo] ?? 1) + (scores[pr.hi] ?? 1));
      denominators[pr.lo] = (denominators[pr.lo] ?? 0) + share;
      denominators[pr.hi] = (denominators[pr.hi] ?? 0) + share;
    }
    const next = scores.map((v, k) => {
      const d = denominators[k] ?? 0;
      return d > 0 ? (totalWins[k] ?? 0) / d : v;
    });
    const logMean = next.reduce((sum, v, k) => (compared[k] === true ? sum + Math.log(v) : sum), 0) / comparedCount;
    const scale = Math.exp(logMean);
    scores = next.map((v, k) => (compared[k] === true ? v / scale : 1));
  }
  return Object.fromEntries(items.map((id, k) => [id, scores[k] ?? 1]));
}
