import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeBackend } from './adapters/fake.ts';
import type { EvidencePacket } from './bench-evidence.ts';
import {
  assembleCandidate, authorityTable, citedIds, dropCanonCliches, initialTask, INITIAL_TASK_ID, logReasons, maintainerTask, maintainerTaskId,
  MAINTAINER_REASON_MAX, parseMaintainer, type ChangeOutput, type MaintainerInput, type NoChangeOutput,
} from './bench-propose.ts';
import { MAINTAINER_KEYS, validateBenchmark } from './bench-validate.ts';
import { loadConfig } from './config.ts';
import { buildContext, type RoundBackends, type StepContext } from './context.ts';
import { isRecord, type JsonRecord } from './json.ts';
import { benchContext, loadProtocolBundle } from './rules.ts';
import { roundPaths } from './store.ts';
import { runTask } from './task.ts';
import { unwrap } from './tasks/fenced.ts';
import { ROLE_MAINTAINER } from './tasks/roles.ts';
import { fakePorts } from './testing/fakes.ts';
import { DEFAULT_FIXTURE, fixtureWorld } from './testing/fixture-world.ts';
import { callLog, fakeRouter, type FakeRouter } from './testing/scripted.ts';

const FORGE = new URL('..', import.meta.url).pathname;

function protocol() {
  const b = loadProtocolBundle(FORGE);
  if (!b.ok) throw new Error(b.error);
  return b.value.protocol;
}

/** The v1-shaped head: v0's maintainer body under the lineage meta. */
function head(): JsonRecord {
  const v0: unknown = JSON.parse(readFileSync(join(FORGE, 'benchmark/v0.json'), 'utf8'));
  if (!isRecord(v0)) throw new Error('v0 is not an object');
  return { ...v0, version: 'v1', parent: null, created_at: '2026-09-01T00:00:00.000Z', author: { kind: 'maintainer', model: 'm' }, reasons: [] };
}

function body(from: JsonRecord = head()): JsonRecord {
  return Object.fromEntries(MAINTAINER_KEYS.map((k) => [k, structuredClone(from[k] ?? null)]));
}

const AGR = 'E-R03-AGR-Moonshot';
const SAT_HOOK = 'E-R03-SAT-hook';
const SAT_TASTE = 'E-R03-SAT-taste';

function packet(ceilings: string[] = []): EvidencePacket {
  return {
    round: 'R03',
    benchmark_version: 'v1',
    head_version: 'v1',
    inputs: { 'rounds/R03/freeze.json': 'a'.repeat(64) },
    items: [
      { id: AGR, kind: 'agreement', family: 'Moonshot', n: 12, agree: 11, mean: 0.85, ci90: [0.7, 0.95], state: 'ok' },
      { id: SAT_HOOK, kind: 'saturation', measure: 'hook', rounds: [{ round: 'R02', n: 4, top: 3 }, { round: 'R03', n: 4, top: 4 }], ceiling: ceilings.includes(SAT_HOOK) },
      { id: SAT_TASTE, kind: 'saturation', measure: 'taste', rounds: [], ceiling: ceilings.includes(SAT_TASTE) },
    ],
    ceilings,
  };
}

