import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeBackend } from '../adapters/fake.ts';
import type { Backend } from '../adapters/types.ts';
import { loadConfig } from '../config.ts';
import { buildContext, type RoundBackends, type StartOptions, type StepContext } from '../context.ts';
import { canonFiles } from '../inputs.ts';
import { readArray, readRecord, readString } from '../json.ts';
import type { Topic } from '../owner-inputs.ts';
import { parseCell, type Cell } from '../brief.ts';
import { runSteps, type RunReport, type StepDef } from '../runner.ts';
import { roundPaths, sha256 } from '../store.ts';
import { fakePorts, type FakePorts } from '../testing/fakes.ts';
import { DEFAULT_FIXTURE, fixtureWorld, type FixtureOptions, type FixtureWorld } from '../testing/fixture-world.ts';
import { ownerSim, type OwnerSim } from '../testing/owner-sim.ts';
import {
  briefInputProblems,
  briefStep,
  buildBrief,
  DEFAULT_STANCES,
  INTERFACE_REQUIREMENTS,
  loadRowAliases,
  parseBrief,
  parseFactStatus,
  parseRegressionFile,
  topicCell,
  type BriefInput,
} from './brief.ts';
import { startStep } from './start.ts';
import { topicStep } from './topic.ts';

interface Harness {
  w: FixtureWorld;
  ports: FakePorts;
  ctx: StepContext;
  sim: OwnerSim;
}

