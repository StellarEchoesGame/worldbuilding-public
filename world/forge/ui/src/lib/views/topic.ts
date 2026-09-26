import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord, readRecord, readString, stringArray } from '../../../../engine/json.ts';
import { ownerInputs, type TopicSource } from '../../../../engine/owner-inputs.ts';
import { loadAliasFile, loadRows } from '../../../../engine/steps/brief.ts';
import { parseTopicOffer, previousRound, thinmapFor, TOPIC_AUTO_DELAY_MS } from '../../../../engine/steps/topic.ts';
import { DEFAULT_GAME_NEED, LAYER_LABELS, LAYERS, parseGameNeed, type AliasKind, type CellValue, type Layer } from '../../../../engine/thinmap.ts';
import { redactRoot } from '../data.ts';
import { GAME_NEED_FILE } from '../game-need.ts';

export interface HeatCell {
  layer: Layer;
  value: CellValue;
  priority: number;
}

/** One row of the 选题 heat map (map/rows.json order), with its game-need weight and 连接度. */
export interface HeatRow {
  rowId: string;
  primary: string;
  /** map/rows.json kind, or character for a P- row of map/aliases.json. */
  kind: AliasKind;
  gameNeed: number;
  connectivity: number;
  cells: HeatCell[];
}

export interface Heatmap {
  layers: Array<{ id: Layer; label: string }>;
  rows: HeatRow[];
  /** map/tags.json exists (else every value is 0 and only game need orders the cells). */
  tagged: boolean;
  /** Unreadable inputs (rows, aliases, tags, game need, fact-status); the map is empty when any is set. */
  errors: string[];
}

export interface TopicCandidate {
  row_id: string;
  layer: string;
  layerLabel: string;
  priority: number;
}

export interface TopicPageView {
  round: string;
  heatmap: Heatmap;
  /** rounds/RNN/topic-offer.json; `autoAt` = offered_at + TOPIC_AUTO_DELAY_MS. */
  offer: { offeredAt: string; autoAt: string; top3: TopicCandidate[] } | null;
  offerError: string | null;
  /** rounds/RNN/topic.json (any source); non-null → the page is read-only. */
  topic: { row_id: string; layer: string; cell: string | null; source: TopicSource; chosenAt: string } | null;
  /** topic.json exists but the owner-log reader does not accept it (repair / invalid); the page stays read-only. */
  topicProblem: string | null;
  /** Round number divisible by 4 (the first wild round is R04); display only in F1-04. */
  wildRound: boolean;
  /** Earlier rounds' wild-seeds.json (submission id → 3 seed lines), newest round first; no author models. */
  wildSeeds: Array<{ round: string; submission: string; seeds: string[] }>;
  /** wild-seeds.json files present but not of the expected shape (entries of the wrong shape are not shown); null when all read. */
  wildSeedsError: string | null;
  gameNeed: GameNeedState;
}

export interface GameNeedState {
  /** map/game-need.json exists (the editor is one-time: shown only while false). */
  exists: boolean;
  /** The file's weights, else DEFAULT_GAME_NEED. */
  weights: Record<string, number>;
  error: string | null;
}


const ROUND_ID = /^[A-Z]\d{2}$/u;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function layerOf(value: string): Layer | null {
  return LAYERS.find((l) => l === value || LAYER_LABELS[l] === value) ?? null;
}

/** Chinese label of a thin-map layer id (or of a label already); unknown values unchanged. */
export function layerLabel(value: string): string {
  const layer = layerOf(value);
  return layer === null ? value : LAYER_LABELS[layer];
}

/** Parsed JSON, or an error string for a present file that is not JSON; null when absent. */
function readFile(path: string, rel: string): { ok: true; value: unknown } | { ok: false; error: string } | null {
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return { ok: true, value };
  } catch {
    return { ok: false, error: `${rel}: not valid JSON` };
  }
}

function roundIds(root: string): string[] {
  const dir = join(root, 'rounds');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((id) => ROUND_ID.test(id)).sort(byCodeUnit);
}

export function gameNeedState(root: string): GameNeedState {
  const file = readFile(join(root, GAME_NEED_FILE), GAME_NEED_FILE);
  if (file === null) return { exists: false, weights: { ...DEFAULT_GAME_NEED }, error: null };
  const parsed = file.ok ? parseGameNeed(file.value) : file;
  if (!parsed.ok) return { exists: true, weights: { ...DEFAULT_GAME_NEED }, error: parsed.error.startsWith(GAME_NEED_FILE) ? parsed.error : `${GAME_NEED_FILE}: ${parsed.error}` };
  return { exists: true, weights: parsed.value, error: null };
}

