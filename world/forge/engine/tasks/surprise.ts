import type { Family } from '../config.ts';
import { isRecord } from '../json.ts';
import type { SealedForecasts } from '../probe.ts';
import { err, ok, type Result } from '../result.ts';
import { CANON_AUTHOR, type CanonPassage } from '../steps/brief.ts';
import type { MeasureBlock } from '../taste.ts';
import type { TaskSpec } from '../task.ts';
import { normalizeForQuote, splitSentences } from '../text.ts';
import { citedIn, isOneOf, outputBlock, parseFencedJson, quoteSpan, readCapped, mustWrap, readCappedOrNull } from './fenced.ts';
import type { ForecastSlot } from './forecast.ts';
import { measureInstruction, type Detail } from './measures.ts';
import { ROLE_ACCEPT, ROLE_CHAIN, ROLE_MATCH } from './roles.ts';

/**
 * Surprise (07b, s2 §8, PROTOCOL §4): two matchers, a chain writer and an acceptor per submission, roles from
 * tasks/assign.ts surpriseRoles. The acceptor never belongs to an author family of a text quoted in a chain
 * (canon passages count as CANON_AUTHOR = OpenAI). Forecasts reach prompts only here, after a valid unseal.
 */

export { CANON_AUTHOR };

/** A sealed forecast under an opaque id (`P01`…, sealed order); forecaster and model never reach a prompt. */
export interface OpaqueForecast {
  id: string;
  slot: ForecastSlot;
  value: string;
  forecaster: string;
  family: Family;
  model: string;
  /** The forecaster is a writer model (tagged `writer_default` when it matches that writer's own submission). */
  writerModel: boolean;
}

export type MatchRelation = 'same' | 'more_general' | 'none';

export interface Match {
  detail: string;
  /** null ⇔ relation none. */
  forecast: string | null;
  relation: MatchRelation;
}

export interface MatchVerdict {
  matches: Match[];
}

export type DetailClass = 'forecast' | 'open';

export interface ChainCanon {
  /** One of the offered canon files. */
  file: string;
  /** citedIn that file (≥ 8). */
  quote: string;
}

export interface Chain {
  detail: string;
  /** null ⇔ steps empty and lands_on null (the writer could not derive it → drift). */
  canon: ChainCanon | null;
  /** 0–2 sentences, ≤ 60 chars each. */
  steps: string[];
  lands_on: string | null;
}

export interface ChainSet {
  chains: Chain[];
}

export interface AcceptItem {
  detail: string;
  accept: boolean;
  reason: string;
}

export interface AcceptVerdict {
  verdicts: AcceptItem[];
}

export type DetailOutcome = 'forecast' | 'surprising' | 'drift' | 'unresolved';

/** Roles status (tasks/assign.ts) or why surprise did not run for the round. */
export type SurpriseStatus = 'full' | 'reused' | 'match_only' | 'insufficient' | 'invalid' | 'inactive';

export interface SurpriseDetail {
  id: string;
  image: string;
  quote: string;
  families: Family[];
  outcome: DetailOutcome;
  /** Opaque ids of the matched forecasts (either matcher). */
  forecasts: string[];
  /** A matched forecast came from this submission's own writer model. */
  writer_default: boolean;
  chain: Chain | null;
  accept_reason: string | null;
}

/** One submission's surprise report (no threshold; `eligible` excludes unresolved details). */
export interface SurpriseReport {
  submission: string;
  status: SurpriseStatus;
  surprising: number;
  eligible: number;
  drift: number;
  unresolved: number;
  forecast: number;
  details: SurpriseDetail[];
  chains: Chain[];
  acceptor_reused: boolean;
  roles: { matchers: Family[]; chain_writer: Family | null; acceptor: Family | null };
  /** Task ids run for this submission; `match-*` records live under `.sealed/RNN/tasks/` (they saw forecast values). */
  tasks: string[];
}


/** Caps (code points) and citation floors of the surprise parsers. */
export const CHAIN_QUOTE_MIN = 8;
export const CHAIN_STEPS_MAX = 2;
const STEP_MAX = 60;
const LANDS_MAX = 30;
const REASON_MAX = 60;
const QUOTE_MAX = 300;
export const MATCH_RELATIONS: readonly MatchRelation[] = ['same', 'more_general', 'none'];

