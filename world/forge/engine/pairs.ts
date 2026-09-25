import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IntegrityError } from './calls.ts';
import { parseChampion, type Champion } from './champions.ts';
import { isFamily, type Family } from './config.ts';
import { isRecord, readString } from './json.ts';
import { err, ok, type Result } from './result.ts';
import { roundPaths, seeded, type RoundPaths } from './store.ts';
import { tasteTaskId, type Order } from './tasks/ids.ts';

/**
 * Session-pair schedule and verdict reading for taste pairs (06b champion pairs, 06c aux pairs). FamilySessions is
 * the one per-family view of a pair read by tally (08), the trust ledger (PR-C `trialOf`) and bench evidence (PR-E).
 */

export type { Order };

export type PairKind = 'champion' | 'sub_sub' | 'anchor';

/** Text id of the decoy (`submissions/DECOY.json`, written by 06a). */
export const DECOY_ID = 'DECOY';

/** Anchor text ids: AN1 = the most recent previous owner-picked champion of the row, AN2 the one before. */
export const ANCHOR_IDS: readonly string[] = ['AN1', 'AN2'];

/** Round-local champion snapshot written by 06a (`rounds/RNN/champion.json` = the Champion record, verified against freeze.sha256.champion). */
export const CHAMPION_SNAPSHOT = 'champion.json';

/** `rounds/RNN/taste/aux/pairs.json` (06c; 06b writes `rounds/RNN/pairs.json`). */
export const AUX_PAIRS_FILE = 'taste/aux/pairs.json';

/** A judged text of the round. */
export interface TextRef {
  /** Submission id, CHAMPION_ID (`BASE`), DECOY_ID, or an ANCHOR_IDS entry. */
  id: string;
  kind: 'submission' | 'champion' | 'anchor' | 'decoy';
  /** Forge-root-relative file holding it: `rounds/RNN/submissions/<id>.json`, `rounds/RNN/champion.json`, or `rounds/<r>/submissions/<s>.json` for anchors. */
  file: string;
  /** SHA-256 of the display text judges saw. */
  sha256: string;
  /** Author families excluded from judging it (decoy: champion authors + the decoy writer's family). */
  authors: Family[];
}

export interface PairEntry {
  /** Champion pair: the submission id; aux: tasks/ids.ts auxPairId. */
  id: string;
  kind: PairKind;
  /** Text ids: champion pairs left = submission, right = CHAMPION_ID; aux as named in auxPairId. */
  left: string;
  right: string;
  /** E before drops (champion) or the 2 seeded families (aux), code-unit sorted. */
  families: Family[];
  /** Flagged families judging as shadow (champion pairs only; never in E, bars or tally). */
  shadow: Family[];
  /** E after void drops (aux: families with at least one valid call). */
  effective: Family[];
  dropped: Family[];
}

/** `rounds/RNN/pairs.json` (06b, champion pairs) and `rounds/RNN/taste/aux/pairs.json` (06c). */
export interface PairsFile {
  round: string;
  champion: string;
  texts: Record<string, TextRef>;
  pairs: PairEntry[];
}

export interface SessionCallPlan {
  taskId: string;
  order: Order;
  /** Seeded decoy position (key `decoypos:<pair>:<family>:s<k>[r]:<order>`); aux calls carry no decoy pair. */
  decoyAt: 3 | 4 | null;
}

/** One planned session-pair: fwd (submission = text 1) and rev (champion = text 1), two fresh calls. */
export interface SessionPlan {
  pairId: string;
  family: Family;
  shadow: boolean;
  session: number;
  rerun: boolean;
  fwd: SessionCallPlan;
  rev: SessionCallPlan;
}

/** One taste call as tally and the trust ledger read it. */
export interface SessionCall {
  taskId: string;
  order: Order;
  status: 'ok' | 'void';
  /** Text id picked on bench.decisive; null when void. */
  decisive: string | null;
  preferredDecoy: boolean;
}

export type DropReason = 'void_after_rerun';

/** Final session-pairs of one family on one pair: a rerun `s<k>r` replaces session k; `[fwd, rev]` per session. */
export interface FamilySessions {
  family: Family;
  shadow: boolean;
  sessions: Array<[SessionCall, SessionCall]>;
  /** Session indexes that were rerun. */
  reruns: number[];
  /** Still void after its rerun → out of E for this pair. */
  dropped: DropReason | null;
}

