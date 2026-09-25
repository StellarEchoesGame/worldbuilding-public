import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeBenchmark, type Resolution } from '../bench-active.ts';
import { readChampions } from '../champions.ts';
import type { StepContext } from '../context.ts';
import { buildFreeze } from '../freeze.ts';
import { readMarker, sha256Bytes } from '../marker.ts';
import { protocolGate } from '../owner-inputs.ts';
import { err, ok, type Result } from '../result.ts';
import { activeRun, type StepDef } from '../runner.ts';
import { IntegrityError } from '../task.ts';
import { readCanaryFailed, readTrustStatus, trustPins } from '../trust-status.ts';
import { benchmarkUnresolved, FACT_STATUS_FILE, readRoundBrief, REGRESSION_FILE } from './brief.ts';

export const WRITERS_FILE = 'writers.json';
export const TRUST_STATUS_FILE = 'calibration/status.json';
export const SKILLS_DIR = 'skills';

const BENCH_PATH = /^benchmark\/[^/]+\.json$/u;

function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** SHA-256 of the file bytes (what markers and the runner's drift check compare). */
function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

/** Skill snapshot name (`skills/<name>.md`) → SHA-256 of its bytes, for every snapshot present. */
export function skillHashes(root: string): Record<string, string> {
  const dir = join(root, SKILLS_DIR);
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) out[name.slice(0, -'.md'.length)] = sha256File(join(dir, name));
  return out;
}

/** The benchmark file 02a took its cliché list from (its marker's inputs), null when 02a is not marked. */
function briefBenchmark(ctx: StepContext): string | null {
  const m = readMarker(join(ctx.paths.markers, '02a-brief.json'));
  if (m === null || !m.ok) return null;
  return Object.keys(m.value.inputs).find((k) => BENCH_PATH.test(k)) ?? null;
}

/** The files whose SHA-256 freeze.json pins by logical name; err names the first one missing. */
function pinnedFiles(ctx: StepContext, briefText: string, championText: string, benchmarkText: string): Result<Record<string, string>> {
  const current = join(ctx.repo, 'world', 'current');
  const sources: Array<[string, string]> = [
    ['BOOK.md', join(current, 'BOOK.md')],
    ['REFERENCE.md', join(current, 'reference', 'REFERENCE.md')],
    ['writers.json', join(ctx.root, WRITERS_FILE)],
    ['fact-status.json', join(ctx.root, FACT_STATUS_FILE)],
    ['regression', join(ctx.root, REGRESSION_FILE)],
  ];
  const files: Record<string, string> = { 'brief.json': briefText, champion: championText, benchmark: benchmarkText };
  for (const [name, path] of sources) {
    const text = readText(path);
    if (text === null) return err(`${name} missing: nothing to pin`);
    files[name] = text;
  }
  return ok(files);
}

function resolutionOf(r: Resolution): Resolution {
  return { version: r.version, sha256: r.sha256, path: r.path, via: r.via, since: r.since };
}

/**
 * 02c-freeze: protocol gate, effective benchmark resolution at brief.json's created_at (the moment 02a read its
 * cliché list, so both name the same file and a later view or rollback waits for the next freeze), trust pins
 * (blocked when an R round lacks ≥ 3 qualified families),
 * skills, then freeze.json with `probe_created_at: null`. Runs only inside runSteps (`steps_sha256` pins the
 * pipeline actually run).
 */
export const freezeStep: StepDef = {
  id: '02c-freeze',
  run: async (ctx) => {
    const gate = protocolGate(ctx);
    if (gate !== null) return gate;
    const run = activeRun(ctx);
    if (run === null) throw new Error('02c-freeze runs only inside runSteps: steps_sha256 needs the pipeline being run');
    const { text: briefText, brief } = readRoundBrief(ctx);

    const bench = activeBenchmark(ctx, 'effective', brief.created_at);
    if (!bench.ok) return benchmarkUnresolved(bench.error);
    const fromBrief = briefBenchmark(ctx);
    if (fromBrief !== null && fromBrief !== bench.value.path) {
      return { kind: 'failed', detail: `effective benchmark changed after 02a-brief (${fromBrief} → ${bench.value.path}); rerun with --redo-from 02a-brief` };
    }

    const status = readTrustStatus(ctx.root);
    if (status !== null && !status.ok) throw new IntegrityError(`${TRUST_STATUS_FILE}: ${status.error}`);
    const canary = readCanaryFailed(ctx.root);
    if (!canary.ok) throw new IntegrityError(canary.error);
    const pins = trustPins(status === null ? null : status.value, ctx.roundId, ctx.config.judges, canary.value, ctx.protocol.calibration);
    if (!pins.ok) return { kind: 'blocked', detail: `calibration: ${pins.error}` };

    const champions = readChampions(ctx.root);
    if (!champions.ok) throw new IntegrityError(champions.error);
    const champion = Object.hasOwn(champions.value, brief.row_id) ? champions.value[brief.row_id] : undefined;
    if (champion === undefined) return { kind: 'failed', detail: `champions.json has no champion for row ${brief.row_id} (02b-baseline sets it)` };

    const files = pinnedFiles(ctx, briefText, champion.text, bench.value.text);
    if (!files.ok) return { kind: 'failed', detail: files.error };
    const trustPath = join(ctx.root, TRUST_STATUS_FILE);
    const record = buildFreeze({
      round: ctx.roundId,
      files: files.value,
      benchmarkVersion: bench.value.version,
      eligibleFamilies: pins.value.eligibleFamilies,
      flags: pins.value.flags,
      protocolBundleSha256: ctx.bundleSha256,
      probeCreatedAt: null,
      seed: ctx.seed(),
      stepsSha256: run.stepsSha256,
      benchmarkResolution: resolutionOf(bench.value),
      gateFamilies: pins.value.gateFamilies,
      trustStatusSha256: existsSync(trustPath) ? sha256File(trustPath) : null,
      skills: skillHashes(ctx.root),
    });
    const out = ctx.files.writeJson(ctx.paths.freeze, record);
    return { kind: 'done', inputs: [ctx.files.rel(ctx.paths.brief), WRITERS_FILE, FACT_STATUS_FILE, REGRESSION_FILE], outputs: [out], external: [] };
  },
};
