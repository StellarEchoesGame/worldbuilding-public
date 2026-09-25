import { charCount, ruleSentenceRatio, sentenceKey, splitSentences, stripMarkdown } from './text.ts';
import type { WriterOutput } from './writer-output.ts';

export interface GateLimits {
  maxChars: number;
  maxNewProperNouns: number;
  maxRegistered: number;
  maxWithoutExtends: number;
  maxRuleRatio: number;
}

/** Defaults; a round passes the PROTOCOL.md `limits` block instead. */
export const LIMITS: GateLimits = {
  maxChars: 2500,
  maxNewProperNouns: 3,
  maxRegistered: 6,
  maxWithoutExtends: 3,
  maxRuleRatio: 0.15,
};

export interface ForbiddenWord {
  term: string;
  protects: string;
}

export const DEFAULT_FORBIDDEN: readonly ForbiddenWord[] = [];

export const DEFAULT_NEGATIONS: readonly string[] = ['没有', '无', '不', '非', '并非', '不是', '未', '别', '禁止', '不能', '不会', '从未', '绝无'];

/** Words that contain a negation character without negating anything (PROTOCOL.md §11 `negation-exceptions`). */
/** Mirrors the PROTOCOL.md `negation-exceptions` block (a test keeps them equal); a round passes the protocol list. */
export const DEFAULT_NEGATION_EXCEPTIONS: readonly string[] = [
  '不久', '不少', '不断', '不仅', '不但', '不管', '不过', '不得不', '不禁', '不停', '不时',
  '无数', '无论', '无比', '无非', '无限', '无穷', '无疑', '无处不在', '无不', '无可',
  '非常', '非但', '南非', '非洲', '是非',
  '未来', '未免',
  '别人', '别处', '别的', '特别', '分别', '区别', '告别', '离别', '差别', '类别', '级别', '个别', '别致',
];

export const DEFAULT_ANCHORS = /^0[1-8](?:-|$)/u;

export interface GateOptions {
  baseline: boolean;
  limits?: GateLimits;
  forbidden?: readonly ForbiddenWord[];
  negations?: readonly string[];
  negationExceptions?: readonly string[];
  validAnchors?: RegExp;
}

export interface GateCheck {
  name: string;
  ok: boolean;
  detail: string;
  flags?: string[];
}

export interface GateResult {
  pass: boolean;
  checks: GateCheck[];
}

const CLAUSE_SEPARATOR = /[，,；;：:、]/u;
/**
 * Removed inside a clause before looking for a term split by spacing or joiner punctuation (跨星-即时, 跨星　即时).
 * Clause separators (，、；：) and dashes (——) are not removed: they are visible pauses and would glue unrelated
 * words (一觉，醒来 → 觉醒; 有星——门开着 → 星门).
 */
const SPLITTERS = /[\s\-‐‑‒·・]/gu;

/** Start indices of every occurrence of `needle` in `haystack` (overlapping occurrences included). */
function occurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/** True when the marker occurrence at `index` of `clause` lies inside an occurrence of one of the exception words. */
function insideException(clause: string, index: number, marker: string, exceptions: readonly string[]): boolean {
  return exceptions.some((e) => {
    for (let k = 0; k < e.length; k += 1) {
      if (!e.slice(k).startsWith(marker)) continue;
      const start = index - k;
      if (start >= 0 && clause.slice(start, start + e.length) === e) return true;
    }
    return false;
  });
}

function clauseIsNegated(clause: string, markers: readonly string[], exceptions: readonly string[]): boolean {
  return markers.some((m) => occurrences(clause, m).some((i) => !insideException(clause, i, m, exceptions)));
}

/** The clauses of a sentence key with their start offsets, split at the separators without dropping offsets. */
function clauses(key: string): Array<{ start: number; text: string }> {
  const out: Array<{ start: number; text: string }> = [];
  let start = 0;
  for (let i = 0; i <= key.length; i += 1) {
    if (i === key.length || CLAUSE_SEPARATOR.test(key.charAt(i))) {
      out.push({ start, text: key.slice(start, i) });
      start = i + 1;
    }
  }
  return out;
}

/**
 * The forbidden-word check reads the stripped text with invisible format characters removed and soft line breaks
 * inside a paragraph joined (CRLF and CR count as newlines), so neither can split a term.
 */