/** One taste call file: `taste/<pair>/<family>-s<k>[r]-<fwd|rev>.json` (champion) or `taste/aux/<pair>/<family>-s0-<fwd|rev>.json`. */
export interface TasteCallFile {
  round: string;
  pair: string;
  kind: PairKind;
  family: Family;
  shadow: boolean;
  session: number;
  rerun: boolean;
  order: Order;
  task: string;
  /** Text ids at positions 1 and 2. */
  text1: string;
  text2: string;
  status: 'ok' | 'void';
  /** Question id → picked text id ({} when void). */
  picks: Record<string, string>;
  quotes: Record<string, string>;
  decisive: string | null;
  decoy_at: 3 | 4 | null;
  decoy_pick: 3 | 4 | null;
  preferred_decoy: boolean;
  error: string | null;
}

/** The call file path of one taste call (convention above). */
export function tasteCallPath(paths: RoundPaths, kind: PairKind, pairId: string, family: Family, session: number, rerun: boolean, order: Order): string {
  const name = `${family}-s${session}${rerun ? 'r' : ''}-${order}.json`;
  return kind === 'champion' ? join(paths.taste, pairId, name) : join(paths.taste, 'aux', pairId, name);
}


const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Seeded decoy position, key `decoypos:<pair>:<family>:s<k>[r]:<order>`. */
export function decoyPosition(seed: string, pairId: string, family: Family, session: number, rerun: boolean, order: Order): 3 | 4 {
  return seeded(seed, `decoypos:${pairId}:${family}:s${session}${rerun ? 'r' : ''}:${order}`) < 0.5 ? 3 : 4;
}

function callPlan(seed: string, pairId: string, family: Family, session: number, rerun: boolean, order: Order): SessionCallPlan {
  return { taskId: tasteTaskId(pairId, family, session, rerun, order), order, decoyAt: decoyPosition(seed, pairId, family, session, rerun, order) };
}

function sessionPlan(seed: string, pairId: string, family: Family, shadow: boolean, session: number, rerun: boolean): SessionPlan {
  return {
    pairId, family, shadow, session, rerun,
    fwd: callPlan(seed, pairId, family, session, rerun, 'fwd'),
    rev: callPlan(seed, pairId, family, session, rerun, 'rev'),
  };
}

/** E × sessionPairs (protocol bars.session_pairs) session plans, then the shadow families' (shadow: true), each with a seeded decoy position. */
export function championSchedule(E: readonly Family[], shadow: readonly Family[], seed: string, pairId: string, sessionPairs: number): SessionPlan[] {
  if (!Number.isInteger(sessionPairs) || sessionPairs < 1) throw new Error(`championSchedule: sessionPairs must be a positive integer, got ${sessionPairs}`);
  const counted = [...new Set(E)].sort(byCodeUnit);
  const shadows = [...new Set(shadow)].sort(byCodeUnit);
  const both = shadows.find((f) => counted.includes(f));
  if (both !== undefined) throw new Error(`championSchedule: ${both} is both in E and shadow on ${pairId}`);
  const plans: SessionPlan[] = [];
  for (const family of counted) for (let k = 0; k < sessionPairs; k += 1) plans.push(sessionPlan(seed, pairId, family, false, k, false));
  for (const family of shadows) for (let k = 0; k < sessionPairs; k += 1) plans.push(sessionPlan(seed, pairId, family, true, k, false));
  return plans;
}

/** The `s<k>r` rerun of a voided session-pair (fresh ids, new decoy positions). */
export function rerunPlan(plan: SessionPlan, seed: string): SessionPlan {
  if (plan.rerun) throw new Error(`rerunPlan: ${plan.fwd.taskId} is already a rerun (one rerun per session-pair)`);
  return sessionPlan(seed, plan.pairId, plan.family, plan.shadow, plan.session, true);
}

/** Void when either call is void or prefers the decoy. */
export function sessionVoid(fwd: SessionCall, rev: SessionCall): boolean {
  return fwd.status === 'void' || rev.status === 'void' || fwd.preferredDecoy || rev.preferredDecoy;
}

