import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FakeReply } from '../adapters/fake.ts';
import type { Champion } from '../champions.ts';
import { loadConfig, type Family } from '../config.ts';
import { buildContext, type RoundBackends, type StepContext } from '../context.ts';
import { buildFreeze } from '../freeze.ts';
import { sha256Bytes, writeMarker } from '../marker.ts';
import { effectiveFamilies, pairsFilePath, pairVerdicts, readPairsFile } from '../pairs.ts';
import type { FreezeFlag } from '../freeze.ts';
import { loadSchema, validate } from '../schema.ts';
import { roundPaths, sha256 } from '../store.ts';
import { buildRoundTally, type ChampionPairResult } from '../tally.ts';
import { IntegrityError } from '../task.ts';
import { unwrap } from '../tasks/fenced.ts';
import { fakePorts } from '../testing/fakes.ts';
import { DEFAULT_FIXTURE, FIXTURE_AT, FIXTURE_CHAMPION_TEXT, fixtureWorld, type FixtureWorld } from '../testing/fixture-world.ts';
import { callLog, fakeRouter, type FakeCallMeta, type FakeRouter, type Route } from '../testing/scripted.ts';
import { DEFAULT_STANCES, type BriefJson } from './brief.ts';
import { auxPairsStep, championPairsStep, decoyStep, readDecoyAttempts, readDecoySubmission, runAuxPairs, runChampionPairs } from './taste.ts';

const FAMILIES: readonly Family[] = ['Anthropic', 'Moonshot', 'OpenAI', 'xAI'];
const JUDGE_IDS: Readonly<Record<string, string>> = { Anthropic: 'claude', Moonshot: 'kimi', OpenAI: 'codex', xAI: 'grok' };
const W1_BODY = '林澈把冷凝管的滤网拆下来，对着灯看了很久，上面结着一层细盐。他把盐刮进小罐，贴上当班的编号。';
const W2_BODY = '温芮在培养架前数菌毯，数到第七卷时停下，把一张旧配给票夹进记录簿里。';
const GOOD_DECOY = ['```json', JSON.stringify({ replacements: [{ original: '扳手', generic: '工具', kind: '物件' }, { original: '循环泵', generic: '机器', kind: '物件' }] }), '```'].join('\n');

/** What a judge does on one taste call: prefer the submission / left text, prefer the decoy, or void. */
type Behaviour = 'normal' | 'decoy' | 'void';

function writerText(body: string): string {
  return ['```submission', body, '```', '```delta', '{"new_proper_nouns":[],"claims":[]}', '```', '```interface', '{"shots":[{},{},{}],"object":{"n":1},"hook":{"h":1}}', '```', '种子：', '- 一'].join('\n');
}

function head(text: string): string {
  return [...text].slice(0, 12).join('');
}

/** Scripted taste judge: picks the non-champion text (aux: text 1) on every question; avoids the decoy unless told. */
function tasteRoute(behave: (meta: FakeCallMeta) => Behaviour): Route {
  return (prompt: string, _n: number, meta: FakeCallMeta): FakeReply => {
    const how = behave(meta);
    if (how === 'void') return '我拒绝回答。';
    const t1 = unwrap(prompt, '文本甲') ?? '';
    const t2 = unwrap(prompt, '文本乙') ?? '';
    const pick = t1 === FIXTURE_CHAMPION_TEXT ? 2 : 1;
    const chosen = pick === 1 ? t1 : t2;
    const answers = { q1: { pick, quote: head(chosen) }, q2: { pick, quote: head(chosen) } };
    const t3 = unwrap(prompt, '文本丙');
    const t4 = unwrap(prompt, '文本丁');
    if (t3 === null || t4 === null) return ['```json', JSON.stringify({ answers }), '```'].join('\n');
    const decoyAt = t3 === FIXTURE_CHAMPION_TEXT ? 4 : 3;
    const decoyPick = how === 'decoy' ? decoyAt : decoyAt === 3 ? 4 : 3;
    const decoy = { pick: decoyPick, quote: head(decoyPick === 3 ? t3 : t4) };
    return ['```json', JSON.stringify({ answers, decoy }), '```'].join('\n');
  };
}

