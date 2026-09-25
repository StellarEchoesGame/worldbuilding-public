import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCell } from '../brief.ts';
import type { StepContext } from '../context.ts';
import { canonFiles, factRowsFrom, parseRegister07 } from '../inputs.ts';
import { isRecord, readArray, readNumber, readString } from '../json.ts';
import type { Topic } from '../owner-inputs.ts';
import { err, ok, type Result } from '../result.ts';
import type { StepDef, StepOutcome } from '../runner.ts';
import { isIsoTimestamp } from '../store.ts';
import { IntegrityError } from '../task.ts';
import { computeThinmap, DEFAULT_GAME_NEED, LAYER_LABELS, LAYERS, parseGameNeed, type Layer } from '../thinmap.ts';
import { FACT_STATUS_FILE, loadAliasFile, loadRowAliases, loadRows, REF_07, rowNames } from './brief.ts';

/** Engine default after the offer has waited this long (fake clock in tests). */
export const TOPIC_AUTO_DELAY_MS = 86_400_000;

/** `rounds/RNN/topic-offer.json`, written once and reused on re-entry (the 24 h clock never restarts). */
export interface TopicOffer {
  round: string;
  offered_at: string;
  top3: Array<{ row_id: string; layer: string; priority: number }>;
}

const ROUND_ID = /^[A-Z]\d{2}$/u;

/** Every JSON file under `dir`, recursively, in name order. */
function jsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsonFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(path);
  }
  return out;
}

/** Strings under a `quote` key, and every string inside a `quotes` value (prototype `{q1: …}` and PR-B `{q: {quote}}` shapes). */
function collectQuotes(value: unknown, out: string[], inQuotes: boolean): void {
  if (typeof value === 'string') {
    if (inQuotes) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectQuotes(v, out, inQuotes);
  } else if (isRecord(value)) {
    for (const [key, v] of Object.entries(value)) {
      if (key === 'quote' && typeof v === 'string') out.push(v);
      else collectQuotes(v, out, inQuotes || key === 'quotes');
    }
  }
}

/** Alias / primary mentions (by row_id) in the previous round's taste quotes; {} without a previous round. */
export function aliasMentions(root: string, prevRound: string): Record<string, number> {
  if (!ROUND_ID.test(prevRound)) return {};
  const dir = join(root, 'rounds', prevRound, 'taste');
  if (!existsSync(dir)) return {};
  const aliases = loadRowAliases(root);
  if (!aliases.ok) return {};
  const quotes: string[] = [];
  for (const file of jsonFiles(dir)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
      collectQuotes(raw, quotes, false);
    } catch {
      // a torn taste file carries no quotes; its step's marker check reports it
    }
  }
  const out: Record<string, number> = {};
  for (const rowId of [...new Set(aliases.value.map((a) => a.row_id))]) {
    const names = rowNames(rowId, aliases.value);
    const n = quotes.filter((q) => names.some((name) => q.includes(name))).length;
    if (n > 0) out[rowId] = n;
  }
  return out;
}

/** The round before `roundId` (R01 → R00), or null for round 0. */
export function previousRound(roundId: string): string | null {
  const n = Number(roundId.slice(1));
  if (!ROUND_ID.test(roundId) || n < 1) return null;
  return `${roundId.slice(0, 1)}${String(n - 1).padStart(2, '0')}`;
}

function layerOf(value: string): Layer | null {
  return LAYERS.find((l) => l === value || LAYER_LABELS[l] === value) ?? null;
}

function readJson(path: string, rel: string): Result<unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return ok(v);
  } catch {
    return err(`${rel}: not valid JSON`);
  }
}

