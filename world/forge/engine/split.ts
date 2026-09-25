import { seededShuffle } from './store.ts';

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The one visible / reserve splitter (plan §3.7 #12): rounds use key `labels:split` with visible = protocol
 * calibration.audit_visible (2 of 4) at 09a, before any answer; round 0 calls it per category (3 / 3).
 * ids sorted by code unit, then store.ts seededShuffle(seed, key); the first `visible` ids are visible (all of
 * them when there are fewer). The result is keyed in code-unit id order, so it never depends on the input order.
 */
export function seededSplit(ids: readonly string[], seed: string, key: string, visible: number): Record<string, 'visible' | 'reserve'> {
  if (!Number.isInteger(visible) || visible < 0) throw new RangeError(`seededSplit: visible must be a non-negative integer, got ${visible}`);
  const sorted = [...ids].sort(byCodeUnit);
  for (const [i, id] of sorted.entries()) if (i > 0 && sorted[i - 1] === id) throw new RangeError(`seededSplit: duplicate id ${id}`);
  const shown = new Set(seededShuffle(sorted, seed, key).slice(0, visible));
  const out: Record<string, 'visible' | 'reserve'> = {};
  for (const id of sorted) out[id] = shown.has(id) ? 'visible' : 'reserve';
  return out;
}