interface H {
  dir: string;
  w: FixtureWorld;
  ctx: StepContext;
  judges: Map<Family, FakeRouter>;
  decoy: FakeRouter;
}

interface Setup {
  behave?: (family: Family, meta: FakeCallMeta) => Behaviour;
  decoy?: Route;
  flags?: Partial<Record<Family, FreezeFlag>>;
  championPin?: string;
  benchmark?: { path: string; version: string };
}

function harness(setup: Setup = {}): H {
  const dir = mkdtempSync(join(tmpdir(), 'forge-taste-'));
  const w = fixtureWorld(dir, DEFAULT_FIXTURE);
  const config = loadConfig(w.root, { requireLocal: true });
  if (!config.ok) throw new Error(config.error);
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: '2026-10-02T00:00:00.000Z', seed: 'taste-seed' });
  const behave = setup.behave ?? ((): Behaviour => 'normal');
  const judges = new Map<Family, FakeRouter>();
  for (const family of FAMILIES) {
    judges.set(family, fakeRouter({ taste: tasteRoute((meta) => behave(family, meta)) }, { id: JUDGE_IDS[family] ?? family, family, model: `${family}-model` }));
  }
  const decoy = fakeRouter({ decoy: setup.decoy ?? ((): FakeReply => GOOD_DECOY) }, { id: 'decoy', family: 'DeepSeek', model: 'deepseek-fixture' });
  const backends: RoundBackends = {
    writers: [], baseline: decoy, decoy, defect: decoy, judges: [...judges.values()].map((backend) => ({ backend, concurrency: 3 })),
    forecasters: [], maintainer: decoy, mergeEditor: decoy, calibGateway: new Map(),
  };
  const built = buildContext({
    root: w.root, repo: w.repo, roundId: 'R01', pipeline: 'round', paths: roundPaths(w.root, 'R01'), config: config.value,
    deps: { ports, backends: () => backends, env: {}, pid: 7, isAlive: () => true, log: () => undefined },
    startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
  });
  if (!built.ok) throw new Error(built.error);
  const h: H = { dir, w, ctx: built.value, judges, decoy };
  prepare(h, setup);
  return h;
}

function brief(): BriefJson {
  return {
    round: 'R01', kind: 'round', row_id: 'SHIP', layer: '物件', topic_source: 'fixed',
    cell: { id: 'C', row_id: 'SHIP', title: '母舰 · 邻里常态日', entity: '母舰', time: 't', layers: ['物件'], setting_notes: [], protagonists: ['温芮'], forbidden: [], stances: [...DEFAULT_STANCES] },
    canon: { revision: '8.1', book_sha256: 'b'.repeat(64), reference_sha256: 'c'.repeat(64) },
    canon_passages: [], facts: [], regression: [], regression_stale: [], forbidden: [], cliches: [], requirements: [], interface_requirements: [], aliases: [],
    seed: 'seed-taste', created_at: '2026-10-01T00:00:00.000Z',
  };
}

/** brief.json, freeze.json (champion + benchmark pinned, family flags), the 02c marker and two passing submissions. */
function prepare(h: H, setup: Setup): void {
  const ctx = h.ctx;
  mkdirSync(ctx.paths.submissions, { recursive: true });
  writeFileSync(ctx.paths.brief, `${JSON.stringify(brief(), null, 2)}\n`);
  const bench = setup.benchmark ?? { path: 'benchmark/v1.json', version: 'v1' };
  const flags: Record<string, FreezeFlag> = {};
  for (const f of FAMILIES) flags[f] = setup.flags?.[f] ?? 'ok';
  const freeze = buildFreeze({
    round: 'R01', files: { champion: setup.championPin ?? FIXTURE_CHAMPION_TEXT }, benchmarkVersion: bench.version,
    eligibleFamilies: FAMILIES.filter((f) => flags[f] === 'ok'), flags, protocolBundleSha256: ctx.bundleSha256, probeCreatedAt: '2026-10-01T00:05:00Z',
    seed: 'seed-taste', gateFamilies: [...FAMILIES],
    benchmarkResolution: { version: bench.version, sha256: sha256Bytes(readFileSync(join(h.w.root, bench.path))), path: bench.path, via: 'activate', since: FIXTURE_AT },
  });
  writeFileSync(ctx.paths.freeze, `${JSON.stringify(freeze, null, 2)}\n`);
  writeMarker(ctx.files, join(ctx.paths.markers, '02c-freeze.json'), {
    v: 1, round: 'R01', step: '02c-freeze', completed_at: '2026-10-01T00:00:00.000Z', result: 'done', skipped: null,
    inputs: {}, outputs: {}, external: {}, local: {}, tasks: { ok: 0, void: 0, calls: 0 }, prev: null,
  });
  for (const [slot, body] of [['W1', W1_BODY], ['W2', W2_BODY]]) {
    writeFileSync(join(ctx.paths.submissions, `${slot}.json`), JSON.stringify({ id: slot, kind: 'writer', model: 'deepseek-fixture', family: 'DeepSeek', stance: 's', ok: true, error: null, text: writerText(body ?? '') }));
  }
}

