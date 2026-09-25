import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RoundFiles, StepContext } from './context.ts';
import { isRecord, type JsonRecord } from './json.ts';
import { err, ok, type Result } from './result.ts';
import { isStepId, type StepId } from './runner.ts';

export type MarkerResult = 'done' | 'skip' | 'waiting' | 'rewind';

/**
 * `markers/<step>.json`. Map keys are forge-root-relative paths sorted by code unit; values are SHA-256 of the
 * file bytes (`.sealed/` outputs: SHA-256(nonce ‖ bytes)). `external` is recorded, never verified; `local`
 * (`.sealed/`, `.runs/`) is verified only where the files exist. Engine logs are never listed.
 */
export interface Marker {
  v: 1;
  round: string;
  step: StepId;
  completed_at: string;
  result: MarkerResult;
  /** Skip reason, else null. */
  skipped: string | null;
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  external: Record<string, string>;
  local: Record<string, string>;
  tasks: { ok: number; void: number; calls: number };
  /** SHA-256 of the previous marker file's bytes in pipeline order; null for the first step. */
  prev: string | null;
}

/** Step id → round-dir-relative paths that step may re-list with a new hash (the latest listing wins). */
export const ALLOWED_AMENDMENTS: Readonly<Record<string, readonly string[]>> = {
  '03c-probe-mirror': ['freeze.json'],
};

/**
 * The SHA-256 the round-dir-relative `rel` had before `step` amended it, or null when `bytes` are not such an
 * amendment. 03c only sets freeze.json's `probe_created_at` (null → a timestamp) through writeJson, so the
 * pre-amendment bytes are the same JSON with that key null. verifyChain uses it for a kill between the amendment
 * and the amending step's marker; the step re-checks the amended value when it reruns.
 */
export function preAmendmentSha256(step: string, rel: string, bytes: Uint8Array): string | null {
  if (step !== '03c-probe-mirror' || rel !== 'freeze.json') return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value['probe_created_at'] !== 'string') return null;
  return sha256Bytes(Buffer.from(`${JSON.stringify({ ...value, probe_created_at: null }, null, 2)}\n`, 'utf8'));
}

const HEX64 = /^[0-9a-f]{64}$/u;
const RESULTS: readonly MarkerResult[] = ['done', 'skip', 'waiting', 'rewind'];
const KEYS: readonly string[] = ['v', 'round', 'step', 'completed_at', 'result', 'skipped', 'inputs', 'outputs', 'external', 'local', 'tasks', 'prev'];
const TASK_KEYS: readonly string[] = ['ok', 'void', 'calls'];

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** SHA-256(nonce ‖ bytes): how `.sealed/` files appear in tracked markers (equals the probe for sealed.json). */
export function sealedSha256(nonce: Uint8Array, bytes: Uint8Array): string {
  return createHash('sha256').update(nonce).update(bytes).digest('hex');
}

/** `.sealed/` and `.runs/` paths (git-ignored) are listed under `local`. */
export function isLocalPath(rel: string): boolean {
  return rel.startsWith('.sealed/') || rel.startsWith('.runs/');
}

/** `.sealed/<id>` when `rel` is a sealed file hashed with that directory's nonce (nonce.hex itself is hashed plainly). */
function sealedDir(rel: string): string | null {
  const parts = rel.split('/');
  if (parts[0] !== '.sealed' || parts.length < 3) return null;
  const dir = `.sealed/${parts[1] ?? ''}`;
  return rel === `${dir}/nonce.hex` ? null : dir;
}

/**
 * The hash a marker records for the forge-root-relative `rel`: null when the file is absent; err when a sealed
 * file has no readable `nonce.hex` next to it.
 */