function fence(value: unknown): string {
  return `说明文字\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

function change(over: JsonRecord = {}, reasonOver: JsonRecord = {}): JsonRecord {
  const b = body();
  b['cliche_list'] = ['新陈词'];
  return {
    kind: 'change',
    body: { ...b, ...over },
    reasons: [{ change: '加入一条陈词', keys: ['cliche_list'], evidence_ids: [AGR], expected_effect: '减少套话', ...reasonOver }],
  };
}

function parseErr(text: string, p: EvidencePacket | null, pattern: RegExp, h: JsonRecord | null = null): void {
  const r = parseMaintainer(text, p, h);
  assert.equal(r.ok, false, `expected a parse error matching ${pattern}`);
  if (!r.ok) {
    assert.match(r.error, pattern);
    assert.match(r.error, /^[\x20-\x7e]+$/u, 'parse errors are ASCII');
  }
}

function input(over: Partial<MaintainerInput> = {}): MaintainerInput {
  return { packet: packet(), head: head(), authority: authorityTable(protocol()), protocolMd: '# 协议全文\n第一条。', round: 'R03', seed: 'b'.repeat(64), ...over };
}

test('task ids: bench-propose-RNN and bench-initial', () => {
  assert.equal(maintainerTaskId('R03'), 'bench-propose-R03');
  assert.equal(maintainerTaskId('R00'), 'bench-propose-R00');
  assert.equal(INITIAL_TASK_ID, 'bench-initial');
  assert.equal(MAINTAINER_REASON_MAX, 300);
});

test('a fenced change output parses; reason texts are trimmed and the body passes through', () => {
  const raw = change({}, { change: '  加入一条陈词  ' });
  const r = parseMaintainer(fence(raw), packet());
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.equal(r.value.kind, 'change');
  if (r.value.kind !== 'change') return;
  assert.deepEqual(r.value.body, raw['body']);
  assert.deepEqual(r.value.reasons, [{ change: '加入一条陈词', keys: ['cliche_list'], evidence_ids: [AGR], expected_effect: '减少套话' }]);
});

test('a no_change output needs at least one reason; its reasons are {text, evidence_ids}', () => {
  const ok = parseMaintainer(fence({ kind: 'no_change', reasons: [{ text: '证据不足以支持修改', evidence_ids: [AGR] }] }), packet());
  assert.deepEqual(ok, { ok: true, value: { kind: 'no_change', reasons: [{ text: '证据不足以支持修改', evidence_ids: [AGR] }] } });
  parseErr(fence({ kind: 'no_change', reasons: [] }), packet(), /no_change needs at least one reason/u);
  parseErr(fence({ kind: 'no_change' }), packet(), /reasons/u);
  parseErr(fence({ kind: 'no_change', reasons: [{ text: '', evidence_ids: [] }] }), packet(), /reasons\[0\]\.text: empty/u);
});

test('bare JSON, two fenced blocks and an unknown kind are parse errors (retry)', () => {
  parseErr(JSON.stringify(change()), packet(), /exactly one fenced json block/u);
  parseErr(`${fence(change())}${fence(change())}`, packet(), /exactly one fenced json block/u);
  parseErr(fence({ ...change(), kind: 'maybe' }), packet(), /kind: must be "no_change" or "change"/u);
});

test('cited evidence ids must exist in the packet; without a packet none may be cited', () => {
  parseErr(fence(change({}, { evidence_ids: ['E-R03-AGR-xAI'] })), packet(), /reasons\[0\]\.evidence_ids: E-R03-AGR-xAI is not in the evidence packet/u);
  parseErr(fence(change({}, { evidence_ids: ['not an id'] })), packet(), /reasons\[0\]\.evidence_ids\[0\]: not an evidence id/u);
  parseErr(fence({ kind: 'no_change', reasons: [{ text: 't', evidence_ids: ['E-R09-RC'] }] }), packet(), /reasons\[0\]\.evidence_ids: E-R09-RC is not in the evidence packet/u);
  parseErr(fence(change()), null, /reasons\[0\]\.evidence_ids: no evidence packet, cite no ids/u);
  const v1 = parseMaintainer(fence(change({}, { evidence_ids: [] })), null);
  assert.ok(v1.ok, v1.ok ? '' : v1.error);
});

test('every ceiling id must be cited or its measure changed (head known)', () => {
  const p = packet([SAT_HOOK]);
  parseErr(fence(change()), p, /ceiling E-R03-SAT-hook: cite it or change measures\.hook/u, head());
  parseErr(fence({ kind: 'no_change', reasons: [{ text: 't', evidence_ids: [AGR] }] }), p, /ceiling E-R03-SAT-hook/u, head());
  assert.ok(parseMaintainer(fence(change({}, { evidence_ids: [AGR, SAT_HOOK] })), p, head()).ok, 'cited');
  assert.ok(parseMaintainer(fence({ kind: 'no_change', reasons: [{ text: 't', evidence_ids: [SAT_HOOK] }] }), p, head()).ok, 'cited by no_change');
  const retired = body();
  retired['cliche_list'] = ['新陈词'];
  retired['measures'] = { ...(isRecord(retired['measures']) ? retired['measures'] : {}), hook: { active: false } };
  assert.ok(parseMaintainer(fence(change({ measures: retired['measures'] })), p, head()).ok, 'measure retired');
  parseErr(fence(change({ measures: retired['measures'] })), p, /ceiling E-R03-SAT-hook/u, null);
  const tp = packet([SAT_TASTE]);
  const headTaste = head()['taste'];
  const taste = { ...(isRecord(headTaste) ? headTaste : {}), decisive: 'q1' };
  const changedTaste = parseMaintainer(fence(change({ taste }, { keys: ['cliche_list', 'taste'] })), tp, { ...head(), taste: { ...taste, decisive: 'q2' } });
  assert.ok(changedTaste.ok, 'the taste measure maps to body.taste');
});

test('body keys: meta keys and unknown keys are parse errors, protected keys pass through, maintainer keys are all required', () => {
  parseErr(fence(change({ version: 'v9' })), packet(), /body: meta key version/u);
  parseErr(fence(change({ reasons: [] })), packet(), /body: meta key reasons/u);
  parseErr(fence(change({ colour: 'red' })), packet(), /body: unknown key colour/u);
  const withProtected = parseMaintainer(fence(change({ gate: { strict: false } })), packet());
  assert.ok(withProtected.ok, withProtected.ok ? '' : withProtected.error);
  if (withProtected.value.kind === 'change') assert.deepEqual(withProtected.value.body['gate'], { strict: false });
  const missing = change();
  const b = missing['body'];
  if (isRecord(b)) delete b['bars'];
  parseErr(fence(missing), packet(), /body: missing maintainer key bars/u);
  parseErr(fence({ ...change(), body: [] }), packet(), /body: not an object/u);
});

test('reason caps and shapes', () => {
  parseErr(fence(change({}, { change: '长'.repeat(301) })), packet(), /reasons\[0\]\.change: longer than 300 chars/u);
  parseErr(fence(change({}, { expected_effect: '效'.repeat(301) })), packet(), /reasons\[0\]\.expected_effect: longer than 300 chars/u);
  parseErr(fence(change({}, { keys: ['gate'] })), packet(), /reasons\[0\]\.keys: gate is not a maintainer key/u);
  parseErr(fence(change({}, { keys: 'cliche_list' })), packet(), /reasons\[0\]\.keys: not an array of strings/u);
  parseErr(fence({ ...change(), reasons: [] }), packet(), /change needs at least one reason/u);
  parseErr(fence({ kind: 'no_change', reasons: [{ text: '长'.repeat(301), evidence_ids: [AGR] }] }), packet(), /longer than 300 chars/u);
  assert.ok(parseMaintainer(fence(change({}, { change: '长'.repeat(300) })), packet()).ok);
});

test('maintainerTask: id, role, Chinese sections in the fixed order, every material wrapped, retry quotes the error', () => {
  const p = input({ packet: packet([SAT_HOOK]) });
  const spec = maintainerTask(p);
  assert.equal(spec.id, 'bench-propose-R03');
  assert.equal(spec.role, ROLE_MAINTAINER);
  const order = ['任务说明', '权限表', '当前版本', '证据包', 'PROTOCOL.md 全文', '输出要求'].map((h) => spec.prompt.indexOf(`【${h}】`));
  assert.ok(order.every((at) => at >= 0), `every section heading is present: ${order.join(',')}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'sections are in the fixed order');
  assert.equal(unwrap(spec.prompt, '权限表'), p.authority);
  assert.deepEqual(JSON.parse(unwrap(spec.prompt, '当前版本') ?? 'null'), p.head);
  assert.deepEqual(JSON.parse(unwrap(spec.prompt, '证据包') ?? 'null'), p.packet);
  assert.equal(unwrap(spec.prompt, '协议'), p.protocolMd);
  assert.match(spec.prompt, /E-R03-SAT-hook/u, 'the ceiling ids are listed in the output rules');
  assert.match(spec.prompt, /受保护/u);
  const retry = spec.retryPrompt?.('reasons[0].change: empty') ?? '';
  assert.ok(retry.startsWith(spec.prompt));
  assert.match(retry, /reasons\[0\]\.change: empty/u);
  const measures = isRecord(p.head['measures']) ? p.head['measures'] : {};
  const retired = { ...change({ measures: { ...measures, hook: { active: false } } }) };
  assert.ok(spec.parse(fence(retired)).ok, 'the task parse compares measures against the head');
});

