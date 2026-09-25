import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibPaths, readCalibPairs, type CalibSetRecord, type SetId } from './calib-build.ts';
import { readVerdicts, type VerdictRecord } from './calib-run.ts';
import { readCalibReports, type CalibReport } from './calib-score.ts';
import { agreementState, posterior, round4 } from './calib-stats.ts';
import { isFamily, type Family, type JudgeSpec } from './config.ts';
import type { StepContext } from './context.ts';
import { isRecord, readArray, readBoolean, readNumber, readRecord, readString } from './json.ts';
import type { AuditAnswers, CalibAnswer, OwnerRead } from './owner-inputs.ts';
import { ANCHOR_IDS, pairsFilePath, pairVerdicts, readPairsFile, sessionVoid, type FamilySessions } from './pairs.ts';
import type { ProtocolCalibration } from './protocol.ts';
import { err, ok, type Result } from './result.ts';
import { loadSchema, validate, type Schema } from './schema.ts';
import { roundPaths, sha256 } from './store.ts';
import { CHAMPION_ID } from './submission.ts';
import { parseAuditSet, type AuditSetFile } from './steps/owner-waits.ts';
import { isOneOf } from './tasks/fenced.ts';
import { parseTrustStatus, readTrustStatus, TRUST_STATUS, type FamilyAgreement, type FamilyTrust, type TrustStatus } from './trust-status.ts';

/**
 * Blind-label ledger `calibration/labels.json` and trust status `calibration/status.json` (s4 §4.5). Both are
 * rebuilt deterministically from pairs.json, owner answers, verdicts, reports and every round's audit files, so
 * c5-score and step 11e (updateTrust) share one builder and a rerun writes byte-identical files. The freeze pins
 * reader is trust-status.ts (PR-A); this module is the only writer of status.json.
 */

export type Split = 'visible' | 'reserve' | 'none';

export type LabelSource = 'round0' | 'audit' | 'requal';

/** A judged text of a label (forge-root-relative path to the text or submission file). */
export interface LabelText {
  id: string;
  path: string;
  sha256: string;
  /** Author families (a champion may have several). */
  authors: Family[];
}

/** One family's outcome on one label (D4: void sessions count and make agree false). */
export interface Trial {
  sessions: number;
  consistent: boolean;
  agree: boolean;
  void: number;
}

/** One `labels.json` entry (file shape, snake_case). */
export interface Label {
  /** `C00-P03` | `R01-audit-2` | `Q01-P05`. */
  id: string;
  source: LabelSource;
  /** Set or round id. */
  round: string;
  /** C / Q: pair index; audit: audit-set position. */
  seq: number;
  texts: LabelText[];
  /** Text id the owner chose (first answer; audit: display id resolved to the text id). */
  owner_chosen: string;
  answered_at: string;
  /** C00: pairs.json split; audit: audit-set.json split; Q: none (D3). */
  split: Split;
  use: 'qualification' | 'agreement' | 'requal';
  trials: Partial<Record<Family, Trial>>;
}

/** `calibration/labels.json` (schema/calib-labels.schema.json). */
export interface LabelLedger {
  schema: 'calib-labels/1';
  labels: Label[];
}

/** One scored calibration set as the ledger reads it. */
export interface CalibLabelSource {
  set: SetId;
  record: CalibSetRecord;
  answers: CalibAnswer[];
  verdicts: VerdictRecord[];
}

/** One round whose audit.json exists (rounds without it contribute nothing yet). */
export interface RoundLabelSource {
  round: string;
  auditSet: AuditSetFile;
  audit: AuditAnswers;
  /** Display id (labels.json label, BASE, AN1, AN2) → text id as pairs.ts decisive names it. */
  textOf: Record<string, string>;
  /** Keyed by text id (the textOf values): pairs.json / taste/aux/pairs.json TextRefs. */
  texts: Record<string, LabelText>;
  /** audit-set pair `pair` (judged pair id) → pairs.ts pairVerdicts. */
  sessions: Record<string, FamilySessions[]>;
}

