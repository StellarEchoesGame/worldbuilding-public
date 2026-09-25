import { err, ok, type Result } from './result.ts';
import { charCount, normalizeForQuote, sentenceKey, splitSentences, stripMarkdown } from './text.ts';

export interface MergeConstants {
  preamble09: string;
  pointer07: string;
  heading8: string;
  tableHeader8: string;
  connectives: string[];
  maxJointsPer500: number;
  /** Revision-notes files (PROTOCOL §7.7) a merge may edit freely. */
  notesPaths: string[];
}

export interface DeltaFact {
  id: string;
  claim: string;
  status: string;
  rowId: string;
  attachesTo: string;
  extends: string;
  misuse: string;
  sourceQuote: string;
}

export interface MergeSource {
  label: string;
  submission: string;
  facts: DeltaFact[];
}

export interface MergeDecision {
  round: string;
  baseLabel: string;
  title: string;
  rows: string[];
  registered: Array<{ rxx: string; label: string; factId: string }>;
}

export interface MergeInput {
  constants: MergeConstants;
  rowIds: string[];
  decision: MergeDecision;
  sources: MergeSource[];
  /**
   * Path → content before / after the merge ('' or a missing key = file absent). Only 09, 07 and 01–06 may differ;
   * any other path must have the same content on both sides, so callers may pass every canon file.
   */
  before: Record<string, string>;
  after: Record<string, string>;
}

export interface MergeCheckResult {
  ok: boolean;
  violations: string[];
}

const SCENES_PATH = 'reference/09-scenes-and-people.md';
const REGISTER_PATH = 'reference/07-register-and-creation.md';
const INDEXED_PATH = /^reference\/0[1-6]-[^/]+\.md$/u;
const INDEX_LINE = /^现场：见09 §(R\d{2})（(R\d{2}-\d{2}(?:、R\d{2}-\d{2})*)）$/u;
const TIME_ANCHOR = 'D\\d+—D\\d+中的任一常态日|D\\d+|任一常态日';
/** Link or image syntax and HTML-ish tags: stripMarkdown drops their targets, titles or contents unchecked. */
const HIDING_MARKUP = /\]\(|!\[|<[A-Za-z!/]/u;
/** Setext underlines and thematic breaks that stripMarkdown leaves as punctuation. */
/** Block markup that turns scene prose into lists, quotes, code or tables; 09 scenes are plain paragraphs. */
const BLOCK_MARKUP = /^\s{0,3}(?:[-*+]\s|\d+[.)]\s|>|\||`{3,}|~{3,})/u;
const RULE_LINE = /^\s{0,3}(?:=+|-+|(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})\s*$/u;
/** Significant characters (normalizeForQuote) a source quote needs before it can identify donor sentences. */
const MIN_QUOTE_CHARS = 4;
/** The 07 延伸自 cell for a registered fact whose delta has no extends. */
const EMPTY_EXTENDS = '无';

type FactColumn = 'rowId' | 'claim' | 'status' | 'attachesTo' | 'extends' | 'misuse';

/** 行 and 地位 must equal the fact's field; the other cells are non-empty substrings of it. */
const REGISTER_COLUMNS: ReadonlyArray<{ label: string; key: FactColumn; exact: boolean }> = [
  { label: '行', key: 'rowId', exact: true },
  { label: '事实', key: 'claim', exact: true },
  { label: '地位', key: 'status', exact: true },
  { label: '挂靠', key: 'attachesTo', exact: false },
  { label: '延伸自', key: 'extends', exact: false },
  { label: '误用', key: 'misuse', exact: false },
];

interface RegisteredFact {
  rxx: string;
  label: string;
  fact: DeltaFact | null;
}

function fileText(files: Record<string, string>, path: string): string {
  return Object.hasOwn(files, path) ? (files[path] ?? '') : '';
}

function quoteLongEnough(quote: string): boolean {
  return [...normalizeForQuote(quote)].length >= MIN_QUOTE_CHARS;
}

/** Comparison keys of a registered quote: as written and with Markdown stripped. */
function quoteKeys(quote: string): string[] {
  return [...new Set([sentenceKey(quote), sentenceKey(stripMarkdown(quote))])];
}

function escapeRegex(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/gu, '\\$&');
}

function headerPattern(rowPattern: string): RegExp {
  return new RegExp(
    `^## (?<round>R\\d{2})｜(?<title>[^｜\\n]{1,24})\\n\\n` +
      `地点：(?<row>${rowPattern})｜时间锚：(?:${TIME_ANCHOR})｜路径依赖：(?:标准成功路径|与路径无关)｜` +
      `地位：(?:状态与路径实例·示例|已选地方事实·已发生事件)｜本场登记事实：(?<facts>无|R\\d{2}-\\d{2}(?:、R\\d{2}-\\d{2}){0,5})(?=\\n|$)`,
    'u',
  );
}

