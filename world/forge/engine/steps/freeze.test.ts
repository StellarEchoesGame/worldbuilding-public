import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeBackend } from '../adapters/fake.ts';
import type { Backend } from '../adapters/types.ts';
import { loadConfig } from '../config.ts';
import { buildContext, type RoundBackends, type StartOptions, type StepContext } from '../context.ts';
import { parseFreeze } from '../freeze.ts';
import { readRecord } from '../json.ts';
import { sha256Bytes } from '../marker.ts';
import { loadSchema, validate } from '../schema.ts';
import { runSteps, stepsSha256, type RunReport, type StepDef } from '../runner.ts';
import { roundPaths } from '../store.ts';
import { fakePorts, type FakePorts } from '../testing/fakes.ts';
import { DEFAULT_FIXTURE, fixtureWorld, type FixtureOptions, type FixtureWorld } from '../testing/fixture-world.ts';
import { ownerSim, type OwnerSim } from '../testing/owner-sim.ts';
import { briefStep } from './brief.ts';
import { freezeStep } from './freeze.ts';
import { startStep } from './start.ts';
import { topicStep } from './topic.ts';

interface Harness {
  w: FixtureWorld;
  ports: FakePorts;
  ctx: StepContext;
  sim: OwnerSim;
}

function harness(startOptions: StartOptions = { cell: 'cells/E2E-R01.json', seed: null }, opts: FixtureOptions = DEFAULT_FIXTURE, roundId = 'R01'): Harness {
  const w = fixtureWorld(mkdtempSync(join(tmpdir(), 'forge-freeze-')), opts);
  const loaded = loadConfig(w.root, { requireLocal: true });
  if (!loaded.ok) throw new Error(loaded.error);
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: '2026-10-01T00:00:00.000Z', seed: 'start-seed' });
  const reply = (): string => '```json\n{}\n```';
  const gw = (id: string): Backend => fakeBackend(id, 'DeepSeek', reply);
  const judges = loaded.value.judges.map((j) => ({ backend: fakeBackend(j.id, j.family, reply), concurrency: j.concurrency }));
  const backends: RoundBackends = {
    writers: ['W1', 'W2', 'W3'].map((slot) => ({ slot, backend: gw(slot) })),
    baseline: gw('BASE'), decoy: gw('decoy'), defect: gw('defect'), judges,
    forecasters: judges.map((j) => j.backend), maintainer: gw('maintainer'), mergeEditor: gw('merge_editor'), calibGateway: new Map(),
  };
  const built = buildContext({
    root: w.root, repo: w.repo, roundId, pipeline: 'round', paths: roundPaths(w.root, roundId), config: loaded.value,
    deps: { ports, backends: () => backends, env: {}, pid: 4242, isAlive: (pid) => pid === 4242, log: () => undefined },
    startOptions, quotaBudgetMs: null,
  });
  if (!built.ok) throw new Error(built.error);
  return { w, ports, ctx: built.value, sim: ownerSim(w.root, ports.clock) };
}

/** 02b stand-in: the fixture's SHIP champion (owner pick of P00) was set by another round. */
const baselineStub: StepDef = { id: '02b-baseline', run: async () => ({ kind: 'skip', reason: 'champion set by P00' }) };
const PIPELINE: readonly StepDef[] = [startStep, topicStep, briefStep, baselineStub, freezeStep];

function run(ctx: StepContext, steps: readonly StepDef[] = PIPELINE): Promise<RunReport> {
  return runSteps(ctx, { pipeline: 'round', steps, until: null, from: null, redoFrom: null, pid: 4242, isAlive: (pid) => pid === 4242 });
}


function jsonAt(path: string): unknown {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return raw;
}

function fileSha(path: string): string {
  return sha256Bytes(readFileSync(path));
}

function freezeOf(ctx: StepContext): ReturnType<typeof parseFreeze> {
  return parseFreeze(jsonAt(ctx.paths.freeze));
}

