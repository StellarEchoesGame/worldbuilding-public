import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FakeReply } from '../adapters/fake.ts';
import type { Family } from '../config.ts';
import { loadConfig } from '../config.ts';
import { buildContext, type RoundBackends, type StepContext } from '../context.ts';
import { buildFreeze } from '../freeze.ts';
import { isRecord } from '../json.ts';
import { sha256Bytes, writeMarker } from '../marker.ts';
import { loadSchema, validate, type Schema } from '../schema.ts';
import { roundPaths } from '../store.ts';
import { gateRoles } from '../tasks/assign.ts';
import { pickDefectSubmission, pickDefectType } from '../tasks/defect.ts';
import { unwrap } from '../tasks/fenced.ts';
import { writerTask } from '../tasks/writing.ts';
import { fakePorts } from '../testing/fakes.ts';
import { DEFAULT_FIXTURE, FIXTURE_AT, fixtureWorld } from '../testing/fixture-world.ts';
import { callLog, fakeRouter, type FakeRouter, type Route } from '../testing/scripted.ts';
import { splitSentences } from '../text.ts';
import type { BriefJson, FactRow } from './brief.ts';
import { defectStep, readDefectFile } from './defect.ts';
import { gateMechStep } from './gate-mech.ts';
import { gateLlmStep, judgedFlags, passingSubmissions, resubmitStep } from './gate-llm.ts';

const FAMS: Family[] = ['Anthropic', 'Moonshot', 'OpenAI', 'xAI'];
const STANCE = 'object-history';
const F01: FactRow = { id: 'F01', kind: 'fact', text: '没有星门，也没有即时跨星通信。', status: '共同事实', rows: ['ALL'] };
const F14: FactRow = { id: 'F14', kind: 'fact', text: '更名后的810人为指定接应实例。', status: '状态与路径实例', rows: ['ALL'] };
const RXX: FactRow = { id: 'R00-01', kind: 'registered', text: '邻里共用工具柜不上锁，借用写在柜门内侧的借用签上', status: '状态与路径实例', rows: ['SHIP'] };
const REVERSAL = '邻里的共用工具柜一向上锁，借东西得先找值班员申领钥匙。';
/** Judge traps: a sentence holding the phrase is a contradiction against the id (only when the pack offers the id). */
const TRAPS: ReadonlyArray<readonly [string, string]> = [['星门', 'F01'], ['回信当晚就到', 'F01'], ['一向上锁', 'R00-01'], ['第三方', 'X01']];
/** The default brief forbidden moves: one D3 target (X01). */
const FORBIDDEN = ['出现未登记的第三方势力'];
const CLEAN: Record<string, string> = {
  W1: '温芮把借来的扳手挂回工具墙。循环泵在夜里换了一种低沉的节拍，像有人在隔壁的舱室里慢慢踱步。林澈说冷凝管今晚要换滤网。',
  W2: '食堂的蒸笼冒着白汽。值班的老周把一摞铝饭盒挨个擦干，按住户门牌的顺序排在长桌的尽头。孩子们在走廊里数着灯。',
  W3: '种植舱的湿度计又跳了一格。苔床边的水管结着细细的露珠，温芮用袖口一颗一颗地抹掉它们。她听见风机在头顶转。',
};
const FAILING_W2 = '食堂的蒸笼冒着白汽。值班的老周说母星的回信当晚就到了，大家可以放心地吃饭。孩子们在走廊里数着灯。';
const TOO_LONG = '循环泵换了节拍。'.repeat(400);

type Behavior = 'honest' | 'blind' | 'void' | 'noted' | 'path';

