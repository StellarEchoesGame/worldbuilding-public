import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { decisivePick, parseReplayResult, replayPlan, replayTaskId, runReplay, scoreReplay, type ReplayCall, type ReplayResult, type ReplayVersion } from './bench-replay.ts';
import { loadConfig, type Family } from './config.ts';
import { buildContext, type RoundBackends, type StepContext } from './context.ts';
import { isRecord, type JsonRecord } from './json.ts';
import { roundPaths, sha256 } from './store.ts';
import { IntegrityError } from './task.ts';
import { unwrap } from './tasks/fenced.ts';
import type { Order } from './tasks/ids.ts';
import { DEFAULT_FIXTURE, FIXTURE_WRITER_MODEL, fixtureWorld } from './testing/fixture-world.ts';
import { fakePorts } from './testing/fakes.ts';
import { callLog, fakeRouter, type FakeRouter, type Route } from './testing/scripted.ts';
import { LABELS_FILE, readLabelLedger, reserveLabels, type Label, type LabelText } from './trust.ts';

function text(id: string, author: Family): LabelText {
  return { id, path: `calibration/texts/${id}.md`, sha256: id.length.toString(16).padStart(64, '0'), authors: [author] };
}

function label(id: string, a: Family, b: Family): Label {
  return { id, source: 'round0', round: 'C00', seq: Number(id.slice(-2)), texts: [text(`${id}-a`, a), text(`${id}-b`, b)], owner_chosen: `${id}-a`, answered_at: '2026-09-02T00:00:00Z', split: 'reserve', use: 'qualification', trials: {} };
}

const FAMILIES: readonly Family[] = ['Anthropic', 'Moonshot', 'OpenAI', 'xAI'];
const VERSIONS: readonly ReplayVersion[] = ['old', 'new'];
const ORDERS: readonly Order[] = ['fwd', 'rev'];

/** Plan of `labels` × `families` (no author exclusion) in base order, for scoring tests. */
function plan(labels: readonly string[], families: readonly Family[]): ReplayCall[] {
  const out: ReplayCall[] = [];
  for (const l of labels) for (const family of families) for (const version of VERSIONS) for (const order of ORDERS) out.push({ family, label: l, version, order });
  return out;
}

/** Every call agrees except where `against` returns true (answers against the owner) or `voided` (null). */
function verdicts(calls: readonly ReplayCall[], against: (c: ReplayCall) => boolean, voided: (c: ReplayCall) => boolean = () => false): Map<string, boolean | null> {
  return new Map(calls.map((c) => [replayTaskId(c), voided(c) ? null : !against(c)]));
}

const LABELS = ['C00-P01', 'C00-P02', 'C00-P03'];

test('replayTaskId: replay-<label>-<family>-<old|new>-<fwd|rev> (task-id kind replay)', () => {
  assert.equal(replayTaskId({ family: 'Moonshot', label: 'R01-audit-2', version: 'new', order: 'rev' }), 'replay-R01-audit-2-Moonshot-new-rev');
  assert.equal(replayTaskId({ family: 'xAI', label: 'C00-P03', version: 'old', order: 'fwd' }), 'replay-C00-P03-xAI-old-fwd');
});

test('scoreReplay: equal agreement old vs new → pass (ok)', () => {
  const p = plan(LABELS, FAMILIES);
  const s = scoreReplay(p, verdicts(p, () => false), 4);
  assert.deepEqual(s.pooled, { old: 12, new: 12, n: 12 });
  assert.equal(s.passed, true);
  assert.equal(s.reason, 'ok');
  assert.deepEqual(s.per_family['Moonshot'], { old: 3, new: 3, n: 3, void: 0 });
  assert.deepEqual(s.families, ['Anthropic', 'Moonshot', 'OpenAI', 'xAI']);
  assert.deepEqual(s.labels, LABELS);
});

test('scoreReplay: a trial agrees only when both orders pick the owner text', () => {
  const p = plan(['C00-P01'], ['xAI']);
  const s = scoreReplay(p, verdicts(p, (c) => c.version === 'new' && c.order === 'rev'), 1);
  assert.deepEqual(s.pooled, { old: 1, new: 0, n: 1 });
  assert.equal(s.reason, 'pooled_lower');
  assert.equal(s.passed, false);
});

