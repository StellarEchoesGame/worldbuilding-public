import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { err, ok, type Result } from './result.ts';

export interface RoundPaths {
  root: string;
  id: string;
  dir: string;
  runs: string;
  calls: string;
  submissions: string;
  taste: string;
  progress: string;
  /** Done-markers `markers/<step>.json`; rewound or redone markers move to `markers/stale/<n>/`. */
  markers: string;
  /** Task records `tasks/<taskId>.json`. */
  tasks: string;
  gate: string;
  measures: string;
  merge: string;
  bookkeeping: string;
  bench: string;
  status: string;
  start: string;
  topic: string;
  brief: string;
  freeze: string;
  /** `probes.sha256` (probe hex + LF). */
  probes: string;
  /** `<root>/.sealed/<id>` (git-ignored). */
  sealed: string;
  /** `<root>/.sealed/<id>/tasks`; sealed call records go to `<root>/.sealed/<id>/calls`. */
  sealedTasks: string;
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
    markers: join(dir, 'markers'),
    tasks: join(dir, 'tasks'),
    gate: join(dir, 'gate'),
    measures: join(dir, 'measures'),
    merge: join(dir, 'merge'),
    bookkeeping: join(dir, 'bookkeeping'),
    bench: join(dir, 'bench'),
    status: join(dir, 'status.json'),
    start: join(dir, 'start.json'),
    topic: join(dir, 'topic.json'),
    brief: join(dir, 'brief.json'),
    freeze: join(dir, 'freeze.json'),
    probes: join(dir, 'probes.sha256'),
    sealed: join(root, '.sealed', id),
    sealedTasks: join(root, '.sealed', id, 'tasks'),
  };
}

/** ISO 8601 UTC as the engine's clocks and GitHub write it (`YYYY-MM-DDTHH:MM:SS[.fff]Z`) and a real date. */
export function isIsoTimestamp(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(text) && !Number.isNaN(Date.parse(text));
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

/**
 * Appends JSON lines to an engine log in one write: a torn tail (last line without `\n`) is cut first,
 * and the file is re-read afterwards to confirm the batch landed. Engine logs only (progress, mirror, bench log).
 */
export function appendRecords(path: string, values: readonly unknown[]): void {
  if (values.length === 0) return;
  const data = values.map((value) => `${jsonLine(value)}\n`).join('');
  mkdirSync(dirname(path), { recursive: true });
  cutTornTail(path);
  appendFileSync(path, data);
  const want = Buffer.from(data, 'utf8');
  if (!tailBytes(path, want.length).equals(want)) throw new Error(`appendRecords: ${path}: the appended batch is not at the end of the file`);
}

function jsonLine(value: unknown): string {
  const text: unknown = JSON.stringify(value);
  if (typeof text !== 'string') throw new TypeError('appendRecords: value is not JSON-serialisable');
  return text;
}

/** Truncates a last line that lacks its LF (a write torn by a crash); complete lines are never touched. */
function cutTornTail(path: string): void {
  if (!existsSync(path)) return;
  const size = statSync(path).size;
  if (size === 0 || tailBytes(path, 1)[0] === 0x0a) return;
  truncateSync(path, readFileSync(path).lastIndexOf(0x0a) + 1);
}

function tailBytes(path: string, n: number): Buffer {
  const size = statSync(path).size;
  const len = Math.min(n, size);
  const out = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, out, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  return out;
}

/**
 * Reads an engine log (JSON lines). A missing file is empty; a last line without LF is a torn tail and is
 * ignored (appendRecords cuts it); any other line that is not JSON is an error (integrity, exit 3).
 */
export function readRecords(path: string): Result<unknown[]> {
  if (!existsSync(path)) return ok([]);
  const lines = readFileSync(path, 'utf8').split('\n');
  lines.pop();
  const out: unknown[] = [];
  for (const [i, line] of lines.entries()) {
    try {
      const v: unknown = JSON.parse(line);
      out.push(v);
    } catch {
      return err(`${path}: line ${i + 1} is not a JSON record`);
    }
  }
  return ok(out);
}

/**
 * Exclusive create: false when the file already exists (nothing written). The text goes to a tmp file first and
 * is hard-linked into place (link fails on an existing target, like `wx`), so a crash never leaves a partial file
 * that wins the race.
 */
export function createExclusive(path: string, text: string): boolean {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { flag: 'wx' });
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'EEXIST') return false;
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Atomic rename; false when `from` is already gone (another process moved or removed it first). */
export function moveFileIfPresent(from: string, to: string): boolean {
  try {
    renameSync(from, to);
    return true;
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return false;
    throw e;
  }
}

/** Deletes a file when present. */
export function removeFile(path: string): void {
  rmSync(path, { force: true });
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

export function progress(paths: RoundPaths, step: string, status: ProgressStatus, detail: string, at?: string): void {
  appendRecords(paths.progress, [{ at: at ?? new Date().toISOString(), step, status, detail }]);
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
