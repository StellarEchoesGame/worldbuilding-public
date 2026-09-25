import { anonymizeText, assignLabels } from './anonymize.ts';
import { isRecord, readBoolean, readString } from './json.ts';
import { readJson, roundPaths, type RoundPaths } from './store.ts';
import { parseWriterOutput, type WriterOutput } from './writer-output.ts';

/** Submission id of the row's champion text in a round (the baseline when this round wrote it). */
export const CHAMPION_ID = 'BASE';

export interface LoadedSubmission {
  id: string;
  kind: 'writer' | 'baseline';
  model: string;
  family: string;
  stance: string | null;
  ok: boolean;
  error: string | null;
  output: WriterOutput | null;
}

/** `submissions/<id>.json` → LoadedSubmission, or null when absent / malformed. */
export function loadSubmission(paths: RoundPaths, id: string): LoadedSubmission | null {
  const rec = readJson(`${paths.submissions}/${id}.json`);
  const kind = readString(rec, 'kind');
  const model = readString(rec, 'model');
  const family = readString(rec, 'family');
  if (kind === null || model === null || family === null || (kind !== 'writer' && kind !== 'baseline')) return null;
  const text = readString(rec, 'text') ?? '';
  const parsed = readBoolean(rec, 'ok') === true ? parseWriterOutput(text) : null;
  return {
    id,
    kind,
    model,
    family,
    stance: readString(rec, 'stance'),
    ok: parsed !== null && parsed.ok,
    error: parsed !== null && !parsed.ok ? parsed.error : readString(rec, 'error'),
    output: parsed !== null && parsed.ok ? parsed.value : null,
  };
}

/** The text judges and the owner see: Markdown and typographic tells removed. */
export function displayText(out: WriterOutput): string {
  return anonymizeText(out.submission);
}

export function submissionFor(root: string, roundId: string, id: string): LoadedSubmission | null {
  return loadSubmission(roundPaths(root, roundId), id);
}

/** Seeded A/B/C labels (label → id); an existing labels.json naming exactly these ids is kept, so labels never move under the owner. */
export function stableLabels(paths: RoundPaths, ids: readonly string[], seed: string): Record<string, string> {
  const existing = readJson(`${paths.dir}/labels.json`);
  if (isRecord(existing)) {
    const kept: Record<string, string> = {};
    for (const [label, id] of Object.entries(existing)) if (typeof id === 'string') kept[label] = id;
    const keptIds = Object.values(kept).sort();
    const wanted = [...ids].sort();
    if (keptIds.length === wanted.length && keptIds.every((id, i) => id === wanted[i])) return kept;
  }
  const byId = assignLabels(ids, seed);
  return Object.fromEntries(Object.entries(byId).map(([id, label]) => [label, id]));
}
