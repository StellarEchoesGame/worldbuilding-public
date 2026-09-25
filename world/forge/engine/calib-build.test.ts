import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildStep, calibPaths, degradeTask, displayOrder, parseBuildConfig, parseCalibPairs, parseSetRequest, planRequal, planRound0, readCalibPairs, readCalibReference, readCalibSet,
  rewriteTask, selectPassages, setKindOf, splitRound0, type BuildConfig, type Passage, type PlannedPair,
} from './calib-build.ts';
import { loadConfig, type Family, type PrefixRule } from './config.ts';
import { canonFiles } from './inputs.ts';
import { buildContext, type RoundBackends, type RunHooks, type StepContext } from './context.ts';
import type { Result } from './result.ts';
import { loadProtocolBundle } from './rules.ts';
import { runSteps } from './runner.ts';
import { sha256 } from './store.ts';
import { unwrap } from './tasks/fenced.ts';
import { charCount, splitSentences } from './text.ts';
import { fakePorts } from './testing/fakes.ts';
import { DEFAULT_FIXTURE, FIXTURE_REFERENCE_FILES, fixtureWorld, type FixtureWorld } from './testing/fixture-world.ts';
import { fakeRouter, type FakeRouter, type Route } from './testing/scripted.ts';

const REAL_ROOT = join(import.meta.dirname, '..');
const PREFIXES: PrefixRule[] = [{ prefix: 'deepseek', family: 'DeepSeek' }, { prefix: 'qwen/', family: 'Alibaba' }, { prefix: 'gpt-', family: 'OpenAI' }, { prefix: 'kimi-code/', family: 'Moonshot' }];
const JUDGES: ReadonlySet<Family> = new Set<Family>(['OpenAI', 'Anthropic', 'Moonshot', 'xAI']);
const BUNDLE = loadProtocolBundle(REAL_ROOT);
if (!BUNDLE.ok) throw new Error(BUNDLE.error);
const CAL = BUNDLE.value.protocol.calibration;
const BUILD_JSON = {
  primary_model: 'deepseek-fixture-a', contrast_models: ['qwen/fixture-b'], degrade_model: 'deepseek-fixture-a',
  passage_files: ['reference/a.md', 'reference/b.md', 'reference/c.md', 'reference/d.md', 'reference/e.md'],
  passage_chars: [250, 600], length_tolerance_pct: 15, max_passages_per_file: 5,
};
const CFG: BuildConfig = {
  primaryModel: 'deepseek-fixture-a', contrastModels: ['qwen/fixture-b'], degradeModel: 'deepseek-fixture-a', passageFiles: BUILD_JSON.passage_files,
  passageChars: [250, 600], lengthTolerancePct: 15, maxPassagesPerFile: 5,
};
const ACTS = ['核对水循环的读数', '把借来的工具挂回墙上', '用手写的记录卡交接夜班', '修补通风口的滤网', '把晾干的菌毯送回培养架', '在公告板上贴出轮值表'];

/** One ≈ 300-character prose block (11 distinct sentences) about `place`. */
function block(place: string): string {
  return Array.from({ length: 11 }, (_, i) => `在${place}，第${i + 1}位住户每天${ACTS[i % ACTS.length] ?? ''}。`).join('');
}

/** A canon file: a heading, a table, a blockquote and `n` prose blocks. */
function canonFile(name: string, n: number): string {
  const blocks = Array.from({ length: n }, (_, i) => block(`${name}区第${i + 1}舱`));
  return [`# ${name}`, '', `> ${block('引文')}`, '', `| 列 | ${block('表格')} |`, '', ...blocks.flatMap((b) => [b, ''])].join('\n');
}

const CANON: Record<string, string> = Object.fromEntries(CFG.passageFiles.map((f) => [f, canonFile(f, 7)]));

function fenced(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function refuses(r: Result<unknown>, pattern: RegExp): void {
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, pattern);
}

test('setKindOf / calibPaths / parseSetRequest: set ids, calibration dirs and request rules', () => {
  assert.deepEqual(['C00', 'Q01', 'G02'].map(setKindOf), ['round0', 'requal', 'gate']);
  assert.throws(() => setKindOf('R01'), RangeError);
  const p = calibPaths('/f', 'C00');
  assert.deepEqual([p.id, p.dir, p.runs, p.taste, p.markers, p.tasks, p.calls], ['C00', '/f/calibration/C00', '/f/.runs/calib-C00', '/f/calibration/C00/verdicts', '/f/calibration/C00/markers', '/f/calibration/C00/tasks', '/f/calibration/C00/calls']);
  const req = { set: 'Q01', kind: 'requal', family: 'xAI', reason: 'suspension', seed: '0123456789abcdef', requested_at: '2026-10-01T00:00:00.000Z' };
  assert.deepEqual(parseSetRequest(req), { ok: true, value: req });
  const bad: unknown[] = [{ ...req, kind: 'round0' }, { ...req, reason: null }, { ...req, family: 'Nobody' }, { ...req, seed: 'XYZ' }, { ...req, set: 'C00', kind: 'round0' }, { ...req, set: 'G01', kind: 'gate' }];
  for (const b of bad) assert.equal(parseSetRequest(b).ok, false, JSON.stringify(b));
});

