import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isFamily, type Family } from './config.ts';
import type { RoundFiles } from './context.ts';
import { isRecord, readBoolean, readNumber, readRecord, readString, stringArray, type JsonRecord } from './json.ts';
import { err, ok, type Result } from './result.ts';
import { loadSchema, type Schema, schemaFile, validate } from './schema.ts';
import { readRecords } from './store.ts';

export type BenchOutcome = 'activate' | 'pending_owner' | 'no_change' | 'no_change_invalid' | 'rejected_validate' | 'rejected_by_replay';

export type BenchActivation = 'auto' | 'replay' | 'owner';

/** Replay result stored in the log (bench-replay.ts in PR-E re-exports this type). */
export interface ReplaySummary {
  labels: string[];
  families: Family[];
  pooled: { old: number; new: number; n: number };
  per_family: Record<string, { old: number; new: number; n: number; void: number }>;
  passed: boolean;
  reason: 'ok' | 'pooled_lower' | 'family_drop' | 'too_few_pairs';
}

export interface BenchLogReason {
  text: string;
  keys: string[];
  evidence_ids: string[];
}

/** One `benchmark/log.jsonl` line; at most one entry per `cycle` ('R03' | 'R00-init' | 'R00'). */
export interface BenchLogEntry {
  at: string;
  cycle: string;
  outcome: BenchOutcome;
  /** Candidate version; null for no_change / no_change_invalid. */
  version: string | null;
  /** Head version the proposal was built on (null only for v1). */
  parent: string | null;
  /** SHA-256 of the candidate bytes. */
  sha256: string | null;
  /** 'benchmark/v4.json' or 'rounds/R03/bench/candidate.json'. */
  path: string | null;
  /** After the rollback-hold upgrade. */
  activation: BenchActivation | null;
  changed_keys: string[];
  evidence_packet: string | null;
  evidence_packet_sha256: string | null;
  evidence_ids: string[];
  reasons: BenchLogReason[];
  errors: string[];
  replay: ReplaySummary | null;
  dropped_cliches: string[];
  protocol_bundle_sha256: string;
  calls: string[];
  source: 'engine';
}

export interface VersionRef {
  version: string;
  sha256: string;
  /** Forge-root-relative, e.g. 'benchmark/v2.json'. */
  path: string;
}

/** Forge-root-relative path of the log. */
export const BENCH_LOG = 'benchmark/log.jsonl';
/** Evidence packets live beside the log (bench-evidence.ts); the path helper sits here so steps/start.ts needs no cycle. */
export const EVIDENCE_DIR = 'benchmark/evidence';

/** `benchmark/evidence/<round>.json` (forge-root-relative). */
export function evidencePath(round: string): string {
  return `${EVIDENCE_DIR}/${round}.json`;
}

/** Maintainer lineage versions (`v0.json` and `v0.1-prototype` are outside it). */
export const VERSION_ID = /^v[1-9]\d*$/u;

const OUTCOMES: readonly BenchOutcome[] = ['activate', 'pending_owner', 'no_change', 'no_change_invalid', 'rejected_validate', 'rejected_by_replay'];
const ACTIVATIONS: readonly BenchActivation[] = ['auto', 'replay', 'owner'];
const REPLAY_REASONS: readonly ReplaySummary['reason'][] = ['ok', 'pooled_lower', 'family_drop', 'too_few_pairs'];

function isOutcome(value: string): value is BenchOutcome {
  return OUTCOMES.some((o) => o === value);
}

function isActivation(value: string): value is BenchActivation {
  return ACTIVATIONS.some((a) => a === value);
}

