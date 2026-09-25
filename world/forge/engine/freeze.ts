import { sha256 } from './store.ts';
import { isRecord, stringArray } from './json.ts';
import { err, ok, type Result } from './result.ts';

export type FreezeFlag = 'ok' | 'flagged' | 'suspended';

export interface FreezeInput {
  round: string;
  /** Logical name (BOOK.md, REFERENCE.md, brief.json, champion, benchmark, writers.json, skill:<name>) to file content. */
  files: Record<string, string>;
  benchmarkVersion: string;
  eligibleFamilies: string[];
  flags: Record<string, FreezeFlag>;
  protocolBundleSha256: string;
  probeCreatedAt: string | null;
}

export interface FreezeRecord {
  round: string;
  sha256: Record<string, string>;
  benchmark_version: string;
  eligible_families: string[];
  flags: Record<string, FreezeFlag>;
  protocol_bundle_sha256: string;
  probe_created_at: string | null;
}

const HEX64 = /^[0-9a-f]{64}$/u;
const FLAGS: readonly FreezeFlag[] = ['ok', 'flagged', 'suspended'];

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
  };
}

/**
 * Drift between the pinned record and the current inputs: file hashes, the protocol bundle and the benchmark version.
 * Flags and eligible families are not file drift and are not compared here; the round runner compares the frozen
 * family set itself (round.ts freezeStep) because it decides the bar.
 * The probe time records when the probe ran, not an input.
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
    if (!isFlag(flag)) return err(`freeze.flags.${name}: expected ok, flagged or suspended`);
    flagMap[name] = flag;
  }
  if (typeof bundle !== 'string' || !HEX64.test(bundle)) return err('freeze.protocol_bundle_sha256: expected a lowercase SHA-256 hex digest');
  if (probe !== null && typeof probe !== 'string') return err('freeze.probe_created_at: expected a string or null');
  return ok({ round, sha256: sha, benchmark_version: version, eligible_families: eligible, flags: flagMap, protocol_bundle_sha256: bundle, probe_created_at: probe });
}