test('parseBuildConfig: accepts non-judge models, refuses judge-family models, unknown prefixes and schema violations', () => {
  assert.deepEqual(parseBuildConfig(BUILD_JSON, PREFIXES, JUDGES), { ok: true, value: CFG });
  const refused: Array<[unknown, RegExp]> = [
    [{ ...BUILD_JSON, contrast_models: ['gpt-6-astra'] }, /judge family OpenAI/u],
    [{ ...BUILD_JSON, degrade_model: 'kimi-code/k3' }, /judge family Moonshot/u],
    [{ ...BUILD_JSON, primary_model: 'mystery/model' }, /no family/u],
    [{ ...BUILD_JSON, contrast_models: ['deepseek-fixture-a'] }, /distinct/u],
    [{ ...BUILD_JSON, extra: 1 }, /unexpected property extra/u],
    [{ ...BUILD_JSON, passage_chars: [600, 250] }, /min <= max/u],
    [{ ...BUILD_JSON, passage_chars: [250, 5000] }, /passage_chars max 5000 with 15% tolerance twice \(rewrite, then its degraded copy\) exceeds the 4000-character text cap/u],
    [{ ...BUILD_JSON, passage_chars: [250, 3400] }, /passage_chars max 3400 with 15% tolerance twice/u],
  ];
  for (const [v, pattern] of refused) refuses(parseBuildConfig(v, PREFIXES, JUDGES), pattern);
});

