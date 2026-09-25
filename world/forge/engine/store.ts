import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface RoundPaths {
  root: string;
  id: string;
  dir: string;
  runs: string;
  calls: string;
  submissions: string;
  taste: string;
  progress: string;
}

export function roundPaths(root: string, id: string): RoundPaths {
  if (!/^[A-Z]\d{2}$/u.test(id)) throw new Error(`round id must look like P01 or R01, got ${id}`);
  const dir = join(root, 'rounds', id);
  return {
    root,
    id,
    dir,
    runs: join(root, '.runs', id),
    calls: join(dir, 'calls'),
    submissions: join(dir, 'submissions'),
    taste: join(dir, 'taste'),
    progress: join(dir, 'progress.jsonl'),
  };
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return v;
  } catch {
    return null;
  }
}

export function appendLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

export function readLines(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const out: unknown[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const v: unknown = JSON.parse(line);
      out.push(v);
    } catch {
      // a torn last line is ignored
    }
  }
  return out;
}

export type ProgressStatus = 'start' | 'done' | 'error' | 'info';

export function progress(paths: RoundPaths, step: string, status: ProgressStatus, detail: string): void {
  appendLine(paths.progress, { at: new Date().toISOString(), step, status, detail });
}

/** Deterministic value in [0, 1) derived from the round seed and a key. */
export function seeded(seed: string, key: string): number {
  const h = createHash('sha256').update(`${seed}\u0000${key}`).digest();
  return h.readUInt32BE(0) / 0x1_0000_0000;
}

export function seededShuffle<T>(items: readonly T[], seed: string, key: string): T[] {
  return items
    .map((item, i) => ({ item, r: seeded(seed, `${key}:${i}`) }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.item);
}
