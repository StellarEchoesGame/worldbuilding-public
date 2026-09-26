import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeBenchmark } from './bench-active.ts';
import { BENCH_R00_STEPS, evidenceStep, INITIAL_STEPS, initialPaths, readOutcome, readProposal } from './bench-cycle.ts';
import { readBenchLog } from './bench-log.ts';
import { MAINTAINER_KEYS } from './bench-validate.ts';
import { loadConfig } from './config.ts';
import { buildContext, type RoundBackends, type StepContext } from './context.ts';
import { isRecord, type JsonRecord } from './json.ts';
import { runSteps, type Pipeline, type RunReport, type StepDef } from './runner.ts';
import { IntegrityError } from './task.ts';
import { roundPaths, sha256, type RoundPaths } from './store.ts';
import { unwrap } from './tasks/fenced.ts';
import { fakePorts } from './testing/fakes.ts';
import { DEFAULT_FIXTURE, FIXTURE_WRITER_MODEL, fixtureWorld, type FixtureOptions } from './testing/fixture-world.ts';
import { ownerSim, type OwnerSim } from './testing/owner-sim.ts';
import { callLog, fakeRouter, type FakeRouter, type Route } from './testing/scripted.ts';

/*
 * The bench-initial pipeline (i1–i3 under benchmark/initial/, cycle R00-init) and the bench-r00 pipeline (11f–11j on
 * rounds/R00/, cycle R00) through runSteps, so markers, listed inputs / outputs and exit codes are the runner's.
 */

const START = '2026-10-01T00:00:00.000Z';
const REAL_V0 = fileURLToPath(new URL('../benchmark/v0.json', import.meta.url));

function fence(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

function record(text: string): JsonRecord {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error('not a JSON object');
  return value;
}

/** v1 as the fixture writes it: the v0 maintainer keys with a 2-detail decoy recipe and one cliché. */
const initialRoute: Route = () => {
  const v0 = record(readFileSync(REAL_V0, 'utf8'));
  const body: JsonRecord = Object.fromEntries(MAINTAINER_KEYS.map((k) => [k, v0[k]]));
  body['cliche_list'] = ['时光在指缝间流走'];
  body['decoy_recipe'] = { details: 2, instructions: '把现任稿中最具体的两个细节换成泛泛的同类说法，长度、段落和格式保持不变。' };
  return fence({ kind: 'change', body, reasons: [{ change: '根版本：沿用原型的问题与门槛', keys: [...MAINTAINER_KEYS], evidence_ids: [], expected_effect: '给第 0 轮一个可批准的起点' }] });
};

/** R00: decoy_recipe 2 → 3 citing the packet's first item (owner class: no replay). */
const decoyRoute: Route = (prompt) => {
  const head = record(unwrap(prompt, '当前版本') ?? 'null');
  const items = record(unwrap(prompt, '证据包') ?? 'null')['items'];
  const first = Array.isArray(items) && isRecord(items[0]) ? items[0]['id'] : null;
  const body: JsonRecord = Object.fromEntries(MAINTAINER_KEYS.map((k) => [k, head[k]]));
  body['decoy_recipe'] = { details: 3, instructions: '把现任稿中最具体的三个细节换成泛泛的同类说法，长度、段落和格式保持不变。' };
  return fence({ kind: 'change', body, reasons: [{ change: '诱饵多换一个细节', keys: ['decoy_recipe'], evidence_ids: [first], expected_effect: '诱饵更难被一眼认出' }] });
};

interface PipelineWorld {
  root: string;
  sim: OwnerSim;
  maintainer: FakeRouter;
  run(): Promise<RunReport>;
  ctx: StepContext;
}

function pipelineWorld(fixture: FixtureOptions, pipeline: Pipeline, steps: readonly StepDef[], route: Route, prepare: (root: string) => void = () => undefined): PipelineWorld {
  const w = fixtureWorld(mkdtempSync(join(tmpdir(), 'forge-bench-pipeline-')), fixture);
  prepare(w.root);
  const loaded = loadConfig(w.root, { requireLocal: true });
  if (!loaded.ok) throw new Error(loaded.error);
  const plain = fakeRouter({}, { id: 'W1', family: 'DeepSeek', model: FIXTURE_WRITER_MODEL });
  const maintainer = fakeRouter({ bench: route }, { id: 'maintainer', family: 'Anthropic', model: 'fixture-maintainer' });
  const judges = loaded.value.judges.map((j) => ({ backend: fakeRouter({}, { id: j.id, family: j.family, model: j.model }), concurrency: 2 }));
  const backends: RoundBackends = { writers: [{ slot: 'W1', backend: plain }], baseline: plain, decoy: plain, defect: plain, judges, forecasters: [], maintainer, mergeEditor: plain, calibGateway: new Map() };
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: START, seed: 'pipeline' });
  const paths: RoundPaths = pipeline === 'bench-initial' ? initialPaths(w.root) : roundPaths(w.root, 'R00');
  const built = buildContext({
    root: w.root, repo: w.repo, roundId: 'R00', pipeline, paths, config: loaded.value,
    deps: { ports, backends: () => backends, env: {}, pid: 7, isAlive: () => false, log: () => undefined }, startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
  });
  if (!built.ok) throw new Error(built.error);
  const ctx = built.value;
  const run = (): Promise<RunReport> => runSteps(ctx, { pipeline, steps, until: null, from: null, redoFrom: null, pid: 7, isAlive: () => false });
  return { root: w.root, sim: ownerSim(w.root, ports.clock), maintainer, run, ctx };
}

