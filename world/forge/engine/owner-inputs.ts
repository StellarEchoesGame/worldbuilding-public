import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StepContext } from './context.ts';
import { isRecord, readArray, readBoolean, readNumber, readRecord, readString, type JsonRecord } from './json.ts';
import { err, ok, type Result } from './result.ts';
import type { StepOutcome } from './runner.ts';
import { loadSchema, type Schema, schemaFile, validate } from './schema.ts';
import { canonicalJson } from './seal.ts';

export type OwnerAction =
  | 'protocol_approved'
  | 'topic'
  | 'audit'
  | 'decision'
  | 'diff_approved'
  | 'calib_answers'
  | 'bench_diff_viewed'
  | 'bench_approved'
  | 'rollback';

/** One `owner-log.jsonl` line (UI-written). Keys absent in older UI lines parse as null. */
export interface OwnerLogEntry {
  at: string;
  action: OwnerAction;
  round: string | null;
  /** Forge-root-relative file (protocol approvals: 'protocol-bundle'). */
  file: string | null;
  /** SHA-256 of the file bytes after the write (protocol approvals: the bundle hash). */
  sha256: string;
  source: 'ui';
  /** Benchmark version (bench_diff_viewed, bench_approved, rollback target). */
  version: string | null;
  /** rollback: the version active when the owner clicked. */
  from: string | null;
  /** calib_answers: calibration set id. */
  set: string | null;
  /** calib_answers: display slots answered in this POST. */
  slots: number[] | null;
}

export type OwnerRead<T> =
  | { state: 'missing' }
  | { state: 'superseded'; sha256: string }
  | { state: 'repair'; detail: string }
  | { state: 'invalid'; error: string }
  | { state: 'ok'; value: T; sha256: string; at: string };

export type TopicSource = 'ui' | 'auto_default' | 'fixed';

/** `rounds/RNN/topic.json` (UI, or engine for auto_default / fixed; exclusive create either way). */
export interface Topic {
  round: string;
  row_id: string;
  layer: string;
  /** Cell file (forge-root-relative) for fixed rounds, else null. */
  cell: string | null;
  source: TopicSource;
  chosen_at: string;
}

export interface AuditAnswer {
  pair: string;
  left: string;
  right: string;
  choice: 'left' | 'right';
  chosen: string;
}

/** `rounds/RNN/audit.json`; keys must equal the pair ids of the audit-set.json pinned by the 09a marker. */
export interface AuditAnswers {
  round: string;
  answers: AuditAnswer[];
  answered_at: string;
}

export interface DecisionFact {
  label: string;
  submission: string;
  id: string;
  claim: string;
}

/** `rounds/RNN/decision.json` or `decision-<n>.json` (append-only chain, PROTOCOL §6). */
export interface Decision {
  round: string;
  /** Candidate label or 'none'. */
  pick: string;
  pick_submission: string | null;
  /** Base label when it differs from the pick, else null (base = base ?? pick). */
  base: string | null;
  champion: string;
  facts: DecisionFact[];
  reason: string;
  fav: string;
  publish: 'yes' | 'no';
  happened: boolean;
  /** SHA-256 of the decision file this one replaces; null for decision.json. */
  supersedes: string | null;
  decided_at: string;
  /** Forge-root-relative path of the file read (not a JSON key). */
  file: string;
}

export interface CalibAnswer {
  slot: number;
  pair: string;
  left: string;
  right: string;
  choice: 'left' | 'right';
  chosen: string;
  answered_at: string;
  ms: number | null;
}

/** `calibration/owner-answers.json` (UI only). */
export interface CalibAnswers {
  sets: Record<string, { pairs_sha256: string; answers: CalibAnswer[] }>;
}

/** `{status}` of `merge/<d8>/regate.json` and `postmerge-gate.json`. */
export type GateRecordStatus = 'pass' | 'fail' | 'split' | 'unverified' | 'trial';

/**
 * The only reader of owner files. A file is `ok` only when it validates against its schema and the latest
 * owner-log entry for (action, round / set) has its SHA-256 and `source: "ui"`; hash mismatch → invalid
 * (exit 3); file without entry or a torn middle log line → repair (WAIT owner_log_repair).
 */