function tasteIds(h: H, family: Family, prefix: string): string[] {
  return (h.judges.get(family)?.log() ?? []).filter((c) => c.taskId.startsWith(prefix) && c.attempt === 1).map((c) => c.taskId).sort();
}

function allCalls(h: H): string[] {
  return [...h.judges.values()].flatMap(callLog).sort();
}

/** The pair as 08 tallies it: buildRoundTally over the stored verdicts (void drops, decoy preference, shadow). */
function tallied(h: H, pair: string): ChampionPairResult | undefined {
  const t = buildRoundTally({
    round: 'R01', benchmark: 'v1', champion: 'owner_pick', sessionPairs: 2, barFourFamilies: 7, labels: { [pair]: 'A' },
    championPairs: [{ pair, submission: pair, sessions: pairVerdicts(h.w.root, 'R01', pair) }], auxPairs: [], gate: {}, measures: {},
    voids: { calls: 0, void_tasks: 0, retried_tasks: 0, session_reruns: 0, dropped_families: 0 },
  });
  return t.champion_pairs[0];
}

function cleanup(h: H): void {
  rmSync(h.dir, { recursive: true });
}

test('06a writes champion.json, decoy.json and submissions/DECOY.json from the engine-applied map', async () => {
  const h = harness();
  const out = await decoyStep.run(h.ctx, null);
  assert.deepEqual(out, {
    kind: 'done', inputs: ['rounds/R01/brief.json', 'rounds/R01/freeze.json'],
    outputs: ['rounds/R01/champion.json', 'rounds/R01/decoy.json', 'rounds/R01/submissions/DECOY.json'], external: [],
  });
  assert.deepEqual(callLog(h.decoy), ['decoy-DECOY#1']);
  const expected = FIXTURE_CHAMPION_TEXT.replace('扳手', '工具').replace('循环泵', '机器');
  const sub = readDecoySubmission(h.ctx.paths);
  assert.deepEqual(sub.ok ? [sub.value.text, sub.value.family, sub.value.champion_sha256, sub.value.recipe_version] : sub, [expected, 'DeepSeek', sha256(FIXTURE_CHAMPION_TEXT), 'v1']);
  const file: unknown = JSON.parse(readFileSync(join(h.ctx.paths.dir, 'decoy.json'), 'utf8'));
  assert.deepEqual(file, {
    round: 'R01', task: 'decoy-DECOY', champion_sha256: sha256(FIXTURE_CHAMPION_TEXT), recipe_version: 'v1', text_sha256: sha256(expected),
    replacements: [{ original: '扳手', generic: '工具', kind: '物件' }, { original: '循环泵', generic: '机器', kind: '物件' }],
  });
  const snap: unknown = JSON.parse(readFileSync(join(h.ctx.paths.dir, 'champion.json'), 'utf8'));
  assert.equal(typeof snap === 'object' && snap !== null && 'text' in snap ? snap.text : null, FIXTURE_CHAMPION_TEXT);
  const prompt = h.decoy.log()[0]?.prompt ?? '';
  assert.equal(unwrap(prompt, '文本甲'), FIXTURE_CHAMPION_TEXT);
  cleanup(h);
});