const NO_BENCH: FixtureOptions = { benchmark: 'none', champions: 'ship_owner_pick', trust: 'none', protocolApproved: false };

test('bench-initial: WAIT protocol_approval before any call; after approval i1–i3 log v1 pending_owner (root = owner class)', async () => {
  const x = pipelineWorld(NO_BENCH, 'bench-initial', INITIAL_STEPS, initialRoute);
  const waiting = await x.run();
  assert.deepEqual([waiting.exitCode, waiting.step, waiting.waitingFor], [2, 'i1-propose', 'protocol_approval']);
  assert.equal(callLog(x.maintainer).length, 0);
  assert.ok(!existsSync(join(x.root, 'benchmark/v1.json')));
  x.sim.approveProtocol();
  const done = await x.run();
  assert.equal(done.exitCode, 0, done.detail);
  assert.equal(callLog(x.maintainer).length, 1);
  assert.deepEqual(callLog(x.maintainer), ['bench-initial#1']);
  const log = readBenchLog(x.root);
  assert.ok(log.ok);
  assert.equal(log.value.length, 1);
  const line = log.value[0];
  assert.ok(line !== undefined);
  assert.deepEqual([line.cycle, line.outcome, line.version, line.parent, line.activation, line.path], ['R00-init', 'pending_owner', 'v1', null, 'owner', 'benchmark/v1.json']);
  assert.deepEqual(line.calls, ['benchmark/initial/calls/bench-initial-a1.json']);
  assert.equal(line.evidence_packet, null);
  const v1 = record(readFileSync(join(x.root, 'benchmark/v1.json'), 'utf8'));
  assert.deepEqual([v1['version'], v1['parent']], ['v1', null]);
  assert.equal(line.sha256, sha256(readFileSync(join(x.root, 'benchmark/v1.json'), 'utf8')));
  const outcome = readOutcome(initialPaths(x.root));
  assert.ok(outcome !== null && outcome.ok);
  assert.deepEqual(outcome.value, line);
  for (const id of ['i1-propose', 'i2-validate', 'i3-outcome']) assert.ok(existsSync(join(x.root, 'benchmark/initial/markers', `${id}.json`)), id);
  assert.ok(!existsSync(join(x.root, 'rounds')), 'the initial pipeline writes nothing under rounds/');
  assert.ok(!activeBenchmark(x.ctx, 'effective').ok, 'a pending v1 is not in effect before the owner approves it');
  x.sim.approveBench('v1');
  const approved = activeBenchmark(x.ctx, 'effective');
  assert.ok(approved.ok && approved.value.version === 'v1' && approved.value.via === 'approved');
  const again = await x.run();
  assert.equal(again.exitCode, 0);
  assert.equal(callLog(x.maintainer).length, 1, 'a finished pipeline makes no further call');
});

test('bench-initial: refused (exit 5, no call) once calibration answers exist', async () => {
  const x = pipelineWorld({ ...NO_BENCH, protocolApproved: true }, 'bench-initial', INITIAL_STEPS, initialRoute);
  x.sim.writeUnlogged('calibration/owner-answers.json', { sets: {} });
  const r = await x.run();
  assert.deepEqual([r.exitCode, r.step], [5, 'i1-propose']);
  assert.match(r.detail, /owner-answers\.json/u);
  assert.equal(callLog(x.maintainer).length, 0);
  assert.ok(!existsSync(join(x.root, 'benchmark/log.jsonl')));
});

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

/** C00 pinned v1 (as c4-judge writes it) and an empty ledger: the R00 packet comes from labels + status only. */
function c00(root: string): void {
  const v1 = readFileSync(join(root, 'benchmark/v1.json'), 'utf8');
  const hex = 'e'.repeat(64);
  put(root, 'calibration/C00/pin.json', `${JSON.stringify({ set: 'C00', benchmark_version: 'v1', benchmark_sha256: sha256(v1), protocol_bundle_sha256: hex, pairs_sha256: hex, answers_sha256: hex, judges: {} }, null, 2)}\n`);
  put(root, 'calibration/labels.json', `${JSON.stringify({ schema: 'calib-labels/1', labels: [] }, null, 2)}\n`);
}