export interface OwnerInputs {
  entries(): readonly OwnerLogEntry[];
  /** The latest protocol_approved entry when it equals the bundle, else null. */
  protocolApproval(bundleSha256: string): OwnerLogEntry | null;
  /** UI entry, or engine file with source auto_default | fixed (no log entry needed). */
  topic(round: string): OwnerRead<Topic>;
  audit(round: string): OwnerRead<AuditAnswers>;
  /** Latest valid of decision.json, decision-2.json, …; superseded while its gate record is non-pass. */
  decision(round: string): OwnerRead<Decision>;
  /** `at` of the matching diff_approved entry, else null. */
  diffApproved(round: string, diffSha256: string): string | null;
  /** s4 checks (a)–(d) per set. */
  calibAnswers(): OwnerRead<CalibAnswers>;
  benchDiffViewed(version: string, sha256: string): string | null;
  benchApproved(version: string, sha256: string): string | null;
  rollbacks(): Array<{ at: string; version: string; from: string; sha256: string; round: string | null }>;
}


/** Forge-root-relative owner files (the UI's write targets; OWNER_ONLY in context.ts guards the engine). */
export const OWNER_LOG = 'owner-log.jsonl';
export const OWNER_ANSWERS = 'calibration/owner-answers.json';
/** `file` of protocol_approved entries (their `sha256` is the bundle hash). */
export const PROTOCOL_BUNDLE_FILE = 'protocol-bundle';

export const OWNER_ACTIONS: readonly OwnerAction[] = [
  'protocol_approved', 'topic', 'audit', 'decision', 'diff_approved', 'calib_answers', 'bench_diff_viewed', 'bench_approved', 'rollback',
];

const GATE_STATUSES: readonly GateRecordStatus[] = ['pass', 'fail', 'split', 'unverified', 'trial'];
const HEX64 = /^[0-9a-f]{64}$/u;
/** Decision chain file names: `decision.json` or `decision-<n>.json` (n a positive integer without a leading zero). */
export const DECISION_FILE = /^decision(?:-([1-9]\d*))?\.json$/u;

export function isOwnerAction(value: string): value is OwnerAction {
  return OWNER_ACTIONS.some((a) => a === value);
}

function isGateStatus(value: string): value is GateRecordStatus {
  return GATE_STATUSES.some((s) => s === value);
}

/** SHA-256 of file bytes (owner-log entries and markers hash bytes, not decoded text). */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type OwnerSchemaName = 'owner-log' | 'topic' | 'audit' | 'decision';

const schemaCache = new Map<OwnerSchemaName, Schema>();

/** The engine's own copy under world/forge/schema/ (module-relative, so temp forge roots need no schema dir). */
function ownerSchema(name: OwnerSchemaName): Schema {
  const cached = schemaCache.get(name);
  if (cached !== undefined) return cached;
  const path = schemaFile(`${name}.schema.json`);
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const schema = loadSchema(raw);
  if (!schema.ok) throw new Error(`schema/${name}.schema.json: ${schema.error}`);
  schemaCache.set(name, schema.value);
  return schema.value;
}

/** Schema errors of an owner file or owner-log line ([] = valid). Used by the reader and by owner-sim. */
export function validateOwnerFile(name: OwnerSchemaName, value: unknown): string[] {
  return validate(ownerSchema(name), value);
}

/** Per-action keys the schema cannot express (it has no conditionals). */
function actionProblem(e: OwnerLogEntry): string | null {
  switch (e.action) {
    case 'topic':
    case 'audit':
    case 'decision':
    case 'diff_approved':
      return e.round === null || e.file === null ? `${e.action} entry needs round and file` : null;
    case 'bench_diff_viewed':
    case 'bench_approved':
      return e.version === null || e.file === null ? `${e.action} entry needs version and file` : null;
    case 'rollback':
      return e.version === null || e.from === null || e.file === null ? 'rollback entry needs version, from and file' : null;
    case 'calib_answers':
      return e.set === null || e.slots === null || e.file !== OWNER_ANSWERS ? 'calib_answers entry needs set, slots and the answers file' : null;
    case 'protocol_approved':
      return null;
  }
}

/** One owner-log line; keys absent in older UI lines (version, from, set, slots) become null. */
export function parseOwnerLogEntry(value: unknown): Result<OwnerLogEntry> {
  const errors = validateOwnerFile('owner-log', value);
  if (errors.length > 0) return err(errors.join('; '));
  const at = readString(value, 'at');
  const action = readString(value, 'action');
  const sha = readString(value, 'sha256');
  if (at === null || action === null || !isOwnerAction(action) || sha === null) return err('malformed entry');
  const rawSlots = readArray(value, 'slots');
  const slots: number[] = [];
  for (const s of rawSlots ?? []) if (typeof s === 'number') slots.push(s);
  const entry: OwnerLogEntry = {
    at,
    action,
    round: readString(value, 'round'),
    file: readString(value, 'file'),
    sha256: sha,
    source: 'ui',
    version: readString(value, 'version'),
    from: readString(value, 'from'),
    set: readString(value, 'set'),
    slots: rawSlots === null ? null : slots,
  };
  const problem = actionProblem(entry);
  return problem === null ? ok(entry) : err(problem);
}

