import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { CHAMPION_ID, submissionFor } from '../../../engine/round.ts';
import { isRecord, readArray, readNumber, readRecord, readString, type JsonRecord } from '../../../engine/json.ts';
import {
  OWNER_ANSWERS, OWNER_LOG, PROTOCOL_BUNDLE_FILE, calibSet, decisionFiles, gateRejection, readOwnerLog, sha256Bytes, staleDecisionPin,
  type OwnerAction,
} from '../../../engine/owner-inputs.ts';
import { loadProtocolBundle } from '../../../engine/rules.ts';
import { readBenchLog } from '../../../engine/bench-log.ts';
import { latestFrozenRound } from '../../../engine/freeze.ts';
import { appendRecords, createExclusive, readJson, roundPaths, writeJson } from '../../../engine/store.ts';

export type OwnerResult = { ok: true; file: string } | { ok: false; status: 400 | 404 | 409; error: string };

type Refusal = { ok: false; status: 400 | 404 | 409; error: string };

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
  /** Base label when the owner merges onto a candidate other than the pick. */
  base?: string;
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

function relPath(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

function fileSha(file: string): string {
  return sha256Bytes(readFileSync(file));
}

interface LogFields {
  version?: string;
  from?: string;
  set?: string;
  slots?: number[];
}

/**
 * Appends one owner-log line through store.appendRecords (the engine's torn-tail guard: a last line without `\n`
 * is cut first, the line is written in one call, and the tail is re-read to confirm it).
 */
function appendOwnerLog(root: string, action: OwnerAction, roundId: string | null, file: string | null, sha: string, now: string, extra: LogFields): string {
  const path = join(root, OWNER_LOG);
  const entry: JsonRecord = { at: now, action, round: roundId, file, sha256: sha, source: 'ui' };
  if (extra.version !== undefined) entry['version'] = extra.version;
  if (extra.from !== undefined) entry['from'] = extra.from;
  if (extra.set !== undefined) entry['set'] = extra.set;
  if (extra.slots !== undefined) entry['slots'] = extra.slots;
  appendRecords(path, [entry]);
  return path;
}

function logOwner(root: string, action: OwnerAction, roundId: string, file: string, now: string): void {
  appendOwnerLog(root, action, roundId, relPath(root, file), fileSha(file), now, {});
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

/** Validates a decision input against labels.json and the submissions; the record keeps the file's key order. */
function decisionRecord(root: string, roundId: string, input: DecisionInput, now: string, supersedes: string | null): { ok: true; record: JsonRecord } | Refusal {
  const labels = readLabels(root, roundId);
  const choices = [...Object.keys(labels), 'none'];
  if (!choices.includes(input.pick)) return { ok: false, status: 400, error: `选择 ${input.pick} 不在候选中。` };
  if (!choices.includes(input.fav)) return { ok: false, status: 400, error: `最喜欢的 ${input.fav} 不在候选中。` };
  if (!REASONS.includes(input.reason)) return { ok: false, status: 400, error: '理由代码只能是 平、假、乱、偏 之一。' };
  if (input.publish !== 'yes' && input.publish !== 'no') return { ok: false, status: 400, error: '发布只能是 yes 或 no。' };
  if (input.facts.length > 6) return { ok: false, status: 400, error: `最多登记 6 条事实，当前选了 ${input.facts.length} 条。` };
  if (input.pick === 'none' && input.facts.length > 0) return { ok: false, status: 400, error: '不选任何一篇时不能登记事实。' };
  const base = input.base === undefined || input.base === input.pick ? null : input.base;
  if (base !== null && (input.pick === 'none' || labels[base] === undefined)) return { ok: false, status: 400, error: `底稿 ${base} 不在候选中，或本轮没有选择任何一篇。` };
  const facts: Array<{ label: string; submission: string; id: string; claim: string }> = [];
  for (const key of input.facts) {
    const [label, factId] = key.split(':');
    const subId = label === undefined ? undefined : labels[label];
    const sub = subId === undefined ? null : submissionFor(root, roundId, subId);
    const claim = sub?.output?.delta.claims.find((c) => c.id === factId && c.kind === 'author_fact');
    if (label === undefined || subId === undefined || claim === undefined) return { ok: false, status: 400, error: `找不到事实 ${key}。` };
    facts.push({ label, submission: subId, id: claim.id, claim: claim.claim });
  }
  return {
    ok: true,
    record: {
      round: roundId,
      pick: input.pick,
      pick_submission: input.pick === 'none' ? null : (labels[input.pick] ?? null),
      base,
      champion: CHAMPION_ID,
      facts,
      reason: input.reason,
      fav: input.fav,
      publish: input.publish,
      happened: input.happened === 'on',
      source: 'ui',
      supersedes,
      decided_at: now,
    },
  };
}

export function submitDecision(root: string, roundId: string, input: DecisionInput, now: string): OwnerResult {
  const paths = roundPaths(root, roundId);
  const file = join(paths.dir, 'decision.json');
  if (!existsSync(join(paths.dir, 'audit.json'))) return { ok: false, status: 409, error: '请先完成盲审。' };
  if (existsSync(file)) return { ok: false, status: 409, error: '这一轮已经做过决定，不能覆盖。' };
  const built = decisionRecord(root, roundId, input, now, null);
  if (!built.ok) return built;
  writeJson(file, built.record);
  logOwner(root, 'decision', roundId, file, now);
  return { ok: true, file };
}

/**
 * Writes decision-<n+1>.json with `supersedes`; only while the current decision's gate record sends it back
 * to 9b and the engine has moved the 09b marker that pinned it to `markers/stale/` (PROTOCOL §6).
 */
export function submitRedecision(root: string, roundId: string, input: DecisionInput, now: string): OwnerResult {
  const paths = roundPaths(root, roundId);
  const chain = decisionFiles(root, roundId);
  if (!chain.ok) return { ok: false, status: 409, error: `决策链有问题：${chain.error}` };
  const prevRel = chain.value.at(-1);
  if (prevRel === undefined) return { ok: false, status: 409, error: '这一轮还没有决策，请先提交第一份决策。' };
  const prevSha = fileSha(join(root, prevRel));
  if (gateRejection(root, roundId, prevSha).kind !== 'rejected') return { ok: false, status: 409, error: '当前决策没有未通过的过门记录，不能追加新决策。' };
  if (!staleDecisionPin(root, roundId, prevSha)) return { ok: false, status: 409, error: '引擎还没有把这一轮退回 9b，请先运行引擎。' };
  const file = join(paths.dir, `decision-${chain.value.length + 1}.json`);
  if (existsSync(file)) return { ok: false, status: 409, error: '新决策已经存在，不能覆盖。' };
  const built = decisionRecord(root, roundId, input, now, prevSha);
  if (!built.ok) return built;
  writeJson(file, built.record);
  logOwner(root, 'decision', roundId, file, now);
  return { ok: true, file };
}

export interface RollbackInput {
  /** Target version (must once have been active or approved). */
  version: string;
  /** Version active when the owner clicked. */
  from: string;
  /** SHA-256 of benchmark/<version>.json as shown to the owner. */
  sha256: string;
}

export interface CalibAnswerInput {
  slot: number;
  choice: 'left' | 'right';
  ms: number | null;
}

export interface TopicInput {
  row_id: string;
  layer: string;
}

const VERSION = /^v[1-9]\d*$/u;

interface BenchLine {
  at: string;
  outcome: string;
  version: string;
  sha256: string | null;
  path: string;
}

/** Version lines of benchmark/log.jsonl in log order, read by the engine's own reader (a bad line refuses, 409). */
function benchLines(root: string): { ok: true; lines: BenchLine[] } | Refusal {
  const log = readBenchLog(root);
  if (!log.ok) return { ok: false, status: 409, error: `基准日志需要修复：${log.error}` };
  const lines: BenchLine[] = [];
  for (const e of log.value) {
    if (e.version === null) continue;
    lines.push({ at: e.at, outcome: e.outcome, version: e.version, sha256: e.sha256, path: e.path ?? `benchmark/${e.version}.json` });
  }
  return { ok: true, lines };
}

/** The logged version file, re-hashed; refuses when it differs from what the owner was shown or from the log. */
function shownVersion(root: string, line: BenchLine, shownSha256: string): { ok: true; sha: string } | Refusal {
  const file = join(root, line.path);
  if (!existsSync(file)) return { ok: false, status: 404, error: `基准文件 ${line.path} 不存在。` };
  const sha = fileSha(file);
  if (sha !== shownSha256 || (line.sha256 !== null && line.sha256 !== sha)) return { ok: false, status: 409, error: '基准文件已经变化，请刷新后重新核对。' };
  return { ok: true, sha };
}

/** Logs protocol_approved for the current bundle; 409 when the bundle hash differs from the one shown. */
export function submitProtocolApproval(root: string, shownBundleSha256: string, now: string): OwnerResult {
  const bundle = loadProtocolBundle(root);
  if (!bundle.ok) return { ok: false, status: 409, error: `协议包无法读取：${bundle.error}` };
  if (bundle.value.bundleSha256 !== shownBundleSha256) return { ok: false, status: 409, error: '协议包已经变化，请刷新后重新核对。' };
  return { ok: true, file: appendOwnerLog(root, 'protocol_approved', null, PROTOCOL_BUNDLE_FILE, shownBundleSha256, now, {}) };
}

/** Logs bench_diff_viewed for benchmark/<version>.json. */
export function submitBenchView(root: string, version: string, shownSha256: string, now: string): OwnerResult {
  if (!VERSION.test(version)) return { ok: false, status: 400, error: `基准版本 ${version} 格式不对。` };
  const bench = benchLines(root);
  if (!bench.ok) return bench;
  const line = bench.lines.filter((l) => l.version === version && (l.outcome === 'activate' || l.outcome === 'pending_owner')).at(-1);
  if (line === undefined) return { ok: false, status: 404, error: `基准 ${version} 不在基准日志中。` };
  const shown = shownVersion(root, line, shownSha256);
  if (!shown.ok) return shown;
  return { ok: true, file: appendOwnerLog(root, 'bench_diff_viewed', null, line.path, shown.sha, now, { version }) };
}

/** Logs bench_approved for a pending_owner version that no later version or rollback has superseded. */
export function submitBenchApproval(root: string, version: string, shownSha256: string, now: string): OwnerResult {
  if (!VERSION.test(version)) return { ok: false, status: 400, error: `基准版本 ${version} 格式不对。` };
  const bench = benchLines(root);
  if (!bench.ok) return bench;
  const lines = bench.lines;
  const index = lines.findLastIndex((l) => l.version === version && l.outcome === 'pending_owner');
  const line = lines[index];
  if (line === undefined) return { ok: false, status: 409, error: `基准 ${version} 不在待批准状态。` };
  const log = readOwnerLog(root);
  if (!log.ok) return { ok: false, status: 409, error: `owner 日志需要修复：${log.error}` };
  const laterVersion = lines.slice(index + 1).some((l) => l.outcome === 'activate' || l.outcome === 'pending_owner');
  const laterRollback = log.value.some((e) => e.action === 'rollback' && Date.parse(e.at) > Date.parse(line.at));
  if (laterVersion || laterRollback) return { ok: false, status: 409, error: `基准 ${version} 已被更新的版本或回滚取代。` };
  const shown = shownVersion(root, line, shownSha256);
  if (!shown.ok) return shown;
  return { ok: true, file: appendOwnerLog(root, 'bench_approved', null, line.path, shown.sha, now, { version }) };
}

/** Logs rollback (round = latest round with a freeze.json); the target must once have been active or approved. */
export function submitRollback(root: string, input: RollbackInput, now: string): OwnerResult {
  if (!VERSION.test(input.version) || !VERSION.test(input.from) || input.version === input.from) return { ok: false, status: 400, error: '回滚的目标版本与当前版本必须是两个不同的基准版本。' };
  const log = readOwnerLog(root);
  if (!log.ok) return { ok: false, status: 409, error: `owner 日志需要修复：${log.error}` };
  const approved = (l: BenchLine): boolean =>
    log.value.some((e) => e.action === 'bench_approved' && e.version === l.version && (l.sha256 === null || e.sha256 === l.sha256));
  const bench = benchLines(root);
  if (!bench.ok) return bench;
  const lines = bench.lines.filter((l) => l.version === input.version && (l.outcome === 'activate' || (l.outcome === 'pending_owner' && approved(l))));
  const line = lines.at(-1);
  if (line === undefined) return { ok: false, status: 409, error: `只能回滚到曾经生效或已批准的版本，${input.version} 不是。` };
  const shown = shownVersion(root, line, input.sha256);
  if (!shown.ok) return shown;
  const file = appendOwnerLog(root, 'rollback', latestFrozenRound(root), line.path, shown.sha, now, { version: input.version, from: input.from });
  return { ok: true, file };
}

/**
 * Appends answers to calibration/owner-answers.json and logs calib_answers with the answered slots (plus any
 * earlier slots of the set that no log line covers yet, i.e. a POST that crashed between file and log).
 */
export function submitCalibAnswers(root: string, set: string, answers: readonly CalibAnswerInput[], now: string): OwnerResult {
  const pairs = calibSet(root, set);
  if (!pairs.ok) return { ok: false, status: 404, error: `校准组 ${set} 不存在：${pairs.error}` };
  if (answers.length === 0) return { ok: false, status: 400, error: '没有要提交的答案。' };
  const log = readOwnerLog(root);
  if (!log.ok) return { ok: false, status: 409, error: `owner 日志需要修复：${log.error}` };
  const file = join(root, OWNER_ANSWERS);
  const current = readJson(file);
  if (existsSync(file) && !isRecord(current)) return { ok: false, status: 409, error: '校准答案文件无法读取。' };
  const sets: JsonRecord = { ...(readRecord(current, 'sets') ?? {}) };
  const existing = readRecord(sets, set);
  if (existing !== null && readString(existing, 'pairs_sha256') !== pairs.value.pairsSha256) return { ok: false, status: 409, error: '校准对已经变化，不能继续提交。' };
  const prior = readArray(existing, 'answers') ?? [];
  const priorSlots = prior.map((a) => readNumber(a, 'slot')).filter((n) => n !== null);
  const logged = new Set(log.value.flatMap((e) => (e.action === 'calib_answers' && e.set === set ? (e.slots ?? []) : [])));
  const slots: number[] = priorSlots.filter((s) => !logged.has(s));
  const added: JsonRecord[] = [];
  for (const a of answers) {
    const d = pairs.value.display.get(a.slot);
    if (d === undefined) return { ok: false, status: 400, error: `第 ${a.slot} 题不在这一组中。` };
    if (priorSlots.includes(a.slot) || added.some((x) => x['slot'] === a.slot)) return { ok: false, status: 409, error: `第 ${a.slot} 题已经回答过，不能覆盖。` };
    if (a.choice !== 'left' && a.choice !== 'right') return { ok: false, status: 400, error: `第 ${a.slot} 题还没有选择。` };
    if (a.ms !== null && (!Number.isInteger(a.ms) || a.ms < 0)) return { ok: false, status: 400, error: `第 ${a.slot} 题的用时不对。` };
    added.push({ slot: a.slot, pair: d.pair, left: d.left, right: d.right, choice: a.choice, chosen: a.choice === 'left' ? d.left : d.right, answered_at: now, ms: a.ms });
    slots.push(a.slot);
  }
  sets[set] = { pairs_sha256: pairs.value.pairsSha256, answers: [...prior, ...added] };
  writeJson(file, { schema: 'owner-answers/1', source: 'ui', sets });
  appendOwnerLog(root, 'calib_answers', null, OWNER_ANSWERS, fileSha(file), now, { set, slots: slots.sort((x, y) => x - y) });
  return { ok: true, file };
}

/** Logs diff_approved with the approval diff's SHA-256 as shown (must equal final.json and approval.diff). */
export function submitDiffApproval(root: string, roundId: string, shownDiffSha256: string, now: string): OwnerResult {
  const paths = roundPaths(root, roundId);
  const finalSha = readString(readJson(join(paths.dir, 'final.json')), 'approval_diff_sha256');
  const diffFile = join(paths.dir, 'approval.diff');
  if (finalSha === null || !existsSync(diffFile)) return { ok: false, status: 404, error: '这一轮还没有待批准的定稿差异。' };
  if (finalSha !== shownDiffSha256 || fileSha(diffFile) !== shownDiffSha256) return { ok: false, status: 409, error: '定稿差异已经变化，请刷新后重新核对。' };
  return { ok: true, file: appendOwnerLog(root, 'diff_approved', roundId, relPath(root, diffFile), shownDiffSha256, now, {}) };
}

/** Creates topic.json exclusively (`wx`, source ui) and logs topic; 409 when a topic exists. */
export function submitTopic(root: string, roundId: string, input: TopicInput, now: string): OwnerResult {
  const paths = roundPaths(root, roundId);
  const file = join(paths.dir, 'topic.json');
  if (existsSync(file)) return { ok: false, status: 409, error: '这一轮的选题已经确定，不能覆盖。' };
  const top3 = readArray(readJson(join(paths.dir, 'topic-offer.json')), 'top3');
  if (top3 === null) return { ok: false, status: 404, error: '这一轮还没有选题候选。' };
  if (!top3.some((t) => readString(t, 'row_id') === input.row_id && readString(t, 'layer') === input.layer)) return { ok: false, status: 400, error: '选题不在候选之中。' };
  const topic = { round: roundId, row_id: input.row_id, layer: input.layer, cell: null, source: 'ui', chosen_at: now };
  if (!createExclusive(file, `${JSON.stringify(topic, null, 2)}\n`)) return { ok: false, status: 409, error: '这一轮的选题已经确定，不能覆盖。' };
  logOwner(root, 'topic', roundId, file, now);
  return { ok: true, file };
}