export interface TrustSources {
  calib: CalibLabelSource[];
  rounds: RoundLabelSource[];
}

export const LABELS_FILE = 'calibration/labels.json';

/**
 * A recoverable owner-file state (the UI crashed between writing answers and logging them, or the owner log needs a
 * repair): the caller returns runner WAIT owner_log_repair instead of an IntegrityError.
 */
export interface TrustWait {
  kind: 'wait';
  waitingFor: 'owner_log_repair';
  detail: string;
}

/** rebuildTrust's value: the written status, or a wait before anything was written. */
export type TrustRebuild = { kind: 'status'; status: TrustStatus } | TrustWait;

/** A source read that may have to wait for an owner-log repair. */
type Sourced<T> = { kind: 'sources'; value: T } | TrustWait;

/** Audit trial from pairs.ts FamilySessions (shadow sessions count); null when the family has no session. */
export function trialOf(fs: FamilySessions, ownerChosen: string): Trial | null {
  if (fs.sessions.length === 0) return null;
  let voids = 0;
  let consistent = true;
  let agree = true;
  for (const [fwd, rev] of fs.sessions) {
    if (sessionVoid(fwd, rev)) {
      voids += 1;
      consistent = false;
      agree = false;
    } else if (fwd.decisive !== rev.decisive) {
      consistent = false;
      agree = false;
    } else if (fwd.decisive !== ownerChosen) {
      agree = false;
    }
  }
  return { sessions: fs.sessions.length, consistent, agree, void: voids };
}

