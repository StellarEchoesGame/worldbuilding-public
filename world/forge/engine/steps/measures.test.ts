import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Family } from '../config.ts';
import { buildContext, type RoundBackends, type StepContext } from '../context.ts';
import { buildFreeze, type FreezeFlag } from '../freeze.ts';
import { isRecord } from '../json.ts';
import { sha256Bytes, writeMarker } from '../marker.ts';
import type { StepId } from '../runner.ts';
import { loadSchema, validate } from '../schema.ts';
import { roundPaths, sha256 } from '../store.ts';
import { pickFamilies } from '../tasks/assign.ts';
import { unwrap } from '../tasks/fenced.ts';
import { fakePorts } from '../testing/fakes.ts';
import { DEFAULT_FIXTURE, FIXTURE_AT, FIXTURE_WRITER_MODEL, fixtureWorld, type FixtureWorld } from '../testing/fixture-world.ts';
import { callLog, fakeRouter, type FakeRouter, type Route } from '../testing/scripted.ts';
import type { BriefJson } from './brief.ts';
import { measureSubmissions, measurePath, measuresStep, readRecallFile, type MeasureDir } from './measures.ts';

const ROUND = 'R01';
const SEED = 'measures-seed';
const START_ISO = '2026-10-01T00:00:00.000Z';
const MEASURE_TEXT = '温芮把借来的扳手挂回第三邻里的工具墙。循环泵换了节拍，走廊里的灯带转成琥珀色。林澈从走廊另一头过来，说冷凝管今晚要换滤网。两个人一起把菌毯卷好，送回培养架。';
const CANON_TEXT = '在远航号的第三邻里，维修工在配给簿上记下每一次借用和归还。';

