import { anonymizeText } from '../anonymize.ts';
import type { Family } from '../config.ts';
import { isRecord, type JsonRecord } from '../json.ts';
import { err, ok, type Result } from '../result.ts';
import type { BriefJson } from '../steps/brief.ts';
import { seededShuffle } from '../store.ts';
import type { MeasureBlock } from '../taste.ts';
import type { TaskSpec } from '../task.ts';
import type { InterfaceCard } from '../writer-output.ts';
import { citedIn, isOneOf, outputBlock, parseFencedJson, quoteSpan, readCapped, readCappedOrNull, mustWrap, spansOverlap, type Span } from './fenced.ts';
import { ROLE_COLD, ROLE_PRODUCER, ROLE_RECALL, ROLE_SKIN } from './roles.ts';

/**
 * Per-submission measures (06d, s2 §7): recall with an engine-owned distractor, skin-swap (engine swap + lineup),
 * cold reader (never sees canon), producer (Layer 3, never retired). All read the anonymized display text. A
 * maintainer `measures.<key>.prompt` replaces only the instruction paragraph (checked by renderMeasurePrompt).
 */

/** 12 distinct seeded two-digit integers; `answer` = sorted ascending. */
export interface Distractor {
  numbers: number[];
  answer: number[];
}

export const DISTRACTOR_SIZE = 12;

export interface Recall {
  sorted: number[];
  /** 2–30 chars. */
  image: string;
  /** citedIn the text, ≥ 6. */
  quote: string;
}

/** A recalled detail offered to 07b: images grouped by overlapping quote spans (≥ 4), by family count desc, then span start; cap DETAIL_CAP. */
export interface Detail {
  /** D1…D6. */
  id: string;
  submission: string;
  image: string;
  quote: string;
  families: Family[];
}

export const DETAIL_CAP = 6;

export type SkinLabel = '甲' | '乙' | '丙' | '丁';

export const SKIN_LABELS: readonly SkinLabel[] = ['甲', '乙', '丙', '丁'];

export type SkinNounKind = 'character' | 'area' | 'ship' | 'civilization' | 'new';

export interface SkinNoun {
  term: string;
  kind: SkinNounKind;
}

/** Brief row + 3 seeded other rows (key `skin:<sub>`), each card = the row's aliases.json first_quote through the same swap. */
export interface SkinLineup {
  cards: Array<{ label: SkinLabel; rowId: string; text: string }>;
  answer: SkinLabel;
}

export interface SkinVerdict {
  pick: SkinLabel;
  quote: string;
  reason: string;
  /** pick === lineup.answer. */
  recognised: boolean;
}

export interface ColdRead {
  where: { answer: string; quote: string };
  who: { name: string; wants: string; cost: string | null; quote: string };
  go: { answer: string | null; quote: string | null };
  /** Answered items with valid quotes (0–3), the default score. */
  clarity: number;
}

export interface ChecklistItem {
  /** `S1.地点` … `H.玩法类型`, extras `X1…`. */
  id: string;
  text: string;
}

export interface ProducerItem {
  id: string;
  ok: boolean;
  /** Non-null iff !ok (≤ 40 chars). */
  missing: string | null;
}

export interface ProducerVerdict {
  items: ProducerItem[];
  /** Every item ok (Layer 3 also needs interfaceChecks to pass). */
  allOk: boolean;
}

const SHOT_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['地点', '地点（行 ID 或舰内空间类型）'],
  ['时间与光源', '时间与光源'],
  ['景别与视点高度', '景别与视点高度'],
  ['主体人物与动作', '主体人物与动作'],
  ['尺度参照物', '尺度参照物'],
  ['材质色彩词', '3 个材质 / 色彩词'],
  ['禁画项', '禁画项'],
];

const OBJECT_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['位置', '物件的位置'],
  ['玩家动词', '至少 2 个玩家动词'],
  ['状态', '至少 2 个状态'],
  ['使用权限', '使用权限归谁'],
  ['拒绝或失败', '拒绝或失败后的结果'],
];