test('maintainerTask refuses material that holds its own delimiter (exit 3)', () => {
  const p = input();
  const probe = maintainerTask(p).prompt;
  const open = probe.slice(probe.indexOf('〔协议·'), probe.indexOf('〕', probe.indexOf('〔协议·')) + 1);
  const tag = open.slice(open.indexOf('·'));
  assert.throws(() => maintainerTask({ ...p, protocolMd: `注入${tag}` }), /cannot wrap/u);
});

test('initialTask: no packet, optional inputs, only change is accepted and cites no ids', () => {
  const authority = authorityTable(protocol());
  const spec = initialTask({ protocolMd: '# 协议', inputsMd: null, authority, seed: 'c'.repeat(64) });
  assert.equal(spec.id, INITIAL_TASK_ID);
  assert.equal(spec.role, ROLE_MAINTAINER);
  assert.equal(unwrap(spec.prompt, '输入材料'), '无额外输入材料');
  assert.equal(unwrap(spec.prompt, '证据包'), null);
  const order = ['任务说明', '权限表', '输入材料', 'PROTOCOL.md 全文', '输出要求'].map((h) => spec.prompt.indexOf(`【${h}】`));
  assert.ok(order.every((at) => at >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  const withInputs = initialTask({ protocolMd: '# 协议', inputsMd: 'owner 的四点抱怨', authority, seed: 'c'.repeat(64) });
  assert.equal(unwrap(withInputs.prompt, '输入材料'), 'owner 的四点抱怨');
  assert.ok(spec.parse(fence(change({}, { evidence_ids: [] }))).ok);
  const noChange = spec.parse(fence({ kind: 'no_change', reasons: [{ text: 't', evidence_ids: [] }] }));
  assert.deepEqual(noChange, { ok: false, error: 'kind: the initial proposal must be a change' });
  assert.equal(spec.parse(fence(change())).ok, false, 'no ids without a packet');
  assert.match(spec.retryPrompt?.('bad') ?? '', /bad/u);
});

function maintainerContext(dir: string, maintainer: FakeRouter): StepContext {
  const w = fixtureWorld(dir, DEFAULT_FIXTURE);
  const config = loadConfig(w.root, { requireLocal: true });
  if (!config.ok) throw new Error(config.error);
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: '2026-10-01T00:00:00.000Z', seed: 'propose-seed' });
  const b = fakeBackend('x', 'DeepSeek', () => '');
  const backends: RoundBackends = {
    writers: [{ slot: 'W1', backend: b }], baseline: b, decoy: b, defect: b, judges: [], forecasters: [], maintainer, mergeEditor: b, calibGateway: new Map(),
  };
  const built = buildContext({
    root: w.root, repo: w.repo, roundId: 'R03', pipeline: 'round', paths: roundPaths(w.root, 'R03'), config: config.value,
    deps: { ports, backends: () => backends, env: {}, pid: 7, isAlive: () => true, log: () => undefined },
    startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
  });
  if (!built.ok) throw new Error(built.error);
  return built.value;
}