function fence(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

function writerText(body: string): string {
  return ['```submission', body, '```', '```delta', '{"new_proper_nouns":[],"claims":[]}', '```', '```interface', '{"shots":[{},{},{}],"object":{"n":1},"hook":{"h":1}}', '```', '种子：', '- 一'].join('\n');
}

function brief(facts: FactRow[], round = 'R01', forbidden: string[] = FORBIDDEN): BriefJson {
  return {
    round, kind: 'round', row_id: 'SHIP', layer: '物件', topic_source: 'fixed',
    cell: { id: 'C', row_id: 'SHIP', title: '母舰 · 邻里常态日', entity: '母舰', time: '息壤停留期', layers: ['物件'], setting_notes: [], protagonists: ['温芮'], forbidden: [...forbidden], stances: [] },
    canon: { revision: '8.1', book_sha256: 'b'.repeat(64), reference_sha256: 'c'.repeat(64) },
    canon_passages: [{ file: 'reference/05-ecology-and-everyday.md', text: '温芮把借来的扳手挂回工具墙。' }],
    facts, regression: [{ id: 'G-001', case: 'P01', source: 'judge-a', quote: '砧港的维修棚彻夜亮灯。' }], regression_stale: [], forbidden: [...forbidden], cliches: [],
    requirements: ['一个具名主角。'], interface_requirements: [], aliases: [], seed: 'brief-seed', created_at: FIXTURE_AT,
  };
}

interface H {
  dir: string;
  ctx: StepContext;
  seed: string;
  brief: BriefJson;
  judges: Map<Family, FakeRouter>;
  writers: FakeRouter[];
  defect: FakeRouter;
  behavior: Map<Family, Behavior>;
  /** Resubmission text per slot (05d). */
  rewrites: Map<string, string>;
  /** The defect writer's replacement for the chosen sentence. */
  replacement: (sentence: string) => string;
}

function judgeRoute(h: () => H, family: Family): Route {
  return (prompt) => {
    const b = h().behavior.get(family) ?? 'honest';
    if (b === 'void') return '';
    const subject = unwrap(prompt, '文本甲') ?? '';
    const table = `${unwrap(prompt, '事实表') ?? ''}\n${unwrap(prompt, '禁用写法') ?? ''}`;
    const sentences = splitSentences(subject);
    const findings: Array<{ quote: string; against: string; reason: string }> = [];
    for (const [trap, against] of b === 'blind' ? [] : TRAPS) {
      const hit = sentences.find((s) => s.includes(trap));
      const id = b === 'path' ? 'F14' : against;
      if (hit !== undefined && table.includes(`${id}｜`)) findings.push({ quote: hit, against: id, reason: '与冻结事实矛盾' });
    }
    if (b === 'noted') findings.push({ quote: sentences[0] ?? '', against: 'F14', reason: '把一次实例写成了常态' });
    return fence({ contradiction: findings.length > 0, findings });
  };
}

function defectRoute(h: () => H): Route {
  return (prompt) => {
    const second = ((unwrap(prompt, '正文') ?? '').split('\n')[1] ?? '').replace(/^〔S\d{3}〕/u, '');
    const against = ((unwrap(prompt, '条目') ?? '').split('\n')[0] ?? '').split('｜')[0] ?? '';
    return fence({ sentence_no: 2, original: second, replacement: h().replacement(second), against });
  };
}

function writerRoute(h: () => H): Route {
  return (_prompt, _call, meta) => writerText(h().rewrites.get(meta.taskId.replace(/^write-|-r2$/gu, '')) ?? CLEAN.W1 ?? '');
}

/** Seed for which the round's defect type is `type` (searching s0, s1, …). */
function seedFor(type: string, facts: FactRow[], types: StepContext['protocol']['defectTypes'], round = 'R01'): string {
  for (let i = 0; i < 500; i += 1) if (pickDefectType(types, { facts }, `s${i}`, round, round === 'R00')?.id === type) return `s${i}`;
  throw new Error(`no seed picks ${type}`);
}

/**
 * Fixture round at 05a: brief (facts), freeze (4 gate families, pinned v1 benchmark), W1..W3 submissions, 05a run.
 * `seed` null → the first seed whose defect type is D1.
 */
async function harness(opts: { facts?: FactRow[]; texts?: Record<string, string>; seed?: string; type?: string; round?: string; forbidden?: string[] } = {}): Promise<H> {
  const round = opts.round ?? 'R01';
  const dir = mkdtempSync(join(tmpdir(), 'forge-gatellm-'));
  const w = fixtureWorld(dir, DEFAULT_FIXTURE);
  const config = loadConfig(w.root, { requireLocal: true });
  if (!config.ok) throw new Error(config.error);
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: '2026-10-01T00:00:00.000Z', seed: 'gate-seed' });
  let self: H | null = null;
  const get = (): H => {
    if (self === null) throw new Error('harness not ready');
    return self;
  };
  const judges = new Map<Family, FakeRouter>(FAMS.map((f) => [f, fakeRouter({ gate: judgeRoute(get, f), gatecopy: judgeRoute(get, f) }, { id: f.toLowerCase(), family: f, model: `${f}-m` })]));
  const writers = ['W1', 'W2', 'W3'].map((slot) => fakeRouter({ write: writerRoute(get) }, { id: `writer-${slot}`, family: 'DeepSeek', model: 'deepseek-fixture' }));
  const defect = fakeRouter({ defect: defectRoute(get) }, { id: 'defect', family: 'DeepSeek', model: 'deepseek-fixture' });
  const other = fakeRouter({}, { id: 'other', family: 'DeepSeek', model: 'deepseek-fixture' });
  const backends: RoundBackends = {
    writers: writers.map((b, i) => ({ slot: `W${i + 1}`, backend: b })),
    baseline: other, decoy: other, defect, judges: [...judges.values()].map((backend) => ({ backend, concurrency: 2 })),
    forecasters: [], maintainer: other, mergeEditor: other, calibGateway: new Map(),
  };
  const built = buildContext({
    root: w.root, repo: w.repo, roundId: round, pipeline: 'round', paths: roundPaths(w.root, round), config: config.value,
    deps: { ports, backends: () => backends, env: {}, pid: 7, isAlive: () => true, log: () => undefined },
    startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
  });
  if (!built.ok) throw new Error(built.error);
  const ctx = built.value;
  const facts = opts.facts ?? [F01, F14];
  const seed = opts.seed ?? seedFor(opts.type ?? 'D1', facts, ctx.protocol.defectTypes, round);
  const b = brief(facts, round, opts.forbidden);
  mkdirSync(ctx.paths.submissions, { recursive: true });
  writeFileSync(ctx.paths.brief, `${JSON.stringify(b, null, 2)}\n`);
  const bench = readFileSync(join(w.root, 'benchmark', 'v1.json'));
  const freeze = buildFreeze({
    round, files: { 'brief.json': 'x' }, benchmarkVersion: 'v1', eligibleFamilies: FAMS, flags: Object.fromEntries(FAMS.map((f) => [f, 'ok'])),
    protocolBundleSha256: ctx.bundleSha256, probeCreatedAt: '2026-10-01T00:05:00Z', seed,
    benchmarkResolution: { version: 'v1', sha256: sha256Bytes(bench), path: 'benchmark/v1.json', via: 'activate', since: FIXTURE_AT },
    gateFamilies: FAMS, trustStatusSha256: null, skills: {},
  });
  writeFileSync(ctx.paths.freeze, `${JSON.stringify(freeze, null, 2)}\n`);
  writeMarker(ctx.files, join(ctx.paths.markers, '02c-freeze.json'), {
    v: 1, round, step: '02c-freeze', completed_at: FIXTURE_AT, result: 'done', skipped: null,
    inputs: {}, outputs: {}, external: {}, local: {}, tasks: { ok: 0, void: 0, calls: 0 }, prev: null,
  });
  for (const [slot, text] of Object.entries(opts.texts ?? CLEAN)) {
    writeFileSync(join(ctx.paths.submissions, `${slot}.json`), JSON.stringify({
      id: slot, kind: 'writer', task: `write-${slot}`, model: 'deepseek-fixture', family: 'DeepSeek', stance: STANCE, skill: null, ok: true, error: null, attempts: 1, text: writerText(text),
    }));
  }
  await gateMechStep.run(ctx, null);
  self = { dir, ctx, seed, brief: b, judges, writers, defect, behavior: new Map(), rewrites: new Map(), replacement: (s) => `星门外${s}` };
  return self;
}