export function parseTopicOffer(value: unknown): Result<TopicOffer> {
  const round = readString(value, 'round');
  const offeredAt = readString(value, 'offered_at');
  const list = readArray(value, 'top3');
  if (round === null || offeredAt === null || !isIsoTimestamp(offeredAt) || list === null) return err('topic-offer.json: round, offered_at and top3 are required');
  const top3: TopicOffer['top3'] = [];
  for (const t of list) {
    const rowId = readString(t, 'row_id');
    const layer = readString(t, 'layer');
    const priority = readNumber(t, 'priority');
    if (rowId === null || layer === null || layerOf(layer) === null || priority === null) return err('topic-offer.json: every candidate needs row_id, layer and priority');
    top3.push({ row_id: rowId, layer, priority });
  }
  if (top3.length === 0 || top3.length > 3) return err('topic-offer.json: top3 must hold 1 to 3 candidates');
  return ok({ round, offered_at: offeredAt, top3 });
}

/** The top 3 thin-map cells (tags, canon, 07 §8 connectivity, game need, alias mentions of the previous round). */
export function offerTopics(ctx: StepContext): Result<TopicOffer['top3']> {
  const rows = loadRows(ctx.root);
  if (!rows.ok) return err(rows.error);
  const aliases = loadAliasFile(ctx.root);
  if (!aliases.ok) return err(aliases.error);
  const tags = readJson(join(ctx.root, 'map/tags.json'), 'map/tags.json');
  if (tags !== null && !tags.ok) return err(tags.error);
  const need = readJson(join(ctx.root, 'map/game-need.json'), 'map/game-need.json');
  if (need !== null && !need.ok) return err(need.error);
  const gameNeed = need === null ? ok(DEFAULT_GAME_NEED) : parseGameNeed(need.value);
  if (!gameNeed.ok) return err(`map/game-need.json: ${gameNeed.error}`);
  const status = readJson(join(ctx.root, FACT_STATUS_FILE), FACT_STATUS_FILE);
  if (status === null) return err(`${FACT_STATUS_FILE} missing`);
  const factRows = status.ok ? factRowsFrom(status.value) : status;
  if (!factRows.ok) return err(factRows.error);
  const canon = canonFiles(ctx.repo);
  const prev = previousRound(ctx.roundId);
  const result = computeThinmap({
    rows: rows.value,
    aliases: aliases.value,
    tags: tags === null ? { cells: {} } : tags.value,
    canon,
    registered: parseRegister07(canon[REF_07] ?? ''),
    factRows: factRows.value,
    gameNeed: gameNeed.value,
    mentions: prev === null ? {} : aliasMentions(ctx.root, prev),
  });
  const top = result.ranking.slice(0, 3).map((c) => ({ row_id: c.rowId, layer: c.layer, priority: c.priority }));
  return top.length === 0 ? err('thin map has no cells to offer') : ok(top);
}

function topicText(topic: Topic): string {
  return `${JSON.stringify(topic, null, 2)}\n`;
}

/** done with topic.json as input (UI-written owner file) or output (engine-written), plus the offer when one exists. */
function doneWith(ctx: StepContext, topic: Topic, offer: string | null, extraInputs: readonly string[]): StepOutcome {
  const rel = ctx.files.rel(ctx.paths.topic);
  const outputs = offer === null ? [] : [offer];
  if (topic.source === 'ui') return { kind: 'done', inputs: [rel, ...extraInputs], outputs, external: [] };
  return { kind: 'done', inputs: [...extraInputs], outputs: [...outputs, rel], external: [] };
}

/**
 * Exclusive create; when another writer (the UI) won, its topic is read back instead. The UI may not have appended
 * its owner-log line yet (state `repair`): WAIT owner_log_repair, like a topic.json found before the create.
 */
function createTopic(ctx: StepContext, topic: Topic, offer: string | null, extraInputs: readonly string[]): StepOutcome {
  if (ctx.files.createExclusive(ctx.paths.topic, topicText(topic))) return doneWith(ctx, topic, offer, extraInputs);
  const winner = ctx.owner.topic(ctx.roundId);
  if (winner.state === 'ok') return doneWith(ctx, winner.value, offer, extraInputs);
  if (winner.state === 'repair') return { kind: 'wait', waitingFor: 'owner_log_repair', detail: winner.detail, inputs: [], outputs: offer === null ? [] : [offer] };
  throw new IntegrityError(`rounds/${ctx.roundId}/topic.json appeared but does not read: ${winner.state === 'invalid' ? winner.error : winner.state}`);
}