test('selectPassages: seeded, prose blocks only, length and per-file caps, excludes used, prefix-stable', () => {
  const a = value(selectPassages(CANON, CFG, new Set(), 24, 'seed-1'));
  assert.deepEqual(value(selectPassages(CANON, CFG, new Set(), 24, 'seed-1')), a, 'deterministic');
  assert.notDeepEqual(value(selectPassages(CANON, CFG, new Set(), 24, 'seed-2')), a, 'the seed decides');
  for (const p of a) {
    assert.ok(!/^[#>|]/mu.test(p.text), p.id);
    assert.ok(charCount(p.text) >= 250 && charCount(p.text) <= 600, p.id);
    assert.equal(p.sha256, sha256(p.text));
    assert.ok(CANON[p.file]?.includes(p.text));
  }
  for (const f of CFG.passageFiles) assert.ok(a.filter((p) => p.file === f).length <= 5, f);
  assert.equal(new Set(a.map((p) => p.sha256)).size, 24);
  assert.deepEqual(value(selectPassages(CANON, CFG, new Set(), 25, 'seed-1')).slice(0, 24), a, 'a larger count extends the list');
  const used = new Set(a.slice(0, 3).map((p) => p.sha256));
  assert.ok(value(selectPassages(CANON, CFG, used, 20, 'seed-1')).every((p) => !used.has(p.sha256)));
  assert.equal(selectPassages(CANON, CFG, new Set(), 26, 'seed-1').ok, false, 'at most 5 of each of 5 files');
  assert.ok(value(selectPassages(CANON, { ...CFG, passageChars: [700, 900] }, new Set(), 10, 'seed-1')).every((p) => /^reference\/.\.md#\d+-\d+$/u.test(p.id) && CANON[p.file]?.includes(p.text)), 'adjacent paragraphs merge verbatim');
  assert.equal(selectPassages(CANON, { ...CFG, passageChars: [5000, 6000] }, new Set(), 1, 'seed-1').ok, false, 'no section is that long');
  assert.equal(selectPassages({}, CFG, new Set(), 1, 'seed-1').ok, false, 'a missing file is an error');
});

function passages(n: number): Passage[] {
  return value(selectPassages(CANON, CFG, new Set(), n, 'plan-seed'));
}

function count<T>(items: readonly T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of items) out[key(t)] = (out[key(t)] ?? 0) + 1;
  return out;
}

test('planRound0: 6/6/6/6 on 24 distinct passages; 8.1 passages only in canon_vs_rewrite; known base is a rewrite', () => {
  const plan = planRound0(passages(24), CFG, CAL, 'plan-seed');
  assert.deepEqual(plan, planRound0(passages(24), CFG, CAL, 'plan-seed'), 'deterministic');
  assert.deepEqual(count(plan.pairs, (p) => p.category), { canon_vs_rewrite: 6, cross_model: 6, stance: 6, known: 6 });
  const text = new Map(plan.texts.map((t) => [t.id, t]));
  const passageOf = (id: string): string => {
    const t = text.get(id);
    return t === undefined || t.role === 'defect' ? '' : t.role === 'degraded' ? passageOf(t.of) : t.passage.sha256;
  };
  assert.equal(new Set(plan.pairs.map((p) => passageOf(p.a))).size, 24, 'one distinct passage per pair');
  const cvrModels: string[] = [];
  for (const p of plan.pairs) {
    const [a, b] = [text.get(p.a), text.get(p.b)];
    assert.ok(a !== undefined && b !== undefined);
    assert.equal(passageOf(p.a), passageOf(p.b), `${p.id}: both texts on one passage`);
    assert.equal(a.role === 'passage' || b.role === 'passage', p.category === 'canon_vs_rewrite', `${p.id}: 8.1 text only in canon_vs_rewrite`);
    if (p.category === 'canon_vs_rewrite' && b.role === 'rewrite') cvrModels.push(b.model);
    const both = a.role === 'rewrite' && b.role === 'rewrite';
    if (p.category === 'cross_model') assert.ok(both && a.model === CFG.primaryModel && b.model === 'qwen/fixture-b' && a.stance.id === b.stance.id, `${p.id}: primary vs contrast, same stance`);
    if (p.category === 'stance') assert.ok(both && a.model === CFG.primaryModel && b.model === CFG.primaryModel && a.stance.id !== b.stance.id, `${p.id}: two stances`);
    if (p.category === 'known') assert.ok(a.role === 'rewrite' && a.model === CFG.primaryModel && b.role === 'degraded' && b.of === a.id, `${p.id}: rewrite vs its degraded copy`);
    assert.equal(p.knownBetter, p.category === 'known' ? a.id : null);
  }
  assert.deepEqual(count(cvrModels, (m) => m), { 'deepseek-fixture-a': 4, 'qwen/fixture-b': 2 }, 'rotation primary ×2 + contrast ×1, cycled');
  assert.throws(() => planRound0(passages(23), CFG, CAL, 'plan-seed'), RangeError);
});

test('planRequal: 9 non-known over the categories the family may judge + 3 known (OpenAI: no canon_vs_rewrite)', () => {
  assert.deepEqual(count(planRequal('Q01', 'OpenAI', passages(12), CFG, CAL, 's').pairs, (p) => p.category), { cross_model: 5, stance: 4, known: 3 });
  const xai = planRequal('Q02', 'xAI', passages(12), CFG, CAL, 's');
  assert.deepEqual(count(xai.pairs, (p) => p.category), { canon_vs_rewrite: 3, cross_model: 3, stance: 3, known: 3 });
  assert.ok(xai.pairs.every((p) => p.id.startsWith('Q02-P')) && xai.texts.every((t) => t.id.startsWith('Q02-T')));
  assert.deepEqual([xai.kind, xai.family], ['requal', 'xAI']);
  assert.throws(() => planRequal('C00', 'xAI', passages(12), CFG, CAL, 's'), RangeError);
});

const TOY_PAIRS: PlannedPair[] = planRound0(passages(24), CFG, CAL, 'plan-seed').pairs;

test('displayOrder: 24 seeded slots + 4 retests in 25–28, sides swapped, originals ≤ 16, one per category', () => {
  const pairs = TOY_PAIRS;
  const d = displayOrder(pairs, 4, 'disp-seed');
  assert.deepEqual(d, displayOrder([...pairs].reverse(), 4, 'disp-seed'), 'deterministic, independent of input order');
  assert.deepEqual(d.map((x) => x.slot), Array.from({ length: 28 }, (_, i) => i + 1));
  assert.deepEqual(new Set(d.slice(0, 24).map((x) => x.pair)).size, 24);
  const cat = new Map(pairs.map((p) => [p.id, p.category]));
  const retests = d.slice(24);
  assert.deepEqual(retests.map((r) => cat.get(r.pair)).sort(), ['canon_vs_rewrite', 'cross_model', 'known', 'stance']);
  for (const r of retests) {
    const o = d.find((x) => x.slot === r.retestOf);
    assert.ok(o !== undefined && o.slot <= 16 && o.pair === r.pair && o.left === r.right && o.right === r.left, `slot ${r.slot}`);
  }
  assert.ok(d.slice(0, 24).every((x) => x.retestOf === null));
  const sides = d.slice(0, 24).filter((x) => pairs.find((p) => p.id === x.pair)?.a === x.left).length;
  assert.ok(sides > 0 && sides < 24, 'left / right seeded per pair');
  assert.notDeepEqual(displayOrder(pairs, 4, 'other-seed'), d);
  assert.equal(displayOrder(pairs.slice(0, 12), 0, 's').length, 12, 'Q sets: no retests');
});

test('splitRound0: 3 / 3 per category at defaults, stable under reruns and input order', () => {
  const pairs = TOY_PAIRS;
  const s = splitRound0(pairs, CAL.visibleRound0, 'split-seed');
  assert.deepEqual(splitRound0([...pairs].reverse(), CAL.visibleRound0, 'split-seed'), s);
  assert.deepEqual(count(pairs, (p) => `${p.category}/${s[p.id] ?? ''}`), Object.fromEntries(CAL.categories.flatMap((c) => [[`${c}/visible`, 3], [`${c}/reserve`, 3]])));
  const odd = splitRound0(pairs, 13, 'split-seed');
  assert.equal(Object.values(odd).filter((v) => v === 'visible').length, 13, 'round-robin beyond an even share');
});

test('rewriteTask: Chinese prompt with the wrapped passage; parse enforces length, no heading line, no chapter marker', () => {
  const [p] = passages(1);
  assert.ok(p !== undefined);
  const stance = { id: 'resident-day', text: '居民的一天。' };
  const target = charCount(p.text);
  const spec = rewriteTask('calibrewrite-C00-T02', p, stance, target, 15, 'seed');
  assert.equal(spec.id, 'calibrewrite-C00-T02');
  assert.equal(unwrap(spec.prompt, '原文'), p.text);
  assert.match(spec.prompt, new RegExp(`约${target}字（允许 ±15%）`, 'u'));
  assert.ok(spec.retryPrompt !== undefined);
  const good = rewritten(p.text);
  assert.deepEqual(spec.parse(fenced({ text: good })), { ok: true, value: { text: good } });
  const bad: Array<[string, RegExp]> = [
    [fenced({ text: good.slice(0, Math.floor(good.length * 0.8)) }), /outside/u],
    [fenced({ text: `${good}${good.slice(0, Math.floor(good.length * 0.2))}` }), /outside/u],
    [fenced({ text: `# 标题\n${good}` }), /heading/u],
    [fenced({ text: `【第一章】${good}` }), /chapter marker/u],
    ['no block', /fenced/u],
  ];
  for (const [text, pattern] of bad) refuses(spec.parse(text), pattern);
});

test('rewriteTask: parse refuses the passage copied verbatim (width, spacing, punctuation aside) or only reordered', () => {
  const [p] = passages(1);
  assert.ok(p !== undefined);
  const spec = rewriteTask('calibrewrite-C00-T02', p, { id: 'resident-day', text: '居民的一天。' }, charCount(p.text), 15, 'seed');
  refuses(spec.parse(fenced({ text: p.text })), /^text: equals the passage verbatim$/u);
  refuses(spec.parse(fenced({ text: p.text.replaceAll('。', '； ') })), /^text: equals the passage verbatim$/u);
  refuses(spec.parse(fenced({ text: splitSentences(p.text).reverse().join('') })), /^text: every sentence is copied from the passage$/u);
  refuses(spec.parse(fenced({ text: splitSentences(p.text).reverse().join('\n').replaceAll('。', '，') })), /every sentence is copied/u);
  const text = rewritten(p.text);
  assert.deepEqual(spec.parse(fenced({ text })), { ok: true, value: { text } });
});

/** The fake degrade answer: the first `n` sentences get the generic `tail`; `extra` appends a sentence. */
function degraded(original: string, n: number, extra = '', tail = '宛如往常'): { text: string; changes: Array<{ from: string; to: string }> } {
  const changes = splitSentences(original).slice(0, n).map((s) => ({ from: s, to: `${s.slice(0, -1)}，${tail}。` }));
  let text = original;
  for (const c of changes) text = text.replace(c.from, c.to);
  return { text: `${text}${extra}`, changes };
}

test('degradeTask: parse needs 3–6 verbatim changes, the same sentence count and length within tolerance', () => {
  const original = block('测试舱');
  const spec = degradeTask('calibdegrade-C00-T48', original, ['仿佛', '宛如'], 15, 'seed');
  assert.equal(unwrap(spec.prompt, '现场'), original);
  assert.match(spec.prompt, /可参考：仿佛、宛如/u);
  const good = degraded(original, 3);
  assert.deepEqual(spec.parse(fenced(good)), { ok: true, value: good });
  const bad: Array<[unknown, RegExp]> = [
    [{ ...good, changes: good.changes.slice(0, 2) }, /expected 3 to 6/u],
    [{ ...good, changes: [{ from: '原文里没有的句子', to: good.changes[0]?.to }, ...good.changes.slice(1)] }, /from: not found verbatim in the original/u],
    [{ ...good, changes: [{ ...good.changes[0], to: '新正文里没有' }, ...good.changes.slice(1)] }, /to: not found verbatim/u],
    [{ ...good, text: original }, /still present/u],
    [degraded(original, 3, '多出来的一句。'), /sentences/u],
    [degraded(original, 3, '', '很'.repeat(30)), /length outside/u],
  ];
  for (const [v, pattern] of bad) refuses(spec.parse(fenced(v)), pattern);
});

/** The fake rewrite: the passage's sentences reversed plus one sentence of its own (parse refuses a pure copy). */
function rewritten(passage: string): string {
  return `${splitSentences(passage).reverse().join('')}这一天就这样过去了。`;
}

const REWRITE: Route = (prompt) => fenced({ text: rewritten(unwrap(prompt, '原文') ?? '') });
const GOOD_ROUTES: Record<string, Route> = {
  calibrewrite: REWRITE,
  calibdegrade: (prompt) => fenced(degraded(unwrap(prompt, '现场') ?? '', 3)),
  defect: (prompt) => {
    const first = (unwrap(prompt, '正文') ?? '').split('\n')[0] ?? '';
    const against = (unwrap(prompt, '条目') ?? '').split('｜')[0] ?? '';
    return fenced({ sentence_no: 1, original: first.replace(/^〔S\d+〕/u, ''), replacement: '据说早在先遣队之前这里就有人住过。', against });
  },
};

/** Fixture world plus four more prose blocks per passage file (C00 and a later Q set need 36 distinct passages); fakeGit gets them too. */
function world(dir: string): FixtureWorld {
  const w = fixtureWorld(dir, DEFAULT_FIXTURE);
  for (const f of FIXTURE_REFERENCE_FILES.filter((name) => !name.startsWith('07-'))) {
    const path = join(w.repo, 'world', 'current', 'reference', f);
    appendFileSync(path, `\n${[1, 2, 3, 4].map((k) => block(`${f}附录${k}`)).join('\n\n')}\n`);
    w.main[`world/current/reference/${f}`] = readFileSync(path, 'utf8');
  }
  return w;
}

function request(w: FixtureWorld, set: string, family: Family | null, reason: string | null): void {
  mkdirSync(join(w.root, 'calibration', set), { recursive: true });
  const kind = setKindOf(set);
  writeFileSync(join(w.root, 'calibration', set, 'request.json'), JSON.stringify({ set, kind, family, reason, seed: sha256(set).slice(0, 16), requested_at: '2026-10-01T00:00:00.000Z' }));
}

function harness(w: FixtureWorld, set: string, routes: Record<string, Route> = GOOD_ROUTES, hooks: RunHooks = {}): { ctx: StepContext; routers: FakeRouter[] } {
  const config = loadConfig(w.root, { requireLocal: true });
  if (!config.ok) throw new Error(config.error);
  const a = fakeRouter(routes, { id: 'calib-deepseek-a', family: 'DeepSeek', model: 'deepseek-fixture-a' });
  const b = fakeRouter(routes, { id: 'calib-qwen-b', family: 'Alibaba', model: 'qwen/fixture-b' });
  const defect = fakeRouter(routes, { id: 'defect', family: 'DeepSeek', model: 'deepseek-fixture' });
  const backends: RoundBackends = {
    writers: [], baseline: defect, decoy: defect, defect, judges: [], forecasters: [], maintainer: defect, mergeEditor: defect,
    calibGateway: new Map([['deepseek-fixture-a', a], ['qwen/fixture-b', b]]),
  };
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: '2026-10-01T00:00:00.000Z', seed: 'calib-build' });
  const built = buildContext({
    root: w.root, repo: w.repo, roundId: set, pipeline: 'calibration', paths: calibPaths(w.root, set), config: config.value,
    deps: { ports, backends: () => backends, hooks, env: {}, pid: 7, isAlive: () => true, log: () => undefined },
    startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
  });
  if (!built.ok) throw new Error(built.error);
  return { ctx: built.value, routers: [a, b, defect] };
}

function calls(h: { routers: FakeRouter[] }): string[] {
  return h.routers.flatMap((r) => r.log().map((c) => `${c.taskId}#${c.attempt}`));
}

async function run(h: { ctx: StepContext }): Promise<string> {
  const out = await buildStep.run(h.ctx, null);
  return out.kind === 'failed' ? `failed: ${out.detail}` : out.kind;
}

test('buildStep C00: 42 gateway + 4 defect calls; texts, reference.json, then the pairs.json set; rerun makes no calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-calib-build-'));
  const w = world(dir);
  request(w, 'C00', null, null);
  const ownerLog = (): string => readFileSync(join(w.root, 'owner-log.jsonl'), 'utf8');
  const owner = ownerLog();
  const h = harness(w, 'C00');
  const out = await buildStep.run(h.ctx, null);
  assert.equal(out.kind, 'done', out.kind === 'failed' ? out.detail : '');
  assert.equal(new Set(h.routers.slice(0, 2).flatMap((r) => r.log().map((c) => c.taskId))).size, 42);
  assert.equal(new Set(h.routers[2]?.log().map((c) => c.taskId)).size, 4);
  const set = value(readCalibSet(w.root, 'C00'));
  assert.deepEqual([set.size, set.pairs.length, Object.keys(set.texts).length, set.dryrun.length], [28, 24, 52, 4]);
  assert.deepEqual(count(set.pairs, (p) => p.split), { visible: 12, reserve: 12 });
  for (const [id, t] of Object.entries(set.texts)) assert.equal(sha256(readFileSync(join(w.root, 'calibration', t.path), 'utf8')), t.sha256, id);
  for (const p of set.pairs) {
    const fams = [set.texts[p.a]?.author_family, set.texts[p.b]?.author_family];
    assert.deepEqual(p.authors, [...new Set(fams)].sort(), p.id);
    if (p.category === 'canon_vs_rewrite') assert.ok(p.authors.includes('OpenAI'));
  }
  assert.deepEqual(new Set(set.dryrun.map((d) => d.defect_type)).size, 4, 'one copy per enabled defect type');
  for (const d of set.dryrun) assert.ok(set.pairs.some((p) => p.category === 'known' && p.known_better === d.base) && set.texts[d.copy]?.of === d.base);
  const ref = value(readCalibReference(h.ctx.paths));
  assert.ok(ref.facts.some((f) => f.kind === 'registered') && ref.forbidden.length === 3);
  if (out.kind === 'done') assert.deepEqual(out.external, ['calibration/pairs.json']);
  const bytes = readFileSync(join(w.root, 'calibration', 'pairs.json'), 'utf8');
  const again = harness(w, 'C00');
  assert.equal(await run(again), 'done');
  assert.deepEqual(calls(again), [], 'a rerun reuses every task record');
  assert.equal(readFileSync(join(w.root, 'calibration', 'pairs.json'), 'utf8'), bytes, 'the set is never rewritten');
  assert.equal(ownerLog(), owner, 'owner files untouched');
  rmSync(dir, { recursive: true });
});