test('06a: a void decoy fails the step, keeps its attempt, and the rerun calls afresh as decoy-DECOY-t2', async () => {
  const h = harness({ decoy: (_p, _n, meta) => (meta.taskId === 'decoy-DECOY' ? '替换表如下：扳手→工具' : GOOD_DECOY) });
  const first = await decoyStep.run(h.ctx, null);
  assert.equal(first.kind, 'failed');
  if (first.kind === 'failed') assert.match(first.detail, /^decoy_missing: decoy-DECOY is void \(.+\); a rerun calls afresh as decoy-DECOY-t2$/u);
  assert.deepEqual(readDecoyAttempts(h.ctx).map((a) => a.task), ['decoy-DECOY']);
  assert.equal(readDecoySubmission(h.ctx.paths).ok, false, 'no decoy without a valid map');
  const second = await decoyStep.run(h.ctx, null);
  assert.equal(second.kind, 'done');
  assert.deepEqual(callLog(h.decoy), ['decoy-DECOY#1', 'decoy-DECOY#2', 'decoy-DECOY-t2#1']);
  const third = await decoyStep.run(h.ctx, null);
  assert.equal(third.kind, 'done', 'a crash before the marker reruns from the task record');
  assert.equal(callLog(h.decoy).length, 3);
  cleanup(h);
});

test('06a: no decoy_recipe → failed without a call; a champion that drifted from the freeze pin → IntegrityError', async () => {
  const h = harness();
  const v1: unknown = JSON.parse(readFileSync(join(h.w.root, 'benchmark/v1.json'), 'utf8'));
  const v2 = typeof v1 === 'object' && v1 !== null ? Object.fromEntries(Object.entries(v1).filter(([k]) => k !== 'decoy_recipe').map(([k, v]) => [k, k === 'version' ? 'v2' : v])) : {};
  writeFileSync(join(h.w.root, 'benchmark/v2.json'), JSON.stringify(v2));
  prepare(h, { benchmark: { path: 'benchmark/v2.json', version: 'v2' } });
  const out = await decoyStep.run(h.ctx, null);
  assert.deepEqual(out, { kind: 'failed', detail: 'decoy_missing: benchmark v2 has no decoy_recipe' });
  assert.deepEqual(callLog(h.decoy), []);
  cleanup(h);
  const drift = harness({ championPin: '另一篇擂主。' });
  await assert.rejects(decoyStep.run(drift.ctx, null), (e: unknown) => e instanceof IntegrityError && /changed since 02c-freeze pinned it/u.test(e.message));
  cleanup(drift);
});