function readGate(h: H, name: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(readFileSync(join(h.ctx.paths.gate, `${name}.json`), 'utf8'));
  if (!isRecord(raw)) throw new Error(`${name}.json is not an object`);
  return raw;
}

function judgesOf(h: H, sub: string): Array<{ family: string; n: number; reserve: boolean; voided: boolean; caught: unknown; copy: unknown }> {
  const list = readGate(h, sub)['judges'];
  if (!Array.isArray(list)) throw new Error('judges');
  return list.filter(isRecord).map((j) => ({
    family: String(j['family']), n: Number(j['n']), reserve: j['reserve'] === true, voided: j['voided'] === true, caught: j['caught'], copy: j['copy'],
  }));
}

function judgeCalls(h: H): string[] {
  return [...h.judges.values()].flatMap(callLog);
}

/** The seeded family order of a submission (all four families are gate families; writers are DeepSeek). */
function orderOf(h: H, sub: string): Family[] {
  const r = gateRoles(FAMS, h.seed, sub);
  return [...r.judges, ...r.reserve];
}

function done(h: H): void {
  rmSync(h.dir, { recursive: true });
}

async function through05c(h: H): Promise<string> {
  const d = await defectStep.run(h.ctx, null);
  assert.equal(d.kind, 'done');
  const g = await gateLlmStep.run(h.ctx, null);
  assert.equal(g.kind, 'done');
  const file = readDefectFile(h.ctx);
  assert.ok(file.ok);
  return file.value.submission ?? '';
}

