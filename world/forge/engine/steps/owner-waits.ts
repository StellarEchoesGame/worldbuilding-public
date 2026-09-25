import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StepContext } from '../context.ts';
import { isRecord, readArray, readString } from '../json.ts';
import type { Marker } from '../marker.ts';
import { ANCHOR_IDS, pairsFilePath, readPairsFile, type PairEntry, type PairKind } from '../pairs.ts';
import type { StepDef, StepOutcome } from '../runner.ts';
import { seededSplit } from '../split.ts';
import { seeded, seededShuffle } from '../store.ts';
import { CHAMPION_ID } from '../submission.ts';
import { IntegrityError } from '../task.ts';
import { isOneOf } from '../tasks/fenced.ts';
import { auditPairId } from '../tasks/ids.ts';

/** Blind-audit pairs per round (epic 9a). */
export const AUDIT_PAIRS = 4;

/**
 * One `audit-set.json` pair. `left` / `right` are display ids: labels.json labels for submissions, CHAMPION_ID
 * (`BASE`), ANCHOR_IDS; never slot ids or the decoy. `split` + `label` are written before any answer (the UI
 * ignores them); `label` = the blind-label id in `calibration/labels.json`.
 */
export interface AuditSetPair {
  /** tasks/ids.ts auditPairId: `<RNN>-audit-<k>`. */
  id: string;
  left: string;
  right: string;
  kind: PairKind;
  /** seededSplit(pair ids, freeze seed, 'labels:split', calibration.audit_visible). */
  split: 'visible' | 'reserve';
  /** `<RNN>-audit-<k>` (same as id). */
  label: string;
  /** The judged pair it was drawn from (pairs.json / taste/aux/pairs.json id), for the trust ledger. */
  pair: string;
}

/** `rounds/RNN/audit-set.json`. */
export interface AuditSetFile {
  round: string;
  pairs: AuditSetPair[];
  created_at: string;
}

const PAIR_KINDS: readonly PairKind[] = ['champion', 'sub_sub', 'anchor'];
const SPLITS: readonly ('visible' | 'reserve')[] = ['visible', 'reserve'];
const PAIR_FILES: readonly ('champion' | 'aux')[] = ['champion', 'aux'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Every pair judged this round: champion pairs (`pairs.json`) and aux pairs (`taste/aux/pairs.json`, absent when 06c skipped). */
function judgedPairs(ctx: StepContext): { pairs: PairEntry[]; inputs: string[] } {
  const pairs: PairEntry[] = [];
  const inputs: string[] = [];
  for (const which of PAIR_FILES) {
    const path = pairsFilePath(ctx.paths, which);
    if (which === 'aux' && !existsSync(path)) continue;
    const read = readPairsFile(ctx.paths, which);
    if (!read.ok) throw new IntegrityError(read.error);
    inputs.push(ctx.files.rel(path));
    pairs.push(...read.value.pairs.filter((p) => p.families.length + p.shadow.length > 0));
  }
  return { pairs, inputs };
}

function readJsonFile(ctx: StepContext, path: string): unknown {
  const rel = ctx.files.rel(path);
  if (!existsSync(path)) throw new IntegrityError(`${rel} is missing`);
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return value;
  } catch {
    throw new IntegrityError(`${rel} is not JSON`);
  }
}

/** Submission id → the 08 label (`labels.json` maps label → id). */
function labelsById(ctx: StepContext, path: string): Map<string, string> {
  const raw = readJsonFile(ctx, path);
  if (!isRecord(raw)) throw new IntegrityError(`${ctx.files.rel(path)}: expected an object`);
  const out = new Map<string, string>();
  for (const [label, id] of Object.entries(raw)) {
    if (typeof id !== 'string') throw new IntegrityError(`${ctx.files.rel(path)}: label ${label} does not name a submission`);
    out.set(id, label);
  }
  return out;
}

/** The id the owner sees: the 08 label of a submission, CHAMPION_ID, or an anchor id; never a slot id or the decoy. */
function displayId(id: string, labels: ReadonlyMap<string, string>): string {
  if (id === CHAMPION_ID || ANCHOR_IDS.includes(id)) return id;
  const label = labels.get(id);
  if (label === undefined) throw new IntegrityError(`labels.json names no label for judged text ${id}`);
  return label;
}

/**
 * AUDIT_PAIRS pairs drawn from every judged pair (sorted ids, seededShuffle key `audit:<round>`), sides swapped by
 * seed (key `auditpos:<pair>`), ids / labels `<RNN>-audit-<k>` in draw order, split by seededSplit(ids, seed,
 * 'labels:split', calibration.audit_visible).
 */
export function buildAuditSet(round: string, seed: string, pairs: readonly PairEntry[], labels: ReadonlyMap<string, string>, visible: number, createdAt: string): AuditSetFile {
  const byId = new Map(pairs.map((p) => [p.id, p]));
  if (byId.size !== pairs.length) throw new IntegrityError('a judged pair id occurs twice across pairs.json and taste/aux/pairs.json');
  const drawn = seededShuffle([...byId.keys()].sort(byCodeUnit), seed, `audit:${round}`).slice(0, AUDIT_PAIRS);
  const ids = drawn.map((_, i) => auditPairId(round, i + 1));
  const split = seededSplit(ids, seed, 'labels:split', visible);
  const out: AuditSetPair[] = [];
  for (const [i, pairId] of drawn.entries()) {
    const p = byId.get(pairId);
    const id = ids[i];
    if (p === undefined || id === undefined) continue;
    const swap = seeded(seed, `auditpos:${pairId}`) < 0.5;
    const [left, right] = swap ? [p.right, p.left] : [p.left, p.right];
    out.push({ id, left: displayId(left, labels), right: displayId(right, labels), kind: p.kind, split: split[id] ?? 'reserve', label: id, pair: pairId });
  }
  return { round, pairs: out, created_at: createdAt };
}