test('06b: a family preferring the decoy in both calls of s1 and in the rerun drops out of E for that pair (|E| 4 → 3, bar 6/6)', async () => {
  const h = harness({ behave: (family, meta) => (family === 'xAI' && /^taste-W1-xAI-s1r?-/u.test(meta.taskId) ? 'decoy' : 'normal') });
  assert.equal((await decoyStep.run(h.ctx, null)).kind, 'done');
  const out = await runChampionPairs(h.ctx, ['W1', 'W2']);
  assert.equal(out.kind, 'done');
  assert.deepEqual(tasteIds(h, 'xAI', 'taste-W1-'), ['taste-W1-xAI-s0-fwd', 'taste-W1-xAI-s0-rev', 'taste-W1-xAI-s1-fwd', 'taste-W1-xAI-s1-rev', 'taste-W1-xAI-s1r-fwd', 'taste-W1-xAI-s1r-rev']);
  for (const f of FAMILIES) {
    assert.deepEqual(tasteIds(h, f, 'taste-W2-'), [`taste-W2-${f}-s0-fwd`, `taste-W2-${f}-s0-rev`, `taste-W2-${f}-s1-fwd`, `taste-W2-${f}-s1-rev`]);
    if (f !== 'xAI') assert.equal(tasteIds(h, f, 'taste-W1-').length, 4);
  }
  const prompts = [...h.judges.values()].flatMap((j) => j.log().map((c) => c.prompt));
  assert.ok(prompts.every((p) => unwrap(p, '文本丙') !== null && unwrap(p, '文本丁') !== null), 'every champion-pair call carries the decoy pair');
  const pairs = readPairsFile(h.ctx.paths, 'champion');
  assert.ok(pairs.ok);
  if (!pairs.ok) return;
  const w1 = pairs.value.pairs.find((p) => p.id === 'W1');
  assert.deepEqual(w1 === undefined ? null : [w1.families, w1.effective, w1.dropped, w1.shadow], [[...FAMILIES], ['Anthropic', 'Moonshot', 'OpenAI'], ['xAI'], []]);
  assert.deepEqual(Object.keys(pairs.value.texts).sort(), ['BASE', 'DECOY', 'W1', 'W2']);
  assert.deepEqual(pairs.value.texts['DECOY']?.authors, ['DeepSeek']);
  const schema = loadSchema(JSON.parse(readFileSync(new URL('../../schema/pairs.schema.json', import.meta.url), 'utf8')));
  assert.ok(schema.ok && validate(schema.value, JSON.parse(readFileSync(join(h.ctx.paths.dir, 'pairs.json'), 'utf8'))).length === 0);
  const sessions = pairVerdicts(h.w.root, 'R01', 'W1');
  const xai = sessions.find((s) => s.family === 'xAI');
  assert.deepEqual(xai === undefined ? null : [xai.dropped, xai.reruns, xai.sessions.length], ['void_after_rerun', [1], 2]);
  assert.ok(sessions.filter((s) => s.family !== 'xAI').every((s) => s.sessions.length === 2 && s.reruns.length === 0 && s.dropped === null));
  assert.deepEqual(effectiveFamilies(sessions), ['Anthropic', 'Moonshot', 'OpenAI']);
  const tally = tallied(h, 'W1');
  assert.deepEqual(tally === undefined ? null : [tally.e, tally.dropped, tally.needed, tally.total_wins, tally.bar, tally.beats_champion], [['Anthropic', 'Moonshot', 'OpenAI'], ['xAI'], 6, 6, '6/6', true]);
  const w2 = tallied(h, 'W2');
  assert.deepEqual(w2 === undefined ? null : [w2.e.length, w2.needed, w2.bar], [4, 7, '7/8']);
  const before = allCalls(h);
  const bytes = readFileSync(join(h.ctx.paths.dir, 'pairs.json'), 'utf8');
  assert.deepEqual(await runChampionPairs(h.ctx, ['W1', 'W2']), out, 'a rerun after a crash reuses every task record');
  assert.deepEqual(allCalls(h), before);
  assert.equal(readFileSync(join(h.ctx.paths.dir, 'pairs.json'), 'utf8'), bytes);
  cleanup(h);
});

test('06b: flagged families judge champion pairs as shadow (same schedule, reruns included) and never count', async () => {
  const h = harness({ flags: { xAI: 'flagged' }, behave: (family, meta) => (family === 'xAI' && meta.taskId.includes('-s0') ? 'void' : 'normal') });
  assert.equal((await decoyStep.run(h.ctx, null)).kind, 'done');
  await runChampionPairs(h.ctx, ['W1']);
  assert.deepEqual(tasteIds(h, 'xAI', 'taste-W1-'), ['taste-W1-xAI-s0-fwd', 'taste-W1-xAI-s0-rev', 'taste-W1-xAI-s0r-fwd', 'taste-W1-xAI-s0r-rev', 'taste-W1-xAI-s1-fwd', 'taste-W1-xAI-s1-rev']);
  const pairs = readPairsFile(h.ctx.paths, 'champion');
  const w1 = pairs.ok ? pairs.value.pairs[0] : undefined;
  assert.deepEqual(w1 === undefined ? null : [w1.families, w1.shadow, w1.effective, w1.dropped], [['Anthropic', 'Moonshot', 'OpenAI'], ['xAI'], ['Anthropic', 'Moonshot', 'OpenAI'], []]);
  const sessions = pairVerdicts(h.w.root, 'R01', 'W1');
  const xai = sessions.find((s) => s.family === 'xAI');
  assert.deepEqual(xai === undefined ? null : [xai.shadow, xai.dropped], [true, 'void_after_rerun']);
  assert.deepEqual(effectiveFamilies(sessions), ['Anthropic', 'Moonshot', 'OpenAI']);
  const tally = tallied(h, 'W1');
  assert.deepEqual(tally === undefined ? null : [tally.e.length, tally.shadow, tally.needed, tally.total_wins], [3, ['xAI'], 6, 6]);
  const aux = await runAuxPairs(h.ctx, ['W1', 'W2']);
  assert.equal(aux.kind, 'done');
  assert.deepEqual(tasteIds(h, 'xAI', 'taste-W1.W2-'), [], 'flagged families never judge aux pairs');
  cleanup(h);
});

