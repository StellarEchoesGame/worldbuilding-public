import { isDeepStrictEqual } from 'node:util';
import { EVIDENCE_ID, type EvidenceMeasure, type EvidencePacket } from './bench-evidence.ts';
import type { BenchLogReason } from './bench-log.ts';
import { MAINTAINER_KEYS, META_KEYS, PROTECTED_KEYS } from './bench-validate.ts';
import { isRecord, stringArray, type JsonRecord } from './json.ts';
import type { Protocol } from './protocol.ts';
import { err, ok, type Result } from './result.ts';
import type { TaskSpec } from './task.ts';
import { mustWrap, outputBlock, parseFencedJson, readCapped } from './tasks/fenced.ts';
import { taskId } from './tasks/ids.ts';
import { ROLE_MAINTAINER } from './tasks/roles.ts';
import { sentenceKey } from './text.ts';

/*
 * Maintainer tasks (plan §5 maintainer row, s3 §3.4): the Chinese prompt (authority table → head JSON → evidence
 * packet → PROTOCOL.md → output block), the validating parser (retry-triggering; a second failure is the logged
 * outcome no_change_invalid), candidate assembly with engine-owned meta, and the canon-cliché filter.
 */

/** Cap per reason text field (schema/benchmark.schema.json reasons). */
export const MAINTAINER_REASON_MAX = 300;
/** Optional owner input of the initial proposal (F1-06 PR); absent → the prompt says 无额外输入材料. */
export const V1_INPUTS = 'benchmark/v1-inputs.md';
/** Task id of the initial proposal (task-id kind `bench`). */
export const INITIAL_TASK_ID = 'bench-initial';

/** One reason of a `change` output (schema/benchmark.schema.json reasons[] shape). */
export interface BenchReason {
  change: string;
  keys: string[];
  evidence_ids: string[];
  expected_effect: string;
}

/** One reason of a `no_change` output. */
export interface NoChangeReason {
  text: string;
  evidence_ids: string[];
}

export interface NoChangeOutput {
  kind: 'no_change';
  reasons: NoChangeReason[];
}

/** `body` = the maintainer keys (protected keys pass through so validation rejects them visibly). */
export interface ChangeOutput {
  kind: 'change';
  body: JsonRecord;
  reasons: BenchReason[];
}

export type MaintainerOutput = NoChangeOutput | ChangeOutput;

export interface MaintainerInput {
  packet: EvidencePacket;
  /** The head version's JSON (the proposal's parent). */
  head: JsonRecord;
  authority: string;
  protocolMd: string;
  round: string;
  /** wrapText seed (the packet's SHA-256). */
  seed: string;
}

export interface InitialInput {
  protocolMd: string;
  /** V1_INPUTS text, or null when the file is absent. */
  inputsMd: string | null;
  authority: string;
  /** wrapText seed (the protocol bundle SHA-256). */
  seed: string;
}

/** Engine-owned meta of an assembled candidate (`author.kind` is always `maintainer`). */
export interface CandidateMeta {
  version: string;
  parent: string | null;
  createdAt: string;
  model: string;
}


/** At most this many reasons per output (one per changed key is the norm). */
const MAINTAINER_REASONS_MAX = 20;
/** Material labels of the prompt blocks (fakes read them with unwrap). */
const WRAP_SCOPE = 'bench-propose';
const NO_INPUTS = '无额外输入材料';

const CLASS_TEXT: Readonly<Record<string, string>> = {
  auto: '自动：owner 打开该版本差异页后，或通知与镜像评论发出 24 小时后，于下一次冻结生效',
  replay: '回放：须先在保留盲标上通过新旧两版回放，再按自动方式生效；未通过记为 rejected_by_replay',
  owner: '须 owner 批准：owner 在基准页点击批准后，于下一次冻结生效',
};

const CHANGE_SHAPE: JsonRecord = {
  kind: 'change',
  body: Object.fromEntries(MAINTAINER_KEYS.map((k) => [k, '（该键的完整取值）'])),
  reasons: [{ change: '改了什么（≤300 字）', keys: ['本条涉及的维护者键'], evidence_ids: ['E-…'], expected_effect: '预期效果（≤300 字）' }],
};