/** Engine default matcher paragraph (a maintainer `measures.surprise.prompt` replaces exactly this paragraph). */
export const DEFAULT_MATCH_PROMPT = '对每个细节，判断是否有一条预测与它相同，或是它的更泛化的说法（例如预测“旧物”涵盖细节“母亲的铝饭盒”）。';

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function wrapped(builder: string, label: string, text: string, id: string, seed: string): string {
  return mustWrap(builder, label, text, seed, `${id}:${label}`);
}

/** readCapped on a bare value (array items), errors prefixed with `at`. */
function cappedValue(v: unknown, max: number, at: string): Result<string> {
  return readCapped({ [at]: v }, at, max);
}

/** The id field of item `at`, required to be one of `ids` and not seen before. */
function claimId(raw: unknown, ids: readonly string[], seen: Set<string>, at: string, key: string): Result<string> {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!ids.includes(id)) return err(`${at}.${key}: not one of the offered ids`);
  if (seen.has(id)) return err(`${at}.${key}: answered twice`);
  seen.add(id);
  return ok(id);
}

function everyAnswered(ids: readonly string[], seen: ReadonlySet<string>, key: string): Result<true> {
  const missing = ids.find((id) => !seen.has(id));
  return missing === undefined ? ok(true) : err(`${key}: offered id ${missing} is not answered`);
}

/** Flattens sealed forecasts with opaque ids P01… in sealed order. */
export function flattenForecasts(sealed: SealedForecasts): OpaqueForecast[] {
  const total = sealed.forecasts.reduce((n, f) => n + f.items.length, 0);
  const width = Math.max(2, String(total).length);
  const out: OpaqueForecast[] = [];
  for (const f of sealed.forecasts) {
    for (const item of f.items) {
      out.push({ id: `P${String(out.length + 1).padStart(width, '0')}`, slot: item.slot, value: item.value, forecaster: f.forecaster, family: f.family, model: f.model, writerModel: f.writer_model });
    }
  }
  return out;
}

/** context[d.id] = the sentence holding the detail's quote plus one sentence either side (the quote itself when unplaced). */
export function detailContexts(details: readonly Detail[], text: string): Record<string, string> {
  const sentences = splitSentences(text);
  const spans: Array<{ start: number; end: number }> = [];
  let at = 0;
  for (const s of sentences) {
    const len = [...normalizeForQuote(s)].length;
    spans.push({ start: at, end: at + len });
    at += len;
  }
  const out: Record<string, string> = {};
  for (const d of details) {
    const q = quoteSpan(d.quote, text);
    const hit = q === null ? [] : spans.flatMap((s, i) => (Math.min(s.end, q.end) - Math.max(s.start, q.start) > 0 ? [i] : []));
    const first = hit[0];
    const last = hit[hit.length - 1];
    out[d.id] = first === undefined || last === undefined ? d.quote : sentences.slice(Math.max(0, first - 1), last + 2).join('');
  }
  return out;
}

function parseMatch(text: string, detailIds: readonly string[], forecastIds: readonly string[]): Result<MatchVerdict> {
  const obj = parseFencedJson(text);
  if (!obj.ok) return obj;
  const list = obj.value['matches'];
  if (!Array.isArray(list)) return err('matches: missing or not an array');
  const seen = new Set<string>();
  const got = new Map<string, Match>();
  for (const [i, item] of list.entries()) {
    const at = `matches[${i}]`;
    if (!isRecord(item)) return err(`${at}: not an object`);
    const detail = claimId(item['detail'], detailIds, seen, at, 'detail');
    if (!detail.ok) return detail;
    const rawRel = item['relation'];
    const relation = typeof rawRel === 'string' ? rawRel.trim() : '';
    if (!isOneOf(relation, MATCH_RELATIONS)) return err(`${at}.relation: not one of same, more_general, none`);
    if (!Object.hasOwn(item, 'forecast')) return err(`${at}.forecast: missing`);
    const rawForecast = item['forecast'];
    if (relation === 'none') {
      if (rawForecast !== null) return err(`${at}: relation none needs forecast null`);
      got.set(detail.value, { detail: detail.value, forecast: null, relation });
      continue;
    }
    const forecast = typeof rawForecast === 'string' ? rawForecast.trim() : '';
    if (!forecastIds.includes(forecast)) return err(`${at}.forecast: not one of the offered forecast ids`);
    got.set(detail.value, { detail: detail.value, forecast, relation });
  }
  const all = everyAnswered(detailIds, seen, 'matches');
  if (!all.ok) return all;
  return ok({ matches: detailIds.flatMap((id) => got.get(id) ?? []) });
}