test('buildStep: a killed build resumes without repeating finished calls and builds the identical set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-calib-build-'));
  const whole = world(join(dir, 'a'));
  request(whole, 'C00', null, null);
  assert.equal(await run(harness(whole, 'C00')), 'done');
  const w = world(join(dir, 'b'));
  request(w, 'C00', null, null);
  let n = 0;
  const kill: RunHooks = { beforeCall: () => { n += 1; if (n > 20) throw new Error('killed'); } };
  const killed = harness(w, 'C00', GOOD_ROUTES, kill);
  await assert.rejects(buildStep.run(killed.ctx, null), /killed/u);
  assert.ok(!existsSync(join(w.root, 'calibration', 'pairs.json')), 'no set before every text exists');
  const resumed = harness(w, 'C00');
  assert.equal(await run(resumed), 'done');
  const first = calls(resumed);
  assert.ok(first.length > 0 && first.length <= 46 - 20, `${first.length} calls after the kill`);
  assert.deepEqual(first.filter((c) => calls(killed).includes(c)), [], 'no finished call is repeated');
  assert.deepEqual(value(readCalibSet(w.root, 'C00')).pairs, value(readCalibSet(whole.root, 'C00')).pairs, 'same seed → same set');
  rmSync(dir, { recursive: true });
});