/** Missing file → ok([]). A torn last line (no trailing `\n`) is ignored; any other bad line → err (repair). */
export function readOwnerLog(root: string): Result<OwnerLogEntry[]> {
  const path = join(root, OWNER_LOG);
  if (!existsSync(path)) return ok([]);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return err(`${OWNER_LOG}: ${message(e)}`);
  }
  const lines = text.split('\n');
  // the segment after the last '\n' is '' for a complete file, else a torn tail the next UI append cuts
  lines.pop();
  const out: OwnerLogEntry[] = [];
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return err(`${OWNER_LOG} line ${i + 1}: not JSON`);
    }
    const entry = parseOwnerLogEntry(value);
    if (!entry.ok) return err(`${OWNER_LOG} line ${i + 1}: ${entry.error}`);
    out.push(entry.value);
  }
  return ok(out);
}

type Loaded = { state: 'missing' } | { state: 'invalid'; error: string } | { state: 'loaded'; value: unknown; sha256: string };

function loadJsonFile(root: string, rel: string): Loaded {
  const path = join(root, rel);
  if (!existsSync(path)) return { state: 'missing' };
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    return { state: 'invalid', error: `${rel}: ${message(e)}` };
  }
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    return { state: 'loaded', value, sha256: sha256Bytes(bytes) };
  } catch {
    return { state: 'invalid', error: `${rel}: not JSON` };
  }
}

function lastOf<T>(items: readonly T[], match: (item: T) => boolean): T | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && match(item)) return item;
  }
  return null;
}

function firstOf<T>(items: readonly T[], match: (item: T) => boolean): T | null {
  return items.find(match) ?? null;
}

type Logged = { state: 'logged'; at: string } | { state: 'repair'; detail: string } | { state: 'invalid'; error: string };

/** The latest matching entry must carry the file's SHA-256: none → repair (UI re-logs), other hash → invalid. */
function checkLogged(log: Result<OwnerLogEntry[]>, rel: string, sha: string, match: (e: OwnerLogEntry) => boolean): Logged {
  if (!log.ok) return { state: 'repair', detail: log.error };
  const entry = lastOf(log.value, match);
  if (entry === null) return { state: 'repair', detail: `${rel} has no owner-log entry` };
  if (entry.sha256 !== sha) return { state: 'invalid', error: `${rel}: SHA-256 differs from its latest owner-log entry` };
  return { state: 'logged', at: entry.at };
}

function schemaProblem(name: OwnerSchemaName, rel: string, value: unknown): string | null {
  const errors = validateOwnerFile(name, value);
  return errors.length === 0 ? null : `${rel}: ${errors.join('; ')}`;
}

function parseTopic(value: unknown): Topic | null {
  const round = readString(value, 'round');
  const rowId = readString(value, 'row_id');
  const layer = readString(value, 'layer');
  const source = readString(value, 'source');
  const chosenAt = readString(value, 'chosen_at');
  if (round === null || rowId === null || layer === null || chosenAt === null) return null;
  if (source !== 'ui' && source !== 'auto_default' && source !== 'fixed') return null;
  return { round, row_id: rowId, layer, cell: readString(value, 'cell'), source, chosen_at: chosenAt };
}

function readTopic(root: string, round: string, log: Result<OwnerLogEntry[]>): OwnerRead<Topic> {
  const rel = `rounds/${round}/topic.json`;
  const file = loadJsonFile(root, rel);
  if (file.state !== 'loaded') return file;
  const problem = schemaProblem('topic', rel, file.value);
  const topic = parseTopic(file.value);
  // engine-written topics (auto_default / fixed) carry no owner-log entry; the 01 marker pins them
  if (topic !== null && topic.source !== 'ui') {
    if (problem !== null) return { state: 'invalid', error: problem };
    return topic.round === round ? { state: 'ok', value: topic, sha256: file.sha256, at: topic.chosen_at } : { state: 'invalid', error: `${rel}: round mismatch` };
  }
  const logged = checkLogged(log, rel, file.sha256, (e) => e.action === 'topic' && e.round === round);
  if (logged.state !== 'logged') return logged;
  if (problem !== null || topic === null) return { state: 'invalid', error: problem ?? `${rel}: malformed` };
  if (topic.round !== round) return { state: 'invalid', error: `${rel}: round mismatch` };
  return { state: 'ok', value: topic, sha256: file.sha256, at: logged.at };
}

