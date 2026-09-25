import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StepContext } from '../context.ts';
import { readMarker, sha256Bytes } from '../marker.ts';
import { buildSealed, probeFiles, type ForecasterResult } from '../probe.ts';
import type { StepDef } from '../runner.ts';
import { seal } from '../seal.ts';
import { IntegrityError, storedTaskResult } from '../task.ts';
import { forecastTask } from '../tasks/forecast.ts';
import { readBriefJson, type BriefJson } from './brief.ts';
import { forecasterPool } from './forecast.ts';

const NONCE_BYTES = 32;
const HEX64 = /^[0-9a-f]{64}$/u;

/** `probes-meta.json`: the public forecaster list (who answered, who is void); never a forecast value. */
export interface ProbesMeta {
  round: string;
  probe: string;
  forecasters: Array<{ forecaster: string; family: string; model: string; writer_model: boolean; status: 'ok' | 'void' }>;
}

/** The nonce of a crashed 03b attempt is reused (same probe); otherwise 32 bytes from Entropy, written first. */
function sealNonce(ctx: StepContext, path: string): Buffer {
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8');
    const hex = text.slice(0, -1);
    if (!HEX64.test(hex) || text !== `${hex}\n`) throw new IntegrityError(`${ctx.files.rel(path)}: expected 64 lowercase hex digits and a LF`);
    return Buffer.from(hex, 'hex');
  }
  const nonce = ctx.ports.entropy.bytes(NONCE_BYTES);
  if (nonce.length !== NONCE_BYTES) throw new Error(`03b-seal: entropy returned ${nonce.length} bytes, not ${NONCE_BYTES}`);
  ctx.files.writeText(path, `${nonce.toString('hex')}\n`);
  return nonce;
}

/**
 * probes.sha256 holds bytes a `--redo-from` superseded: some `markers/stale/<n>/03b-seal.json` lists exactly them
 * (the runner allows such a redo only while probe.json is absent). A crashed 03b attempt is never superseded.
 */
function supersededByRedo(ctx: StepContext, path: string): boolean {
  const staleRoot = join(ctx.paths.markers, 'stale');
  if (!existsSync(path) || !existsSync(staleRoot)) return false;
  const rel = ctx.files.rel(path);
  const hash = sha256Bytes(readFileSync(path));
  return readdirSync(staleRoot).some((n) => {
    const m = readMarker(join(staleRoot, n, '03b-seal.json'));
    return m !== null && m.ok && m.value.outputs[rel] === hash;
  });
}

/** Every 03a record read back through storedTaskResult (checked, no call); a missing or mismatching record is an integrity error. */
function forecasterResults(ctx: StepContext, brief: BriefJson): ForecasterResult[] {
  const out: ForecasterResult[] = [];
  for (const p of forecasterPool(ctx)) {
    const r = storedTaskResult(ctx, p.backend, forecastTask(brief, p.forecaster), 'sealed');
    if (r === null) {
      const record = join(ctx.paths.sealedTasks, `forecast-${p.forecaster.backendId}.json`);
      throw new IntegrityError(`03b-seal: ${ctx.files.rel(record)} is missing (03a ran elsewhere or its record was removed)`);
    }
    out.push({
      forecaster: p.forecaster.backendId, family: p.backend.family, model: p.backend.model, writerModel: p.forecaster.writerDefault,
      status: r.value === null ? 'void' : 'ok', items: r.value ?? [],
    });
  }
  return out;
}

/**
 * 03b: nonce from Entropy, sealed.json, nonce.hex, probes.sha256, probes-meta.json; never reseals once marked.
 * probes.sha256 = SHA-256(nonce ‖ sealed.json) + LF; the marker lists sealed.json under `local` (salted hash).
 * A probe a `--redo-from` superseded (probe.json absent) is resealed with a fresh nonce, so the new probe shares no
 * nonce with one that may already sit on the pushed branch; any other probe already on disk is an integrity error.
 */
export const sealStep: StepDef = {
  id: '03b-seal',
  run: async (ctx) => {
    const files = probeFiles(ctx.paths);
    if (existsSync(files.probe)) throw new IntegrityError(`03b-seal: rounds/${ctx.roundId}/probe.json exists; a published probe is never resealed`);
    const brief = readBriefJson(ctx);
    const results = forecasterResults(ctx, brief);
    const reseal = supersededByRedo(ctx, files.probes);
    if (reseal) {
      ctx.files.remove(files.nonce);
      ctx.log(`03b-seal: rounds/${ctx.roundId}/probes.sha256 was superseded by --redo-from; resealing with a fresh nonce`);
    }
    const nonce = sealNonce(ctx, files.nonce);
    const sealed = seal(buildSealed(ctx.roundId, brief.row_id, sha256Bytes(readFileSync(ctx.paths.brief)), results), nonce);
    const probeText = `${sealed.probe}\n`;
    if (!reseal && existsSync(files.probes) && readFileSync(files.probes, 'utf8') !== probeText) {
      throw new IntegrityError(`03b-seal: rounds/${ctx.roundId}/probes.sha256 holds another probe; the seal is never redone`);
    }
    const meta: ProbesMeta = {
      round: ctx.roundId,
      probe: sealed.probe,
      forecasters: results.map((r) => ({ forecaster: r.forecaster, family: r.family, model: r.model, writer_model: r.writerModel, status: r.status })),
    };
    const outputs = [ctx.files.writeText(files.sealed, sealed.canonical), ctx.files.writeText(files.probes, probeText), ctx.files.writeJson(files.meta, meta)];
    return { kind: 'done', inputs: [ctx.files.rel(ctx.paths.brief)], outputs, external: [] };
  },
};