/** Rewrites of C00-T02 answer with no json block (void) on the first plan, and on the re-plan too when `twice`. */
function voidT02(twice: boolean): Record<string, Route> {
  const bad = (id: string): boolean => id.startsWith('calibrewrite-C00-T02') && (twice || !id.endsWith('-2'));
  return { ...GOOD_ROUTES, calibrewrite: (prompt, n, meta) => (bad(meta.taskId) ? 'no json' : REWRITE(prompt, n, meta)) };
}

test('buildStep: a void pair is re-planned once on the next seeded passage (-2 task ids); a second void fails the build', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-calib-build-'));
  const w = world(join(dir, 'a'));
  request(w, 'C00', null, null);
  const h = harness(w, 'C00', voidT02(false));
  assert.equal(await run(h), 'done');
  const log = calls(h);
  assert.ok(['calibrewrite-C00-T02#1', 'calibrewrite-C00-T02#2', 'calibrewrite-C00-T02-2#1'].every((c) => log.includes(c)));
  const source = (id: string): string => unwrap(h.routers.flatMap((r) => r.log()).find((c) => c.taskId === id)?.prompt ?? '', '原文') ?? '';
  assert.notEqual(source('calibrewrite-C00-T02-2'), source('calibrewrite-C00-T02'), 'the re-plan uses another passage');
  assert.equal(value(readCalibSet(w.root, 'C00')).texts['C00-T02']?.call, 'calibrewrite-C00-T02-2');
  assert.equal(readFileSync(join(w.root, 'calibration', 'texts', 'C00-T01.md'), 'utf8'), source('calibrewrite-C00-T02-2'), 'the 8.1 text follows');
  const w2 = world(join(dir, 'b'));
  request(w2, 'C00', null, null);
  assert.match(await run(harness(w2, 'C00', voidT02(true))), /^failed: C00-T02 voided again after a re-plan/u);
  assert.ok(!existsSync(join(w2.root, 'calibration', 'pairs.json')));
  rmSync(dir, { recursive: true });
});

