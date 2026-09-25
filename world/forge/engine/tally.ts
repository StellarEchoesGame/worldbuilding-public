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
  for (const f of eligible) winsByFamily[f] = sessions.filter((s) => s.family === f && isWin(s)).length;
  const totalWins = eligible.reduce((sum, f) => sum + (winsByFamily[f] ?? 0), 0);
  const trial = eligible.length <= 2;
  const needed = eligible.length >= 4 ? opts.barFourFamilies : eligible.length * 2;
  return { eligible, dropped, winsByFamily, totalWins, needed, beatsChampion: !trial && totalWins >= needed, trial };
}