/** C / Q trial from the ab / ba verdicts (one session-pair); null when the family judged neither order. */
export function calibTrial(ab: VerdictRecord | null, ba: VerdictRecord | null, ownerChosen: string): Trial | null {
  if (ab === null && ba === null) return null;
  const first = ab?.status === 'ok' ? ab.decisive : null;
  const second = ba?.status === 'ok' ? ba.decisive : null;
  if (first === null || second === null) return { sessions: 1, consistent: false, agree: false, void: 1 };
  const consistent = first === second;
  return { sessions: 1, consistent, agree: consistent && first === ownerChosen, void: 0 };
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Families with a trial, code-unit sorted (the key order labels.json is written in). */
function sortedTrials(entries: ReadonlyArray<[Family, Trial | null]>): Partial<Record<Family, Trial>> {
  const out: Partial<Record<Family, Trial>> = {};
  for (const [family, trial] of [...entries].sort((x, y) => byCodeUnit(x[0], y[0]))) if (trial !== null) out[family] = trial;
  return out;
}

/** C / Q labels of one scored set; the owner label is the first answer (retest slots are reported, never labels: D6). */
function calibLabels(src: CalibLabelSource): Result<Label[]> {
  const { set, record } = src;
  if (record.kind === 'gate') return ok([]);
  const source: LabelSource = record.kind === 'round0' ? 'round0' : 'requal';
  const retest = new Set(record.display.filter((d) => d.retest_of !== null).map((d) => d.slot));
  const out: Label[] = [];
  for (const [i, pair] of record.pairs.entries()) {
    const first = src.answers.filter((a) => a.pair === pair.id && !retest.has(a.slot)).sort((x, y) => x.slot - y.slot)[0];
    if (first === undefined) return err(`${set}: pair ${pair.id} has no owner answer`);
    if (first.chosen !== pair.a && first.chosen !== pair.b) return err(`${set}: the answer to ${pair.id} names neither text`);
    const texts: LabelText[] = [];
    for (const id of [pair.a, pair.b]) {
      const t = record.texts[id];
      if (t === undefined) return err(`${set}: pair ${pair.id} names unknown text ${id}`);
      texts.push({ id, path: `calibration/${t.path}`, sha256: t.sha256, authors: [t.author_family] });
    }
    const split: Split = source === 'requal' ? 'none' : pair.split;
    if (split === 'none' && source === 'round0') return err(`${set}: round-0 pair ${pair.id} has no visible / reserve split`);
    const own = src.verdicts.filter((v) => v.pair === pair.id);
    const trials: Array<[Family, Trial | null]> = [];
    for (const family of [...new Set(own.map((v) => v.family))]) {
      const ab = own.filter((v) => v.family === family && v.order === 'ab');
      const ba = own.filter((v) => v.family === family && v.order === 'ba');
      if (ab.length > 1 || ba.length > 1) return err(`${set}: ${family} has two verdicts in one order on ${pair.id}`);
      trials.push([family, calibTrial(ab[0] ?? null, ba[0] ?? null, first.chosen)]);
    }
    out.push({
      id: pair.id, source, round: set, seq: i + 1, texts, owner_chosen: first.chosen, answered_at: first.answered_at, split,
      use: source === 'round0' ? 'qualification' : 'requal', trials: sortedTrials(trials),
    });
  }
  return ok(out);
}

/** Audit labels of one round whose audit.json exists; display ids resolve through textOf to the ids pairs.ts decisive uses. */
function auditLabels(src: RoundLabelSource): Result<Label[]> {
  const { round } = src;
  if (src.audit.round !== round || src.auditSet.round !== round) return err(`${round}: audit.json / audit-set.json name another round`);
  const out: Label[] = [];
  for (const [i, p] of src.auditSet.pairs.entries()) {
    const answer = src.audit.answers.find((a) => a.pair === p.id);
    if (answer === undefined) return err(`${round}: audit pair ${p.id} has no owner answer`);
    const chosen = src.textOf[answer.chosen];
    if (chosen === undefined) return err(`${round}: display id ${answer.chosen} of ${p.id} names no judged text`);
    const texts: LabelText[] = [];
    for (const shown of [p.left, p.right]) {
      const id = src.textOf[shown];
      const t = id === undefined ? undefined : src.texts[id];
      if (t === undefined) return err(`${round}: display id ${shown} of ${p.id} names no judged text`);
      texts.push(t);
    }
    const trials = (src.sessions[p.pair] ?? []).map((fs): [Family, Trial | null] => [fs.family, trialOf(fs, chosen)]);
    if (new Set(trials.map(([f]) => f)).size !== trials.length) return err(`${round}: a family occurs twice in the sessions of ${p.pair}`);
    out.push({
      id: p.label, source: 'audit', round, seq: i + 1, texts, owner_chosen: chosen, answered_at: src.audit.answered_at, split: p.split,
      use: 'agreement', trials: sortedTrials(trials),
    });
  }
  return ok(out);
}

/** C sets before Q sets, each by id (set ids are zero-padded, so code-unit order is numeric order). */
function setRank(set: string): number {
  return set.startsWith('C') ? 0 : 1;
}

/**
 * C00 labels (seq = pair index), Q labels (split none), then audit labels by round number (seq = audit-set position).
 * `informed_pick` (the decision page) is never an input. `cal` is not needed yet: every number the ledger carries
 * (split, sessions) was fixed by the step that wrote its source file.
 */
export function buildLedger(src: TrustSources, cal: ProtocolCalibration): Result<LabelLedger> {
  const labels: Label[] = [];
  const calib = [...src.calib].sort((x, y) => setRank(x.set) - setRank(y.set) || byCodeUnit(x.set, y.set));
  for (const s of calib) {
    const r = calibLabels(s);
    if (!r.ok) return r;
    labels.push(...r.value);
  }
  for (const s of [...src.rounds].sort((x, y) => byCodeUnit(x.round, y.round))) {
    const r = auditLabels(s);
    if (!r.ok) return r;
    labels.push(...r.value);
  }
  const ids = new Set<string>();
  for (const l of labels) {
    if (ids.has(l.id)) return err(`label ${l.id} occurs twice`);
    ids.add(l.id);
  }
  return ok({ schema: 'calib-labels/1', labels });
}

/** 2-space JSON + LF, the bytes RoundFiles.writeJson would write; labels_sha256 hashes exactly these. */
function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Number of an R round id, else null. */
function roundNumber(id: string): number | null {
  const m = /^R(\d{2})$/u.exec(id)?.[1];
  return m === undefined ? null : Number(m);
}

/**
 * Audit round a suspension dates from: an R id as is; a set id (a status written before suspensions were dated by
 * audit round) through its report's after_round; -1 when neither names a round.
 */
function suspensionRound(since: string, reports: readonly CalibReport[]): number {
  const own = roundNumber(since);
  if (own !== null) return own;
  const after = reports.find((r) => r.set === since)?.after_round ?? null;
  return (after === null ? null : roundNumber(after)) ?? -1;
}

/** An audit label counts for a posterior whose epoch is a set (C00, or a requal scored before any audit) or an earlier R round. */
function afterEpoch(label: Label, epoch: string): boolean {
  const e = roundNumber(epoch);
  const r = roundNumber(label.round);
  return e === null || (r !== null && r > e);
}

/** The family's posterior after its epoch and the newest R round among the audit labels it counted (null: none). */
function agreementOf(ledger: LabelLedger, family: Family, qualified: boolean, epoch: string, cal: ProtocolCalibration): { agreement: FamilyAgreement; newest: string | null } {
  let n = 0;
  let k = 0;
  let newest: string | null = null;
  for (const l of ledger.labels) {
    const trial = l.trials[family];
    if (!qualified || l.source !== 'audit' || trial === undefined || !afterEpoch(l, epoch)) continue;
    n += 1;
    if (trial.agree) k += 1;
    if (newest === null || (roundNumber(l.round) ?? -1) > (roundNumber(newest) ?? -1)) newest = l.round;
  }
  const p = posterior(k, n, cal.agreement.threshold);
  const agreement: FamilyAgreement = {
    epoch, n, k, alpha: p.alpha, beta: p.beta, mean: round4(p.mean), ci90: [round4(p.ci90.lo), round4(p.ci90.hi)], p_below: round4(p.pBelow),
    state: agreementState(p, cal.agreement),
  };
  return { agreement, newest };
}

const bySet = (x: CalibReport, y: CalibReport): number => byCodeUnit(x.set, y.set);

/**
 * Per judge family (judges.json order): qualified by the valid C00 report or a later passed requal (which also
 * resets the posterior epoch to its after_round); requal_used by any valid Q report of that reason (an invalid one
 * qualifies nobody and leaves the re-test unused); gate_judge from the newest valid dry-run (C00, then G sets).
 * Posterior Beta(1,1) over audit labels after the epoch. A newly suspended family gets suspended_at = the newest R
 * round it was judged on (never a set id: c5 of a G or Q set rebuilds too); the suspension stays until a passed
 * requal whose after_round is at least that round (a suspension requal is built after the suspension, so its
 * after_round is never earlier).
 */
export function computeStatus(ledger: LabelLedger, reports: readonly CalibReport[], prev: TrustStatus | null, judges: readonly JudgeSpec[], cal: ProtocolCalibration, after: string): TrustStatus {
  const valid = reports.filter((r) => r.valid);
  const round0 = valid.find((r) => r.kind === 'round0');
  const dryruns = [...(round0 === undefined ? [] : [round0]), ...valid.filter((r) => r.kind === 'gate').sort(bySet)];
  const requals = reports.filter((r) => r.kind === 'requal').sort(bySet);
  const families: Record<string, FamilyTrust> = {};
  for (const family of [...new Set(judges.map((j) => j.family))]) {
    let qualifiedBy = round0 !== undefined && round0.qualified.includes(family) ? round0.set : null;
    let epoch = round0?.set ?? 'C00';
    const used = { calibration_fail: false, suspension: false };
    const passed: CalibReport[] = [];
    for (const r of requals.filter((q) => q.family === family)) {
      if (!r.valid) continue;
      if (r.reason !== null) used[r.reason] = true;
      if (!r.qualified.includes(family)) continue;
      qualifiedBy = r.set;
      epoch = r.after_round ?? r.set;
      passed.push(r);
    }
    let gateBy: string | null = null;
    for (const r of dryruns) {
      const d = r.gate_dryrun[family];
      if (d !== undefined) gateBy = d.gate_judge ? r.set : null;
    }
    const { agreement, newest } = agreementOf(ledger, family, qualifiedBy !== null, epoch, cal);
    const was = prev?.families[family];
    let suspendedAt: string | null = null;
    if (was?.agreement.state === 'suspended') {
      const since = was.suspended_at ?? after;
      const at = suspensionRound(since, reports);
      if (!passed.some((r) => r.after_round !== null && (roundNumber(r.after_round) ?? -1) >= at)) suspendedAt = since;
    }
    if (suspendedAt === null && agreement.state === 'suspended') suspendedAt = newest ?? after;
    families[family] = {
      qualified: qualifiedBy !== null, qualified_by: qualifiedBy, requal_used: used, gate_judge: gateBy !== null, gate_by: gateBy,
      agreement: { ...agreement, state: suspendedAt === null ? agreement.state : 'suspended' }, suspended_at: suspendedAt,
    };
  }
  return { schema: 'trust-status/1', updated_after: after, labels_sha256: sha256(jsonText(ledger)), families };
}

let cachedSchema: Schema | null = null;

/** The engine's copy of schema/calib-labels.schema.json (module-relative, so temp forge roots need no schema dir). */
function labelsSchema(): Schema {
  if (cachedSchema !== null) return cachedSchema;
  const raw: unknown = JSON.parse(readFileSync(fileURLToPath(new URL('../schema/calib-labels.schema.json', import.meta.url)), 'utf8'));
  const schema = loadSchema(raw);
  if (!schema.ok) throw new Error(`schema/calib-labels.schema.json: ${schema.error}`);
  cachedSchema = schema.value;
  return schema.value;
}

const SOURCES: readonly LabelSource[] = ['round0', 'audit', 'requal'];
const SPLITS: readonly Split[] = ['visible', 'reserve', 'none'];
const USES: readonly Label['use'][] = ['qualification', 'agreement', 'requal'];
/** Per source: the only `use` and the allowed splits (D3: requal labels never feed evidence or replay). */
const SOURCE_RULES: Readonly<Record<LabelSource, { use: Label['use']; splits: readonly Split[] }>> = {
  round0: { use: 'qualification', splits: ['visible', 'reserve'] },
  audit: { use: 'agreement', splits: ['visible', 'reserve'] },
  requal: { use: 'requal', splits: ['none'] },
};

function narrowText(value: unknown): LabelText | null {
  const id = readString(value, 'id');
  const path = readString(value, 'path');
  const sha = readString(value, 'sha256');
  const authors: Family[] = [];
  for (const a of readArray(value, 'authors') ?? []) if (typeof a === 'string' && isFamily(a)) authors.push(a);
  return id === null || path === null || sha === null ? null : { id, path, sha256: sha, authors };
}

function narrowTrial(value: unknown): Result<Trial> {
  const sessions = readNumber(value, 'sessions');
  const consistent = readBoolean(value, 'consistent');
  const agree = readBoolean(value, 'agree');
  const voids = readNumber(value, 'void');
  if (sessions === null || consistent === null || agree === null || voids === null) return err('malformed trial');
  if (voids > sessions) return err('void exceeds sessions');
  if (agree && !consistent) return err('agree without consistent');
  return ok({ sessions, consistent, agree, void: voids });
}

function narrowLabel(value: unknown): Result<Label> {
  const id = readString(value, 'id');
  const source = readString(value, 'source');
  const round = readString(value, 'round');
  const seq = readNumber(value, 'seq');
  const chosen = readString(value, 'owner_chosen');
  const answeredAt = readString(value, 'answered_at');
  const split = readString(value, 'split');
  const use = readString(value, 'use');
  if (id === null || round === null || seq === null || chosen === null || answeredAt === null) return err('malformed label');
  if (source === null || !isOneOf(source, SOURCES) || split === null || !isOneOf(split, SPLITS) || use === null || !isOneOf(use, USES)) return err(`${id}: unknown source, split or use`);
  const rule = SOURCE_RULES[source];
  if (use !== rule.use || !rule.splits.includes(split)) return err(`${id}: a ${source} label has use ${rule.use} and split ${rule.splits.join(' | ')}`);
  const texts: LabelText[] = [];
  for (const t of readArray(value, 'texts') ?? []) {
    const text = narrowText(t);
    if (text === null) return err(`${id}: malformed text`);
    texts.push(text);
  }
  if (!texts.some((t) => t.id === chosen)) return err(`${id}: owner_chosen names neither text`);
  const trials: Partial<Record<Family, Trial>> = {};
  for (const [family, raw] of Object.entries(readRecord(value, 'trials') ?? {})) {
    const trial = narrowTrial(raw);
    if (!isFamily(family)) return err(`${id}: unknown family ${family}`);
    if (!trial.ok) return err(`${id}.trials.${family}: ${trial.error}`);
    trials[family] = trial.value;
  }
  return ok({ id, source, round, seq, texts, owner_chosen: chosen, answered_at: answeredAt, split, use, trials });
}

/** Shape plus schema/calib-labels.schema.json. */
export function parseLabelLedger(value: unknown): Result<LabelLedger> {
  const errors = validate(labelsSchema(), value);
  if (errors.length > 0) return err(errors.join('; '));
  const labels: Label[] = [];
  const ids = new Set<string>();
  for (const raw of readArray(value, 'labels') ?? []) {
    const label = narrowLabel(raw);
    if (!label.ok) return label;
    if (ids.has(label.value.id)) return err(`label ${label.value.id} occurs twice`);
    ids.add(label.value.id);
    labels.push(label.value);
  }
  return ok({ schema: 'calib-labels/1', labels });
}

/** null when calibration/labels.json is absent. */
export function readLabelLedger(root: string): Result<LabelLedger> | null {
  const path = join(root, LABELS_FILE);
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return err(`${LABELS_FILE}: ${e instanceof Error ? e.message.split(path).join(LABELS_FILE) : String(e)}`);
  }
  const parsed = parseLabelLedger(value);
  return parsed.ok ? parsed : err(`${LABELS_FILE}: ${parsed.error}`);
}