function harness(startOptions: StartOptions = { cell: 'cells/E2E-R01.json', seed: null }, opts: FixtureOptions = DEFAULT_FIXTURE, roundId = 'R01'): Harness {
  const w = fixtureWorld(mkdtempSync(join(tmpdir(), 'forge-brief-')), opts);
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

function run(ctx: StepContext, steps: readonly StepDef[] = [startStep, topicStep, briefStep]): Promise<RunReport> {
  return runSteps(ctx, { pipeline: 'round', steps, until: null, from: null, redoFrom: null, pid: 4242, isAlive: (pid) => pid === 4242 });
}


function jsonAt(path: string): unknown {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return raw;
}

function must<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const SECTION_8 = [
  '## 8. 已登记现场事实',
  '',
  '| R-ID | 行 | 事实 | 地位 | 挂靠 | 延伸自 | 误用 | 来源 |',
  '|---|---|---|---|---|---|---|---|',
  '| R01-01 | SHIP | 第三邻里的工具墙按编号借还 | 已选地方事实 | 05 | F01 | 写成配给 | 09 §R01 |',
  '| R01-02 | S1-冷湾 | 冷湾的渔网由母舰换下的滤网改成 | 状态与路径实例 | 04 | F02 | 写成通例 | 09 §R01 |',
  '| R01-03 | S1-赤脊 | 赤脊的台地上只在清晨刮风 | 共同事实 | 04 | F03 | 写成全球 | 09 §R01 |',
  '',
].join('\n');

function fixtureInput(w: FixtureWorld, over: Partial<BriefInput> = {}): BriefInput {
  const canon = canonFiles(w.repo);
  canon['reference/REFERENCE.md'] = readFileSync(join(w.repo, 'world', 'current', 'reference', 'REFERENCE.md'), 'utf8');
  const topic: Topic = { round: 'R01', row_id: 'SHIP', layer: 'object', cell: 'cells/E2E-R01.json', source: 'fixed', chosen_at: '2026-10-01T00:00:00.000Z' };
  const cell: Cell = must(parseCell(jsonAt(join(w.root, 'cells', 'E2E-R01.json'))));
  return {
    round: 'R01',
    seed: '0011223344556677',
    topic,
    cell,
    canon,
    revision: '8.1',
    factStatus: must(parseFactStatus(jsonAt(join(w.root, 'fact-status.json')))),
    aliases: must(loadRowAliases(w.root)),
    regression: must(parseRegressionFile(jsonAt(join(w.root, 'regression', 'wb-b1.json')))),
    cliches: ['时光在指缝间流走'],
    createdAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

function world(opts: FixtureOptions = DEFAULT_FIXTURE): FixtureWorld {
  return fixtureWorld(mkdtempSync(join(tmpdir(), 'forge-brief-pure-')), opts);
}

test('buildBrief joins every 07 §2 F-ID with its fact-status entry and keeps the Rxx touching the row', () => {
  const w = world();
  const input = fixtureInput(w);
  const factStatus = input.factStatus;
  const ref07 = `${input.canon['reference/07-register-and-creation.md'] ?? ''}\n${SECTION_8}`;
  const brief = buildBrief({ ...input, canon: { ...input.canon, 'reference/07-register-and-creation.md': ref07 } });
  const fIds = brief.facts.filter((f) => f.kind === 'fact');
  assert.deepEqual(fIds.map((f) => f.id), factStatus.map((f) => f.id));
  for (const f of fIds) {
    const entry = factStatus.find((e) => e.id === f.id);
    assert.equal(f.status, entry?.status);
    assert.deepEqual(f.rows, entry?.rows);
    assert.ok(f.text.length > 0);
  }
  assert.deepEqual(
    brief.facts.filter((f) => f.kind === 'registered').map((f) => [f.id, f.status, f.rows.join(',')]),
    [
      ['R01-01', '已选地方事实', 'SHIP'],
      ['R01-02', '状态与路径实例', 'S1-冷湾'],
    ],
  );
  assert.deepEqual(brief.aliases, ['远航号', '母舰', '家园舰', '归航号']);
});

test('buildBrief: cliché list minus canon hits, regression quotes re-verified, canon hashes, requirements', () => {
  const w = world();
  const input = fixtureInput(w);
  const live = input.regression[0];
  assert.ok(live !== undefined);
  const brief = buildBrief({
    ...input,
    cliches: ['时光在指缝间流走', '循环泵的节拍', '  ', '时光在指缝间流走'],
    regression: [...input.regression, { id: 'G-099', case: 'P03', source: 'judge-a', quote: '这一句早已从正典里删去了。' }],
  });
  assert.deepEqual(brief.cliches, ['时光在指缝间流走']);
  assert.deepEqual(brief.regression.map((q) => q.id), input.regression.map((q) => q.id));
  assert.deepEqual(brief.regression_stale, ['G-099']);
  assert.equal(brief.canon.book_sha256, sha256(input.canon['BOOK.md'] ?? '?'));
  assert.equal(brief.canon.reference_sha256, sha256(input.canon['reference/REFERENCE.md'] ?? '?'));
  assert.equal(brief.canon.revision, '8.1');
  assert.deepEqual(brief.interface_requirements, [...INTERFACE_REQUIREMENTS]);
  assert.equal(brief.requirements.length, 4);
  assert.ok(brief.requirements.some((r) => r.includes('温芮 / 林澈') && r.includes('代价')));
  assert.deepEqual(brief.forbidden, input.cell.forbidden);
  assert.equal(brief.cell.row_id, 'SHIP');
  assert.equal(brief.topic_source, 'fixed');
  assert.equal(brief.kind, 'round');
});

test('canon passages are verbatim prose of BOOK / reference 01–06, 08 naming the row or a protagonist', () => {
  const w = world();
  const input = fixtureInput(w);
  const brief = buildBrief(input);
  assert.ok(brief.canon_passages.length > 0);
  const names = [...brief.aliases, ...input.cell.protagonists];
  for (const p of brief.canon_passages) {
    assert.ok((input.canon[p.file] ?? '').includes(p.text), `${p.file} passage is verbatim`);
    assert.ok(names.some((n) => p.text.includes(n)));
    assert.ok(!p.file.startsWith('reference/07-') && p.file !== 'reference/REFERENCE.md');
    assert.ok(!p.text.split('\n').some((l) => l.startsWith('#') || l.startsWith('|')));
  }
  assert.ok(brief.canon_passages.some((p) => p.text.includes('温芮在远航号的第三邻里长大')));
});

test('briefInputProblems: a fact without status, a cell for another row; buildBrief refuses them', () => {
  const w = world();
  const input = fixtureInput(w);
  const bad = { ...input, factStatus: input.factStatus.filter((f) => f.id !== 'F03'), topic: { ...input.topic, row_id: 'S1-冷湾' } };
  const problems = briefInputProblems(bad);
  assert.ok(problems.some((p) => p.includes('F03')));
  assert.ok(problems.some((p) => p.includes('row SHIP')));
  assert.throws(() => buildBrief(bad), /buildBrief: /u);
  assert.deepEqual(briefInputProblems(input), []);
});

test('parseBrief round-trips a built brief and refuses prototype briefs and bad statuses', () => {
  const w = world();
  const brief = buildBrief(fixtureInput(w));
  const copy: unknown = JSON.parse(JSON.stringify(brief));
  assert.deepEqual(must(parseBrief(copy)), brief);
  assert.equal(parseBrief({ ...brief, kind: 'prototype' }).ok, false);
  assert.equal(parseBrief({ ...brief, facts: [{ ...brief.facts[0], status: '共同创作尺度' }] }).ok, false);
  assert.equal(parseBrief({ ...brief, cliches: 'x' }).ok, false);
  assert.equal(parseBrief({ ...brief, cell: { id: 'x' } }).ok, false);
});

test('topicCell: a UI topic gets the row as entity, the layer, the four default stances and derived protagonists', () => {
  const w = world();
  const input = fixtureInput(w);
  const topic: Topic = { round: 'R04', row_id: 'SHIP', layer: 'quest_hook', cell: null, source: 'ui', chosen_at: '2026-10-01T00:00:00.000Z' };
  const cell = topicCell(topic, input.aliases, input.canon);
  assert.equal(cell.rowId, 'SHIP');
  assert.equal(cell.entity, '远航号');
  assert.equal(cell.title, '远航号 · 任务钩子');
  assert.deepEqual(cell.layers, ['任务钩子']);
  assert.deepEqual(cell.stances.map((s) => s.id), DEFAULT_STANCES.map((s) => s.id));
  assert.deepEqual(cell.protagonists, ['温芮', '林澈']);
  const far = topicCell({ ...topic, row_id: 'S1-赤脊' }, input.aliases, input.canon);
  assert.deepEqual(far.protagonists, []);
  assert.ok(buildBrief({ ...input, round: 'R04', topic, cell }).requirements.some((r) => r.includes('温芮')));
});

test('02a-brief (fixed cell): brief.json from the canon, the topic and the effective benchmark; inputs pinned in the marker', async () => {
  const h = harness();
  const report = await run(h.ctx);
  assert.equal(report.exitCode, 0, report.detail);
  const brief = must(parseBrief(jsonAt(h.ctx.paths.brief)));
  assert.equal(brief.row_id, 'SHIP');
  assert.equal(brief.layer, 'object');
  assert.equal(brief.cell.id, 'E2E-R01');
  assert.deepEqual(brief.cliches, ['时光在指缝间流走']);
  assert.equal(brief.seed, h.ctx.start().seed);
  assert.equal(brief.created_at, '2026-10-01T00:00:00.000Z');
  const inputs = Object.keys(readRecord(jsonAt(join(h.ctx.paths.markers, '02a-brief.json')), 'inputs') ?? {});
  assert.deepEqual(inputs.sort(), ['benchmark/v1.json', 'cells/E2E-R01.json', 'fact-status.json', 'map/aliases.json', 'map/rows.json', 'regression/wb-b1.json', 'rounds/R01/topic.json'].sort());
});

test('02a-brief waits for a benchmark when none is effective, and fails without the regression file', async () => {
  const pending = harness(undefined, { ...DEFAULT_FIXTURE, benchmark: 'pending' });
  const r1 = await run(pending.ctx);
  assert.equal(r1.exitCode, 2);
  assert.equal(r1.step, '02a-brief');
  assert.equal(r1.waitingFor, 'benchmark_approval');
  pending.sim.approveBench('v1');
  assert.equal((await run(pending.ctx)).exitCode, 0);
  const noRegression = harness();
  assert.equal((await run(noRegression.ctx, [startStep, topicStep])).exitCode, 0);
  rmSync(join(noRegression.w.root, 'regression', 'wb-b1.json'));
  const r2 = await run(noRegression.ctx);
  assert.equal(r2.exitCode, 5);
  assert.match(r2.detail, /regression\/wb-b1\.json missing/u);
});

test('02a-brief (UI topic): the brief uses a topic cell of the chosen row and layer', async () => {
  const h = harness({ cell: null, seed: null });
  assert.equal((await run(h.ctx)).exitCode, 2);
  const first = readArray(jsonAt(join(h.ctx.paths.dir, 'topic-offer.json')), 'top3')?.[0];
  const rowId = readString(first, 'row_id') ?? '?';
  const layer = readString(first, 'layer') ?? '?';
  h.sim.pickTopic('R01', { row_id: rowId, layer });
  const report = await run(h.ctx);
  assert.equal(report.exitCode, 0, report.detail);
  const brief = must(parseBrief(jsonAt(h.ctx.paths.brief)));
  assert.equal(brief.topic_source, 'ui');
  assert.equal(brief.row_id, rowId);
  assert.equal(brief.cell.id, `R01-${rowId}-${layer}`);
  assert.deepEqual(brief.cell.stances.map((s) => s.id), DEFAULT_STANCES.map((s) => s.id));
});