/** Matches the two header lines of a 09 scene at the start of the given text. */
export function sceneHeaderRegex(rowIds: readonly string[]): RegExp {
  return headerPattern(rowIds.length === 0 ? '(?!)' : rowIds.map(escapeRegex).join('|'));
}

function resolveDecision(input: MergeInput, violations: string[]): RegisteredFact[] {
  const { decision } = input;
  if (!/^R\d{2}$/u.test(decision.round)) violations.push(`decision: round ${decision.round} must look like R01`);
  if (!input.sources.some((s) => s.label === decision.baseLabel)) violations.push(`decision: base source ${decision.baseLabel} not found`);
  const seen = new Set<string>();
  const seenFacts = new Set<string>();
  return decision.registered.map((r) => {
    if (!new RegExp(`^${escapeRegex(decision.round)}-\\d{2}$`, 'u').test(r.rxx)) violations.push(`decision: ${r.rxx} is not an id of round ${decision.round}`);
    if (seen.has(r.rxx)) violations.push(`decision: ${r.rxx} is listed twice`);
    seen.add(r.rxx);
    const factKey = JSON.stringify([r.label, r.factId]);
    if (seenFacts.has(factKey)) violations.push(`decision: ${r.label}/${r.factId} is registered twice`);
    seenFacts.add(factKey);
    const fact = input.sources.find((s) => s.label === r.label)?.facts.find((f) => f.id === r.factId) ?? null;
    if (fact === null) violations.push(`decision: ${r.rxx} refers to unknown fact ${r.label}/${r.factId}`);
    else if (!quoteLongEnough(fact.sourceQuote)) violations.push(`decision: ${r.rxx} source quote is too short`);
    return { rxx: r.rxx, label: r.label, fact };
  });
}

/** Returns the matched header text, or null after recording why it does not match. */
function checkHeader(scene: string, input: MergeInput, violations: string[]): string | null {
  const { decision } = input;
  const m = sceneHeaderRegex(input.rowIds).exec(scene);
  if (m === null) {
    const row = headerPattern('[^｜\\n]+').exec(scene)?.groups?.['row'];
    if (row !== undefined) violations.push(`09: unknown 地点 ${row}`);
    else violations.push(`09: scene header does not match the required format: ${scene.split('\n').slice(0, 3).join(' / ')}`);
    return null;
  }
  const round = m.groups?.['round'] ?? '';
  const title = m.groups?.['title'] ?? '';
  const row = m.groups?.['row'] ?? '';
  const facts = m.groups?.['facts'] ?? '';
  if (round !== decision.round) violations.push(`09: heading round ${round} does not match decision round ${decision.round}`);
  if (title !== decision.title) violations.push(`09: title ${title} does not match decision title ${decision.title}`);
  if (!decision.rows.includes(row)) violations.push(`09: 地点 ${row} is not a decision row`);
  const listed = facts === '无' ? [] : facts.split('、');
  const expected = decision.registered.map((r) => r.rxx);
  if (listed.join('、') !== expected.join('、')) violations.push(`09: registered list ${facts} does not match decision ${expected.join('、') || '无'}`);
  for (const id of listed) {
    if (!id.startsWith(`${round}-`)) violations.push(`09: ${id} is not a fact of heading round ${round}`);
  }
  return m[0];
}

