import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Backend } from './adapters/types.ts';
import { anonymizeText } from './anonymize.ts';
import type { Attempted } from './calls.ts';
import { activeBenchmark } from './bench-active.ts';
import { readBenchLog } from './bench-log.ts';
import { PAIRS_FILE, readCalibReference, readCalibSet, type CalibSetRecord, type SetId } from './calib-build.ts';
import { isFamily, type Family } from './config.ts';
import type { StepContext } from './context.ts';
import { isRecord, readBoolean, readRecord, readString, type JsonRecord } from './json.ts';
import { calibSet, OWNER_ANSWERS, OWNER_LOG, protocolGate, type CalibAnswer } from './owner-inputs.ts';
import { err, ok, type Result } from './result.ts';
import { runAll, type StepDef, type StepOutcome } from './runner.ts';
import { loadSchema, type Schema, schemaFile, validate } from './schema.ts';
import { canonicalJson } from './seal.ts';
import { sha256, type RoundPaths } from './store.ts';
import { IntegrityError, runTask, TASK_ID } from './task.ts';
import { caughtDefect, gateJudgeTask, type GatePack, type GateVerdict } from './tasks/gate-judge.ts';
import { quoteSpan } from './tasks/fenced.ts';
import { taskId } from './tasks/ids.ts';
import { tasteTask, type TasteVerdict } from './tasks/taste-pair.ts';
import type { Benchmark } from './taste.ts';
import { benchmarkUnresolved } from './steps/brief.ts';

/**
 * `forge calib run` (c2-gate-dryrun, c3-owner-answers, c4-judge; s4 §4.3). Gate dry-run jobs need no owner; taste
 * verdicts never exist before the owner answered the whole set; `pin.json` is written once and compared on every
 * rerun. A void verdict is final and counts as non-agreement with m unchanged (D5).
 */

/** `ab` = pair text a shown first. */
export type CalibOrder = 'ab' | 'ba';

export const CALIB_ORDERS: readonly CalibOrder[] = ['ab', 'ba'];

export interface CalibJob {
  set: SetId;
  pair: string;
  family: Family;
  /** Judge backend id. */
  judge: string;
  order: CalibOrder;
}

/** `calibration/<set>/verdicts/<family>/<pairId>-<ab|ba>.json` (schema/calib-verdict.schema.json). */
export interface VerdictRecord {
  pair: string;
  family: Family;
  judge: string;
  order: CalibOrder;
  text1: string;
  text2: string;
  status: 'ok' | 'void';
  /** Text id picked on bench.decisive; null when void. */
  decisive: string | null;
  /** Question id → picked text id ({} when void). */
  picks: Record<string, string>;
  quotes: Record<string, string>;
  error: string | null;
  /** Task id (calibTaskId). */
  call: string;
  benchmark_version: string;
}

/**
 * `calibration/<set>/dryrun/<family>/<G-id>.json` (parser only, no schema). `judge` / `model` = the backend that made
 * the call: a c2 rerun reuses the file only for the same judge, model and copy; c5 requires them to equal pin.json's
 * `judges[family]` for pinned sets.
 */
export interface DryrunVerdictRecord {
  id: string;
  family: Family;
  judge: string;
  /** Model id of the judge backend (`backend.model`). */
  model: string;
  copy: string;
  status: 'ok' | 'void';
  /** tasks/gate-judge.ts caughtDefect; a void call is a miss. */
  caught: boolean;
  error: string | null;
  call: string;
}

/** `calibration/<set>/pin.json` (schema/calib-pin.schema.json); context.ts reads benchmark_version / benchmark_sha256. */
export interface CalibPin {
  set: SetId;
  benchmark_version: string;
  benchmark_sha256: string;
  protocol_bundle_sha256: string;
  /** sha256(canonicalJson(pairs.json sets[set])) = owner-answers pairs_sha256. */
  pairs_sha256: string;
  /** sha256(canonicalJson(owner-answers.json sets[set])) of the complete set. */
  answers_sha256: string;
  judges: Partial<Record<Family, { id: string; model: string }>>;
}

export const PIN_FILE = 'pin.json';

