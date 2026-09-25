import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Resolution } from './bench-active.ts';
import { sha256 } from './store.ts';
import { isRecord, stringArray, type JsonRecord } from './json.ts';
import { err, ok, type Result } from './result.ts';

/** Precedence when pinned from trust status: suspended > unqualified > flagged > ok. */
export type FreezeFlag = 'ok' | 'flagged' | 'suspended' | 'unqualified';

export interface FreezeInput {
  round: string;
  /** Logical name (BOOK.md, REFERENCE.md, brief.json, champion, benchmark, writers.json, skill:<name>) to file content. */
  files: Record<string, string>;
  benchmarkVersion: string;
  eligibleFamilies: string[];
  flags: Record<string, FreezeFlag>;
  protocolBundleSha256: string;
  probeCreatedAt: string | null;
  /** Round-pipeline pins (absent for prototype freezes, which store the defaults below). */
  seed?: string;
  stepsSha256?: string;
  benchmarkResolution?: Resolution;
  gateFamilies?: string[];
  trustStatusSha256?: string | null;
  skills?: Record<string, string>;
}

export interface FreezeRecord {
  round: string;
  sha256: Record<string, string>;
  benchmark_version: string;
  eligible_families: string[];
  flags: Record<string, FreezeFlag>;
  protocol_bundle_sha256: string;
  probe_created_at: string | null;
  /** Round seed; null only in prototype freezes. */
  seed: string | null;
  /** SHA-256 of the ids of the pipeline actually run, joined by LF; null only in prototype freezes. */
  steps_sha256: string | null;
  /** How 02c resolved the benchmark (never re-resolved on resume); null only in prototype freezes. */
  benchmark_resolution: Resolution | null;
  /** gate_judge && !suspended && canary-passing; [] in prototype freezes. */
  gate_families: string[];
  /** SHA-256 of calibration/status.json bytes; pinned for audit, never drift-compared; null when absent. */
  trust_status_sha256: string | null;
  /** Skill snapshot name → SHA-256 of skills/<name>.md; {} in prototype freezes. */
  skills: Record<string, string>;
}

const HEX64 = /^[0-9a-f]{64}$/u;
const FLAGS: readonly FreezeFlag[] = ['ok', 'flagged', 'suspended', 'unqualified'];
const VIAS: readonly Resolution['via'][] = ['activate', 'approved', 'rollback'];

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Hashes are keyed in code-unit name order so the serialised record does not depend on input order. */
export function buildFreeze(input: FreezeInput): FreezeRecord {
  const hashes: Record<string, string> = {};
  for (const [name, content] of Object.entries(input.files).sort(([a], [b]) => byCodeUnit(a, b))) hashes[name] = sha256(content);
  return {
    round: input.round,
    sha256: hashes,
    benchmark_version: input.benchmarkVersion,
    eligible_families: [...input.eligibleFamilies],
    flags: { ...input.flags },
    protocol_bundle_sha256: input.protocolBundleSha256,
    probe_created_at: input.probeCreatedAt,
    seed: input.seed ?? null,
    steps_sha256: input.stepsSha256 ?? null,
    benchmark_resolution: input.benchmarkResolution === undefined ? null : { ...input.benchmarkResolution },
    gate_families: [...(input.gateFamilies ?? [])],
    trust_status_sha256: input.trustStatusSha256 ?? null,
    skills: { ...(input.skills ?? {}) },
  };
}

/**
 * Drift between the pinned record and the current inputs: file hashes, skill snapshots, the protocol bundle, the
 * benchmark version (and resolved file) and the step list. Flags, eligible and gate families are not file drift and
 * are not compared (resume reuses the frozen values); neither is `trust_status_sha256` (step 11e of the same round
 * rewrites calibration/status.json), the seed, or the probe time (when the probe ran, not an input).
 */
export function diffFreeze(pinned: FreezeRecord, current: FreezeRecord): string[] {
  const names = [...new Set([...Object.keys(pinned.sha256), ...Object.keys(current.sha256)])].sort(byCodeUnit);
  const out: string[] = [];
  for (const name of names) {
    const was = Object.hasOwn(pinned.sha256, name) ? pinned.sha256[name] : undefined;
    const now = Object.hasOwn(current.sha256, name) ? current.sha256[name] : undefined;
    if (was === undefined) out.push(`file not in freeze: ${name}`);
    else if (now === undefined) out.push(`frozen file missing: ${name}`);
    else if (was !== now) out.push(`frozen file changed: ${name}`);
  }
  if (pinned.protocol_bundle_sha256 !== current.protocol_bundle_sha256) out.push('protocol bundle changed');
  if (pinned.benchmark_version !== current.benchmark_version) out.push(`benchmark version changed: ${pinned.benchmark_version} → ${current.benchmark_version}`);
  else if (pinned.benchmark_resolution !== null && current.benchmark_resolution !== null && pinned.benchmark_resolution.sha256 !== current.benchmark_resolution.sha256) out.push('benchmark file changed');
  const skills = [...new Set([...Object.keys(pinned.skills), ...Object.keys(current.skills)])].sort(byCodeUnit);
  for (const name of skills) {
    const was = Object.hasOwn(pinned.skills, name) ? pinned.skills[name] : undefined;
    const now = Object.hasOwn(current.skills, name) ? current.skills[name] : undefined;
    if (was === undefined) out.push(`skill not in freeze: ${name}`);
    else if (now === undefined) out.push(`frozen skill missing: ${name}`);
    else if (was !== now) out.push(`frozen skill changed: ${name}`);
  }
  if (pinned.steps_sha256 !== null && current.steps_sha256 !== null && pinned.steps_sha256 !== current.steps_sha256) out.push('step list changed');
  return out;
}