test('runSteps c1 for C00, then Q01 (unused passages, no dry-run) and G01 (C00 known-base copies only); sets only grow', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-calib-build-'));
  const w = world(dir);
  request(w, 'C00', null, null);
  const report = await runSteps(harness(w, 'C00').ctx, { pipeline: 'calibration', steps: [buildStep], until: null, from: null, redoFrom: null, pid: 7, isAlive: () => true });
  assert.equal(report.state, 'done', report.detail);
  assert.ok(existsSync(join(w.root, 'calibration', 'C00', 'markers', 'c1-build.json')));
  const c00Bytes = JSON.stringify(readCalibSet(w.root, 'C00'));
  request(w, 'Q01', 'OpenAI', 'calibration_fail');
  request(w, 'G01', 'xAI', null);
  const [q, g] = [harness(w, 'Q01'), harness(w, 'G01')];
  assert.deepEqual([await run(q), await run(g)], ['done', 'done']);
  const { C00: c00, Q01: q01, G01: g01 } = value(readCalibPairs(w.root)).sets;
  assert.ok(c00 !== undefined && q01 !== undefined && g01 !== undefined);
  assert.equal(JSON.stringify(readCalibSet(w.root, 'C00')), c00Bytes, 'C00 unchanged');
  assert.deepEqual([q01.family, q01.reason, q01.size, q01.dryrun.length], ['OpenAI', 'calibration_fail', 12, 0]);
  assert.deepEqual(count(q01.pairs, (p) => `${p.category}/${p.split}`), { 'cross_model/none': 5, 'stance/none': 4, 'known/none': 3 });
  const sources = (s: typeof c00): string[] => Object.values(s.texts).flatMap((t) => (t.source === null ? [] : [t.source.quote_sha256]));
  assert.ok(sources(q01).every((h) => !sources(c00).includes(h)), 'requal passages are unused');
  assert.equal(new Set(calls(q)).size, 24);
  assert.deepEqual([g01.size, g01.pairs.length, Object.keys(g01.texts), calls(g).length], [0, 0, ['G01-T01', 'G01-T02', 'G01-T03', 'G01-T04'], 4]);
  assert.ok(g01.dryrun.every((d) => c00.pairs.some((p) => p.known_better === d.base) && g01.texts[d.copy]?.of === d.base));
  const pairsPath = join(w.root, 'calibration', 'pairs.json');
  writeFileSync(pairsPath, readFileSync(pairsPath, 'utf8').replace('"split": "visible"', '"split": "reserve"'));
  await assert.rejects(run(harness(w, 'C00')), /set C00 does not match calibration\/C00\/pairs\.sha256/u);
  rmSync(join(w.root, 'calibration', 'C00', 'pairs.sha256'));
  await assert.rejects(run(harness(w, 'C00')), /set C00 differs from what c1 rebuilds; a set is never rewritten/u);
  rmSync(dir, { recursive: true });
});