/** Non-shadow families not dropped, code-unit sorted. */
export function effectiveFamilies(results: readonly FamilySessions[]): Family[] {
  return results.filter((r) => !r.shadow && r.dropped === null).map((r) => r.family).sort(byCodeUnit);
}

const PAIR_KINDS: readonly PairKind[] = ['champion', 'sub_sub', 'anchor'];
const TEXT_KINDS: readonly TextRef['kind'][] = ['submission', 'champion', 'anchor', 'decoy'];
const HEX64 = /^[0-9a-f]{64}$/u;

function familyOf(value: unknown): Family | null {
  return typeof value === 'string' && isFamily(value) ? value : null;
}

function familyList(value: unknown): Family[] | null {
  if (!Array.isArray(value)) return null;
  const out: Family[] = [];
  for (const v of value) {
    const f = familyOf(v);
    if (f === null) return null;
    out.push(f);
  }
  return out;
}

function stringMap(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') return null;
    out[k] = v;
  }
  return out;
}

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === 'string' ? value : undefined;
}

function position(value: unknown): 3 | 4 | null | undefined {
  return value === null ? null : value === 3 ? 3 : value === 4 ? 4 : undefined;
}

/** One `taste/…/<family>-s<k>[r]-<order>.json` call file; err names the first malformed field. */
function parseTasteCallFile(value: unknown): Result<TasteCallFile> {
  if (!isRecord(value)) return err('expected an object');
  const round = readString(value, 'round');
  const pair = readString(value, 'pair');
  const task = readString(value, 'task');
  const text1 = readString(value, 'text1');
  const text2 = readString(value, 'text2');
  if (round === null || pair === null || task === null || text1 === null || text2 === null) return err('round, pair, task, text1 and text2 are required strings');
  const kind = PAIR_KINDS.find((k) => k === value['kind']);
  const family = familyOf(value['family']);
  const order = value['order'] === 'fwd' ? 'fwd' : value['order'] === 'rev' ? 'rev' : null;
  const status = value['status'] === 'ok' ? 'ok' : value['status'] === 'void' ? 'void' : null;
  if (kind === undefined || family === null || order === null || status === null) return err('kind, family, order or status is not a known value');
  const session = value['session'];
  const shadow = value['shadow'];
  const rerun = value['rerun'];
  const preferred = value['preferred_decoy'];
  if (typeof session !== 'number' || !Number.isInteger(session) || session < 0) return err('session: expected a non-negative integer');
  if (typeof shadow !== 'boolean' || typeof rerun !== 'boolean' || typeof preferred !== 'boolean') return err('shadow, rerun and preferred_decoy are required booleans');
  const picks = stringMap(value['picks']);
  const quotes = stringMap(value['quotes']);
  if (picks === null || quotes === null) return err('picks and quotes must map question ids to strings');
  const decisive = nullableString(value['decisive']);
  const error = nullableString(value['error']);
  const decoyAt = position(value['decoy_at']);
  const decoyPick = position(value['decoy_pick']);
  if (decisive === undefined || error === undefined) return err('decisive and error must be a string or null');
  if (decoyAt === undefined || decoyPick === undefined) return err('decoy_at and decoy_pick must be 3, 4 or null');
  if ((status === 'ok') !== (decisive !== null)) return err('decisive must be set exactly when status is ok');
  return ok({
    round, pair, kind, family, shadow, session, rerun, order, task, text1, text2, status, picks, quotes, decisive,
    decoy_at: decoyAt, decoy_pick: decoyPick, preferred_decoy: preferred, error,
  });
}

/** The SessionCall view of one call file (what tally, trust and sessionVoid read). */
export function sessionCallOf(f: TasteCallFile): SessionCall {
  return { taskId: f.task, order: f.order, status: f.status, decisive: f.decisive, preferredDecoy: f.preferred_decoy };
}

type CallPair = [TasteCallFile | undefined, TasteCallFile | undefined];

function completePair(p: CallPair | undefined, what: string): [SessionCall, SessionCall] {
  const [fwd, rev] = p ?? [undefined, undefined];
  if (fwd === undefined || rev === undefined) throw new IntegrityError(`${what}: both the fwd and the rev call file are required`);
  return [sessionCallOf(fwd), sessionCallOf(rev)];
}