/** Invisible characters a renderer drops or shows as nothing: format characters, joiners, variation selectors, fillers. */
const INVISIBLE = /[\p{Cf}\u034F\u115F\u1160\u3164\uFFA0\u180B-\u180D\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;
/** C0/C1 controls other than tab and newline. */
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const QUOTE_PREFIX = /^\s{0,3}(?:>\s?)+/u;
const BLOCK_START = /^\s{0,3}(?:#{1,6}(?:\s|$)|[-*+]\s|\d+[.)]\s|\||`{3,}|~{3,}|(?:=+|-+)\s*$|(?:[-*_]\s*){3,}$)/u;
const ATX_HEADING = /^\s{0,3}#{1,6}(?:\s|$)/u;

/**
 * Sentences for the forbidden-word check. A soft line break inside a paragraph renders as nothing between CJK
 * characters, so continuation lines are joined (with the whitespace around the break) before splitting; headings,
 * list items, table rows, fences and rules start new blocks and are never joined to their neighbours.
 */
function forbiddenSentences(submission: string): string[] {
  const lines = submission
    .replace(/\r\n?|[\u0085\u2028]/gu, '\n')
    .replace(/\u2029/gu, '\n\n')
    .replace(INVISIBLE, '')
    .replace(CONTROLS, '')
    .split('\n');
  const out: string[] = [];
  let prev: 'blank' | 'heading' | 'text' = 'blank';
  let prevDepth = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      out.push('');
      prev = 'blank';
      continue;
    }
    const quote = QUOTE_PREFIX.exec(line)?.[0] ?? '';
    const depth = [...quote].filter((ch) => ch === '>').length;
    const content = line.slice(quote.length);
    const last = out.length - 1;
    // Same quote depth, or a lazy continuation line after a quoted paragraph, continues the paragraph.
    if (prev === 'text' && last >= 0 && !BLOCK_START.test(content) && (depth === prevDepth || depth === 0)) {
      out[last] = `${(out[last] ?? '').trimEnd()}${content.trimStart()}`;
    } else {
      out.push(content);
      prevDepth = depth;
    }
    prev = ATX_HEADING.test(content) ? 'heading' : 'text';
  }
  return splitSentences(stripMarkdown(out.join('\n')));
}

function forbiddenCheck(
  sentences: readonly string[],
  forbidden: readonly ForbiddenWord[],
  negations: readonly string[],
  negationExceptions: readonly string[],
): { ok: boolean; detail: string; flags: string[] } {
  // An empty term, marker or exception would match every sentence. Everything is compared by its NFKC key.
  const terms = forbidden.filter((w) => w.term !== '').map((w) => ({ word: w, key: sentenceKey(w.term) }));
  const markers = negations.filter((n) => n !== '').map(sentenceKey);
  const exceptions = negationExceptions.filter((e) => e !== '').map(sentenceKey);
  const failing: string[] = [];
  const flagged: string[] = [];
  const flags: string[] = [];
  for (const sentence of sentences) {
    const key = sentenceKey(sentence);
    const sentenceClauses = clauses(key);
    const direct = terms.filter((t) => key.includes(t.key));
    // Clauses holding a term only once spacing and joiners are removed; the split never crosses a clause separator.
    const splitIn = (t: { key: string }): Array<{ text: string }> => {
      const squeezedTerm = t.key.replace(SPLITTERS, '');
      if (squeezedTerm === '' || key.includes(t.key)) return [];
      return sentenceClauses.filter((c) => c.text.replace(SPLITTERS, '').includes(squeezedTerm));
    };
    const split = terms.filter((t) => splitIn(t).length > 0);
    const found = [...direct, ...split];
    if (found.length === 0) continue;
    // An occurrence is negated only when its own clause holds a negation marker outside every exception word.
    const negated =
      direct.every((t) =>
        occurrences(key, t.key).every((at) => {
          const clause = sentenceClauses.findLast((c) => c.start <= at);
          return clause !== undefined && clauseIsNegated(clause.text, markers, exceptions);
        }),
      ) && split.every((t) => splitIn(t).every((c) => clauseIsNegated(c.text, markers, exceptions)));
    const label = `${found.map((t) => `${t.word.term}（${t.word.protects}）`).join('、')}：${sentence}`;
    if (negated) {
      flagged.push(label);
      flags.push(sentence);
    } else {
      failing.push(label);
    }
  }
  const parts: string[] = [];
  if (failing.length > 0) parts.push(`未否定：${failing.join(' / ')}`);
  if (flagged.length > 0) parts.push(`否定句待复核：${flagged.join(' / ')}`);
  return { ok: failing.length === 0, detail: parts.length === 0 ? '未出现禁用词' : parts.join('；'), flags };
}