/** Matcher TaskSpec (role ROLE_MATCH): 【细节】 `D1｜image｜上下文`, 【预测】 `P07｜slot｜value`, measure prompt; every detail exactly once. */
export function matchTask(details: readonly Detail[], context: Readonly<Record<string, string>>, forecasts: readonly OpaqueForecast[], measure: MeasureBlock, id: string, seed: string): TaskSpec<MatchVerdict> {
  if (details.length === 0 || forecasts.length === 0) throw new Error('matchTask: needs at least one detail and one forecast');
  const detailIds = details.map((d) => d.id);
  const forecastIds = forecasts.map((f) => f.id);
  const prompt = [
    '下面是一篇现场里读者记住的细节，以及写作之前别人对这类现场做的预测。',
    '【细节】（编号｜细节｜上下文）',
    wrapped('matchTask', '细节', details.map((d) => `${d.id}｜${d.image}｜上下文：${context[d.id] ?? d.quote}`).join('\n'), id, seed),
    '',
    '【预测】（编号｜槽位｜取值）',
    wrapped('matchTask', '预测', forecasts.map((f) => `${f.id}｜${f.slot}｜${f.value}`).join('\n'), id, seed),
    '',
    measureInstruction(measure, DEFAULT_MATCH_PROMPT),
    '每个细节恰好回答一次：relation 为 same（相同）、more_general（预测是细节的更泛化说法）或 none（没有命中）；none 时 forecast 写 null，否则写那条预测的编号。',
    '',
    outputBlock({ matches: [{ detail: 'D1', forecast: 'P07', relation: 'same' }, { detail: 'D2', forecast: null, relation: 'none' }] }),
  ].join('\n');
  return { id, role: ROLE_MATCH, prompt, parse: (t) => parseMatch(t, detailIds, forecastIds) };
}

/** `open` only when both matchers answer none; disagreement or a void matcher (null) → forecast. */
export function classifyForecast(a: MatchVerdict | null, b: MatchVerdict | null, detailIds: readonly string[]): Record<string, DetailClass> {
  const relation = (v: MatchVerdict, id: string): MatchRelation | null => v.matches.find((m) => m.detail === id)?.relation ?? null;
  const out: Record<string, DetailClass> = {};
  for (const id of detailIds) out[id] = a !== null && b !== null && relation(a, id) === 'none' && relation(b, id) === 'none' ? 'open' : 'forecast';
  return out;
}

/** Canon texts by file, in first-seen order (passages of one file joined by a blank line). */
export function canonFiles(canon: readonly CanonPassage[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of canon) {
    const prev = out.get(p.file);
    out.set(p.file, prev === undefined ? p.text : `${prev}\n\n${p.text}`);
  }
  return out;
}

function parseCanon(raw: unknown, files: ReadonlyMap<string, string>, at: string): Result<ChainCanon | null> {
  if (raw === null) return ok(null);
  if (!isRecord(raw)) return err(`${at}.canon: not an object or null`);
  const rawFile = raw['file'];
  const file = typeof rawFile === 'string' ? rawFile.trim() : '';
  const text = files.get(file);
  if (text === undefined) return err(`${at}.canon.file: not one of the offered canon files`);
  const quote = cappedValue(raw['quote'], QUOTE_MAX, `${at}.canon.quote`);
  if (!quote.ok) return quote;
  if (!citedIn(quote.value, text, CHAIN_QUOTE_MIN)) return err(`${at}.canon.quote: not cited verbatim from that file (at least ${CHAIN_QUOTE_MIN} chars)`);
  return ok({ file, quote: quote.value });
}

