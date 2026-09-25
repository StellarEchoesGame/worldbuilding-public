import { createHash } from 'node:crypto';
import { isRecord, stringArray, type JsonRecord } from './json.ts';
import { err, ok, type Result } from './result.ts';

export type ProtocolBlockName =
  | 'protected-keys'
  | 'activation'
  | 'bars'
  | 'limits'
  | 'forbidden-words'
  | 'negations'
  | 'negation-exceptions'
  | 'defect-types'
  | 'connectives'
  | 'merge'
  | 'fixture-rxx';

export const PROTOCOL_BLOCKS: readonly ProtocolBlockName[] = [
  'protected-keys',
  'activation',
  'bars',
  'limits',
  'forbidden-words',
  'negations',
  'negation-exceptions',
  'defect-types',
  'connectives',
  'merge',
  'fixture-rxx',
];

export const BUNDLE_FILES: readonly string[] = ['PROTOCOL.md', 'families.json', 'judges.json'];

export interface ProtocolBars {
  beatsChampionFourFamilies: number;
  sessionPairs: number;
  holdRounds: number;
}

export interface ProtocolLimits {
  maxChars: number;
  maxNewProperNouns: number;
  maxRegistered: number;
  maxWithoutExtends: number;
  maxRuleRatio: number;
}

export interface ForbiddenWord {
  term: string;
  protects: string;
}

export interface DefectType {
  id: string;
  text: string;
  requires: string | null;
}

export interface ProtocolMerge {
  preamble09: string;
  pointer07: string;
  heading8: string;
  tableHeader8: string;
  maxJointsPer500: number;
}

export interface FixtureRxx {
  rxx: string;
  rowId: string;
  claim: string;
  status: string;
  attachesTo: string;
  extends: string;
  misuse: string;
  reversal: string;
}

export interface Protocol {
  version: string;
  protectedKeys: string[];
  activation: Record<string, 'auto' | 'replay' | 'owner'>;
  bars: ProtocolBars;
  limits: ProtocolLimits;
  forbidden: ForbiddenWord[];
  negations: string[];
  /** Words that contain a negation marker but do not negate (不久, 非常); see PROTOCOL.md §2. */
  negationExceptions: string[];
  defectTypes: DefectType[];
  connectives: string[];
  merge: ProtocolMerge;
  fixtureRxx: FixtureRxx;
}

export interface BundleFile {
  name: string;
  bytes: Uint8Array;
}

class ShapeError extends Error {}

function fail(message: string): never {
  throw new ShapeError(message);
}