test('02c-freeze pins seed, steps_sha256, benchmark_resolution, gate_families, trust_status_sha256 and skills', async () => {
  const h = harness();
  const report = await run(h.ctx);
  assert.equal(report.exitCode, 0, report.detail);
  const parsed = freezeOf(h.ctx);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  const f = parsed.value;
  const root = h.w.root;
  assert.equal(f.round, 'R01');
  assert.equal(f.seed, h.ctx.start().seed);
  assert.equal(f.steps_sha256, stepsSha256(PIPELINE.map((s) => s.id)));
  assert.equal(f.benchmark_version, 'v1');
  assert.deepEqual(f.benchmark_resolution, { version: 'v1', sha256: fileSha(join(root, 'benchmark', 'v1.json')), path: 'benchmark/v1.json', via: 'activate', since: f.benchmark_resolution?.since ?? '?' });
  assert.deepEqual([...f.gate_families].sort(), ['Anthropic', 'Moonshot', 'OpenAI', 'xAI']);
  assert.deepEqual([...f.eligible_families].sort(), ['Anthropic', 'Moonshot', 'OpenAI', 'xAI']);
  assert.deepEqual(f.flags, { OpenAI: 'ok', Anthropic: 'ok', Moonshot: 'ok', xAI: 'ok' });
  assert.equal(f.trust_status_sha256, fileSha(join(root, 'calibration', 'status.json')));
  assert.deepEqual(f.skills, {
    'metabolic-cultures': fileSha(join(root, 'skills', 'metabolic-cultures.md')),
    'systemic-worldbuilding': fileSha(join(root, 'skills', 'systemic-worldbuilding.md')),
  });
  assert.equal(f.probe_created_at, null);
  assert.equal(f.protocol_bundle_sha256, h.ctx.bundleSha256);
  assert.deepEqual(Object.keys(f.sha256).sort(), ['BOOK.md', 'REFERENCE.md', 'benchmark', 'brief.json', 'champion', 'fact-status.json', 'regression', 'writers.json']);
  assert.equal(f.sha256['brief.json'], fileSha(h.ctx.paths.brief));
  assert.equal(f.sha256['BOOK.md'], fileSha(join(h.w.repo, 'world', 'current', 'BOOK.md')));
  const schema = loadSchema(jsonAt(join(root, 'schema', 'freeze.schema.json')));
  assert.ok(schema.ok);
  assert.deepEqual(validate(schema.value, jsonAt(h.ctx.paths.freeze)), []);
  const inputs = Object.keys(readRecord(jsonAt(join(h.ctx.paths.markers, '02c-freeze.json')), 'inputs') ?? {}).sort();
  assert.deepEqual(inputs, ['fact-status.json', 'regression/wb-b1.json', 'rounds/R01/brief.json', 'writers.json']);
});

test('02c-freeze: resume refuses drift of a pinned skill or the fact table (exit 3), not an owner-log append', async () => {
  const h = harness();
  assert.equal((await run(h.ctx)).exitCode, 0);
  h.sim.viewBenchDiff('v1');
  assert.equal((await run(h.ctx)).exitCode, 0, 'owner-log appends are not drift');
  const skill = join(h.w.root, 'skills', 'metabolic-cultures.md');
  const original = readFileSync(skill, 'utf8');
  appendFileSync(skill, '\n多一行。\n');
  const drift = await run(h.ctx);
  assert.equal(drift.exitCode, 3);
  assert.match(drift.detail, /skills\/metabolic-cultures\.md/u);
  writeFileSync(skill, original);
  appendFileSync(join(h.w.root, 'fact-status.json'), '\n');
  const facts = await run(h.ctx);
  assert.equal(facts.exitCode, 3);
  assert.match(facts.detail, /fact-status\.json/u);
});

test('02c-freeze waits for benchmark approval when no benchmark is effective', async () => {
  const h = harness();
  assert.equal((await run(h.ctx, PIPELINE.slice(0, 4))).exitCode, 0);
  writeFileSync(join(h.w.root, 'benchmark', 'log.jsonl'), '');
  const report = await run(h.ctx);
  assert.equal(report.exitCode, 2);
  assert.equal(report.step, '02c-freeze');
  assert.equal(report.waitingFor, 'benchmark_approval');
});

