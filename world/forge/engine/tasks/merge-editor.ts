import { isRecord, type JsonRecord } from '../json.ts';
import { carriesQuote, mergecheck, sentencesCarrying, type MergeConstants, type MergeDecision, type MergeSource } from '../mergecheck.ts';
import { err, ok, type Result } from '../result.ts';
import type { TaskSpec } from '../task.ts';
import { normalizeForQuote, sentenceKey, splitSentences, stripMarkdown } from '../text.ts';
import { isOneOf, mustWrap, outputBlock, parseFencedJson } from './fenced.ts';
import { taskId } from './ids.ts';
import { ROLE_MERGE } from './roles.ts';
/**
 * 10b merge editor (plan §8, s5 §4.2; PR-D group D1). The editor (`ctx.backends.mergeEditor`, ROLE_MERGE) only picks
 * and orders numbered sentences; the engine renders the 09 scene, the 07 §8 rows and the 01–06 index lines, and
 * `parse` = parseMergePlan → renderMerge → in-memory mergecheck, so the one retry also covers a plan that fails
 * mergecheck. Two failures → fallbackPlan, flagged `editor: "fallback"`.
 */

export type MergePath = '标准成功路径' | '与路径无关';

/** One body position: a numbered base sentence, or every donor sentence of one Rxx (in donor order). */
export type PlanItem =
  | { from: 'base'; index: number; connective: string | null }
  | { from: 'donor'; rxx: string; connective: string | null };

/** The editor's JSON block (snake_case, stored as `merge/<d8>/plan.json` `plan`). */
export interface MergePlan {
  /** 1–TITLE_MAX code points, no ｜ or newline. */
  title: string;
  /** `D\d+—D\d+中的任一常态日` | `D\d+` | `任一常态日`. */
  time_anchor: string;
  path: MergePath;
  body: PlanItem[];
  /** Body positions followed by a blank line. */
  paragraph_breaks: number[];
}

/** Everything the editor prompt, renderer and in-memory mergecheck need (built by merge.ts loadMergeSources). */
export interface MergeSources {
  round: string;
  /** mergeDecisionFrom's decision; `title` is '' here (the plan supplies it). */
  decision: MergeDecision;
  /** Decision.happened: 地位 `已选地方事实·已发生事件` iff true. */
  happened: boolean;
  /** sourcesFromRound order (labels, then BASE). */
  sources: MergeSource[];
  /** map rows + character alias rows (mergecheck rowIds). */
  rowIds: string[];
  /** Canon Markdown at start.base_sha, world/current-relative (canonFiles keys ∪ 09; '' = absent). */
  before: Record<string, string>;
  /** brief.cell title (fallback title, cut to TITLE_MAX). */
  cellTitle: string;
  constants: MergeConstants;
}

/** Numbered prompt material: base sentences `[0]…[n]`, donor sentences per Rxx, 07 §7 time anchors. */
export interface EditorMaterial {
  base: string[];
  donors: Record<string, string[]>;
  timeAnchors: string[];
}

/** Rendered canon: world/current-relative path → full new content (09, 07, touched 01–06 only). */
export interface CanonEdit {
  files: Record<string, string>;
  /** The new 09 scene section (header lines + body), as appended. */
  scene: string;
  /** Registered Rxx in order (`RNN-01`…); [] = 本场登记事实：无. */
  rxx: string[];
}

export interface EditorResult {
  plan: MergePlan;
  edit: CanonEdit;
}

export const TITLE_MAX = 24;

