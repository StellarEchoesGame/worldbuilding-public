import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { setOwnerPickChampion, type Champion } from './champions.ts';
import { isFamily, type Family } from './config.ts';
import type { StepContext } from './context.ts';
import { canonFiles, parseRegister07 } from './inputs.ts';
import { isRecord, readArray, readRecord, readString, stringArray } from './json.ts';
import { drainMirrors } from './mirror.ts';
import type { Decision } from './owner-inputs.ts';
import { isSupersededProbe, matchProbeComment, parseSealedForecasts, probeFiles, readProbeFile, readProbeRecord, type SealedForecasts } from './probe.ts';
import { err, ok, type Result } from './result.ts';
import { ensureRoundBranch, type StepDef, type StepOutcome } from './runner.ts';
import { verifySeal } from './seal.ts';
import { readBriefJson, REF_07, loadAliasFile, loadRowAliases, loadRows, rowNames, type BriefJson } from './steps/brief.ts';
import { judgeBackend, judgeFamilies } from './steps/gate-llm.ts';
import { readUnsealFile, surprisePath, type UnsealFile } from './steps/surprise.ts';
import { readJson, readRecords, sha256 } from './store.ts';
import { displayText, loadSubmission, type LoadedSubmission } from './submission.ts';
import type { ChampionPairResult } from './tally.ts';
import { IntegrityError, readTaskRecord, runTask } from './task.ts';
import { eligibleFamilies, familyStates, pickFamilies } from './tasks/assign.ts';
import type { ForecastSlot } from './tasks/forecast.ts';
import { surpriseTaskId } from './tasks/ids.ts';
import type { SurpriseStatus } from './tasks/surprise.ts';
import { applyTags, reviewTagTask, tagReviewTaskId, tagTask, tagTaskId, type KeptTag, type TagProposal, type TagReview } from './tasks/tagging.ts';
import { computeThinmap, LAYER_LABELS, LAYERS, type Alias, type CellValue, type Layer, type ThinmapResult } from './thinmap.ts';

/**
 * Step 11 bookkeeping (plan §4 rows 29–32, 39–40, §8 Bookkeeping, s5 §6; PR-D group D3). Round files go under
 * `rounds/RNN/`; shared files (champions.json, map/tags.json) are marker `external`; regression/forecast-pool.jsonl is
 * an engine log (runner engineJsonlLogs) and never listed. 11k / 11l get defs here but are registered by PR-E.
 */

/** Round-dir-relative outputs. */
export const UNSEALED_DIR = 'unsealed';
export const RECHECK_FILE = 'unsealed/recheck.json';
export const TAGGING_FILE = 'tagging.json';
export const THINMAP_DELTA_FILE = 'thinmap-delta.json';
export const WIKI_PAGES_FILE = 'wiki-pages.json';
/** Forge-root-relative shared files. */
export const FORECAST_POOL_FILE = 'regression/forecast-pool.jsonl';
export const TAGS_FILE = 'map/tags.json';
export const SNAPSHOT_R0_FILE = 'map/snapshot-r0.json';
/** Repository-relative wiki pages 11k scans (and their i18n twins). */
export const WIKI_WORLD_DIR = 'wiki/src/content/docs/world';
/** world/current-relative key of the 09 scene file (the `file` of every quote 11d adds to map/tags.json). */
export const SCENES_KEY = 'reference/09-scenes-and-people.md';

/** `unsealed/recheck.json` (11a; 07a's unseal.json is never rewritten). */
export interface RecheckFile {
  round: string;
  /** verifySeal of the copied files against probes.sha256; `missing` = no sealed files (nothing published). */
  seal: 'verified' | 'missing' | 'mismatch';
  /** Remote probe comment recheck (always rerun when 07a recorded `unavailable`). */
  remote: 'verified' | 'unavailable' | 'mismatch';
  published: boolean;
  checked_at: string;
}

/** One regression/forecast-pool.jsonl line per sealed forecast item. */
export interface PoolLine {
  round: string;
  row_id: string;
  forecaster: string;
  family: string;
  slot: ForecastSlot;
  value: string;
  /** The forecaster is a writer model (sealed.json `writer_model`, s5 §1). */
  writer_model: boolean;
  /**
   * `forecast`: a working matcher matched it to a detail of some submission. `unmatched`: a working matcher compared
   * the forecasts with at least one submission (it sees them all) and no detail matched this one. null: no comparison
   * happened — no surprise.json, or every report is `insufficient` (no matcher ran), has no detail, or both matchers void.
   */
  surprise: 'forecast' | 'unmatched' | null;
}

/** One submission's surprise.json report as 11b reads it. */
export interface PoolReport {
  status: SurpriseStatus;
  /** Status of each matcher task that ran (its `.sealed/RNN/tasks/match-<sub>-<family>.json` record); [] when none ran. */
  match_status: ReadonlyArray<'ok' | 'void'>;
  /** Matched opaque forecast ids per detail. */
  details: ReadonlyArray<{ forecasts: readonly string[] }>;
}

/** What 11b knows of 07b: surprise.json reports plus their sealed matcher task statuses. */
export interface PoolSurprise {
  submissions: Readonly<Record<string, PoolReport>>;
}