/** `bench-propose-<round>` (task-id kind `bench`). */
export function maintainerTaskId(round: string): string {
  return taskId(`bench-propose-${round}`);
}

function retryWith(prompt: string): (error: string) => string {
  return (error) => `${prompt}\n\n上一次的输出没有通过检查：${error}\n请只改正这些问题，按同样的形状重新输出。`;
}

/** Output rules shared by both tasks; `initial` forbids evidence ids and no_change. */
function outputRules(ceilings: readonly string[], initial: boolean): string[] {
  const keys = MAINTAINER_KEYS.join('、');
  const rules = initial
    ? ['1. kind 必须为 change：这是第一个版本，没有可维持的旧版本。']
    : ['1. kind 为 no_change（维持当前版本）或 change（提出新版本）。', '2. no_change：reasons 至少一条，每条写 text（≤300 字）与 evidence_ids，形如 {"kind": "no_change", "reasons": [{"text": "…", "evidence_ids": ["E-…"]}]}。'];
  const n = rules.length + 1;
  rules.push(
    `${n}. change：body 写出全部维护者键（${keys}）的完整取值，不写 ${META_KEYS.join('、')} 等元数据（由引擎填写），也不写受保护键；reasons 每条列出 change、keys、evidence_ids、expected_effect，文字各 ≤300 字。`,
    initial
      ? `${n + 1}. 还没有证据包：每条理由的 evidence_ids 写空数组 []。`
      : `${n + 1}. evidence_ids 只能引用证据包里出现过的编号；每个改动的键都必须出现在某条带证据编号的理由里，门槛只能收紧。`,
  );
  if (!initial) {
    rules.push(
      ceilings.length === 0
        ? `${n + 2}. 本轮没有测量触及天花板。`
        : `${n + 2}. 以下测量已被标记天花板：${ceilings.join('、')}。每一项必须退役、替换（改动对应测量的取值），或在某条理由里引用该编号。`,
    );
  }
  return rules;
}

function maintainerPrompt(p: MaintainerInput, id: string): string {
  const version = p.packet.head_version;
  return [
    '【任务说明】',
    `你维护《群星回响》的审美基准。第 ${p.round} 轮已经结束，引擎整理了本轮的证据包。请只根据下面的材料判断：维持当前版本不变（no_change），或提出一个以当前版本为父版本的新版本（change）。每条理由都要引用证据包里的编号；证据不足时宁可不改。`,
    '',
    '【权限表】（各键的生效方式；受保护键不可写）',
    mustWrap(WRAP_SCOPE, '权限表', p.authority, p.seed, `${id}:权限表`),
    '',
    `【当前版本】（${version}，你的提案以它为父版本）`,
    mustWrap(WRAP_SCOPE, '当前版本', JSON.stringify(p.head, null, 2), p.seed, `${id}:当前版本`),
    '',
    '【证据包】',
    mustWrap(WRAP_SCOPE, '证据包', JSON.stringify(p.packet, null, 2), p.seed, `${id}:证据包`),
    '',
    '【PROTOCOL.md 全文】',
    mustWrap(WRAP_SCOPE, '协议', p.protocolMd, p.seed, `${id}:协议`),
    '',
    '【输出要求】',
    ...outputRules(p.packet.ceilings, false),
    '',
    outputBlock(CHANGE_SHAPE),
  ].join('\n');
}

/** The cycle proposal task on ctx.backends.maintainer; retryPrompt quotes the parse error. */
export function maintainerTask(p: MaintainerInput): TaskSpec<MaintainerOutput> {
  const id = maintainerTaskId(p.round);
  const prompt = maintainerPrompt(p, id);
  return { id, role: ROLE_MAINTAINER, prompt, parse: (text) => parseMaintainer(text, p.packet, p.head), retryPrompt: retryWith(prompt) };
}