const PAIR_ID = /^([CQG]\d{2})-(P\d{2,})$/u;
const DRYRUN_DIR = 'dryrun';

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The unchecked `calib-<set>-<judge>-<Pnn>-<order>`; null when `pairId` is not a calibration pair id. */
function calibIdText(pairId: string, judgeId: string, order: CalibOrder): string | null {
  const m = PAIR_ID.exec(pairId);
  const set = m?.[1];
  const pair = m?.[2];
  return set === undefined || pair === undefined ? null : `calib-${set}-${judgeId}-${pair}-${order}`;
}

function dryrunIdText(dryrunId: string, family: Family): string {
  return `gate-${dryrunId}-${family}`;
}

/** `calib-C00-kimi-P03-ab` (routing kind `calib`). */
export function calibTaskId(pairId: string, judgeId: string, order: CalibOrder): string {
  const id = calibIdText(pairId, judgeId, order);
  if (id === null) throw new Error(`calibTaskId: ${pairId} is not a calibration pair id`);
  return taskId(id);
}

/** `gate-C00-G1-xAI` (routing kind `gate`). */
export function dryrunTaskId(dryrunId: string, family: Family): string {
  return taskId(dryrunIdText(dryrunId, family));
}

export function verdictPath(paths: RoundPaths, family: Family, pairId: string, order: CalibOrder): string {
  return join(paths.taste, family, `${pairId}-${order}.json`);
}

export function dryrunPath(paths: RoundPaths, family: Family, dryrunId: string): string {
  return join(paths.dir, DRYRUN_DIR, family, `${dryrunId}.json`);
}

/** The first judge of each family, in judge order; a Q or G set keeps only its own family. */
function setPool<J extends { family: Family }>(record: CalibSetRecord, judges: readonly J[]): J[] {
  const out: J[] = [];
  for (const j of judges) {
    if (out.some((o) => o.family === j.family)) continue;
    if (record.kind !== 'round0' && j.family !== record.family) continue;
    out.push(j);
  }
  return out;
}

/** Every (pair, order) for every judge whose family is not in pair.authors; Q sets only for set.family; G sets none. Retests are not re-judged (D6). */
export function jobsFor(set: SetId, record: CalibSetRecord, judges: ReadonlyArray<{ id: string; family: Family }>): CalibJob[] {
  if (record.kind === 'gate') return [];
  const pool = setPool(record, judges);
  const out: CalibJob[] = [];
  for (const pair of record.pairs) {
    for (const j of pool) {
      if (pair.authors.includes(j.family)) continue;
      for (const order of CALIB_ORDERS) out.push({ set, pair: pair.id, family: j.family, judge: j.id, order });
    }
  }
  return out;
}

const schemas = new Map<string, Schema>();

/** The engine's copy of schema/<name>.schema.json (module-relative, so temp forge roots need no schema dir). */
function schemaOf(name: string): Schema {
  const cached = schemas.get(name);
  if (cached !== undefined) return cached;
  const raw: unknown = JSON.parse(readFileSync(schemaFile(`${name}.schema.json`), 'utf8'));
  const schema = loadSchema(raw);
  if (!schema.ok) throw new Error(`schema/${name}.schema.json: ${schema.error}`);
  schemas.set(name, schema.value);
  return schema.value;
}

/** A JSON object of strings (picks, quotes); null when any value is not a string. */
function stringMap(value: JsonRecord | null): Record<string, string> | null {
  if (value === null) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') return null;
    out[k] = v;
  }
  return out;
}

function nullableString(value: unknown, key: string): { ok: true; value: string | null } | { ok: false } {
  if (!isRecord(value) || !Object.hasOwn(value, key)) return { ok: false };
  const v = value[key];
  if (v === null) return { ok: true, value: null };
  return typeof v === 'string' ? { ok: true, value: v } : { ok: false };
}

function isOrder(value: string | null): value is CalibOrder {
  return value === 'ab' || value === 'ba';
}

function isStatus(value: string | null): value is 'ok' | 'void' {
  return value === 'ok' || value === 'void';
}