/** Primary name and kind per row id: map/rows.json rows, then map/aliases.json characters. */
function rowInfo(root: string): Map<string, { primary: string; kind: AliasKind }> {
  const out = new Map<string, { primary: string; kind: AliasKind }>();
  const rows = loadRows(root);
  if (rows.ok) for (const r of rows.value) out.set(r.row_id, { primary: r.primary, kind: r.kind });
  const aliases = loadAliasFile(root);
  if (aliases.ok) for (const a of aliases.value) if (!out.has(a.row_id)) out.set(a.row_id, { primary: a.primary, kind: a.kind });
  return out;
}

/** Canon directories engine/inputs.ts canonFiles lists (it throws when one is absent; the engine steps rely on that). */
const CANON_DIRS: readonly string[] = ['world/current', 'world/current/reference'];

/**
 * Thin map over `root` (forge) and `repo` (canon); mentions from `mentionsRound`'s taste quotes (null → none). A data
 * copy (FORGE_DATA_DIR) without its sibling canon gets an error and an empty map instead of a thrown ENOENT.
 */
export function heatmap(root: string, repo: string, mentionsRound: string | null): Heatmap {
  const layers = LAYERS.map((id) => ({ id, label: LAYER_LABELS[id] }));
  const tagged = existsSync(join(root, 'map', 'tags.json'));
  const missing = CANON_DIRS.find((d) => statSync(join(repo, d), { throwIfNoEntry: false })?.isDirectory() !== true);
  if (missing !== undefined) return { layers, rows: [], tagged, errors: [`正典目录 ${missing} 不存在（数据目录旁边没有正典），无法计算热力图。`] };
  const result = thinmapFor(root, repo, mentionsRound);
  if (!result.ok) return { layers, rows: [], tagged, errors: [result.error] };
  const weights = gameNeedState(root).weights;
  const info = rowInfo(root);
  const rows: HeatRow[] = result.value.rows.map((rowId) => {
    const fallback: { primary: string; kind: AliasKind } = { primary: rowId, kind: 'character' };
    const meta = info.get(rowId) ?? fallback;
    const cells: HeatCell[] = [];
    for (const layer of LAYERS) {
      const cell = result.value.cells.find((c) => c.rowId === rowId && c.layer === layer);
      if (cell !== undefined) cells.push({ layer, value: cell.value, priority: cell.priority });
    }
    return {
      rowId,
      primary: meta.primary,
      kind: meta.kind,
      gameNeed: Object.hasOwn(weights, rowId) ? (weights[rowId] ?? 1) : 1,
      connectivity: Object.hasOwn(result.value.connectivity, rowId) ? (result.value.connectivity[rowId] ?? 0) : 0,
      cells,
    };
  });
  return { layers, rows, tagged, errors: [] };
}

function readOffer(dir: string, roundId: string): { offer: TopicPageView['offer']; error: string | null } {
  const rel = `rounds/${roundId}/topic-offer.json`;
  const file = readFile(join(dir, 'topic-offer.json'), rel);
  if (file === null) return { offer: null, error: null };
  const parsed = file.ok ? parseTopicOffer(file.value) : file;
  if (!parsed.ok) return { offer: null, error: parsed.error };
  if (parsed.value.round !== roundId) return { offer: null, error: `${rel}: round mismatch` };
  const offeredAt = parsed.value.offered_at;
  return {
    offer: {
      offeredAt,
      autoAt: new Date(Date.parse(offeredAt) + TOPIC_AUTO_DELAY_MS).toISOString(),
      top3: parsed.value.top3.map((t) => ({ row_id: t.row_id, layer: t.layer, layerLabel: layerLabel(t.layer), priority: t.priority })),
    },
    error: null,
  };
}

function isTopicSource(value: string | null): value is TopicSource {
  return value === 'ui' || value === 'auto_default' || value === 'fixed';
}