/** world/current-relative merge targets (mergecheck's SCENES_PATH / REGISTER_PATH). */
export const SCENES_PATH = 'reference/09-scenes-and-people.md';
export const REGISTER_PATH = 'reference/07-register-and-creation.md';
/** 01–06 reference files: index-line targets (mergecheck INDEXED_PATH). */
const INDEXED_PATH = /^reference\/0[1-6]-[^/]+\.md$/u;
const TIME_ANCHOR = /^(?:D\d+—D\d+中的任一常态日|D\d+|任一常态日)$/u;
const TIME_ANCHOR_IN_TEXT = /D\d+—D\d+中的任一常态日/gu;
const DEFAULT_ANCHOR = '任一常态日';
const PATHS: readonly MergePath[] = ['标准成功路径', '与路径无关'];
const HAPPENED = '已选地方事实·已发生事件';
const EXAMPLE = '状态与路径实例·示例';
/** The 07 延伸自 cell of a fact without extends (mergecheck EMPTY_EXTENDS). */
const EMPTY_EXTENDS = '无';
const CONNECTIVE_MAX = 12;
const BODY_MAX = 400;
const FALLBACK_TITLE = '样本现场';
/** Significant characters a source quote needs (mergecheck MIN_QUOTE_CHARS). */
const MIN_QUOTE_CHARS = 4;

/** `merge-<d8>` (routing kind `merge`). */
export function mergeEditorTaskId(d8: string): string {
  return taskId(`merge-${d8}`);
}

function baseSource(src: MergeSources): MergeSource | undefined {
  return src.sources.find((s) => s.label === src.decision.baseLabel);
}

/** Registered facts with their delta fields, in decision order (unknown facts skipped: mergecheck reports them). */
function registeredFacts(src: MergeSources): Array<{ rxx: string; label: string; fact: MergeSource['facts'][number] }> {
  return src.decision.registered.flatMap((r) => {
    const fact = src.sources.find((s) => s.label === r.label)?.facts.find((f) => f.id === r.factId);
    return fact === undefined ? [] : [{ rxx: r.rxx, label: r.label, fact }];
  });
}

/** Base sentences = splitSentences(stripMarkdown(base.submission)); donor sentences = mergecheck sentencesCarrying(donor, quote). */
export function editorMaterial(src: MergeSources): EditorMaterial {
  const base = splitSentences(stripMarkdown(baseSource(src)?.submission ?? ''));
  const donors: Record<string, string[]> = {};
  for (const r of registeredFacts(src)) {
    if (r.label === src.decision.baseLabel) continue;
    donors[r.rxx] = sentencesCarrying(src.sources.find((s) => s.label === r.label)?.submission ?? '', r.fact.sourceQuote);
  }
  const found = (src.before[REGISTER_PATH] ?? '').match(TIME_ANCHOR_IN_TEXT) ?? [];
  return { base, donors, timeAnchors: [...new Set([DEFAULT_ANCHOR, ...found])] };
}

function isIndex(v: unknown, length: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < length;
}

function parseConnective(v: unknown): Result<string | null> {
  if (v === null || v === undefined) return ok(null);
  if (typeof v !== 'string' || v === '' || [...v].length > CONNECTIVE_MAX || /[\r\n]/u.test(v)) return err('must be null or a short string without line breaks');
  return ok(v);
}

function parseItem(raw: unknown, i: number, material: EditorMaterial): Result<PlanItem> {
  const at = `body[${i}]`;
  if (!isRecord(raw)) return err(`${at}: not an object`);
  const connective = parseConnective(raw['connective']);
  if (!connective.ok) return err(`${at}.connective: ${connective.error}`);
  if (raw['from'] === 'base') {
    if (!isIndex(raw['index'], material.base.length)) return err(`${at}.index: not a base sentence number (0-${material.base.length - 1})`);
    return ok({ from: 'base', index: raw['index'], connective: connective.value });
  }
  if (raw['from'] === 'donor') {
    const rxx = raw['rxx'];
    if (typeof rxx !== 'string' || !Object.hasOwn(material.donors, rxx)) return err(`${at}.rxx: not a listed donor fact id`);
    return ok({ from: 'donor', rxx, connective: connective.value });
  }
  return err(`${at}.from: must be "base" or "donor"`);
}