test('scoreReplay: pooled new below old → pooled_lower', () => {
  const p = plan(LABELS, FAMILIES);
  const s = scoreReplay(p, verdicts(p, (c) => c.version === 'new' && c.label === 'C00-P01' && c.family === 'xAI'), 4);
  assert.deepEqual(s.pooled, { old: 12, new: 11, n: 12 });
  assert.equal(s.reason, 'pooled_lower');
});

test('scoreReplay: one family loses 2 while pooled stays equal → family_drop', () => {
  const p = plan(LABELS, FAMILIES);
  const lost = (c: ReplayCall): boolean => c.family === 'Moonshot' && c.version === 'new' && c.label !== 'C00-P03';
  const gained = (c: ReplayCall): boolean => c.family === 'OpenAI' && c.version === 'old' && c.label !== 'C00-P03';
  const s = scoreReplay(p, verdicts(p, (c) => lost(c) || gained(c)), 4);
  assert.deepEqual(s.pooled, { old: 10, new: 10, n: 12 });
  assert.deepEqual(s.per_family['Moonshot'], { old: 3, new: 1, n: 3, void: 0 });
  assert.equal(s.reason, 'family_drop');
  assert.equal(s.passed, false);
});

test('scoreReplay: pooled up but one family −2 → family_drop; −1 only → ok', () => {
  const p = plan(LABELS, FAMILIES);
  const others = (c: ReplayCall): boolean => c.family !== 'Moonshot' && c.version === 'old' && c.label === 'C00-P01';
  const two = scoreReplay(p, verdicts(p, (c) => others(c) || (c.family === 'Moonshot' && c.version === 'new' && c.label !== 'C00-P03')), 4);
  assert.ok(two.pooled.new > two.pooled.old);
  assert.equal(two.reason, 'family_drop');
  const one = scoreReplay(p, verdicts(p, (c) => others(c) || (c.family === 'Moonshot' && c.version === 'new' && c.label === 'C00-P01')), 4);
  assert.equal(one.reason, 'ok');
  assert.equal(one.passed, true);
});

test('scoreReplay: a void call under either version removes the (family, label) from both sides and counts void', () => {
  const p = plan(LABELS, FAMILIES);
  const s = scoreReplay(p, verdicts(p, (c) => c.family === 'xAI' && c.version === 'old' && c.label === 'C00-P02', (c) => c.family === 'xAI' && c.version === 'new' && c.label === 'C00-P02' && c.order === 'fwd'), 4);
  assert.deepEqual(s.per_family['xAI'], { old: 2, new: 2, n: 2, void: 1 });
  assert.deepEqual(s.pooled, { old: 11, new: 11, n: 11 });
  assert.equal(s.reason, 'ok');
});

test('scoreReplay: a missing verdict counts as void', () => {
  const p = plan(['C00-P01'], ['xAI']);
  const v = verdicts(p, () => false);
  v.delete(replayTaskId({ family: 'xAI', label: 'C00-P01', version: 'old', order: 'rev' }));
  assert.deepEqual(scoreReplay(p, v, 1).per_family['xAI'], { old: 0, new: 0, n: 0, void: 1 });
});

test('scoreReplay: n_pooled below the floor → too_few_pairs (even when new ≥ old)', () => {
  const p = plan(['C00-P01'], ['Anthropic', 'Moonshot', 'OpenAI']);
  const s = scoreReplay(p, verdicts(p, () => false), 4);
  assert.equal(s.pooled.n, 3);
  assert.equal(s.reason, 'too_few_pairs');
  assert.equal(s.passed, false);
  const voided = scoreReplay(plan(LABELS, ['xAI']), verdicts(plan(LABELS, ['xAI']), () => false, (c) => c.label !== 'C00-P01'), 1);
  assert.deepEqual(voided.pooled, { old: 1, new: 1, n: 1 });
  assert.equal(voided.reason, 'ok');
});