/** The part of tally.json 11c reads (a RoundTally satisfies it). */
export type TallyPairs = { champion_pairs: ReadonlyArray<Pick<ChampionPairResult, 'label' | 'submission' | 'beats_champion' | 'trial'>> };

export interface PickChampionInput {
  round: string;
  rowId: string;
  decision: Decision;
  tally: TallyPairs;
  /** The picked submission (never a merged text). */
  submission: LoadedSubmission;
  family: Family;
  at: string;
}

export interface ThinmapDeltaRow {
  row_id: string;
  layer: Layer;
  /** null when map/snapshot-r0.json is missing (never a substituted 0). */
  r0: CellValue | null;
  now: CellValue;
  /** (row_id, layer) is the brief's target cell. */
  target: boolean;
  /** now > r0; false when r0 is null. */
  above_r0: boolean;
}

/** `thinmap-delta.json` (reported, never a gate). */
export interface ThinmapDelta {
  round: string;
  /** Whether map/snapshot-r0.json existed (F1-05 produces it); `missing` → every r0 null and all_targets_above false. */
  snapshot: 'present' | 'missing';
  rows: ThinmapDeltaRow[];
  all_targets_above: boolean;
}

/** map/snapshot-r0.json as 11d found it: absent, or its parsed content (null when it is not JSON, i.e. malformed). */
export type SnapshotR0 = { state: 'missing' } | { state: 'present'; value: unknown };

/** `tagging.json`: disputed quotes live only here, never in map/tags.json. */
export interface TaggingFile {
  round: string;
  touched: string[];
  tagger: { family: Family; task: string; status: 'ok' | 'void' };
  reviewer: { family: Family; task: string; status: 'ok' | 'void' } | null;
  proposals: TagProposal[];
  reviews: TagReview[];
  kept: KeptTag[];
  disputed: TagReview[];
}

export interface WikiPage {
  /** Repository-relative. */
  path: string;
  terms: string[];
  rounds: string[];
}

/** `wiki-pages.json` (listing only; pages are rewritten by hand in F1-10). */
export interface WikiPagesFile {
  round: string;
  /** The last three rounds with a merge.json. */
  rounds: string[];
  publish: Record<string, 'yes' | 'no'>;
  pages: WikiPage[];
}

const ROUND_ID = /^[A-Z](\d{2})$/u;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Opaque forecast ids as tasks/surprise.ts flattenForecasts numbers them (P01…, width ≥ 2), in seal order. */
function opaqueIds(sealed: SealedForecasts): string[] {
  const total = sealed.forecasts.reduce((n, f) => n + f.items.length, 0);
  const width = Math.max(2, String(total).length);
  return Array.from({ length: total }, (_, i) => `P${String(i + 1).padStart(width, '0')}`);
}

/** Report statuses under which surpriseRoles picked two matchers (insufficient: none; invalid / inactive: round-level only). */
const MATCHER_STATUSES: readonly SurpriseStatus[] = ['full', 'reused', 'match_only'];
const SURPRISE_STATUSES: readonly SurpriseStatus[] = [...MATCHER_STATUSES, 'insufficient', 'invalid', 'inactive'];

/** A working matcher (ok record) compared this submission's details with the forecasts. */
function compared(report: PoolReport): boolean {
  return MATCHER_STATUSES.includes(report.status) && report.match_status.includes('ok');
}

/** 11b lines, sorted by forecaster then item order; see PoolLine.surprise for forecast / unmatched / null. */
export function poolLines(round: string, rowId: string, sealed: SealedForecasts, surprise: PoolSurprise | null): PoolLine[] {
  const reports = Object.values(surprise?.submissions ?? {}).filter(compared);
  const matched = new Set<string>();
  for (const report of reports) for (const d of report.details) for (const id of d.forecasts) matched.add(id);
  const ids = opaqueIds(sealed);
  const out: PoolLine[] = [];
  for (const f of sealed.forecasts) {
    for (const item of f.items) {
      const id = ids[out.length] ?? '';
      out.push({
        round, row_id: rowId, forecaster: f.forecaster, family: f.family, slot: item.slot, value: item.value, writer_model: f.writer_model,
        surprise: matched.has(id) ? 'forecast' : reports.length > 0 ? 'unmatched' : null,
      });
    }
  }
  return out;
}

/**
 * 11c: owner_pick Champion when the pick (not none) has `beats_champion` in tally.json, else null. Only the picked
 * submission's own champion pair counts (a base or donor that beat the champion does not); a `trial` pair never
 * replaces a champion; the text is the pick's display text, never the merged scene. `previous` is left empty:
 * `setOwnerPickChampion` fills it from the current champions.json entry.
 */
export function pickChampion(input: PickChampionInput): Champion | null {
  const { decision, submission } = input;
  if (decision.pick === 'none' || submission.output === null || !submission.ok) return null;
  const pair = input.tally.champion_pairs.find((p) => p.label === decision.pick && p.submission === submission.id);
  if (pair === undefined || !pair.beats_champion || pair.trial) return null;
  const text = displayText(submission.output);
  return {
    row_id: input.rowId, kind: 'owner_pick', round: input.round, submission: submission.id, family: input.family, authors: [input.family],
    text, text_sha256: sha256(text), set_at: input.at, previous: [],
  };
}