/** Comparison keys (sentenceKey) of non-base sentences that carry the source quote of one of that source's registered facts. */
function donorSentences(input: MergeInput, registered: readonly RegisteredFact[]): Set<string> {
  const out = new Set<string>();
  for (const source of input.sources) {
    if (source.label === input.decision.baseLabel) continue;
    const quotes = registered
      .flatMap((r) => (r.label === source.label && r.fact !== null ? quoteKeys(r.fact.sourceQuote) : []))
      .filter(quoteLongEnough);
    if (quotes.length === 0) continue;
    for (const sentence of splitSentences(stripMarkdown(source.submission))) {
      const key = sentenceKey(sentence);
      if (quotes.some((q) => key.includes(q))) out.add(key);
    }
  }
  return out;
}

/** Raw body lines whose text stripMarkdown would hide, or that are nothing but markup (a setext underline makes a second heading). */
function checkMarkup(body: string, violations: string[]): boolean {
  const before = violations.length;
  for (const line of body.split('\n')) {
    if (line.trim() === '') continue;
    if (HIDING_MARKUP.test(line)) violations.push(`09: markup hides text: ${line}`);
    else if (stripMarkdown(line).trim() === '' || RULE_LINE.test(line)) violations.push(`09: markup-only line: ${line}`);
    else if (BLOCK_MARKUP.test(line)) violations.push(`09: body must be plain paragraphs: ${line}`);
  }
  return violations.length === before;
}

/** Like the gate's source-quote check, a quote may span sentences; punctuation, whitespace and width are folded. */
function checkQuotesInScene(body: string, registered: readonly RegisteredFact[], violations: string[]): void {
  const scene = normalizeForQuote(stripMarkdown(body));
  for (const r of registered) {
    // Unknown facts and too-short quotes are already reported by resolveDecision.
    if (r.fact === null || !quoteLongEnough(r.fact.sourceQuote)) continue;
    const quotes = [r.fact.sourceQuote, stripMarkdown(r.fact.sourceQuote)].map(normalizeForQuote).filter((q) => q !== '');
    if (!quotes.some((q) => scene.includes(q))) violations.push(`09: ${r.rxx} source quote not in scene`);
  }
}

function checkBody(body: string, base: MergeSource, input: MergeInput, registered: readonly RegisteredFact[], violations: string[]): void {
  const { maxJointsPer500 } = input.constants;
  const connectives = input.constants.connectives.map(sentenceKey).filter((c) => c !== '');
  const baseKeys = splitSentences(stripMarkdown(base.submission)).map(sentenceKey);
  const inBase = new Set(baseKeys);
  const donors = donorSentences(input, registered);
  const used = new Set<number>();
  const usedDonors = new Set<string>();
  let last = -1;
  let joints = 0;
  for (const sentence of splitSentences(stripMarkdown(body))) {
    const key = sentenceKey(sentence);
    const candidates = [{ key, joint: false }];
    for (const c of connectives) {
      if (key.startsWith(c) && key.length > c.length) candidates.push({ key: key.slice(c.length), joint: true });
    }
    // A sentence whose text (with or without its connective) is a base sentence never takes the donor path,
    // so repeats and reorderings of base sentences stay visible.
    const baseHit = candidates.some((c) => inBase.has(c.key));
    let matched = false;
    for (const candidate of candidates) {
      // Earliest unused later occurrence keeps the base subsequence check exact when a sentence repeats in the base.
      const index = baseKeys.findIndex((s, i) => i > last && s === candidate.key);
      if (index !== -1) {
        last = index;
        used.add(index);
      } else if (baseHit || !donors.has(candidate.key) || usedDonors.has(candidate.key)) {
        continue;
      } else {
        usedDonors.add(candidate.key);
      }
      if (candidate.joint) joints += 1;
      matched = true;
      break;
    }
    if (matched) continue;
    const occurrences = candidates.flatMap((c) => baseKeys.flatMap((s, i) => (s === c.key ? [i] : [])));
    if (occurrences.length === 0 && candidates.some((c) => usedDonors.has(c.key))) violations.push(`09: donor sentence repeated: ${sentence}`);
    else if (occurrences.length === 0) violations.push(`09: sentence matches no source: ${sentence}`);
    else if (occurrences.every((i) => used.has(i))) violations.push(`09: base sentence repeated: ${sentence}`);
    else violations.push(`09: base sentence out of order: ${sentence}`);
  }
  const limit = maxJointsPer500 * Math.ceil(charCount(body) / 500);
  if (joints > limit) violations.push(`09: too many joints: ${joints} > ${limit}`);
}