test('05b/05c: exactly one defect copy per round, of one seeded gate-bound submission, sent only to its two gate judges', async () => {
  const h = await harness({ texts: { ...CLEAN, W3: TOO_LONG } });
  const sub = await through05c(h);
  assert.equal(sub, pickDefectSubmission(['W1', 'W2'], h.seed, 'R01'), 'seeded over the gate-bound (mechanical pass) slots only');
  const defect = readDefectFile(h.ctx);
  assert.ok(defect.ok && defect.value.status === 'ok' && defect.value.type === 'D1');
  assert.deepEqual(callLog(h.defect), [`defect-${sub}#1`]);
  const copies = judgeCalls(h).filter((c) => c.startsWith('gatecopy-'));
  const [a, b] = orderOf(h, sub);
  assert.deepEqual(copies.sort(), [`gatecopy-${sub}-${a}-1#1`, `gatecopy-${sub}-${b}-2#1`].sort());
  for (const other of ['W1', 'W2'].filter((s) => s !== sub)) {
    const [c, d] = orderOf(h, other);
    assert.deepEqual(judgeCalls(h).filter((x) => x.includes(`-${other}-`)).sort(), [`gate-${other}-${c}-1#1`, `gate-${other}-${d}-2#1`].sort());
  }
  assert.equal(judgeCalls(h).length, 6, '2 real calls per gate-bound submission + 2 copy calls');
  assert.ok(!judgeCalls(h).some((c) => c.includes('-W3-')), 'a mechanical fail is not gate-bound');
  for (const j of judgesOf(h, sub)) assert.equal(j.caught, true);
  const llm = readGate(h, 'llm');
  assert.deepEqual(llm['submissions'], { W1: { outcome: 'pass', defect_unverified: false }, W2: { outcome: 'pass', defect_unverified: false } });
  assert.deepEqual(llm['voided_families'], []);
  const log = [...h.judges.values()].flatMap((r) => r.log());
  const real = log.find((c) => c.taskId === `gate-${sub}-${a}-1`);
  const copy = log.find((c) => c.taskId === `gatecopy-${sub}-${a}-1`);
  assert.ok(real !== undefined && copy !== undefined);
  const shape = (p: string): string => p.replace(/·[0-9a-f]{4}〕/gu, '·t〕').replace(/〔文本甲·t〕\n[\s\S]*?\n〔文本甲完·t〕/u, 'SUBJECT');
  assert.equal(shape(real.prompt), shape(copy.prompt), 'real and copy prompts are identical in form');
  assert.ok((unwrap(copy.prompt, '文本甲') ?? '').includes('星门外'));
  done(h);
});

