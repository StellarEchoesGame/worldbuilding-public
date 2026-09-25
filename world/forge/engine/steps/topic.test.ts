import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeBackend } from '../adapters/fake.ts';
import type { Backend } from '../adapters/types.ts';
import { loadConfig } from '../config.ts';
import { buildContext, type RoundBackends, type StartOptions, type StepContext } from '../context.ts';
import { readArray, readNumber, readString } from '../json.ts';
import type { OwnerInputs } from '../owner-inputs.ts';
import { runSteps, type RunReport, type StepDef } from '../runner.ts';
import { roundPaths } from '../store.ts';
import { fakePorts, type FakePorts } from '../testing/fakes.ts';
import { DEFAULT_FIXTURE, fixtureWorld, type FixtureOptions, type FixtureWorld } from '../testing/fixture-world.ts';
import { ownerSim, type OwnerSim } from '../testing/owner-sim.ts';
import { startStep } from './start.ts';
import { aliasMentions, TOPIC_AUTO_DELAY_MS, topicStep } from './topic.ts';

interface Harness {
  w: FixtureWorld;
  ports: FakePorts;
  ctx: StepContext;
  sim: OwnerSim;
}

function harness(startOptions: StartOptions = { cell: null, seed: null }, opts: FixtureOptions = DEFAULT_FIXTURE, roundId = 'R01'): Harness {
  const w = fixtureWorld(mkdtempSync(join(tmpdir(), 'forge-topic-')), opts);
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

function run(ctx: StepContext, steps: readonly StepDef[] = [startStep, topicStep]): Promise<RunReport> {
  return runSteps(ctx, { pipeline: 'round', steps, until: null, from: null, redoFrom: null, pid: 4242, isAlive: (pid) => pid === 4242 });
}

const HOUR = 3_600_000;

function keysOf(value: unknown): string[] {
  return typeof value === 'object' && value !== null ? Object.keys(value) : [];
}

function readJsonFile(path: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${path}: not an object`);
  return { ...raw };
}

function offer(ctx: StepContext): { offered_at: string; top3: Array<{ row_id: string; layer: string; priority: number }> } {
  const raw = readJsonFile(join(ctx.paths.dir, 'topic-offer.json'));
  const top3: Array<{ row_id: string; layer: string; priority: number }> = [];
  for (const t of readArray(raw, 'top3') ?? []) {
    const rowId = readString(t, 'row_id');
    const layer = readString(t, 'layer');
    const priority = readNumber(t, 'priority');
    if (rowId !== null && layer !== null && priority !== null) top3.push({ row_id: rowId, layer, priority });
  }
  return { offered_at: String(raw['offered_at']), top3 };
}

function marker01(ctx: StepContext): Record<string, unknown> {
  return readJsonFile(join(ctx.paths.markers, '01-topic.json'));
}

test('01-topic waits (exit 2) under 24 h, reuses the offer on re-entry, and takes the first candidate after 24 h', async () => {
  const h = harness();
  const first = await run(h.ctx);
  assert.equal(first.exitCode, 2);
  assert.equal(first.waitingFor, 'topic');
  const o = offer(h.ctx);
  assert.equal(o.offered_at, '2026-10-01T00:00:00.000Z');
  assert.equal(o.top3.length, 3);
  assert.equal(existsSync(h.ctx.paths.topic), false);
  h.ports.clock.advance(23 * HOUR);
  const second = await run(h.ctx);
  assert.equal(second.exitCode, 2);
  assert.deepEqual(offer(h.ctx), o, 'the 24 h clock never restarts');
  h.ports.clock.advance(TOPIC_AUTO_DELAY_MS - 23 * HOUR);
  const third = await run(h.ctx);
  assert.equal(third.exitCode, 0, third.detail);
  const topic = readJsonFile(h.ctx.paths.topic);
  assert.deepEqual(topic, { round: 'R01', row_id: o.top3[0]?.row_id, layer: o.top3[0]?.layer, cell: null, source: 'auto_default', chosen_at: '2026-10-02T00:00:00.000Z' });
  const m = marker01(h.ctx);
  assert.equal(m['result'], 'done');
  assert.deepEqual(keysOf(m['outputs']).sort(), ['rounds/R01/topic-offer.json', 'rounds/R01/topic.json']);
  assert.equal(h.ctx.owner.topic('R01').state, 'ok');
});

test('01-topic: an owner pick through the UI wins, even after 24 h, and is pinned as an input', async () => {
  const h = harness();
  assert.equal((await run(h.ctx)).exitCode, 2);
  const pick = offer(h.ctx).top3[1];
  assert.ok(pick !== undefined);
  h.ports.clock.advance(30 * HOUR);
  h.sim.pickTopic('R01', { row_id: pick.row_id, layer: pick.layer });
  const report = await run(h.ctx);
  assert.equal(report.exitCode, 0, report.detail);
  const topic = readJsonFile(h.ctx.paths.topic);
  assert.equal(topic['source'], 'ui');
  assert.equal(topic['layer'], pick.layer);
  assert.ok(keysOf(marker01(h.ctx)['inputs']).includes('rounds/R01/topic.json'));
});

test('01-topic: a UI topic.json created between the check and the engine write wins the wx race', async () => {
  const h = harness();
  assert.equal((await run(h.ctx)).exitCode, 2);
  const pick = offer(h.ctx).top3[2];
  assert.ok(pick !== undefined);
  h.ports.clock.advance(25 * HOUR);
  const real = h.ctx.owner;
  let raced = false;
  const racing: OwnerInputs = {
    ...real,
    topic: (round) => {
      if (raced) return h.ctx.owner.topic(round);
      raced = true;
      h.sim.pickTopic(round, { row_id: pick.row_id, layer: pick.layer });
      return { state: 'missing' };
    },
  };
  const outcome = await topicStep.run({ ...h.ctx, owner: racing }, null);
  assert.equal(outcome.kind, 'done');
  const topic = readJsonFile(h.ctx.paths.topic);
  assert.equal(topic['source'], 'ui');
  assert.equal(topic['layer'], pick.layer);
});

test('01-topic: a UI topic.json that won the wx race before its owner-log line waits for owner_log_repair', async () => {
  const h = harness();
  assert.equal((await run(h.ctx)).exitCode, 2);
  const pick = offer(h.ctx).top3[1];
  assert.ok(pick !== undefined);
  h.ports.clock.advance(25 * HOUR);
  let raced = false;
  const racing: OwnerInputs = {
    ...h.ctx.owner,
    topic: (round) => {
      if (raced) return h.ctx.owner.topic(round);
      raced = true;
      // The UI's exclusive create landed; its owner-log append has not happened yet.
      const ui = { round, row_id: pick.row_id, layer: pick.layer, cell: null, source: 'ui', chosen_at: h.ports.clock.now() };
      writeFileSync(h.ctx.paths.topic, `${JSON.stringify(ui, null, 2)}\n`);
      return { state: 'missing' };
    },
  };
  const outcome = await topicStep.run({ ...h.ctx, owner: racing }, null);
  assert.equal(outcome.kind, 'wait');
  assert.equal(outcome.kind === 'wait' ? outcome.waitingFor : null, 'owner_log_repair');
  assert.equal(readJsonFile(h.ctx.paths.topic)['source'], 'ui', 'the engine never overwrites the UI topic');
});

test('01-topic: round start --cell writes a fixed topic from the cell (no offer)', async () => {
  const h = harness({ cell: 'cells/E2E-R01.json', seed: null });
  const report = await run(h.ctx);
  assert.equal(report.exitCode, 0, report.detail);
  assert.deepEqual(readJsonFile(h.ctx.paths.topic), { round: 'R01', row_id: 'SHIP', layer: 'object', cell: 'cells/E2E-R01.json', source: 'fixed', chosen_at: '2026-10-01T00:00:00.000Z' });
  assert.equal(existsSync(join(h.ctx.paths.dir, 'topic-offer.json')), false);
  assert.deepEqual(keysOf(marker01(h.ctx)['inputs']), ['cells/E2E-R01.json']);
});

test('aliasMentions counts quotes of the previous round naming a row, and the offer ranks by them', async () => {
  const h = harness();
  const taste = join(h.w.root, 'rounds', 'R00', 'taste');
  mkdirSync(join(taste, 'W1'), { recursive: true });
  mkdirSync(join(taste, 'W2'), { recursive: true });
  writeFileSync(join(taste, 'W1', 'grok-s1-fwd.json'), JSON.stringify({ verdict: { picks: { q1: 1 }, quotes: { q1: '冷湾的风把码头的缆绳吹得发响。', q2: '母舰的灯带在夜里变暗。' } } }));
  writeFileSync(join(taste, 'W2', 'Moonshot-s0-rev.json'), JSON.stringify({ answers: { q1: { pick: 2, quote: '她在冷湾等潮水退下去。' }, q2: { pick: 1, quote: '没有提到任何地名。' } }, decoy: { pick: 3, quote: '冷湾的旧码头上堆着渔网。' } }));
  writeFileSync(join(taste, 'W2', 'torn.json'), '{"answers":');
  assert.deepEqual(aliasMentions(h.w.root, 'R00'), { 'S1-冷湾': 3, SHIP: 1 });
  assert.deepEqual(aliasMentions(h.w.root, 'R07'), {});
  assert.deepEqual(aliasMentions(h.w.root, 'bogus'), {});
  assert.equal((await run(h.ctx)).exitCode, 2);
  const top = offer(h.ctx).top3;
  assert.deepEqual(top.map((t) => t.row_id), ['S1-冷湾', 'S1-冷湾', 'S1-冷湾']);
  assert.ok((top[0]?.priority ?? 0) > 0);
});
