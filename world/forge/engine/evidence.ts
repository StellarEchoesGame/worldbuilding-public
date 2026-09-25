import { createHash } from 'node:crypto';
import { readArray, readString } from './json.ts';

export interface EvidenceItem {
  source: string;
  quote: string;
}

export interface RegressionItem {
  case: string;
  source: string;
  quote: string;
}

export interface RegressionCheck {
  live: number;
  stale: RegressionItem[];
}

/** CRLF and lone CR become LF, matching Python's universal-newline read_text() in WB-B1 score.py. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/gu, '\n');
}

type QuoteState = 'live' | 'unknown source' | 'not found';

function quoteState(item: EvidenceItem, sources: Record<string, string>): QuoteState {
  const text = Object.hasOwn(sources, item.source) ? sources[item.source] : undefined;
  if (text === undefined) return 'unknown source';
  if (item.quote === '' || !normalizeNewlines(text).includes(item.quote)) return 'not found';
  return 'live';
}

/** Exact-substring evidence check ported from WB-B1 score.py; the quote itself is never normalised. */
export function checkQuotes(items: ReadonlyArray<EvidenceItem>, sources: Record<string, string>, where: string): string[] {
  if (items.length === 0) return [`${where}: evidence missing`];
  const errors: string[] = [];
  for (const item of items) {
    const state = quoteState(item, sources);
    if (state === 'unknown source') errors.push(`${where}: unknown source`);
    else if (state === 'not found') errors.push(`${where}: quote not found in ${item.source}`);
  }
  return errors;
}

export function checkFrozen(expected: Record<string, string>, readBytes: (path: string) => Buffer | null): string[] {
  const errors: string[] = [];
  for (const [path, hash] of Object.entries(expected)) {
    const bytes = readBytes(path);
    if (bytes === null) errors.push(`frozen file missing: ${path}`);
    else if (createHash('sha256').update(bytes).digest('hex') !== hash) errors.push(`frozen file changed: ${path}`);
  }
  return errors;
}

export function extractRegression(judges: ReadonlyArray<{ name: string; data: unknown }>, cases: readonly string[]): RegressionItem[] {
  const out: RegressionItem[] = [];
  const seen = new Set<string>();
  for (const judge of judges) {
    const rows = readArray(judge.data, 'cases') ?? [];
    for (const id of cases) {
      for (const row of rows) {
        if (readString(row, 'id') !== id) continue;
        for (const entry of readArray(row, 'evidence') ?? []) {
          const source = readString(entry, 'source');
          const quote = readString(entry, 'quote');
          // score.py already rejected judge files with malformed evidence, so such entries carry no regression quote.
          if (source === null || quote === null) continue;
          const key = JSON.stringify([source, quote]);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ case: id, source, quote });
        }
      }
    }
  }
  return out;
}

export function recheckRegression(items: ReadonlyArray<RegressionItem>, sources: Record<string, string>): RegressionCheck {
  let live = 0;
  const stale: RegressionItem[] = [];
  for (const item of items) {
    if (quoteState(item, sources) === 'live') live += 1;
    else stale.push({ case: item.case, source: item.source, quote: item.quote });
  }
  return { live, stale };
}