interface AuditSetPair {
  id: string;
  left: string;
  right: string;
}

/** The 09a marker's pin of audit-set.json: null without a marker (prototype rounds), err when it lists none. */
function pinnedAuditSet(root: string, round: string, setRel: string): Result<string | null> {
  const marker = loadJsonFile(root, `rounds/${round}/markers/09a-audit.json`);
  if (marker.state === 'missing') return ok(null);
  if (marker.state === 'invalid') return err(marker.error);
  const pin = readString(readRecord(marker.value, 'outputs'), setRel) ?? readString(readRecord(marker.value, 'inputs'), setRel);
  return pin === null ? err(`09a marker does not pin ${setRel}`) : ok(pin);
}

function parseAudit(value: unknown): AuditAnswers | null {
  const round = readString(value, 'round');
  const answeredAt = readString(value, 'answered_at');
  const raw = readArray(value, 'answers');
  if (round === null || answeredAt === null || raw === null) return null;
  const answers: AuditAnswer[] = [];
  for (const a of raw) {
    const pair = readString(a, 'pair');
    const left = readString(a, 'left');
    const right = readString(a, 'right');
    const choice = readString(a, 'choice');
    const chosen = readString(a, 'chosen');
    if (pair === null || left === null || right === null || chosen === null || (choice !== 'left' && choice !== 'right')) return null;
    answers.push({ pair, left, right, choice, chosen });
  }
  return { round, answers, answered_at: answeredAt };
}

function auditSetPairs(value: unknown): AuditSetPair[] | null {
  const raw = readArray(value, 'pairs');
  if (raw === null) return null;
  const out: AuditSetPair[] = [];
  for (const p of raw) {
    const id = readString(p, 'id');
    const left = readString(p, 'left');
    const right = readString(p, 'right');
    if (id === null || left === null || right === null) return null;
    out.push({ id, left, right });
  }
  return out;
}

/** Answer keys must equal the pinned audit set's pair ids; left / right / chosen must match the pair shown. */
function auditProblem(root: string, round: string, audit: AuditAnswers): string | null {
  const setRel = `rounds/${round}/audit-set.json`;
  const set = loadJsonFile(root, setRel);
  if (set.state === 'missing') return `${setRel} is missing`;
  if (set.state === 'invalid') return set.error;
  const pin = pinnedAuditSet(root, round, setRel);
  if (!pin.ok) return pin.error;
  if (pin.value !== null && pin.value !== set.sha256) return `${setRel} differs from the 09a marker`;
  const pairs = auditSetPairs(set.value);
  if (pairs === null) return `${setRel}: malformed`;
  const byId = new Map(pairs.map((p) => [p.id, p]));
  const seen = new Set<string>();
  for (const a of audit.answers) {
    const p = byId.get(a.pair);
    if (p === undefined) return `audit answer ${a.pair} is not in ${setRel}`;
    if (seen.has(a.pair)) return `audit answer ${a.pair} is duplicated`;
    seen.add(a.pair);
    if (a.left !== p.left || a.right !== p.right) return `audit answer ${a.pair} does not match the pair shown`;
    if (a.chosen !== (a.choice === 'left' ? a.left : a.right)) return `audit answer ${a.pair}: chosen does not match choice`;
  }
  const unanswered = pairs.filter((p) => !seen.has(p.id)).map((p) => p.id);
  return unanswered.length === 0 ? null : `audit answers missing for ${unanswered.join(', ')}`;
}

function readAudit(root: string, round: string, log: Result<OwnerLogEntry[]>): OwnerRead<AuditAnswers> {
  const rel = `rounds/${round}/audit.json`;
  const file = loadJsonFile(root, rel);
  if (file.state !== 'loaded') return file;
  const logged = checkLogged(log, rel, file.sha256, (e) => e.action === 'audit' && e.round === round);
  if (logged.state !== 'logged') return logged;
  const problem = schemaProblem('audit', rel, file.value);
  const audit = parseAudit(file.value);
  if (problem !== null || audit === null) return { state: 'invalid', error: problem ?? `${rel}: malformed` };
  if (audit.round !== round) return { state: 'invalid', error: `${rel}: round mismatch` };
  const mismatch = auditProblem(root, round, audit);
  if (mismatch !== null) return { state: 'invalid', error: mismatch };
  return { state: 'ok', value: audit, sha256: file.sha256, at: logged.at };
}