function parseChains(text: string, openIds: readonly string[], files: ReadonlyMap<string, string>): Result<ChainSet> {
  const obj = parseFencedJson(text);
  if (!obj.ok) return obj;
  const list = obj.value['chains'];
  if (!Array.isArray(list)) return err('chains: missing or not an array');
  const seen = new Set<string>();
  const got = new Map<string, Chain>();
  for (const [i, item] of list.entries()) {
    const at = `chains[${i}]`;
    if (!isRecord(item)) return err(`${at}: not an object`);
    const detail = claimId(item['detail'], openIds, seen, at, 'detail');
    if (!detail.ok) return detail;
    if (!Object.hasOwn(item, 'canon')) return err(`${at}.canon: missing`);
    const canon = parseCanon(item['canon'], files, at);
    if (!canon.ok) return canon;
    const rawSteps = item['steps'];
    if (!Array.isArray(rawSteps)) return err(`${at}.steps: missing or not an array`);
    if (rawSteps.length > CHAIN_STEPS_MAX) return err(`${at}.steps: more than ${CHAIN_STEPS_MAX} steps`);
    const steps: string[] = [];
    for (const [k, s] of rawSteps.entries()) {
      const step = cappedValue(s, STEP_MAX, `${at}.steps[${k}]`);
      if (!step.ok) return step;
      if (splitSentences(step.value).length !== 1) return err(`${at}.steps[${k}]: not exactly one sentence`);
      steps.push(step.value);
    }
    const landsOn = readCappedOrNull(item, 'lands_on', LANDS_MAX);
    if (!landsOn.ok) return err(`${at}.${landsOn.error}`);
    if (canon.value === null && (steps.length > 0 || landsOn.value !== null)) return err(`${at}: canon null needs empty steps and lands_on null`);
    if (canon.value !== null && landsOn.value === null) return err(`${at}: a chain with a canon quote needs lands_on`);
    got.set(detail.value, { detail: detail.value, canon: canon.value, steps, lands_on: landsOn.value });
  }
  const all = everyAnswered(openIds, seen, 'chains');
  if (!all.ok) return all;
  return ok({ chains: openIds.flatMap((id) => got.get(id) ?? []) });
}

/** Chain-writer TaskSpec (role ROLE_CHAIN): the brief's canon passages `〔文件：…〕` and the open details; every open detail exactly once. */
export function chainTask(open: readonly Detail[], context: Readonly<Record<string, string>>, canon: readonly CanonPassage[], id: string, seed: string): TaskSpec<ChainSet> {
  const files = canonFiles(canon);
  if (open.length === 0 || files.size === 0) throw new Error('chainTask: needs at least one open detail and one canon passage');
  const openIds = open.map((d) => d.id);
  const prompt = [
    '对每个细节，尝试从正典推出它：先逐字引用一句正典原句，再写至多两句推理，最后落到这个细节。推不出来就如实写“推不出”。不得引入正典没有的事实。',
    '【正典】',
    wrapped('chainTask', '正典', [...files].map(([file, text]) => `〔文件：${file}〕\n${text}`).join('\n\n'), id, seed),
    '',
    '【细节】（编号｜细节｜上下文）',
    wrapped('chainTask', '细节', open.map((d) => `${d.id}｜${d.image}｜上下文：${context[d.id] ?? d.quote}`).join('\n'), id, seed),
    '',
    `每个细节恰好一条：canon.file 照抄〔文件：…〕里的文件名，canon.quote 逐字摘自该文件，至少 ${CHAIN_QUOTE_MIN} 个字；steps 至多 ${CHAIN_STEPS_MAX} 句，每句不超过 ${STEP_MAX} 字；lands_on 不超过 ${LANDS_MAX} 字，写出推到的细节。推不出时 canon 写 null、steps 写 []、lands_on 写 null。`,
    '',
    outputBlock({
      chains: [
        { detail: 'D2', canon: { file: 'reference/05-ecology-and-everyday.md', quote: '逐字正典原句' }, steps: ['推理一句', '推理一句'], lands_on: '推到的细节' },
        { detail: 'D3', canon: null, steps: [], lands_on: null },
      ],
    }),
  ].join('\n');
  return { id, role: ROLE_CHAIN, prompt, parse: (t) => parseChains(t, openIds, files) };
}

interface CanonChain extends Chain {
  canon: ChainCanon;
}

