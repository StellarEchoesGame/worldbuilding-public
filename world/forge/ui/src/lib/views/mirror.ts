import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pendingMirrors, type QueuedKind } from '../../../../engine/mirror.ts';
import { readMirrorLog, type MirrorKind } from '../../../../engine/mirror-log.ts';

export interface MirrorItemView {
  kind: QueuedKind;
  key: string;
  failures: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  /** First 600 characters of the body (already public-scan material). */
  preview: string;
}

/** A posted comment from rounds/<R>/mirror.jsonl (probe included). */
export interface MirrorPostedView {
  kind: MirrorKind;
  key: string;
  createdAt: string | null;
  url: string | null;
}

export interface MirrorPageView {
  /** Rounds with a pending mirror, a posted entry or an error, in id order. */
  rounds: Array<{ round: string; items: MirrorItemView[]; posted: MirrorPostedView[]; error: string | null }>;
  /** Retry spawns the real CLI, so only on real data (isRealData()); otherwise the reason. */
  retryDisabled: string | null;
}

export const PREVIEW_CHARS = 600;

export function mirrorView(root: string, now: string, realData: boolean): MirrorPageView {
  const retryDisabled = realData ? null : '这是夹具数据目录：重试会启动真实的 forge mirror，只在真实数据目录上可用。';
  const dir = join(root, 'rounds');
  if (!existsSync(dir)) return { rounds: [], retryDisabled };
  const rounds: MirrorPageView['rounds'] = [];
  for (const round of readdirSync(dir).filter((n) => /^[A-Z]\d{2}$/u.test(n)).sort()) {
    const errors: string[] = [];
    const log = readMirrorLog(root, round);
    if (!log.ok) errors.push(log.error);
    const posted = (log.ok ? log.value : [])
      .filter((e) => e.status === 'posted')
      .map((e) => ({ kind: e.kind, key: e.key, createdAt: e.created_at, url: e.url }));
    const pending = pendingMirrors(root, round, now);
    if (!pending.ok && !errors.includes(pending.error)) errors.push(pending.error);
    const items = (pending.ok ? pending.value : []).map((p) => ({
      kind: p.kind, key: p.key, failures: p.failures, lastError: p.lastError, nextAttemptAt: p.nextAttemptAt, preview: [...p.body].slice(0, PREVIEW_CHARS).join(''),
    }));
    const error = errors.length === 0 ? null : errors.join('；');
    if (items.length > 0 || posted.length > 0 || error !== null) rounds.push({ round, items, posted, error });
  }
  return { rounds, retryDisabled };
}