/** Narrows a decision file (schema-checked by the caller) to Decision; absent base / supersedes → null. */
export function parseDecision(value: unknown, file: string): Result<Decision> {
  const problem = schemaProblem('decision', file, value);
  if (problem !== null) return err(problem);
  const round = readString(value, 'round');
  const pick = readString(value, 'pick');
  const champion = readString(value, 'champion');
  const reason = readString(value, 'reason');
  const fav = readString(value, 'fav');
  const publish = readString(value, 'publish');
  const happened = readBoolean(value, 'happened');
  const decidedAt = readString(value, 'decided_at');
  const rawFacts = readArray(value, 'facts');
  if (round === null || pick === null || champion === null || reason === null || fav === null || happened === null || decidedAt === null || rawFacts === null) return err(`${file}: malformed`);
  if (publish !== 'yes' && publish !== 'no') return err(`${file}: malformed publish`);
  const facts: DecisionFact[] = [];
  for (const f of rawFacts) {
    const label = readString(f, 'label');
    const submission = readString(f, 'submission');
    const id = readString(f, 'id');
    const claim = readString(f, 'claim');
    if (label === null || submission === null || id === null || claim === null) return err(`${file}: malformed fact`);
    facts.push({ label, submission, id, claim });
  }
  return ok({
    round, pick, pick_submission: readString(value, 'pick_submission'), base: readString(value, 'base'), champion, facts, reason, fav, publish, happened,
    supersedes: readString(value, 'supersedes'), decided_at: decidedAt, file,
  });
}

/** `rounds/<round>/decision.json`, `decision-2.json`, … in chain order (forge-root-relative); err on a gap. */
export function decisionFiles(root: string, round: string): Result<string[]> {
  const dir = join(root, 'rounds', round);
  if (!existsSync(dir)) return ok([]);
  const numbered: Array<{ n: number; name: string }> = [];
  for (const name of readdirSync(dir)) {
    const m = DECISION_FILE.exec(name);
    if (m === null) continue;
    const n = m[1] === undefined ? 1 : Number(m[1]);
    if (n === 1 && m[1] !== undefined) return err(`rounds/${round}/${name}: the first decision is decision.json`);
    numbered.push({ n, name });
  }
  numbered.sort((a, b) => a.n - b.n);
  for (const [i, d] of numbered.entries()) if (d.n !== i + 1) return err(`rounds/${round}: decision chain has a gap before ${d.name}`);
  return ok(numbered.map((d) => `rounds/${round}/${d.name}`));
}

type GateFile = { kind: 'missing' } | { kind: 'malformed' } | { kind: 'status'; status: GateRecordStatus };

/** A present record must carry a GateRecordStatus; anything else is malformed, never "no rejection". */
function gateStatus(root: string, rel: string): GateFile {
  const file = loadJsonFile(root, rel);
  if (file.state === 'missing') return { kind: 'missing' };
  // A present record that does not parse is malformed, never "no rejection".
  if (file.state !== 'loaded') return { kind: 'malformed' };
  const status = readString(file.value, 'status');
  return status !== null && isGateStatus(status) ? { kind: 'status', status } : { kind: 'malformed' };
}

/** `merge/<d8>/` for a decision: the first 8 hex digits of its SHA-256 (plan §3.5; PR-D's merge step must use this). */
export function decisionDirName(decisionSha256: string): string {
  return decisionSha256.slice(0, 8);
}

export type GateRejection = { kind: 'none' } | { kind: 'rejected'; path: string } | { kind: 'malformed'; path: string };

/**
 * The gate record that sends the decision with this SHA-256 back to 9b (PROTOCOL §6, §7): re-gate
 * `merge/<d8>/regate.json` fail / split / trial, or post-merge `postmerge-gate.json` fail (a post-merge split
 * continues; `unverified` fails the step instead). A record without a valid status is `malformed` (exit 3 upstream).
 */