/** Shape plus schema/calib-verdict.schema.json. */
export function parseVerdictRecord(value: unknown): Result<VerdictRecord> {
  const errors = validate(schemaOf('calib-verdict'), value);
  if (errors.length > 0) return err(errors.join('; '));
  const pair = readString(value, 'pair');
  const family = readString(value, 'family');
  const judge = readString(value, 'judge');
  const order = readString(value, 'order');
  const text1 = readString(value, 'text1');
  const text2 = readString(value, 'text2');
  const status = readString(value, 'status');
  const call = readString(value, 'call');
  const version = readString(value, 'benchmark_version');
  const decisive = nullableString(value, 'decisive');
  const error = nullableString(value, 'error');
  const picks = stringMap(readRecord(value, 'picks'));
  const quotes = stringMap(readRecord(value, 'quotes'));
  if (pair === null || family === null || !isFamily(family) || judge === null || !isOrder(order) || text1 === null || text2 === null || !isStatus(status) || call === null || version === null) {
    return err('malformed verdict');
  }
  if (!decisive.ok || !error.ok || picks === null || quotes === null) return err('decisive, error, picks and quotes are malformed');
  if (text1 === text2) return err('text1 and text2 are the same text');
  // parsers never throw: an id part that forms no task id (file input) is a parse error, not an engine bug
  const expected = calibIdText(pair, judge, order);
  if (expected === null) return err('pair: not a calibration pair id');
  if (!TASK_ID.test(expected)) return err('judge: not a task-id token');
  if (call !== expected) return err(`call ${call} is not the task id of ${pair} ${judge} ${order}`);
  const shown = [text1, text2];
  if (status === 'void') {
    if (decisive.value !== null || Object.keys(picks).length > 0 || Object.keys(quotes).length > 0 || error.value === null) return err('a void verdict has no decisive, picks or quotes and carries its error');
  } else {
    if (error.value !== null || decisive.value === null || !shown.includes(decisive.value)) return err('an ok verdict picks text1 or text2 on the decisive question and has no error');
    if (Object.keys(picks).length === 0 || Object.values(picks).some((p) => !shown.includes(p))) return err('every pick names text1 or text2');
    if (!Object.values(picks).includes(decisive.value)) return err('decisive is not one of the picks');
  }
  return ok({ pair, family, judge, order, text1, text2, status, decisive: decisive.value, picks, quotes, error: error.value, call, benchmark_version: version });
}

function relPath(paths: RoundPaths, path: string): string {
  return relative(paths.root, path).split(sep).join('/');
}

/** Parsed JSON of `path` (label = forge-root-relative path in errors). */
function readJsonFile(paths: RoundPaths, path: string): Result<unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return ok(raw);
  } catch (e) {
    return err(`${relPath(paths, path)}: ${message(e).split(path).join(relPath(paths, path))}`);
  }
}

/** `<dir>/<family>/<name>.json` files, family and name in code-unit order (stray files, e.g. `*.tmp`, ignored). */
function familyFiles(dir: string): Result<Array<{ family: Family; name: string; path: string }>> {
  if (!existsSync(dir)) return ok([]);
  const out: Array<{ family: Family; name: string; path: string }> = [];
  const dirs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  for (const family of dirs.sort(byCodeUnit)) {
    if (!isFamily(family)) return err(`${family} is not a judge family directory`);
    for (const file of readdirSync(join(dir, family)).sort(byCodeUnit)) {
      if (file.endsWith('.json')) out.push({ family, name: file.slice(0, -'.json'.length), path: join(dir, family, file) });
    }
  }
  return ok(out);
}

/** Every verdict file of the set (missing dir → []). */
export function readVerdicts(paths: RoundPaths): Result<VerdictRecord[]> {
  const files = familyFiles(paths.taste);
  if (!files.ok) return err(`${relPath(paths, paths.taste)}: ${files.error}`);
  const out: VerdictRecord[] = [];
  for (const f of files.value) {
    const raw = readJsonFile(paths, f.path);
    if (!raw.ok) return raw;
    const v = parseVerdictRecord(raw.value);
    if (!v.ok) return err(`${relPath(paths, f.path)}: ${v.error}`);
    if (v.value.family !== f.family || `${v.value.pair}-${v.value.order}` !== f.name) return err(`${relPath(paths, f.path)}: file name does not match its verdict`);
    out.push(v.value);
  }
  return ok(out);
}