const HOOK_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['自行发生', '玩家不来时何时自行发生什么'],
  ['同意', '需要谁同意'],
  ['选项', '至少 2 个选项且含拒绝'],
  ['消耗义务', '消耗与义务由谁承担'],
  ['回舰遗留', '回到母舰后留下什么'],
  ['玩法类型', '玩法类型（经营 / 战略与战斗 / 探索 / 生成支线之一）'],
];

/** Protocol-owned producer checklist: one item per interface field (3 shots × 7 + object 5 + hook 6 = 32). */
export const CHECKLIST_BASE: readonly ChecklistItem[] = [
  ...[1, 2, 3].flatMap((k) => SHOT_FIELDS.map(([f, t]) => ({ id: `S${k}.${f}`, text: `镜头 ${k}：${t}` }))),
  ...OBJECT_FIELDS.map(([f, t]) => ({ id: `O.${f}`, text: `物件：${t}` })),
  ...HOOK_FIELDS.map(([f, t]) => ({ id: `H.${f}`, text: `钩子：${t}` })),
];


/** Field caps (code points) and citation floors of the measure parsers. */
export const IMAGE_MIN = 2;
export const IMAGE_MAX = 30;
export const MEASURE_QUOTE_MIN = 6;
const QUOTE_MAX = 200;
const REASON_MAX = 60;
const COLD_ANSWER_MAX = 40;
const COLD_NAME_MAX = 12;
const MISSING_MAX = 40;
/** Two recalled images name one detail when their quote spans share at least this many normalized chars. */
export const DETAIL_OVERLAP_MIN = 4;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** mustWrap under the `<id>:<label>` key; a text holding its own delimiter is an IntegrityError (as every task builder). */
function wrapped(builder: string, label: string, text: string, id: string, seed: string): string {
  return mustWrap(builder, label, text, seed, `${id}:${label}`);
}

/** The maintainer paragraph (validated) or the engine default; an invalid maintainer prompt throws. */
export function measureInstruction(measure: MeasureBlock, fallback: string): string {
  if (measure.prompt === null) return fallback;
  const rendered = renderMeasurePrompt(measure.prompt);
  if (!rendered.ok) throw new Error(`measure prompt rejected: ${rendered.error}`);
  return rendered.value;
}

function prefixed<T>(r: Result<T>, at: string): Result<T> {
  return r.ok ? r : err(`${at}.${r.error}`);
}

/** Seeded distractor (key e.g. `distractor:<sub>:<family>`). */
export function makeDistractor(seed: string, key: string): Distractor {
  const pool = Array.from({ length: 90 }, (_, i) => i + 10);
  const numbers = seededShuffle(pool, seed, key).slice(0, DISTRACTOR_SIZE);
  return { numbers, answer: [...numbers].sort((a, b) => a - b) };
}

function parseRecall(text: string, shown: string, d: Distractor): Result<Recall> {
  const obj = parseFencedJson(text);
  if (!obj.ok) return obj;
  const sorted = obj.value['sorted'];
  if (!Array.isArray(sorted) || !sorted.every((n) => typeof n === 'number' && Number.isInteger(n))) return err('sorted: missing or not an integer array');
  if (sorted.length !== d.answer.length || sorted.some((n, i) => n !== d.answer[i])) return err('sorted: not the offered numbers in ascending order');
  const image = readCapped(obj.value, 'image', IMAGE_MAX);
  if (!image.ok) return image;
  if ([...image.value].length < IMAGE_MIN) return err(`image: shorter than ${IMAGE_MIN} chars`);
  const quote = readCapped(obj.value, 'quote', QUOTE_MAX);
  if (!quote.ok) return quote;
  if (!citedIn(quote.value, shown, MEASURE_QUOTE_MIN)) return err(`quote: not cited verbatim from the text (at least ${MEASURE_QUOTE_MIN} chars)`);
  return ok({ sorted: [...d.answer], image: image.value, quote: quote.value });
}