/** Exactly one ```json block; ASCII errors that never echo model text. */
export function parseMergePlan(text: string, material: EditorMaterial): Result<MergePlan> {
  const obj = parseFencedJson(text);
  if (!obj.ok) return obj;
  const v = obj.value;
  const title = v['title'];
  if (typeof title !== 'string' || title.trim() === '' || [...title].length > TITLE_MAX || /[｜|\r\n]/u.test(title)) {
    return err(`title: must be 1-${TITLE_MAX} characters without a bar or line break`);
  }
  const anchor = v['time_anchor'];
  if (typeof anchor !== 'string' || !TIME_ANCHOR.test(anchor)) return err('time_anchor: not an allowed time anchor form');
  const path = v['path'];
  if (typeof path !== 'string' || !isOneOf(path, PATHS)) return err('path: not one of the two path values');
  const list = v['body'];
  if (!Array.isArray(list) || list.length === 0 || list.length > BODY_MAX) return err(`body: must be an array of 1-${BODY_MAX} items`);
  const body: PlanItem[] = [];
  for (const [i, raw] of list.entries()) {
    const item = parseItem(raw, i, material);
    if (!item.ok) return item;
    body.push(item.value);
  }
  const breaksRaw = v['paragraph_breaks'] ?? [];
  if (!Array.isArray(breaksRaw)) return err('paragraph_breaks: not an array');
  const breaks: number[] = [];
  for (const [i, b] of breaksRaw.entries()) {
    if (!isIndex(b, body.length)) return err(`paragraph_breaks[${i}]: not a body position`);
    if (breaks.includes(b)) return err(`paragraph_breaks[${i}]: repeated`);
    breaks.push(b);
  }
  return ok({ title, time_anchor: anchor, path, body, paragraph_breaks: breaks.sort((a, b) => a - b) });
}

/** One body position's sentences: the base sentence, or every unused donor sentence of the Rxx; the connective goes first. */
function itemSentences(item: PlanItem, material: EditorMaterial, baseKeys: ReadonlySet<string>, used: Set<string>): string[] {
  let sentences: string[];
  if (item.from === 'base') {
    sentences = [material.base[item.index] ?? ''].filter((s) => s !== '');
  } else {
    // A donor sentence that is also a base sentence, or already placed, would read as a repeat: mergecheck matches it once.
    sentences = (material.donors[item.rxx] ?? []).filter((s) => !baseKeys.has(sentenceKey(s)) && !used.has(sentenceKey(s)));
    for (const s of sentences) used.add(sentenceKey(s));
  }
  return sentences.map((s, i) => (i === 0 ? `${item.connective ?? ''}${s}` : s));
}

/** True when splitSentences ends a sentence after `text` (terminator, closers included); false for a bare line. */
function endsSentence(text: string): boolean {
  return splitSentences(`${text}续`).length > splitSentences(text).length;
}

/**
 * Plan breaks become blank lines. A sentence without a terminator (the source split it at a line break) also ends
 * its paragraph: joined to the next sentence it would read as one sentence no source has.
 */
function sceneBody(plan: MergePlan, material: EditorMaterial): string {
  const baseKeys = new Set(material.base.map(sentenceKey));
  const used = new Set<string>();
  const paragraphs: string[] = [];
  let current = '';
  plan.body.forEach((item, i) => {
    for (const sentence of itemSentences(item, material, baseKeys, used)) {
      current += sentence;
      if (!endsSentence(sentence)) {
        paragraphs.push(current);
        current = '';
      }
    }
    if (plan.paragraph_breaks.includes(i) && current !== '') {
      paragraphs.push(current);
      current = '';
    }
  });
  if (current !== '') paragraphs.push(current);
  return paragraphs.join('\n\n');
}

