import type { Family } from '../config.ts';
import type { FreezeRecord } from '../freeze.ts';
import { seededShuffle } from '../store.ts';

/** Pinned in freeze.json (flags, eligible_families, gate_families). */
export interface FamilyState {
  family: Family;
  tasteQualified: boolean;
  gateQualified: boolean;
  flag: 'ok' | 'flagged' | 'suspended';
}

/** A judged text and its author families (8.1 / golden / revision-8 text counts as OpenAI; baseline = its writer's family). */
export interface JudgedText {
  id: string;
  authors: Family[];
}

export type Use = 'taste' | 'gate' | 'measure';

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Sorted by code unit, duplicates removed: every seeded pick starts from the same order. */
function sortedPool(pool: readonly Family[]): Family[] {
  return [...new Set(pool)].sort(byCodeUnit);
}

/**
 * The family states a freeze pins, for eligibleFamilies: taste-qualified = in `eligible_families` (ok and
 * canary-passing) or `flagged` (qualified, shadow only); gate-qualified = in `gate_families`; an `unqualified`
 * flag reads as a non-taste-qualified family with flag ok. Keys of `flags` are judge family names.
 */
export function familyStates(freeze: Pick<FreezeRecord, 'flags' | 'eligible_families' | 'gate_families'>, families: readonly Family[]): FamilyState[] {
  const out: FamilyState[] = [];
  for (const family of sortedPool(families)) {
    const pinned = Object.hasOwn(freeze.flags, family) ? freeze.flags[family] : undefined;
    const flag = pinned === 'flagged' || pinned === 'suspended' ? pinned : 'ok';
    const tasteQualified = pinned !== 'unqualified' && pinned !== undefined && (freeze.eligible_families.includes(family) || pinned === 'flagged');
    out.push({ family, tasteQualified, gateQualified: freeze.gate_families.includes(family), flag });
  }
  return out;
}

/** taste, measure: tasteQualified && flag ok; gate: gateQualified && flag !== suspended; always minus every author. */
export function eligibleFamilies(states: readonly FamilyState[], texts: readonly JudgedText[], use: Use): Family[] {
  const authors = new Set<Family>(texts.flatMap((t) => t.authors));
  const pool = states.filter((s) => (use === 'gate' ? s.gateQualified && s.flag !== 'suspended' : s.tasteQualified && s.flag === 'ok'));
  return sortedPool(pool.map((s) => s.family).filter((f) => !authors.has(f)));
}

/** seededShuffle(sorted pool, seed, key).slice(0, n). */
export function pickFamilies(pool: readonly Family[], n: number, seed: string, key: string): Family[] {
  if (!Number.isInteger(n) || n <= 0) return [];
  return seededShuffle(sortedPool(pool), seed, key).slice(0, n);
}

export interface GateRoles {
  /** First 2 in seeded order. */
  judges: Family[];
  /** The rest, in seeded order. */
  reserve: Family[];
}

/** Seeded order of the gate pool for one submission (key `gate:<submissionId>`): 2 judges, the rest reserve. */
export function gateRoles(pool: readonly Family[], seed: string, submissionId: string): GateRoles {
  const order = seededShuffle(sortedPool(pool), seed, `gate:${submissionId}`);
  return { judges: order.slice(0, 2), reserve: order.slice(2) };
}

export interface SurpriseRoles {
  matchers: Family[];
  chainWriter: Family | null;
  acceptor: Family | null;
  acceptorReused: boolean;
  status: 'full' | 'reused' | 'match_only' | 'insufficient';
}

/**
 * Seeded order (key `surprise:<submissionId>`): 4 eligible → full (matchers, chain writer, acceptor); 3 → reused
 * (acceptor = a fresh session of matchers[0]); 2 → match_only; ≤ 1 → insufficient (no roles). The acceptor's
 * exclusion of families quoted in a chain is applied by 07b on the pool it passes in.
 */
export function surpriseRoles(pool: readonly Family[], seed: string, submissionId: string): SurpriseRoles {
  const order = seededShuffle(sortedPool(pool), seed, `surprise:${submissionId}`);
  const [a, b, c, d] = order;
  if (a === undefined || b === undefined) return { matchers: [], chainWriter: null, acceptor: null, acceptorReused: false, status: 'insufficient' };
  if (c === undefined) return { matchers: [a, b], chainWriter: null, acceptor: null, acceptorReused: false, status: 'match_only' };
  if (d === undefined) return { matchers: [a, b], chainWriter: c, acceptor: a, acceptorReused: true, status: 'reused' };
  return { matchers: [a, b], chainWriter: c, acceptor: d, acceptorReused: false, status: 'full' };
}
