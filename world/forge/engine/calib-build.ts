import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Backend } from './adapters/types.ts';
import type { Stance } from './brief.ts';
import { familyOf, isFamily, type Family, type PrefixRule } from './config.ts';
import type { StepContext } from './context.ts';
import { canonFiles } from './inputs.ts';
import { isRecord, readArray, readNumber, readRecord, readString, stringArray, type JsonRecord } from './json.ts';
import { CALIB_CATEGORIES, type CalibCategory, type DefectType, type ProtocolCalibration } from './protocol.ts';
import { err, ok, type Result } from './result.ts';
import { runAll, type StepDef, type StepOutcome } from './runner.ts';
import { loadSchema, type Schema, schemaFile, validate } from './schema.ts';
import { canonicalJson } from './seal.ts';
import { seededSplit } from './split.ts';
import { CANON_AUTHOR, DEFAULT_FORBIDDEN, DEFAULT_STANCES, FACT_STATUS_FILE, FACT_STATUSES, factTable07, forbiddenRows, parseFactStatus, parseRegressionFile, REF_07, REGRESSION_FILE, type FactRow, type ForbiddenRow, type RegressionRow } from './steps/brief.ts';
import { SEED_PATTERN } from './steps/start.ts';
import { isIsoTimestamp, seeded, seededShuffle, sha256, type RoundPaths } from './store.ts';
import { IntegrityError, readTaskRecord, runTask, type TaskSpec } from './task.ts';
import { applyDefect, defectTargets, defectTask, fixtureRxxRow, targetIds } from './tasks/defect.ts';
import { mustWrap, outputBlock, parseFencedJson, readCapped, type Span } from './tasks/fenced.ts';
import { ROLE_CALIB_DEGRADE, ROLE_CALIB_REWRITE } from './tasks/roles.ts';
import { charCount, normalizeForQuote, splitSentences } from './text.ts';

/**
 * `forge calib build` (c1-build, s4 §4.2): build config, passage selection, set plans (C00 round 0, Qnn
 * re-qualification, Gnn gate re-test), display order, stratified split, rewrite / degrade tasks and the
 * `calibration/pairs.json` set record. A set record is written once, after every text exists, and never
 * rewritten: owner answers pin sha256(canonicalJson(sets[set])) (owner-inputs.ts calibSet).
 */

/** `C00` round 0, `Q01…` re-qualification, `G01…` gate re-test (SET_ID). */
export type SetId = string;

export const SET_ID: RegExp = /^[CQG]\d{2}$/u;

export type SetKind = 'round0' | 'requal' | 'gate';

export type RequalReason = 'calibration_fail' | 'suspension';

export type TextRole = 'passage' | 'rewrite' | 'degraded' | 'defect';

/** What `calib build` was asked for (cli-calib.ts parseCalibArgs). */
export type BuildRequest =
  | { kind: 'round0' }
  | { kind: 'requal'; family: Family; reason: RequalReason }
  | { kind: 'gate'; family: Family };

/** `calibration/<set>/request.json`, written by cli-calib before c1 runs; the build seed lives here until pairs.json has the set. */
export interface SetRequest {
  set: SetId;
  kind: SetKind;
  family: Family | null;
  reason: RequalReason | null;
  /** 64 hex from ctx.ports.entropy; copied into pairs.json sets[set].seed (then ctx.seed() returns it). */
  seed: string;
  requested_at: string;
}

/** `calibration/build.json` (agent PR, reviewed; model ids never in engine code). */
export interface BuildConfig {
  primaryModel: string;
  contrastModels: string[];
  degradeModel: string;
  /** world/current-relative 8.1 files (01–06, 08). */
  passageFiles: string[];
  passageChars: [number, number];
  lengthTolerancePct: number;
  maxPassagesPerFile: number;
}

/** Forge-root-relative shared calibration files. */
export const BUILD_CONFIG = 'calibration/build.json';
export const PAIRS_FILE = 'calibration/pairs.json';
/** Per-set files under calibPaths(root, set).dir. */
export const REQUEST_FILE = 'request.json';
export const REFERENCE_FILE = 'reference.json';
/** c1's pin of its pairs.json record: sha256(canonicalJson(sets[set])) + LF, a marker output (readCalibPairs checks it). */
export const PAIRS_PIN_FILE = 'pairs.sha256';

/** One seeded passage of an 8.1 file: a run of adjacent prose paragraphs (blank-line blocks) of one section. */
export interface Passage {
  /** `<file>#<block index>` (one paragraph) or `<file>#<first>-<last>` (merged paragraphs). */
  id: string;
  file: string;
  text: string;
  /** sha256 of text; the `used` key across sets. */
  sha256: string;
}

export type TextPlan =
  | { id: string; role: 'passage'; passage: Passage }
  | { id: string; role: 'rewrite'; passage: Passage; model: string; stance: Stance }
  | { id: string; role: 'degraded'; of: string; model: string }
  | { id: string; role: 'defect'; of: string; defectType: string };

export interface PlannedPair {
  id: string;
  category: CalibCategory;
  a: string;
  b: string;
  knownBetter: string | null;
}

/** One gate dry-run copy: a defect copy of a known-category base rewrite. */
export interface DryrunPlan {
  /** `<set>-G<n>`. */
  id: string;
  defectType: string;
  base: string;
  /** Text id of the copy (role `defect`). */
  copy: string;
}

export interface SetPlan {
  set: SetId;
  kind: SetKind;
  family: Family | null;
  reason: RequalReason | null;
  texts: TextPlan[];
  pairs: PlannedPair[];
  dryrun: DryrunPlan[];
}

export interface DisplayItem {
  slot: number;
  pair: string;
  left: string;
  right: string;
  retestOf: number | null;
}

/** pairs.json `texts[id]`; `path` is calibration-relative (`texts/C00-T07.md`, as the UI and owner-sim read it). */
export interface CalibTextRecord {
  path: string;
  sha256: string;
  role: TextRole;
  /** Gateway model id (rewrite, degraded, defect writer); null for 8.1 passages. */
  model: string | null;
  /** 8.1 passages: OpenAI (PROTOCOL §1). */
  author_family: Family;
  /** steps/brief.ts DEFAULT_STANCES id for rewrites, else null. */
  stance: string | null;
  source: { file: string; quote_sha256: string } | null;
  /** Base text id of a degraded / defect copy, else null. */
  of: string | null;
  /** Task id that produced it; null for passages. */
  call: string | null;
}

export interface CalibPairRecord {
  id: string;
  category: CalibCategory;
  a: string;
  b: string;
  known_better: string | null;
  /** Author families of a and b (sorted, unique); a family never judges a pair it authored. */
  authors: Family[];
  /** C00: splitRound0; Q sets: none. */
  split: 'visible' | 'reserve' | 'none';
}

export interface DisplayRecord {
  slot: number;
  pair: string;
  left: string;
  right: string;
  retest_of: number | null;
}

export interface DryrunRecord {
  id: string;
  defect_type: string;
  base: string;
  copy: string;
  /** The replacement sentence (tasks/defect.ts Defect.injected). */
  injected: string;
  injected_span: Span;
  against: string;
}

/** pairs.json `sets[set]` (schema/calib-pairs.schema.json). */
export interface CalibSetRecord {
  kind: SetKind;
  family: Family | null;
  reason: RequalReason | null;
  seed: string;
  built_at: string;
  /** Display slots (C00: 28). */
  size: number;
  texts: Record<string, CalibTextRecord>;
  pairs: CalibPairRecord[];
  display: DisplayRecord[];
  dryrun: DryrunRecord[];
}

export interface CalibPairsFile {
  schema: 'calib-pairs/1';
  sets: Record<string, CalibSetRecord>;
}

/** `calibration/<set>/reference.json` (c1): what dry-run defects contradict and gate judges see (facts include fixtureRxxRow). */
export interface CalibReference {
  facts: FactRow[];
  regression: RegressionRow[];
  forbidden: ForbiddenRow[];
}

export interface RewriteOut {
  text: string;
}

export interface DegradeOut {
  text: string;
  changes: Array<{ from: string; to: string }>;
}

const TEXT_ID = /^[CQG]\d{2}-T\d{2,}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const TEXT_ROLES: readonly TextRole[] = ['passage', 'rewrite', 'degraded', 'defect'];
/**
 * A rewrite / degraded text is at most this many characters; parseBuildConfig refuses a passage range whose rewrite +
 * degrade chain (tolerance applied twice) could exceed it. Dry-run defect copies are not re-capped: they differ from their
 * base rewrite by one sentence (tasks/defect.ts DEFECT_MAX_GROWTH bounds that sentence, not the text).
 */
const TEXT_MAX = 4000;
/** Cliché hints quoted in the degrade prompt (s4 §4.2: the first 20). */
const DEGRADE_HINTS = 20;
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function twoDigits(n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`calibration ids are 1-based integers, got ${n}`);
  return String(n).padStart(2, '0');
}

/** C → round0, Q → requal, G → gate. */
export function setKindOf(set: SetId): SetKind {
  if (!SET_ID.test(set)) throw new RangeError(`calibration set id must look like C00, Q01 or G01, got ${set}`);
  return set.startsWith('C') ? 'round0' : set.startsWith('Q') ? 'requal' : 'gate';
}

/** Calibration RoundPaths: dir `calibration/<set>`, runs `.runs/calib-<set>`, taste → `<set>/verdicts`, markers / tasks / calls / status / progress under dir. */
export function calibPaths(root: string, set: SetId): RoundPaths {
  setKindOf(set);
  const dir = join(root, 'calibration', set);
  const sealed = join(root, '.sealed', `calib-${set}`);
  return {
    root,
    id: set,
    dir,
    runs: join(root, '.runs', `calib-${set}`),
    calls: join(dir, 'calls'),
    submissions: join(dir, 'submissions'),
    taste: join(dir, 'verdicts'),
    progress: join(dir, 'progress.jsonl'),
    markers: join(dir, 'markers'),
    tasks: join(dir, 'tasks'),
    gate: join(dir, 'dryrun'),
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
    sealed,
    sealedTasks: join(sealed, 'tasks'),
  };
}

/** `C00-T07` (n 1-based, 2 digits). */
export function calibTextId(set: SetId, n: number): string {
  return `${set}-T${twoDigits(n)}`;
}