test('two invalid outputs through runTask leave the task void (output null → no_change_invalid)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-propose-'));
  const maintainer = fakeRouter({ bench: (_prompt, n) => (n === 1 ? JSON.stringify(change()) : fence(change({ version: 'v9' }))) }, { id: 'maintainer', family: 'Anthropic', model: 'fable' });
  const ctx = maintainerContext(dir, maintainer);
  const res = await runTask(ctx, ctx.backends.maintainer, maintainerTask(input()));
  assert.equal(res.value, null);
  assert.equal(res.attempts, 2);
  assert.match(res.error ?? '', /body: meta key version/u);
  assert.deepEqual(callLog(maintainer), ['bench-propose-R03#1', 'bench-propose-R03#2']);
  const second = maintainer.log()[1]?.prompt ?? '';
  assert.match(second, /exactly one fenced json block/u, 'the retry prompt quotes the first parse error');
  rmSync(dir, { recursive: true });
});

test('a valid second attempt is accepted through runTask', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-propose-'));
  const maintainer = fakeRouter({ bench: (_prompt, n) => (n === 1 ? 'no fence' : fence(change())) }, { id: 'maintainer', family: 'Anthropic', model: 'fable' });
  const ctx = maintainerContext(dir, maintainer);
  const res = await runTask(ctx, ctx.backends.maintainer, maintainerTask(input()));
  assert.equal(res.value?.kind, 'change');
  assert.equal(res.attempts, 2);
  rmSync(dir, { recursive: true });
});