function ownerProblem(read: OwnerRead<unknown>): string {
  switch (read.state) {
    case 'missing':
      return 'missing';
    case 'superseded':
      return 'superseded';
    case 'repair':
      return `needs an owner-log repair (${read.detail})`;
    case 'invalid':
      return read.error;
    case 'ok':
      return 'ok';
  }
}

function readJsonAt(root: string, rel: string): Result<unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(join(root, rel), 'utf8'));
    return ok(value);
  } catch {
    return err(`${rel} is missing or not JSON`);
  }
}

/**
 * Every set with a valid round-0 / requal report: its pairs.json record, the owner's answers and its verdict files.
 * owner-answers.json in `repair` (answers of any set without their log line) is a wait; any other non-ok read is an error.
 */
function calibSources(ctx: StepContext, reports: readonly CalibReport[]): Result<Sourced<CalibLabelSource[]>> {
  const scored = reports.filter((r) => r.valid && r.kind !== 'gate').map((r) => r.set);
  if (scored.length === 0) return ok({ kind: 'sources', value: [] });
  const pairs = readCalibPairs(ctx.root);
  if (!pairs.ok) return pairs;
  const answers = ctx.owner.calibAnswers();
  if (answers.state === 'repair') return ok({ kind: 'wait', waitingFor: 'owner_log_repair', detail: answers.detail });
  if (answers.state !== 'ok') return err(`calibration/owner-answers.json: ${ownerProblem(answers)}`);
  const out: CalibLabelSource[] = [];
  for (const set of scored) {
    const record = pairs.value.sets[set];
    const given = answers.value.sets[set];
    if (record === undefined || given === undefined) return err(`scored set ${set} has no pairs.json record or no owner answers`);
    const verdicts = readVerdicts(calibPaths(ctx.root, set));
    if (!verdicts.ok) return verdicts;
    out.push({ set, record, answers: given.answers, verdicts: verdicts.value });
  }
  return ok({ kind: 'sources', value: out });
}