/** Appends `line` as its own paragraph (a blank line above it). */
function appendParagraph(text: string, line: string): string {
  return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${text === '' ? '' : '\n'}${line}\n`;
}

/** The 01–06 file an `attaches_to` value names by its two-digit prefix, among the non-empty files at base. */
function indexTarget(attachesTo: string, before: Readonly<Record<string, string>>): string | null {
  const nn = /^0[1-6](?=-|$|\s|[^\d])/u.exec(attachesTo.trim())?.[0];
  if (nn === undefined) return null;
  const hits = Object.keys(before).filter((p) => INDEXED_PATH.test(p) && p.startsWith(`reference/${nn}-`) && (before[p] ?? '') !== '');
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/** Pure: 09 header + body, 07 §8 rows from delta fields, `现场：见09 §RNN（…）` index lines, first-merge openings. */
export function renderMerge(plan: MergePlan, src: MergeSources): CanonEdit {
  const c = src.constants;
  const d = src.decision;
  const facts = registeredFacts(src);
  const rxx = d.registered.map((r) => r.rxx);
  const status = src.happened ? HAPPENED : EXAMPLE;
  const header = `## ${d.round}｜${plan.title}\n\n地点：${d.rows[0] ?? ''}｜时间锚：${plan.time_anchor}｜路径依赖：${plan.path}｜地位：${status}｜本场登记事实：${rxx.length === 0 ? '无' : rxx.join('、')}`;
  const scene = `${header}\n\n${sceneBody(plan, editorMaterial(src))}\n`;
  const files: Record<string, string> = {};
  const before09 = src.before[SCENES_PATH] ?? '';
  files[SCENES_PATH] = before09 === '' ? `${c.preamble09}\n\n${scene}` : `${before09}${before09.endsWith('\n') ? '' : '\n'}\n${scene}`;
  if (facts.length > 0) {
    const before07 = src.before[REGISTER_PATH] ?? '';
    const opening = before07.includes(c.pointer07) ? '' : `\n${c.pointer07}\n\n${c.heading8}\n\n${c.tableHeader8}\n`;
    const rows = facts.map(({ rxx: id, fact: f }) => `| ${id} | ${f.rowId} | ${f.claim} | ${f.status} | ${f.attachesTo} | ${f.extends.trim() === '' ? EMPTY_EXTENDS : f.extends} | ${f.misuse} | ${d.round} |\n`);
    files[REGISTER_PATH] = `${before07}${opening}${rows.join('')}`;
  }
  const byFile = new Map<string, string[]>();
  for (const f of facts) {
    const target = indexTarget(f.fact.attachesTo, src.before);
    if (target !== null) byFile.set(target, [...(byFile.get(target) ?? []), f.rxx]);
  }
  for (const [path, ids] of [...byFile].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    files[path] = appendParagraph(src.before[path] ?? '', `现场：见09 §${d.round}（${ids.join('、')}）`);
  }
  return { files, scene, rxx };
}

/** In-memory mergecheck of a rendered edit against `src.before` (decision title = plan.title); [] = passes. */
export function renderedViolations(plan: MergePlan, edit: CanonEdit, src: MergeSources): string[] {
  const decision: MergeDecision = { ...src.decision, title: plan.title };
  return mergecheck({ constants: src.constants, rowIds: [...src.rowIds], decision, sources: src.sources, before: src.before, after: { ...src.before, ...edit.files } }).violations;
}

const SHAPE: JsonRecord = {
  title: `不超过 ${TITLE_MAX} 字的小标题`,
  time_anchor: DEFAULT_ANCHOR,
  path: '标准成功路径',
  body: [{ from: 'base', index: 0, connective: null }, { from: 'donor', rxx: 'R01-02', connective: '同一天，' }],
  paragraph_breaks: [0],
};

/** Base sentence numbers that carry a base-registered fact's source quote (the editor must keep them). */
function mustKeep(src: MergeSources, material: EditorMaterial): number[] {
  const quotes = registeredFacts(src).filter((r) => r.label === src.decision.baseLabel).map((r) => r.fact.sourceQuote);
  return material.base.flatMap((s, i) => (quotes.some((q) => carriesQuote(s, q)) ? [i] : []));
}

