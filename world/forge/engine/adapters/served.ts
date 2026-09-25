import type { CallResult } from './types.ts';

/**
 * Voids a call whose served model is outside `accepted`. An empty list means the CLI does not report a served
 * model (Codex, Kimi), so nothing is checked; a non-empty list also voids a call that reports no served model.
 * The served model stays on the record for provenance.
 */
export function checkServed(r: CallResult, accepted: readonly string[]): CallResult {
  if (!r.ok || accepted.length === 0) return r;
  if (r.servedModel === null) return { ...r, ok: false, error: 'served model not reported' };
  if (!accepted.includes(r.servedModel)) return { ...r, ok: false, error: `served model ${r.servedModel} is not in accepted_served` };
  return r;
}
