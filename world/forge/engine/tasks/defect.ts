import { anonymizeText } from '../anonymize.ts';
import type { DefectType, FixtureRxx } from '../protocol.ts';
import { err, ok, type Result } from '../result.ts';
import { FACT_STATUSES, forbiddenRows, type BriefJson, type FactRow, type ForbiddenRow, type RegressionRow } from '../steps/brief.ts';
import { seededShuffle } from '../store.ts';
import type { TaskSpec } from '../task.ts';
import { normalizeForQuote, sentenceKey, splitSentences } from '../text.ts';
import { outputBlock, occursExactly, parseFencedJson, mustWrap, readCapped, type Span } from './fenced.ts';
import { DEFECT_OVERLAP_MIN } from './gate-judge.ts';
import { ROLE_DEFECT } from './roles.ts';

/**
 * Defect writer (s2 §3.4, PROTOCOL §2): the model returns one sentence swap, the engine applies it. One seeded type
 * and one copy per round, of one seeded gate-bound submission; the copy goes only to that submission's gate judges.
 */

export type { DefectType };

/**
 * A brief forbidden move is a D3 target iff it holds one of these. They paraphrase the PROTOCOL D3 text (未登记的第三方势力 /
 * 早于先遣队的人工痕迹) and the two DEFAULT_FORBIDDEN moves; defect.test.ts pins both, so a rewording fails a test instead of
 * silently disabling D3.
 */
export const D3_KEYWORDS: readonly string[] = ['第三方', '先遣队'];

/** A replacement sentence may be at most this many times the original's length (code points). */
export const DEFECT_MAX_GROWTH = 1.5;

/**
 * What the defect writer may contradict. D1: brief F-IDs whose status ≠ 状态与路径实例 (F14 excluded); D4: brief
 * Rxx rows (kind `registered`), or the protocol fixture-rxx row in a round-0 drill; D2: live regression quotes;
 * D3: the brief forbidden moves holding a D3_KEYWORDS word, by X-id (the gate pack lists the same rows, so a judge
 * can name the id a D3 copy contradicts).
 */
export type DefectTargets =
  | { kind: 'facts'; facts: FactRow[] }
  | { kind: 'regression'; regression: RegressionRow[] }
  | { kind: 'forbidden'; rows: ForbiddenRow[] };

/** The model's answer `{sentence_no, original, replacement, against}` after validation. */
export interface DefectPlan {
  /** 1-based index into splitSentences(subDisplay). */
  sentenceNo: number;
  original: string;
  replacement: string;
  /** One of targetIds(targets). */
  against: string;
}

/** The applied defect (`gate/defect.json` carries it with the task id and status). */
export interface Defect {
  submission: string;
  /** Full display text with the one sentence replaced. */
  copy: string;
  /** The replacement sentence. */
  injected: string;
  /** Span of `injected` in normalizeForQuote(copy) coordinates (tasks/fenced.ts quoteSpan). */
  injectedSpan: Span;
  /** D1…D4. */
  type: string;
  against: string;
}


const PATH_INSTANCE = '状态与路径实例';
const TEXT_MAX = 2000;
const AGAINST_MAX = 40;
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function codePoints(text: string): number {
  return [...text].length;
}

/** fixture-rxx as a registered FactRow (id = fixture.rxx, status from the block; binding like any Rxx). */
export function fixtureRxxRow(fixture: FixtureRxx): FactRow {
  const status = FACT_STATUSES.find((s) => s === fixture.status);
  if (status === undefined) throw new Error('fixture-rxx: status is not one of the four fact statuses');
  return { id: fixture.rxx, kind: 'registered', text: fixture.claim, status, rows: [fixture.rowId] };
}

/**
 * The targets a type offers for this brief; `fixture` non-null only in a round-0 drill (D4 against fixture-rxx).
 * `requires: "rxx"` types offer the brief's registered rows (+ fixture-rxx); D1 the F-IDs whose status is not
 * 状态与路径实例; D2 the live regression quotes; D3 the forbidden moves naming a third party or pre-advance-party traces
 * (none → D3 is not enabled this round). Any other type offers nothing (never picked).
 */
export function defectTargets(type: DefectType, brief: Pick<BriefJson, 'facts' | 'regression' | 'forbidden'>, fixture: FixtureRxx | null): DefectTargets {
  if (type.requires === 'rxx') {
    const rows = brief.facts.filter((f) => f.kind === 'registered');
    if (fixture !== null && !rows.some((r) => r.id === fixture.rxx)) rows.push(fixtureRxxRow(fixture));
    return { kind: 'facts', facts: rows };
  }
  if (type.requires !== null) return { kind: 'facts', facts: [] };
  if (type.id === 'D1') return { kind: 'facts', facts: brief.facts.filter((f) => f.kind === 'fact' && f.status !== PATH_INSTANCE) };
  if (type.id === 'D2') return { kind: 'regression', regression: [...brief.regression] };
  if (type.id === 'D3') return { kind: 'forbidden', rows: forbiddenRows(brief).filter((row) => D3_KEYWORDS.some((k) => row.text.includes(k))) };
  return { kind: 'facts', facts: [] };
}