test('05b/05c: a D3 copy targets a brief forbidden move by its X-id and is caught; without such a move D3 is never picked', async () => {
  const h = await harness({ type: 'D3' });
  h.replacement = (s) => `一支未登记的第三方商队${s}`;
  const sub = await through05c(h);
  const defect = readDefectFile(h.ctx);
  assert.ok(defect.ok && defect.value.status === 'ok');
  assert.deepEqual([defect.value.type, defect.value.against], ['D3', 'X01']);
  assert.ok((defect.value.copy ?? '').includes('第三方商队'));
  const js = judgesOf(h, sub);
  assert.ok(js.length >= 2);
  for (const j of js) assert.equal(j.caught, true, `${j.family} catches the D3 copy against X01`);
  assert.deepEqual(readGate(h, 'llm')['voided_families'], []);
  done(h);
  const none = await harness({ seed: h.seed, forbidden: ['决定任何失散者的结局'] });
  await through05c(none);
  const other = readDefectFile(none.ctx);
  assert.ok(other.ok && other.value.status === 'ok');
  assert.notEqual(other.value.type, 'D3', 'no id-based D3 target → D3 is not enabled this round');
  done(none);
});

test('05b: D1 never offers an F-ID with status 状态与路径实例 (F14); void defect → status void and defect_unverified, never a failed step', async () => {
  const h = await harness({ type: 'D1' });
  h.replacement = () => '两句话。第二句。';
  const d = await defectStep.run(h.ctx, null);
  assert.equal(d.kind, 'done');
  const prompt = h.defect.log()[0]?.prompt ?? '';
  assert.equal(unwrap(prompt, '条目'), 'F01｜共同事实｜没有星门，也没有即时跨星通信。');
  const file = readDefectFile(h.ctx);
  assert.ok(file.ok);
  assert.equal(file.value.status, 'void');
  assert.equal(callLog(h.defect).length, 2, 'one retry, then void');
  assert.match(file.value.error ?? '', /exactly one sentence/u);
  const g = await gateLlmStep.run(h.ctx, null);
  assert.equal(g.kind, 'done');
  assert.ok(!judgeCalls(h).some((c) => c.startsWith('gatecopy-')), 'no copy when the defect voided');
  const llm = readGate(h, 'llm');
  assert.equal(llm['defect_status'], 'void');
  const subs = llm['submissions'];
  assert.ok(isRecord(subs));
  const sub = file.value.submission ?? '';
  assert.deepEqual(subs[sub], { outcome: 'pass', defect_unverified: true });
  assert.equal(readGate(h, sub)['defect_unverified'], true);
  assert.deepEqual(validate(gateSchema('defect'), readGate(h, 'defect')), []);
  done(h);
});

test('05c: a family that answers 无矛盾 on the copy loses all its verdicts of the round; reserve families replace it everywhere', async () => {
  const h = await harness();
  const sub = pickDefectSubmission(['W1', 'W2', 'W3'], h.seed, 'R01') ?? '';
  const blind = orderOf(h, sub)[0] ?? 'OpenAI';
  h.behavior.set(blind, 'blind');
  const elsewhere = ['W1', 'W2', 'W3'].filter((s) => s !== sub && orderOf(h, s).slice(0, 2).includes(blind));
  assert.ok(elsewhere.length > 0, 'fixture: the blind family is also a seeded judge of another submission');
  await through05c(h);
  const llm = readGate(h, 'llm');
  assert.deepEqual(llm['voided_families'], [{ family: blind, reason: 'missed_copy' }]);
  for (const s of ['W1', 'W2', 'W3']) {
    const order = orderOf(h, s);
    const js = judgesOf(h, s);
    const counted = readGate(h, s)['counted'];
    assert.ok(Array.isArray(counted) && counted.length === 2 && !counted.includes(blind), `${s}: two counted families, never the blind one`);
    if (order.slice(0, 2).includes(blind)) {
      assert.ok(js.some((j) => j.family === blind && j.voided), `${s}: the blind family's verdict is kept but voided`);
      const reserve = js.find((j) => j.reserve);
      assert.ok(reserve !== undefined && reserve.family === order[2] && reserve.n === 3, `${s}: the next reserve (n 3) replaces it`);
      if (s === sub) {
        assert.equal(reserve.caught, true, 'the reserve on the defect submission also judges the copy');
        assert.ok(judgeCalls(h).includes(`gatecopy-${s}-${order[2]}-3#1`));
      }
    }
    assert.equal(readGate(h, s)['outcome'], 'pass');
  }
  done(h);
});