function isFlag(value: unknown): value is FreezeFlag {
  return FLAGS.some((f) => f === value);
}

/** Narrows a parsed freeze.json to FreezeRecord, checking what freeze.schema.json cannot (values under dynamic keys). */
export function parseFreeze(value: unknown): Result<FreezeRecord> {
  if (!isRecord(value)) return err('freeze: expected an object');
  const { round, sha256: hashes, benchmark_version: version, eligible_families: families, flags, protocol_bundle_sha256: bundle, probe_created_at: probe } = value;
  if (typeof round !== 'string') return err('freeze.round: expected a string');
  if (!isRecord(hashes)) return err('freeze.sha256: expected an object');
  const sha: Record<string, string> = {};
  for (const [name, hash] of Object.entries(hashes)) {
    if (typeof hash !== 'string' || !HEX64.test(hash)) return err(`freeze.sha256.${name}: expected a lowercase SHA-256 hex digest`);
    sha[name] = hash;
  }
  if (typeof version !== 'string') return err('freeze.benchmark_version: expected a string');
  const eligible = stringArray(families);
  if (eligible === null) return err('freeze.eligible_families: expected a string array');
  if (!isRecord(flags)) return err('freeze.flags: expected an object');
  const flagMap: Record<string, FreezeFlag> = {};
  for (const [name, flag] of Object.entries(flags)) {
    if (!isFlag(flag)) return err(`freeze.flags.${name}: expected ok, flagged, suspended or unqualified`);
    flagMap[name] = flag;
  }
  if (typeof bundle !== 'string' || !HEX64.test(bundle)) return err('freeze.protocol_bundle_sha256: expected a lowercase SHA-256 hex digest');
  if (probe !== null && typeof probe !== 'string') return err('freeze.probe_created_at: expected a string or null');
  const pins = parseRoundPins(value);
  if (!pins.ok) return err(pins.error);
  return ok({ round, sha256: sha, benchmark_version: version, eligible_families: eligible, flags: flagMap, protocol_bundle_sha256: bundle, probe_created_at: probe, ...pins.value });
}

type RoundPins = Pick<FreezeRecord, 'seed' | 'steps_sha256' | 'benchmark_resolution' | 'gate_families' | 'trust_status_sha256' | 'skills'>;

function nullableString(value: unknown, key: string): Result<string | null> {
  const v = isRecord(value) ? value[key] : undefined;
  if (v === undefined || v === null) return ok(null);
  if (typeof v !== 'string' || v === '') return err(`freeze.${key}: expected a non-empty string or null`);
  return ok(v);
}

function nullableHex(value: unknown, key: string): Result<string | null> {
  const v = nullableString(value, key);
  if (!v.ok || v.value === null || HEX64.test(v.value)) return v;
  return err(`freeze.${key}: expected a lowercase SHA-256 hex digest or null`);
}

function parseResolution(value: unknown): Result<Resolution | null> {
  if (value === undefined || value === null) return ok(null);
  if (!isRecord(value)) return err('freeze.benchmark_resolution: expected an object or null');
  const { version, sha256: hash, path, via, since } = value;
  if (typeof version !== 'string' || typeof path !== 'string' || typeof since !== 'string') return err('freeze.benchmark_resolution: version, path and since must be strings');
  if (typeof hash !== 'string' || !HEX64.test(hash)) return err('freeze.benchmark_resolution.sha256: expected a lowercase SHA-256 hex digest');
  const v = VIAS.find((x) => x === via);
  if (v === undefined) return err('freeze.benchmark_resolution.via: expected activate, approved or rollback');
  return ok({ version, sha256: hash, path, via: v, since });
}

/** Round-pipeline fields; absent keys (prototype freezes written before PR-A) parse as the defaults. */
function parseRoundPins(value: JsonRecord): Result<RoundPins> {
  const seed = nullableString(value, 'seed');
  if (!seed.ok) return err(seed.error);
  const steps = nullableHex(value, 'steps_sha256');
  if (!steps.ok) return err(steps.error);
  const trust = nullableHex(value, 'trust_status_sha256');
  if (!trust.ok) return err(trust.error);
  const resolution = parseResolution(value['benchmark_resolution']);
  if (!resolution.ok) return err(resolution.error);
  const gateRaw = value['gate_families'];
  const gate = gateRaw === undefined ? [] : stringArray(gateRaw);
  if (gate === null || gate.some((f) => f === '')) return err('freeze.gate_families: expected an array of family names');
  const skillsRaw = value['skills'];
  const skills: Record<string, string> = {};
  if (skillsRaw !== undefined) {
    if (!isRecord(skillsRaw)) return err('freeze.skills: expected an object');
    for (const [name, hash] of Object.entries(skillsRaw)) {
      if (typeof hash !== 'string' || !HEX64.test(hash)) return err(`freeze.skills.${name}: expected a lowercase SHA-256 hex digest`);
      skills[name] = hash;
    }
  }
  return ok({ seed: seed.value, steps_sha256: steps.value, benchmark_resolution: resolution.value, gate_families: gate, trust_status_sha256: trust.value, skills });
}

/** The latest R round with a freeze.json (P rounds are prototype rounds outside the benchmark cycle), else null. */
export function latestFrozenRound(root: string): string | null {
  const dir = join(root, 'rounds');
  if (!existsSync(dir)) return null;
  const ids = readdirSync(dir).filter((n) => /^R\d{2}$/u.test(n) && existsSync(join(dir, n, 'freeze.json'))).sort();
  return ids[ids.length - 1] ?? null;
}