test('replayPlan: families authoring either text are excluded per label; both orders under both versions', () => {
  const labels = [label('C00-P01', 'OpenAI', 'DeepSeek'), label('C00-P02', 'DeepSeek', 'Moonshot'), label('C00-P03', 'DeepSeek', 'DeepSeek')];
  const p = replayPlan(labels, FAMILIES, 'seed-a');
  const of = (l: string): string[] => [...new Set(p.filter((c) => c.label === l).map((c) => c.family))].sort();
  assert.deepEqual(of('C00-P01'), ['Anthropic', 'Moonshot', 'xAI']);
  assert.deepEqual(of('C00-P02'), ['Anthropic', 'OpenAI', 'xAI']);
  assert.deepEqual(of('C00-P03'), ['Anthropic', 'Moonshot', 'OpenAI', 'xAI']);
  assert.equal(p.length, (3 + 3 + 4) * 4);
  const ids = p.map(replayTaskId);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of p.filter((x) => x.label === 'C00-P01' && x.family === 'xAI')) assert.ok(ids.includes(replayTaskId(c)));
  assert.equal(p.filter((c) => c.label === 'C00-P01' && c.family === 'xAI').length, 4);
});

test('replayPlan: seeded interleave of old and new (deterministic per seed, not grouped by version)', () => {
  const labels = ['C00-P01', 'C00-P02', 'C00-P03', 'C00-P04'].map((id) => label(id, 'DeepSeek', 'DeepSeek'));
  const a = replayPlan(labels, FAMILIES, 'seed-a');
  assert.deepEqual(replayPlan(labels, FAMILIES, 'seed-a'), a);
  assert.notDeepEqual(replayPlan(labels, FAMILIES, 'seed-b').map(replayTaskId), a.map(replayTaskId));
  const versions = a.map((c) => c.version);
  const firstNew = versions.indexOf('new');
  const lastOld = versions.lastIndexOf('old');
  assert.ok(firstNew < lastOld, 'old and new calls are interleaved, not all old first');
  assert.equal(versions.filter((v) => v === 'old').length, versions.length / 2);
});

test('decisivePick: the answer on the decisive question; none is an IntegrityError (runner integrity path), never a plain Error', () => {
  const id = 'replay-C00-P01-xAI-old-fwd';
  assert.equal(decisivePick(id, { q1: 2, q2: 1 }, 'q2'), 1);
  assert.throws(() => decisivePick(id, { q1: 2 }, 'q2'), (e: unknown) => e instanceof IntegrityError && e.message === `${id}: the verdict has no answer to q2`);
  assert.throws(() => decisivePick(id, { q1: 2 }, 'toString'), IntegrityError, 'an inherited key is no answer');
});

test('replayPlan: no labels or no families → empty plan', () => {
  assert.deepEqual(replayPlan([], FAMILIES, 's'), []);
  assert.deepEqual(replayPlan([label('C00-P01', 'DeepSeek', 'DeepSeek')], [], 's'), []);
});

function result(): ReplayResult {
  const p = plan(['C00-P01', 'C00-P02'], ['Moonshot', 'xAI']);
  const v = verdicts(p, (c) => c.family === 'Moonshot' && c.version === 'new', (c) => c.family === 'xAI' && c.label === 'C00-P02' && c.order === 'rev');
  return { old_version: 'v2', new_version: 'v3', plan: p, verdicts: Object.fromEntries(v), summary: scoreReplay(p, v, 1) };
}

test('parseReplayResult: round-trips a result through JSON', () => {
  const r = result();
  const back = parseReplayResult(JSON.parse(JSON.stringify(r)), 1);
  assert.ok(back.ok);
  assert.deepEqual(back.value, r);
  assert.equal(r.summary.reason, 'pooled_lower');
});

test('parseReplayResult: rejects malformed files', () => {
  const r = result();
  const bad = (edit: (x: Record<string, unknown>) => void): boolean => {
    const x: Record<string, unknown> = JSON.parse(JSON.stringify(r));
    edit(x);
    return !parseReplayResult(x, 1).ok;
  };
  assert.ok(bad((x) => { x['old_version'] = 3; }));
  assert.ok(bad((x) => { x['plan'] = [{ family: 'Nobody', label: 'C00-P01', version: 'old', order: 'fwd' }]; }));
  assert.ok(bad((x) => { x['plan'] = [{ family: 'xAI', label: 'C00-P01', version: 'older', order: 'fwd' }]; }));
  assert.ok(bad((x) => { x['verdicts'] = { 'replay-C00-P01-xAI-old-fwd': 'yes' }; }), 'a verdict is true, false or null');
  assert.ok(bad((x) => { x['verdicts'] = {}; }), 'verdict keys equal the plan task ids');
  assert.ok(bad((x) => { x['summary'] = { ...r.summary, reason: 'fine' }; }));
  assert.ok(bad((x) => { x['summary'] = { ...r.summary, passed: true }; }), 'the summary must be the plan verdicts scored');
  assert.ok(!parseReplayResult(null, 1).ok);
});