const ANCHOR_BODY = '邻里的公共炉子熄了一夜，早上第一个来的人把自己的暖手炉借给了值班员。';

/** champion.json with one previous owner pick (P00/W3) whose submission file exists, so AN1 is judged. */
function withAnchor(h: H): void {
  const anchorPaths = roundPaths(h.w.root, 'P00');
  mkdirSync(anchorPaths.submissions, { recursive: true });
  writeFileSync(join(anchorPaths.submissions, 'W3.json'), JSON.stringify({ id: 'W3', kind: 'writer', model: 'm', family: 'DeepSeek', stance: 's', ok: true, error: null, text: writerText(ANCHOR_BODY) }));
  const champion: Champion = {
    row_id: 'SHIP', kind: 'owner_pick', round: 'P00', submission: 'W1', family: 'DeepSeek', authors: ['DeepSeek'], text: FIXTURE_CHAMPION_TEXT,
    text_sha256: sha256(FIXTURE_CHAMPION_TEXT), set_at: FIXTURE_AT,
    previous: [
      { kind: 'baseline', round: 'P00', submission: 'BASE', family: 'DeepSeek', text_sha256: 'e'.repeat(64) },
      { kind: 'owner_pick', round: 'P00', submission: 'W3', family: 'DeepSeek', text_sha256: sha256(ANCHOR_BODY) },
    ],
  };
  writeFileSync(join(h.ctx.paths.dir, 'champion.json'), JSON.stringify(champion));
}

test('06c: sub–sub and anchor pairs use 2 seeded families × 1 call per order, no decoy, and never rerun', async () => {
  const h = harness({ behave: (_family, meta) => (meta.taskId.startsWith('taste-W1.AN1-') || (meta.taskId.startsWith('taste-W1.W2-') && meta.taskId.endsWith('-rev')) ? 'void' : 'normal') });
  withAnchor(h);
  const out = await runAuxPairs(h.ctx, ['W1', 'W2']);
  assert.equal(out.kind, 'done');
  const calls = allCalls(h);
  assert.equal(calls.filter((c) => c.endsWith('#1')).length, 3 * 2 * 2, '3 aux pairs × 2 families × 2 orders');
  assert.ok(calls.every((c) => /^taste-(W1\.W2|W1\.AN1|W2\.AN1)-[A-Za-z]+-s0-(fwd|rev)#[12]$/u.test(c)), 'session 0 only, no s<k>r rerun ids');
  const prompts = [...h.judges.values()].flatMap((j) => j.log().map((c) => c.prompt));
  assert.ok(prompts.every((p) => unwrap(p, '文本丙') === null && !p.includes('另有一组对照')), 'aux calls carry no decoy pair');
  const aux = readPairsFile(h.ctx.paths, 'aux');
  assert.ok(aux.ok);
  if (!aux.ok) return;
  assert.deepEqual(aux.value.pairs.map((p) => [p.id, p.kind, p.left, p.right, p.families.length, p.shadow]), [
    ['W1.W2', 'sub_sub', 'W1', 'W2', 2, []], ['W1.AN1', 'anchor', 'W1', 'AN1', 2, []], ['W2.AN1', 'anchor', 'W2', 'AN1', 2, []],
  ]);
  assert.deepEqual(aux.value.texts['AN1'], { id: 'AN1', kind: 'anchor', file: 'rounds/P00/submissions/W3.json', sha256: sha256(ANCHOR_BODY), authors: ['DeepSeek'] });
  const an = aux.value.pairs.find((p) => p.id === 'W1.AN1');
  assert.deepEqual(an === undefined ? null : [an.effective, an.dropped.length], [[], 2], 'a family with no valid call is simply missing');
  const subSub = pairVerdicts(h.w.root, 'R01', 'W1.W2');
  assert.equal(subSub.length, 2);
  assert.ok(subSub.every((f) => f.sessions.length === 1 && f.reruns.length === 0 && f.dropped === null && f.sessions[0]?.[1]?.status === 'void'));
  assert.ok(pairVerdicts(h.w.root, 'R01', 'W2.AN1').every((f) => f.sessions[0]?.[0]?.decisive === 'W2'));
  cleanup(h);
});

test('06c: skip when there is no aux pair; a tampered anchor file is an integrity error', async () => {
  const h = harness();
  assert.equal((await decoyStep.run(h.ctx, null)).kind, 'done');
  const stale = [pairsFilePath(h.ctx.paths, 'aux'), join(h.ctx.paths.taste, 'aux', 'W1.W2', 'xAI-s0-fwd.json')];
  for (const p of stale) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '{}\n');
  }
  const out = await runAuxPairs(h.ctx, ['W1']);
  assert.deepEqual(out, { kind: 'skip', reason: 'no aux pair (1 passing submission(s), no anchor)' });
  assert.deepEqual(allCalls(h), []);
  for (const p of stale) assert.ok(!existsSync(p), `stale aux output removed: ${p}`);
  withAnchor(h);
  const anchor = join(roundPaths(h.w.root, 'P00').submissions, 'W3.json');
  writeFileSync(anchor, readFileSync(anchor, 'utf8').replace('暖手炉', '手炉'));
  await assert.rejects(runAuxPairs(h.ctx, ['W1']), (e: unknown) => e instanceof IntegrityError && /anchor AN1: .* does not match the champion record/u.test(e.message));
  cleanup(h);
});