/** topic.json through the owner-log reader; a present file it does not accept is shown leniently with the problem. */
function readTopic(root: string, dir: string, roundId: string): { topic: TopicPageView['topic']; problem: string | null } {
  const read = ownerInputs(root).topic(roundId);
  if (read.state === 'missing') return { topic: null, problem: null };
  if (read.state === 'ok') {
    const t = read.value;
    return { topic: { row_id: t.row_id, layer: t.layer, cell: t.cell, source: t.source, chosenAt: t.chosen_at }, problem: null };
  }
  const problem = redactRoot(read.state === 'repair' ? `owner 日志需要修复：${read.detail}` : read.state === 'invalid' ? read.error : '选题文件已被取代', root);
  const raw = readFile(join(dir, 'topic.json'), 'topic.json');
  const value = raw !== null && raw.ok ? raw.value : null;
  const rowId = readString(value, 'row_id');
  const layer = readString(value, 'layer');
  const source = readString(value, 'source');
  const chosenAt = readString(value, 'chosen_at') ?? '';
  if (rowId === null || layer === null || !isTopicSource(source)) return { topic: null, problem };
  return { topic: { row_id: rowId, layer, cell: readString(value, 'cell'), source, chosenAt }, problem };
}

/**
 * Earlier rounds' wild-seeds.json, newest round first, submissions in code-unit order. No engine reader or schema
 * exists yet (wild rounds start at R04): a present file whose shape is not `{seeds: {submission: [line, …]}}` is
 * reported in `error` (its well-formed entries still show).
 */
function wildSeeds(root: string, roundId: string): { seeds: TopicPageView['wildSeeds']; error: string | null } {
  const out: TopicPageView['wildSeeds'] = [];
  const bad: string[] = [];
  for (const round of roundIds(root).filter((id) => byCodeUnit(id, roundId) < 0).reverse()) {
    const rel = `rounds/${round}/wild-seeds.json`;
    const file = readFile(join(root, rel), rel);
    if (file === null) continue;
    const seeds = file.ok ? readRecord(file.value, 'seeds') : null;
    let malformed = seeds === null;
    for (const submission of seeds === null ? [] : Object.keys(seeds).sort(byCodeUnit)) {
      const lines = isRecord(seeds) ? stringArray(seeds[submission]) : null;
      if (lines === null) malformed = true;
      else out.push({ round, submission, seeds: lines });
    }
    if (malformed) bad.push(rel);
  }
  const error = bad.length === 0 ? null : `${bad.join('、')} 的格式不是预期的 {"seeds": {投稿编号: [种子行, …]}}，格式不对的种子没有显示。`;
  return { seeds: out, error };
}

/** The 选题 page of one round; null when the round directory does not exist. */
export function topicView(root: string, repo: string, roundId: string): TopicPageView | null {
  if (!ROUND_ID.test(roundId)) return null;
  const dir = join(root, 'rounds', roundId);
  if (!existsSync(dir)) return null;
  const offer = readOffer(dir, roundId);
  const topic = readTopic(root, dir, roundId);
  const wild = wildSeeds(root, roundId);
  const n = Number(roundId.slice(1));
  return {
    round: roundId,
    heatmap: heatmap(root, repo, previousRound(roundId)),
    offer: offer.offer,
    offerError: offer.error,
    topic: topic.topic,
    topicProblem: topic.problem,
    wildRound: n > 0 && n % 4 === 0,
    wildSeeds: wild.seeds,
    wildSeedsError: wild.error,
    gameNeed: gameNeedState(root),
  };
}

/** Rounds with a topic-offer.json or a topic.json (fixed rounds have no offer), newest first (the /topic index). */
export function topicRounds(root: string): Array<{ round: string; offered: boolean; chosen: boolean }> {
  const out: Array<{ round: string; offered: boolean; chosen: boolean }> = [];
  for (const round of roundIds(root).reverse()) {
    const offered = existsSync(join(root, 'rounds', round, 'topic-offer.json'));
    const chosen = existsSync(join(root, 'rounds', round, 'topic.json'));
    if (offered || chosen) out.push({ round, offered, chosen });
  }
  return out;
}

/** map/rows.json rows for the one-time game-need editor (its keys must be row ids of this file). */
export function gameNeedRows(root: string): { rows: Array<{ rowId: string; primary: string; system: string }>; error: string | null } {
  const rows = loadRows(root);
  if (!rows.ok) return { rows: [], error: rows.error };
  return { rows: rows.value.map((r) => ({ rowId: r.row_id, primary: r.primary, system: r.system })), error: null };
}

/** The newest `R\d\d` round directory (its taste quotes weight the next round's heat map), or null. */
export function latestRound(root: string): string | null {
  return roundIds(root).filter((id) => id.startsWith('R')).at(-1) ?? null;
}