/** decision rows ∪ registered row_ids ∪ rows / characters whose primary or an alias occurs in the scene; sorted. */
export function touchedRows(decisionRows: readonly string[], registeredRows: readonly string[], scene: string, aliases: readonly Alias[]): string[] {
  const named = aliases.filter((a) => [a.primary, ...a.aliases].some((n) => n.trim() !== '' && scene.includes(n.trim()))).map((a) => a.row_id);
  return unique([...decisionRows, ...registeredRows, ...named]).sort(byCodeUnit);
}

function cellValueOf(value: unknown): CellValue | null {
  const n = isRecord(value) ? value['value'] : value;
  return n === 0 || n === 1 || n === 2 || n === 3 ? n : null;
}

/**
 * `{cells: {row_id: {layer: value}}}` (value 0–3, or `{value}` as a thinmap Cell); an absent row or layer is 0.
 * err on any other shape.
 */
function snapshotValues(snapshot: unknown): Result<(rowId: string, layer: Layer) => CellValue> {
  const cells = readRecord(snapshot, 'cells');
  if (cells === null) return err(`${SNAPSHOT_R0_FILE}: expected { "cells": { row_id: { layer: value } } }`);
  for (const [rowId, layers] of Object.entries(cells)) {
    if (!isRecord(layers)) return err(`${SNAPSHOT_R0_FILE}: cells.${rowId} must be an object`);
    for (const [layer, v] of Object.entries(layers)) {
      if (!LAYERS.some((l) => l === layer) || cellValueOf(v) === null) return err(`${SNAPSHOT_R0_FILE}: cells.${rowId}.${layer} must be a thin-map layer with a value 0–3`);
    }
  }
  return ok((rowId, layer) => {
    const row = Object.hasOwn(cells, rowId) ? cells[rowId] : undefined;
    return isRecord(row) && Object.hasOwn(row, layer) ? (cellValueOf(row[layer]) ?? 0) : 0;
  });
}

/**
 * computeThinmap on the branch canon vs map/snapshot-r0.json for `rows` × LAYERS; err = snapshot malformed. A missing
 * snapshot is never read as zeros: r0 null, nothing above it, all_targets_above false.
 */
export function compareSnapshot(
  round: string,
  now: ThinmapResult,
  snapshot: SnapshotR0,
  rows: readonly string[],
  targets: ReadonlyArray<{ row_id: string; layer: Layer }>,
): Result<ThinmapDelta> {
  const r0 = snapshot.state === 'present' ? snapshotValues(snapshot.value) : ok(null);
  if (!r0.ok) return r0;
  const baseline = r0.value;
  const nowOf = (rowId: string, layer: Layer): CellValue => now.cells.find((c) => c.rowId === rowId && c.layer === layer)?.value ?? 0;
  const isTarget = (rowId: string, layer: Layer): boolean => targets.some((t) => t.row_id === rowId && t.layer === layer);
  const out: ThinmapDeltaRow[] = [];
  for (const rowId of unique([...rows, ...targets.map((t) => t.row_id)])) {
    for (const layer of LAYERS) {
      const before = baseline === null ? null : baseline(rowId, layer);
      const after = nowOf(rowId, layer);
      out.push({ row_id: rowId, layer, r0: before, now: after, target: isTarget(rowId, layer), above_r0: before !== null && after > before });
    }
  }
  const targetRows = out.filter((r) => r.target);
  const allAbove = baseline !== null && targetRows.length > 0 && targetRows.every((r) => r.above_r0);
  return ok({ round, snapshot: snapshot.state, rows: out, all_targets_above: allAbove });
}

/** Round number % 3 === 0 (R03, R06, …); R00 never lists pages. */
export function wikiDue(round: string): boolean {
  const n = Number(ROUND_ID.exec(round)?.[1] ?? '0');
  return n > 0 && n % 3 === 0;
}

function markdownPages(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && /\.mdx?$/u.test(e.name)).map((e) => e.name).sort(byCodeUnit);
}

/** Pages under WIKI_WORLD_DIR (+ i18n twins) containing a term (primary / alias / Rxx) of a listed round. */
export function wikiPages(repo: string, rounds: ReadonlyArray<{ round: string; terms: readonly string[] }>): WikiPage[] {
  const docs = join(repo, 'wiki', 'src', 'content', 'docs');
  const names = markdownPages(join(repo, WIKI_WORLD_DIR));
  // An i18n twin is `docs/<locale>/world/<same name>`; the root locale is WIKI_WORLD_DIR itself.
  const locales = existsSync(docs) ? readdirSync(docs, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'world').map((e) => e.name).sort(byCodeUnit) : [];
  const files = names.flatMap((name) => [`${WIKI_WORLD_DIR}/${name}`, ...locales.map((l) => `wiki/src/content/docs/${l}/world/${name}`).filter((p) => existsSync(join(repo, p)))]);
  const out: WikiPage[] = [];
  for (const path of files) {
    const text = readFileSync(join(repo, path), 'utf8');
    const hits = rounds.map((r) => ({ round: r.round, terms: r.terms.filter((t) => t.trim() !== '' && text.includes(t.trim())) })).filter((r) => r.terms.length > 0);
    if (hits.length === 0) continue;
    out.push({ path, terms: unique(hits.flatMap((h) => h.terms)).sort(byCodeUnit), rounds: hits.map((h) => h.round) });
  }
  return out;
}