function fenced(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

function goodInterface(verbs: readonly string[] = ['借', '还']): Record<string, unknown> {
  const shot = { 地点: 'SHIP 第三邻里工具墙', 时间与光源: '夜班', 景别与视点高度: '中景', 主体人物与动作: '温芮挂扳手', 尺度参照物: '扳手', 材质色彩: ['铝', '琥珀', '灰'], 禁画项: ['星门'] };
  return {
    shots: [shot, shot, shot],
    object: { 名称: '扳手', 位置: '工具墙', 玩家动词: [...verbs], 状态: ['在墙上', '借出'], 使用权限: '值班员', 拒绝或失败后: '记欠账' },
    hook: { 玩家不来时会发生什么: '滤网报警', 需要谁同意: '林澈', 选项: ['帮忙', '拒绝'], 消耗与义务: '工时', 回到母舰后留下什么: '欠条', 玩法类型: '经营' },
  };
}

function writerText(body: string, iface: Record<string, unknown>, nouns: readonly string[] = []): string {
  return ['```submission', body, '```', '```delta', JSON.stringify({ new_proper_nouns: nouns, claims: [] }), '```', '```interface', JSON.stringify(iface), '```', '种子：', '- 一'].join('\n');
}

function stepBrief(): BriefJson {
  return {
    round: ROUND, kind: 'round', row_id: 'SHIP', layer: '物件', topic_source: 'fixed',
    cell: { id: 'C', row_id: 'SHIP', title: '母舰 · 邻里常态日', entity: '远航号第三邻里', time: '息壤停留期', layers: ['物件'], setting_notes: [], protagonists: ['温芮'], forbidden: [], stances: [{ id: 'daily', text: '住民的一天' }] },
    canon: { revision: '8.1', book_sha256: 'b'.repeat(64), reference_sha256: 'c'.repeat(64) },
    canon_passages: [{ file: 'reference/05-ecology-and-everyday.md', text: CANON_TEXT }],
    facts: [], regression: [], regression_stale: [], forbidden: [], cliches: [], requirements: ['一个具名主角。'], interface_requirements: [], aliases: ['远航号'],
    seed: SEED, created_at: START_ISO,
  };
}

function mark(ctx: StepContext, step: StepId): void {
  writeMarker(ctx.files, join(ctx.paths.markers, `${step}.json`), {
    v: 1, round: ctx.roundId, step, completed_at: START_ISO, result: 'done', skipped: null,
    inputs: {}, outputs: {}, external: {}, local: {}, tasks: { ok: 0, void: 0, calls: 0 }, prev: null,
  });
}

interface H {
  dir: string;
  w: FixtureWorld;
  ctx: StepContext;
  routers: Map<Family, FakeRouter>;
}

interface HarnessOptions {
  routes: (family: Family) => Record<string, Route>;
  flags?: Record<string, FreezeFlag>;
  measures?: Record<string, unknown>;
}

function harness(opts: HarnessOptions): H {
  const dir = mkdtempSync(join(tmpdir(), 'forge-measures-'));
  const w = fixtureWorld(dir, DEFAULT_FIXTURE);
  const config = loadConfig(w.root, { requireLocal: true });
  if (!config.ok) throw new Error(config.error);
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: START_ISO, seed: 'measures-ports' });
  const routers = new Map<Family, FakeRouter>();
  const judges = config.value.judges.map((j) => {
    const r = fakeRouter(opts.routes(j.family), { id: j.id, family: j.family, model: j.model });
    routers.set(j.family, r);
    return { backend: r, concurrency: j.concurrency };
  });
  const plain = fakeRouter({}, { id: 'gw', family: 'DeepSeek', model: FIXTURE_WRITER_MODEL });
  const backends: RoundBackends = { writers: [], baseline: plain, decoy: plain, defect: plain, judges, forecasters: [], maintainer: plain, mergeEditor: plain, calibGateway: new Map() };
  const built = buildContext({
    root: w.root, repo: w.repo, roundId: ROUND, pipeline: 'round', paths: roundPaths(w.root, ROUND), config: config.value,
    deps: { ports, backends: () => backends, env: {}, pid: 7, isAlive: () => true, log: () => undefined },
    startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
  });
  if (!built.ok) throw new Error(built.error);
  const ctx = built.value;
  let benchPath = 'benchmark/v1.json';
  let version = 'v1';
  if (opts.measures !== undefined) {
    const v1: unknown = JSON.parse(readFileSync(join(w.root, benchPath), 'utf8'));
    if (!isRecord(v1)) throw new Error('fixture v1 is not an object');
    benchPath = 'benchmark/v2.json';
    version = 'v2';
    writeFileSync(join(w.root, benchPath), `${JSON.stringify({ ...v1, version, parent: 'v1', measures: opts.measures }, null, 2)}\n`);
  }
  mkdirSync(ctx.paths.submissions, { recursive: true });
  const briefText = `${JSON.stringify(stepBrief(), null, 2)}\n`;
  writeFileSync(ctx.paths.brief, briefText);
  const flags = opts.flags ?? { Anthropic: 'ok', Moonshot: 'ok', OpenAI: 'ok', xAI: 'ok' };
  const freeze = buildFreeze({
    round: ROUND, files: { 'brief.json': briefText }, benchmarkVersion: version, eligibleFamilies: Object.keys(flags).filter((f) => flags[f] === 'ok'), flags,
    protocolBundleSha256: ctx.bundleSha256, probeCreatedAt: START_ISO, seed: SEED, stepsSha256: sha256('steps'),
    benchmarkResolution: { version, sha256: sha256Bytes(readFileSync(join(w.root, benchPath))), path: benchPath, via: 'activate', since: FIXTURE_AT },
    gateFamilies: ['Anthropic', 'Moonshot', 'OpenAI', 'xAI'], trustStatusSha256: null, skills: {},
  });
  writeFileSync(ctx.paths.freeze, `${JSON.stringify(freeze, null, 2)}\n`);
  mark(ctx, '02c-freeze');
  return { dir, w, ctx, routers };
}

function submit(h: H, id: string, text: string, family: string = 'DeepSeek'): void {
  writeFileSync(join(h.ctx.paths.submissions, `${id}.json`), JSON.stringify({ id, kind: 'writer', model: FIXTURE_WRITER_MODEL, family, stance: 'daily', ok: true, error: null, text }));
}

function calls(h: H): string[] {
  return [...h.routers.values()].flatMap(callLog).sort();
}

function prompts(h: H, taskId: string): string[] {
  return [...h.routers.values()].flatMap((r) => r.log().filter((c) => c.taskId === taskId).map((c) => c.prompt));
}

function file(h: H, dir: MeasureDir, sub: string): Record<string, unknown> {
  const v: unknown = JSON.parse(readFileSync(measurePath(h.ctx, dir, sub), 'utf8'));
  if (!isRecord(v)) throw new Error('not an object');
  return v;
}

function recallRoute(image: string, quote: string): Route {
  return (prompt) => {
    const numbers = (unwrap(prompt, '数列') ?? '').split('、').map(Number).sort((a, b) => a - b);
    return fenced({ sorted: numbers, image, quote });
  };
}

const JUNK: Route = () => 'no fence here';

const skinRoute: Route = (prompt) => {
  const label = ['甲', '乙', '丙', '丁'].find((l) => (unwrap(prompt, `卡片${l}`) ?? '').includes('那艘船')) ?? '甲';
  return fenced({ pick: label, quote: '循环泵换了节拍', reason: '配给簿与邻里' });
};