/** Fixed round (`round start --cell`): the cell's row and its first thin-map layer, source fixed. */
function fixedTopic(ctx: StepContext, cellRel: string): Result<Topic> {
  const raw = readJson(join(ctx.root, cellRel), cellRel);
  if (raw === null) return err(`${cellRel} missing`);
  const cell = raw.ok ? parseCell(raw.value) : raw;
  if (!cell.ok) return err(`${cellRel}: ${cell.error}`);
  const layer = cell.value.layers.map(layerOf).find((l) => l !== null) ?? null;
  if (layer === null) return err(`${cellRel}: no layer names a thin-map layer`);
  return ok({ round: ctx.roundId, row_id: cell.value.rowId, layer, cell: cellRel, source: 'fixed', chosen_at: ctx.ports.clock.now() });
}

/** The pending offer (re-entry after WAIT, or a crash after writing it), else a new one stamped now. */
function currentOffer(ctx: StepContext, path: string): Result<TopicOffer> {
  const rel = ctx.files.rel(path);
  const existing = readJson(path, rel);
  if (existing !== null) {
    const parsed = existing.ok ? parseTopicOffer(existing.value) : existing;
    if (!parsed.ok) throw new IntegrityError(parsed.error);
    if (parsed.value.round !== ctx.roundId) throw new IntegrityError(`${rel}: round mismatch`);
    return parsed;
  }
  const top3 = offerTopics(ctx);
  if (!top3.ok) return err(top3.error);
  const offer: TopicOffer = { round: ctx.roundId, offered_at: ctx.ports.clock.now(), top3: top3.value };
  ctx.files.writeJson(path, offer);
  return ok(offer);
}

/** 01-topic: offer, WAIT topic < 24 h, auto_default ≥ 24 h (exclusive create), fixed for `--cell`. */
export const topicStep: StepDef = {
  id: '01-topic',
  run: async (ctx) => {
    const offerPath = join(ctx.paths.dir, 'topic-offer.json');
    const offerRel = existsSync(offerPath) ? ctx.files.rel(offerPath) : null;
    const cellRel = ctx.start().cell;
    const cellInputs = cellRel === null ? [] : [cellRel];
    const existing = ctx.owner.topic(ctx.roundId);
    if (existing.state === 'repair') return { kind: 'wait', waitingFor: 'owner_log_repair', detail: existing.detail, inputs: [], outputs: offerRel === null ? [] : [offerRel] };
    if (existing.state === 'invalid' || existing.state === 'superseded') throw new IntegrityError(existing.state === 'invalid' ? existing.error : 'topic.json superseded');
    if (existing.state === 'ok') return doneWith(ctx, existing.value, offerRel, cellInputs);
    if (cellRel !== null) {
      const fixed = fixedTopic(ctx, cellRel);
      if (!fixed.ok) return { kind: 'failed', detail: fixed.error };
      return createTopic(ctx, fixed.value, offerRel, cellInputs);
    }
    const offer = currentOffer(ctx, offerPath);
    if (!offer.ok) return { kind: 'failed', detail: offer.error };
    const rel = ctx.files.rel(offerPath);
    const waited = Date.parse(ctx.ports.clock.now()) - Date.parse(offer.value.offered_at);
    const first = offer.value.top3[0];
    if (waited >= TOPIC_AUTO_DELAY_MS && first !== undefined) {
      const auto: Topic = { round: ctx.roundId, row_id: first.row_id, layer: first.layer, cell: null, source: 'auto_default', chosen_at: ctx.ports.clock.now() };
      return createTopic(ctx, auto, rel, []);
    }
    const autoAt = new Date(Date.parse(offer.value.offered_at) + TOPIC_AUTO_DELAY_MS).toISOString();
    const names = offer.value.top3.map((t) => `${t.row_id}·${LAYER_LABELS[layerOf(t.layer) ?? 'object']}`).join('、');
    return { kind: 'wait', waitingFor: 'topic', detail: `选题待 owner 决定（候选：${names}）；${autoAt} 起引擎自动取第一项`, inputs: [], outputs: [rel] };
  },
};