/** `chore: bookkeeping for RNN (#<issue>)`. */
export function bookkeepingCommitMessage(round: string, issue: number): string {
  return `chore: bookkeeping for ${round} (#${issue})`;
}

/** Repository-relative paths 11l commits (those that exist): rounds/RNN/, champions.json, map/tags.json, the pool, calibration/{labels,status}.json, benchmark/. */
export function bookkeepingPaths(ctx: StepContext): string[] {
  const forge = relative(ctx.repo, ctx.root).split(sep).join('/');
  const rels = [`rounds/${ctx.roundId}`, 'champions.json', TAGS_FILE, FORECAST_POOL_FILE, 'calibration/labels.json', 'calibration/status.json', 'benchmark'];
  return rels.filter((rel) => existsSync(join(ctx.root, rel))).map((rel) => (forge === '' ? rel : `${forge}/${rel}`));
}

function readTextOrNull(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** Forge-root-relative keys of the files that exist (inputs of a marker). */
function existing(ctx: StepContext, paths: readonly string[]): string[] {
  return paths.filter((p) => existsSync(p)).map((p) => ctx.files.rel(p));
}

/** The 07a remote check again (probe.ts remoteCheck semantics): port error → unavailable, no or another probe → mismatch. */
async function remoteRecheck(ctx: StepContext): Promise<RecheckFile['remote']> {
  const probe = readProbeFile(ctx.paths);
  const record = readProbeRecord(ctx.paths);
  const recorded = record !== null && record.ok ? record.value : null;
  if (!probe.ok || recorded === null) return 'mismatch';
  const listed = await ctx.ports.github.listComments(recorded.issue);
  if (!listed.ok) {
    ctx.log(`11a-unseal-publish: remote probe check unavailable: ${ctx.redact(listed.error)}`);
    return 'unavailable';
  }
  const match = matchProbeComment(listed.value, ctx.roundId, probe.value, (p) => isSupersededProbe(ctx, p));
  return match.kind === 'same' && match.comment.createdAt === recorded.created_at ? 'verified' : 'mismatch';
}

/**
 * 11a: copy `.sealed/RNN/{sealed.json,nonce.hex}` → `unsealed/` after verifySeal; remote recheck → recheck.json.
 * The remote check reruns only when 07a recorded `unavailable` (or unseal.json does not read); else 07a's value stands.
 * A missing or mismatching seal publishes nothing (reported, never a failure).
 */
export const unsealPublishStep: StepDef = {
  id: '11a-unseal-publish',
  run: async (ctx) => {
    const f = probeFiles(ctx.paths);
    const sealedText = readTextOrNull(f.sealed);
    const nonceText = readTextOrNull(f.nonce);
    const probe = readProbeFile(ctx.paths);
    let seal: RecheckFile['seal'] = 'missing';
    if (sealedText !== null && nonceText !== null) {
      const nonceHex = nonceText.endsWith('\n') ? nonceText.slice(0, -1) : nonceText;
      seal = probe.ok && verifySeal(sealedText, nonceHex, probe.value) ? 'verified' : 'mismatch';
    }
    const outputs: string[] = [];
    const dir = join(ctx.paths.dir, UNSEALED_DIR);
    if (seal === 'verified' && sealedText !== null && nonceText !== null) {
      outputs.push(ctx.files.writeText(join(dir, 'sealed.json'), sealedText), ctx.files.writeText(join(dir, 'nonce.hex'), nonceText));
    }
    const unsealed = readUnsealFile(ctx);
    const remote: UnsealFile['remote'] = unsealed.ok && unsealed.value.remote !== 'unavailable' ? unsealed.value.remote : await remoteRecheck(ctx);
    const file: RecheckFile = { round: ctx.roundId, seal, remote, published: outputs.length > 0, checked_at: ctx.ports.clock.now() };
    outputs.push(ctx.files.writeJson(join(ctx.paths.dir, RECHECK_FILE), file));
    ctx.progress('11a-unseal-publish', 'info', `seal ${seal}${file.published ? ', published' : ''}, remote ${remote}`);
    const inputs = existing(ctx, [f.probes, f.probe, f.sealed, f.nonce, join(ctx.paths.dir, 'unseal.json')]);
    return { kind: 'done', inputs, outputs, external: [] };
  },
};

/** `match-<sub>-<family>`; a submission key that makes no task id is an integrity error, not a crash. */
function matchTaskId(submission: string, family: Family, at: string): string {
  try {
    return surpriseTaskId('match', submission, family);
  } catch {
    throw new IntegrityError(`${at}: ${JSON.stringify(submission)} is not a submission id`);
  }
}

/**
 * surprise.json → PoolSurprise (null when absent). Each report's status, details[].forecasts and the sealed record of
 * every roles.matchers task listed in `tasks` (void or ok); `records` are those record paths (11b inputs).
 */
function readPoolSurprise(ctx: StepContext): { surprise: PoolSurprise | null; records: string[] } {
  const path = surprisePath(ctx);
  const rel = ctx.files.rel(path);
  if (!existsSync(path)) return { surprise: null, records: [] };
  const subs = readRecord(readJson(path), 'submissions');
  if (subs === null) throw new IntegrityError(`${rel}: expected { "submissions": { … } }`);
  const out: Record<string, PoolReport> = {};
  const records: string[] = [];
  for (const [id, report] of Object.entries(subs)) {
    const at = `${rel}: submissions.${id}`;
    const status = SURPRISE_STATUSES.find((st) => st === readString(report, 'status'));
    const tasks = stringArray(isRecord(report) ? report['tasks'] : null);
    const matchers = stringArray(readRecord(report, 'roles')?.['matchers'] ?? null);
    const families = (matchers ?? []).filter(isFamily);
    if (status === undefined || tasks === null || matchers === null || families.length !== matchers.length) {
      throw new IntegrityError(`${at} needs status, tasks and roles.matchers (families)`);
    }
    const matchStatus: Array<'ok' | 'void'> = [];
    for (const family of families) {
      const task = matchTaskId(id, family, at);
      if (!tasks.includes(task)) continue; // not run: insufficient roles or no detail
      const file = join(ctx.paths.sealedTasks, `${task}.json`);
      const record = readTaskRecord(file);
      if (record === null) throw new IntegrityError(`${at}: matcher task ${task} ran but ${ctx.files.rel(file)} is missing`);
      if (!record.ok || record.value.id !== task || record.value.family !== family) {
        throw new IntegrityError(`${at}: ${ctx.files.rel(file)}: ${record.ok ? `not the record of ${task}` : record.error}`);
      }
      matchStatus.push(record.value.status);
      records.push(file);
    }
    const details = readArray(report, 'details');
    if (details === null) throw new IntegrityError(`${at}.details must be an array`);
    const parsed: Array<{ forecasts: string[] }> = [];
    for (const d of details) {
      const forecasts = stringArray(isRecord(d) ? d['forecasts'] : null);
      if (forecasts === null) throw new IntegrityError(`${at}.details[].forecasts must be string arrays`);
      parsed.push({ forecasts });
    }
    out[id] = { status, match_status: matchStatus, details: parsed };
  }
  return { surprise: { submissions: out }, records };
}

/** 11b: append poolLines once (skip when lines for RNN exist) from the published `unsealed/sealed.json`. */
export const forecastPoolStep: StepDef = {
  id: '11b-forecast-pool',
  run: async (ctx) => {
    const pool = join(ctx.root, FORECAST_POOL_FILE);
    const lines = readRecords(pool);
    if (!lines.ok) throw new IntegrityError(`${FORECAST_POOL_FILE}: ${lines.error.replace(pool, FORECAST_POOL_FILE)}`);
    if (lines.value.some((l) => readString(l, 'round') === ctx.roundId)) return { kind: 'skip', reason: `${FORECAST_POOL_FILE} already holds ${ctx.roundId}` };
    const sealedPath = join(ctx.paths.dir, UNSEALED_DIR, 'sealed.json');
    const text = readTextOrNull(sealedPath);
    if (text === null) return { kind: 'skip', reason: 'no published seal (11a did not verify it)' };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new IntegrityError(`rounds/${ctx.roundId}/${UNSEALED_DIR}/sealed.json is not JSON`);
    }
    const sealed = parseSealedForecasts(raw);
    if (!sealed.ok) throw new IntegrityError(`rounds/${ctx.roundId}/${UNSEALED_DIR}/sealed.json: ${sealed.error}`);
    const surprise = readPoolSurprise(ctx);
    const out = poolLines(ctx.roundId, readBriefJson(ctx).row_id, sealed.value, surprise.surprise);
    if (out.length === 0) return { kind: 'skip', reason: 'the seal holds no forecast item' };
    ctx.files.appendLines(pool, out);
    const uncompared = out.filter((l) => l.surprise === null).length;
    ctx.progress('11b-forecast-pool', 'info', `${out.length} pool lines appended${uncompared > 0 ? `, ${uncompared} never compared by a working matcher` : ''}`);
    return { kind: 'done', inputs: existing(ctx, [sealedPath, surprisePath(ctx), ctx.paths.brief, ...surprise.records]), outputs: [], external: [] };
  },
};

