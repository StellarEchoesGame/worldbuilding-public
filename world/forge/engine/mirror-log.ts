import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RoundFiles } from './context.ts';
import { isRecord } from './json.ts';
import { err, ok, type Result } from './result.ts';
import { isIsoTimestamp, readRecords } from './store.ts';

export type MirrorKind = 'probe' | 'card' | 'decision' | 'bench_notice' | 'diff_approval';

export type MirrorStatus = 'posted' | 'failed' | 'rejected_scan';

/** One line of `rounds/RNN/mirror.jsonl` (git-ignored local log; never listed in markers). */
export interface MirrorEntry {
  at: string;
  kind: MirrorKind;
  /** round, decision sha256, benchmark version / cycle, or diff sha256. */
  key: string;
  source_sha256: string;
  status: MirrorStatus;
  comment_id: number | null;
  /** GitHub created_at of the posted comment. */
  created_at: string | null;
  url: string | null;
  /** Redacted error, else null. */
  error: string | null;
}

const KINDS: readonly MirrorKind[] = ['probe', 'card', 'decision', 'bench_notice', 'diff_approval'];
const STATUSES: readonly MirrorStatus[] = ['posted', 'failed', 'rejected_scan'];
const HEX64 = /^[0-9a-f]{64}$/u;
const ROUND_ID = /^[A-Z]\d{2}$/u;

function mirrorPath(root: string, round: string): string {
  if (!ROUND_ID.test(round)) throw new Error(`mirror log: round id must look like R01, got ${JSON.stringify(round)}`);
  return join(root, 'rounds', round, 'mirror.jsonl');
}

function isKind(value: unknown): value is MirrorKind {
  return KINDS.some((k) => k === value);
}

function isStatus(value: unknown): value is MirrorStatus {
  return STATUSES.some((s) => s === value);
}

function stringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** Narrows one mirror.jsonl record; a posted entry must carry comment_id, created_at and url. */
export function parseMirrorEntry(value: unknown): Result<MirrorEntry> {
  if (!isRecord(value)) return err('mirror entry: expected an object');
  const { at, kind, key, source_sha256: source, status, comment_id: commentId, created_at: createdAt, url, error } = value;
  if (typeof at !== 'string' || !isIsoTimestamp(at)) return err('mirror entry.at: expected an ISO 8601 UTC timestamp');
  if (!isKind(kind)) return err('mirror entry.kind: unknown kind');
  if (typeof key !== 'string' || key === '') return err('mirror entry.key: expected a non-empty string');
  if (typeof source !== 'string' || !HEX64.test(source)) return err('mirror entry.source_sha256: expected a SHA-256 hex digest');
  if (!isStatus(status)) return err('mirror entry.status: expected posted, failed or rejected_scan');
  if (commentId !== null && (typeof commentId !== 'number' || !Number.isInteger(commentId) || commentId < 1)) return err('mirror entry.comment_id: expected a positive integer or null');
  if (!stringOrNull(createdAt) || (createdAt !== null && !isIsoTimestamp(createdAt))) return err('mirror entry.created_at: expected an ISO timestamp or null');
  if (!stringOrNull(url) || !stringOrNull(error)) return err('mirror entry: url and error must be strings or null');
  if (status === 'posted' && (commentId === null || createdAt === null || url === null)) return err('mirror entry: a posted entry needs comment_id, created_at and url');
  return ok({ at, kind, key, source_sha256: source, status, comment_id: commentId, created_at: createdAt, url, error });
}

/** Appends through files.appendLine (torn tail cut first). */
export function appendMirrorEntry(files: RoundFiles, round: string, e: MirrorEntry): void {
  const checked = parseMirrorEntry(e);
  if (!checked.ok) throw new Error(checked.error);
  files.appendLine(mirrorPath(files.root, round), checked.value);
}

/** Missing file → ok([]); torn last line ignored. */
export function readMirrorLog(root: string, round: string): Result<MirrorEntry[]> {
  const path = mirrorPath(root, round);
  const records = readRecords(path);
  if (!records.ok) return err(`rounds/${round}/mirror.jsonl: ${records.error.replace(path, '').replace(/^:\s*/u, '')}`);
  const out: MirrorEntry[] = [];
  for (const [i, record] of records.value.entries()) {
    const e = parseMirrorEntry(record);
    if (!e.ok) return err(`rounds/${round}/mirror.jsonl line ${i + 1}: ${e.error}`);
    out.push(e.value);
  }
  return ok(out);
}

/** created_at of the latest `posted` entry for (kind, key), else null. */
export function mirroredAt(root: string, round: string, kind: MirrorKind, key: string): string | null {
  const log = readMirrorLog(root, round);
  if (!log.ok) return null;
  let found: string | null = null;
  for (const e of log.value) if (e.status === 'posted' && e.kind === kind && e.key === key && e.created_at !== null) found = e.created_at;
  return found;
}

/** Every posted bench_notice across rounds (R00 included): the only start of the 24 h auto clock. */
export function postedBenchNotices(root: string): Array<{ version: string; createdAt: string }> {
  const dir = join(root, 'rounds');
  if (!existsSync(dir)) return [];
  const first = new Map<string, string>();
  for (const round of readdirSync(dir).filter((name) => ROUND_ID.test(name)).sort()) {
    const log = readMirrorLog(root, round);
    if (!log.ok) continue;
    for (const e of log.value) {
      if (e.kind !== 'bench_notice' || e.status !== 'posted' || e.created_at === null) continue;
      const was = first.get(e.key);
      if (was === undefined || Date.parse(e.created_at) < Date.parse(was)) first.set(e.key, e.created_at);
    }
  }
  return [...first.entries()]
    .map(([version, createdAt]) => ({ version, createdAt }))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
}
