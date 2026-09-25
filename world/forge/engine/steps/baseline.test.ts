import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readChampions } from '../champions.ts';
import { loadConfig } from '../config.ts';
import { buildContext, type RoundBackends, type StepContext } from '../context.ts';
import { readJson, roundPaths, sha256 } from '../store.ts';
import { CHAMPION_ID, displayText, loadSubmission } from '../submission.ts';
import { runSteps } from '../runner.ts';
import { IntegrityError } from '../task.ts';
import { fakePorts } from '../testing/fakes.ts';
import { DEFAULT_FIXTURE, fixtureWorld, type FixtureWorld } from '../testing/fixture-world.ts';
import { callLog, fakeRouter, type FakeRouter, type Route } from '../testing/scripted.ts';
import { baselineStep, baselineTaskId, readAttempts } from './baseline.ts';
import { DEFAULT_STANCES, type BriefJson } from './brief.ts';

const PASSAGE = '温芮把借来的扳手挂回工具墙。循环泵换了节拍。林澈说冷凝管今晚要换滤网。';
const GOOD = ['```submission', '循环泵换了节拍。同一天，温芮把借来的扳手挂回工具墙。', '```', '```delta', '{"new_proper_nouns":[],"claims":[]}', '```', '```interface', '{"shots":[{},{},{}],"object":{"n":1},"hook":{"h":1}}', '```', '种子：', '- 一'].join('\n');

function brief(rowId: string, passage = PASSAGE): BriefJson {
  return {
    round: 'R01', kind: 'round', row_id: rowId, layer: '物件', topic_source: 'fixed',
    cell: { id: 'C', row_id: rowId, title: '冷湾 · 码头常态日', entity: '冷湾', time: 't', layers: ['物件'], setting_notes: [], protagonists: ['温芮'], forbidden: [], stances: [...DEFAULT_STANCES] },
    canon: { revision: '8.1', book_sha256: 'b'.repeat(64), reference_sha256: 'c'.repeat(64) },
    canon_passages: [{ file: 'reference/04-war-and-diplomacy.md', text: passage }],
    facts: [], regression: [], regression_stale: [], forbidden: [], cliches: [], requirements: [], interface_requirements: [], aliases: [],
    seed: 'seed-b', created_at: '2026-10-01T00:00:00.000Z',
  };
}

interface H {
  dir: string;
  w: FixtureWorld;
  ctx: StepContext;
  baseline: FakeRouter;
}

function harness(route: Route, champions: 'none' | 'ship_owner_pick', rowId: string, passage = PASSAGE): H {
  const dir = mkdtempSync(join(tmpdir(), 'forge-baseline-'));
  const w = fixtureWorld(dir, { ...DEFAULT_FIXTURE, champions });
  const config = loadConfig(w.root, { requireLocal: true });
  if (!config.ok) throw new Error(config.error);
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: '2026-10-01T00:00:00.000Z', seed: 'baseline-seed' });
  const baseline = fakeRouter({ baseline: route }, { id: 'BASE', family: 'DeepSeek', model: 'deepseek-fixture' });
  const backends: RoundBackends = {
    writers: [], baseline, decoy: baseline, defect: baseline, judges: [], forecasters: [], maintainer: baseline, mergeEditor: baseline, calibGateway: new Map(),
  };
  const built = buildContext({
    root: w.root, repo: w.repo, roundId: 'R01', pipeline: 'round', paths: roundPaths(w.root, 'R01'), config: config.value,
    deps: { ports, backends: () => backends, env: {}, pid: 7, isAlive: () => false, log: () => undefined },
    startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
  });
  if (!built.ok) throw new Error(built.error);
  mkdirSync(built.value.paths.dir, { recursive: true });
  writeFileSync(built.value.paths.brief, `${JSON.stringify(brief(rowId, passage), null, 2)}\n`);
  return { dir, w, ctx: built.value, baseline };
}

function run(h: H): ReturnType<typeof runSteps> {
  return runSteps(h.ctx, { pipeline: 'round', steps: [baselineStep], until: null, from: null, redoFrom: null, pid: 7, isAlive: () => false });
}