function readRoundJson(ctx: StepContext, name: string): unknown {
  const rel = `rounds/${ctx.roundId}/${name}`;
  const path = join(ctx.paths.dir, name);
  if (!existsSync(path)) throw new IntegrityError(`${rel} is missing`);
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return v;
  } catch {
    throw new IntegrityError(`${rel} is not valid JSON`);
  }
}

/** tally.json champion pairs (label, submission, beats_champion, trial); the rest of RoundTally is not read here. */
function readTallyPairs(ctx: StepContext): TallyPairs {
  const list = readArray(readRoundJson(ctx, 'tally.json'), 'champion_pairs');
  if (list === null) throw new IntegrityError(`rounds/${ctx.roundId}/tally.json: champion_pairs must be an array`);
  const pairs: Array<Pick<ChampionPairResult, 'label' | 'submission' | 'beats_champion' | 'trial'>> = [];
  for (const p of list) {
    const label = readString(p, 'label');
    const submission = readString(p, 'submission');
    const beats = isRecord(p) ? p['beats_champion'] : undefined;
    const trial = isRecord(p) ? p['trial'] : undefined;
    if (label === null || submission === null || typeof beats !== 'boolean' || typeof trial !== 'boolean') {
      throw new IntegrityError(`rounds/${ctx.roundId}/tally.json: every champion pair needs label, submission, beats_champion and trial`);
    }
    pairs.push({ label, submission, beats_champion: beats, trial });
  }
  return { champion_pairs: pairs };
}