/** Judged texts of a round: champion pairs.json plus taste/aux/pairs.json when 06c ran. */
function roundTexts(root: string, round: string): Result<Record<string, LabelText>> {
  const paths = roundPaths(root, round);
  const texts: Record<string, LabelText> = {};
  for (const which of ['champion', 'aux'] satisfies ReadonlyArray<'champion' | 'aux'>) {
    if (which === 'aux' && !existsSync(pairsFilePath(paths, 'aux'))) continue;
    const file = readPairsFile(paths, which);
    if (!file.ok) return err(`rounds/${round}: ${file.error}`);
    for (const t of Object.values(file.value.texts)) texts[t.id] = { id: t.id, path: t.file, sha256: t.sha256, authors: [...t.authors] };
  }
  return ok(texts);
}

/** Display id → text id: 08 labels.json (label → submission id), CHAMPION_ID and the anchors map to themselves. */
function displayMap(root: string, round: string): Result<Record<string, string>> {
  const raw = readJsonAt(root, `rounds/${round}/labels.json`);
  if (!raw.ok) return raw;
  if (!isRecord(raw.value)) return err(`rounds/${round}/labels.json: expected an object`);
  const out: Record<string, string> = { [CHAMPION_ID]: CHAMPION_ID };
  for (const id of ANCHOR_IDS) out[id] = id;
  for (const [label, id] of Object.entries(raw.value)) {
    if (typeof id !== 'string') return err(`rounds/${round}/labels.json: label ${label} does not name a submission`);
    out[label] = id;
  }
  return ok(out);
}