const coldRoute: Route = () => fenced({
  where: { answer: '一艘船上的邻里', quote: '挂回第三邻里的工具墙' },
  who: { name: '温芮', wants: '把工具还回去', cost: null, quote: '把借来的扳手挂回' },
  go: { answer: null, quote: null },
});

function producerRoute(ok = true): Route {
  return (prompt) => {
    const ids = (unwrap(prompt, '检查项') ?? '').split('\n').map((l) => l.split('｜')[0] ?? '');
    return fenced({ items: ids.map((id) => (ok || id !== 'O.状态' ? { id, ok: true, missing: null } : { id, ok: false, missing: '没写状态' })) });
  };
}

function defaultRoutes(family: Family): Record<string, Route> {
  const recall: Record<string, Route> = {
    Anthropic: recallRoute('琥珀色灯带', '走廊里的灯带转成琥珀色'),
    Moonshot: recallRoute('灯带', '灯带转成琥珀色'),
    OpenAI: recallRoute('扳手', '温芮把借来的扳手挂回'),
    xAI: JUNK,
  };
  return { recall: recall[family] ?? JUNK, skin: skinRoute, cold: coldRoute, producer: producerRoute() };
}

const SCHEMA = loadSchema(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'schema', 'measures.schema.json'), 'utf8')));

function schemaErrors(value: unknown): string[] {
  if (!SCHEMA.ok) return [SCHEMA.error];
  return validate(SCHEMA.value, value);
}

test('06d: recall from every eligible family, one seeded skin-swap / cold / producer call each; files per measure; resume makes no call', async () => {
  const h = harness({ routes: defaultRoutes });
  submit(h, 'W1', writerText(MEASURE_TEXT, goodInterface(), ['工具墙']));
  submit(h, 'W2', writerText(MEASURE_TEXT, goodInterface(['借'])));
  const out = await measureSubmissions(h.ctx, ['W1', 'W2']);
  assert.equal(out.kind, 'done');
  if (out.kind !== 'done') return;
  assert.deepEqual(out.inputs, ['rounds/R01/brief.json', 'map/rows.json', 'map/aliases.json', 'rounds/R01/submissions/W1.json', 'rounds/R01/submissions/W2.json']);
  const dirs: MeasureDir[] = ['recall', 'skin-swap', 'cold-reader', 'producer'];
  assert.deepEqual(out.outputs, ['W1', 'W2'].flatMap((s) => dirs.map((d) => `rounds/R01/measures/${d}/${s}.json`)));
  assert.deepEqual(out.external, []);
  const pool: Family[] = ['Anthropic', 'Moonshot', 'OpenAI', 'xAI'];
  const skinFamily = pickFamilies(pool, 1, SEED, 'skin:W1')[0] ?? 'none';
  const coldFamily = pickFamilies(pool, 1, SEED, 'cold:W1')[0] ?? 'none';
  const producerFamily = pickFamilies(pool, 2, SEED, 'producer:W1')[0] ?? 'none';
  const log = calls(h);
  for (const f of pool) assert.ok(log.includes(`recall-W1-${f}#1`), `recall from ${f}`);
  assert.ok(log.includes('recall-W1-xAI#2'), 'a judge failure is retried identically once');
  assert.ok(log.includes(`skin-W1-${skinFamily}#1`) && log.includes(`cold-W1-${coldFamily}#1`) && log.includes(`producer-W1-${producerFamily}#1`));
  assert.equal(log.filter((c) => c.startsWith('skin-W1-') || c.startsWith('cold-W1-') || c.startsWith('producer-W1-')).length, 3);
  assert.equal(new Set(log).size, log.length, 'every task id + attempt is unique');
  const numbersOf = (f: Family): string => unwrap(prompts(h, `recall-W1-${f}`)[0] ?? '', '数列') ?? '';
  assert.notEqual(numbersOf('Anthropic'), numbersOf('Moonshot'), 'a seeded distractor per family');

  const recall = readRecallFile(h.ctx, 'W1');
  assert.ok(recall.ok);
  assert.deepEqual(recall.value.calls.map((c) => [c.family, c.status]), [['Anthropic', 'ok'], ['Moonshot', 'ok'], ['OpenAI', 'ok'], ['xAI', 'void']]);
  assert.ok(recall.value.calls[3]?.error !== null);
  assert.deepEqual(recall.value.details.map((d) => [d.id, d.image, d.families]), [['D1', '琥珀色灯带', ['Anthropic', 'Moonshot']], ['D2', '扳手', ['OpenAI']]]);
  assert.equal(recall.value.hook, 2 / 3);

  const skin = file(h, 'skin-swap', 'W1');
  assert.equal(skin['status'], 'ok');
  assert.equal(skin['family'], skinFamily);
  const lineup = Array.isArray(skin['lineup']) ? skin['lineup'] : [];
  assert.deepEqual(lineup.map((c) => (isRecord(c) ? c['row_id'] : null)).sort(), ['S1-冷湾', 'S1-赤脊', 'SHIP'], 'brief row + the other rows with a first_quote card');
  const verdict = skin['verdict'];
  assert.ok(isRecord(verdict) && verdict['recognised'] === true);
  const skinPrompt = prompts(h, `skin-W1-${skinFamily}`)[0] ?? '';
  const swapped = unwrap(skinPrompt, '文本甲') ?? '';
  for (const name of ['温芮', '林澈', '工具墙', '远航号']) assert.ok(!swapped.includes(name), `${name} swapped out`);
  assert.ok(swapped.includes('那人') && swapped.includes('那东西'), 'characters → 那人, new nouns → 那东西');

  const coldPrompt = prompts(h, `cold-W1-${coldFamily}`)[0] ?? '';
  assert.ok(coldPrompt !== '' && !coldPrompt.includes(CANON_TEXT) && !coldPrompt.includes('配给簿'), 'the cold reader never sees canon');
  assert.equal(file(h, 'cold-reader', 'W1')['status'], 'ok');

  assert.deepEqual([file(h, 'producer', 'W1')['status'], file(h, 'producer', 'W1')['mechanical']], ['pass', []]);
  assert.deepEqual([file(h, 'producer', 'W2')['status'], file(h, 'producer', 'W2')['mechanical']], ['fail', ['object.verbs']], 'Layer 3 needs the engine checks too');
  const items = file(h, 'producer', 'W1')['items'];
  assert.equal(Array.isArray(items) ? items.length : 0, 32);

  for (const s of ['W1', 'W2']) for (const d of dirs) assert.deepEqual(schemaErrors(file(h, d, s)), [], `${d}/${s}`);
  const before = calls(h).length;
  const again = await measureSubmissions(h.ctx, ['W1', 'W2']);
  assert.equal(again.kind, 'done');
  assert.equal(calls(h).length, before, 'task records are reused on resume');
  rmSync(h.dir, { recursive: true });
});