/** Submission id of a label (labels.json, label → id). */
function labelled(ctx: StepContext, label: string): string | null {
  return readString(readRoundJson(ctx, 'labels.json'), label);
}

/** 11c: setOwnerPickChampion (external champions.json); skip when pickChampion is null. */
export const championStep: StepDef = {
  id: '11c-champion',
  run: async (ctx) => {
    const decision = ctx.decision();
    if (decision.pick === 'none') return { kind: 'skip', reason: 'pick none' };
    const id = decision.pick_submission ?? labelled(ctx, decision.pick);
    const submission = id === null ? null : loadSubmission(ctx.paths, id);
    if (id === null || submission === null) throw new IntegrityError(`rounds/${ctx.roundId}: the picked submission ${decision.pick} does not load`);
    if (!isFamily(submission.family)) return { kind: 'skip', reason: `picked submission family ${submission.family} is not a judge family` };
    const rowId = readBriefJson(ctx).row_id;
    const champion = pickChampion({ round: ctx.roundId, rowId, decision, tally: readTallyPairs(ctx), submission, family: submission.family, at: ctx.ports.clock.now() });
    if (champion === null) return { kind: 'skip', reason: `pick ${decision.pick} did not beat the champion (or its pair was trial)` };
    const set = setOwnerPickChampion(ctx.files, champion);
    if (!set.ok) throw new IntegrityError(set.error);
    ctx.progress('11c-champion', 'info', `${rowId}: ${decision.pick} (${submission.id}) is the owner_pick champion (${set.value})`);
    const inputs = [ctx.files.rel(join(ctx.paths.dir, 'tally.json')), ctx.files.rel(join(ctx.paths.submissions, `${submission.id}.json`))];
    return { kind: 'done', inputs, outputs: [], external: ['champions.json'] };
  },
};

/** The committed merge of this round: `merge.json` → `merge/<current>/edit.json` scene and Rxx; null without merge.json. */
interface MergedScene {
  current: string;
  scene: string;
  rxx: string[];
  files: string[];
}

function mergedScene(ctx: StepContext): MergedScene | null {
  if (!existsSync(join(ctx.paths.dir, 'merge.json'))) return null;
  const pointer = readRoundJson(ctx, 'merge.json');
  const current = readString(pointer, 'current');
  if (current === null || !/^[0-9a-f]{8}$/u.test(current) || readString(pointer, 'status') !== 'merged_on_branch') {
    throw new IntegrityError(`rounds/${ctx.roundId}/merge.json: needs current (d8) and status merged_on_branch`);
  }
  const editRel = `merge/${current}/edit.json`;
  const edit = readRecord(readRoundJson(ctx, editRel), 'edit');
  const scene = readString(edit, 'scene');
  const rxx = stringArray(isRecord(edit) ? edit['rxx'] : null);
  if (scene === null || scene.trim() === '' || rxx === null) throw new IntegrityError(`rounds/${ctx.roundId}/${editRel}: edit.scene and edit.rxx are required`);
  return { current, scene, rxx, files: [join(ctx.paths.dir, 'merge.json'), join(ctx.paths.dir, editRel)] };
}

/** One Alias per touched row id: the first entry's kind and primary, every other name of the row as an alias. */
function aliasesFor(rowIds: readonly string[], all: readonly Alias[]): Alias[] {
  const out: Alias[] = [];
  for (const rowId of rowIds) {
    const first = all.find((a) => a.row_id === rowId);
    if (first === undefined) continue;
    const names = rowNames(rowId, all).filter((n) => n !== first.primary);
    out.push({ ...first, aliases: names });
  }
  return out;
}

/** Thin-map layer of a brief `layer` / cell layer (English id or Chinese label); null when it names none. */
function layerOf(value: string): Layer | null {
  return LAYERS.find((l) => l === value || LAYER_LABELS[l] === value) ?? null;
}

/** Target cells: the brief's (row, layer) plus every cell layer of the row that names a thin-map layer. */
function targetCells(brief: BriefJson): Array<{ row_id: string; layer: Layer }> {
  const layers = [brief.layer, ...brief.cell.layers].map(layerOf).filter((l): l is Layer => l !== null);
  return unique(layers).map((layer) => ({ row_id: brief.row_id, layer }));
}

/** Author families of the merged scene's sources: the base submission and every fact donor. */
function sourceAuthors(ctx: StepContext, decision: Decision): Family[] {
  const baseLabel = decision.base ?? decision.pick;
  const baseId = decision.base === null ? (decision.pick_submission ?? labelled(ctx, baseLabel)) : labelled(ctx, baseLabel);
  const ids = unique([...(baseId === null ? [] : [baseId]), ...decision.facts.map((f) => f.submission)]);
  return unique(ids.map((id) => loadSubmission(ctx.paths, id)?.family ?? '').filter(isFamily));
}