function initialPrompt(p: InitialInput): string {
  const id = INITIAL_TASK_ID;
  return [
    '【任务说明】',
    '你为《群星回响》起草第一个审美基准版本（根版本 v1）。现在还没有任何轮次，也没有证据包；请依据 PROTOCOL.md 与输入材料写出全部维护者键的完整取值。根版本须经 owner 在基准页批准后才会生效。',
    '',
    '【权限表】（各键的生效方式；受保护键不可写）',
    mustWrap(WRAP_SCOPE, '权限表', p.authority, p.seed, `${id}:权限表`),
    '',
    '【输入材料】',
    mustWrap(WRAP_SCOPE, '输入材料', p.inputsMd ?? NO_INPUTS, p.seed, `${id}:输入材料`),
    '',
    '【PROTOCOL.md 全文】',
    mustWrap(WRAP_SCOPE, '协议', p.protocolMd, p.seed, `${id}:协议`),
    '',
    '【输出要求】',
    ...outputRules([], true),
    '',
    outputBlock(CHANGE_SHAPE),
  ].join('\n');
}

/** The v1 proposal task (no packet; only `change` is accepted, cited ids must be empty). */
export function initialTask(p: InitialInput): TaskSpec<MaintainerOutput> {
  const prompt = initialPrompt(p);
  return {
    id: INITIAL_TASK_ID,
    role: ROLE_MAINTAINER,
    prompt,
    parse: (text) => {
      const r = parseMaintainer(text, null, null);
      if (r.ok && r.value.kind !== 'change') return err('kind: the initial proposal must be a change');
      return r;
    },
    retryPrompt: retryWith(prompt),
  };
}

/** A key name safe to quote in an ASCII error (model text is never echoed otherwise). */
function keyName(key: string): string {
  return /^[A-Za-z0-9_.-]{1,40}$/u.test(key) ? key : '(non-ASCII key)';
}

function capped(obj: JsonRecord, key: string, at: string): Result<string> {
  const r = readCapped(obj, key, MAINTAINER_REASON_MAX);
  return r.ok ? r : err(`${at}.${r.error}`);
}

/** Evidence ids of one reason: the id pattern, then membership in the packet (null packet: none allowed). */
function evidenceIds(value: unknown, at: string, known: ReadonlySet<string> | null): Result<string[]> {
  const ids = stringArray(value);
  if (ids === null) return err(`${at}.evidence_ids: not an array of strings`);
  for (const [j, id] of ids.entries()) if (!EVIDENCE_ID.test(id)) return err(`${at}.evidence_ids[${j}]: not an evidence id`);
  if (known === null && ids.length > 0) return err(`${at}.evidence_ids: no evidence packet, cite no ids`);
  const missing = known === null ? undefined : ids.find((id) => !known.has(id));
  if (missing !== undefined) return err(`${at}.evidence_ids: ${missing} is not in the evidence packet`);
  return ok(ids);
}

function noChangeReason(raw: unknown, at: string, known: ReadonlySet<string> | null): Result<NoChangeReason> {
  if (!isRecord(raw)) return err(`${at}: not an object`);
  const text = capped(raw, 'text', at);
  if (!text.ok) return text;
  const ids = evidenceIds(raw['evidence_ids'], at, known);
  return ids.ok ? ok({ text: text.value, evidence_ids: ids.value }) : ids;
}

function changeReason(raw: unknown, at: string, known: ReadonlySet<string> | null): Result<BenchReason> {
  if (!isRecord(raw)) return err(`${at}: not an object`);
  const change = capped(raw, 'change', at);
  if (!change.ok) return change;
  const keys = stringArray(raw['keys']);
  if (keys === null) return err(`${at}.keys: not an array of strings`);
  const foreign = keys.find((k) => !MAINTAINER_KEYS.includes(k));
  if (foreign !== undefined) return err(`${at}.keys: ${keyName(foreign)} is not a maintainer key`);
  const ids = evidenceIds(raw['evidence_ids'], at, known);
  if (!ids.ok) return ids;
  const effect = capped(raw, 'expected_effect', at);
  if (!effect.ok) return effect;
  return ok({ change: change.value, keys, evidence_ids: ids.value, expected_effect: effect.value });
}