export function parseDryrunVerdict(value: unknown): Result<DryrunVerdictRecord> {
  const id = readString(value, 'id');
  const family = readString(value, 'family');
  const judge = readString(value, 'judge');
  const model = readString(value, 'model');
  const copy = readString(value, 'copy');
  const status = readString(value, 'status');
  const caught = readBoolean(value, 'caught');
  const call = readString(value, 'call');
  const error = nullableString(value, 'error');
  if (id === null || family === null || !isFamily(family) || judge === null || model === null || model === '' || copy === null || !isStatus(status) || caught === null || call === null || !error.ok) {
    return err('malformed dry-run verdict');
  }
  const expected = dryrunIdText(id, family);
  if (!TASK_ID.test(expected)) return err('id: not a task-id token');
  if (call !== expected) return err(`call ${call} is not the task id of ${id} ${family}`);
  if (status === 'void' && (caught || error.value === null)) return err('a void dry-run call is a miss and carries its error');
  if (status === 'ok' && error.value !== null) return err('an ok dry-run call has no error');
  return ok({ id, family, judge, model, copy, status, caught, error: error.value, call });
}

/** Every dry-run verdict of the set (missing dir → []). */
export function readDryrunVerdicts(paths: RoundPaths): Result<DryrunVerdictRecord[]> {
  const dir = join(paths.dir, DRYRUN_DIR);
  const files = familyFiles(dir);
  if (!files.ok) return err(`${relPath(paths, dir)}: ${files.error}`);
  const out: DryrunVerdictRecord[] = [];
  for (const f of files.value) {
    const raw = readJsonFile(paths, f.path);
    if (!raw.ok) return raw;
    const v = parseDryrunVerdict(raw.value);
    if (!v.ok) return err(`${relPath(paths, f.path)}: ${v.error}`);
    if (v.value.family !== f.family || v.value.id !== f.name) return err(`${relPath(paths, f.path)}: file name does not match its verdict`);
    out.push(v.value);
  }
  return ok(out);
}

/** Shape plus schema/calib-pin.schema.json. */
export function parsePin(value: unknown): Result<CalibPin> {
  const errors = validate(schemaOf('calib-pin'), value);
  if (errors.length > 0) return err(errors.join('; '));
  const set = readString(value, 'set');
  const version = readString(value, 'benchmark_version');
  const benchSha = readString(value, 'benchmark_sha256');
  const bundle = readString(value, 'protocol_bundle_sha256');
  const pairs = readString(value, 'pairs_sha256');
  const answers = readString(value, 'answers_sha256');
  if (set === null || version === null || benchSha === null || bundle === null || pairs === null || answers === null) return err('malformed pin');
  const judges: CalibPin['judges'] = {};
  for (const [family, j] of Object.entries(readRecord(value, 'judges') ?? {})) {
    const id = readString(j, 'id');
    const model = readString(j, 'model');
    if (!isFamily(family) || id === null || model === null) return err(`judges.${family}: malformed`);
    judges[family] = { id, model };
  }
  return ok({ set, benchmark_version: version, benchmark_sha256: benchSha, protocol_bundle_sha256: bundle, pairs_sha256: pairs, answers_sha256: answers, judges });
}

/** null when `<paths.dir>/pin.json` is absent. */
export function readPin(paths: RoundPaths): Result<CalibPin> | null {
  const path = join(paths.dir, PIN_FILE);
  if (!existsSync(path)) return null;
  const raw = readJsonFile(paths, path);
  if (!raw.ok) return raw;
  const pin = parsePin(raw.value);
  return pin.ok ? pin : err(`${relPath(paths, path)}: ${pin.error}`);
}