/** Every R round whose audit.json exists (rounds before 09a contribute nothing yet), round order; `repair` waits as in calibSources. */
function roundSources(ctx: StepContext): Result<Sourced<RoundLabelSource[]>> {
  const dir = join(ctx.root, 'rounds');
  if (!existsSync(dir)) return ok({ kind: 'sources', value: [] });
  const out: RoundLabelSource[] = [];
  for (const round of readdirSync(dir).filter((n) => /^R\d{2}$/u.test(n)).sort(byCodeUnit)) {
    if (!existsSync(join(dir, round, 'audit.json'))) continue;
    const audit = ctx.owner.audit(round);
    if (audit.state === 'repair') return ok({ kind: 'wait', waitingFor: 'owner_log_repair', detail: audit.detail });
    if (audit.state !== 'ok') return err(`rounds/${round}/audit.json: ${ownerProblem(audit)}`);
    const rawSet = readJsonAt(ctx.root, `rounds/${round}/audit-set.json`);
    if (!rawSet.ok) return rawSet;
    const auditSet = parseAuditSet(rawSet.value);
    if (auditSet === null) return err(`rounds/${round}/audit-set.json: malformed`);
    const textOf = displayMap(ctx.root, round);
    if (!textOf.ok) return textOf;
    const texts = roundTexts(ctx.root, round);
    if (!texts.ok) return texts;
    const sessions: Record<string, FamilySessions[]> = {};
    for (const p of auditSet.pairs) sessions[p.pair] = pairVerdicts(ctx.root, round, p.pair);
    out.push({ round, auditSet, audit: audit.value, textOf: textOf.value, texts: texts.value, sessions });
  }
  return ok({ kind: 'sources', value: out });
}