export function gateRejection(root: string, round: string, decisionSha256: string): GateRejection {
  const dir = `rounds/${round}/merge/${decisionDirName(decisionSha256)}`;
  const regate = gateStatus(root, `${dir}/regate.json`);
  if (regate.kind === 'malformed') return { kind: 'malformed', path: `${dir}/regate.json` };
  if (regate.kind === 'status' && (regate.status === 'fail' || regate.status === 'split' || regate.status === 'trial')) return { kind: 'rejected', path: `${dir}/regate.json` };
  const post = gateStatus(root, `${dir}/postmerge-gate.json`);
  if (post.kind === 'malformed') return { kind: 'malformed', path: `${dir}/postmerge-gate.json` };
  if (post.kind === 'status' && post.status === 'fail') return { kind: 'rejected', path: `${dir}/postmerge-gate.json` };
  return { kind: 'none' };
}

/** True when a 09b marker under `markers/stale/<n>/` pins the decision with this SHA-256 (the round went back to 9b). */
export function staleDecisionPin(root: string, round: string, decisionSha256: string): boolean {
  const stale = join(root, 'rounds', round, 'markers', 'stale');
  if (!existsSync(stale)) return false;
  for (const n of readdirSync(stale)) {
    const marker = loadJsonFile(root, `rounds/${round}/markers/stale/${n}/09b-decision.json`);
    if (marker.state !== 'loaded') continue;
    const inputs = readRecord(marker.value, 'inputs');
    if (inputs !== null && Object.values(inputs).some((v) => v === decisionSha256)) return true;
  }
  return false;
}

function readDecision(root: string, round: string, log: Result<OwnerLogEntry[]>): OwnerRead<Decision> {
  const files = decisionFiles(root, round);
  if (!files.ok) return { state: 'invalid', error: files.error };
  let prev: { rel: string; sha256: string } | null = null;
  let current: { value: Decision; sha256: string; at: string } | null = null;
  for (const rel of files.value) {
    const file = loadJsonFile(root, rel);
    if (file.state === 'missing') return { state: 'invalid', error: `${rel} vanished while reading` };
    if (file.state === 'invalid') return file;
    const logged = checkLogged(log, rel, file.sha256, (e) => e.action === 'decision' && e.round === round && e.file === rel);
    if (logged.state !== 'logged') return logged;
    const decision = parseDecision(file.value, rel);
    if (!decision.ok) return { state: 'invalid', error: decision.error };
    if (decision.value.round !== round) return { state: 'invalid', error: `${rel}: round mismatch` };
    if (prev === null) {
      if (decision.value.supersedes !== null) return { state: 'invalid', error: `${rel}: the first decision supersedes nothing` };
    } else {
      if (decision.value.supersedes !== prev.sha256) return { state: 'invalid', error: `${rel}: supersedes is not the SHA-256 of ${prev.rel}` };
      const prevGate = gateRejection(root, round, prev.sha256);
      if (prevGate.kind === 'malformed') return { state: 'invalid', error: `${prevGate.path}: status is not a gate record status` };
      if (prevGate.kind === 'none') return { state: 'invalid', error: `${rel}: ${prev.rel} has no non-pass gate record` };
      if (!staleDecisionPin(root, round, prev.sha256)) return { state: 'invalid', error: `${rel}: no stale 09b marker pins ${prev.rel}` };
    }
    prev = { rel, sha256: file.sha256 };
    current = { value: decision.value, sha256: file.sha256, at: logged.at };
  }
  if (current === null) return { state: 'missing' };
  const gate = gateRejection(root, round, current.sha256);
  if (gate.kind === 'malformed') return { state: 'invalid', error: `${gate.path}: status is not a gate record status` };
  if (gate.kind === 'rejected') return { state: 'superseded', sha256: current.sha256 };
  return { state: 'ok', value: current.value, sha256: current.sha256, at: current.at };
}