/** `C00-P03`. */
export function calibPairId(set: SetId, n: number): string {
  return `${set}-P${twoDigits(n)}`;
}

/** `calibrewrite-C00-T07` (routing kind `calibrewrite`). */
export function rewriteTaskId(textId: string): string {
  return `calibrewrite-${textId}`;
}

/** `calibdegrade-C00-T31` (routing kind `calibdegrade`). */
export function degradeTaskId(textId: string): string {
  return `calibdegrade-${textId}`;
}

/** `defect-C00-G1` (routing kind `defect`, backend ctx.backends.defect). */
export function dryrunDefectTaskId(dryrunId: string): string {
  return `defect-${dryrunId}`;
}

/** The task id of a re-planned text (PROTOCOL task-id suffix `-2`): the first attempt's record stays as provenance. */
function replanned(taskId: string, attempt: 1 | 2): string {
  return attempt === 1 ? taskId : `${taskId}-2`;
}

let cachedSchemas: { build: Schema; set: Schema } | null = null;

/** The engine's copies of schema/calib-{build,pairs}.schema.json (module-relative, so temp forge roots need no schema dir). */
function schemas(): { build: Schema; set: Schema } {
  if (cachedSchemas !== null) return cachedSchemas;
  const load = (name: string): Schema => {
    const raw: unknown = JSON.parse(readFileSync(schemaFile(name), 'utf8'));
    const schema = loadSchema(raw);
    if (!schema.ok) throw new Error(`schema/${name}: ${schema.error}`);
    return schema.value;
  };
  cachedSchemas = { build: load('calib-build.schema.json'), set: load('calib-pairs.schema.json') };
  return cachedSchemas;
}

function readJsonFile(path: string, rel: string): Result<unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return ok(raw);
  } catch {
    return err(`${rel}: not valid JSON`);
  }
}

/** Refuses a model whose family is null or a judge / maintainer family (rewrites come only from non-judge families). */
export function parseBuildConfig(value: unknown, prefixes: readonly PrefixRule[], judgeFamilies: ReadonlySet<Family>): Result<BuildConfig> {
  const errors = validate(schemas().build, value);
  if (errors.length > 0) return err(`${BUILD_CONFIG}: ${errors.join('; ')}`);
  const primaryModel = readString(value, 'primary_model');
  const contrastModels = stringArray(readArray(value, 'contrast_models'));
  const degradeModel = readString(value, 'degrade_model');
  const passageFiles = stringArray(readArray(value, 'passage_files'));
  const chars = readArray(value, 'passage_chars') ?? [];
  const lo = chars[0];
  const hi = chars[1];
  const tol = readNumber(value, 'length_tolerance_pct');
  const perFile = readNumber(value, 'max_passages_per_file');
  if (primaryModel === null || contrastModels === null || degradeModel === null || passageFiles === null || typeof lo !== 'number' || typeof hi !== 'number' || tol === null || perFile === null) {
    return err(`${BUILD_CONFIG}: malformed`);
  }
  if (lo > hi) return err(`${BUILD_CONFIG}: passage_chars must be [min, max] with min <= max`);
  // A rewrite may run to max + tolerance and its degraded copy to that length + tolerance again; a range the parser
  // accepts but TEXT_MAX rejects would void texts at c1 instead of failing here.
  if (hi * (1 + tol / 100) ** 2 > TEXT_MAX) return err(`${BUILD_CONFIG}: passage_chars max ${hi} with ${tol}% tolerance twice (rewrite, then its degraded copy) exceeds the ${TEXT_MAX}-character text cap`);
  const writers = [primaryModel, ...contrastModels];
  if (new Set(writers).size !== writers.length) return err(`${BUILD_CONFIG}: primary_model and contrast_models must be distinct`);
  if (new Set(passageFiles).size !== passageFiles.length) return err(`${BUILD_CONFIG}: passage_files must be distinct`);
  for (const model of [...writers, degradeModel]) {
    const family = familyOf(model, prefixes);
    if (family === null) return err(`${BUILD_CONFIG}: model ${model} has no family in families.json prefixes`);
    if (judgeFamilies.has(family)) return err(`${BUILD_CONFIG}: model ${model} is from judge family ${family}; calibration texts come only from non-judge families`);
  }
  return ok({ primaryModel, contrastModels, degradeModel, passageFiles, passageChars: [lo, hi], lengthTolerancePct: tol, maxPassagesPerFile: perFile });
}

function isRequalReason(value: unknown): value is RequalReason {
  return value === 'calibration_fail' || value === 'suspension';
}

function familyOrNull(value: unknown): { ok: true; value: Family | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  return typeof value === 'string' && isFamily(value) ? { ok: true, value } : { ok: false };
}

function reasonOrNull(value: unknown): { ok: true; value: RequalReason | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  return isRequalReason(value) ? { ok: true, value } : { ok: false };
}

export function parseSetRequest(value: unknown): Result<SetRequest> {
  if (!isRecord(value)) return err(`${REQUEST_FILE}: not an object`);
  const set = readString(value, 'set');
  const seed = readString(value, 'seed');
  const at = readString(value, 'requested_at');
  const family = familyOrNull(value['family']);
  const reason = reasonOrNull(value['reason']);
  if (set === null || !SET_ID.test(set)) return err(`${REQUEST_FILE}: set must look like C00, Q01 or G01`);
  const kind = setKindOf(set);
  if (readString(value, 'kind') !== kind) return err(`${REQUEST_FILE}: kind must be ${kind} for set ${set}`);
  if (seed === null || !SEED_PATTERN.test(seed)) return err(`${REQUEST_FILE}: seed must be 8-64 lowercase hex digits`);
  if (at === null || !isIsoTimestamp(at)) return err(`${REQUEST_FILE}: requested_at must be an ISO 8601 UTC timestamp`);
  if (!family.ok) return err(`${REQUEST_FILE}: family must be a family name or null`);
  if (!reason.ok) return err(`${REQUEST_FILE}: reason must be calibration_fail, suspension or null`);
  const f = family.value;
  const r = reason.value;
  if (kind === 'round0' && (f !== null || r !== null)) return err(`${REQUEST_FILE}: a round-0 set has no family and no reason`);
  if (kind === 'requal' && (f === null || r === null)) return err(`${REQUEST_FILE}: a requal set needs family and reason`);
  if (kind === 'gate' && (f === null || r !== null)) return err(`${REQUEST_FILE}: a gate set needs a family and no reason`);
  return ok({ set, kind, family: f, reason: r, seed, requested_at: at });
}

/** `<paths.dir>/request.json`; missing → err. */
export function readSetRequest(paths: RoundPaths): Result<SetRequest> {
  const rel = `calibration/${paths.id}/${REQUEST_FILE}`;
  const raw = readJsonFile(join(paths.dir, REQUEST_FILE), rel);
  if (raw === null) return err(`${rel} is missing`);
  if (!raw.ok) return raw;
  const parsed = parseSetRequest(raw.value);
  if (!parsed.ok) return err(parsed.error.replace(REQUEST_FILE, rel));
  if (parsed.value.set !== paths.id) return err(`${rel}: set ${parsed.value.set} is not ${paths.id}`);
  return parsed;
}
function isTextRole(value: unknown): value is TextRole {
  return TEXT_ROLES.some((r) => r === value);
}

function isCategory(value: unknown): value is CalibCategory {
  return CALIB_CATEGORIES.some((c) => c === value);
}

function nullableString(rec: JsonRecord, key: string): { ok: true; value: string | null } | { ok: false } {
  const v = rec[key];
  if (v === null) return { ok: true, value: null };
  return typeof v === 'string' ? { ok: true, value: v } : { ok: false };
}

const TEXT_KEYS: readonly string[] = ['path', 'sha256', 'role', 'model', 'author_family', 'stance', 'source', 'of', 'call'];

function parseTextRecord(id: string, value: unknown): Result<CalibTextRecord> {
  const where = `texts.${id}`;
  if (!TEXT_ID.test(id)) return err(`${where}: text id must look like C00-T07`);
  if (!isRecord(value)) return err(`${where}: not an object`);
  const extra = Object.keys(value).filter((k) => !TEXT_KEYS.includes(k));
  if (extra.length > 0 || TEXT_KEYS.some((k) => !Object.hasOwn(value, k))) return err(`${where}: keys must be exactly ${TEXT_KEYS.join(', ')}`);
  const path = readString(value, 'path');
  const hash = readString(value, 'sha256');
  const role = value['role'];
  const family = readString(value, 'author_family');
  const model = nullableString(value, 'model');
  const stance = nullableString(value, 'stance');
  const of = nullableString(value, 'of');
  const call = nullableString(value, 'call');
  if (path !== `texts/${id}.md`) return err(`${where}: path must be texts/${id}.md`);
  if (hash === null || !HEX64.test(hash)) return err(`${where}: sha256 must be SHA-256 hex`);
  if (!isTextRole(role)) return err(`${where}: role must be one of ${TEXT_ROLES.join(', ')}`);
  if (family === null || !isFamily(family)) return err(`${where}: author_family must be a family name`);
  if (!model.ok || !stance.ok || !of.ok || !call.ok) return err(`${where}: model, stance, of and call must be strings or null`);
  let source: CalibTextRecord['source'] = null;
  const rawSource = value['source'];
  if (rawSource !== null) {
    const file = readString(rawSource, 'file');
    const quote = readString(rawSource, 'quote_sha256');
    if (!isRecord(rawSource) || Object.keys(rawSource).length !== 2 || file === null || quote === null || !HEX64.test(quote)) {
      return err(`${where}: source must be null or {file, quote_sha256}`);
    }
    source = { file, quote_sha256: quote };
  }
  if ((role === 'passage') !== (model.value === null)) return err(`${where}: only a passage has no model`);
  if ((role === 'degraded' || role === 'defect') !== (of.value !== null)) return err(`${where}: of names the base of a degraded or defect copy, else null`);
  if ((role === 'rewrite') !== (stance.value !== null)) return err(`${where}: only a rewrite has a stance`);
  return ok({ path, sha256: hash, role, model: model.value, author_family: family, stance: stance.value, source, of: of.value, call: call.value });
}