function at(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

function label(path: string): string {
  return path === '' ? 'block' : path;
}

function isBlockName(name: string): name is ProtocolBlockName {
  return PROTOCOL_BLOCKS.some((n) => n === name);
}

function isActivation(value: unknown): value is 'auto' | 'replay' | 'owner' {
  return value === 'auto' || value === 'replay' || value === 'owner';
}

/** Fixed-shape objects reject unknown keys so a misspelt key cannot silently fall back to nothing. */
function shape(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): JsonRecord {
  if (!isRecord(value)) return fail(`${label(path)} must be an object`);
  const where = path === '' ? '' : `${path}: `;
  for (const key of required) {
    if (!Object.hasOwn(value, key)) return fail(`${where}missing key ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) return fail(`${where}unknown key ${key}`);
  }
  return value;
}

function text(rec: JsonRecord, key: string, path: string): string {
  const v = rec[key];
  if (typeof v !== 'string' || v.trim() === '') return fail(`${at(path, key)} must be a non-empty string`);
  return v;
}

function count(rec: JsonRecord, key: string, path: string): number {
  const v = rec[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return fail(`${at(path, key)} must be a non-negative integer`);
  return v;
}

function ratio(rec: JsonRecord, key: string, path: string): number {
  const v = rec[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return fail(`${at(path, key)} must be a number between 0 and 1`);
  return v;
}

function unique(seen: Set<string>, value: string, path: string): void {
  if (seen.has(value)) fail(`${path} duplicates ${JSON.stringify(value)}`);
  seen.add(value);
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) return fail('block must be an array');
  return value;
}

function stringList(value: unknown): string[] {
  const items = stringArray(value);
  if (items === null) return fail('block must be an array of strings');
  const seen = new Set<string>();
  for (const [i, item] of items.entries()) {
    if (item.trim() === '') fail(`[${i}] must be a non-empty string`);
    unique(seen, item, `[${i}]`);
  }
  return items;
}

function activation(value: unknown): Record<string, 'auto' | 'replay' | 'owner'> {
  if (!isRecord(value)) return fail('block must be an object');
  const entries: Array<[string, 'auto' | 'replay' | 'owner']> = [];
  for (const [key, v] of Object.entries(value)) {
    if (!isActivation(v)) return fail(`${key} must be auto, replay or owner`);
    entries.push([key, v]);
  }
  // fromEntries defines own properties, so a "__proto__" key cannot reach the prototype.
  return Object.fromEntries(entries);
}

function bars(value: unknown): ProtocolBars {
  const rec = shape(value, '', ['beats_champion_four_families', 'session_pairs', 'hold_rounds']);
  return {
    beatsChampionFourFamilies: count(rec, 'beats_champion_four_families', ''),
    sessionPairs: count(rec, 'session_pairs', ''),
    holdRounds: count(rec, 'hold_rounds', ''),
  };
}

function limits(value: unknown): ProtocolLimits {
  const rec = shape(value, '', ['max_chars', 'max_new_proper_nouns', 'max_registered', 'max_without_extends', 'max_rule_ratio']);
  return {
    maxChars: count(rec, 'max_chars', ''),
    maxNewProperNouns: count(rec, 'max_new_proper_nouns', ''),
    maxRegistered: count(rec, 'max_registered', ''),
    maxWithoutExtends: count(rec, 'max_without_extends', ''),
    maxRuleRatio: ratio(rec, 'max_rule_ratio', ''),
  };
}

function forbidden(value: unknown): ForbiddenWord[] {
  const seen = new Set<string>();
  return list(value).map((item, i) => {
    const path = `[${i}]`;
    const rec = shape(item, path, ['term', 'protects']);
    const term = text(rec, 'term', path);
    unique(seen, term, at(path, 'term'));
    return { term, protects: text(rec, 'protects', path) };
  });
}

function defectTypes(value: unknown): DefectType[] {
  const seen = new Set<string>();
  return list(value).map((item, i) => {
    const path = `[${i}]`;
    const rec = shape(item, path, ['id', 'text'], ['requires']);
    const id = text(rec, 'id', path);
    unique(seen, id, at(path, 'id'));
    const requires = rec['requires'] ?? null;
    if (requires !== null && (typeof requires !== 'string' || requires.trim() === '')) {
      return fail(`${at(path, 'requires')} must be a non-empty string or null`);
    }
    return { id, text: text(rec, 'text', path), requires };
  });
}

function merge(value: unknown): ProtocolMerge {
  const rec = shape(value, '', ['preamble09', 'pointer07', 'heading8', 'tableHeader8', 'maxJointsPer500']);
  const tableHeader8 = text(rec, 'tableHeader8', '');
  const lines = tableHeader8.split('\n');
  if (lines.length !== 2 || lines.some((l) => l.trim() === '')) fail('tableHeader8 must be two non-empty lines (header row and separator row)');
  return {
    preamble09: text(rec, 'preamble09', ''),
    pointer07: text(rec, 'pointer07', ''),
    heading8: text(rec, 'heading8', ''),
    tableHeader8,
    maxJointsPer500: count(rec, 'maxJointsPer500', ''),
  };
}

function fixtureRxx(value: unknown): FixtureRxx {
  const rec = shape(value, '', ['rxx', 'rowId', 'claim', 'status', 'attachesTo', 'extends', 'misuse', 'reversal']);
  const rxx = text(rec, 'rxx', '');
  if (!/^R\d{2}-\d{2}$/u.test(rxx)) fail('rxx must match R<nn>-<nn>');
  return {
    rxx,
    rowId: text(rec, 'rowId', ''),
    claim: text(rec, 'claim', ''),
    status: text(rec, 'status', ''),
    attachesTo: text(rec, 'attachesTo', ''),
    extends: text(rec, 'extends', ''),
    misuse: text(rec, 'misuse', ''),
    reversal: text(rec, 'reversal', ''),
  };
}

interface RawBlock {
  name: string;
  line: number;
  body: string;
}

interface OpenFence {
  marker: string;
  width: number;
  line: number;
  protocolName: string | null;
  body: string[];
}

/**
 * Walks every fenced code block (backtick or tilde, CommonMark widths) so that a protocol block shown as an
 * example inside a wider fence is not mistaken for a real one.
 */
function scanBlocks(lines: readonly string[]): { blocks: RawBlock[]; errors: string[] } {
  const blocks: RawBlock[] = [];
  const errors: string[] = [];
  let open: OpenFence | null = null;
  for (const [i, line] of lines.entries()) {
    if (open === null) {
      const m = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
      const fence = m?.[1];
      const info = (m?.[2] ?? '').trim();
      if (fence === undefined || (fence.startsWith('`') && info.includes('`'))) continue;
      const name = /^json\s+protocol:(\S+)$/u.exec(info)?.[1] ?? null;
      open = { marker: fence.charAt(0), width: fence.length, line: i + 1, protocolName: name, body: [] };
      continue;
    }
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/u.exec(line)?.[1];
    if (close !== undefined && close.charAt(0) === open.marker && close.length >= open.width) {
      if (open.protocolName !== null) blocks.push({ name: open.protocolName, line: open.line, body: open.body.join('\n') });
      open = null;
    } else {
      open.body.push(line);
    }
  }
  if (open !== null && open.protocolName !== null) errors.push(`protocol:${open.protocolName}: unclosed block (line ${open.line})`);
  return { blocks, errors };
}

export function parseProtocol(markdown: string): Result<Protocol> {
  const normalized = markdown.replace(/\r\n?/gu, '\n');
  const errors: string[] = [];
  const version = /^Protocol version: (\S+)$/mu.exec(normalized)?.[1] ?? null;
  if (version === null) errors.push('missing "Protocol version: <version>" line');

  const scanned = scanBlocks(normalized.split('\n'));
  errors.push(...scanned.errors);
  const byName = new Map<ProtocolBlockName, RawBlock[]>();
  for (const block of scanned.blocks) {
    if (!isBlockName(block.name)) {
      errors.push(`protocol:${block.name}: unknown block (line ${block.line})`);
      continue;
    }
    byName.set(block.name, [...(byName.get(block.name) ?? []), block]);
  }

  const take = <T>(name: ProtocolBlockName, decode: (value: unknown) => T): T | null => {
    const found = byName.get(name) ?? [];
    const first = found[0];
    if (first === undefined) {
      errors.push(`protocol:${name}: missing block`);
      return null;
    }
    if (found.length > 1) {
      errors.push(`protocol:${name}: duplicate block (lines ${found.map((b) => b.line).join(', ')})`);
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(first.body);
    } catch (e) {
      errors.push(`protocol:${name}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
      return null;
    }
    try {
      return decode(parsed);
    } catch (e) {
      if (!(e instanceof ShapeError)) throw e;
      errors.push(`protocol:${name}: ${e.message}`);
      return null;
    }
  };

  const protectedKeys = take('protected-keys', stringList);
  const activationMap = take('activation', activation);
  const barsValue = take('bars', bars);
  const limitsValue = take('limits', limits);
  const forbiddenValue = take('forbidden-words', forbidden);
  const negations = take('negations', stringList);
  const exceptions = take('negation-exceptions', stringList);
  if (negations !== null && exceptions !== null) {
    for (const word of exceptions) {
      if (!negations.some((m) => word.includes(m))) errors.push(`protocol:negation-exceptions: ${JSON.stringify(word)} contains no negation marker`);
    }
  }
  const defects = take('defect-types', defectTypes);
  const connectives = take('connectives', stringList);
  const mergeValue = take('merge', merge);
  const fixture = take('fixture-rxx', fixtureRxx);

  if (protectedKeys !== null && activationMap !== null) {
    for (const key of Object.keys(activationMap)) {
      if (protectedKeys.includes(key)) errors.push(`protocol:activation: ${key} is also a protected key`);
    }
  }

  if (
    errors.length > 0 ||
    version === null ||
    protectedKeys === null ||
    activationMap === null ||
    barsValue === null ||
    limitsValue === null ||
    forbiddenValue === null ||
    negations === null ||
    exceptions === null ||
    defects === null ||
    connectives === null ||
    mergeValue === null ||
    fixture === null
  ) {
    return err(errors.join('; '));
  }
  return ok({
    version,
    protectedKeys,
    activation: activationMap,
    bars: barsValue,
    limits: limitsValue,
    forbidden: forbiddenValue,
    negations,
    negationExceptions: exceptions,
    defectTypes: defects,
    connectives,
    merge: mergeValue,
    fixtureRxx: fixture,
  });
}

/** Each file is framed as UTF-8(name) ‖ 0x00 ‖ decimal byte length ‖ 0x00 ‖ bytes, so no two bundles share a byte stream. */
export function protocolBundleHash(files: readonly BundleFile[]): string {
  const hash = createHash('sha256');
  const nul = Buffer.from([0]);
  for (const file of files) {
    if (file.name.includes('\u0000')) throw new RangeError(`bundle file name contains NUL: ${JSON.stringify(file.name)}`);
    hash.update(Buffer.from(file.name, 'utf8'));
    hash.update(nul);
    hash.update(Buffer.from(String(file.bytes.byteLength), 'utf8'));
    hash.update(nul);
    hash.update(file.bytes);
  }
  return hash.digest('hex');
}