/** Differing fields, like freeze.ts diffFreeze ([] = same). */
export function pinDiff(pinned: CalibPin, current: CalibPin): string[] {
  const out: string[] = [];
  const scalar = (name: string, was: string, now: string): void => {
    if (was !== now) out.push(`${name} changed: ${was} → ${now}`);
  };
  scalar('set', pinned.set, current.set);
  scalar('benchmark_version', pinned.benchmark_version, current.benchmark_version);
  if (pinned.benchmark_sha256 !== current.benchmark_sha256) out.push(`benchmark file changed (${pinned.benchmark_version})`);
  if (pinned.protocol_bundle_sha256 !== current.protocol_bundle_sha256) out.push('protocol bundle changed');
  if (pinned.pairs_sha256 !== current.pairs_sha256) out.push('pairs.json set changed');
  if (pinned.answers_sha256 !== current.answers_sha256) out.push('owner answers changed');
  const families = [...new Set([...Object.keys(pinned.judges), ...Object.keys(current.judges)])].filter(isFamily).sort(byCodeUnit);
  for (const family of families) {
    const was = pinned.judges[family];
    const now = current.judges[family];
    if (was === undefined) out.push(`judge not pinned: ${family}`);
    else if (now === undefined) out.push(`pinned judge missing: ${family}`);
    else if (was.id !== now.id || was.model !== now.model) out.push(`judge changed: ${family} ${was.id}/${was.model} → ${now.id}/${now.model}`);
  }
  return out;
}

/** One judge backend per family that judges the set (first configured judge of the family). */
interface SetJudge {
  id: string;
  family: Family;
  backend: Backend;
}

function setJudges(ctx: StepContext, record: CalibSetRecord): SetJudge[] {
  const pool = setPool(record, ctx.backends.judges.map((j) => ({ id: j.backend.id, family: j.backend.family, backend: j.backend })));
  // judges.json lost the set's family after the set was built: a state/config mismatch (exit 3), not an engine bug
  if (record.kind !== 'round0' && record.family !== null && !pool.some((j) => j.family === record.family)) throw new IntegrityError(`no judge backend of family ${record.family}`);
  return pool;
}

function setRecord(ctx: StepContext): CalibSetRecord {
  const r = readCalibSet(ctx.root, ctx.roundId);
  if (!r.ok) throw new IntegrityError(r.error);
  return r.value;
}

/** A set text as stored (`calibration/texts/<id>.md`), checked against its pairs.json hash. */
function setText(ctx: StepContext, record: CalibSetRecord, id: string): { text: string; rel: string } {
  const t = Object.hasOwn(record.texts, id) ? record.texts[id] : undefined;
  if (t === undefined) throw new IntegrityError(`calibration/pairs.json ${ctx.roundId} has no text ${id}`);
  const rel = `calibration/${t.path}`;
  const path = join(ctx.root, 'calibration', t.path);
  if (!existsSync(path)) throw new IntegrityError(`${rel} is missing`);
  const text = readFileSync(path, 'utf8');
  if (sha256(text) !== t.sha256) throw new IntegrityError(`${rel} does not match its pairs.json hash`);
  return { text, rel };
}

/**
 * An existing result file that parses and belongs to this job, else null (absent); a mismatching file is an integrity
 * error (`bound` names what `same` compares, for the message).
 */
function reusable<T>(ctx: StepContext, path: string, parse: (v: unknown) => Result<T>, same: (v: T) => boolean, bound: string): T | null {
  if (!existsSync(path)) return null;
  const raw = readJsonFile(ctx.paths, path);
  if (!raw.ok) throw new IntegrityError(raw.error);
  const v = parse(raw.value);
  if (!v.ok) throw new IntegrityError(`${ctx.files.rel(path)}: ${v.error}`);
  if (!same(v.value)) throw new IntegrityError(`${ctx.files.rel(path)} belongs to another ${bound}`);
  return v.value;
}

function dryrunRecord(ctx: StepContext, id: string, judge: SetJudge, copy: string, task: string, r: Attempted<GateVerdict>, caught: boolean): DryrunVerdictRecord {
  const by = { id, family: judge.family, judge: judge.id, model: judge.backend.model, copy };
  if (r.value === null) return { ...by, status: 'void', caught: false, error: ctx.redact(r.error ?? 'void'), call: task };
  return { ...by, status: 'ok', caught, error: null, call: task };
}