/** Link and image syntax and HTML tags: stripMarkdown deletes their targets, titles and tags, so text there escapes every check. */
const MARKUP = /\]\(|!\[|<[A-Za-z!/]|&(?:#\d+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/u;

function markupCheck(submission: string): { ok: boolean; detail: string } {
  const lines = submission.split('\n').flatMap((line, i) => (MARKUP.test(line) ? [`第 ${i + 1} 行：${line.trim()}`] : []));
  return { ok: lines.length === 0, detail: lines.length === 0 ? '无链接、图片或 HTML 标记' : `含链接、图片或 HTML 标记：${lines.join(' / ')}` };
}

export function mechanicalGate(out: WriterOutput, opts: GateOptions): GateResult {
  const checks: GateCheck[] = [];
  const add = (name: string, ok: boolean, detail: string, flags: readonly string[] = []): void => {
    checks.push(flags.length === 0 ? { name, ok, detail } : { name, ok, detail, flags: [...flags] });
  };
  const limits = opts.limits ?? LIMITS;
  const chars = charCount(out.submission);
  add('length', chars <= limits.maxChars, `${chars} / ${limits.maxChars} 字`);
  add('new_proper_nouns', out.delta.newProperNouns.length <= limits.maxNewProperNouns, `${out.delta.newProperNouns.length} 个：${out.delta.newProperNouns.join('、') || '无'}`);
  const facts = out.delta.claims.filter((c) => c.kind === 'author_fact');
  const registered = facts.filter((c) => c.register);
  add('registered_facts', registered.length <= limits.maxRegistered, `${registered.length} 条登记`);
  const plain = stripMarkdown(out.submission);
  const badQuotes = out.delta.claims.filter((c) => !(out.submission.includes(c.sourceQuote) || plain.includes(c.sourceQuote)) || c.sourceQuote.trim() === '');
  add('source_quotes', badQuotes.length === 0, badQuotes.length === 0 ? '全部逐字出自正文' : `未在正文找到：${badQuotes.map((c) => c.id).join('、')}`);
  const noExtends = facts.filter((c) => c.extends.trim() === '');
  add('facts_without_extends', noExtends.length <= limits.maxWithoutExtends, `${noExtends.length} 条无延伸依据`);
  const ratio = ruleSentenceRatio(out.submission);
  add('rule_sentences', ratio <= limits.maxRuleRatio, `规则句占比 ${(ratio * 100).toFixed(1)}%`);
  const ifaceOk = out.iface.shots.length === 3 && out.iface.object !== null && out.iface.hook !== null;
  add('interface', ifaceOk, `${out.iface.shots.length} 个镜头，物件${out.iface.object === null ? '缺' : '有'}，钩子${out.iface.hook === null ? '缺' : '有'}`);

  const forbidden = forbiddenCheck(
    forbiddenSentences(out.submission),
    opts.forbidden ?? DEFAULT_FORBIDDEN,
    opts.negations ?? DEFAULT_NEGATIONS,
    opts.negationExceptions ?? DEFAULT_NEGATION_EXCEPTIONS,
  );
  add('forbidden_words', forbidden.ok, forbidden.detail, forbidden.flags);
  const sentenceKeys = splitSentences(plain).map(sentenceKey);
  const dangling = out.delta.newProperNouns.filter((noun) => sentenceKeys.filter((s) => s.includes(sentenceKey(noun))).length < 2);
  add('dangling_nouns', dangling.length === 0, dangling.length === 0 ? '新专名均至少出现在两句中' : `出现不足两句：${dangling.join('、')}`);
  const anchorPattern = opts.validAnchors ?? DEFAULT_ANCHORS;
  // A g or y pattern keeps lastIndex between test() calls; a copy without them tests each fact independently.
  const anchor = new RegExp(anchorPattern.source, anchorPattern.flags.replace(/[gy]/gu, ''));
  const badAnchors = facts.filter((c) => !anchor.test(c.attachesTo));
  add('anchors', badAnchors.length === 0, badAnchors.length === 0 ? '挂靠均有效' : `挂靠无效：${badAnchors.map((c) => `${c.id}（${c.attachesTo || '空'}）`).join('、')}`);

  const markup = markupCheck(out.submission);
  add('markup', markup.ok, markup.detail);

  if (opts.baseline) add('baseline_no_new_facts', facts.length === 0 && out.delta.newProperNouns.length === 0, `${facts.length} 条作者事实`);
  return { pass: checks.every((c) => c.ok), checks };
}