function parsePairRecord(value: unknown): Result<CalibPairRecord> {
  if (!isRecord(value)) return err('pairs: malformed pair');
  const id = readString(value, 'id');
  const category = value['category'];
  const a = readString(value, 'a');
  const b = readString(value, 'b');
  const better = nullableString(value, 'known_better');
  const authors = stringArray(readArray(value, 'authors'));
  const split = readString(value, 'split');
  if (id === null || !isCategory(category) || a === null || b === null || !better.ok || authors === null) return err('pairs: malformed pair');
  if (split !== 'visible' && split !== 'reserve' && split !== 'none') return err(`pairs.${id}: malformed split`);
  const families = authors.filter(isFamily);
  if (families.length !== authors.length) return err(`pairs.${id}: authors must be family names`);
  if (a === b) return err(`pairs.${id}: a and b must differ`);
  if ((category === 'known') !== (better.value !== null)) return err(`pairs.${id}: known_better is set exactly on known pairs`);
  if (better.value !== null && better.value !== a && better.value !== b) return err(`pairs.${id}: known_better must be a or b`);
  return ok({ id, category, a, b, known_better: better.value, authors: families, split });
}

function parseDisplayRecord(value: unknown): Result<DisplayRecord> {
  const slot = readNumber(value, 'slot');
  const pair = readString(value, 'pair');
  const left = readString(value, 'left');
  const right = readString(value, 'right');
  const retest = isRecord(value) ? value['retest_of'] : undefined;
  if (slot === null || pair === null || left === null || right === null) return err('display: malformed item');
  if (retest !== null && typeof retest !== 'number') return err(`display slot ${slot}: retest_of must be a slot or null`);
  return ok({ slot, pair, left, right, retest_of: retest });
}

function parseDryrunRecord(value: unknown): Result<DryrunRecord> {
  const id = readString(value, 'id');
  const type = readString(value, 'defect_type');
  const base = readString(value, 'base');
  const copy = readString(value, 'copy');
  const injected = readString(value, 'injected');
  const against = readString(value, 'against');
  const span = readRecord(value, 'injected_span');
  const start = readNumber(span, 'start');
  const end = readNumber(span, 'end');
  if (id === null || type === null || base === null || copy === null || injected === null || against === null || start === null || end === null) return err('dryrun: malformed item');
  if (end < start) return err(`dryrun.${id}: injected_span must have start <= end`);
  return ok({ id, defect_type: type, base, copy, injected, injected_span: { start, end }, against });
}

function collect<T>(items: readonly unknown[], parse: (v: unknown) => Result<T>): Result<T[]> {
  const out: T[] = [];
  for (const item of items) {
    const r = parse(item);
    if (!r.ok) return r;
    out.push(r.value);
  }
  return ok(out);
}

/** Schema, text records and cross-references of one set (dry-run bases of a G set live in C00, so only copies are checked there). */
function parseSetRecord(set: string, value: unknown): Result<CalibSetRecord> {
  const errors = validate(schemas().set, value);
  if (errors.length > 0) return err(errors.join('; '));
  if (!isRecord(value)) return err('not an object');
  const kind = setKindOf(set);
  if (value['kind'] !== kind) return err(`kind must be ${kind}`);
  const family = familyOrNull(value['family']);
  const reason = reasonOrNull(value['reason']);
  const seed = readString(value, 'seed');
  const builtAt = readString(value, 'built_at');
  const size = readNumber(value, 'size');
  if (!family.ok || !reason.ok || seed === null || builtAt === null || size === null) return err('malformed');
  const texts: Record<string, CalibTextRecord> = {};
  for (const [id, raw] of Object.entries(readRecord(value, 'texts') ?? {})) {
    if (!id.startsWith(`${set}-`)) return err(`texts.${id}: text ids of set ${set} start with ${set}-`);
    const t = parseTextRecord(id, raw);
    if (!t.ok) return t;
    texts[id] = t.value;
  }
  const pairs = collect(readArray(value, 'pairs') ?? [], parsePairRecord);
  const display = collect(readArray(value, 'display') ?? [], parseDisplayRecord);
  const dryrun = collect(readArray(value, 'dryrun') ?? [], parseDryrunRecord);
  if (!pairs.ok) return pairs;
  if (!display.ok) return display;
  if (!dryrun.ok) return dryrun;
  const has = (id: string): boolean => Object.hasOwn(texts, id);
  const byId = new Map(pairs.value.map((p) => [p.id, p]));
  if (byId.size !== pairs.value.length) return err('pairs: duplicate pair id');
  for (const p of pairs.value) {
    const a = Object.hasOwn(texts, p.a) ? texts[p.a] : undefined;
    const b = Object.hasOwn(texts, p.b) ? texts[p.b] : undefined;
    if (a === undefined || b === undefined) return err(`pairs.${p.id}: a and b must be texts of the set`);
    const authors = [...new Set([a.author_family, b.author_family])].sort(byCodeUnit);
    if (authors.join(',') !== p.authors.join(',')) return err(`pairs.${p.id}: authors must be the author families of a and b (${authors.join(', ')})`);
    const [better, worse] = p.known_better === p.a ? [a, b] : [b, a];
    if (p.known_better !== null && (better.role !== 'rewrite' || worse.role !== 'degraded' || worse.of !== p.known_better)) {
      return err(`pairs.${p.id}: known_better must be the rewrite a degraded copy was made of`);
    }
  }
  if (size !== display.value.length) return err('size must equal the number of display slots');
  for (const [i, d] of display.value.entries()) {
    const p = byId.get(d.pair);
    if (d.slot !== i + 1) return err('display: slots must run 1, 2, … in order');
    if (p === undefined) return err(`display slot ${d.slot}: unknown pair ${d.pair}`);
    if (!((d.left === p.a && d.right === p.b) || (d.left === p.b && d.right === p.a))) return err(`display slot ${d.slot}: left / right must be the pair's texts`);
    if (d.retest_of !== null && (d.retest_of >= d.slot || display.value[d.retest_of - 1]?.pair !== d.pair)) return err(`display slot ${d.slot}: retest_of must be an earlier slot of the same pair`);
  }
  const shown = display.value.filter((d) => d.retest_of === null).map((d) => d.pair);
  if (shown.length !== byId.size || new Set(shown).size !== byId.size) return err('display: the slots before the retests must show every pair exactly once');
  for (const d of dryrun.value) {
    if (!has(d.copy) || texts[d.copy]?.role !== 'defect') return err(`dryrun.${d.id}: copy must be a defect text of the set`);
    if (kind !== 'gate' && !has(d.base)) return err(`dryrun.${d.id}: base must be a text of the set`);
  }
  return ok({
    kind, family: family.value, reason: reason.value, seed, built_at: builtAt, size, texts, pairs: pairs.value, display: display.value, dryrun: dryrun.value,
  });
}

/** Shape plus schema/calib-pairs.schema.json. */
export function parseCalibPairs(value: unknown): Result<CalibPairsFile> {
  if (!isRecord(value) || value['schema'] !== 'calib-pairs/1') return err(`${PAIRS_FILE}: schema must be calib-pairs/1`);
  const extra = Object.keys(value).filter((k) => k !== 'schema' && k !== 'sets');
  if (extra.length > 0) return err(`${PAIRS_FILE}: unexpected key ${extra[0] ?? ''}`);
  const sets = readRecord(value, 'sets');
  if (sets === null) return err(`${PAIRS_FILE}: sets must be an object`);
  const out: Record<string, CalibSetRecord> = {};
  for (const [set, raw] of Object.entries(sets)) {
    if (!SET_ID.test(set)) return err(`${PAIRS_FILE}: set id ${set} must look like C00, Q01 or G01`);
    const parsed = parseSetRecord(set, raw);
    if (!parsed.ok) return err(`${PAIRS_FILE} set ${set}: ${parsed.error}`);
    out[set] = parsed.value;
  }
  return ok({ schema: 'calib-pairs/1', sets: out });
}

/** sha256(canonicalJson(sets[set])): c1's pin, owner answers' pairs_sha256 (owner-inputs.ts calibSet) and pin.json's. */
function setSha256(value: unknown): string {
  return sha256(canonicalJson(value));
}

/**
 * Every `calibration/<set>/pairs.sha256` c1 wrote must name a set of the file with that hash: a set record is immutable
 * after c1, and its pair metadata (authors, known_better, split, display) would otherwise be unpinned until c4's pin.json.
 */
function pinProblem(root: string, sets: JsonRecord): string | null {
  const dir = join(root, 'calibration');
  if (!existsSync(dir)) return null;
  for (const set of readdirSync(dir).filter((name) => SET_ID.test(name)).sort(byCodeUnit)) {
    const pin = join(dir, set, PAIRS_PIN_FILE);
    if (!existsSync(pin)) continue;
    const rel = `calibration/${set}/${PAIRS_PIN_FILE}`;
    if (!Object.hasOwn(sets, set)) return `${PAIRS_FILE} has no set ${set} but ${rel} pins one`;
    if (readFileSync(pin, 'utf8').trim() !== setSha256(sets[set])) return `${PAIRS_FILE} set ${set} does not match ${rel}; a set record is never edited after c1-build`;
  }
  return null;
}

/** Missing file → ok({schema, sets: {}}); a set whose record differs from its c1 pin (`<set>/pairs.sha256`) → err. */
export function readCalibPairs(root: string): Result<CalibPairsFile> {
  const raw = readJsonFile(join(root, PAIRS_FILE), PAIRS_FILE);
  if (raw !== null && !raw.ok) return raw;
  const value = raw === null ? { schema: 'calib-pairs/1', sets: {} } : raw.value;
  const problem = pinProblem(root, readRecord(value, 'sets') ?? {});
  if (problem !== null) return err(problem);
  return parseCalibPairs(value);
}

/** err when pairs.json has no such set (before c1 finished). */
export function readCalibSet(root: string, set: SetId): Result<CalibSetRecord> {
  const file = readCalibPairs(root);
  if (!file.ok) return file;
  const record = file.value.sets[set];
  return record === undefined ? err(`${PAIRS_FILE} has no set ${set}`) : ok(record);
}

function parseFactRow(value: unknown): Result<FactRow> {
  const id = readString(value, 'id');
  const kind = readString(value, 'kind');
  const text = readString(value, 'text');
  const status = FACT_STATUSES.find((s) => s === readString(value, 'status'));
  const rows = stringArray(readArray(value, 'rows'));
  if (id === null || text === null || status === undefined || rows === null || (kind !== 'fact' && kind !== 'registered')) return err('facts: malformed row');
  return ok({ id, kind, text, status, rows });
}