/**
 * c2: gateJudgeTask on each dry-run copy (anonymized, pack = `<set>/reference.json`) for every judge family (G: set.family);
 * caughtDefect against the injected sentence's span in the anonymized subject. No owner input. Each verdict file is written
 * as its call finishes, so a resumed run skips parsed files. Skip for Q sets.
 */
export const dryrunStep: StepDef = {
  id: 'c2-gate-dryrun',
  run: async (ctx) => {
    const record = setRecord(ctx);
    if (record.kind === 'requal') return { kind: 'skip', reason: 're-qualification sets have no gate dry-run' };
    if (record.dryrun.length === 0) return { kind: 'skip', reason: `${ctx.roundId} has no dry-run copies` };
    const ref = readCalibReference(ctx.paths);
    if (!ref.ok) throw new IntegrityError(ref.error);
    const judges = setJudges(ctx, record);
    const seed = ctx.seed();
    const inputs = new Set<string>([ctx.files.rel(join(ctx.paths.dir, 'reference.json'))]);
    const outputs: string[] = [];
    const jobs: Array<() => Promise<void>> = [];
    for (const d of record.dryrun) {
      const copy = setText(ctx, record, d.copy);
      inputs.add(copy.rel);
      const pack: GatePack = { subjectKind: 'text', subject: anonymizeText(copy.text), facts: ref.value.facts, regression: ref.value.regression, forbidden: ref.value.forbidden, negatedFlags: [] };
      // injected_span is measured on the raw copy; anonymizeText strips markup (list prefixes, URLs), so re-measure on the subject.
      const span = quoteSpan(d.injected, pack.subject);
      if (span === null) throw new IntegrityError(`${copy.rel}: injected sentence not in the displayed copy (${d.id})`);
      for (const judge of judges) {
        const path = dryrunPath(ctx.paths, judge.family, d.id);
        const task = dryrunTaskId(d.id, judge.family);
        outputs.push(ctx.files.rel(path));
        if (reusable(ctx, path, parseDryrunVerdict, (v) => v.judge === judge.id && v.model === judge.backend.model && v.copy === d.copy, 'judge, model or copy') !== null) continue;
        jobs.push(async () => {
          const r = await runTask(ctx, judge.backend, gateJudgeTask(pack, task, seed));
          const caught = caughtDefect(r.value, pack.subject, span);
          ctx.files.writeJson(path, dryrunRecord(ctx, d.id, judge, d.copy, task, r, caught));
        });
      }
    }
    await runAll(ctx, jobs);
    ctx.progress('c2-gate-dryrun', 'info', `${outputs.length} dry-run verdicts (${jobs.length} new)`);
    return { kind: 'done', inputs: [...inputs].sort(byCodeUnit), outputs: outputs.sort(byCodeUnit), external: [PAIRS_FILE] };
  },
};

type SetAnswers = { kind: 'complete'; answers: CalibAnswer[]; sha256: string } | { kind: 'wait'; outcome: StepOutcome };

function waitFor(waitingFor: 'calib_answers' | 'owner_log_repair', detail: string): SetAnswers {
  return { kind: 'wait', outcome: { kind: 'wait', waitingFor, detail, inputs: [], outputs: [] } };
}

/**
 * The set's owner answers through ctx.owner.calibAnswers() (s4 checks a–d): complete = every display slot answered.
 * Missing or incomplete → WAIT calib_answers (`n/size`); repair → WAIT owner_log_repair; invalid → IntegrityError.
 */
function setAnswers(ctx: StepContext, record: CalibSetRecord): SetAnswers {
  const read = ctx.owner.calibAnswers();
  const size = record.display.length;
  const pending = (n: number): SetAnswers => waitFor('calib_answers', `校准组 ${ctx.roundId}：owner 已答 ${n}/${size}`);
  if (read.state === 'missing') return pending(0);
  if (read.state === 'repair') return waitFor('owner_log_repair', read.detail);
  if (read.state === 'invalid') throw new IntegrityError(read.error);
  if (read.state === 'superseded') throw new IntegrityError(`${OWNER_ANSWERS} cannot be superseded`);
  const set = Object.hasOwn(read.value.sets, ctx.roundId) ? read.value.sets[ctx.roundId] : undefined;
  if (set === undefined) return pending(0);
  if (set.answers.length < size) return pending(set.answers.length);
  return { kind: 'complete', answers: set.answers, sha256: sha256(canonicalJson(set)) };
}