function parseCalibAnswers(value: unknown): Result<CalibAnswers> {
  const rawSets = readRecord(value, 'sets');
  if (rawSets === null) return err(`${OWNER_ANSWERS}: sets must be an object`);
  const sets: CalibAnswers['sets'] = {};
  for (const [set, rawSet] of Object.entries(rawSets)) {
    const pairsSha = readString(rawSet, 'pairs_sha256');
    const rawAnswers = readArray(rawSet, 'answers');
    if (!/^[A-Z]\d{2}$/u.test(set) || pairsSha === null || !HEX64.test(pairsSha) || rawAnswers === null) return err(`${OWNER_ANSWERS}: malformed set ${set}`);
    const answers: CalibAnswer[] = [];
    for (const a of rawAnswers) {
      const slot = readNumber(a, 'slot');
      const pair = readString(a, 'pair');
      const left = readString(a, 'left');
      const right = readString(a, 'right');
      const choice = readString(a, 'choice');
      const chosen = readString(a, 'chosen');
      const answeredAt = readString(a, 'answered_at');
      const ms = isRecord(a) ? a['ms'] : undefined;
      if (slot === null || !Number.isInteger(slot) || pair === null || left === null || right === null || chosen === null || answeredAt === null) return err(`${OWNER_ANSWERS}: malformed answer in ${set}`);
      if (choice !== 'left' && choice !== 'right') return err(`${OWNER_ANSWERS}: malformed choice in ${set}`);
      if (ms !== null && (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0)) return err(`${OWNER_ANSWERS}: malformed ms in ${set}`);
      answers.push({ slot, pair, left, right, choice, chosen, answered_at: answeredAt, ms });
    }
    sets[set] = { pairs_sha256: pairsSha, answers };
  }
  return ok({ sets });
}

interface DisplayItem {
  pair: string;
  left: string;
  right: string;
}

/** `calibration/pairs.json` set: SHA-256 of its canonical JSON and its display slots. */
export function calibSet(root: string, set: string): Result<{ pairsSha256: string; display: Map<number, DisplayItem>; value: JsonRecord }> {
  const file = loadJsonFile(root, 'calibration/pairs.json');
  if (file.state === 'missing') return err('calibration/pairs.json is missing');
  if (file.state === 'invalid') return err(file.error);
  const value = readRecord(readRecord(file.value, 'sets'), set);
  if (value === null) return err(`calibration/pairs.json has no set ${set}`);
  let pairsSha256: string;
  try {
    pairsSha256 = sha256Bytes(Buffer.from(canonicalJson(value), 'utf8'));
  } catch (e) {
    return err(`calibration/pairs.json set ${set}: ${message(e)}`);
  }
  const display = new Map<number, DisplayItem>();
  for (const d of readArray(value, 'display') ?? []) {
    const slot = readNumber(d, 'slot');
    const pair = readString(d, 'pair');
    const left = readString(d, 'left');
    const right = readString(d, 'right');
    if (slot === null || pair === null || left === null || right === null) return err(`calibration/pairs.json set ${set}: malformed display item`);
    display.set(slot, { pair, left, right });
  }
  return ok({ pairsSha256, display, value });
}

/** s4 checks (b)–(d) for one set; (a) is the file-level hash check. */
function calibSetProblem(root: string, set: string, answers: CalibAnswers['sets'][string], entries: readonly OwnerLogEntry[]): string | null {
  const pairs = calibSet(root, set);
  if (!pairs.ok) return pairs.error;
  if (answers.pairs_sha256 !== pairs.value.pairsSha256) return `${OWNER_ANSWERS}: ${set} was answered on other pairs (pairs_sha256)`;
  const seen = new Set<number>();
  for (const a of answers.answers) {
    const d = pairs.value.display.get(a.slot);
    if (d === undefined) return `${OWNER_ANSWERS}: ${set} slot ${a.slot} is not displayed`;
    if (seen.has(a.slot)) return `${OWNER_ANSWERS}: ${set} slot ${a.slot} answered twice`;
    seen.add(a.slot);
    if (a.pair !== d.pair || a.left !== d.left || a.right !== d.right) return `${OWNER_ANSWERS}: ${set} slot ${a.slot} does not match the display`;
    if (a.chosen !== (a.choice === 'left' ? a.left : a.right)) return `${OWNER_ANSWERS}: ${set} slot ${a.slot}: chosen does not match choice`;
    const covering = entries.filter((e) => e.set === set && e.slots !== null && e.slots.includes(a.slot));
    const entry = covering[0];
    if (covering.length !== 1 || entry === undefined) return `${OWNER_ANSWERS}: ${set} slot ${a.slot} is logged ${covering.length} times`;
    const at = Date.parse(entry.at);
    const answered = Date.parse(a.answered_at);
    if (Number.isNaN(at) || Number.isNaN(answered) || at < answered) return `${OWNER_ANSWERS}: ${set} slot ${a.slot} was logged before it was answered`;
  }
  for (const e of entries) {
    for (const slot of e.set === set ? (e.slots ?? []) : []) if (!seen.has(slot)) return `${OWNER_ANSWERS}: ${set} slot ${slot} is logged but not in the file`;
  }
  return null;
}