test('02b skips a row whose champion another round set, without a call', async () => {
  const h = harness(() => GOOD, 'ship_owner_pick', 'SHIP');
  const out = await baselineStep.run(h.ctx, null);
  assert.equal(out.kind, 'skip');
  if (out.kind === 'skip') assert.match(out.reason, /row SHIP already has a owner_pick champion/u);
  assert.deepEqual(callLog(h.baseline), []);
  assert.equal(existsSync(join(h.ctx.paths.submissions, `${CHAMPION_ID}.json`)), false);
  rmSync(h.dir, { recursive: true });
});

test('02b writes BASE.json, then the baseline champion with authors = the baseline family only', async () => {
  const h = harness(() => GOOD, 'none', 'S1-冷湾');
  const out = await baselineStep.run(h.ctx, null);
  assert.deepEqual(out, { kind: 'done', inputs: ['rounds/R01/brief.json'], outputs: ['rounds/R01/submissions/BASE.json'], external: ['champions.json'] });
  assert.deepEqual(callLog(h.baseline), ['baseline-BASE#1']);
  const sub = loadSubmission(h.ctx.paths, CHAMPION_ID);
  assert.equal(sub?.kind, 'baseline');
  const text = sub?.output === null || sub === null ? '' : displayText(sub.output);
  const champ = readChampions(h.w.root);
  assert.ok(champ.ok);
  if (!champ.ok) return;
  const row = champ.value['S1-冷湾'];
  assert.deepEqual(
    row === undefined ? null : { kind: row.kind, round: row.round, submission: row.submission, family: row.family, authors: row.authors, text: row.text, sha: row.text_sha256 },
    { kind: 'baseline', round: 'R01', submission: 'BASE', family: 'DeepSeek', authors: ['DeepSeek'], text, sha: sha256(text) },
  );
  rmSync(h.dir, { recursive: true });
});

test('02b: a void baseline fails the run (exit 5), keeps its record and the rerun calls afresh as -t2', async () => {
  const h = harness((_p, _n, meta) => (meta.taskId === 'baseline-BASE' ? '循环泵换了节拍，但没有代码块。' : GOOD), 'none', 'S1-冷湾');
  const first = await run(h);
  assert.equal(first.exitCode, 5);
  assert.match(first.detail, /^baseline_missing: baseline-BASE is void .*a rerun calls afresh as baseline-BASE-t2$/u);
  assert.deepEqual(readAttempts(h.ctx).map((a) => a.task), ['baseline-BASE']);
  const champ = readChampions(h.w.root);
  assert.deepEqual(champ.ok ? Object.keys(champ.value) : null, [], 'no champion is invented');
  const second = await run(h);
  assert.equal(second.exitCode, 0);
  assert.deepEqual(callLog(h.baseline), ['baseline-BASE#1', 'baseline-BASE#2', 'baseline-BASE-t2#1']);
  assert.equal(readJson(join(h.ctx.paths.tasks, 'baseline-BASE.json')) !== null, true, 'the void record stays as evidence');
  assert.equal(baselineTaskId(3), 'baseline-BASE-t3');
  rmSync(h.dir, { recursive: true });
});

test('02b after a crash following champions.json: the rerun marks done without a call; a mismatching BASE.json is integrity', async () => {
  const h = harness(() => GOOD, 'none', 'S1-冷湾');
  await baselineStep.run(h.ctx, null);
  const again = await baselineStep.run(h.ctx, null);
  assert.equal(again.kind, 'done');
  if (again.kind === 'done') assert.deepEqual(again.outputs, ['rounds/R01/submissions/BASE.json']);
  assert.equal(callLog(h.baseline).length, 1);
  const path = join(h.ctx.paths.submissions, `${CHAMPION_ID}.json`);
  writeFileSync(path, readFileSync(path, 'utf8').replace('循环泵换了节拍。', '循环泵停了。'));
  await assert.rejects(baselineStep.run(h.ctx, null), IntegrityError);
  rmSync(h.dir, { recursive: true });
});

test('02b fails without a call when the brief has no canon sentence', async () => {
  const h = harness(() => GOOD, 'none', 'S1-冷湾', '——');
  const out = await baselineStep.run(h.ctx, null);
  assert.equal(out.kind, 'failed');
  assert.deepEqual(callLog(h.baseline), []);
  rmSync(h.dir, { recursive: true });
});