/** c3: WAIT calib_answers until every display slot of the set is answered (no taste verdict exists before); skip for G sets. */
export const answersStep: StepDef = {
  id: 'c3-owner-answers',
  run: async (ctx) => {
    const record = setRecord(ctx);
    if (record.kind === 'gate') return { kind: 'skip', reason: 'gate re-test sets have no owner answers' };
    const answers = setAnswers(ctx, record);
    if (answers.kind === 'wait') return answers.outcome;
    ctx.progress('c3-owner-answers', 'info', `${answers.answers.length}/${record.display.length} answers`);
    return { kind: 'done', inputs: [], outputs: [], external: [PAIRS_FILE, OWNER_ANSWERS, OWNER_LOG] };
  },
};

function pinJudges(judges: readonly SetJudge[]): CalibPin['judges'] {
  const out: CalibPin['judges'] = {};
  for (const j of judges) out[j.family] = { id: j.id, model: j.backend.model };
  return out;
}

function pairsSha256(ctx: StepContext): string {
  const set = calibSet(ctx.root, ctx.roundId);
  if (!set.ok) throw new IntegrityError(set.error);
  return set.value.pairsSha256;
}

/**
 * The first pin: the effective benchmark now (none → WAIT benchmark_approval); C00 must pin a root version (its log
 * entry has parent null), else blocked.
 */
function freshPin(ctx: StepContext, record: CalibSetRecord, answersSha: string, judges: readonly SetJudge[]): { kind: 'pin'; pin: CalibPin } | { kind: 'stop'; outcome: StepOutcome } {
  const bench = activeBenchmark(ctx, 'effective');
  if (!bench.ok) return { kind: 'stop', outcome: benchmarkUnresolved(bench.error) };
  if (record.kind === 'round0') {
    const log = readBenchLog(ctx.root);
    if (!log.ok) throw new IntegrityError(log.error);
    const entry = log.value.find((e) => e.version === bench.value.version);
    if (entry === undefined || entry.parent !== null) {
      return { kind: 'stop', outcome: { kind: 'blocked', detail: `${ctx.roundId} must pin a root benchmark version, but the effective version ${bench.value.version} has parent ${entry?.parent ?? 'unknown'}` } };
    }
  }
  const pin: CalibPin = {
    set: ctx.roundId, benchmark_version: bench.value.version, benchmark_sha256: bench.value.sha256, protocol_bundle_sha256: ctx.bundleSha256,
    pairs_sha256: pairsSha256(ctx), answers_sha256: answersSha, judges: pinJudges(judges),
  };
  return { kind: 'pin', pin };
}

/** What a rerun would pin now: the pinned version's current file bytes (never re-resolved), bundle, pairs, answers, judges. */
function currentPin(ctx: StepContext, pinned: CalibPin, answersSha: string, judges: readonly SetJudge[]): CalibPin {
  const path = join(ctx.root, 'benchmark', `${pinned.benchmark_version}.json`);
  const benchSha = existsSync(path) ? sha256(readFileSync(path, 'utf8')) : 'missing';
  return { ...pinned, benchmark_sha256: benchSha, protocol_bundle_sha256: ctx.bundleSha256, pairs_sha256: pairsSha256(ctx), answers_sha256: answersSha, judges: pinJudges(judges) };
}

function verdictOf(ctx: StepContext, bench: Benchmark, job: CalibJob, text1: string, text2: string, r: Attempted<TasteVerdict>): VerdictRecord {
  const base = { pair: job.pair, family: job.family, judge: job.judge, order: job.order, text1, text2, call: calibTaskId(job.pair, job.judge, job.order), benchmark_version: bench.version };
  const v = r.value;
  if (v === null) return { ...base, status: 'void', decisive: null, picks: {}, quotes: {}, error: ctx.redact(r.error ?? 'void') };
  const picks: Record<string, string> = {};
  for (const [q, pick] of Object.entries(v.picks)) picks[q] = pick === 1 ? text1 : text2;
  const decisive = Object.hasOwn(picks, bench.decisive) ? picks[bench.decisive] : undefined;
  if (decisive === undefined) throw new Error(`${base.call}: the verdict has no answer to ${bench.decisive}`);
  return { ...base, status: 'ok', decisive, picks, quotes: { ...v.quotes }, error: null };
}