/**
 * Final FamilySessions of one pair from its call files (champion or aux): a rerun `s<k>r` replaces session k;
 * a rerun still void → `dropped: 'void_after_rerun'`. Sessions must be 0…n-1 with both orders; code-unit sorted by
 * family. Throws IntegrityError on an incomplete or inconsistent set (the step writes every file before its marker).
 */
export function familySessionsOf(calls: readonly TasteCallFile[]): FamilySessions[] {
  const byFamily = new Map<Family, TasteCallFile[]>();
  for (const c of calls) byFamily.set(c.family, [...(byFamily.get(c.family) ?? []), c]);
  const out: FamilySessions[] = [];
  for (const family of [...byFamily.keys()].sort(byCodeUnit)) {
    const own = byFamily.get(family) ?? [];
    const first = own[0];
    if (first === undefined) continue;
    if (own.some((c) => c.shadow !== first.shadow || c.pair !== first.pair)) throw new IntegrityError(`taste ${first.pair} ${family}: call files disagree on shadow or pair`);
    const orig = new Map<number, CallPair>();
    const rerun = new Map<number, CallPair>();
    for (const c of own) {
      const into = c.rerun ? rerun : orig;
      const slot: CallPair = into.get(c.session) ?? [undefined, undefined];
      if (slot[c.order === 'fwd' ? 0 : 1] !== undefined) throw new IntegrityError(`taste ${c.pair} ${family}: duplicate call ${c.task}`);
      slot[c.order === 'fwd' ? 0 : 1] = c;
      into.set(c.session, slot);
    }
    const sessions: Array<[SessionCall, SessionCall]> = [];
    const reruns: number[] = [];
    let dropped: DropReason | null = null;
    for (let k = 0; k < orig.size; k += 1) {
      const base = completePair(orig.get(k), `taste ${first.pair} ${family} s${k}`);
      if (!rerun.has(k)) {
        sessions.push(base);
        continue;
      }
      const again = completePair(rerun.get(k), `taste ${first.pair} ${family} s${k}r`);
      reruns.push(k);
      sessions.push(again);
      if (sessionVoid(again[0], again[1])) dropped = 'void_after_rerun';
    }
    if ([...rerun.keys()].some((k) => !orig.has(k))) throw new IntegrityError(`taste ${first.pair} ${family}: a rerun without its session`);
    out.push({ family, shadow: first.shadow, sessions, reruns, dropped });
  }
  return out;
}

/** Directory of one pair's call files: aux pair ids hold a `.` (tasks/ids.ts auxPairId), champion pair ids never do. */
export function pairDir(paths: RoundPaths, pairId: string): string {
  return pairId.includes('.') ? join(paths.taste, 'aux', pairId) : join(paths.taste, pairId);
}

/** Every call file of one pair directory, parsed and checked against its file name; [] when the directory is absent. */
function readCallFiles(paths: RoundPaths, pairId: string): TasteCallFile[] {
  const dir = pairDir(paths, pairId);
  if (!existsSync(dir)) return [];
  const out: TasteCallFile[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort(byCodeUnit)) {
    const where = `rounds/${paths.id}/${pairId.includes('.') ? 'taste/aux' : 'taste'}/${pairId}/${name}`;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      throw new IntegrityError(`${where} is not valid JSON`);
    }
    const parsed = parseTasteCallFile(raw);
    if (!parsed.ok) throw new IntegrityError(`${where}: ${parsed.error}`);
    const f = parsed.value;
    const expected = tasteCallPath(paths, f.kind, pairId, f.family, f.session, f.rerun, f.order);
    if (f.round !== paths.id || f.pair !== pairId || expected !== join(dir, name)) throw new IntegrityError(`${where}: round, pair or call does not match the file name`);
    out.push(f);
  }
  return out;
}

/** Reads every call file of one pair (champion dir or aux dir) into final FamilySessions, code-unit sorted by family. */
export function pairVerdicts(root: string, roundId: string, pairId: string): FamilySessions[] {
  return familySessionsOf(readCallFiles(roundPaths(root, roundId), pairId));
}

/** `rounds/RNN/pairs.json` (champion) or `rounds/RNN/taste/aux/pairs.json` (aux). */
export function pairsFilePath(paths: RoundPaths, which: 'champion' | 'aux'): string {
  return which === 'champion' ? join(paths.dir, 'pairs.json') : join(paths.dir, AUX_PAIRS_FILE);
}

