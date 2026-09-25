import { seededShuffle } from './store.ts';
import { stripMarkdown } from './text.ts';

const HEADING = /^\s{0,3}#{1,6}(?:\s|$)/u;
const CURLY_QUOTES = /[“”‘’]/gu;
const CORNER_QUOTES = new Map([
  ['“', '「'],
  ['”', '」'],
  ['‘', '『'],
  ['’', '』'],
]);
const ELLIPSIS = /\.{3,}|。{3,}/gu;
const BASE_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

function dropLeadingHeading(text: string): string {
  const lines = text.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  const line = lines[first];
  if (line === undefined || !HEADING.test(line)) return text;
  lines.splice(first, 1);
  return lines.join('\n');
}

/** A line holding only 1-6 `#` is an empty heading; stripMarkdown keeps it because it needs text after the marker. */
const EMPTY_HEADING = /^\s{0,3}#{1,6}\s*$/u;

/** One typesetting pass; the leading heading is dropped once beforehand, never here. */
function typesetOnce(text: string): string {
  const typeset = stripMarkdown(text)
    .replace(CURLY_QUOTES, (ch) => CORNER_QUOTES.get(ch) ?? ch)
    .replace(ELLIPSIS, '……');
  return typeset
    .split('\n')
    .map((line) => (EMPTY_HEADING.test(line) ? '' : line.trimEnd()))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/**
 * The leading heading is dropped exactly once, on the raw input: a line that only becomes `# …` after stripping
 * (`> # 通告`, `    # 代码`, `# # x`) is text and must reach the judges. One typesetting pass is not always
 * idempotent (stripMarkdown removes one marker per line, so `# # x` leaves `# x`), so passes repeat until the
 * text is stable. No pass lengthens the text and quote mapping is one-shot, so the loop terminates. At the
 * fixed point no line matches a heading, so anonymizing the output again changes nothing.
 */
export function anonymizeText(markdown: string): string {
  let current = dropLeadingHeading(markdown);
  let next = typesetOnce(current);
  while (next !== current) {
    current = next;
    next = typesetOnce(current);
  }
  return next;
}

function labelAt(index: number): string {
  return BASE_LABELS[index] ?? `X${index}`;
}

/** Ids are sorted first so the mapping depends only on the id set and the seed, not on input order. */
export function assignLabels(ids: readonly string[], seed: string): Record<string, string> {
  const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === sorted[i - 1]) throw new RangeError(`assignLabels: duplicate id ${JSON.stringify(sorted[i])}`);
  }
  const labels = new Map<string, string>();
  seededShuffle(sorted, seed, 'labels').forEach((id, i) => labels.set(id, labelAt(i)));
  return Object.fromEntries(labels);
}
