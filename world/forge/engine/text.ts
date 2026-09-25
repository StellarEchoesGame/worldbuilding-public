const TERMINATORS = new Set(['。', '！', '？', '；', '!', '?', ';', '…']);
const CLOSERS = new Set(['」', '』', '”', '’', '）', ')', '》', '"']);
const RULE_WORDS = /必须|不能|不得|禁止|不可|不准|须(?!臾)/u;
const DIALOGUE = /「[^」]*」|『[^』]*』|“[^”]*”/gu;

export function stripMarkdown(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/u, '')
        .replace(/^\s{0,3}>\s?/u, '')
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/u, '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
        .replace(/(\*\*|__|\*|`)/gu, ''),
    )
    .join('\n')
    .trim();
}

/** Unicode code points after Markdown stripping (matches `wc -m` on the stripped text). */
export function charCount(text: string): number {
  return [...stripMarkdown(text)].length;
}

const TABLE_ROW = /^\s*\|.*\|\s*$/u;
const TABLE_SEPARATOR = /^:?-+:?$/u;

/** Table rows become one line per cell; separator rows disappear. */
function tableCellsAsLines(text: string): string {
  return text
    .split('\n')
    .flatMap((line) => {
      if (!TABLE_ROW.test(line)) return [line];
      const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim());
      return cells.every((c) => TABLE_SEPARATOR.test(c)) ? [] : cells;
    })
    .join('\n');
}

/**
 * The comparison key for sentences, quotes, terms and connectives: NFKC, so width variants compare equal.
 * Not applied to the text itself because NFKC turns Chinese full-width punctuation (，：！) and … into ASCII.
 */
export function sentenceKey(text: string): string {
  return text.normalize('NFKC');
}

/**
 * The shared sentence splitter: splits on 。！？；… (and ASCII !?;) and on newlines, keeps closing quotes
 * with their sentence and gives table cells their own sentences. Compare its output with `sentenceKey`.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const push = (sentence: string): void => {
    const trimmed = sentence.trim();
    if (trimmed !== '') out.push(trimmed);
  };
  const chars = [...tableCellsAsLines(text)];
  let current = '';
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] ?? '';
    if (ch === '\n') {
      push(current);
      current = '';
      continue;
    }
    current += ch;
    if (TERMINATORS.has(ch)) {
      while (i + 1 < chars.length && (TERMINATORS.has(chars[i + 1] ?? '') || CLOSERS.has(chars[i + 1] ?? ''))) {
        i += 1;
        current += chars[i] ?? '';
      }
      push(current);
      current = '';
    }
  }
  push(current);
  return out;
}

/** Share of non-dialogue sentences that read like rules. */
export function ruleSentenceRatio(text: string): number {
  const narration = stripMarkdown(text).replace(DIALOGUE, '');
  const sentences = splitSentences(narration).filter((s) => /[\p{L}\p{N}]/u.test(s));
  if (sentences.length === 0) return 0;
  const rules = sentences.filter((s) => RULE_WORDS.test(s)).length;
  return rules / sentences.length;
}

export function normalizeForQuote(text: string): string {
  return text.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '');
}

/** True when `quote` (≥ minChars significant characters) occurs in `text`, ignoring width, whitespace and punctuation. */
export function quoteIn(quote: string, text: string, minChars = 4): boolean {
  const q = normalizeForQuote(quote);
  if ([...q].length < minChars) return false;
  return normalizeForQuote(text).includes(q);
}
