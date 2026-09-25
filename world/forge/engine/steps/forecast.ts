import type { Backend } from '../adapters/types.ts';
import type { StepContext } from '../context.ts';
import { runAll, type StepDef } from '../runner.ts';
import { runSealedTask } from '../task.ts';
import { forecastTask, type Forecaster } from '../tasks/forecast.ts';
import { readBriefJson } from './brief.ts';

export interface PooledForecaster {
  backend: Backend;
  forecaster: Forecaster;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `ctx.backends.forecasters` (judges + one gateway backend per distinct writer model) without judges whose family
 * freeze.json flags `suspended` (flagged or taste-unqualified families still forecast); one entry per backend id,
 * sorted by id. `writerDefault` = the model is a writers.json slot model.
 */
export function forecasterPool(ctx: StepContext): PooledForecaster[] {
  const judgeIds = new Set(ctx.backends.judges.map((j) => j.backend.id));
  const flags = ctx.freeze().flags;
  const writerModels = new Set(ctx.config.slots.map((s) => s.model));
  const seen = new Set<string>();
  const out: PooledForecaster[] = [];
  for (const backend of ctx.backends.forecasters) {
    if (seen.has(backend.id)) continue;
    seen.add(backend.id);
    if (judgeIds.has(backend.id) && flags[backend.family] === 'suspended') continue;
    out.push({ backend, forecaster: { backendId: backend.id, model: backend.model, writerDefault: writerModels.has(backend.model) } });
  }
  return out.sort((a, b) => byCodeUnit(a.forecaster.backendId, b.forecaster.backendId));
}

/**
 * 03a: one runSealedTask per forecaster (plaintext only under .sealed/, marker records counts only). A void
 * forecaster is tolerated (03b lists it in probes-meta.json); all void still seals an empty list (surprise invalid).
 */
export const forecastStep: StepDef = {
  id: '03a-forecast',
  run: async (ctx) => {
    const brief = readBriefJson(ctx);
    const pool = forecasterPool(ctx);
    const results = await runAll(ctx, pool.map((p) => () => runSealedTask(ctx, p.backend, forecastTask(brief, p.forecaster))));
    const ok = results.filter((r) => r.value !== null).length;
    ctx.log(`03a-forecast: ${ok} of ${pool.length} forecaster(s) answered, ${pool.length - ok} void`);
    return { kind: 'done', inputs: [ctx.files.rel(ctx.paths.brief)], outputs: [], external: [] };
  },
};