test('authorityTable lists every activation key with its Chinese class, the hold rule and the protected keys', () => {
  const p = protocol();
  const table = authorityTable(p);
  for (const [key, cls] of Object.entries(p.activation)) {
    const word = cls === 'auto' ? '自动' : cls === 'replay' ? '回放' : 'owner 批准';
    assert.match(table, new RegExp(`\\| ${key} \\| ${cls} \\| [^\\n]*${word}`, 'u'), key);
  }
  assert.match(table, new RegExp(`${p.bars.holdRounds} 轮`, 'u'));
  for (const key of p.protectedKeys) assert.ok(table.includes(key), key);
  const narrowed = authorityTable({ ...p, activation: { taste: 'owner' }, protectedKeys: ['gate'] });
  assert.match(narrowed, /\| taste \| owner \|/u);
  assert.doesNotMatch(narrowed, /\| measures \|/u);
  assert.doesNotMatch(narrowed, /forbidden_words/u);
});

test('assembleCandidate: engine meta first in a fixed key order, then the maintainer keys, deep-copied', () => {
  const b = body();
  const reordered: JsonRecord = Object.fromEntries(Object.entries(b).reverse());
  reordered['gate'] = { x: 1 };
  const o: ChangeOutput = { kind: 'change', body: reordered, reasons: [{ change: 'c', keys: ['bars'], evidence_ids: [AGR], expected_effect: 'e' }] };
  const c = assembleCandidate(o, { version: 'v4', parent: 'v3', createdAt: '2026-10-01T00:00:00.000Z', model: 'fable-served' });
  assert.deepEqual(Object.keys(c), ['version', 'parent', 'created_at', 'author', 'reasons', ...MAINTAINER_KEYS, 'gate']);
  assert.deepEqual(c['author'], { kind: 'maintainer', model: 'fable-served' });
  assert.equal(c['parent'], 'v3');
  assert.deepEqual(c['reasons'], [{ change: 'c', keys: ['bars'], evidence_ids: [AGR], expected_effect: 'e' }]);
  assert.notEqual(c['taste'], reordered['taste'], 'values are copies');
  const root = assembleCandidate(o, { version: 'v1', parent: null, createdAt: '2026-10-01T00:00:00.000Z', model: 'm' });
  assert.equal(root['parent'], null);
});