function readCalibAnswers(root: string, log: Result<OwnerLogEntry[]>): OwnerRead<CalibAnswers> {
  const file = loadJsonFile(root, OWNER_ANSWERS);
  if (file.state !== 'loaded') return file;
  if (!log.ok) return { state: 'repair', detail: log.error };
  const entries = log.value.filter((e) => e.action === 'calib_answers');
  const parsed = parseCalibAnswers(file.value);
  const last = entries.at(-1);
  if (last === undefined) return { state: 'repair', detail: `${OWNER_ANSWERS} has no owner-log entry` };
  if (last.sha256 !== file.sha256) {
    // the UI writes the file before its log line: answers no entry covers mean a crash in between (UI re-logs)
    const uncovered = parsed.ok && Object.entries(parsed.value.sets).some(([set, s]) =>
      s.answers.some((a) => !entries.some((e) => e.set === set && e.slots !== null && e.slots.includes(a.slot))));
    if (uncovered) return { state: 'repair', detail: `${OWNER_ANSWERS} has answers without an owner-log entry` };
    return { state: 'invalid', error: `${OWNER_ANSWERS}: SHA-256 differs from its latest owner-log entry` };
  }
  if (!parsed.ok) return { state: 'invalid', error: parsed.error };
  for (const [set, answers] of Object.entries(parsed.value.sets)) {
    const problem = calibSetProblem(root, set, answers, entries);
    if (problem !== null) return { state: 'invalid', error: problem };
  }
  return { state: 'ok', value: parsed.value, sha256: file.sha256, at: last.at };
}

/**
 * The only reader of owner files. Every call re-reads the files, so answers the UI logs while the engine waits are
 * seen by the next call. A broken owner log (bad non-last line) turns every file read into `repair` and makes
 * entries() empty.
 */
export function ownerInputs(root: string): OwnerInputs {
  const log = (): Result<OwnerLogEntry[]> => readOwnerLog(root);
  const entries = (): OwnerLogEntry[] => {
    const r = log();
    return r.ok ? r.value : [];
  };
  return {
    entries,
    protocolApproval(bundleSha256) {
      const last = lastOf(entries(), (e) => e.action === 'protocol_approved');
      return last !== null && last.sha256 === bundleSha256 ? last : null;
    },
    topic: (round) => readTopic(root, round, log()),
    audit: (round) => readAudit(root, round, log()),
    decision: (round) => readDecision(root, round, log()),
    diffApproved(round, diffSha256) {
      return lastOf(entries(), (e) => e.action === 'diff_approved' && e.round === round && e.sha256 === diffSha256)?.at ?? null;
    },
    calibAnswers: () => readCalibAnswers(root, log()),
    /** `at` of the first matching view (s3 §2.2 uses the first view). */
    benchDiffViewed(version, sha256) {
      return firstOf(entries(), (e) => e.action === 'bench_diff_viewed' && e.version === version && e.sha256 === sha256)?.at ?? null;
    },
    /** `at` of the first matching approval. */
    benchApproved(version, sha256) {
      return firstOf(entries(), (e) => e.action === 'bench_approved' && e.version === version && e.sha256 === sha256)?.at ?? null;
    },
    rollbacks() {
      const out: Array<{ at: string; version: string; from: string; sha256: string; round: string | null }> = [];
      for (const e of entries()) {
        if (e.action === 'rollback' && e.version !== null && e.from !== null) out.push({ at: e.at, version: e.version, from: e.from, sha256: e.sha256, round: e.round });
      }
      return out;
    },
  };
}

/**
 * WAIT protocol_approval (`协议包 <sha12> 尚未在基准页批准`) unless the latest approval equals ctx.bundleSha256;
 * WAIT owner_log_repair when the owner log has a bad non-last line.
 */
export function protocolGate(ctx: StepContext): StepOutcome | null {
  return protocolGateAt(ctx.root, ctx.owner, ctx.bundleSha256);
}

/** protocolGate over its three inputs (unit-testable without a StepContext). */
export function protocolGateAt(root: string, owner: OwnerInputs, bundleSha256: string): StepOutcome | null {
  const log = readOwnerLog(root);
  if (!log.ok) return { kind: 'wait', waitingFor: 'owner_log_repair', detail: log.error, inputs: [], outputs: [] };
  if (owner.protocolApproval(bundleSha256) !== null) return null;
  return { kind: 'wait', waitingFor: 'protocol_approval', detail: `协议包 ${bundleSha256.slice(0, 12)} 尚未在基准页批准`, inputs: [], outputs: [] };
}
