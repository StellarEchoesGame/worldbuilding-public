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

export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const chars = [...text];
  let current = '';
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] ?? '';
    if (ch === '\n') {
      if (current.trim() !== '') out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
    if (TERMINATORS.has(ch)) {
      while (i + 1 < chars.length && (TERMINATORS.has(chars[i + 1] ?? '') || CLOSERS.has(chars[i + 1] ?? ''))) {
        i += 1;
        current += chars[i] ?? '';
      }
      if (current.trim() !== '') out.push(current.trim());
      current = '';
    }
  }
  if (current.trim() !== '') out.push(current.trim());
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

/** True when `quote` (≥4 significant characters) occurs in `text`, ignoring width, whitespace and punctuation. */
export function quoteIn(quote: string, text: string): boolean {
  const q = normalizeForQuote(quote);
  if ([...q].length < 4) return false;
  return normalizeForQuote(text).includes(q);
}