test('06b / 06c StepDefs judge exactly passingSubmissions (gate pass or split enters taste, a missing slot does not)', async () => {
  const h = harness();
  mkdirSync(h.ctx.paths.gate, { recursive: true });
  const entry = (status: 'pass' | 'missing'): Record<string, unknown> => ({ status, pass: status === 'pass', checks: [], error: status === 'pass' ? null : 'no submission file' });
  writeFileSync(join(h.ctx.paths.gate, 'mechanical.json'), JSON.stringify({ round: 'R01', submissions: { W1: entry('pass'), W2: entry('pass'), W3: entry('missing') } }));
  writeFileSync(join(h.ctx.paths.gate, 'llm.json'), JSON.stringify({
    round: 'R01', defect_submission: null, defect_status: 'none', voided_families: [], unverified: [],
    submissions: { W1: { outcome: 'pass', defect_unverified: false }, W2: { outcome: 'split', defect_unverified: false } },
  }));
  assert.equal((await decoyStep.run(h.ctx, null)).kind, 'done');
  const champion = await championPairsStep.run(h.ctx, null);
  assert.equal(champion.kind, 'done');
  if (champion.kind === 'done') {
    assert.deepEqual(champion.inputs, ['rounds/R01/champion.json', 'rounds/R01/decoy.json', 'rounds/R01/submissions/DECOY.json', 'rounds/R01/submissions/W1.json', 'rounds/R01/submissions/W2.json']);
    assert.equal(champion.outputs.length, 2 * 4 * 2 * 2 + 1, '2 pairs × 4 families × 2 sessions × 2 orders + pairs.json');
    assert.equal(champion.external.length, 0);
  }
  const pairs = readPairsFile(h.ctx.paths, 'champion');
  assert.deepEqual(pairs.ok ? pairs.value.pairs.map((p) => p.id) : pairs, ['W1', 'W2']);
  const aux = await auxPairsStep.run(h.ctx, null);
  assert.equal(aux.kind, 'done');
  if (aux.kind === 'done') assert.deepEqual(aux.outputs.filter((o) => o.endsWith('pairs.json')), ['rounds/R01/taste/aux/pairs.json']);
  cleanup(h);
});