function isReplayReason(value: string): value is ReplaySummary['reason'] {
  return REPLAY_REASONS.some((r) => r === value);
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

let cachedSchema: Schema | null = null;

/** The engine's copy of schema/bench-log.schema.json (module-relative, so temp forge roots need no schema dir). */
function logSchema(): Schema {
  if (cachedSchema !== null) return cachedSchema;
  const raw: unknown = JSON.parse(readFileSync(schemaFile('bench-log.schema.json'), 'utf8'));
  const schema = loadSchema(raw);
  if (!schema.ok) throw new Error(`schema/bench-log.schema.json: ${schema.error}`);
  cachedSchema = schema.value;
  return schema.value;
}

function strings(value: JsonRecord, key: string): string[] {
  return stringArray(value[key]) ?? [];
}

function count(value: unknown, key: string): number | null {
  const n = readNumber(value, key);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
}

function narrowReplay(value: JsonRecord): Result<ReplaySummary> {
  const families: Family[] = [];
  for (const f of strings(value, 'families')) if (isFamily(f)) families.push(f);
  const pooledRaw = readRecord(value, 'pooled');
  const pooled = { old: count(pooledRaw, 'old'), new: count(pooledRaw, 'new'), n: count(pooledRaw, 'n') };
  const reason = readString(value, 'reason');
  const passed = readBoolean(value, 'passed');
  if (pooled.old === null || pooled.new === null || pooled.n === null || reason === null || !isReplayReason(reason) || passed === null) {
    return err('replay: malformed summary');
  }
  const perFamily: ReplaySummary['per_family'] = {};
  for (const [family, v] of Object.entries(readRecord(value, 'per_family') ?? {})) {
    const row = { old: count(v, 'old'), new: count(v, 'new'), n: count(v, 'n'), void: count(v, 'void') };
    if (!isFamily(family)) return err(`replay.per_family: unknown family ${family}`);
    if (row.old === null || row.new === null || row.n === null || row.void === null || !isRecord(v) || Object.keys(v).length !== 4) {
      return err(`replay.per_family.${family}: expected exactly old, new, n and void as non-negative integers`);
    }
    perFamily[family] = { old: row.old, new: row.new, n: row.n, void: row.void };
  }
  return ok({ labels: strings(value, 'labels'), families, pooled: { old: pooled.old, new: pooled.new, n: pooled.n }, per_family: perFamily, passed, reason });
}

/** Schema check, narrowing, and the per-line rules the schema subset cannot express. */
function parseEntry(value: unknown): Result<BenchLogEntry> {
  const errors = validate(logSchema(), value);
  if (errors.length > 0) return err(errors.join('; '));
  if (!isRecord(value)) return err('expected an object');
  const at = readString(value, 'at');
  const cycle = readString(value, 'cycle');
  const outcome = readString(value, 'outcome');
  const activation = readString(value, 'activation');
  const bundle = readString(value, 'protocol_bundle_sha256');
  if (at === null || cycle === null || outcome === null || !isOutcome(outcome) || bundle === null) return err('malformed entry');
  if (activation !== null && !isActivation(activation)) return err(`unknown activation ${activation}`);
  let replay: ReplaySummary | null = null;
  const replayRaw = readRecord(value, 'replay');
  if (replayRaw !== null) {
    const parsed = narrowReplay(replayRaw);
    if (!parsed.ok) return parsed;
    replay = parsed.value;
  }
  const reasons: BenchLogReason[] = [];
  for (const r of Array.isArray(value['reasons']) ? value['reasons'] : []) {
    const text = readString(r, 'text');
    if (!isRecord(r) || text === null) return err('reasons: malformed item');
    reasons.push({ text, keys: strings(r, 'keys'), evidence_ids: strings(r, 'evidence_ids') });
  }
  const entry: BenchLogEntry = {
    at,
    cycle,
    outcome,
    version: readString(value, 'version'),
    parent: readString(value, 'parent'),
    sha256: readString(value, 'sha256'),
    path: readString(value, 'path'),
    activation,
    changed_keys: strings(value, 'changed_keys'),
    evidence_packet: readString(value, 'evidence_packet'),
    evidence_packet_sha256: readString(value, 'evidence_packet_sha256'),
    evidence_ids: strings(value, 'evidence_ids'),
    reasons,
    errors: strings(value, 'errors'),
    replay,
    dropped_cliches: strings(value, 'dropped_cliches'),
    protocol_bundle_sha256: bundle,
    calls: strings(value, 'calls'),
    source: 'engine',
  };
  const problem = entryProblem(entry);
  return problem === null ? ok(entry) : err(problem);
}

function entryProblem(e: BenchLogEntry): string | null {
  if (e.outcome === 'activate' || e.outcome === 'pending_owner') {
    if (e.version === null || e.sha256 === null || e.path === null || e.activation === null) return `${e.outcome} needs version, sha256, path and activation`;
    if (e.path !== `benchmark/${e.version}.json`) return `${e.outcome} path must be benchmark/${e.version}.json`;
    if ((e.outcome === 'pending_owner') !== (e.activation === 'owner')) return `${e.outcome} cannot have activation ${e.activation}`;
  }
  if (e.outcome === 'rejected_by_replay' && (e.replay === null || e.replay.passed)) return 'rejected_by_replay needs a failed replay';
  return null;
}

/**
 * Rejects schema violations (unknown outcomes, non-hex hashes, …), duplicate cycles, reused version numbers and
 * an `at` that goes backwards (equal timestamps are allowed; log order breaks ties).
 */
export function parseBenchLog(lines: readonly unknown[]): Result<BenchLogEntry[]> {
  const out: BenchLogEntry[] = [];
  const cycles = new Set<string>();
  const versions = new Set<string>();
  let lastMs = Number.NEGATIVE_INFINITY;
  for (const [i, line] of lines.entries()) {
    const parsed = parseEntry(line);
    if (!parsed.ok) return err(`line ${i + 1}: ${parsed.error}`);
    const e = parsed.value;
    if (cycles.has(e.cycle)) return err(`line ${i + 1}: duplicate cycle ${e.cycle}`);
    if (e.version !== null && versions.has(e.version)) return err(`line ${i + 1}: version ${e.version} is already logged (version numbers are burned)`);
    const ms = Date.parse(e.at);
    if (Number.isNaN(ms)) return err(`line ${i + 1}: at is not a timestamp`);
    if (ms < lastMs) return err(`line ${i + 1}: at ${e.at} is earlier than the previous line`);
    cycles.add(e.cycle);
    if (e.version !== null) versions.add(e.version);
    lastMs = ms;
    out.push(e);
  }
  return ok(out);
}

/** Missing file → ok([]); a torn last line is dropped; a bad middle line → err. */
export function readBenchLog(root: string): Result<BenchLogEntry[]> {
  const path = join(root, BENCH_LOG);
  const lines = readRecords(path);
  if (!lines.ok) return err(lines.error.split(path).join(BENCH_LOG));
  const parsed = parseBenchLog(lines.value);
  return parsed.ok ? parsed : err(`${BENCH_LOG} ${parsed.error}`);
}

/** Fixed key order (the schema's), so a line's bytes depend only on its values. */
function logLine(e: BenchLogEntry): JsonRecord {
  const replay =
    e.replay === null
      ? null
      : {
          labels: [...e.replay.labels],
          families: [...e.replay.families],
          pooled: { old: e.replay.pooled.old, new: e.replay.pooled.new, n: e.replay.pooled.n },
          per_family: Object.fromEntries(Object.entries(e.replay.per_family).map(([f, r]) => [f, { old: r.old, new: r.new, n: r.n, void: r.void }])),
          passed: e.replay.passed,
          reason: e.replay.reason,
        };
  return {
    at: e.at,
    cycle: e.cycle,
    outcome: e.outcome,
    version: e.version,
    parent: e.parent,
    sha256: e.sha256,
    path: e.path,
    activation: e.activation,
    changed_keys: [...e.changed_keys],
    evidence_packet: e.evidence_packet,
    evidence_packet_sha256: e.evidence_packet_sha256,
    evidence_ids: [...e.evidence_ids],
    reasons: e.reasons.map((r) => ({ text: r.text, keys: [...r.keys], evidence_ids: [...r.evidence_ids] })),
    errors: [...e.errors],
    replay,
    dropped_cliches: [...e.dropped_cliches],
    protocol_bundle_sha256: e.protocol_bundle_sha256,
    calls: [...e.calls],
    source: e.source,
  };
}

/**
 * Appends unless an entry with the same `cycle` exists (resume after a crash between append and marker). The new
 * line is validated together with the existing log first; an unreadable log or an invalid entry throws (integrity),
 * and the log is re-read afterwards to confirm the line landed.
 */
export function appendBenchLogOnce(files: RoundFiles, root: string, entry: BenchLogEntry): 'appended' | 'present' {
  const log = readBenchLog(root);
  if (!log.ok) throw new Error(log.error);
  if (log.value.some((e) => e.cycle === entry.cycle)) return 'present';
  const line = logLine(entry);
  const checked = parseBenchLog([...log.value.map(logLine), line]);
  if (!checked.ok) throw new Error(`${BENCH_LOG}: refusing to append cycle ${entry.cycle}: ${checked.error}`);
  files.appendLine(join(root, BENCH_LOG), line);
  const after = readBenchLog(root);
  if (!after.ok) throw new Error(after.error);
  if (!after.value.some((e) => e.cycle === entry.cycle)) throw new Error(`${BENCH_LOG}: cycle ${entry.cycle} missing after the append`);
  return 'appended';
}

function versionNumber(version: string): number | null {
  return VERSION_ID.test(version) ? Number(version.slice(1)) : null;
}

/** 'v' + (1 + max N over log versions and benchmark/v<N>.json); rejected numbers are burned. */
export function nextVersion(root: string, log: readonly BenchLogEntry[]): string {
  let max = 0;
  for (const e of log) {
    const n = e.version === null ? null : versionNumber(e.version);
    if (n !== null && n > max) max = n;
  }
  const dir = join(root, 'benchmark');
  const names = existsSync(dir) ? readdirSync(dir) : [];
  for (const name of names) {
    const m = /^(v\d+)\.json$/u.exec(name);
    const n = m?.[1] === undefined ? null : versionNumber(m[1]);
    if (n !== null && n > max) max = n;
  }
  return `v${max + 1}`;
}

/** Writes benchmark/<candidate.version>.json (`JSON.stringify(v, null, 2) + "\n"`); err on different existing bytes. */
export function writeVersion(files: RoundFiles, root: string, candidate: JsonRecord): Result<VersionRef> {
  const version = readString(candidate, 'version');
  if (version === null || !VERSION_ID.test(version)) return err('writeVersion: candidate.version must look like v<N> (N ≥ 1)');
  const path = `benchmark/${version}.json`;
  const text = `${JSON.stringify(candidate, null, 2)}\n`;
  const sha = sha256Bytes(Buffer.from(text, 'utf8'));
  const abs = join(root, path);
  if (existsSync(abs)) {
    if (sha256Bytes(readFileSync(abs)) !== sha) return err(`${path} already exists with different bytes (version numbers are never reused)`);
    return ok({ version, sha256: sha, path });
  }
  files.writeText(abs, text);
  return ok({ version, sha256: sha, path });
}

/** Reads and re-hashes the version file; err on a missing file, a hash mismatch or a different `version` field. */
export function loadVersion(root: string, ref: VersionRef): Result<JsonRecord> {
  if (!VERSION_ID.test(ref.version) || ref.path !== `benchmark/${ref.version}.json`) return err(`loadVersion: ${ref.path} is not the file of ${ref.version}`);
  const abs = join(root, ref.path);
  if (!existsSync(abs)) return err(`${ref.path} is missing`);
  let bytes: Buffer;
  try {
    bytes = readFileSync(abs);
  } catch (e) {
    return err(`${ref.path}: ${message(e).split(abs).join(ref.path)}`);
  }
  if (sha256Bytes(bytes) !== ref.sha256) return err(`${ref.path} does not match its logged sha256 ${ref.sha256.slice(0, 12)}`);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    return err(`${ref.path} is not valid JSON: ${message(e)}`);
  }
  if (!isRecord(value)) return err(`${ref.path} is not a JSON object`);
  if (readString(value, 'version') !== ref.version) return err(`${ref.path} does not declare version ${ref.version}`);
  return ok(value);
}