function editorPrompt(src: MergeSources, material: EditorMaterial, id: string, seed: string): string {
  const d = src.decision;
  const baseLines = material.base.map((s, i) => `[${i}] ${s}`).join('\n');
  const donorLines = Object.entries(material.donors).map(([rxx, sentences]) => `${rxx}：${sentences.join('')}`).join('\n') || '（无）';
  const facts = registeredFacts(src).map((r) => `${r.rxx}（${r.label === d.baseLabel ? '底稿自带' : `借自 ${r.label}`}）：${r.fact.claim}`).join('\n') || '（无）';
  const keep = mustKeep(src, material);
  return [
    '你是合并编辑。只能挑选、排序下列句子，不得改写任何字，也不得新写句子。引擎会把你挑出的句子逐字拼成正典里的一场样本现场。',
    '',
    `【场景】${src.cellTitle}（地点行 ${d.rows[0] ?? ''}，第 ${d.round} 轮）`,
    '',
    '【底稿句子】（编号从 0 开始）',
    mustWrap('merge-editor', '底稿', baseLines, seed, `${id}:底稿`),
    '',
    '【借入句子】（每个编号下的句子会整组放进正文）',
    mustWrap('merge-editor', '借入', donorLines, seed, `${id}:借入`),
    '',
    '【本场登记事实】',
    mustWrap('merge-editor', '登记', facts, seed, `${id}:登记`),
    '',
    `【可用连接词】${src.constants.connectives.join('、')}`,
    `【可用时间锚】${material.timeAnchors.join('、')}`,
    '',
    '# 规则',
    '1. body 按正文顺序列出句子：底稿句子写 {"from": "base", "index": 编号}，借入句子写 {"from": "donor", "rxx": 编号}。',
    `2. 底稿句子必须保持原来的先后顺序，可以删去，不能重复；${keep.length === 0 ? '可以删去任何底稿句子' : `这些底稿句子必须保留：${keep.map((i) => `[${i}]`).join('、')}`}。`,
    `3. 每个借入编号必须在 body 里恰好出现一次${Object.keys(material.donors).length === 0 ? '（本场没有借入句子）' : ''}。`,
    `4. connective 只能取上面的连接词之一或写 null，它会接在该句之前；每 500 字最多 ${src.constants.maxJointsPer500} 个连接词。`,
    `5. title 为 1–${TITLE_MAX} 字的小标题，不含｜；time_anchor 取上面的时间锚之一；path 写 标准成功路径 或 与路径无关。`,
    '6. paragraph_breaks 列出其后要空一行分段的 body 位置（从 0 开始）。',
    '',
    outputBlock(SHAPE),
  ].join('\n');
}

/** Chinese prompt ending with outputBlock; retryPrompt quotes the parse / mergecheck error. */
export function mergeEditorTask(src: MergeSources, id: string, seed: string): TaskSpec<EditorResult> {
  const material = editorMaterial(src);
  const prompt = editorPrompt(src, material, id, seed);
  return {
    id,
    role: ROLE_MERGE,
    prompt,
    parse: (text) => {
      const plan = parseMergePlan(text, material);
      if (!plan.ok) return plan;
      const bad = plan.value.body.findIndex((item) => item.connective !== null && !src.constants.connectives.includes(item.connective));
      if (bad >= 0) return err(`body[${bad}].connective: not one of the listed connectives`);
      const edit = renderMerge(plan.value, src);
      const violations = renderedViolations(plan.value, edit, src);
      if (violations.length > 0) return err(`mergecheck: ${violations.join('; ')}`);
      return ok({ plan: plan.value, edit });
    },
    retryPrompt: (error) => `${prompt}\n\n上一次的输出没有通过检查：${error}\n请只改正这些问题，按同样的形状重新输出。`,
  };
}