/** Maintainer keys (all required) plus protected keys (kept for validation to reject visibly); meta or other keys → err. */
function changeBody(raw: unknown): Result<JsonRecord> {
  if (!isRecord(raw)) return err('body: not an object');
  for (const key of Object.keys(raw)) {
    if (META_KEYS.includes(key)) return err(`body: meta key ${key} is written by the engine`);
    if (!MAINTAINER_KEYS.includes(key) && !PROTECTED_KEYS.includes(key)) return err(`body: unknown key ${keyName(key)}`);
  }
  const missing = MAINTAINER_KEYS.find((k) => !Object.hasOwn(raw, k));
  if (missing !== undefined) return err(`body: missing maintainer key ${missing}`);
  return ok(raw);
}

function reasonList<T>(raw: unknown, parse: (r: unknown, at: string) => Result<T>): Result<T[]> {
  if (!Array.isArray(raw)) return err('reasons: not an array');
  if (raw.length > MAINTAINER_REASONS_MAX) return err(`reasons: more than ${MAINTAINER_REASONS_MAX}`);
  const out: T[] = [];
  for (const [i, r] of raw.entries()) {
    const parsed = parse(r, `reasons[${i}]`);
    if (!parsed.ok) return parsed;
    out.push(parsed.value);
  }
  return ok(out);
}

/** The benchmark value a saturation measure lives in: `taste` → `taste`, the others → `measures.<m>`. */
function measurePath(measure: EvidenceMeasure): string {
  return measure === 'taste' ? 'taste' : `measures.${measure}`;
}

function measureValue(version: JsonRecord, measure: EvidenceMeasure): unknown {
  if (measure === 'taste') return version['taste'];
  const measures = version['measures'];
  return isRecord(measures) ? measures[measure] : undefined;
}

/** First ceiling id neither cited nor answered by a change of its measure against `head` (null head: citation only). */
function unansweredCeiling(o: MaintainerOutput, packet: EvidencePacket, head: JsonRecord | null): string | null {
  const cited = new Set(citedIds(o));
  for (const id of packet.ceilings) {
    if (cited.has(id)) continue;
    const item = packet.items.find((i) => i.id === id);
    const measure = item !== undefined && item.kind === 'saturation' ? item.measure : null;
    if (measure === null) return `ceiling ${id}: cite it`;
    const changed = o.kind === 'change' && head !== null && !isDeepStrictEqual(measureValue(o.body, measure), measureValue(head, measure));
    if (!changed) return `ceiling ${id}: cite it or change ${measurePath(measure)}`;
  }
  return null;
}

/**
 * One fenced json block; known kind; cited ids exist in the packet (null: none allowed); ceilings cited or measure
 * changed; no meta keys; caps. "Measure changed" compares against `head` (maintainerTask passes the proposal's parent);
 * without a head a ceiling must be cited. Errors are ASCII and trigger the one retry.
 */
export function parseMaintainer(text: string, packet: EvidencePacket | null, head: JsonRecord | null = null): Result<MaintainerOutput> {
  const obj = parseFencedJson(text);
  if (!obj.ok) return obj;
  const kind = obj.value['kind'];
  const known = packet === null ? null : new Set(packet.items.map((i) => i.id));
  let output: MaintainerOutput;
  if (kind === 'no_change') {
    const reasons = reasonList(obj.value['reasons'], (r, at) => noChangeReason(r, at, known));
    if (!reasons.ok) return reasons;
    if (reasons.value.length === 0) return err('reasons: no_change needs at least one reason');
    output = { kind, reasons: reasons.value };
  } else if (kind === 'change') {
    const body = changeBody(obj.value['body']);
    if (!body.ok) return body;
    const reasons = reasonList(obj.value['reasons'], (r, at) => changeReason(r, at, known));
    if (!reasons.ok) return reasons;
    if (reasons.value.length === 0) return err('reasons: a change needs at least one reason');
    output = { kind, body: body.value, reasons: reasons.value };
  } else {
    return err('kind: must be "no_change" or "change"');
  }
  const ceiling = packet === null ? null : unansweredCeiling(output, packet, head);
  return ceiling === null ? ok(output) : err(ceiling);
}