/** Recall TaskSpec (role ROLE_RECALL): text wrapped, the distractor numbers, then the image question; outputBlock. */
export function recallTask(text: string, distractor: Distractor, id: string, seed: string): TaskSpec<Recall> {
  const prompt = [
    '请读完下面这篇文字。',
    wrapped('recallTask', '文本甲', text, id, seed),
    '',
    `先完成一个无关的小任务：把下面 ${distractor.numbers.length} 个数从小到大排列。`,
    wrapped('recallTask', '数列', distractor.numbers.join('、'), id, seed),
    '',
    '然后不要回头看原文，写下这篇文字里你最先想起的一个画面——一个具体细节，不是主题或概括——并给出它在原文里的出处。',
    `画面 ${IMAGE_MIN}–${IMAGE_MAX} 字；出处逐字摘自原文，至少 ${MEASURE_QUOTE_MIN} 个字。`,
    '',
    outputBlock({ sorted: [11, 23, 47], image: `画面（${IMAGE_MIN}–${IMAGE_MAX}字）`, quote: `逐字原文（至少${MEASURE_QUOTE_MIN}字）` }),
  ].join('\n');
  return { id, role: ROLE_RECALL, prompt, parse: (t) => parseRecall(t, text, distractor) };
}

interface RecallMember {
  family: Family;
  recall: Recall;
  span: Span;
}

function groupFamilies(group: readonly RecallMember[]): Family[] {
  return [...new Set(group.map((m) => m.family))].sort(byCodeUnit);
}

function groupStart(group: readonly RecallMember[]): number {
  return Math.min(...group.map((m) => m.span.start));
}

/** Groups valid recalls into at most DETAIL_CAP details (ids D1…). */
export function recallDetails(recalls: ReadonlyArray<{ family: Family; recall: Recall }>, text: string, submission: string): Detail[] {
  const members: RecallMember[] = [];
  for (const r of [...recalls].sort((a, b) => byCodeUnit(a.family, b.family))) {
    const span = quoteSpan(r.recall.quote, text);
    if (span !== null) members.push({ family: r.family, recall: r.recall, span });
  }
  let groups: RecallMember[][] = [];
  for (const m of members) {
    const hit = groups.filter((g) => g.some((o) => spansOverlap(o.span, m.span, DETAIL_OVERLAP_MIN)));
    groups = [...groups.filter((g) => !hit.includes(g)), [...hit.flat(), m]];
  }
  groups.sort((a, b) => groupFamilies(b).length - groupFamilies(a).length || groupStart(a) - groupStart(b) || byCodeUnit(groupFamilies(a)[0] ?? '', groupFamilies(b)[0] ?? ''));
  const out: Detail[] = [];
  for (const g of groups.slice(0, DETAIL_CAP)) {
    const rep = [...g].sort((a, b) => a.span.start - b.span.start || byCodeUnit(a.family, b.family))[0];
    if (rep === undefined) continue;
    out.push({ id: `D${out.length + 1}`, submission, image: rep.recall.image, quote: rep.recall.quote, families: groupFamilies(g) });
  }
  return out;
}

/** Mechanical memory-hook score: share of the `valid` recalling families whose image sits in a detail named by ≥ 2 families. */
export function hookScore(details: readonly Detail[], valid: number): number | null {
  if (valid <= 0) return null;
  const shared = details.filter((d) => d.families.length >= 2).reduce((n, d) => n + d.families.length, 0);
  return shared / valid;
}

const SWAP_WORD: Readonly<Record<SkinNounKind, string>> = { character: '那人', area: '那地方', ship: '那艘船', civilization: '那一方', new: '那东西' };
const KIND_ORDER: readonly SkinNounKind[] = ['character', 'area', 'ship', 'civilization', 'new'];

/** The index after `key` when the NFKC chars from `at` spell it exactly, else -1. */
function matchAt(norm: readonly string[], at: number, key: string): number {
  let acc = '';
  let j = at;
  while (j < norm.length && acc.length < key.length) {
    acc += norm[j] ?? '';
    j += 1;
    if (!key.startsWith(acc)) return -1;
  }
  return acc === key ? j : -1;
}