/** map/tags.json (null when absent: 11d creates it). */
function readTags(ctx: StepContext): unknown {
  const path = join(ctx.root, TAGS_FILE);
  if (!existsSync(path)) return null;
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return v;
  } catch {
    throw new IntegrityError(`${TAGS_FILE} is not valid JSON`);
  }
}

/** Branch canon (world/current, 09 included) with the new tags; connectivity and priorities are not reported, so no fact rows or game need. */
function thinmapNow(ctx: StepContext, tags: unknown): ThinmapResult {
  const rows = loadRows(ctx.root);
  if (!rows.ok) throw new IntegrityError(rows.error);
  const aliases = loadAliasFile(ctx.root);
  if (!aliases.ok) throw new IntegrityError(aliases.error);
  const canon = canonFiles(ctx.repo);
  return computeThinmap({ rows: rows.value, aliases: aliases.value, tags, canon, registered: parseRegister07(canon[REF_07] ?? ''), factRows: {}, gameNeed: {}, mentions: {} });
}

/**
 * 11d: tagger + reviewer → map/tags.json (external), tagging.json, thinmap-delta.json; skip without merge.json.
 * Tagger and reviewer are two seeded eligible families (`tag:<RNN>`, `tagreview:<RNN>`), neither an author of the
 * scene's sources. A void tagger or no reviewer keeps nothing; only `keep` verdicts reach map/tags.json.
 */
export const taggingStep: StepDef = {
  id: '11d-tagging',
  run: async (ctx) => {
    const merged = mergedScene(ctx);
    if (merged === null) return { kind: 'skip', reason: 'no merge.json (nothing merged this round)' };
    const decision = ctx.decision();
    const brief = readBriefJson(ctx);
    const all = loadRowAliases(ctx.root);
    if (!all.ok) throw new IntegrityError(all.error);
    const mapRows = loadRows(ctx.root);
    if (!mapRows.ok) throw new IntegrityError(mapRows.error);
    // map rows + character rows, as `forge thinmap` checks tags (cli.ts mapRows)
    const rowIds = unique([...mapRows.value.map((r) => r.row_id), ...all.value.filter((a) => a.kind === 'character').map((a) => a.row_id)]);
    const canon = canonFiles(ctx.repo);
    const registered = parseRegister07(canon[REF_07] ?? '').filter((f) => merged.rxx.includes(f.rxx)).map((f) => f.rowId);
    const touched = touchedRows([brief.row_id], registered, merged.scene, all.value).filter((id) => rowIds.includes(id));
    const seed = ctx.seed();
    const states = familyStates(ctx.freeze(), judgeFamilies(ctx));
    const pool = eligibleFamilies(states, [{ id: 'scene', authors: sourceAuthors(ctx, decision) }], 'measure');
    const tagger = pickFamilies(pool, 1, seed, `tag:${ctx.roundId}`)[0];
    if (tagger === undefined) return { kind: 'skip', reason: 'no eligible tagger family (every family authored a source or is unqualified)' };
    const reviewer = pickFamilies(pool.filter((f) => f !== tagger), 1, seed, `tagreview:${ctx.roundId}`)[0] ?? null;
    const tagSpec = tagTask(merged.scene, aliasesFor(touched, all.value), LAYERS, tagTaskId(ctx.roundId, tagger), seed);
    const tagged = await runTask(ctx, judgeBackend(ctx, tagger), tagSpec);
    const proposals = tagged.value ?? [];
    let reviews: TagReview[] = [];
    let reviewed: TaggingFile['reviewer'] = null;
    if (reviewer !== null && proposals.some((p) => p.quotes.length > 0)) {
      const spec = reviewTagTask(merged.scene, proposals, tagReviewTaskId(ctx.roundId, reviewer), seed);
      const r = await runTask(ctx, judgeBackend(ctx, reviewer), spec);
      reviews = r.value ?? [];
      reviewed = { family: reviewer, task: spec.id, status: r.value === null ? 'void' : 'ok' };
    }
    const kept: KeptTag[] = reviews.filter((r) => r.verdict === 'keep').map((r) => ({ row_id: r.row_id, layer: r.layer, quote: r.quote }));
    const tags = applyTags(readTags(ctx), kept, SCENES_KEY, rowIds);
    if (!tags.ok) throw new IntegrityError(tags.error);
    ctx.files.writeJson(join(ctx.root, TAGS_FILE), tags.value);
    const file: TaggingFile = {
      round: ctx.roundId, touched, tagger: { family: tagger, task: tagSpec.id, status: tagged.value === null ? 'void' : 'ok' }, reviewer: reviewed,
      proposals, reviews, kept, disputed: reviews.filter((r) => r.verdict === 'dispute'),
    };
    const snapshotPath = join(ctx.root, SNAPSHOT_R0_FILE);
    // never a zero baseline: without the file (F1-05 produces it) the delta records `snapshot: missing`
    const snapshot: SnapshotR0 = existsSync(snapshotPath) ? { state: 'present', value: readJson(snapshotPath) } : { state: 'missing' };
    const delta = compareSnapshot(ctx.roundId, thinmapNow(ctx, tags.value), snapshot, touched, targetCells(brief));
    if (!delta.ok) throw new IntegrityError(delta.error);
    const outputs = [ctx.files.writeJson(join(ctx.paths.dir, TAGGING_FILE), file), ctx.files.writeJson(join(ctx.paths.dir, THINMAP_DELTA_FILE), delta.value)];
    const above = delta.value.snapshot === 'missing' ? `no ${SNAPSHOT_R0_FILE}, nothing counts as above r0` : `all targets above r0: ${delta.value.all_targets_above}`;
    ctx.progress('11d-tagging', 'info', `${touched.length} rows touched, ${kept.length} quotes kept, ${file.disputed.length} disputed; ${above}`);
    const inputs = existing(ctx, [...merged.files, ctx.paths.brief, snapshotPath]);
    return { kind: 'done', inputs, outputs, external: [TAGS_FILE] };
  },
};