/** The ids the model may name in `against`. */
export function targetIds(targets: DefectTargets): string[] {
  if (targets.kind === 'facts') return targets.facts.map((f) => f.id);
  if (targets.kind === 'regression') return targets.regression.map((r) => r.id);
  return targets.rows.map((r) => r.id);
}

function targetLines(targets: DefectTargets): string {
  if (targets.kind === 'facts') return targets.facts.map((f) => `${f.id}｜${f.status}｜${f.text}`).join('\n');
  if (targets.kind === 'regression') return targets.regression.map((r) => `${r.id}｜${r.case}｜${r.quote}`).join('\n');
  return targets.rows.map((r) => `${r.id}｜${r.text}`).join('\n');
}

function numbered(subDisplay: string): string {
  return splitSentences(subDisplay)
    .map((s, i) => `〔S${String(i + 1).padStart(3, '0')}〕${s}`)
    .join('\n');
}

const SHAPE = { sentence_no: 17, original: '被改写的原句（逐字照抄）', replacement: '改写后的一句', against: '所选条目的编号' };

function defectPrompt(subDisplay: string, type: DefectType, targets: DefectTargets, id: string, seed: string): string {
  return [
    '下面是一篇现场正文，已按句编号（〔S001〕是第 1 句）。它将用来抽查事实门评委是否认真核对事实。',
    mustWrap('defect', '正文', numbered(subDisplay), seed, `${id}:正文`),
    '',
    `缺陷类型：${type.text}`,
    '从下列条目中选一条（against 写所选条目的编号）：',
    mustWrap('defect', '条目', targetLines(targets), seed, `${id}:条目`),
    '',
    '# 要求',
    '1. 只改写正文中的一句，使它与所选条目明确矛盾，但读起来自然、长度相近，不加注释。',
    `2. 改写后仍是一句话，不换行，长度不超过原句的 ${DEFECT_MAX_GROWTH} 倍，不能与原句相同。`,
    '3. sentence_no 写被改写句子的编号，original 逐字照抄那一句（不带编号），replacement 写改写后的一句。',
    '4. 选一句在全文中只出现一次的句子。',
    '',
    outputBlock(SHAPE),
  ].join('\n');
}

function retryWith(prompt: string): (error: string) => string {
  return (error) => `${prompt}\n\n# 上一次输出未通过校验\n错误：${error}\n请针对这个错误重新作答，仍然只输出一个 json 代码块。`;
}

/**
 * The defect-writer TaskSpec (role ROLE_DEFECT; Chinese prompt with numbered sentences, the type text and the
 * offered targets, ending with outputBlock); retryPrompt quotes the validation error. `seed` feeds wrapText.
 */
export function defectTask(subDisplay: string, type: DefectType, targets: DefectTargets, id: string, seed: string): TaskSpec<DefectPlan> {
  const prompt = defectPrompt(subDisplay, type, targets, id, seed);
  return { id, role: ROLE_DEFECT, prompt, parse: (text) => parseDefectPlan(text, subDisplay, targets), retryPrompt: retryWith(prompt) };
}

/** The display text with sentence `sentence` (verbatim, found once) replaced; null when it is not found. */
function replaced(subDisplay: string, sentence: string, replacement: string): { copy: string; at: number } | null {
  const at = subDisplay.indexOf(sentence);
  if (at === -1) return null;
  return { copy: `${subDisplay.slice(0, at)}${replacement}${subDisplay.slice(at + sentence.length)}`, at };
}

/**
 * One fenced json block; `original` equals sentence `sentence_no` and occurs exactly once; `replacement` is one
 * sentence (also in place, in the copy), ≠ original, ≤ DEFECT_MAX_GROWTH × its length, with ≥ DEFECT_OVERLAP_MIN
 * significant chars and no 〔〕; the copy stays an anonymizeText fixed point when the text is one; `against` ∈
 * targetIds(targets). ASCII errors. The plan carries the verbatim sentence.
 */