test('06d pools: authors, flagged and unqualified families never measure; a void producer hands over to one more family (-2), then unjudged', async () => {
  const h = harness({
    flags: { Anthropic: 'ok', Moonshot: 'ok', OpenAI: 'unqualified', xAI: 'flagged' },
    routes: (family) => ({
      ...defaultRoutes(family),
      recall: recallRoute('灯带', '走廊里的灯带转成琥珀色'),
      producer: (prompt, n, meta) => (meta.taskId.startsWith('producer-W2-') || !meta.taskId.endsWith('-2') ? 'void' : producerRoute(false)(prompt, n, meta)),
    }),
  });
  submit(h, 'W1', writerText(MEASURE_TEXT, goodInterface()));
  submit(h, 'W2', writerText(MEASURE_TEXT, goodInterface()));
  submit(h, 'W3', writerText(MEASURE_TEXT, goodInterface()), 'Anthropic');
  const out = await measureSubmissions(h.ctx, ['W1', 'W2', 'W3']);
  assert.equal(out.kind, 'done');
  const log = calls(h);
  assert.ok(!log.some((c) => c.includes('-OpenAI') || c.includes('-xAI')), 'unqualified and flagged families never measure');
  assert.ok(!log.some((c) => c.includes('-W3-Anthropic')), 'the author family never judges its own text');
  const w1 = file(h, 'producer', 'W1');
  const pair = pickFamilies(['Anthropic', 'Moonshot'], 2, SEED, 'producer:W1');
  assert.deepEqual(w1['calls'], [
    { family: pair[0], task: `producer-W1-${pair[0]}`, status: 'void' },
    { family: pair[1], task: `producer-W1-${pair[1]}-2`, status: 'ok' },
  ]);
  assert.equal(w1['status'], 'fail', 'the second family said O.状态 is not enough');
  const w2 = file(h, 'producer', 'W2');
  assert.deepEqual([w2['status'], w2['items']], ['unjudged', []]);
  const w3 = file(h, 'producer', 'W3');
  assert.deepEqual([w3['status'], w3['calls']], ['unjudged', [{ family: 'Moonshot', task: 'producer-W3-Moonshot', status: 'void' }]], 'only one eligible family, no second');
  const r3 = readRecallFile(h.ctx, 'W3');
  assert.ok(r3.ok);
  assert.deepEqual(r3.value.calls.map((c) => c.family), ['Moonshot']);
  assert.equal(r3.value.hook, 0, 'a single valid family never shares a detail');
  rmSync(h.dir, { recursive: true });
});