function checkScenes(input: MergeInput, registered: readonly RegisteredFact[], violations: string[]): void {
  const before = fileText(input.before, SCENES_PATH);
  const after = fileText(input.after, SCENES_PATH);
  if (after === before) {
    violations.push('09: no scene appended');
    return;
  }
  let appended: string;
  if (before === '') {
    const opening = `${input.constants.preamble09}\n\n`;
    if (!after.startsWith(opening)) {
      violations.push('09: a new 09 must open with the exact preamble followed by a blank line');
      return;
    }
    appended = after.slice(opening.length);
  } else {
    if (!after.startsWith(before)) {
      violations.push('09: not append-only (existing content changed)');
      return;
    }
    appended = after.slice(before.length);
    if (!before.endsWith('\n') && !appended.startsWith('\n')) {
      violations.push('09: the scene header must start on a new line');
      return;
    }
  }
  const scene = appended.replace(/^\n+/u, '');
  if (scene.trim() === '') {
    violations.push('09: no scene appended');
    return;
  }
  const headerText = checkHeader(scene, input, violations);
  if (headerText === null) return;
  const rest = scene.slice(headerText.length);
  if (!rest.startsWith('\n\n') || rest.trim() === '') {
    violations.push('09: the scene header must be followed by a blank line and a body');
    return;
  }
  const body = rest.slice(2);
  if (body.split('\n').some((line) => /^\s{0,3}#{1,6}\s/u.test(line))) {
    violations.push('09: the appended part must contain exactly one scene (heading found in the body)');
    return;
  }
  if (!checkMarkup(body, violations)) return;
  checkQuotesInScene(body, registered, violations);
  const base = input.sources.find((s) => s.label === input.decision.baseLabel);
  if (base !== undefined) checkBody(body, base, input, registered, violations);
}

function tableCells(line: string): string[] | null {
  if (line.length < 2 || !line.startsWith('|') || !line.endsWith('|')) return null;
  return line
    .slice(1, -1)
    .split('|')
    .map((c) => c.trim());
}

function checkRegisterRow(line: string, expected: RegisteredFact, round: string, violations: string[]): void {
  const cells = tableCells(line);
  if (cells === null || cells.length !== REGISTER_COLUMNS.length + 2) {
    violations.push(`07: malformed row for ${expected.rxx}: ${line}`);
    return;
  }
  const id = cells[0] ?? '';
  if (id !== expected.rxx) violations.push(`07: row ${id} found where ${expected.rxx} was expected`);
  const roundCell = cells[REGISTER_COLUMNS.length + 1] ?? '';
  if (roundCell !== round) violations.push(`07: ${expected.rxx} round column ${roundCell} is not ${round}`);
  const { fact } = expected;
  if (fact === null) return;
  for (const [i, column] of REGISTER_COLUMNS.entries()) {
    const cell = cells[i + 1] ?? '';
    const value = fact[column.key];
    if (column.key === 'extends' && value.trim() === '') {
      if (cell !== EMPTY_EXTENDS) violations.push(`07: ${expected.rxx} 延伸自 ${cell} must be ${EMPTY_EXTENDS} for a fact without extends`);
    } else if (column.exact) {
      if (cell !== value) violations.push(`07: ${expected.rxx} ${column.label} ${cell} is not ${value}`);
    } else if (cell === '' || !value.includes(cell)) {
      violations.push(`07: ${expected.rxx} ${column.label} ${cell} is not a non-empty substring of ${column.key}`);
    }
  }
}

function checkRegister(input: MergeInput, registered: readonly RegisteredFact[], violations: string[]): void {
  const { constants, decision } = input;
  const before = fileText(input.before, REGISTER_PATH);
  const after = fileText(input.after, REGISTER_PATH);
  if (!after.startsWith(before)) {
    violations.push('07: not append-only (existing content changed)');
    return;
  }
  let addition = after.slice(before.length);
  if (!before.includes(constants.pointer07)) {
    const opening = `\n${constants.pointer07}\n\n${constants.heading8}\n\n${constants.tableHeader8}\n`;
    if (addition.startsWith(opening)) addition = addition.slice(opening.length);
    else if (registered.length > 0 || addition !== '') {
      violations.push('07: the first merge must add the pointer, §8 heading and table header');
      return;
    }
  }
  const lines = addition.split('\n');
  if (lines.at(-1) === '') lines.pop();
  else violations.push('07: the addition must end with a newline');
  for (const [i, line] of lines.entries()) {
    const expected = registered[i];
    if (expected === undefined) violations.push(`07: extra row: ${line}`);
    else checkRegisterRow(line, expected, decision.round, violations);
  }
  for (const missing of registered.slice(lines.length)) violations.push(`07: missing row for ${missing.rxx}`);
}

function textLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

/** Positions in `after` not matched when `before` is embedded in it as a subsequence; err names the first unmatched `before` line. */
function addedLines(before: readonly string[], after: readonly string[]): Result<number[]> {
  const added: number[] = [];
  let j = 0;
  for (const [n, line] of before.entries()) {
    while (j < after.length && after[j] !== line) {
      added.push(j);
      j += 1;
    }
    if (j === after.length) return err(`line ${n + 1} removed or changed: ${JSON.stringify(line)}`);
    j += 1;
  }
  for (; j < after.length; j += 1) added.push(j);
  return ok(added);
}

function allPaths(input: MergeInput): string[] {
  return [...new Set([...Object.keys(input.before), ...Object.keys(input.after)])].sort();
}

function checkIndexes(input: MergeInput, violations: string[]): void {
  const { decision } = input;
  const registered = new Set(decision.registered.map((r) => r.rxx));
  const paths = allPaths(input).filter((p) => INDEXED_PATH.test(p) && !isNewIndexedFile(input, p));
  for (const path of paths) {
    const after = textLines(fileText(input.after, path));
    const diff = addedLines(textLines(fileText(input.before, path)), after);
    if (!diff.ok) {
      violations.push(`${path}: ${diff.error}`);
      continue;
    }
    const added = new Set(diff.value);
    const isAddedIndex = (i: number): boolean => added.has(i) && INDEX_LINE.test(after[i] ?? '');
    for (const i of diff.value) {
      const line = after[i] ?? '';
      // A blank line may only set an added index line off as its own Markdown paragraph.
      if (line === '' && (isAddedIndex(i - 1) || isAddedIndex(i + 1))) continue;
      const m = INDEX_LINE.exec(line);
      if (m === null) {
        violations.push(`${path}: added line is not an index line: ${line}`);
        continue;
      }
      // Directly under a text line, Markdown would fold the index line into that paragraph.
      const above = after[i - 1];
      if (above !== undefined && above.trim() !== '' && !isAddedIndex(i - 1)) violations.push(`${path}: index line must start its own paragraph: ${line}`);
      const sceneRound = m[1] ?? '';
      if (sceneRound !== decision.round) violations.push(`${path}: index line points to §${sceneRound}, not §${decision.round}`);
      for (const id of (m[2] ?? '').split('、')) {
        if (!registered.has(id)) violations.push(`${path}: ${id} is not registered in this merge`);
      }
    }
  }
}

/** Any path other than 09, 07, 01–06 and the notes paths must be unchanged. */
/** A new 01–06 file (absent or empty before) is not an index target. */
function isNewIndexedFile(input: MergeInput, path: string): boolean {
  return INDEXED_PATH.test(path) && fileText(input.before, path) === '' && fileText(input.after, path) !== '';
}

function checkUntouched(input: MergeInput, violations: string[]): void {
  for (const path of allPaths(input)) {
    if (isNewIndexedFile(input, path)) violations.push(`unexpected change: ${path}`);
    if (path === SCENES_PATH || path === REGISTER_PATH || INDEXED_PATH.test(path) || input.constants.notesPaths.includes(path)) continue;
    if (fileText(input.before, path) !== fileText(input.after, path)) violations.push(`unexpected change: ${path}`);
  }
}

/** Checks that a merge touched 09, 07 and 01–06 only in the ways the merge protocol allows, and nothing else. */
export function mergecheck(input: MergeInput): MergeCheckResult {
  const violations: string[] = [];
  const registered = resolveDecision(input, violations);
  checkScenes(input, registered, violations);
  checkRegister(input, registered, violations);
  checkIndexes(input, violations);
  checkUntouched(input, violations);
  return { ok: violations.length === 0, violations };
}