test('bench-r00: 11f–11j on rounds/R00 (cycle R00): packet from C00, decoy change → v2 pending_owner with parent v1, replay skipped', async () => {
  const x = pipelineWorld(DEFAULT_FIXTURE, 'bench-r00', BENCH_R00_STEPS, decoyRoute, c00);
  const r = await x.run();
  assert.equal(r.exitCode, 0, r.detail);
  assert.ok(existsSync(join(x.root, 'benchmark/evidence/R00.json')));
  const proposal = readProposal(roundPaths(x.root, 'R00'));
  assert.ok(proposal !== null && proposal.ok);
  assert.deepEqual([proposal.value.cycle, proposal.value.version, proposal.value.parent, proposal.value.evidence_packet], ['R00', 'v2', 'v1', 'benchmark/evidence/R00.json']);
  const marker = record(readFileSync(join(x.root, 'rounds/R00/markers/11i-bench-replay.json'), 'utf8'));
  assert.deepEqual([marker['result'], marker['skipped']], ['skip', 'no replay-class key']);
  const f = record(readFileSync(join(x.root, 'rounds/R00/markers/11f-bench-evidence.json'), 'utf8'));
  assert.ok(isRecord(f['outputs']) && Object.hasOwn(f['outputs'], 'benchmark/evidence/R00.json'));
  assert.ok(isRecord(f['inputs']) && !Object.hasOwn(f['inputs'], 'owner-log.jsonl') && !Object.hasOwn(f['inputs'], 'benchmark/log.jsonl'), 'append-only logs are never listed');
  const log = readBenchLog(x.root);
  assert.ok(log.ok);
  assert.deepEqual(log.value.map((e) => [e.cycle, e.outcome, e.version, e.parent]), [['R00-init', 'activate', 'v1', null], ['R00', 'pending_owner', 'v2', 'v1']]);
  const head = activeBenchmark(x.ctx, 'effective');
  assert.ok(head.ok && head.value.version === 'v1');
  const packet = readFileSync(join(x.root, 'benchmark/evidence/R00.json'), 'utf8');
  assert.equal((await x.run()).exitCode, 0);
  assert.equal(readFileSync(join(x.root, 'benchmark/evidence/R00.json'), 'utf8'), packet);
  assert.equal(callLog(x.maintainer).length, 1);
});

test('11f: the packet is written once — same bytes on a rebuild, different existing bytes → IntegrityError', async () => {
  const x = pipelineWorld(DEFAULT_FIXTURE, 'bench-r00', BENCH_R00_STEPS, decoyRoute, c00);
  const first = await evidenceStep.run(x.ctx, null);
  assert.ok(first.kind === 'done');
  assert.deepEqual(first.outputs, ['benchmark/evidence/R00.json']);
  assert.ok(first.inputs.includes('calibration/labels.json') && first.inputs.includes('calibration/C00/pin.json'), first.inputs.join(', '));
  const path = join(x.root, 'benchmark/evidence/R00.json');
  const bytes = readFileSync(path, 'utf8');
  assert.deepEqual(await evidenceStep.run(x.ctx, null), first);
  assert.equal(readFileSync(path, 'utf8'), bytes);
  writeFileSync(path, bytes.replace('"R00"', '"R00" '));
  await assert.rejects(evidenceStep.run(x.ctx, null), (e: unknown) => e instanceof IntegrityError && e.message.includes('benchmark/evidence/R00.json'));
});

test('11f rerun after the logs moved on (own 11j line, owner view / approval): the packet is kept; a real edit is still integrity', async () => {
  const x = pipelineWorld(DEFAULT_FIXTURE, 'bench-r00', BENCH_R00_STEPS, decoyRoute, c00);
  assert.equal((await x.run()).exitCode, 0);
  const path = join(x.root, 'benchmark/evidence/R00.json');
  const bytes = readFileSync(path, 'utf8');
  const first = await evidenceStep.run(x.ctx, null);
  assert.ok(first.kind === 'done' && first.outputs[0] === 'benchmark/evidence/R00.json', 'a rebuild now lists v2 as pending: kept');
  x.sim.viewBenchDiff('v2');
  x.sim.approveBench('v2');
  assert.deepEqual(await evidenceStep.run(x.ctx, null), first, 'head v2 now: still the packet 11f wrote');
  assert.equal(readFileSync(path, 'utf8'), bytes, 'the packet is never rewritten');
  writeFileSync(path, bytes.replace('"reserve"', '"reserve" '));
  await assert.rejects(evidenceStep.run(x.ctx, null), (e: unknown) => e instanceof IntegrityError && e.message.includes('benchmark/evidence/R00.json'));
});

test('11f (round): WAIT audit while the owner has not answered the audit (never a cycle on partial labels)', async () => {
  const w = pipelineWorld(DEFAULT_FIXTURE, 'bench-r00', BENCH_R00_STEPS, decoyRoute, c00);
  const ctx: StepContext = { ...w.ctx, roundId: 'R01', pipeline: 'round', paths: roundPaths(w.root, 'R01') };
  const out = await evidenceStep.run(ctx, null);
  assert.ok(out.kind === 'wait' && out.waitingFor === 'audit', JSON.stringify(out));
  assert.ok(!existsSync(join(w.root, 'benchmark/evidence/R01.json')));
});