test('06d: inactive benchmark measures write status inactive with no call; hook inactive → null; a slotted maintainer prompt fails the step before any call', async () => {
  const off = { active: false, prompt: null };
  const h = harness({ routes: defaultRoutes, measures: { skin_swap: off, cold_reader: off, hook: off } });
  submit(h, 'W1', writerText(MEASURE_TEXT, goodInterface()));
  const out = await measureSubmissions(h.ctx, ['W1']);
  assert.equal(out.kind, 'done');
  assert.deepEqual([file(h, 'skin-swap', 'W1')['status'], file(h, 'skin-swap', 'W1')['task']], ['inactive', null]);
  assert.deepEqual([file(h, 'cold-reader', 'W1')['status'], file(h, 'cold-reader', 'W1')['read']], ['inactive', null]);
  assert.equal(file(h, 'recall', 'W1')['hook'], null);
  assert.ok(!calls(h).some((c) => c.startsWith('skin-') || c.startsWith('cold-')));
  assert.ok(calls(h).some((c) => c.startsWith('producer-')), 'Layer 3 is never retired');
  rmSync(h.dir, { recursive: true });

  const bad = harness({ routes: defaultRoutes, measures: { cold_reader: { active: true, prompt: '回答 {QUESTIONS}' } } });
  submit(bad, 'W1', writerText(MEASURE_TEXT, goodInterface()));
  const refused = await measureSubmissions(bad.ctx, ['W1']);
  assert.equal(refused.kind, 'failed');
  assert.match(refused.kind === 'failed' ? refused.detail : '', /measures\.cold_reader\.prompt: measure prompt: holds a \{slot\}/u);
  assert.deepEqual(calls(bad), []);
  assert.ok(!existsSync(bad.ctx.paths.measures));
  rmSync(bad.dir, { recursive: true });

  // hook has no LLM call, but a maintainer paragraph on it is validated too, never silently dropped.
  const hook = harness({ routes: defaultRoutes, measures: { hook: { active: true, prompt: '看 {TEXT_1}' } } });
  submit(hook, 'W1', writerText(MEASURE_TEXT, goodInterface()));
  const hookRefused = await measureSubmissions(hook.ctx, ['W1']);
  assert.equal(hookRefused.kind, 'failed');
  assert.match(hookRefused.kind === 'failed' ? hookRefused.detail : '', /measures\.hook\.prompt: measure prompt: holds a \{slot\}/u);
  assert.deepEqual(calls(hook), []);
  rmSync(hook.dir, { recursive: true });
});

test('06d: a missing passing submission fails the step without calls', async () => {
  const h = harness({ routes: defaultRoutes });
  const out = await measureSubmissions(h.ctx, ['W1']);
  assert.deepEqual(out, { kind: 'failed', detail: 'submissions/W1.json is missing or holds no valid submission' });
  assert.deepEqual(calls(h), []);
  rmSync(h.dir, { recursive: true });
});

test('06d-measures step: measures exactly passingSubmissions (05c files)', async () => {
  const h = harness({ routes: defaultRoutes });
  submit(h, 'W1', writerText(MEASURE_TEXT, goodInterface()));
  submit(h, 'W2', writerText(MEASURE_TEXT, goodInterface()));
  const entry = { status: 'pass', pass: true, checks: [], error: null };
  mkdirSync(h.ctx.paths.gate, { recursive: true });
  writeFileSync(join(h.ctx.paths.gate, 'mechanical.json'), JSON.stringify({ round: ROUND, submissions: { W1: entry, W2: { status: 'missing', pass: false, checks: [], error: 'void' } } }));
  writeFileSync(join(h.ctx.paths.gate, 'llm.json'), JSON.stringify({
    round: ROUND, defect_submission: null, defect_status: 'none', voided_families: [], submissions: { W1: { outcome: 'pass', defect_unverified: false } }, unverified: [],
  }));
  const out = await measuresStep.run(h.ctx, null);
  assert.equal(out.kind, 'done', out.kind === 'failed' ? out.detail : out.kind);
  assert.ok(existsSync(measurePath(h.ctx, 'recall', 'W1')) && !existsSync(measurePath(h.ctx, 'recall', 'W2')));
  rmSync(h.dir, { recursive: true });
});