test('selectPassages on the real 8.1 canon with the fixture build.json: C00 (24 + spares) and a later Q set (12) both fit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-calib-build-'));
  const w = fixtureWorld(dir, DEFAULT_FIXTURE);
  const cfg = value(parseBuildConfig(JSON.parse(readFileSync(join(w.root, 'calibration', 'build.json'), 'utf8')), PREFIXES, JUDGES));
  rmSync(dir, { recursive: true });
  const canon = canonFiles(join(REAL_ROOT, '..', '..'));
  const round0 = CAL.categories.length * CAL.pairsPerCategory;
  const requal = CAL.requal.nonknown + CAL.requal.known;
  const c00 = value(selectPassages(canon, cfg, new Set(), round0 + 2, 'real-seed'));
  const q01 = value(selectPassages(canon, cfg, new Set(c00.slice(0, round0).map((p) => p.sha256)), requal, 'real-seed-q'));
  const all = [...c00.slice(0, round0), ...q01];
  assert.equal(new Set(all.map((p) => p.sha256)).size, round0 + requal);
  for (const p of all) {
    const chars = charCount(p.text);
    assert.ok(chars >= cfg.passageChars[0] && chars <= cfg.passageChars[1], `${p.id}: ${chars}`);
    assert.ok(canon[p.file]?.includes(p.text), `${p.id}: verbatim`);
    assert.ok(!p.text.split('\n').some((line) => /^\s*(?:#|\||>)/u.test(line)), `${p.id}: prose only`);
  }
  const blocks = all.flatMap((p) => p.text.split(/\n[ \t]*\n/u).map((b) => `${p.file}\n${b.trim()}`));
  assert.equal(new Set(blocks).size, blocks.length, 'no paragraph is in two passages');
});

test('buildStep: a failed build (second void) moves its void and re-plan task records to tasks/stale/<n>/; the same request then retries and finishes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-calib-build-'));
  const clean = world(join(dir, 'a'));
  request(clean, 'C00', null, null);
  assert.equal(await run(harness(clean, 'C00')), 'done');
  const w = world(join(dir, 'b'));
  request(w, 'C00', null, null);
  const failedRun = await run(harness(w, 'C00', voidT02(true)));
  assert.match(failedRun, /^failed: C00-T02 voided again after a re-plan.*tasks\/stale\/1\//u);
  const tasks = join(w.root, 'calibration', 'C00', 'tasks');
  for (const id of ['calibrewrite-C00-T02', 'calibrewrite-C00-T02-2']) {
    assert.ok(!existsSync(join(tasks, `${id}.json`)) && existsSync(join(tasks, 'stale', '1', `${id}.json`)), id);
    assert.ok(existsSync(join(w.root, 'calibration', 'C00', 'calls', 'stale', '1', `${id}-a1.json`)), `${id} calls`);
  }
  assert.ok(existsSync(join(tasks, 'calibrewrite-C00-T04.json')), 'finished first-attempt records stay');
  const retry = harness(w, 'C00');
  assert.equal(await run(retry), 'done');
  const rewrites = calls(retry).filter((c) => c.startsWith('calibrewrite-'));
  assert.deepEqual(rewrites, ['calibrewrite-C00-T02#1'], 'only the voided text is called again');
  assert.deepEqual(value(readCalibSet(w.root, 'C00')), value(readCalibSet(clean.root, 'C00')), 'the same set as a build that never voided');
  rmSync(dir, { recursive: true });
});

