import { readFileSync } from 'node:fs';
import { isIsoTimestamp } from '../../../engine/store.ts';
import { isRealData } from './data.ts';

/** Env var naming a file whose content is the ISO timestamp the UI stamps (fixture data only; the test harness sets it). */
export const CLOCK_FILE_ENV = 'FORGE_UI_CLOCK_FILE';

/**
 * The timestamp every owner write and time-dependent view uses. Real data → the wall clock, always. Fixture data with
 * FORGE_UI_CLOCK_FILE set → that file's ISO timestamp (the harness mirrors the engine's fake clock into it), so owner
 * entries and engine entries order the way they would on one real clock.
 */
export function uiNow(): string {
  const file = process.env[CLOCK_FILE_ENV];
  if (file === undefined || file === '' || isRealData()) return new Date().toISOString();
  const text = readFileSync(file, 'utf8').trim();
  if (!isIsoTimestamp(text)) throw new Error(`${CLOCK_FILE_ENV}: not an ISO timestamp`);
  return text;
}
