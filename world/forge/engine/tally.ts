import type { ChampionKind } from './champions.ts';
import type { Family } from './config.ts';
import type { FamilySessions, SessionCall } from './pairs.ts';
import type { GateOutcome } from './tasks/gate-judge.ts';
import type { SurpriseStatus } from './tasks/surprise.ts';
import { IntegrityError } from './task.ts';
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

// ---------------------------------------------------------------------------------------------------------------
// tally.json v2 (08-aggregate). buildRoundTally is pure: 08 reads the files and passes summaries in.

/** One champion pair (submission vs CHAMPION_ID) after void drops; shadow families never count. */
export interface ChampionPairResult {
  pair: string;
  submission: string;
  /** labels.json label (A/B/C). */
  label: string;
  /** E after drops, code-unit sorted. */
  e: Family[];
  shadow: Family[];
  dropped: Family[];
  wins_by_family: Record<string, number>;
  total_wins: number;
  needed: number;
  /** `7/8` or `8/8` at |E| = 4, `6/6` at |E| = 3, `trial` at |E| ≤ 2. */
  bar: string;
  beats_champion: boolean;
  /** |E| ≤ 2: reported, never a failure; card flag `trial`, never replaces a champion, blocked from merge at 10a. */
  trial: boolean;
  signs: FamilySigns;
  /** Session-level one-sided binomial p (descriptive only). */
  p_value: number;
}

/** One aux pair (sub–sub or anchor): ordering only. */
export interface AuxPairResult {
  pair: string;
  kind: 'sub_sub' | 'anchor';
  left: string;
  right: string;
  /** Calls whose decisive pick was left / right. */
  wins_left: number;
  wins_right: number;
  families: Family[];
  void_calls: number;
}

export type SkinSwapSummary = 'recognised' | 'not_recognised' | 'void' | 'inactive';

/** Per-submission measure summary (08 builds it from measures/*, surprise.json and unseal.json). */
export interface SubmissionMeasures {
  hook: number | null;
  skin_swap: SkinSwapSummary;
  cold_reader: { status: 'ok' | 'void' | 'inactive'; clarity: number | null };
  interface: 'pass' | 'fail' | 'unjudged';
  surprise: { status: SurpriseStatus; surprising: number; eligible: number };
}

export interface VoidCounts {
  /** Paid calls counted this round (call records, quota tries excluded). */
  calls: number;
  void_tasks: number;
  retried_tasks: number;
  session_reruns: number;
  dropped_families: number;
}

/** `rounds/RNN/tally.json` v2. */
export interface RoundTally {
  v: 2;
  round: string;
  benchmark: string;
  /** Kind of the row's champion the pairs were judged against (`champion.json`): baseline, owner_pick or golden. */
  champion: ChampionKind;
  session_pairs: number;
  champion_pairs: ChampionPairResult[];
  aux_pairs: AuxPairResult[];
  /** Bradley–Terry strengths (0.5 pseudo-counts) over the submissions and the aux-pair texts (aux calls only), for ordering only. */
  ordering: Record<string, number>;
  gate: Record<string, GateOutcome>;
  measures: Record<string, SubmissionMeasures>;
  voids: VoidCounts;
}