function parseRegressionRow(value: unknown): Result<RegressionRow> {
  const id = readString(value, 'id');
  const kase = readString(value, 'case');
  const source = readString(value, 'source');
  const quote = readString(value, 'quote');
  if (id === null || kase === null || source === null || quote === null) return err('regression: malformed row');
  return ok({ id, case: kase, source, quote });
}

function parseForbiddenRow(value: unknown): Result<ForbiddenRow> {
  const id = readString(value, 'id');
  const text = readString(value, 'text');
  if (id === null || text === null) return err('forbidden: malformed row');
  return ok({ id, text });
}

export function readCalibReference(paths: RoundPaths): Result<CalibReference> {
  const rel = `calibration/${paths.id}/${REFERENCE_FILE}`;
  const raw = readJsonFile(join(paths.dir, REFERENCE_FILE), rel);
  if (raw === null) return err(`${rel} is missing`);
  if (!raw.ok) return raw;
  const facts = collect(readArray(raw.value, 'facts') ?? [null], parseFactRow);
  const regression = collect(readArray(raw.value, 'regression') ?? [null], parseRegressionRow);
  const forbidden = collect(readArray(raw.value, 'forbidden') ?? [null], parseForbiddenRow);
  if (!facts.ok) return err(`${rel}: ${facts.error}`);
  if (!regression.ok) return err(`${rel}: ${regression.error}`);
  if (!forbidden.ok) return err(`${rel}: ${forbidden.error}`);
  return ok({ facts: facts.value, regression: regression.value, forbidden: forbidden.value });
}

/**
 * The dry-run reference (s4 §4.2, index): 07 §2 F-rows joined with fact-status.json plus fixture-rxx; live
 * regression quotes (NFKC substrings of the canon, as buildBrief keeps them); forbidden = the default topic-cell moves.
 */
function buildReference(root: string, canon: Readonly<Record<string, string>>, fixture: StepContext['protocol']['fixtureRxx']): Result<CalibReference> {
  const ref07 = canon[REF_07];
  if (ref07 === undefined) return err(`${REF_07} missing from the canon`);
  const statusRaw = readJsonFile(join(root, FACT_STATUS_FILE), FACT_STATUS_FILE) ?? err(`${FACT_STATUS_FILE} missing`);
  const status = statusRaw.ok ? parseFactStatus(statusRaw.value) : statusRaw;
  if (!status.ok) return status;
  const byId = new Map(status.value.map((f) => [f.id, f]));
  const facts: FactRow[] = [];
  for (const f of factTable07(ref07)) {
    const entry = byId.get(f.id);
    if (entry === undefined) return err(`${FACT_STATUS_FILE} has no entry for ${f.id}`);
    facts.push({ id: f.id, kind: 'fact', text: f.text, status: entry.status, rows: [...entry.rows] });
  }
  if (facts.length === 0) return err('07 §2 has no F-ID rows');
  facts.push(fixtureRxxRow(fixture));
  const regressionRaw = readJsonFile(join(root, REGRESSION_FILE), REGRESSION_FILE) ?? err(`${REGRESSION_FILE} missing`);
  const regression = regressionRaw.ok ? parseRegressionFile(regressionRaw.value) : regressionRaw;
  if (!regression.ok) return regression;
  const canonText = Object.keys(canon).sort(byCodeUnit).map((k) => canon[k] ?? '').join('\n').normalize('NFKC');
  const live = regression.value.filter((q) => q.quote.trim() !== '' && canonText.includes(q.quote.normalize('NFKC')));
  return ok({ facts, regression: live, forbidden: forbiddenRows({ forbidden: [...DEFAULT_FORBIDDEN] }) });
}

/** A block holding a heading, table row, blockquote, fence or HTML line is not a prose passage. */
const NON_PROSE = /^\s*(?:#|\||>|```|~~~|<)/u;

/** Blank-line blocks of one file with their 1-based index (every block counts, so ids stay stable) and trimmed offsets. */
function blocksOf(text: string): Array<{ n: number; start: number; end: number; prose: boolean }> {
  const out: Array<{ n: number; start: number; end: number; prose: boolean }> = [];
  let at = 0;
  for (const part of text.split(/(\n[ \t]*\n)/u)) {
    const from = at;
    at += part.length;
    if (/^\n[ \t]*\n$/u.test(part) || part.trim() === '') continue;
    const lead = part.length - part.trimStart().length;
    const body = part.trim();
    out.push({ n: out.length + 1, start: from + lead, end: from + lead + body.length, prose: !body.split('\n').some((line) => NON_PROSE.test(line)) });
  }
  return out;
}

/**
 * Passage candidates of one file: adjacent prose blocks of one section (a heading, table, quote or over-long block
 * ends a run) are merged in order until the run reaches `lo` characters; a merge that would pass `hi` restarts at the
 * block that did not fit. The 8.1 files are written as one-line paragraphs of ≈ 60–280 characters, so single blocks
 * alone would give almost no 250–600 character passage. The partition depends only on the text and the range, so
 * every set sees the same passages and `used` (sha256) excludes whole ones. Texts are verbatim slices of the file.
 */
function passagesOf(file: string, raw: string, lo: number, hi: number): Passage[] {
  const text = raw.replace(/\r\n?/gu, '\n');
  const out: Passage[] = [];
  let run: Array<{ n: number; start: number; end: number }> = [];
  const slice = (r: ReadonlyArray<{ start: number; end: number }>): string => text.slice(r[0]?.start ?? 0, r[r.length - 1]?.end ?? 0);
  for (const block of blocksOf(text)) {
    if (!block.prose || charCount(slice([block])) > hi) {
      run = [];
      continue;
    }
    if (run.length > 0 && charCount(slice([...run, block])) > hi) run = [];
    run.push(block);
    const body = slice(run);
    if (charCount(body) < lo) continue;
    const first = run[0]?.n ?? block.n;
    out.push({ id: first === block.n ? `${file}#${first}` : `${file}#${first}-${block.n}`, file, text: body, sha256: sha256(body) });
    run = [];
  }
  return out;
}

/**
 * Seeded passages of cfg.passageFiles (passagesOf: merged prose paragraphs, charCount(stripMarkdown) in range),
 * ≤ maxPassagesPerFile, none in `used` (sha256). Candidates are shuffled (key `calib:passages`) and taken greedily, so the
 * first n of a larger `count` are the n of `count = n`: the build's spare passages extend the list without changing it.
 */
export function selectPassages(canon: Readonly<Record<string, string>>, cfg: BuildConfig, used: ReadonlySet<string>, count: number, seed: string): Result<Passage[]> {
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`selectPassages: count must be a non-negative integer, got ${count}`);
  const [lo, hi] = cfg.passageChars;
  const candidates: Passage[] = [];
  const seen = new Set<string>(used);
  for (const file of cfg.passageFiles) {
    const text = canon[file];
    if (text === undefined) return err(`passage file ${file} is not in the canon`);
    for (const p of passagesOf(file, text, lo, hi)) {
      if (seen.has(p.sha256)) continue;
      seen.add(p.sha256);
      candidates.push(p);
    }
  }
  const order = seededShuffle([...candidates].sort((a, b) => byCodeUnit(a.id, b.id)), seed, 'calib:passages');
  const perFile = new Map<string, number>();
  const out: Passage[] = [];
  for (const p of order) {
    if (out.length === count) break;
    const n = perFile.get(p.file) ?? 0;
    if (n >= cfg.maxPassagesPerFile) continue;
    perFile.set(p.file, n + 1);
    out.push(p);
  }
  if (out.length < count) return err(`only ${out.length} unused ${lo}-${hi} character passages in the passage files (at most ${cfg.maxPassagesPerFile} per file); ${count} needed`);
  return ok(out);
}

/** Builds a set plan: text and pair ids in plan order (`<set>-T01…`, `<set>-P01…`). */
class Planner {
  readonly texts: TextPlan[] = [];
  readonly pairs: PlannedPair[] = [];
  readonly set: SetId;
  readonly seed: string;

  constructor(set: SetId, seed: string) {
    this.set = set;
    this.seed = seed;
  }

  private nextText(): string {
    return calibTextId(this.set, this.texts.length + 1);
  }

  private nextPair(): string {
    return calibPairId(this.set, this.pairs.length + 1);
  }

  /** Seeded distinct stances for pair `pairId` (DEFAULT_STANCES in id order, key `calib:stance:<pair>`). */
  stances(pairId: string, n: number): Stance[] {
    const sorted = [...DEFAULT_STANCES].sort((a, b) => byCodeUnit(a.id, b.id));
    return seededShuffle(sorted, this.seed, `calib:stance:${pairId}`).slice(0, n).map((s) => ({ id: s.id, text: s.text }));
  }

  private passageText(passage: Passage): string {
    const id = this.nextText();
    this.texts.push({ id, role: 'passage', passage });
    return id;
  }

  private rewrite(passage: Passage, model: string, stance: Stance): string {
    const id = this.nextText();
    this.texts.push({ id, role: 'rewrite', passage, model, stance });
    return id;
  }

  private pair(category: CalibCategory, a: string, b: string, knownBetter: string | null): void {
    this.pairs.push({ id: this.nextPair(), category, a, b, knownBetter });
  }

  /** 8.1 passage vs its rewrite by `model`. */
  canonVsRewrite(passage: Passage, model: string): void {
    const [stance] = this.stances(this.nextPair(), 1);
    if (stance === undefined) throw new Error('calibration: no stances');
    const a = this.passageText(passage);
    this.pair('canon_vs_rewrite', a, this.rewrite(passage, model, stance), null);
  }

  /** Primary vs contrast: same passage, stance and target length. */
  crossModel(passage: Passage, primary: string, contrast: string): void {
    const [stance] = this.stances(this.nextPair(), 1);
    if (stance === undefined) throw new Error('calibration: no stances');
    const a = this.rewrite(passage, primary, stance);
    this.pair('cross_model', a, this.rewrite(passage, contrast, stance), null);
  }