/** Engine swap: every noun (longest first, NFKC-matched) → 那人 / 那地方 / 那艘船 / 那一方 / 那东西. */
export function skinSwapText(text: string, nouns: readonly SkinNoun[]): string {
  const terms: Array<{ key: string; kind: SkinNounKind }> = [];
  const sorted = nouns
    .map((n) => ({ key: n.term.trim().normalize('NFKC'), kind: n.kind }))
    .filter((n) => n.key !== '')
    .sort((a, b) => [...b.key].length - [...a.key].length || byCodeUnit(a.key, b.key) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  for (const n of sorted) if (!terms.some((t) => t.key === n.key)) terms.push(n);
  const chars = [...text];
  const norm = chars.map((c) => c.normalize('NFKC'));
  let out = '';
  let i = 0;
  while (i < chars.length) {
    let replaced = false;
    for (const t of terms) {
      const end = matchAt(norm, i, t.key);
      if (end === -1) continue;
      out += SWAP_WORD[t.kind];
      i = end;
      replaced = true;
      break;
    }
    if (!replaced) {
      out += chars[i] ?? '';
      i += 1;
    }
  }
  return out;
}

/**
 * The lineup: the brief row's card plus up to 3 other rows (seeded, key `<key>:rows`), cards in seeded order
 * (`<key>:order`), labelled 甲乙丙丁. Card texts are already swapped. null when the brief row has no card or no
 * other row has one (the measure is then void).
 */
export function skinLineup(brief: { rowId: string; text: string }, others: ReadonlyArray<{ rowId: string; text: string }>, seed: string, key: string): SkinLineup | null {
  const pool = [...others].filter((o) => o.rowId !== brief.rowId).sort((a, b) => byCodeUnit(a.rowId, b.rowId));
  const chosen = seededShuffle(pool, seed, `${key}:rows`).slice(0, SKIN_LABELS.length - 1);
  if (chosen.length === 0) return null;
  const order = seededShuffle([brief, ...chosen], seed, `${key}:order`);
  const cards: SkinLineup['cards'] = [];
  let answer: SkinLabel | null = null;
  for (const [i, c] of order.entries()) {
    const label = SKIN_LABELS[i];
    if (label === undefined) continue;
    cards.push({ label, rowId: c.rowId, text: c.text });
    if (c.rowId === brief.rowId) answer = label;
  }
  return answer === null ? null : { cards, answer };
}

/** Engine default instruction paragraphs (a maintainer `measures.<key>.prompt` replaces exactly this paragraph). */
export const DEFAULT_SKIN_PROMPT = '只凭场所、物件、习俗和人的做法判断，不要猜名字。';
export const DEFAULT_COLD_PROMPT = '回答三件事：我在哪里？谁想要什么、为此付出什么？读完我想去这个世界的哪里看看？每个回答都引原文；第三问可以回答“哪儿也不想去”。';

const COUNT_WORD: readonly string[] = ['零', '一', '两', '三', '四'];

function parseSkin(text: string, swapped: string, lineup: SkinLineup): Result<SkinVerdict> {
  const obj = parseFencedJson(text);
  if (!obj.ok) return obj;
  const labels = lineup.cards.map((c) => c.label);
  const raw = obj.value['pick'];
  const pick = typeof raw === 'string' ? raw.trim() : '';
  if (!isOneOf(pick, labels)) return err('pick: not one of the offered card labels');
  const quote = readCapped(obj.value, 'quote', QUOTE_MAX);
  if (!quote.ok) return quote;
  if (!citedIn(quote.value, swapped, MEASURE_QUOTE_MIN)) return err(`quote: not cited verbatim from the swapped text (at least ${MEASURE_QUOTE_MIN} chars)`);
  const reason = readCapped(obj.value, 'reason', REASON_MAX);
  if (!reason.ok) return reason;
  return ok({ pick, quote: quote.value, reason: reason.value, recognised: pick === lineup.answer });
}

/** Skin-swap TaskSpec (role ROLE_SKIN): swapped text, 【甲】…【丁】 cards, the measure prompt or the default; outputBlock. */
export function skinSwapTask(swapped: string, lineup: SkinLineup, measure: MeasureBlock, id: string, seed: string): TaskSpec<SkinVerdict> {
  const labels = lineup.cards.map((c) => c.label);
  if (labels.length < 2 || new Set(labels).size !== labels.length || !labels.includes(lineup.answer)) throw new Error('skinSwapTask: the lineup needs 2–4 distinct cards including the answer');
  const prompt = [
    '下面这篇文字里的专名都被换成了泛称。',
    wrapped('skinSwapTask', '文本甲', swapped, id, seed),
    '',
    `它写的是下列${COUNT_WORD[labels.length] ?? String(labels.length)}处中的哪一处？每张卡片是那一处在正典里的第一句描写，专名同样换成了泛称。`,
    ...lineup.cards.map((c) => `【${c.label}】\n${wrapped('skinSwapTask', `卡片${c.label}`, c.text, id, seed)}`),
    '',
    measureInstruction(measure, DEFAULT_SKIN_PROMPT),
    `pick 只能是 ${labels.join('、')} 之一；quote 逐字摘自上面那篇文字（不是卡片），至少 ${MEASURE_QUOTE_MIN} 个字；reason 不超过 ${REASON_MAX} 字。`,
    '',
    outputBlock({ pick: labels[0] ?? '甲', quote: `逐字原文（至少${MEASURE_QUOTE_MIN}字）`, reason: `理由（不超过${REASON_MAX}字）` }),
  ].join('\n');
  return { id, role: ROLE_SKIN, prompt, parse: (t) => parseSkin(t, swapped, lineup) };
}

function readObject(obj: JsonRecord, key: string): Result<JsonRecord> {
  const v = obj[key];
  return isRecord(v) ? ok(v) : err(`${key}: missing or not an object`);
}

function citedQuote(obj: JsonRecord, text: string): Result<string> {
  const quote = readCapped(obj, 'quote', QUOTE_MAX);
  if (!quote.ok) return quote;
  if (!citedIn(quote.value, text, MEASURE_QUOTE_MIN)) return err(`quote: not cited verbatim from the text (at least ${MEASURE_QUOTE_MIN} chars)`);
  return quote;
}

function parseCold(text: string, shown: string): Result<ColdRead> {
  const obj = parseFencedJson(text);
  if (!obj.ok) return obj;
  const where = readObject(obj.value, 'where');
  if (!where.ok) return where;
  const whereAnswer = prefixed(readCapped(where.value, 'answer', COLD_ANSWER_MAX), 'where');
  if (!whereAnswer.ok) return whereAnswer;
  const whereQuote = prefixed(citedQuote(where.value, shown), 'where');
  if (!whereQuote.ok) return whereQuote;
  const who = readObject(obj.value, 'who');
  if (!who.ok) return who;
  const name = prefixed(readCapped(who.value, 'name', COLD_NAME_MAX), 'who');
  if (!name.ok) return name;
  const wants = prefixed(readCapped(who.value, 'wants', COLD_ANSWER_MAX), 'who');
  if (!wants.ok) return wants;
  const cost = prefixed(readCappedOrNull(who.value, 'cost', COLD_ANSWER_MAX), 'who');
  if (!cost.ok) return cost;
  const whoQuote = prefixed(citedQuote(who.value, shown), 'who');
  if (!whoQuote.ok) return whoQuote;
  const go = readObject(obj.value, 'go');
  if (!go.ok) return go;
  const goAnswer = prefixed(readCappedOrNull(go.value, 'answer', COLD_ANSWER_MAX), 'go');
  if (!goAnswer.ok) return goAnswer;
  const goRaw = prefixed(readCappedOrNull(go.value, 'quote', QUOTE_MAX), 'go');
  if (!goRaw.ok) return goRaw;
  if ((goAnswer.value === null) !== (goRaw.value === null)) return err('go: answer and quote must both be null or both be set');
  if (goRaw.value !== null && !citedIn(goRaw.value, shown, MEASURE_QUOTE_MIN)) return err(`go.quote: not cited verbatim from the text (at least ${MEASURE_QUOTE_MIN} chars)`);
  return ok({
    where: { answer: whereAnswer.value, quote: whereQuote.value },
    who: { name: name.value, wants: wants.value, cost: cost.value, quote: whoQuote.value },
    go: { answer: goAnswer.value, quote: goRaw.value },
    clarity: 2 + (goAnswer.value === null ? 0 : 1),
  });
}

/** Cold-reader TaskSpec (role ROLE_COLD): only the text, no canon, no brief. */
export function coldReaderTask(text: string, measure: MeasureBlock, id: string, seed: string): TaskSpec<ColdRead> {
  const prompt = [
    '你第一次读到这段文字，对它所在的世界一无所知。',
    wrapped('coldReaderTask', '文本甲', text, id, seed),
    '',
    measureInstruction(measure, DEFAULT_COLD_PROMPT),
    `where.answer、who.wants、who.cost、go.answer 各不超过 ${COLD_ANSWER_MAX} 字，who.name 不超过 ${COLD_NAME_MAX} 字；说不出代价时 who.cost 写 null。每个 quote 逐字摘自原文，至少 ${MEASURE_QUOTE_MIN} 个字；哪儿也不想去时 go.answer 与 go.quote 都写 null。`,
    '',
    outputBlock({
      where: { answer: `我在哪里（不超过${COLD_ANSWER_MAX}字）`, quote: '逐字原文' },
      who: { name: '人名或称呼', wants: '想要什么', cost: '付出什么，或 null', quote: '逐字原文' },
      go: { answer: '想去哪里看看，或 null', quote: '逐字原文，或 null' },
    }),
  ].join('\n');
  return { id, role: ROLE_COLD, prompt, parse: (t) => parseCold(t, text) };
}

/** CHECKLIST_BASE + benchmark interface_checklist_extra as X1…. */
export function checklistItems(extra: readonly string[]): ChecklistItem[] {
  return [...CHECKLIST_BASE, ...extra.map((text, i) => ({ id: `X${i + 1}`, text: text.trim() }))];
}

function parseProducer(text: string, items: readonly ChecklistItem[]): Result<ProducerVerdict> {
  const obj = parseFencedJson(text);
  if (!obj.ok) return obj;
  const list = obj.value['items'];
  if (!Array.isArray(list)) return err('items: missing or not an array');
  const wanted = items.map((i) => i.id);
  const got = new Map<string, ProducerItem>();
  for (const [i, item] of list.entries()) {
    const at = `items[${i}]`;
    if (!isRecord(item)) return err(`${at}: not an object`);
    const rawId = item['id'];
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!wanted.includes(id)) return err(`${at}.id: not one of the requested checklist ids`);
    if (got.has(id)) return err(`${at}.id: answered twice`);
    const okValue = item['ok'];
    if (typeof okValue !== 'boolean') return err(`${at}.ok: missing or not a boolean`);
    const missing = prefixed(readCappedOrNull(item, 'missing', MISSING_MAX), at);
    if (!missing.ok) return missing;
    if (okValue && missing.value !== null) return err(`${at}: ok true needs missing null`);
    if (!okValue && missing.value === null) return err(`${at}: ok false needs a missing note`);
    got.set(id, { id, ok: okValue, missing: missing.value });
  }
  const out: ProducerItem[] = [];
  for (const id of wanted) {
    const item = got.get(id);
    if (item === undefined) return err(`items: requested id ${id} is not answered`);
    out.push(item);
  }
  return ok({ items: out, allOk: out.every((i) => i.ok) });
}