/**
 * Reads every source, writes labels.json then status.json via ctx.files (both validated first: status by
 * parseTrustStatus, the ledger by parseLabelLedger). No timestamps: a rerun with the same inputs writes the same bytes.
 * An owner file awaiting a log repair returns a TrustWait and writes nothing; err is an integrity problem.
 */
export function rebuildTrust(ctx: StepContext, after: string): Result<TrustRebuild> {
  const reports = readCalibReports(ctx.root);
  if (!reports.ok) return reports;
  const calib = calibSources(ctx, reports.value);
  if (!calib.ok) return calib;
  if (calib.value.kind === 'wait') return ok(calib.value);
  const rounds = roundSources(ctx);
  if (!rounds.ok) return rounds;
  if (rounds.value.kind === 'wait') return ok(rounds.value);
  const ledger = buildLedger({ calib: calib.value.value, rounds: rounds.value.value }, ctx.protocol.calibration);
  if (!ledger.ok) return ledger;
  const labelsText = jsonText(ledger.value);
  const checked = parseLabelLedger(JSON.parse(labelsText));
  if (!checked.ok) return err(`${LABELS_FILE}: ${checked.error}`);
  const prev = readTrustStatus(ctx.root);
  if (prev !== null && !prev.ok) return prev;
  const status = computeStatus(ledger.value, reports.value, prev?.value ?? null, ctx.config.judges, ctx.protocol.calibration, after);
  const statusText = jsonText(status);
  const valid = parseTrustStatus(JSON.parse(statusText));
  if (!valid.ok) return err(`${TRUST_STATUS}: ${valid.error}`);
  ctx.files.writeText(join(ctx.root, LABELS_FILE), labelsText);
  ctx.files.writeText(join(ctx.root, TRUST_STATUS), statusText);
  return ok({ kind: 'status', status });
}