test('05c: reserve exhausted → unverified (listed in llm.json); void calls void the family with reason void_call', async () => {
  const h = await harness();
  for (const f of FAMS.slice(1)) h.behavior.set(f, 'void');
  await through05c(h);
  const llm = readGate(h, 'llm');
  assert.deepEqual(llm['unverified'], ['W1', 'W2', 'W3']);
  assert.deepEqual(llm['voided_families'], FAMS.slice(1).map((family) => ({ family, reason: 'void_call' })));
  for (const s of ['W1', 'W2', 'W3']) {
    assert.equal(readGate(h, s)['outcome'], 'unverified');
    assert.deepEqual(readGate(h, s)['counted'], [FAMS[0]]);
  }
  done(h);
});

test('05b/05c: a D4 reversal of fixture-rxx (status 状态与路径实例) quoted against the Rxx id is caught; the same quote against F14 misses', async () => {
  const h = await harness({ facts: [F01, F14, RXX], type: 'D4' });
  h.replacement = () => REVERSAL;
  const sub = await through05c(h);
  const defect = readDefectFile(h.ctx);
  assert.ok(defect.ok);
  assert.deepEqual([defect.value.type, defect.value.against, defect.value.injected], ['D4', 'R00-01', REVERSAL]);
  const js = judgesOf(h, sub);
  assert.deepEqual(js.map((j) => j.caught), [true, true]);
  assert.deepEqual(readGate(h, 'llm')['voided_families'], []);

  const miss = await harness({ facts: [F01, F14, RXX], type: 'D4' });
  miss.replacement = () => REVERSAL;
  const first = orderOf(miss, pickDefectSubmission(['W1', 'W2', 'W3'], miss.seed, 'R01') ?? '')[0] ?? 'OpenAI';
  miss.behavior.set(first, 'path');
  await through05c(miss);
  assert.deepEqual(readGate(miss, 'llm')['voided_families'], [{ family: first, reason: 'missed_copy' }], 'a path-instance finding never catches');
  done(h);
  done(miss);
});

test('05b/05c round-0 drill: without any registered fact D4 reverses the protocol fixture-rxx, the judges get it as a fact row, and catch it', async () => {
  const h = await harness({ round: 'R00', facts: [F01, F14], type: 'D4' });
  const fixture = h.ctx.protocol.fixtureRxx;
  h.replacement = () => fixture.reversal;
  assert.equal(pickDefectType(h.ctx.protocol.defectTypes, { facts: [F01, F14] }, h.seed, 'R00', false)?.id === 'D4', false, 'D4 needs the drill');
  const sub = await through05c(h);
  const defect = readDefectFile(h.ctx);
  assert.ok(defect.ok);
  assert.deepEqual([defect.value.type, defect.value.against, defect.value.injected], ['D4', fixture.rxx, fixture.reversal]);
  const prompts = [...h.judges.values()].flatMap((r) => r.log()).filter((c) => c.taskId.includes(`-${sub}-`));
  assert.ok(prompts.length > 0 && prompts.every((c) => (unwrap(c.prompt, '事实表') ?? '').includes(`${fixture.rxx}｜`)), 'fixture-rxx is a fact row of every judge pack');
  assert.deepEqual(judgesOf(h, sub).map((j) => j.caught), [true, true]);
  assert.deepEqual(readGate(h, 'llm')['voided_families'], []);
  done(h);
});

test('05c: path-instance findings go to path_instance_notes and never make a verdict yes', async () => {
  const h = await harness();
  for (const f of FAMS) h.behavior.set(f, 'noted');
  await through05c(h);
  for (const s of ['W1', 'W2', 'W3']) {
    const g = readGate(h, s);
    assert.equal(g['outcome'], 'pass');
    const notes = g['path_instance_notes'];
    assert.ok(Array.isArray(notes) && notes.length === 2);
    const first = CLEAN[s] === undefined ? '' : splitSentences(CLEAN[s] ?? '')[0];
    assert.ok(notes.every((n) => isRecord(n) && n['against'] === 'F14' && n['quote'] === first));
  }
  done(h);
});