/** Every string of a JSON value typeset like the judged text (anonymizeText); keys and structure kept. */
function typesetJson(value: unknown): unknown {
  if (typeof value === 'string') return anonymizeText(value);
  if (Array.isArray(value)) return value.map(typesetJson);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typesetJson(v)]));
  return value;
}

/** The interface card as the producer sees it: the parsed shots / object / hook only (no extra writer keys), typeset. */
function shownInterface(iface: InterfaceCard): JsonRecord {
  return { shots: iface.shots.map(typesetJson), object: typesetJson(iface.object), hook: typesetJson(iface.hook) };
}

/** Producer TaskSpec (role ROLE_PRODUCER): 【接口卡】 shownInterface pretty-printed, the text (context only), 【检查项】; ids must equal `items`. */
export function producerTask(iface: InterfaceCard, text: string, items: readonly ChecklistItem[], id: string, seed: string): TaskSpec<ProducerVerdict> {
  if (items.length === 0 || new Set(items.map((i) => i.id)).size !== items.length) throw new Error('producerTask: checklist ids must be non-empty and distinct');
  const prompt = [
    '你是美术与关卡制作负责人。逐项判断：只凭这张接口卡，美术或关卡能不能不问任何问题就开工？',
    '【接口卡】',
    wrapped('producerTask', '接口卡', JSON.stringify(shownInterface(iface), null, 2), id, seed),
    '',
    '【正文】（只作背景，判断只看接口卡）',
    wrapped('producerTask', '文本甲', text, id, seed),
    '',
    '【检查项】（编号｜说明）',
    wrapped('producerTask', '检查项', items.map((i) => `${i.id}｜${i.text}`).join('\n'), id, seed),
    '',
    `每个检查项恰好回答一次，id 照抄编号；能开工写 ok: true、missing: null；不能开工写 ok: false，missing 用不超过 ${MISSING_MAX} 字说明缺什么。`,
    '',
    outputBlock({ items: [{ id: 'S1.地点', ok: true, missing: null }, { id: 'O.状态', ok: false, missing: `缺什么（不超过${MISSING_MAX}字）` }] }),
  ].join('\n');
  return { id, role: ROLE_PRODUCER, prompt, parse: (t) => parseProducer(t, items) };
}