/** Base positions after which the base text had a paragraph break (sentence counts per stripped paragraph). */
function baseBreaks(submission: string, start: number, count: number): number[] {
  const paragraphs = stripMarkdown(submission).split(/\n[ \t]*\n/u).map((p) => splitSentences(p).length);
  if (paragraphs.reduce((a, b) => a + b, 0) !== count) return [];
  const out: number[] = [];
  let end = -1;
  for (const n of paragraphs.slice(0, -1)) {
    end += n;
    if (n > 0 && end - start >= 0) out.push(end - start);
  }
  return [...new Set(out)];
}

/** Deterministic: base sentences minus a leading title line, donor blocks appended in Rxx order, 任一常态日, 标准成功路径. */
export function fallbackPlan(src: MergeSources): MergePlan {
  const material = editorMaterial(src);
  const submission = baseSource(src)?.submission ?? '';
  const firstLine = submission.split('\n').find((l) => l.trim() !== '') ?? '';
  const title = /^\s{0,3}#{1,6}\s/u.test(firstLine) && sentenceKey(material.base[0] ?? '') === sentenceKey(stripMarkdown(firstLine).trim());
  const start = title && material.base.length > 1 && !mustKeep(src, material).includes(0) ? 1 : 0;
  const body: PlanItem[] = material.base.slice(start).map((_, i) => ({ from: 'base', index: start + i, connective: null }));
  const breaks = baseBreaks(submission, start, material.base.length).filter((b) => b < body.length - 1);
  const donors = src.decision.registered.map((r) => r.rxx).filter((rxx) => Object.hasOwn(material.donors, rxx));
  if (donors.length > 0 && body.length > 0) breaks.push(body.length - 1);
  for (const rxx of donors) body.push({ from: 'donor', rxx, connective: null });
  const cut = [...src.cellTitle.replace(/[｜|\r\n]/gu, '')].slice(0, TITLE_MAX).join('').trim();
  return { title: cut === '' ? FALLBACK_TITLE : cut, time_anchor: DEFAULT_ANCHOR, path: '标准成功路径', body, paragraph_breaks: [...new Set(breaks)].sort((a, b) => a - b) };
}

/**
 * Why no plan, LLM or fallback, can merge this decision; [] = mergeable. 10a runs it for every decision (base-only
 * ones included) and rewinds on any line, so an unmergeable decision reaches the owner instead of failing 10b on
 * every rerun: a 07 cell with `|` or a line break, a too-short quote, a donor quote no single donor sentence
 * carries (mergecheck carriesQuote, the donor rule), the fixture claim; then, as a backstop, the fallback plan's own
 * mergecheck.
 */
export function mergeability(src: MergeSources, fixtureClaim: string): string[] {
  const out: string[] = [];
  const material = editorMaterial(src);
  const fixture = normalizeForQuote(fixtureClaim);
  for (const { rxx, label, fact } of registeredFacts(src)) {
    const cells: Array<[string, string]> = [
      ['claim', fact.claim], ['status', fact.status], ['row_id', fact.rowId], ['attaches_to', fact.attachesTo], ['extends', fact.extends], ['misuse', fact.misuse],
    ];
    for (const [name, value] of cells) if (/[|\r\n]/u.test(value)) out.push(`${rxx}: ${name} contains | or a line break`);
    if ([...normalizeForQuote(fact.sourceQuote)].length < MIN_QUOTE_CHARS) out.push(`${rxx}: source quote is too short`);
    const sentences = label === src.decision.baseLabel ? material.base.filter((s) => carriesQuote(s, fact.sourceQuote)) : (material.donors[rxx] ?? []);
    if (label !== src.decision.baseLabel && sentences.length === 0) out.push(`${rxx}: no donor sentence carries the whole source quote`);
    if (fixture !== '' && [fact.claim, ...sentences].some((t) => normalizeForQuote(t).includes(fixture))) out.push(`${rxx}: repeats the fixture fact`);
  }
  if (out.length > 0) return out;
  const plan = fallbackPlan(src);
  return renderedViolations(plan, renderMerge(plan, src), src).map((v) => `fallback plan: ${v}`);
}
