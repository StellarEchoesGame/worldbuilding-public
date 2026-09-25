import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchContext, RollbackEntry } from './bench-validate.ts';
import { isRecord, readNumber, readRecord, readString, stringArray } from './json.ts';
import { BUNDLE_FILES, parseProtocol, protocolBundleHash, type BundleFile, type Protocol } from './protocol.ts';
import { err, ok, type Result } from './result.ts';
import type { RoundRules } from './round.ts';
import { loadSchema } from './schema.ts';

export interface ProtocolBundle {
  protocol: Protocol;
  bundleSha256: string;
}

function readBundleFiles(root: string): Result<BundleFile[]> {
  const files: BundleFile[] = [];
  for (const name of BUNDLE_FILES) {
    try {
      files.push({ name, bytes: readFileSync(join(root, name)) });
    } catch (e) {
      return err(`protocol bundle: cannot read ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return ok(files);
}

/** Reads PROTOCOL.md, families.json and judges.json from `root`; parses the protocol and hashes the bundle. */
export function loadProtocolBundle(root: string): Result<ProtocolBundle> {
  const files = readBundleFiles(root);
  if (!files.ok) return files;
  const protocolFile = files.value.find((f) => f.name === 'PROTOCOL.md');
  if (protocolFile === undefined) return err('protocol bundle: PROTOCOL.md is not in BUNDLE_FILES');
  const protocol = parseProtocol(Buffer.from(protocolFile.bytes).toString('utf8'));
  if (!protocol.ok) return protocol;
  return ok({ protocol: protocol.value, bundleSha256: protocolBundleHash(files.value) });
}

/** Bars only tighten: the stricter of the protocol bar and the benchmark's `bars.beats_champion_four_families`. */
export function effectiveBar(protocolBar: number, benchmark: unknown): 7 | 8 {
  const benchBar = readNumber(readRecord(benchmark, 'bars'), 'beats_champion_four_families');
  return protocolBar >= 8 || (benchBar !== null && benchBar >= 8) ? 8 : 7;
}

export function roundRules(protocol: Protocol, benchmark: unknown): RoundRules {
  return {
    limits: protocol.limits,
    forbidden: protocol.forbidden,
    negations: protocol.negations,
    negationExceptions: protocol.negationExceptions,
    barFourFamilies: effectiveBar(protocol.bars.beatsChampionFourFamilies, benchmark),
  };
}

export function benchContext(root: string, protocol: Protocol, currentRound: number, rollbacks: RollbackEntry[]): Result<BenchContext> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, 'schema/benchmark.schema.json'), 'utf8'));
  } catch (e) {
    return err(`benchmark schema: ${e instanceof Error ? e.message : String(e)}`);
  }
  const schema = loadSchema(raw);
  if (!schema.ok) return schema;
  return ok({
    schema: schema.value,
    activation: { ...protocol.activation },
    protectedKeys: [...protocol.protectedKeys],
    currentRound,
    rollbacks,
    holdRounds: protocol.bars.holdRounds,
  });
}

export interface FoundBenchmark {
  path: string;
  value: unknown;
}

/** The benchmark/*.json file whose `version` field equals `version`. */
export function findBenchmark(root: string, version: string): Result<FoundBenchmark> {
  const dir = join(root, 'benchmark');
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch (e) {
    return err(`cannot list ${dir}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const found: FoundBenchmark[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      return err(`${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (readString(value, 'version') === version) found.push({ path, value });
  }
  const only = found[0];
  if (only === undefined) return err(`no benchmark with version ${version} in ${dir}`);
  if (found.length > 1) return err(`more than one benchmark claims version ${version}: ${found.map((f) => f.path).join(', ')}`);
  return ok(only);
}

/** Owner rollbacks as `[{ "round": n, "rolled_back_keys": [...] }]`; until the benchmark log exists (F1-04) the CLI takes a file. */
export function parseRollbacks(value: unknown): Result<RollbackEntry[]> {
  if (!Array.isArray(value)) return err('rollbacks: expected an array');
  const out: RollbackEntry[] = [];
  for (const [i, entry] of value.entries()) {
    const round = readNumber(entry, 'round');
    const keys = isRecord(entry) ? stringArray(entry['rolled_back_keys']) : null;
    if (round === null || !Number.isInteger(round) || round < 0 || keys === null) {
      return err(`rollbacks[${i}]: needs an integer round >= 0 and rolled_back_keys (strings)`);
    }
    out.push({ round, rolledBackKeys: keys });
  }
  return ok(out);
}