test('parseReplayResult: the reason must be the one scored at the protocol floor (minPairs); too_few_pairs is not a free claim', () => {
  const r = result();
  assert.equal(r.summary.pooled.n, 3);
  const forged = { ...r, summary: { ...r.summary, reason: 'too_few_pairs', passed: false } };
  const rejected = parseReplayResult(JSON.parse(JSON.stringify(forged)), 1);
  assert.ok(!rejected.ok && /reason too_few_pairs contradicts the counts \(pooled_lower\)/u.test(rejected.error), rejected.ok ? 'accepted' : rejected.error);
  const p = r.plan;
  const tooFew: ReplayResult = { ...r, summary: scoreReplay(p, new Map(Object.entries(r.verdicts)), 4) };
  assert.equal(tooFew.summary.reason, 'too_few_pairs');
  const back = parseReplayResult(JSON.parse(JSON.stringify(tooFew)), 4);
  assert.ok(back.ok, back.ok ? '' : back.error);
  assert.deepEqual(back.value, tooFew);
  assert.ok(!parseReplayResult(JSON.parse(JSON.stringify(tooFew)), 1).ok, 'n = 3 meets a floor of 1');
  assert.ok(!parseReplayResult(JSON.parse(JSON.stringify(r)), 4).ok, 'n = 3 misses a floor of 4: pooled_lower is not the scored reason');
});

/* runReplay on a fixture world: six C00 reserve labels whose owner text carries OWNER_MARK. */

const OWNER_MARK = '主人选中的这一篇';
const REPLAY_Q = '哪一篇里的地方，你读完还想再回去看一眼？';

