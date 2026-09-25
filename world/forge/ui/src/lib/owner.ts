import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAMPION_ID, submissionFor } from '../../../engine/round.ts';
import { isRecord, readArray, readString } from '../../../engine/json.ts';
import { appendLine, readJson, roundPaths, sha256, writeJson } from '../../../engine/store.ts';

export type OwnerResult = { ok: true; file: string } | { ok: false; status: 400 | 404 | 409; error: string };

export const REASONS = ['平', '假', '乱', '偏'];

export interface AuditPair {
  id: string;
  left: string;
  right: string;
}

export interface DecisionInput {
  pick: string;
  reason: string;
  fav: string;
  publish: string;
  happened?: string;
  facts: string[];
}

export function readLabels(root: string, roundId: string): Record<string, string> {
  const raw = readJson(join(roundPaths(root, roundId).dir, 'labels.json'));
  const out: Record<string, string> = {};
  if (isRecord(raw)) for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v;
  return out;
}

export function readAuditSet(root: string, roundId: string): AuditPair[] {
  const raw = readJson(join(roundPaths(root, roundId).dir, 'audit-set.json'));
  const out: AuditPair[] = [];
  for (const p of readArray(raw, 'pairs') ?? []) {
    const id = readString(p, 'id');
    const left = readString(p, 'left');
    const right = readString(p, 'right');
    if (id !== null && left !== null && right !== null) out.push({ id, left, right });
  }
  return out;
}

function logOwner(root: string, action: string, roundId: string, file: string, now: string): void {
  appendLine(join(root, 'owner-log.jsonl'), { at: now, action, round: roundId, file: file.slice(root.length + 1), sha256: sha256(readFileSync(file, 'utf8')), source: 'ui' });
}

export function submitAudit(root: string, roundId: string, answers: Record<string, string>, now: string): OwnerResult {
  const paths = roundPaths(root, roundId);
  const file = join(paths.dir, 'audit.json');
  if (existsSync(file)) return { ok: false, status: 409, error: '这一轮的盲审已经提交过，不能覆盖。' };
  const pairs = readAuditSet(root, roundId);
  if (pairs.length === 0) return { ok: false, status: 404, error: '这一轮还没有盲审对。' };
  const out: Array<{ pair: string; left: string; right: string; choice: string; chosen: string }> = [];
  for (const p of pairs) {
    const choice = answers[p.id];
    if (choice !== 'left' && choice !== 'right') return { ok: false, status: 400, error: `第 ${p.id} 对还没有选择。` };
    out.push({ pair: p.id, left: p.left, right: p.right, choice, chosen: choice === 'left' ? p.left : p.right });
  }
  writeJson(file, { round: roundId, answers: out, source: 'ui', answered_at: now });
  logOwner(root, 'audit', roundId, file, now);
  return { ok: true, file };
}

export function submitDecision(root: string, roundId: string, input: DecisionInput, now: string): OwnerResult {
  const paths = roundPaths(root, roundId);
  const file = join(paths.dir, 'decision.json');
  if (!existsSync(join(paths.dir, 'audit.json'))) return { ok: false, status: 409, error: '请先完成盲审。' };
  if (existsSync(file)) return { ok: false, status: 409, error: '这一轮已经做过决定，不能覆盖。' };
  const labels = readLabels(root, roundId);
  const choices = [...Object.keys(labels), 'none'];
  if (!choices.includes(input.pick)) return { ok: false, status: 400, error: `选择 ${input.pick} 不在候选中。` };
  if (!choices.includes(input.fav)) return { ok: false, status: 400, error: `最喜欢的 ${input.fav} 不在候选中。` };
  if (!REASONS.includes(input.reason)) return { ok: false, status: 400, error: '理由代码只能是 平、假、乱、偏 之一。' };
  if (input.publish !== 'yes' && input.publish !== 'no') return { ok: false, status: 400, error: '发布只能是 yes 或 no。' };
  if (input.facts.length > 6) return { ok: false, status: 400, error: `最多登记 6 条事实，当前选了 ${input.facts.length} 条。` };
  if (input.pick === 'none' && input.facts.length > 0) return { ok: false, status: 400, error: '不选任何一篇时不能登记事实。' };
  const facts: Array<{ label: string; submission: string; id: string; claim: string }> = [];
  for (const key of input.facts) {
    const [label, factId] = key.split(':');
    const subId = label === undefined ? undefined : labels[label];
    const sub = subId === undefined ? null : submissionFor(root, roundId, subId);
    const claim = sub?.output?.delta.claims.find((c) => c.id === factId && c.kind === 'author_fact');
    if (label === undefined || subId === undefined || claim === undefined) return { ok: false, status: 400, error: `找不到事实 ${key}。` };
    facts.push({ label, submission: subId, id: claim.id, claim: claim.claim });
  }
  writeJson(file, {
    round: roundId,
    pick: input.pick,
    pick_submission: input.pick === 'none' ? null : (labels[input.pick] ?? null),
    champion: CHAMPION_ID,
    facts,
    reason: input.reason,
    fav: input.fav,
    publish: input.publish,
    happened: input.happened === 'on',
    source: 'ui',
    decided_at: now,
  });
  logOwner(root, 'decision', roundId, file, now);
  return { ok: true, file };
}