export function parseDefectPlan(text: string, subDisplay: string, targets: DefectTargets): Result<DefectPlan> {
  const obj = parseFencedJson(text);
  if (!obj.ok) return err(obj.error);
  const sentences = splitSentences(subDisplay);
  const no = obj.value['sentence_no'];
  if (typeof no !== 'number' || !Number.isInteger(no)) return err('sentence_no: missing or not an integer');
  if (no < 1 || no > sentences.length) return err(`sentence_no: out of range 1..${sentences.length}`);
  const sentence = sentences[no - 1] ?? '';
  const original = readCapped(obj.value, 'original', TEXT_MAX);
  if (!original.ok) return err(original.error);
  if (sentenceKey(original.value) !== sentenceKey(sentence)) return err('original: not the verbatim sentence sentence_no of the text');
  if (!occursExactly(sentence, subDisplay, 1)) return err('original: the sentence occurs more than once in the text; pick a unique sentence');
  const replacement = readCapped(obj.value, 'replacement', TEXT_MAX);
  if (!replacement.ok) return err(replacement.error);
  const r = replacement.value;
  if (/[〔〕\n]/u.test(r)) return err('replacement: contains a line break or a reserved bracket');
  if (splitSentences(r).length !== 1) return err('replacement: must be exactly one sentence');
  if (normalizeForQuote(r) === normalizeForQuote(sentence)) return err('replacement: equals the original sentence');
  if (codePoints(normalizeForQuote(r)) < DEFECT_OVERLAP_MIN) return err(`replacement: fewer than ${DEFECT_OVERLAP_MIN} significant chars`);
  if (codePoints(r) > DEFECT_MAX_GROWTH * codePoints(sentence)) return err(`replacement: longer than ${DEFECT_MAX_GROWTH} times the original sentence`);
  const swapped = replaced(subDisplay, sentence, r);
  if (swapped === null) return err('original: not found verbatim in the text');
  // The copy must look like any judged text: display texts are anonymizeText fixed points (no curly quotes, no
  // ellipsis dots, no Markdown), so a replacement typesetting would change gives the copy away.
  if (anonymizeText(subDisplay) === subDisplay && anonymizeText(swapped.copy) !== swapped.copy) {
    return err('replacement: must stay plain display text (no curly quotes, ellipsis dots or markup that typesetting changes)');
  }
  const after = splitSentences(swapped.copy);
  if (after.length !== sentences.length || sentenceKey(after[no - 1] ?? '') !== sentenceKey(r)) {
    return err('replacement: does not stay one sentence in place of the original (check its end punctuation)');
  }
  const against = readCapped(obj.value, 'against', AGAINST_MAX);
  if (!against.ok) return err(against.error);
  if (!targetIds(targets).includes(against.value)) return err('against: not one of the offered ids');
  return ok({ sentenceNo: no, original: sentence, replacement: r, against: against.value });
}

/** Applies a validated plan (the parser guarantees `original` occurs once); a plan that does not fit the text is an engine bug. */
export function applyDefect(subDisplay: string, plan: DefectPlan, meta: { submission: string; type: string }): Defect {
  const sentence = splitSentences(subDisplay)[plan.sentenceNo - 1];
  if (sentence === undefined || sentenceKey(sentence) !== sentenceKey(plan.original)) throw new Error('applyDefect: the plan does not match the text');
  const swapped = replaced(subDisplay, sentence, plan.replacement);
  if (swapped === null) throw new Error('applyDefect: the sentence is not in the text');
  const start = codePoints(normalizeForQuote(subDisplay.slice(0, swapped.at)));
  const injectedSpan = { start, end: start + codePoints(normalizeForQuote(plan.replacement)) };
  return { submission: meta.submission, copy: swapped.copy, injected: plan.replacement, injectedSpan, type: meta.type, against: plan.against };
}

/**
 * One seeded enabled type per round (key `defect:<round>`, over the code-unit sorted ids): `requires: "rxx"` types
 * only when the brief holds a registered fact, or when `drill` (round-0 gate dry-run, against fixture-rxx); types
 * with another `requires` never. null when no type is enabled.
 */
export function pickDefectType(types: readonly DefectType[], brief: Pick<BriefJson, 'facts'>, seed: string, round: string, drill: boolean): DefectType | null {
  const rxx = drill || brief.facts.some((f) => f.kind === 'registered');
  const enabled = types.filter((t) => t.requires === null || (t.requires === 'rxx' && rxx));
  const sorted = [...enabled].sort((a, b) => byCodeUnit(a.id, b.id));
  return seededShuffle(sorted, seed, `defect:${round}`)[0] ?? null;
}

/** The seeded gate-bound submission that gets the copy (key `defectsub:<round>`, over the code-unit sorted ids); null when none. */
export function pickDefectSubmission(gateBound: readonly string[], seed: string, round: string): string | null {
  const sorted = [...new Set(gateBound)].sort(byCodeUnit);
  return seededShuffle(sorted, seed, `defectsub:${round}`)[0] ?? null;
}
