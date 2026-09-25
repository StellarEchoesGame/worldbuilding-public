import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeBackend } from './adapters/fake.ts';
import { drainAfterRun, roundContext } from './cli-round.ts';
import type { EngineDeps, RoundBackends } from './context.ts';
import { postedBenchNotices } from './mirror-log.ts';
import { pendingMirrors } from './mirror.ts';
import { fakePorts, type FakePorts } from './testing/fakes.ts';
import { DEFAULT_FIXTURE, fixtureWorld, type FixtureWorld } from './testing/fixture-world.ts';

/** Round 0 bench notices (cycles R00-init and R00) live in rounds/R00 and post on the epic issue (github.json #1). */
const START = '2026-10-01T06:00:00.000Z';
const EPIC = 1;

interface H {
  dir: string;
  w: FixtureWorld;
  ports: FakePorts;
  deps: EngineDeps;
  logs: string[];
}

/** Fixture world after round 0: the fixture's R00-init/v1 entry plus an R00/v2 entry, and a rounds/R00 directory. */
function harness(): H {
  const dir = mkdtempSync(join(tmpdir(), 'forge-mirror-r00-'));
  const w = fixtureWorld(dir, DEFAULT_FIXTURE);
  // before the log edit: the fake git lays the main tree into the working copy
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: START, seed: 'mirror-r00' });
  const logPath = join(w.root, 'benchmark', 'log.jsonl');
  const init: unknown = JSON.parse(readFileSync(logPath, 'utf8').trim());
  const r00 = { ...(typeof init === 'object' && init !== null ? init : {}), at: START, cycle: 'R00', outcome: 'pending_owner', version: 'v2', parent: 'v1', sha256: 'c'.repeat(64), path: 'benchmark/v2.json', activation: 'owner' };
  appendFileSync(logPath, `${JSON.stringify(r00)}\n`);
  mkdirSync(join(w.root, 'rounds', 'R00'), { recursive: true });
  const b = fakeBackend('x', 'DeepSeek', () => '');
  const backends: RoundBackends = { writers: [], baseline: b, decoy: b, defect: b, judges: [], forecasters: [], maintainer: b, mergeEditor: b, calibGateway: new Map() };
  const logs: string[] = [];
  const deps: EngineDeps = { ports, backends: () => backends, env: {}, pid: 7, isAlive: () => false, log: (line) => logs.push(line) };
  return { dir, w, ports, deps, logs };
}

function benchKeys(root: string, round: string): string[] {
  const r = pendingMirrors(root, round, START);
  if (!r.ok) throw new Error(r.error);
  return r.value.filter((m) => m.kind === 'bench_notice').map((m) => m.key);
}

test('R00 queues the bench notices of both round-0 cycles (R00-init and R00), keyed by version; R01 queues neither', () => {
  const h = harness();
  assert.deepEqual(benchKeys(h.w.root, 'R00'), ['v1', 'v2']);
  assert.deepEqual(benchKeys(h.w.root, 'R01'), []);
  rmSync(h.dir, { recursive: true, force: true });
});

test('the drain after a round run (drainAfterRun of R01) also posts the pending round-0 notices on the epic issue', async () => {
  const h = harness();
  const ctx = roundContext({ root: h.w.root, repo: h.w.repo }, h.deps, 'R01', 'round', { cell: null, seed: null }, null);
  if (!ctx.ok) throw new Error(ctx.error);
  await drainAfterRun(ctx.value, h.deps);
  const heads = h.ports.github.comments(EPIC).map((c) => c.body.split('\n', 1)[0]);
  assert.deepEqual(heads, ['<!-- forge:bench_notice R00 v1 -->', '<!-- forge:bench_notice R00 v2 -->'], h.logs.join('\n'));
  // the 24 h auto-activation clock starts at the posted notice (bench-active.ts)
  assert.deepEqual(postedBenchNotices(h.w.root).map((n) => n.version), ['v1', 'v2']);
  assert.deepEqual(benchKeys(h.w.root, 'R00'), []);
  // nothing left: a second drain posts nothing
  await drainAfterRun(ctx.value, h.deps);
  assert.equal(h.ports.github.comments(EPIC).length, 2);
  rmSync(h.dir, { recursive: true, force: true });
});