test('parseCalibPairs: authors, known_better and display coverage must match the texts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-calib-build-'));
  const w = world(dir);
  request(w, 'C00', null, null);
  assert.equal(await run(harness(w, 'C00')), 'done');
  const raw = (): { schema: string; sets: Record<string, Record<string, unknown>> } => JSON.parse(readFileSync(join(w.root, 'calibration', 'pairs.json'), 'utf8'));
  assert.equal(parseCalibPairs(raw()).ok, true);
  const set = value(readCalibSet(w.root, 'C00'));
  const cvr = set.pairs.findIndex((p) => p.category === 'canon_vs_rewrite');
  const known = set.pairs.findIndex((p) => p.category === 'known');
  const edits: Array<[(pairs: Array<Record<string, unknown>>, display: Array<Record<string, unknown>>) => void, RegExp]> = [
    [(pairs) => { pairs[cvr] = { ...pairs[cvr], authors: ['DeepSeek'] }; }, /authors must be the author families of a and b/u],
    [(pairs) => { const p = set.pairs[known]; pairs[known] = { ...pairs[known], known_better: p?.b }; }, /known_better must be the rewrite a degraded copy was made of/u],
    [(_pairs, display) => { display[0] = { ...display[0], pair: display[1]?.['pair'], left: display[1]?.['left'], right: display[1]?.['right'] }; }, /every pair exactly once/u],
  ];
  for (const [edit, pattern] of edits) {
    const file = raw();
    const c00 = file.sets['C00'];
    assert.ok(c00 !== undefined && Array.isArray(c00['pairs']) && Array.isArray(c00['display']));
    edit(c00['pairs'], c00['display']);
    refuses(parseCalibPairs(file), pattern);
  }
  rmSync(dir, { recursive: true });
});

test('c1 pins its set: <set>/pairs.sha256 is a marker output and any later edit of sets[set] is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-calib-build-'));
  const w = world(dir);
  request(w, 'C00', null, null);
  const report = await runSteps(harness(w, 'C00').ctx, { pipeline: 'calibration', steps: [buildStep], until: null, from: null, redoFrom: null, pid: 7, isAlive: () => true });
  assert.equal(report.state, 'done', report.detail);
  const marker = readFileSync(join(w.root, 'calibration', 'C00', 'markers', 'c1-build.json'), 'utf8');
  assert.ok(marker.includes('calibration/C00/pairs.sha256'), 'the pin is a c1 output');
  const pairsPath = join(w.root, 'calibration', 'pairs.json');
  const bytes = readFileSync(pairsPath, 'utf8');
  writeFileSync(pairsPath, bytes.replace('"split": "visible"', '"split": "reserve"'));
  refuses(readCalibSet(w.root, 'C00'), /C00 does not match calibration\/C00\/pairs\.sha256/u);
  refuses(readCalibPairs(w.root), /pairs\.sha256/u);
  writeFileSync(pairsPath, JSON.stringify({ schema: 'calib-pairs/1', sets: {} }));
  refuses(readCalibPairs(w.root), /has no set C00 but calibration\/C00\/pairs\.sha256 pins one/u);
  writeFileSync(pairsPath, bytes);
  assert.equal(readCalibSet(w.root, 'C00').ok, true);
  rmSync(dir, { recursive: true });
});