export interface RoundTallyInput {
  round: string;
  benchmark: string;
  /** Kind of the row's champion the pairs were judged against (`champion.json`): baseline, owner_pick or golden. */
  champion: ChampionKind;
  sessionPairs: number;
  barFourFamilies: 7 | 8;
  /** Submission id → label. */
  labels: Readonly<Record<string, string>>;
  championPairs: ReadonlyArray<{ pair: string; submission: string; sessions: readonly FamilySessions[] }>;
  auxPairs: ReadonlyArray<{ pair: string; kind: 'sub_sub' | 'anchor'; left: string; right: string; sessions: readonly FamilySessions[] }>;
  gate: Readonly<Record<string, GateOutcome>>;
  measures: Readonly<Record<string, SubmissionMeasures>>;
  voids: VoidCounts;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A call's pick in tally.ts position terms: the submission is text 1 in `fwd`, text 2 in `rev`; null = void or decoy preferred. */
function positionPick(call: SessionCall, submission: string): Pick | null {
  if (call.status !== 'ok' || call.preferredDecoy || call.decisive === null) return null;
  const pickedSubmission = call.decisive === submission;
  if (call.order === 'fwd') return pickedSubmission ? 1 : 2;
  return pickedSubmission ? 2 : 1;
}

/** Final session-pairs of one family as tally.ts SessionPairs; a dropped family always carries a void pair. */
function sessionPairsOf(fs: FamilySessions, submission: string): SessionPair[] {
  const out = fs.sessions.map(([a, b], index): SessionPair => {
    const fwd = a.order === 'fwd' ? a : b;
    const rev = a.order === 'fwd' ? b : a;
    const valid = fwd.order === 'fwd' && rev.order === 'rev';
    return { family: fs.family, index, forward: valid ? positionPick(fwd, submission) : null, reverse: valid ? positionPick(rev, submission) : null };
  });
  if (fs.dropped !== null && !out.some(isVoid)) out.push({ family: fs.family, index: out.length, forward: null, reverse: null });
  return out;
}

function championPairResult(
  pair: { pair: string; submission: string; sessions: readonly FamilySessions[] },
  input: RoundTallyInput,
): ChampionPairResult {
  const counted = pair.sessions.filter((fs) => !fs.shadow);
  const families = [...new Set(counted.map((fs) => fs.family))].sort(byCodeUnit);
  const sessions = counted.flatMap((fs) => sessionPairsOf(fs, pair.submission));
  const t = tallyChampionPair(sessions, families, { barFourFamilies: input.barFourFamilies });
  const e = [...t.eligible].sort(byCodeUnit);
  const n = e.reduce((sum, f) => sum + (t.pairsByFamily[f] ?? 0), 0);
  const winsByFamily: Record<string, number> = {};
  for (const f of e) winsByFamily[f] = t.winsByFamily[f] ?? 0;
  return {
    pair: pair.pair,
    submission: pair.submission,
    label: input.labels[pair.submission] ?? pair.submission,
    e,
    shadow: [...new Set(pair.sessions.filter((fs) => fs.shadow).map((fs) => fs.family))].sort(byCodeUnit),
    dropped: [...t.dropped].sort(byCodeUnit),
    wins_by_family: winsByFamily,
    total_wins: t.totalWins,
    needed: t.needed,
    bar: t.trial ? 'trial' : `${t.needed}/${e.length * input.sessionPairs}`,
    beats_champion: t.beatsChampion,
    trial: t.trial,
    signs: familySigns(t),
    p_value: binomialTailP(t.totalWins, n, 0.5),
  };
}

function auxPairResult(pair: RoundTallyInput['auxPairs'][number]): AuxPairResult {
  const calls = pair.sessions.flatMap((fs) => fs.sessions.flatMap(([a, b]) => [a, b]));
  const valid = calls.filter((c) => c.status === 'ok' && c.decisive !== null);
  return {
    pair: pair.pair,
    kind: pair.kind,
    left: pair.left,
    right: pair.right,
    wins_left: valid.filter((c) => c.decisive === pair.left).length,
    wins_right: valid.filter((c) => c.decisive === pair.right).length,
    families: [...new Set(pair.sessions.map((fs) => fs.family))].sort(byCodeUnit),
    void_calls: calls.length - valid.length,
  };
}

/** Code-unit sorted copy of a record, so the serialised tally never depends on input order. */
/** A copy of `rec` with its keys in code-unit order. */
export function sortedRecord<T>(rec: Readonly<Record<string, T>>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(rec).sort(byCodeUnit)) {
    const v = rec[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** Session-pairs per counted family the bars are defined for. */
const TALLY_SESSION_PAIRS = 2;

/**
 * tally.json v2: per champion pair E after void drops (shadow families never count), bars by |E| through
 * tallyChampionPair (|E| = 4 → barFourFamilies of 8, 3 → 6/6, ≤ 2 → trial), family sign counts and the
 * descriptive session-level binomial p (p = 0.5); aux pairs for ordering only (Bradley–Terry, 0.5 pseudo-counts,
 * over the submissions and the aux texts; only aux calls are comparisons, PROTOCOL §3, so the champion is not
 * ranked); measures and void counts as given.
 */
export function buildRoundTally(input: RoundTallyInput): RoundTally {
  // The bars (7/8 or 8/8 at |E| = 4, 6/6 at |E| = 3) and tallyChampionPair's `needed` are defined for exactly 2
  // session-pairs per family (PROTOCOL §1 擂台对); any other bars.session_pairs would silently loosen them.
  if (input.sessionPairs !== TALLY_SESSION_PAIRS) throw new IntegrityError(`PROTOCOL bars.session_pairs must be ${TALLY_SESSION_PAIRS}, got ${input.sessionPairs}`);
  const championPairs = input.championPairs.map((p) => championPairResult(p, input)).sort((a, b) => byCodeUnit(a.label, b.label) || byCodeUnit(a.pair, b.pair));
  const auxPairs = input.auxPairs.map(auxPairResult).sort((a, b) => byCodeUnit(a.pair, b.pair));
  const items = new Set<string>(input.championPairs.map((p) => p.submission));
  for (const p of auxPairs) {
    items.add(p.left);
    items.add(p.right);
  }
  const comparisons: Comparison[] = auxPairs.map((p) => ({ a: p.left, b: p.right, winsA: p.wins_left, winsB: p.wins_right }));
  return {
    v: 2,
    round: input.round,
    benchmark: input.benchmark,
    champion: input.champion,
    session_pairs: input.sessionPairs,
    champion_pairs: championPairs,
    aux_pairs: auxPairs,
    ordering: bradleyTerry([...items].sort(byCodeUnit), comparisons, 0.5),
    gate: sortedRecord(input.gate),
    measures: sortedRecord(input.measures),
    voids: { ...input.voids },
  };
}