/** Rounds up to this one whose merge.json exists, last three in round order. */
function mergedRounds(ctx: StepContext): string[] {
  const dir = join(ctx.root, 'rounds');
  if (!existsSync(dir)) return [];
  const rounds = readdirSync(dir).filter((n) => ROUND_ID.test(n) && n.slice(0, 1) === ctx.roundId.slice(0, 1) && byCodeUnit(n, ctx.roundId) <= 0);
  return rounds.filter((n) => existsSync(join(dir, n, 'merge.json'))).sort(byCodeUnit).slice(-3);
}

/** Wiki terms of a merged round: names of its tagging.json touched rows plus its Rxx ids (from the committed edit). */
function roundTerms(ctx: StepContext, round: string, aliases: readonly Alias[]): string[] {
  const dir = join(ctx.root, 'rounds', round);
  const tagging = readJson(join(dir, TAGGING_FILE));
  const rows = stringArray(isRecord(tagging) ? tagging['touched'] : null) ?? [];
  const current = readString(readJson(join(dir, 'merge.json')), 'current');
  const edit = current === null ? null : readRecord(readJson(join(dir, 'merge', current, 'edit.json')), 'edit');
  const rxx = stringArray(isRecord(edit) ? edit['rxx'] : null) ?? [];
  return unique([...rows.flatMap((id) => rowNames(id, aliases)), ...rxx]);
}

/** Owner's publish answer of a round: this round's pinned decision, else the owner reader's current decision. */
function publishOf(ctx: StepContext, round: string): 'yes' | 'no' {
  if (round === ctx.roundId) return ctx.decision().publish;
  const read = ctx.owner.decision(round);
  return read.state === 'ok' ? read.value.publish : 'no';
}

/** 11k: wiki-pages.json when wikiDue(round), else skip; the engine never rewrites a page. */
export const wikiListStep: StepDef = {
  id: '11k-wiki',
  run: async (ctx) => {
    if (!wikiDue(ctx.roundId)) return { kind: 'skip', reason: `${ctx.roundId} is not a wiki round (every third round)` };
    const aliases = loadRowAliases(ctx.root);
    if (!aliases.ok) throw new IntegrityError(aliases.error);
    const rounds = mergedRounds(ctx);
    const publish: Record<string, 'yes' | 'no'> = {};
    for (const r of rounds) publish[r] = publishOf(ctx, r);
    const pages = wikiPages(ctx.repo, rounds.map((round) => ({ round, terms: roundTerms(ctx, round, aliases.value) })));
    const file: WikiPagesFile = { round: ctx.roundId, rounds, publish, pages };
    ctx.progress('11k-wiki', 'info', `${pages.length} wiki pages to review for ${rounds.join(', ') || 'no merged round'}`);
    return { kind: 'done', inputs: [], outputs: [ctx.files.writeJson(join(ctx.paths.dir, WIKI_PAGES_FILE), file)], external: [] };
  },
};

/** 11l: commit bookkeepingPaths + push (failure → blocked), then drainMirrors (never changes the outcome). */
export const bookkeepingCommitStep: StepDef = {
  id: '11l-commit',
  run: async (ctx): Promise<StepOutcome> => {
    const moved = await ensureRoundBranch(ctx);
    if (moved !== null) return { kind: 'blocked', detail: moved };
    const start = ctx.start();
    const committed = await ctx.ports.git.commit(bookkeepingPaths(ctx), bookkeepingCommitMessage(ctx.roundId, start.issue.number));
    if (!committed.ok) return { kind: 'blocked', detail: `git commit: ${ctx.redact(committed.error)}` };
    const pushed = await ctx.ports.git.push(start.branch);
    if (!pushed.ok) return { kind: 'blocked', detail: `git push ${start.branch}: ${ctx.redact(pushed.error)}` };
    try {
      const report = await drainMirrors(ctx);
      ctx.progress('11l-commit', 'info', `mirrors: ${report.posted} posted, ${report.failed} failed, ${report.rejected} rejected`);
    } catch (e) {
      ctx.progress('11l-commit', 'info', `mirror drain failed: ${message(e)}`);
    }
    return { kind: 'done', inputs: [], outputs: [], external: [] };
  },
};