test('logReasons and citedIds', () => {
  const o: ChangeOutput = {
    kind: 'change',
    body: body(),
    reasons: [
      { change: 'c1', keys: ['bars'], evidence_ids: [SAT_HOOK, AGR], expected_effect: 'e' },
      { change: 'c2', keys: ['taste'], evidence_ids: [AGR], expected_effect: 'e' },
    ],
  };
  assert.deepEqual(logReasons(o), [
    { text: 'c1', keys: ['bars'], evidence_ids: [SAT_HOOK, AGR] },
    { text: 'c2', keys: ['taste'], evidence_ids: [AGR] },
  ]);
  assert.deepEqual(citedIds(o), [AGR, SAT_HOOK]);
  const n: NoChangeOutput = { kind: 'no_change', reasons: [{ text: 't', evidence_ids: [SAT_TASTE] }] };
  assert.deepEqual(logReasons(n), [{ text: 't', keys: [], evidence_ids: [SAT_TASTE] }]);
  assert.deepEqual(citedIds(n), [SAT_TASTE]);
});

test('dropCanonCliches removes new entries found in BOOK.md or REFERENCE.md (NFKC both sides), without mutating the input', () => {
  const candidate: JsonRecord = { ...head(), cliche_list: ['星光如水', 'ＡＢＣ之夜', '时光在指缝间流走', '独有的陈词'] };
  const r = dropCanonCliches(candidate, { book: '那夜星光如水，照着舱壁。', reference: '参见 ABC之夜 一节。' }, null);
  assert.deepEqual(r.dropped, ['星光如水', 'ＡＢＣ之夜']);
  assert.deepEqual(r.candidate['cliche_list'], ['时光在指缝间流走', '独有的陈词']);
  assert.deepEqual(candidate['cliche_list'], ['星光如水', 'ＡＢＣ之夜', '时光在指缝间流走', '独有的陈词']);
  const none = dropCanonCliches(candidate, { book: '', reference: '' }, null);
  assert.deepEqual(none.dropped, []);
  assert.deepEqual(none.candidate, candidate);
  const noList = dropCanonCliches({ version: 'v2' }, { book: 'x', reference: 'y' }, null);
  assert.deepEqual(noList, { candidate: { version: 'v2' }, dropped: [] });
});

test('dropCanonCliches keeps entries inherited from the parent (NFKC), so a bars-only change still validates', () => {
  const parent: JsonRecord = { ...head(), cliche_list: ['星海无垠', 'ＸＹＺ之光'] };
  const b = body(parent);
  b['bars'] = { beats_champion_four_families: 8 };
  const out: ChangeOutput = { kind: 'change', body: b, reasons: [{ change: 'c', keys: ['bars'], evidence_ids: [AGR], expected_effect: 'e' }] };
  const assembled = assembleCandidate(out, { version: 'v2', parent: 'v1', createdAt: '2026-09-02T00:00:00.000Z', model: 'm' });
  assembled['cliche_list'] = ['星海无垠', 'XYZ之光', '新的陈词'];
  const canon = { book: '序章：星海无垠。新的陈词。', reference: 'XYZ之光' };
  const r = dropCanonCliches(assembled, canon, parent);
  assert.deepEqual(r.dropped, ['新的陈词']);
  assert.deepEqual(r.candidate['cliche_list'], ['星海无垠', 'XYZ之光']);
  // Unchanged inherited list: nothing dropped, and validation sees only the bars change.
  const plain = assembleCandidate(out, { version: 'v2', parent: 'v1', createdAt: '2026-09-02T00:00:00.000Z', model: 'm' });
  const kept = dropCanonCliches(plain, canon, parent);
  assert.deepEqual(kept.dropped, []);
  const bench = benchContext(FORGE, protocol(), 3, []);
  if (!bench.ok) throw new Error(bench.error);
  const verdict = validateBenchmark(kept.candidate, parent, bench.value);
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.changedKeys, ['bars']);
});