  /** Primary model, same passage, two distinct stances. */
  stancePair(passage: Passage, primary: string): void {
    const [s1, s2] = this.stances(this.nextPair(), 2);
    if (s1 === undefined || s2 === undefined) throw new Error('calibration: fewer than two stances');
    const a = this.rewrite(passage, primary, s1);
    this.pair('stance', a, this.rewrite(passage, primary, s2), null);
  }

  /** A primary rewrite vs its cliché-degraded copy; the rewrite is known better (D1: never an 8.1 passage). */
  known(passage: Passage, primary: string, degradeModel: string): void {
    const [stance] = this.stances(this.nextPair(), 1);
    if (stance === undefined) throw new Error('calibration: no stances');
    const base = this.rewrite(passage, primary, stance);
    const copy = this.nextText();
    this.texts.push({ id: copy, role: 'degraded', of: base, model: degradeModel });
    this.pair('known', base, copy, base);
  }
}

function take(passages: readonly Passage[], need: number, what: string): Passage[] {
  if (passages.length < need) throw new RangeError(`${what}: ${need} distinct passages needed, got ${passages.length}`);
  const picked = passages.slice(0, need);
  if (new Set(picked.map((p) => p.sha256)).size !== need) throw new RangeError(`${what}: passages must be distinct`);
  return picked;
}

/** Adds `count` pairs of `category`, one passage each, in order. */
function addPairs(p: Planner, category: CalibCategory, passages: readonly Passage[], cfg: BuildConfig, cvrModels: readonly string[]): void {
  const contrasts = seededShuffle(cfg.contrastModels, p.seed, 'calib:contrast');
  passages.forEach((passage, i) => {
    if (category === 'canon_vs_rewrite') p.canonVsRewrite(passage, cvrModels[i % cvrModels.length] ?? cfg.primaryModel);
    else if (category === 'cross_model') p.crossModel(passage, cfg.primaryModel, contrasts[i % contrasts.length] ?? cfg.primaryModel);
    else if (category === 'stance') p.stancePair(passage, cfg.primaryModel);
    else p.known(passage, cfg.primaryModel, cfg.degradeModel);
  });
}

/** canon_vs_rewrite rewrite models: primary ×2 + each contrast ×1, seeded (key `calib:cvr-models`), cycled. */
function cvrRotation(cfg: BuildConfig, seed: string): string[] {
  return seededShuffle([cfg.primaryModel, cfg.primaryModel, ...cfg.contrastModels], seed, 'calib:cvr-models');
}

/** C00: 4 categories × pairsPerCategory; known base is a primary rewrite (D1); dryrun left empty (planDryrun). */
export function planRound0(passages: readonly Passage[], cfg: BuildConfig, cal: ProtocolCalibration, seed: string): SetPlan {
  const n = cal.pairsPerCategory;
  const picked = take(passages, cal.categories.length * n, 'planRound0');
  const p = new Planner('C00', seed);
  const rotation = cvrRotation(cfg, seed);
  cal.categories.forEach((category, ci) => addPairs(p, category, picked.slice(ci * n, (ci + 1) * n), cfg, rotation));
  return { set: 'C00', kind: 'round0', family: null, reason: null, texts: p.texts, pairs: p.pairs, dryrun: [] };
}

/** The non-known categories `family` may judge: a family never judges a pair it authored, and 8.1 passages are OpenAI's. */
function judgeableCategories(family: Family, cal: ProtocolCalibration): CalibCategory[] {
  return cal.categories.filter((c) => c !== 'known' && !(c === 'canon_vs_rewrite' && family === CANON_AUTHOR));
}

/** Qnn: requal.nonknown over the categories the family may judge (OpenAI: cross_model + stance) + requal.known known pairs. */
export function planRequal(set: SetId, family: Family, passages: readonly Passage[], cfg: BuildConfig, cal: ProtocolCalibration, seed: string): SetPlan {
  if (setKindOf(set) !== 'requal') throw new RangeError(`planRequal: ${set} is not a Q set`);
  const cats = judgeableCategories(family, cal);
  if (cats.length === 0) throw new RangeError(`planRequal: ${family} may judge no non-known category`);
  const total = cal.requal.nonknown + cal.requal.known;
  const picked = take(passages, total, 'planRequal');
  const p = new Planner(set, seed);
  const rotation = cvrRotation(cfg, seed);
  let at = 0;
  cats.forEach((category, i) => {
    const count = Math.floor(cal.requal.nonknown / cats.length) + (i < cal.requal.nonknown % cats.length ? 1 : 0);
    addPairs(p, category, picked.slice(at, at + count), cfg, rotation);
    at += count;
  });
  addPairs(p, 'known', picked.slice(at, total), cfg, rotation);
  return { set, kind: 'requal', family, reason: null, texts: p.texts, pairs: p.pairs, dryrun: [] };
}

/** Bases in dry-run order (code-unit sorted, then key `calib:dryrun:<set>`); copies take the first ones, re-plans the next. */
function dryrunBases(set: SetId, bases: readonly string[], seed: string): string[] {
  return seededShuffle([...new Set(bases)].sort(byCodeUnit), seed, `calib:dryrun:${set}`);
}

/** One copy per enabled defect type (defectTargets non-empty for the set's reference), bases seeded. */
export function planDryrun(set: SetId, bases: readonly string[], types: readonly DefectType[], seed: string): DryrunPlan[] {
  const order = dryrunBases(set, bases, seed);
  if (types.length > order.length) throw new RangeError(`planDryrun: ${types.length} defect types need as many base texts, got ${order.length}`);
  const sorted = [...types].sort((a, b) => byCodeUnit(a.id, b.id));
  return sorted.map((t, i) => ({ id: `${set}-G${i + 1}`, defectType: t.id, base: order[i] ?? '', copy: calibTextId(set, i + 1) }));
}

/** Gnn: dry-run copies only, of the given base rewrites (C00 known bases). */
export function planGate(set: SetId, family: Family, bases: readonly string[], types: readonly DefectType[], seed: string): SetPlan {
  if (setKindOf(set) !== 'gate') throw new RangeError(`planGate: ${set} is not a G set`);
  const dryrun = planDryrun(set, bases, types, seed);
  const texts: TextPlan[] = dryrun.map((d) => ({ id: d.copy, role: 'defect', of: d.base, defectType: d.defectType }));
  return { set, kind: 'gate', family, reason: null, texts, pairs: [], dryrun };
}

/** Every retest is shown at least this many slots after its original (s4 §4.2: originals ≤ 16 of 24, retests 25–28). */
const RETEST_GAP = 9;
/** Display re-draws (key suffix `:<k>`) before giving up on a category without an early enough original. */
const DISPLAY_DRAWS = 100;

/**
 * Pairs seeded into slots 1…n (key `calib:display`), sides seeded per pair (`calib:side:<pair>`); `retestPairs`
 * retests appended with sides swapped, one per category in seeded category order (`calib:retest-cats`, cycling when
 * there are more retests than categories), the original drawn (`calib:retest:<k>`) among slots ≤ n + 1 − RETEST_GAP. A
 * draw where some category has no such original is re-drawn with key suffix `:1`, `:2`, …
 */
export function displayOrder(pairs: readonly PlannedPair[], retestPairs: number, seed: string): DisplayItem[] {
  if (!Number.isInteger(retestPairs) || retestPairs < 0 || retestPairs > pairs.length) throw new RangeError(`displayOrder: retestPairs must be 0..${pairs.length}, got ${retestPairs}`);
  const sorted = [...pairs].sort((a, b) => byCodeUnit(a.id, b.id));
  const limit = sorted.length + 1 - RETEST_GAP;
  const categories = seededShuffle([...new Set(sorted.map((p) => p.category))].sort(byCodeUnit), seed, 'calib:retest-cats');
  for (let draw = 0; draw < DISPLAY_DRAWS; draw += 1) {
    const order = seededShuffle(sorted, seed, draw === 0 ? 'calib:display' : `calib:display:${draw}`);
    const items: DisplayItem[] = order.map((p, i) => {
      const leftA = seeded(seed, `calib:side:${p.id}`) < 0.5;
      return { slot: i + 1, pair: p.id, left: leftA ? p.a : p.b, right: leftA ? p.b : p.a, retestOf: null };
    });
    const chosen: DisplayItem[] = [];
    for (let k = 0; k < retestPairs; k += 1) {
      const category = categories[k % categories.length];
      const early = items.filter((d) => d.slot <= limit && !chosen.includes(d) && order[d.slot - 1]?.category === category);
      const pick = seededShuffle(early, seed, `calib:retest:${k}`)[0];
      if (pick === undefined) break;
      chosen.push(pick);
    }
    if (chosen.length < retestPairs) continue;
    const retests = seededShuffle(chosen, seed, 'calib:retest-order').map((d, i) => ({ slot: items.length + i + 1, pair: d.pair, left: d.right, right: d.left, retestOf: d.slot }));
    return [...items, ...retests];
  }
  throw new RangeError(`displayOrder: no draw places ${retestPairs} retests at least ${RETEST_GAP} slots after their originals`);
}

/** seededSplit per category, round-robin until `visible` are visible (3 / 3 per category at defaults). */
export function splitRound0(pairs: readonly PlannedPair[], visible: number, seed: string): Record<string, 'visible' | 'reserve'> {
  if (!Number.isInteger(visible) || visible < 0 || visible > pairs.length) throw new RangeError(`splitRound0: visible must be 0..${pairs.length}, got ${visible}`);
  const categories = [...new Set(pairs.map((p) => p.category))].sort((a, b) => CALIB_CATEGORIES.indexOf(a) - CALIB_CATEGORIES.indexOf(b));
  const ids = new Map(categories.map((c) => [c, pairs.filter((p) => p.category === c).map((p) => p.id)]));
  const quota = new Map(categories.map((c) => [c, 0]));
  for (let left = visible; left > 0; ) {
    for (const c of categories) {
      const q = quota.get(c) ?? 0;
      if (left > 0 && q < (ids.get(c)?.length ?? 0)) {
        quota.set(c, q + 1);
        left -= 1;
      }
    }
  }
  const out: Record<string, 'visible' | 'reserve'> = {};
  for (const c of categories) Object.assign(out, seededSplit(ids.get(c) ?? [], seed, `calib:split:${c}`, quota.get(c) ?? 0));
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => byCodeUnit(a, b)));
}