function fence(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

/** Honest replay judge (picks OWNER_MARK); `against(family, label, isNew)` flips the pick. */
function replayRoute(family: Family, against: (family: Family, label: string, isNew: boolean) => boolean): Route {
  return (prompt, _n, meta) => {
    const t1 = unwrap(prompt, '文本甲') ?? '';
    const t2 = unwrap(prompt, '文本乙') ?? '';
    const label = /^replay-(C00-P\d{2})-/u.exec(meta.taskId)?.[1] ?? '';
    const honest = t1.includes(OWNER_MARK) ? 1 : 2;
    const pick = against(family, label, prompt.includes(REPLAY_Q)) ? 3 - honest : honest;
    const quote = [...(pick === 1 ? t1 : t2)].slice(0, 12).join('');
    return fence({ answers: { q1: { pick, quote }, q2: { pick, quote } } });
  };
}

interface ReplayWorld {
  ctx: StepContext;
  root: string;
  judges: FakeRouter[];
  oldV: JsonRecord;
  newV: JsonRecord;
}

function put(root: string, rel: string, text: string): string {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
  return sha256(text);
}

/** Label k: texts T(2k-1) (owner's) and T(2k); P01, P02 authored by OpenAI, the rest by DeepSeek. */
function ledger(root: string): void {
  const labels = [1, 2, 3, 4, 5, 6].map((k) => {
    const id = `C00-P0${k}`;
    const author: Family = k <= 2 ? 'OpenAI' : 'DeepSeek';
    const texts = [0, 1].map((j) => {
      const tid = `C00-T${String(2 * k - 1 + j).padStart(2, '0')}`;
      const body = j === 0 ? `${OWNER_MARK}，第${k}个邻里的循环泵在夜里换了节拍。` : `第${k}个邻里的走廊很安静，灯一盏一盏熄了。`;
      return { id: tid, path: `calibration/texts/${tid}.md`, sha256: put(root, `calibration/texts/${tid}.md`, body), authors: [author] };
    });
    return { id, source: 'round0', round: 'C00', seq: k, texts, owner_chosen: texts[0]?.id ?? '', answered_at: '2026-09-02T00:00:00Z', split: 'reserve', use: 'qualification', trials: {} };
  });
  put(root, LABELS_FILE, `${JSON.stringify({ schema: 'calib-labels/1', labels }, null, 2)}\n`);
}

function replayWorld(against: (family: Family, label: string, isNew: boolean) => boolean): ReplayWorld {
  const w = fixtureWorld(mkdtempSync(join(tmpdir(), 'forge-replay-')), DEFAULT_FIXTURE);
  const loaded = loadConfig(w.root, { requireLocal: true });
  if (!loaded.ok) throw new Error(loaded.error);
  ledger(w.root);
  const hex = 'a'.repeat(64);
  put(w.root, 'rounds/R01/start.json', JSON.stringify({ round: 'R01', seed: 'replay-seed', branch: 'forge/r01', base_sha: 'base', issue: { number: 2, url: 'https://example.invalid/2' }, bundle_sha256: hex, doctor_sha256: hex, started_at: '2026-10-01T00:00:00.000Z', cell: null }));
  const plain = fakeRouter({}, { id: 'W1', family: 'DeepSeek', model: FIXTURE_WRITER_MODEL });
  const judges = loaded.value.judges.map((j) => fakeRouter({ replay: replayRoute(j.family, against) }, { id: j.id, family: j.family, model: j.model }));
  const backends: RoundBackends = {
    writers: [{ slot: 'W1', backend: plain }], baseline: plain, decoy: plain, defect: plain, judges: judges.map((backend) => ({ backend, concurrency: 2 })), forecasters: [], maintainer: plain, mergeEditor: plain, calibGateway: new Map(),
  };
  const built = buildContext({
    root: w.root, repo: w.repo, roundId: 'R01', pipeline: 'round', paths: roundPaths(w.root, 'R01'), config: loaded.value,
    deps: { ports: fakePorts({ repoDir: w.repo, main: w.main, startIso: '2026-10-01T00:00:00.000Z', seed: 'replay' }), backends: () => backends, env: {}, pid: 1, isAlive: () => true, log: () => undefined },
    startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
  });
  if (!built.ok) throw new Error(built.error);
  const oldRaw: unknown = JSON.parse(readFileSync(join(w.root, 'benchmark/v1.json'), 'utf8'));
  if (!isRecord(oldRaw) || !isRecord(oldRaw['taste'])) throw new Error('fixture v1 has no taste');
  const taste = oldRaw['taste'];
  const questions = Array.isArray(taste['questions']) ? taste['questions'] : [];
  const newV: JsonRecord = { ...oldRaw, version: 'v2', parent: 'v1', taste: { ...taste, questions: questions.map((q, i) => (i === 0 && isRecord(q) ? { ...q, text: REPLAY_Q } : q)) } };
  return { ctx: built.value, root: w.root, judges, oldV: oldRaw, newV };
}

const JUDGE_FAMILIES: readonly Family[] = ['Anthropic', 'Moonshot', 'OpenAI', 'xAI'];

function allCalls(judges: readonly FakeRouter[]): string[] {
  return judges.flatMap((j) => callLog(j));
}

test('runReplay: reserve labels newest first, authors excluded, both orders under both versions; Moonshot −2 on new → family_drop', async () => {
  const x = replayWorld((family, label, isNew) => (family === 'Moonshot' && isNew && (label === 'C00-P03' || label === 'C00-P04')) || (family === 'OpenAI' && !isNew && (label === 'C00-P05' || label === 'C00-P06')));
  const r = await runReplay(x.ctx, x.oldV, x.newV, JUDGE_FAMILIES);
  assert.equal(r.old_version, 'v1');
  assert.equal(r.new_version, 'v2');
  assert.deepEqual(r.summary.labels, ['C00-P06', 'C00-P05', 'C00-P04', 'C00-P03', 'C00-P02', 'C00-P01']);
  assert.deepEqual(r.summary.families, JUDGE_FAMILIES);
  assert.deepEqual(r.summary.pooled, { old: 20, new: 20, n: 22 });
  assert.deepEqual(r.summary.per_family['Moonshot'], { old: 6, new: 4, n: 6, void: 0 });
  assert.deepEqual(r.summary.per_family['OpenAI'], { old: 2, new: 4, n: 4, void: 0 });
  assert.equal(r.summary.reason, 'family_drop');
  assert.equal(r.summary.passed, false);
  const calls = allCalls(x.judges);
  assert.equal(calls.length, r.plan.length);
  assert.equal(r.plan.length, 22 * 4);
  assert.ok(calls.every((c) => c.startsWith('replay-')));
  assert.ok(!calls.some((c) => /^replay-C00-P0[12]-OpenAI-/u.test(c)), 'OpenAI authored P01 / P02');
  const ledgerNow = readLabelLedger(x.root);
  assert.ok(ledgerNow !== null && ledgerNow.ok);
  assert.deepEqual(r.plan, replayPlan(reserveLabels(ledgerNow.value, 16), JUDGE_FAMILIES, 'replay-seed'), 'the plan is replayPlan over the reserve labels with the round seed');
  const parsed = parseReplayResult(JSON.parse(JSON.stringify(r)), x.ctx.protocol.calibration.replayMinPairs);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
});

test('runReplay: equal answers pass; a rerun reuses every task record (no new call) and returns the same result', async () => {
  const x = replayWorld(() => false);
  const first = await runReplay(x.ctx, x.oldV, x.newV, JUDGE_FAMILIES);
  assert.equal(first.summary.reason, 'ok');
  assert.ok(first.summary.passed);
  const before = allCalls(x.judges).length;
  const again = await runReplay(x.ctx, x.oldV, x.newV, JUDGE_FAMILIES);
  assert.equal(allCalls(x.judges).length, before);
  assert.deepEqual(again, first);
});

test('runReplay: a void call (no parseable answer after the retry) removes that (family, label) from both sides', async () => {
  const x = replayWorld(() => false);
  const xai = x.judges.find((j) => j.family === 'xAI');
  assert.ok(xai !== undefined);
  const judges = x.ctx.backends.judges.map((j) => (j.backend.family === 'xAI' ? { ...j, backend: fakeRouter({ replay: (p, n, meta) => (meta.taskId === 'replay-C00-P04-xAI-new-rev' ? 'no fence' : replayRoute('xAI', () => false)(p, n, meta)) }, { id: xai.id, family: 'xAI', model: xai.model }) } : j));
  const ctx: StepContext = { ...x.ctx, backends: { ...x.ctx.backends, judges } };
  const r = await runReplay(ctx, x.oldV, x.newV, JUDGE_FAMILIES);
  assert.equal(r.verdicts['replay-C00-P04-xAI-new-rev'], null);
  assert.deepEqual(r.summary.per_family['xAI'], { old: 5, new: 5, n: 5, void: 1 });
});

test('runReplay: a label text that no longer matches its ledger hash → IntegrityError before any call; no ledger → IntegrityError', async () => {
  const x = replayWorld(() => false);
  writeFileSync(join(x.root, 'calibration/texts/C00-T05.md'), '被改过的文本，已经不是标注时的样子。');
  await assert.rejects(runReplay(x.ctx, x.oldV, x.newV, JUDGE_FAMILIES), (e: unknown) => e instanceof IntegrityError && e.message.includes('C00-T05'));
  assert.equal(allCalls(x.judges).length, 0);
  writeFileSync(join(x.root, LABELS_FILE), '{"schema": "calib-labels/1", "labels": "nope"}\n');
  await assert.rejects(runReplay(x.ctx, x.oldV, x.newV, JUDGE_FAMILIES), IntegrityError);
});

test('runReplay: at most replayMaxPairs labels; a family without a judge backend → IntegrityError', async () => {
  const x = replayWorld(() => false);
  const ctx: StepContext = { ...x.ctx, protocol: { ...x.ctx.protocol, calibration: { ...x.ctx.protocol.calibration, replayMaxPairs: 2 } } };
  const r = await runReplay(ctx, x.oldV, x.newV, ['xAI']);
  assert.deepEqual(r.summary.labels, ['C00-P06', 'C00-P05']);
  assert.equal(r.summary.reason, 'too_few_pairs');
  const back = parseReplayResult(JSON.parse(JSON.stringify(r)), ctx.protocol.calibration.replayMinPairs);
  assert.ok(back.ok, back.ok ? '' : back.error);
  await assert.rejects(runReplay(x.ctx, x.oldV, x.newV, ['Zhipu']), (e: unknown) => e instanceof IntegrityError && e.message.includes('Zhipu'));
});