function gateSchema(kind: string): Schema {
  const loaded = loadSchema(JSON.parse(readFileSync(new URL('../../schema/gate.schema.json', import.meta.url), 'utf8')));
  if (!loaded.ok) throw new Error(loaded.error);
  const sub = loaded.value.properties?.[kind];
  if (sub === undefined) throw new Error(`gate.schema.json has no ${kind}`);
  return sub;
}

test('05d: a failed slot gets one blind resubmission (same prompt, new id, no feedback), a fresh -re pass by non-voided families, no new copy', async () => {
  const h = await harness({ texts: { W1: CLEAN.W1 ?? '', W2: FAILING_W2, W3: TOO_LONG } });
  const sub = pickDefectSubmission(['W1', 'W2'], h.seed, 'R01') ?? '';
  const blind = orderOf(h, sub)[0] ?? 'OpenAI';
  h.behavior.set(blind, 'blind');
  await through05c(h);
  assert.equal(readGate(h, 'W2')['outcome'], 'fail');
  const before = new Set(judgeCalls(h));
  h.rewrites.set('W2', CLEAN.W2 ?? '');
  h.rewrites.set('W3', TOO_LONG);
  const out = await resubmitStep.run(h.ctx, null);
  assert.equal(out.kind, 'done');
  assert.deepEqual(callLog(h.writers[0] ?? h.defect), []);
  assert.deepEqual(callLog(h.writers[1] ?? h.defect), ['write-W2-r2#1']);
  assert.deepEqual(callLog(h.writers[2] ?? h.defect), ['write-W3-r2#1']);
  const rewrites: Array<[number, string]> = [[1, 'W2'], [2, 'W3']];
  for (const [i, slot] of rewrites) {
    assert.equal(h.writers[i]?.log()[0]?.prompt, writerTask(h.brief, slot, STANCE, null).prompt, `${slot}: the resubmission prompt is the first prompt, byte for byte`);
  }
  assert.equal(callLog(h.defect).length, 1, 'no new defect call');
  const re = judgeCalls(h).filter((c) => !before.has(c));
  assert.ok(re.length === 2 && re.every((c) => /^gate-W2-r2-[A-Za-z]+-\d-re#1$/u.test(c)), 'two fresh -re calls on W2-r2 only, no copy');
  assert.ok(!re.some((c) => c.includes(`-${blind}-`)), 'the family voided in 05c never judges in 05d');
  assert.equal(readGate(h, 'W2-r2')['outcome'], 'pass');
  assert.equal(readGate(h, 'W2-r2')['resubmission'], true);
  const resubmit = readGate(h, 'resubmit');
  const entries = resubmit['entries'];
  assert.ok(Array.isArray(entries));
  assert.deepEqual(entries.filter(isRecord).map((e) => [e['slot'], e['submission'], e['reason'], e['writer'], e['mechanical'], e['outcome']]), [
    ['W2', 'W2-r2', 'gate_fail', 'ok', 'pass', 'pass'],
    ['W3', 'W3-r2', 'mechanical_fail', 'ok', 'fail', null],
  ]);
  assert.deepEqual(resubmit['passing'], ['W1', 'W2-r2']);
  assert.deepEqual(resubmit['voided_families'], [{ family: blind, reason: 'missed_copy' }], 'the 05c voids carry over');
  assert.deepEqual(passingSubmissions(h.ctx), { ok: true, value: ['W1', 'W2-r2'] });
  const files: Array<[string, string]> = [['defect', 'defect'], ['llm', 'llm'], ['submission', 'W1'], ['submission', 'W2'], ['submission', 'W2-r2'], ['resubmit', 'resubmit']];
  for (const [kind, name] of files) assert.deepEqual(validate(gateSchema(kind), readGate(h, name)), [], `${name}.json validates`);
  done(h);
});

test('05d: a family that voids a -re call is added to resubmit.json voided_families next to the 05c voids', async () => {
  const h = await harness({ texts: { W1: CLEAN.W1 ?? '', W2: FAILING_W2, W3: CLEAN.W3 ?? '' } });
  const sub = pickDefectSubmission(['W1', 'W2', 'W3'], h.seed, 'R01') ?? '';
  const blind = orderOf(h, sub)[0] ?? 'OpenAI';
  h.behavior.set(blind, 'blind');
  await through05c(h);
  const late = gateRoles(FAMS.filter((f) => f !== blind), h.seed, 'W2-r2').judges[0] ?? 'OpenAI';
  h.behavior.set(late, 'void');
  h.rewrites.set('W2', CLEAN.W2 ?? '');
  assert.equal((await resubmitStep.run(h.ctx, null)).kind, 'done');
  const resubmit = readGate(h, 'resubmit');
  const want = [{ family: blind, reason: 'missed_copy' }, { family: late, reason: 'void_call' }].sort((a, b) => (a.family < b.family ? -1 : 1));
  assert.deepEqual(resubmit['voided_families'], want);
  assert.deepEqual(validate(gateSchema('resubmit'), resubmit), []);
  done(h);
});

test('05d: skip when nothing failed; failed (5) when no submission passes after resubmission', async () => {
  const h = await harness();
  await through05c(h);
  assert.deepEqual(await resubmitStep.run(h.ctx, null), { kind: 'skip', reason: 'no failed slot' });
  assert.deepEqual(passingSubmissions(h.ctx), { ok: true, value: ['W1', 'W2', 'W3'] });
  done(h);

  const f = await harness({ texts: { W1: TOO_LONG, W2: TOO_LONG, W3: TOO_LONG } });
  await through05c(f);
  assert.equal(readDefectFile(f.ctx).ok && readGate(f, 'defect')['status'], 'none');
  for (const slot of ['W1', 'W2', 'W3']) f.rewrites.set(slot, TOO_LONG);
  const out = await resubmitStep.run(f.ctx, null);
  assert.equal(out.kind, 'failed');
  assert.deepEqual(readGate(f, 'resubmit')['passing'], []);
  for (const name of ['defect', 'llm', 'resubmit']) assert.deepEqual(validate(gateSchema(name), readGate(f, name)), [], name);
  assert.deepEqual(judgeCalls(f), [], 'nothing reached the LLM gate');
  done(f);
});

test('05c resumed after a finished run reuses every task record: no new call, byte-identical files', async () => {
  const h = await harness();
  const sub = pickDefectSubmission(['W1', 'W2', 'W3'], h.seed, 'R01') ?? '';
  h.behavior.set(orderOf(h, sub)[0] ?? 'OpenAI', 'blind');
  await through05c(h);
  const calls = judgeCalls(h).length;
  const bytes = ['llm', 'W1', 'W2', 'W3'].map((n) => readFileSync(join(h.ctx.paths.gate, `${n}.json`), 'utf8'));
  const again = await gateLlmStep.run(h.ctx, null);
  assert.equal(again.kind, 'done');
  assert.equal(judgeCalls(h).length, calls);
  assert.deepEqual(['llm', 'W1', 'W2', 'W3'].map((n) => readFileSync(join(h.ctx.paths.gate, `${n}.json`), 'utf8')), bytes);
  done(h);
});

test('judgedFlags: 05a flags reach a judge typeset like its text and only when the text holds them (never on the copy after the defect replaced the sentence)', () => {
  const display = '温芮把扳手挂回工具墙。林澈说「这里没有星门」……她笑了。';
  const flags = ['林澈说“这里没有星门”...她笑了。', '标题里也没有星门', '林澈说“这里没有星门”...她笑了。'];
  assert.deepEqual(judgedFlags(display, flags), ['林澈说「这里没有星门」……她笑了。'], 'typeset, deduplicated, the dropped title line left out');
  const copy = display.replace('林澈说「这里没有星门」……她笑了。', '林澈说星门今晚就开。');
  assert.deepEqual(judgedFlags(copy, flags), [], 'the copy never lists a sentence it no longer holds');
});