/** Play types a hook may name (never 固定主线). */
export const PLAY_TYPES: readonly string[] = ['经营', '战略与战斗', '探索', '生成支线'];
/** The 地点 marker of a 母舰 shot whose space has no concept page yet (separator-insensitive). */
export const NEW_SPACE_MARKER = '新空间·需概念任务';

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter((x) => x !== '') : [];
}

function fieldOf(rec: JsonRecord | null, key: string): unknown {
  return rec !== null && Object.hasOwn(rec, key) ? rec[key] : undefined;
}

const SEPARATORS = /[\s·・•‧･.\-—]/gu;

/**
 * Engine Layer-3 checks (≥ 2 verbs, ≥ 2 states, ≥ 2 options incl. 拒绝, play-type enum, 母舰 place rule); the failed
 * check names, [] = pass. Place rule: every shot names a 地点; in a 母舰 cell (row SHIP) a shot that names a new space
 * (新空间) must carry the marker 新空间·需概念任务 (the concept-page list lives outside the engine).
 */
export function interfaceChecks(iface: InterfaceCard, brief: Pick<BriefJson, 'row_id' | 'cell'>): string[] {
  const failed: string[] = [];
  if (stringList(fieldOf(iface.object, '玩家动词')).length < 2) failed.push('object.verbs');
  if (stringList(fieldOf(iface.object, '状态')).length < 2) failed.push('object.states');
  const options = stringList(fieldOf(iface.hook, '选项'));
  if (options.length < 2) failed.push('hook.options');
  if (!options.some((o) => o.normalize('NFKC').includes('拒绝'))) failed.push('hook.refusal');
  const play = fieldOf(iface.hook, '玩法类型');
  if (typeof play !== 'string' || !PLAY_TYPES.includes(play.trim())) failed.push('hook.play_type');
  const ship = brief.row_id === 'SHIP' || brief.cell.row_id === 'SHIP';
  const marker = NEW_SPACE_MARKER.replace(SEPARATORS, '');
  const placeOk = iface.shots.length > 0 && iface.shots.every((shot) => {
    const place = fieldOf(shot, '地点');
    if (typeof place !== 'string' || place.trim() === '') return false;
    const key = place.normalize('NFKC').replace(SEPARATORS, '');
    return !ship || !key.includes('新空间') || key.includes(marker);
  });
  if (!placeOk) failed.push('shots.place');
  return failed;
}

/** A maintainer measure prompt: err when it holds a `{…}` slot or a ``` fence; otherwise the trimmed paragraph. Shared with bench validate. */
export function renderMeasurePrompt(prompt: string): Result<string> {
  const trimmed = prompt.trim();
  if (trimmed === '') return err('measure prompt: empty');
  const key = trimmed.normalize('NFKC');
  if (/[{}]/u.test(key)) return err('measure prompt: holds a {slot} brace; measure prompts take no slots');
  if (key.includes('```')) return err('measure prompt: holds a code fence');
  return ok(trimmed);
}