function parseTextRef(value: unknown, key: string): Result<TextRef> {
  const id = readString(value, 'id');
  const file = readString(value, 'file');
  const sha = readString(value, 'sha256');
  const kind = TEXT_KINDS.find((k) => isRecord(value) && k === value['kind']);
  const authors = familyList(isRecord(value) ? value['authors'] : null);
  if (id !== key || file === null || file === '' || kind === undefined || authors === null) return err(`texts.${key}: id (= key), kind, file and authors are required`);
  if (sha === null || !HEX64.test(sha)) return err(`texts.${key}.sha256: expected a lowercase SHA-256 hex digest`);
  return ok({ id, kind, file, sha256: sha, authors });
}

function parsePairEntry(value: unknown, i: number): Result<PairEntry> {
  const id = readString(value, 'id');
  const left = readString(value, 'left');
  const right = readString(value, 'right');
  const kind = PAIR_KINDS.find((k) => isRecord(value) && k === value['kind']);
  if (id === null || left === null || right === null || kind === undefined) return err(`pairs[${i}]: id, kind, left and right are required`);
  const list = (key: string): Family[] | null => familyList(isRecord(value) ? value[key] : null);
  const families = list('families');
  const shadow = list('shadow');
  const effective = list('effective');
  const dropped = list('dropped');
  if (families === null || shadow === null || effective === null || dropped === null) return err(`pairs[${i}]: families, shadow, effective and dropped must be family arrays`);
  return ok({ id, kind, left, right, families, shadow, effective, dropped });
}

/** A PairsFile value (schema/pairs.schema.json plus every TextRef and family). */
export function parsePairsFile(value: unknown): Result<PairsFile> {
  const round = readString(value, 'round');
  const champion = readString(value, 'champion');
  const rawTexts = isRecord(value) ? value['texts'] : null;
  const rawPairs = isRecord(value) ? value['pairs'] : null;
  if (round === null || champion === null || !isRecord(rawTexts) || !Array.isArray(rawPairs)) return err('round, champion, texts and pairs are required');
  const texts: Record<string, TextRef> = {};
  for (const [key, t] of Object.entries(rawTexts)) {
    const parsed = parseTextRef(t, key);
    if (!parsed.ok) return parsed;
    texts[key] = parsed.value;
  }
  const pairs: PairEntry[] = [];
  for (const [i, p] of rawPairs.entries()) {
    const parsed = parsePairEntry(p, i);
    if (!parsed.ok) return parsed;
    if (!Object.hasOwn(texts, parsed.value.left) || !Object.hasOwn(texts, parsed.value.right)) return err(`pairs[${i}]: left and right must name texts`);
    pairs.push(parsed.value);
  }
  return ok({ round, champion, texts, pairs });
}

function readJsonResult(path: string, rel: string): Result<unknown> {
  if (!existsSync(path)) return err(`${rel} is missing`);
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return ok(raw);
  } catch {
    return err(`${rel} is not valid JSON`);
  }
}

/** `pairs.json` (champion) or `taste/aux/pairs.json` (aux) of a round; err when missing or malformed. */
export function readPairsFile(paths: RoundPaths, which: 'champion' | 'aux'): Result<PairsFile> {
  const rel = `rounds/${paths.id}/${which === 'champion' ? 'pairs.json' : AUX_PAIRS_FILE}`;
  const raw = readJsonResult(pairsFilePath(paths, which), rel);
  if (!raw.ok) return raw;
  const parsed = parsePairsFile(raw.value);
  return parsed.ok ? parsed : err(`${rel}: ${parsed.error}`);
}

/** `rounds/RNN/champion.json` (06a snapshot); err when missing or malformed. */
export function readChampionSnapshot(paths: RoundPaths): Result<Champion> {
  const rel = `rounds/${paths.id}/${CHAMPION_SNAPSHOT}`;
  const raw = readJsonResult(join(paths.dir, CHAMPION_SNAPSHOT), rel);
  if (!raw.ok) return raw;
  const row = readString(raw.value, 'row_id');
  if (row === null) return err(`${rel}: row_id is required`);
  const parsed = parseChampion(raw.value, row);
  return parsed.ok ? parsed : err(`${rel}: ${parsed.error}`);
}