/** `audit-set.json` as written by 09a; null when it does not have that shape. */
export function parseAuditSet(value: unknown): AuditSetFile | null {
  const round = readString(value, 'round');
  const createdAt = readString(value, 'created_at');
  const raw = readArray(value, 'pairs');
  if (round === null || createdAt === null || !ISO.test(createdAt) || raw === null || raw.length === 0 || raw.length > AUDIT_PAIRS) return null;
  const pairs: AuditSetPair[] = [];
  for (const p of raw) {
    const id = readString(p, 'id');
    const left = readString(p, 'left');
    const right = readString(p, 'right');
    const kind = readString(p, 'kind');
    const split = readString(p, 'split');
    const label = readString(p, 'label');
    const pair = readString(p, 'pair');
    if (id === null || left === null || right === null || label === null || pair === null) return null;
    if (kind === null || !isOneOf(kind, PAIR_KINDS) || split === null || !isOneOf(split, SPLITS)) return null;
    pairs.push({ id, left, right, kind, split, label, pair });
  }
  return { round, pairs, created_at: createdAt };
}

/**
 * The round's audit set: the file a waiting 09a marker lists (re-entry: never redrawn), else the fresh draw. An
 * existing file with the same pairs (crash before the marker) is kept, so its bytes and created_at never move; a
 * different one is replaced only while no audit.json answers it.
 */
function currentAuditSet(ctx: StepContext, path: string, pending: Marker | null, draw: () => AuditSetFile): AuditSetFile {
  const rel = ctx.files.rel(path);
  const existing = existsSync(path) ? parseAuditSet(readJsonFile(ctx, path)) : null;
  if (pending !== null && Object.hasOwn(pending.outputs, rel)) {
    if (existing === null || existing.round !== ctx.roundId) throw new IntegrityError(`${rel}: listed by the waiting 09a marker but does not read`);
    return existing;
  }
  const fresh = draw();
  if (existing !== null && existing.round === ctx.roundId && JSON.stringify(existing.pairs) === JSON.stringify(fresh.pairs)) return existing;
  if (existsSync(join(ctx.paths.dir, 'audit.json'))) throw new IntegrityError(`${rel} would change under an answered audit.json`);
  ctx.files.writeJson(path, fresh);
  return fresh;
}

/**
 * 09a-audit: engine half first — AUDIT_PAIRS pairs seeded from every pair judged this round (champion, sub–sub,
 * anchor), positions shuffled, split and label set → `audit-set.json`; then owner.audit(round): missing → WAIT
 * `audit` (outputs = audit-set.json, re-entry reuses it); repair → WAIT `owner_log_repair`; ok → done with the
 * audit.json hash in inputs; invalid → integrity (exit 3).
 */
export const auditStep: StepDef = {
  id: '09a-audit',
  run: async (ctx, pending) => {
    const labelsPath = join(ctx.paths.dir, 'labels.json');
    const setPath = join(ctx.paths.dir, 'audit-set.json');
    const judged = judgedPairs(ctx);
    if (judged.pairs.length === 0) return { kind: 'failed', detail: 'no judged pair to draw the blind audit from' };
    const labels = labelsById(ctx, labelsPath);
    const set = currentAuditSet(ctx, setPath, pending, () =>
      buildAuditSet(ctx.roundId, ctx.seed(), judged.pairs, labels, ctx.protocol.calibration.auditVisible, ctx.ports.clock.now()),
    );
    const inputs = [...judged.inputs, ctx.files.rel(labelsPath)].sort(byCodeUnit);
    const outputs = [ctx.files.rel(setPath)];
    const audit = ctx.owner.audit(ctx.roundId);
    switch (audit.state) {
      case 'ok':
        return { kind: 'done', inputs: [...inputs, ctx.files.rel(join(ctx.paths.dir, 'audit.json'))].sort(byCodeUnit), outputs, external: [] };
      case 'missing':
        return { kind: 'wait', waitingFor: 'audit', detail: `盲审待 owner 完成（${set.pairs.length} 对，只看文字）`, inputs, outputs };
      case 'repair':
        return { kind: 'wait', waitingFor: 'owner_log_repair', detail: audit.detail, inputs, outputs };
      case 'invalid':
        throw new IntegrityError(audit.error);
      case 'superseded':
        throw new IntegrityError(`rounds/${ctx.roundId}/audit.json: superseded`);
    }
  },
};

function waitDecision(detail: string): StepOutcome {
  return { kind: 'wait', waitingFor: 'decision', detail, inputs: [], outputs: [] };
}

/**
 * 09b-decision: owner.decision(round): missing or superseded → WAIT `decision`; repair → WAIT `owner_log_repair`;
 * ok → done with the decision file's hash in inputs (the pin ctx.decision() reads); invalid → integrity (exit 3).
 */
export const decisionStep: StepDef = {
  id: '09b-decision',
  run: async (ctx) => {
    const decision = ctx.owner.decision(ctx.roundId);
    switch (decision.state) {
      case 'ok':
        return { kind: 'done', inputs: [ctx.files.rel(join(ctx.root, decision.value.file))], outputs: [], external: [] };
      case 'missing':
        return waitDecision('决策待 owner 在决策页提交');
      case 'superseded':
        return waitDecision(`当前决策（${decision.sha256.slice(0, 12)}）的过门记录未通过，待 owner 追加新的决策`);
      case 'repair':
        return { kind: 'wait', waitingFor: 'owner_log_repair', detail: decision.detail, inputs: [], outputs: [] };
      case 'invalid':
        throw new IntegrityError(decision.error);
    }
  },
};