function hasCanon(c: Chain): c is CanonChain {
  return c.canon !== null;
}

/** canonContext[chain.detail] = the canon paragraph holding the chain's cited sentence (the quote itself when unplaced). */
export function canonContexts(chains: readonly Chain[], canon: readonly CanonPassage[]): Record<string, string> {
  const files = canonFiles(canon);
  const out: Record<string, string> = {};
  for (const c of chains.filter(hasCanon)) {
    const paragraphs = (files.get(c.canon.file) ?? '').split(/\n\s*\n/u).map((p) => p.trim()).filter((p) => p !== '');
    out[c.detail] = paragraphs.find((p) => citedIn(c.canon.quote, p, CHAIN_QUOTE_MIN)) ?? c.canon.quote;
  }
  return out;
}

function parseAccept(text: string, ids: readonly string[]): Result<AcceptVerdict> {
  const obj = parseFencedJson(text);
  if (!obj.ok) return obj;
  const list = obj.value['verdicts'];
  if (!Array.isArray(list)) return err('verdicts: missing or not an array');
  const seen = new Set<string>();
  const got = new Map<string, AcceptItem>();
  for (const [i, item] of list.entries()) {
    const at = `verdicts[${i}]`;
    if (!isRecord(item)) return err(`${at}: not an object`);
    const detail = claimId(item['detail'], ids, seen, at, 'detail');
    if (!detail.ok) return detail;
    const accept = item['accept'];
    if (typeof accept !== 'boolean') return err(`${at}.accept: missing or not a boolean`);
    const reason = readCapped(item, 'reason', REASON_MAX);
    if (!reason.ok) return err(`${at}.${reason.error}`);
    got.set(detail.value, { detail: detail.value, accept, reason: reason.value });
  }
  const all = everyAnswered(ids, seen, 'verdicts');
  if (!all.ok) return all;
  return ok({ verdicts: ids.flatMap((id) => got.get(id) ?? []) });
}

/** Acceptor TaskSpec (role ROLE_ACCEPT): every chain with non-null canon exactly once; reason ≤ 60. */
export function acceptTask(chains: readonly Chain[], details: readonly Detail[], canonContext: Readonly<Record<string, string>>, id: string, seed: string): TaskSpec<AcceptVerdict> {
  const offered = chains.filter(hasCanon);
  if (offered.length === 0) throw new Error('acceptTask: no chain carries a canon quote');
  const image = (detail: string): string => details.find((d) => d.id === detail)?.image ?? '';
  const ids = offered.map((c) => c.detail);
  const chainLine = (c: CanonChain): string => `${c.detail}｜引文：${c.canon.quote}（${c.canon.file}）｜步骤：${c.steps.length === 0 ? '（无）' : c.steps.join(' → ')}｜落到：${c.lands_on ?? ''}｜细节：${image(c.detail)}`;
  const prompt = [
    '判断每条推理链是否成立：引文确实出自正典且意思没有被曲解；每一步都只用引文和常识，不引入新事实；最后确实推到了这个细节。',
    '【链】（编号｜引文｜步骤｜落到｜细节）',
    wrapped('acceptTask', '链', offered.map(chainLine).join('\n'), id, seed),
    '',
    '【正典段落】（编号｜引文所在段落）',
    wrapped('acceptTask', '正典段落', offered.map((c) => `${c.detail}｜${canonContext[c.detail] ?? c.canon.quote}`).join('\n'), id, seed),
    '',
    `每条链恰好回答一次：accept 为 true（成立）或 false（不成立），reason 不超过 ${REASON_MAX} 字。`,
    '',
    outputBlock({ verdicts: [{ detail: 'D2', accept: true, reason: `理由（不超过${REASON_MAX}字）` }] }),
  ].join('\n');
  return { id, role: ROLE_ACCEPT, prompt, parse: (t) => parseAccept(t, ids) };
}

/** Author families of the texts quoted in the chains (every canon quote → CANON_AUTHOR), code-unit sorted; excluded from the acceptor role. */
export function chainAuthors(chains: readonly Chain[]): Family[] {
  const authors = new Set<Family>();
  for (const c of chains) if (c.canon !== null) authors.add(CANON_AUTHOR);
  return [...authors].sort(byCodeUnit);
}