/** Step 11e (PR-D agreementStep) = rebuildTrust(ctx, roundId); a TrustWait becomes WAIT owner_log_repair there. */
export function updateTrust(ctx: StepContext, roundId: string): Result<TrustRebuild> {
  return rebuildTrust(ctx, roundId);
}

/** Labels whose texts the evidence packet may show (split visible), in ledger order. */
export function visibleLabels(ledger: LabelLedger): Label[] {
  return ledger.labels.filter((l) => l.split === 'visible');
}

/** Round order of a label: C00 before every R round (R01 = 1); requal labels are never reserve. */
function roundOrder(label: Label): number {
  const m = /^R(\d{2})$/u.exec(label.round);
  return m?.[1] === undefined ? -1 : Number(m[1]);
}

/** Texts every family and the maintainer may already know: the round champion and the anchors recur across pairs. */
function isSharedText(t: LabelText): boolean {
  return t.id === CHAMPION_ID || ANCHOR_IDS.includes(t.id);
}

/** sha256 of every non-shared text a visible label shows (the evidence packet may print them). */
function shownTextShas(ledger: LabelLedger): Set<string> {
  return new Set(visibleLabels(ledger).flatMap((l) => l.texts.filter((t) => !isSharedText(t)).map((t) => t.sha256)));
}

/**
 * Replay input (PROTOCOL §8): reserve labels newest first by (round, seq), at most `max`, never visible. A reserve
 * label whose non-shared text also sits in a visible label is left out: the maintainer may have read that text in
 * the evidence packet, so the pair is no longer blind (split stays per label; exclusivity is decided per text here).
 */
export function reserveLabels(ledger: LabelLedger, max: number): Label[] {
  const shown = shownTextShas(ledger);
  const reserve = ledger.labels.filter((l) => l.split === 'reserve' && !l.texts.some((t) => !isSharedText(t) && shown.has(t.sha256)));
  return reserve.sort((x, y) => roundOrder(y) - roundOrder(x) || y.seq - x.seq).slice(0, Math.max(0, max));
}