function retryWith(prompt: string): (error: string) => string {
  return (error) => `${prompt}\n\n# 上一次输出未通过校验\n错误：${error}\n请针对这个错误重新作答，仍然只输出一个 json 代码块。`;
}

/** charCount(text) within ±tolPct % of target (integer arithmetic, bounds inclusive). */
function withinTolerance(chars: number, target: number, tolPct: number): boolean {
  return chars * 100 >= target * (100 - tolPct) && chars * 100 <= target * (100 + tolPct);
}

/** ROLE_CALIB_REWRITE; parse: `text` within ±tolPct of targetChars, no `#` line, no `【第`, not a copy of the passage (copyProblem). */
export function rewriteTask(id: string, passage: Passage, stance: Stance, targetChars: number, tolPct: number, seed: string): TaskSpec<RewriteOut> {
  const prompt = [
    `把下面这段设定原文改写成一个现场：用下面这种写法——${stance.text}只用原文已有的事实，不新增专名和数字，约${targetChars}字（允许 ±${tolPct}%）。`,
    mustWrap('calibrewrite', '原文', passage.text, seed, `${id}:原文`),
    '',
    '# 要求',
    '1. 写成连贯的正文段落，不加标题、不加小节编号、不加注释。',
    '2. 不照抄原文的句子；原文没有的人名、地名、机构名和数字一律不写。',
    '',
    outputBlock({ text: '现场正文' }),
  ].join('\n');
  return { id, role: ROLE_CALIB_REWRITE, prompt, parse: (text) => parseRewrite(text, passage.text, targetChars, tolPct), retryPrompt: retryWith(prompt) };
}

/**
 * A rewrite that copies the passage: equal after normalizeForQuote (width, whitespace and punctuation ignored), or
 * every sentence (splitSentences) occurs in the passage under the same normalization (reordered or re-punctuated).
 */
function copyProblem(text: string, passage: string): string | null {
  const whole = normalizeForQuote(passage);
  if (normalizeForQuote(text) === whole) return 'text: equals the passage verbatim';
  if (splitSentences(text).every((s) => whole.includes(normalizeForQuote(s)))) return 'text: every sentence is copied from the passage';
  return null;
}