export function hashListed(root: string, rel: string): Result<string> | null {
  const abs = join(root, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  const bytes = readFileSync(abs);
  const dir = sealedDir(rel);
  if (dir === null) return ok(sha256Bytes(bytes));
  const noncePath = join(root, dir, 'nonce.hex');
  if (!existsSync(noncePath)) return err(`${rel}: sealed file listed without ${dir}/nonce.hex`);
  const hex = readFileSync(noncePath, 'utf8').trim();
  if (!HEX64.test(hex)) return err(`${dir}/nonce.hex: expected 64 lowercase hex digits`);
  return ok(sealedSha256(Buffer.from(hex, 'hex'), bytes));
}

function sortedMap(map: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(map).sort(byCodeUnit)) {
    const value = map[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The canonical marker bytes: fixed key order, maps sorted by code unit, two-space JSON + LF. */
export function markerText(m: Marker): string {
  const canonical = {
    v: m.v,
    round: m.round,
    step: m.step,
    completed_at: m.completed_at,
    result: m.result,
    skipped: m.skipped,
    inputs: sortedMap(m.inputs),
    outputs: sortedMap(m.outputs),
    external: sortedMap(m.external),
    local: sortedMap(m.local),
    tasks: { ok: m.tasks.ok, void: m.tasks.void, calls: m.tasks.calls },
    prev: m.prev,
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

function hashMap(value: unknown, key: string): Result<Record<string, string>> {
  if (!isRecord(value)) return err(`marker.${key}: expected an object`);
  const out: Record<string, string> = {};
  for (const [path, hash] of Object.entries(value)) {
    if (path === '' || path.startsWith('/')) return err(`marker.${key}: expected forge-root-relative paths`);
    if (typeof hash !== 'string' || !HEX64.test(hash)) return err(`marker.${key}.${path}: expected a lowercase SHA-256 hex digest`);
    out[path] = hash;
  }
  return ok(out);
}

function count(value: JsonRecord, key: string): number | null {
  const v = value[key];
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

function isResult(value: unknown): value is MarkerResult {
  return RESULTS.some((r) => r === value);
}

/** Narrows parsed marker JSON (schema/marker.schema.json plus the checks the schema subset cannot express). */
export function parseMarker(value: unknown): Result<Marker> {
  if (!isRecord(value)) return err('marker: expected an object');
  const extra = Object.keys(value).find((k) => !KEYS.includes(k));
  if (extra !== undefined) return err(`marker: unexpected key ${extra}`);
  const { v, round, step, completed_at: completedAt, result, skipped, tasks, prev } = value;
  if (v !== 1) return err('marker.v: expected 1');
  if (typeof round !== 'string' || round === '') return err('marker.round: expected a non-empty string');
  if (typeof step !== 'string' || !isStepId(step)) return err('marker.step: expected a step id');
  if (typeof completedAt !== 'string' || completedAt === '') return err('marker.completed_at: expected a timestamp');
  if (!isResult(result)) return err('marker.result: expected done, skip, waiting or rewind');
  if (skipped !== null && typeof skipped !== 'string') return err('marker.skipped: expected a string or null');
  if (prev !== null && (typeof prev !== 'string' || !HEX64.test(prev))) return err('marker.prev: expected a SHA-256 hex digest or null');
  const maps: Array<Record<string, string>> = [];
  for (const key of ['inputs', 'outputs', 'external', 'local']) {
    const map = hashMap(value[key], key);
    if (!map.ok) return err(map.error);
    maps.push(map.value);
  }
  const [inputs, outputs, external, local] = maps;
  if (inputs === undefined || outputs === undefined || external === undefined || local === undefined) return err('marker: maps missing');
  if (!isRecord(tasks) || Object.keys(tasks).some((k) => !TASK_KEYS.includes(k))) return err('marker.tasks: expected {ok, void, calls}');
  const okCount = count(tasks, 'ok');
  const voidCount = count(tasks, 'void');
  const calls = count(tasks, 'calls');
  if (okCount === null || voidCount === null || calls === null) return err('marker.tasks: expected non-negative integers');
  return ok({ v: 1, round, step, completed_at: completedAt, result, skipped, inputs, outputs, external, local, tasks: { ok: okCount, void: voidCount, calls }, prev });
}

/** null when the marker file is absent; err when it exists but is not a valid marker. */
export function readMarker(path: string): Result<Marker> | null {
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return err(`${path}: not JSON`);
  }
  return parseMarker(value);
}

/** Writes canonical marker bytes through RoundFiles; returns the SHA-256 of the written bytes. */
export function writeMarker(files: RoundFiles, path: string, m: Marker): string {
  const text = markerText(m);
  files.writeText(path, text);
  return sha256Bytes(Buffer.from(text, 'utf8'));
}

/**
 * Mismatches of `m` against the tree under `root`; `latestHash` maps a path to the hash in the latest marker
 * listing it (amendment rule), so an amended file is checked only against its latest listing.
 */
export function verifyMarker(root: string, m: Marker, latestHash: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  const check = (path: string, listed: string, required: boolean): void => {
    const actual = hashListed(root, path);
    if (actual === null) {
      if (required) problems.push(`${path}: listed in a marker but missing`);
      return;
    }
    if (!actual.ok) problems.push(actual.error);
    else if (actual.value !== (latestHash.get(path) ?? listed)) problems.push(`${path}: content does not match its marker hash`);
  };
  for (const [path, hash] of Object.entries(m.inputs)) check(path, hash, true);
  for (const [path, hash] of Object.entries(m.outputs)) check(path, hash, true);
  for (const [path, hash] of Object.entries(m.local)) check(path, hash, false);
  return problems;
}

/** Read-only precondition check: a final (`done` or `skip`) marker for `id` exists in this round. */
export function isDone(ctx: StepContext, id: StepId): boolean {
  const m = readMarker(join(ctx.paths.markers, `${id}.json`));
  return m !== null && m.ok && (m.value.result === 'done' || m.value.result === 'skip');
}