/** Chinese table of every maintainer key's activation class and the protected keys (protocol §11). */
export function authorityTable(protocol: Protocol): string {
  const keys = [...MAINTAINER_KEYS.filter((k) => Object.hasOwn(protocol.activation, k)), ...Object.keys(protocol.activation).filter((k) => !MAINTAINER_KEYS.includes(k))];
  const rows = keys.map((k) => {
    const cls = protocol.activation[k] ?? 'owner';
    return `| ${k} | ${cls} | ${CLASS_TEXT[cls] ?? ''} |`;
  });
  return [
    '| 键 | 类别 | 生效方式 |',
    '| --- | --- | --- |',
    ...rows,
    '',
    `回滚冻结：owner 回滚后 ${protocol.bars.holdRounds} 轮内，改动被回滚版本触及过的键一律升为 owner 类（须 owner 批准）；replay 键照常回放。`,
    '根版本（没有父版本）一律须 owner 批准。',
    `受保护键（不得写入 body，写入即被拒绝）：${protocol.protectedKeys.join('、')}`,
  ].join('\n');
}

/** `{version, parent, created_at, author: {kind: 'maintainer', model}, reasons, ...body}` in that key order. */
export function assembleCandidate(o: ChangeOutput, meta: CandidateMeta): JsonRecord {
  const out: JsonRecord = {
    version: meta.version,
    parent: meta.parent,
    created_at: meta.createdAt,
    author: { kind: 'maintainer', model: meta.model },
    reasons: o.reasons.map((r) => ({ change: r.change, keys: [...r.keys], evidence_ids: [...r.evidence_ids], expected_effect: r.expected_effect })),
  };
  // Maintainer keys in MAINTAINER_KEYS order, then any protected key the output carried (validation rejects it).
  for (const key of MAINTAINER_KEYS) if (Object.hasOwn(o.body, key)) out[key] = structuredClone(o.body[key]);
  for (const key of Object.keys(o.body)) if (!MAINTAINER_KEYS.includes(key) && !META_KEYS.includes(key)) out[key] = structuredClone(o.body[key]);
  return out;
}

/**
 * Removes cliche_list entries that are substrings of BOOK.md or REFERENCE.md (NFKC both sides), but only entries new
 * against `parent` (null: all are new). Inherited entries stay even once canon contains them: dropping one would be a
 * cliche_list change the maintainer never proposed (rejected_validate for lack of a reason), and the freeze-time brief
 * filter already handles canon growth.
 */
export function dropCanonCliches(candidate: JsonRecord, canon: { book: string; reference: string }, parent: JsonRecord | null): { candidate: JsonRecord; dropped: string[] } {
  const copy = structuredClone(candidate);
  const list = copy['cliche_list'];
  if (!Array.isArray(list)) return { candidate: copy, dropped: [] };
  const book = sentenceKey(canon.book);
  const reference = sentenceKey(canon.reference);
  const inherited = new Set((stringArray(parent?.['cliche_list']) ?? []).map((e) => sentenceKey(e).trim()));
  const dropped: string[] = [];
  const kept: unknown[] = [];
  for (const entry of list) {
    const key = typeof entry === 'string' ? sentenceKey(entry).trim() : '';
    const isNew = key !== '' && !inherited.has(key);
    if (isNew && typeof entry === 'string' && (book.includes(key) || reference.includes(key))) dropped.push(entry);
    else kept.push(entry);
  }
  copy['cliche_list'] = kept;
  return { candidate: copy, dropped };
}

/** Log reasons of an output (`change` → text = change; `no_change` → keys []). */
export function logReasons(o: MaintainerOutput): BenchLogReason[] {
  if (o.kind === 'no_change') return o.reasons.map((r) => ({ text: r.text, keys: [], evidence_ids: [...r.evidence_ids] }));
  return o.reasons.map((r) => ({ text: r.change, keys: [...r.keys], evidence_ids: [...r.evidence_ids] }));
}

/** Sorted union of the evidence ids an output cites. */
export function citedIds(o: MaintainerOutput): string[] {
  const ids = new Set<string>();
  for (const r of o.reasons) for (const id of r.evidence_ids) ids.add(id);
  return [...ids].sort();
}