test('02c-freeze pins the benchmark effective when 02a read it; a view after 02a waits for --redo-from 02a-brief', async () => {
  const h = harness();
  assert.equal((await run(h.ctx, PIPELINE.slice(0, 4))).exitCode, 0);
  const root = h.w.root;
  const v1: unknown = jsonAt(join(root, 'benchmark', 'v1.json'));
  assert.ok(typeof v1 === 'object' && v1 !== null);
  const v2Text = `${JSON.stringify({ ...v1, version: 'v2', parent: 'v1' }, null, 2)}\n`;
  writeFileSync(join(root, 'benchmark', 'v2.json'), v2Text);
  const logPath = join(root, 'benchmark', 'log.jsonl');
  const entry: unknown = JSON.parse(readFileSync(logPath, 'utf8').trim());
  assert.ok(typeof entry === 'object' && entry !== null);
  appendFileSync(logPath, `${JSON.stringify({ ...entry, at: '2026-09-20T00:00:00.000Z', cycle: 'R00', version: 'v2', parent: 'v1', sha256: fileSha(join(root, 'benchmark', 'v2.json')), path: 'benchmark/v2.json' })}\n`);
  h.ports.clock.advance(60_000);
  h.sim.viewBenchDiff('v2');
  const frozen = await run(h.ctx);
  assert.equal(frozen.exitCode, 0, frozen.detail);
  const pinned = freezeOf(h.ctx);
  assert.ok(pinned.ok);
  assert.equal(pinned.value.benchmark_resolution?.path, 'benchmark/v1.json', 'v2 took effect after the brief read v1');
  const redo = await runSteps(h.ctx, { pipeline: 'round', steps: PIPELINE, until: null, from: null, redoFrom: '02a-brief', pid: 4242, isAlive: (pid) => pid === 4242 });
  assert.equal(redo.exitCode, 0, redo.detail);
  const f = freezeOf(h.ctx);
  assert.ok(f.ok);
  assert.equal(f.value.benchmark_version, 'v2');
  assert.equal(f.value.benchmark_resolution?.path, 'benchmark/v2.json');
});

test('02c-freeze: an R round without calibration/status.json or with < 3 qualified families is blocked (exit 4)', async () => {
  const none = harness(undefined, { ...DEFAULT_FIXTURE, trust: 'none' });
  const r1 = await run(none.ctx);
  assert.equal(r1.exitCode, 4);
  assert.equal(r1.step, '02c-freeze');
  assert.match(r1.detail, /^calibration: /u);
  const two = harness(undefined, { ...DEFAULT_FIXTURE, trust: { qualified: ['Anthropic', 'OpenAI'] } });
  const r2 = await run(two.ctx);
  assert.equal(r2.exitCode, 4);
  assert.match(r2.detail, /qualified/u);
});

test('02c-freeze: a P round without calibration status freezes every judge family as ok', async () => {
  const h = harness(undefined, { ...DEFAULT_FIXTURE, trust: 'none' }, 'P02');
  const report = await run(h.ctx);
  assert.equal(report.exitCode, 0, report.detail);
  const f = freezeOf(h.ctx);
  assert.ok(f.ok);
  assert.deepEqual(f.value.flags, { OpenAI: 'ok', Anthropic: 'ok', Moonshot: 'ok', xAI: 'ok' });
  assert.deepEqual([...f.value.gate_families].sort(), ['Anthropic', 'Moonshot', 'OpenAI', 'xAI']);
  assert.equal(f.value.trust_status_sha256, null);
});

test('02c-freeze refuses to run outside runSteps (steps_sha256 needs the pipeline)', async () => {
  const h = harness();
  assert.equal((await run(h.ctx, PIPELINE.slice(0, 4))).exitCode, 0);
  await assert.rejects(freezeStep.run(h.ctx, null), /runs only inside runSteps/u);
});