/**
 * c4: protocol gate; the complete owner answers (as c3); `pin.json` written once, then compared on every rerun (any
 * difference → IntegrityError); then tasteTask(ctx.benchmark(), {text1, text2, decoy: null}) on anonymized texts for
 * jobsFor(…), each verdict file written as its call finishes. A void verdict is final; parsed files are skipped on
 * resume. Skip for G sets.
 */
export const judgeStep: StepDef = {
  id: 'c4-judge',
  run: async (ctx) => {
    const record = setRecord(ctx);
    if (record.kind === 'gate') return { kind: 'skip', reason: 'gate re-test sets have no taste calls' };
    const gate = protocolGate(ctx);
    if (gate !== null) return gate;
    const answers = setAnswers(ctx, record);
    if (answers.kind === 'wait') return answers.outcome;
    const judges = setJudges(ctx, record);
    const pinPath = join(ctx.paths.dir, PIN_FILE);
    const pinned = readPin(ctx.paths);
    if (pinned === null) {
      const fresh = freshPin(ctx, record, answers.sha256, judges);
      if (fresh.kind === 'stop') return fresh.outcome;
      ctx.files.writeJson(pinPath, fresh.pin);
    } else {
      if (!pinned.ok) throw new IntegrityError(pinned.error);
      const drift = pinDiff(pinned.value, currentPin(ctx, pinned.value, answers.sha256, judges));
      if (drift.length > 0) throw new IntegrityError(`calibration/${ctx.roundId}/${PIN_FILE} refuses the rerun: ${drift.join('; ')}`);
    }
    const bench = ctx.benchmark();
    const seed = ctx.seed();
    const pairs = new Map(record.pairs.map((p) => [p.id, p]));
    const backends = new Map(judges.map((j) => [j.id, j.backend]));
    const inputs = new Set<string>();
    const outputs: string[] = [ctx.files.rel(pinPath)];
    const jobs: Array<() => Promise<void>> = [];
    for (const job of jobsFor(ctx.roundId, record, judges)) {
      const pair = pairs.get(job.pair);
      const backend = backends.get(job.judge);
      if (pair === undefined || backend === undefined) throw new Error(`c4-judge: job ${job.pair} ${job.judge} has no pair or backend`);
      const [id1, id2] = job.order === 'ab' ? [pair.a, pair.b] : [pair.b, pair.a];
      const t1 = setText(ctx, record, id1);
      const t2 = setText(ctx, record, id2);
      inputs.add(t1.rel).add(t2.rel);
      const path = verdictPath(ctx.paths, job.family, job.pair, job.order);
      outputs.push(ctx.files.rel(path));
      if (reusable(ctx, path, parseVerdictRecord, (v) => v.judge === job.judge && v.text1 === id1 && v.text2 === id2 && v.benchmark_version === bench.version, 'judge, text or benchmark version') !== null) continue;
      jobs.push(async () => {
        const spec = tasteTask(bench, { text1: anonymizeText(t1.text), text2: anonymizeText(t2.text), decoy: null }, seed, calibTaskId(job.pair, job.judge, job.order));
        const r = await runTask(ctx, backend, spec);
        ctx.files.writeJson(path, verdictOf(ctx, bench, job, id1, id2, r));
      });
    }
    await runAll(ctx, jobs);
    ctx.progress('c4-judge', 'info', `${outputs.length - 1} taste verdicts (${jobs.length} new) on ${bench.version}`);
    return { kind: 'done', inputs: [...inputs].sort(byCodeUnit), outputs: outputs.sort(byCodeUnit), external: [PAIRS_FILE, OWNER_ANSWERS] };
  },
};