function parseRewrite(text: string, passage: string, targetChars: number, tolPct: number): Result<RewriteOut> {
  const obj = parseFencedJson(text);
  if (!obj.ok) return obj;
  const body = readCapped(obj.value, 'text', TEXT_MAX);
  if (!body.ok) return body;
  if (/^\s*#/mu.test(body.value)) return err('text: contains a heading line (starting with #)');
  if (body.value.includes('【第')) return err('text: contains a chapter marker');
  const chars = charCount(body.value);
  if (!withinTolerance(chars, targetChars, tolPct)) return err(`text: ${chars} characters, outside ${targetChars} +/- ${tolPct}%`);
  const copied = copyProblem(body.value, passage);
  return copied === null ? ok({ text: body.value }) : err(copied);
}

/** ROLE_CALIB_DEGRADE; parse: 3–6 changes, from ⊂ original and ∉ text, to ⊂ text, equal sentence count, length within tolerance. */
export function degradeTask(id: string, original: string, cliches: readonly string[], tolPct: number, seed: string): TaskSpec<DegradeOut> {
  const hints = cliches.slice(0, DEGRADE_HINTS);
  const prompt = [
    `把下面这篇现场里 3–6 处具体细节换成泛泛的陈词${hints.length > 0 ? `（可参考：${hints.join('、')}）` : ''}，其余句子逐字保留，长度与句数不变（长度允许 ±${tolPct}%）。`,
    mustWrap('calibdegrade', '现场', original, seed, `${id}:现场`),
    '',
    '# 要求',
    '1. changes 逐条列出每一处替换：from 是原文里被换掉的片段（逐字照抄），to 是换上去的片段（在新正文里逐字出现）。',
    '2. 每处替换都留在原来那一句里，不合并、不拆分句子。',
    '',
    outputBlock({ text: '替换后的全文', changes: [{ from: '原文片段', to: '替换后片段' }] }),
  ].join('\n');
  return { id, role: ROLE_CALIB_DEGRADE, prompt, parse: (text) => parseDegrade(text, original, tolPct), retryPrompt: retryWith(prompt) };
}

function parseDegrade(text: string, original: string, tolPct: number): Result<DegradeOut> {
  const obj = parseFencedJson(text);
  if (!obj.ok) return obj;
  const body = readCapped(obj.value, 'text', TEXT_MAX);
  if (!body.ok) return body;
  const list = obj.value['changes'];
  if (!Array.isArray(list)) return err('changes: missing or not an array');
  if (list.length < 3 || list.length > 6) return err(`changes: ${list.length} changes, expected 3 to 6`);
  const changes: Array<{ from: string; to: string }> = [];
  for (const [i, c] of list.entries()) {
    if (!isRecord(c)) return err(`changes[${i}]: not an object`);
    const from = readCapped(c, 'from', TEXT_MAX);
    const to = readCapped(c, 'to', TEXT_MAX);
    if (!from.ok) return err(`changes[${i}].${from.error}`);
    if (!to.ok) return err(`changes[${i}].${to.error}`);
    if (from.value === to.value) return err(`changes[${i}]: from equals to`);
    if (!original.includes(from.value)) return err(`changes[${i}].from: not found verbatim in the original`);
    if (body.value.includes(from.value)) return err(`changes[${i}].from: still present in the new text`);
    if (!body.value.includes(to.value)) return err(`changes[${i}].to: not found verbatim in the new text`);
    changes.push({ from: from.value, to: to.value });
  }
  const before = splitSentences(original).length;
  const after = splitSentences(body.value).length;
  if (before !== after) return err(`text: ${after} sentences, the original has ${before}`);
  const target = charCount(original);
  if (!withinTolerance(charCount(body.value), target, tolPct)) return err(`text: length outside ${target} +/- ${tolPct}%`);
  return ok({ text: body.value, changes });
}

/** One text as c1 made it (before it becomes a CalibTextRecord). */
interface Made {
  id: string;
  role: TextRole;
  text: string;
  model: string | null;
  family: Family;
  stance: string | null;
  source: { file: string; quote_sha256: string } | null;
  of: string | null;
  call: string | null;
}

type Attempt = { ok: true; made: Made[] } | { ok: false; text: string; error: string };

/** What every c1 task needs besides the StepContext. */
interface BuildEnv {
  ctx: StepContext;
  set: SetId;
  seed: string;
  cfg: BuildConfig;
  reference: CalibReference;
  /** Texts of earlier sets a G set's copies are made of (id → Made), else empty. */
  foreign: ReadonlyMap<string, Made>;
}

function sourceOf(p: Passage): { file: string; quote_sha256: string } {
  return { file: p.file, quote_sha256: p.sha256 };
}

function gateway(env: BuildEnv, model: string): Backend {
  const backend = env.ctx.backends.calibGateway.get(model);
  if (backend === undefined) throw new Error(`c1-build: no calibration gateway backend for ${model}`);
  return backend;
}

/** A plan text with its passage replaced (a re-plan keeps ids, stances and models). */
function onPassage(t: TextPlan, passage: Passage): TextPlan {
  if (t.role === 'passage') return { ...t, passage };
  if (t.role === 'rewrite') return { ...t, passage };
  return t;
}

/** Runs one passage or rewrite / degraded text; null when its task voided (error in `why`). */
async function makeText(env: BuildEnv, t: TextPlan, attempt: 1 | 2, made: ReadonlyMap<string, Made>, why: { error: string }): Promise<Made | null> {
  const { ctx, cfg, seed } = env;
  const tol = cfg.lengthTolerancePct;
  if (t.role === 'passage') {
    return { id: t.id, role: 'passage', text: t.passage.text, model: null, family: CANON_AUTHOR, stance: null, source: sourceOf(t.passage), of: null, call: null };
  }
  if (t.role === 'rewrite') {
    const backend = gateway(env, t.model);
    const spec = rewriteTask(replanned(rewriteTaskId(t.id), attempt), t.passage, t.stance, charCount(t.passage.text), tol, seed);
    const r = await runTask(ctx, backend, spec);
    if (r.value === null) {
      why.error = r.error ?? 'void';
      return null;
    }
    return { id: t.id, role: 'rewrite', text: r.value.text, model: t.model, family: backend.family, stance: t.stance.id, source: sourceOf(t.passage), of: null, call: spec.id };
  }
  if (t.role === 'degraded') {
    const base = made.get(t.of);
    if (base === undefined) throw new Error(`c1-build: ${t.id} is planned before its base ${t.of}`);
    const backend = gateway(env, t.model);
    const cliches = ctx.protocol.forbidden.map((f) => f.term);
    const spec = degradeTask(replanned(degradeTaskId(t.id), attempt), base.text, cliches, tol, seed);
    const r = await runTask(ctx, backend, spec);
    if (r.value === null) {
      why.error = r.error ?? 'void';
      return null;
    }
    return { id: t.id, role: 'degraded', text: r.value.text, model: t.model, family: backend.family, stance: null, source: base.source, of: base.id, call: spec.id };
  }
  throw new Error(`c1-build: defect copy ${t.id} is made by the dry-run phase`);
}

/** The texts of one pair on one passage: rewrites (and the 8.1 passage) first, then degraded copies of them. */
async function runUnit(env: BuildEnv, texts: readonly TextPlan[], attempt: 1 | 2, passage: Passage | null): Promise<Attempt> {
  const plans = passage === null ? texts : texts.map((t) => onPassage(t, passage));
  const made = new Map<string, Made>();
  for (const stage of [plans.filter((t) => t.role !== 'degraded'), plans.filter((t) => t.role === 'degraded')]) {
    const results = await runAll(env.ctx, stage.map((t) => async (): Promise<{ t: TextPlan; m: Made | null; error: string }> => {
      const why = { error: '' };
      const m = await makeText(env, t, attempt, made, why);
      return { t, m, error: why.error };
    }));
    for (const r of results) {
      if (r.m === null) return { ok: false, text: r.t.id, error: r.error };
      made.set(r.m.id, r.m);
    }
  }
  return { ok: true, made: plans.map((t) => made.get(t.id)).filter((m): m is Made => m !== undefined) };
}

/**
 * Every pair's texts; a pair whose text voids is re-planned once on the next seeded passage (fresh `-2` task ids,
 * voided units in pair order take spares in order, so a resumed build re-plans identically); a second void → err.
 */
async function buildPairs(env: BuildEnv, plan: SetPlan, spares: (n: number) => Result<Passage[]>): Promise<Result<Made[]>> {
  const units = plan.pairs.map((p) => plan.texts.filter((t) => t.id === p.a || t.id === p.b));
  const first = await runAll(env.ctx, units.map((u) => () => runUnit(env, u, 1, null)));
  const voided = first.flatMap((r, i) => (r.ok ? [] : [i]));
  const results: Attempt[] = [...first];
  if (voided.length > 0) {
    const sp = spares(voided.length);
    if (!sp.ok) return err(`re-plan after a void: ${sp.error}`);
    const second = await runAll(env.ctx, voided.map((i, j) => () => runUnit(env, units[i] ?? [], 2, sp.value[j] ?? null)));
    for (const [j, i] of voided.entries()) {
      const r = second[j];
      const before = first[i];
      if (r === undefined || !r.ok) return err(`${r?.ok === false ? r.text : '?'} voided again after a re-plan with the next seeded passage: ${r?.ok === false ? r.error : ''}`);
      if (before !== undefined && !before.ok) env.ctx.progress('c1-build', 'info', `${before.text} voided (${before.error}); pair re-planned on the next seeded passage`);
      results[i] = r;
    }
  }
  return ok(results.flatMap((r) => (r.ok ? r.made : [])));
}

/** The dry-run copy `d` of `base` (defect writer on ctx.backends.defect + applyDefect); null when the call voided. */
async function makeCopy(env: BuildEnv, d: DryrunPlan, type: DefectType, base: Made, attempt: 1 | 2, why: { error: string }): Promise<{ made: Made; record: DryrunRecord } | null> {
  const { ctx } = env;
  const brief = { facts: env.reference.facts, regression: env.reference.regression, forbidden: [...DEFAULT_FORBIDDEN] };
  const targets = defectTargets(type, brief, ctx.protocol.fixtureRxx);
  const spec = defectTask(base.text, type, targets, replanned(dryrunDefectTaskId(d.id), attempt), env.seed);
  const backend = ctx.backends.defect;
  const r = await runTask(ctx, backend, spec);
  if (r.value === null) {
    why.error = r.error ?? 'void';
    return null;
  }
  const defect = applyDefect(base.text, r.value, { submission: base.id, type: type.id });
  return {
    made: { id: d.copy, role: 'defect', text: defect.copy, model: backend.model, family: backend.family, stance: null, source: base.source, of: base.id, call: spec.id },
    record: { id: d.id, defect_type: type.id, base: base.id, copy: d.copy, injected: defect.injected, injected_span: defect.injectedSpan, against: defect.against },
  };
}

/** Dry-run copies; a void copy is re-planned once on the next unused seeded base (`spareBases` in order); a second void → err. */
async function buildDryrun(env: BuildEnv, plans: readonly DryrunPlan[], spareBases: readonly string[], texts: ReadonlyMap<string, Made>): Promise<Result<{ made: Made[]; records: DryrunRecord[] }>> {
  const typeOf = (d: DryrunPlan): DefectType => {
    const t = env.ctx.protocol.defectTypes.find((x) => x.id === d.defectType);
    if (t === undefined) throw new Error(`c1-build: unknown defect type ${d.defectType}`);
    return t;
  };
  const baseOf = (id: string): Made => {
    const b = texts.get(id) ?? env.foreign.get(id);
    if (b === undefined) throw new Error(`c1-build: dry-run base ${id} is not a built text`);
    return b;
  };
  const run = (d: DryrunPlan, attempt: 1 | 2) => async (): Promise<{ d: DryrunPlan; out: { made: Made; record: DryrunRecord } | null; error: string }> => {
    const why = { error: '' };
    return { d, out: await makeCopy(env, d, typeOf(d), baseOf(d.base), attempt, why), error: why.error };
  };
  const first = await runAll(env.ctx, plans.map((d) => run(d, 1)));
  const voided = first.flatMap((r, i) => (r.out === null ? [i] : []));
  if (voided.length > spareBases.length) return err(`dry-run: ${voided.length} copies voided and only ${spareBases.length} spare bases`);
  const retries = voided.map((i, j) => {
    const d = plans[i];
    const spare = spareBases[j];
    if (d === undefined || spare === undefined) throw new Error('c1-build: dry-run re-plan out of range');
    return run({ ...d, base: spare }, 2);
  });
  const second = await runAll(env.ctx, retries);
  const outs = first.map((r) => r.out);
  for (const [j, i] of voided.entries()) {
    const r = second[j];
    if (r === undefined || r.out === null) return err(`${plans[i]?.copy ?? '?'} voided again after a re-plan with the next seeded base: ${r?.error ?? ''}`);
    env.ctx.progress('c1-build', 'info', `${r.d.copy} voided (${first[i]?.error ?? ''}); re-planned on base ${r.d.base}`);
    outs[i] = r.out;
  }
  const done = outs.filter((o): o is { made: Made; record: DryrunRecord } => o !== null);
  return ok({ made: done.map((o) => o.made), records: done.map((o) => o.record) });
}

function failed(detail: string): StepOutcome {
  return { kind: 'failed', detail };
}

/** `n` past every `stale/<n>/` under markers/, tasks/ and calls/ (the runner's --redo-from numbering). */
function nextStale(paths: RoundPaths): number {
  let n = 1;
  for (const dir of [paths.markers, paths.tasks, paths.calls]) {
    const stale = join(dir, 'stale');
    if (!existsSync(stale)) continue;
    for (const name of readdirSync(stale)) if (/^[1-9][0-9]*$/u.test(name)) n = Math.max(n, Number(name) + 1);
  }
  return n;
}

/** The call labels of task `id` (task.ts): `<id>-a1`, `<id>-a2` and quota tries `<id>-a<k>-q<n>`. */
function isCallLabelOf(id: string, label: string): boolean {
  return label.startsWith(`${id}-a`) && /^[12](?:-q[1-9][0-9]*)?$/u.test(label.slice(id.length + 2));
}

/**
 * After a failed build: every void c1 task record and every re-plan (`-2`) record of the set moves to
 * `tasks/stale/<n>/`, its call files and transcripts to `calls/` / `.runs/…` `stale/<n>/` (as under --redo-from). A void
 * record is otherwise reused as void, so the build would fail again with no call; with them gone, rerunning
 * `forge calib build` with the same request calls those tasks afresh and re-plans from the kept first attempts
 * (re-plans are dropped because the spare a unit takes depends on which first attempts void). Returns the stale dir
 * (forge-relative) and the number of records moved.
 */
function archiveFailedTasks(ctx: StepContext): { dir: string; records: number } {
  const { tasks, calls, runs } = ctx.paths;
  const n = String(nextStale(ctx.paths));
  const dir = ctx.files.rel(join(tasks, 'stale', n));
  if (!existsSync(tasks)) return { dir, records: 0 };
  const set = ctx.roundId;
  const ours = [rewriteTaskId(set), degradeTaskId(set), dryrunDefectTaskId(set)].map((prefix) => `${prefix}-`);
  const ids = readdirSync(tasks)
    .filter((name) => name.endsWith('.json') && ours.some((p) => name.startsWith(p)))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((id) => {
      if (id.endsWith('-2')) return true;
      const rec = readTaskRecord(join(tasks, `${id}.json`));
      return rec !== null && rec.ok && rec.value.status === 'void';
    })
    .sort(byCodeUnit);
  const places: ReadonlyArray<readonly [string, string]> = [[calls, '.json'], [runs, '.out.txt'], [runs, '.txt']];
  for (const id of ids) {
    ctx.files.move(join(tasks, `${id}.json`), join(tasks, 'stale', n, `${id}.json`));
    for (const [place, ext] of places) {
      if (!existsSync(place)) continue;
      for (const name of readdirSync(place)) {
        if (name.endsWith(ext) && isCallLabelOf(id, name.slice(0, -ext.length))) ctx.files.move(join(place, name), join(place, 'stale', n, name));
      }
    }
  }
  return { dir, records: ids.length };
}

/** failed, after archiveFailedTasks; the detail says where the records went and how to retry. */
function buildFailed(ctx: StepContext, detail: string): StepOutcome {
  const moved = archiveFailedTasks(ctx);
  if (moved.records === 0) return failed(detail);
  return failed(`${detail}; moved ${moved.records} void or re-planned task record(s) to ${moved.dir}/, rerun the same forge calib build to call them again`);
}

function textPath(root: string, id: string): string {
  return join(root, 'calibration', 'texts', `${id}.md`);
}

/** Defect types that offer a target against the set's reference (D3 needs a D3_KEYWORDS forbidden move, D4 fixture-rxx). */
function enabledTypes(ctx: StepContext, reference: CalibReference): DefectType[] {
  const brief = { facts: reference.facts, regression: reference.regression, forbidden: [...DEFAULT_FORBIDDEN] };
  return ctx.protocol.defectTypes.filter((t) => targetIds(defectTargets(t, brief, ctx.protocol.fixtureRxx)).length > 0);
}

/** The C00 texts a G set copies, read from `texts/` and checked against the C00 record (a changed file is an integrity error). */
function c00Bases(root: string, c00: CalibSetRecord): Map<string, Made> {
  const out = new Map<string, Made>();
  for (const p of c00.pairs) {
    const id = p.known_better;
    const t = id === null ? undefined : c00.texts[id];
    if (id === null || t === undefined) continue;
    const path = textPath(root, id);
    const text = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (text === null || sha256(text) !== t.sha256) throw new IntegrityError(`calibration/${t.path} is missing or differs from calibration/pairs.json set C00`);
    out.set(id, { id, role: t.role, text, model: t.model, family: t.author_family, stance: t.stance, source: t.source, of: t.of, call: t.call });
  }
  return out;
}

/** Writes texts/<id>.md (bytes = the text); an existing file must already hold exactly that text. */
function writeTexts(ctx: StepContext, made: readonly Made[]): string[] {
  return made.map((m) => {
    const path = textPath(ctx.root, m.id);
    if (existsSync(path)) {
      if (readFileSync(path, 'utf8') !== m.text) throw new IntegrityError(`${ctx.files.rel(path)} differs from the text c1 built for it`);
      return ctx.files.rel(path);
    }
    return ctx.files.writeText(path, m.text);
  });
}

function textRecord(m: Made): CalibTextRecord {
  return { path: `texts/${m.id}.md`, sha256: sha256(m.text), role: m.role, model: m.model, author_family: m.family, stance: m.stance, source: m.source, of: m.of, call: m.call };
}

interface Built {
  plan: SetPlan;
  made: Made[];
  dryrun: DryrunRecord[];
}

/** pairs.json `sets[set]`: pairs with authors and split, the display order, the dry-run records. */
function setRecord(ctx: StepContext, request: SetRequest, built: Built, builtAt: string): CalibSetRecord {
  const { plan, made } = built;
  const byId = new Map(made.map((m) => [m.id, m]));
  const cal = ctx.protocol.calibration;
  const split = plan.kind === 'round0' ? splitRound0(plan.pairs, cal.visibleRound0, request.seed) : {};
  const familyOfText = (id: string): Family => {
    const m = byId.get(id);
    if (m === undefined) throw new Error(`c1-build: pair text ${id} was not built`);
    return m.family;
  };
  const pairs: CalibPairRecord[] = plan.pairs.map((p) => ({
    id: p.id, category: p.category, a: p.a, b: p.b, known_better: p.knownBetter,
    authors: [...new Set([familyOfText(p.a), familyOfText(p.b)])].sort(byCodeUnit),
    split: split[p.id] ?? 'none',
  }));
  const display = displayOrder(plan.pairs, plan.kind === 'round0' ? cal.retestPairs : 0, request.seed).map((d) => ({ slot: d.slot, pair: d.pair, left: d.left, right: d.right, retest_of: d.retestOf }));
  const texts: Record<string, CalibTextRecord> = {};
  for (const m of made) texts[m.id] = textRecord(m);
  return {
    kind: plan.kind, family: request.family, reason: request.reason, seed: request.seed, built_at: builtAt, size: display.length, texts, pairs, display, dryrun: built.dryrun,
  };
}

/** Adds the set to pairs.json once (read-modify-write of the whole file); an existing set must equal the rebuilt one. */
function commitSet(ctx: StepContext, file: CalibPairsFile, set: SetId, record: CalibSetRecord): string {
  const path = join(ctx.root, PAIRS_FILE);
  const existing = file.sets[set];
  if (existing !== undefined) {
    if (canonicalJson(existing) !== canonicalJson(record)) throw new IntegrityError(`${PAIRS_FILE} set ${set} differs from what c1 rebuilds; a set is never rewritten`);
    return ctx.files.rel(path);
  }
  const check = parseSetRecord(set, record);
  if (!check.ok) throw new Error(`c1-build: set ${set} record is invalid: ${check.error}`);
  // Earlier sets are copied as read (not re-serialized from the parsed form), so their bytes stay as written.
  const raw = readJsonFile(path, PAIRS_FILE);
  const sets = raw !== null && raw.ok ? (readRecord(raw.value, 'sets') ?? {}) : {};
  return ctx.files.writeJson(path, { schema: 'calib-pairs/1', sets: { ...sets, [set]: record } });
}

/** Plans the set, makes every text (re-planning voids once) and the dry-run copies; err → the step fails. */
async function buildSet(ctx: StepContext, request: SetRequest, cfg: BuildConfig, file: CalibPairsFile, canon: Readonly<Record<string, string>>, reference: CalibReference): Promise<Result<Built>> {
  const { set, seed } = request;
  const cal = ctx.protocol.calibration;
  // Passages of the sets built before this one (all others while it is pending; on a rerun of a committed set, the
  // ones with an earlier built_at), so a rebuild after later sets exist selects the same passages.
  const mine = file.sets[set];
  const earlier = Object.entries(file.sets).filter(([id, s]) => id !== set && (mine === undefined || s.built_at < mine.built_at || (s.built_at === mine.built_at && id < set)));
  const used = new Set(earlier.flatMap(([, s]) => Object.values(s.texts).flatMap((t) => (t.source === null ? [] : [t.source.quote_sha256]))));
  const types = enabledTypes(ctx, reference);
  let plan: SetPlan;
  let foreign = new Map<string, Made>();
  let need = 0;
  if (request.kind === 'gate') {
    const c00 = file.sets['C00'];
    if (c00 === undefined || request.family === null) return err('a gate set copies C00 known-base rewrites; build C00 first');
    foreign = c00Bases(ctx.root, c00);
    plan = planGate(set, request.family, [...foreign.keys()], types, seed);
  } else {
    need = request.kind === 'round0' ? cal.categories.length * cal.pairsPerCategory : cal.requal.nonknown + cal.requal.known;
    const passages = selectPassages(canon, cfg, used, need, seed);
    if (!passages.ok) return passages;
    if (request.kind === 'round0') plan = planRound0(passages.value, cfg, cal, seed);
    else if (request.family === null) return err('a requal set needs a family');
    else plan = { ...planRequal(set, request.family, passages.value, cfg, cal, seed), reason: request.reason };
  }
  const models = new Set(plan.texts.flatMap((t) => (t.role === 'rewrite' || t.role === 'degraded' ? [t.model] : [])));
  const missing = [...models].filter((m) => !ctx.backends.calibGateway.has(m));
  if (missing.length > 0) return err(`no calibration gateway backend for ${missing.join(', ')}`);
  const env: BuildEnv = { ctx, set, seed, cfg, reference, foreign };
  const spares = (n: number): Result<Passage[]> => {
    const more = selectPassages(canon, cfg, used, need + n, seed);
    return more.ok ? ok(more.value.slice(need)) : more;
  };
  const pairs = await buildPairs(env, plan, spares);
  if (!pairs.ok) return pairs;
  const made = new Map(pairs.value.map((m) => [m.id, m]));
  let dryPlans = plan.dryrun;
  let bases = [...foreign.keys()];
  if (plan.kind === 'round0') {
    bases = plan.pairs.flatMap((p) => (p.category === 'known' && p.knownBetter !== null ? [p.knownBetter] : []));
    const offset = plan.texts.length;
    dryPlans = planDryrun(set, bases, types, seed).map((d, i) => ({ ...d, copy: calibTextId(set, offset + i + 1) }));
    plan = { ...plan, texts: [...plan.texts, ...dryPlans.map((d): TextPlan => ({ id: d.copy, role: 'defect', of: d.base, defectType: d.defectType }))], dryrun: dryPlans };
  }
  const spareBases = dryrunBases(set, bases, seed).slice(dryPlans.length);
  const dry = await buildDryrun(env, dryPlans, spareBases, made);
  if (!dry.ok) return dry;
  return ok({ plan, made: [...pairs.value, ...dry.value.made], dryrun: dry.value.records });
}

/**
 * c1-build: reads `<set>/request.json` (its seed: ctx.seed() needs the pairs.json record this step writes),
 * `calibration/build.json` and the canon; plans; makes every text (≈ 42 gateway calls for C00 via
 * ctx.backends.calibGateway by model id, plus one defect-writer call per dry-run copy); writes `texts/*.md` and
 * `<set>/reference.json`, then adds the set to `calibration/pairs.json` (external: later sets rewrite the file). A
 * resumed build reuses every task record (no new calls) and must rebuild the identical set. A text that voids is
 * re-planned once with the next seeded passage (a dry-run copy with the next seeded base); a second void → failed.
 */
export const buildStep: StepDef = {
  id: 'c1-build',
  run: async (ctx) => {
    if (ctx.pipeline !== 'calibration') throw new Error(`c1-build runs in the calibration pipeline, not ${ctx.pipeline}`);
    const request = readSetRequest(ctx.paths);
    if (!request.ok) throw new IntegrityError(request.error);
    const cfgRaw = readJsonFile(join(ctx.root, BUILD_CONFIG), BUILD_CONFIG) ?? err(`${BUILD_CONFIG} is missing`);
    if (!cfgRaw.ok) return failed(cfgRaw.error);
    const judgeFamilies = new Set<Family>([...ctx.config.judges.map((j) => j.family), ctx.config.maintainer.family]);
    const cfg = parseBuildConfig(cfgRaw.value, ctx.config.prefixes, judgeFamilies);
    if (!cfg.ok) return failed(cfg.error);
    const file = readCalibPairs(ctx.root);
    if (!file.ok) throw new IntegrityError(file.error);
    const canon = canonFiles(ctx.repo);
    const reference = buildReference(ctx.root, canon, ctx.protocol.fixtureRxx);
    if (!reference.ok) return failed(reference.error);
    ctx.progress('c1-build', 'start', `${request.value.set}: building (${request.value.kind})`);
    let built: Result<Built>;
    try {
      built = await buildSet(ctx, request.value, cfg.value, file.value, canon, reference.value);
    } catch (e) {
      if (e instanceof RangeError) return buildFailed(ctx, message(e));
      throw e;
    }
    if (!built.ok) return buildFailed(ctx, built.error);
    const texts = writeTexts(ctx, built.value.made);
    const ref = ctx.files.writeJson(join(ctx.paths.dir, REFERENCE_FILE), reference.value);
    const builtAt = file.value.sets[request.value.set]?.built_at ?? ctx.ports.clock.now();
    const record = setRecord(ctx, request.value, built.value, builtAt);
    const pairsFile = commitSet(ctx, file.value, request.value.set, record);
    const pin = ctx.files.writeText(join(ctx.paths.dir, PAIRS_PIN_FILE), `${setSha256(record)}\n`);
    ctx.progress('c1-build', 'done', `${request.value.set}: ${built.value.made.length} texts, ${built.value.plan.pairs.length} pairs, ${built.value.dryrun.length} dry-run copies`);
    const inputs = [ctx.files.rel(join(ctx.paths.dir, REQUEST_FILE)), BUILD_CONFIG, FACT_STATUS_FILE, REGRESSION_FILE];
    if (request.value.kind === 'gate') for (const id of new Set(built.value.dryrun.map((d) => d.base))) inputs.push(ctx.files.rel(textPath(ctx.root, id)));
    return { kind: 'done', inputs, outputs: [...texts, ref, pin], external: [pairsFile] };
  },
};
