import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fakeBackend } from './adapters/fake.ts';
import { calibPaths, type CalibPairRecord, type CalibSetRecord, type DisplayRecord } from './calib-build.ts';
import { CALIB_ORDERS, calibTaskId, dryrunPath, PIN_FILE, verdictPath, type CalibPin, type DryrunVerdictRecord, type VerdictRecord } from './calib-run.ts';
import {
  calibReport, dryrunScore, ownerRetest, pairOutcome, parseCalibReport, readCalibReports, recommendWriter, reportPath, scoreFamily, scoreStep, writerModels,
  type CalibReport, type PairOutcome, type WriterModelRow,
} from './calib-score.ts';
import { loadConfig, type Family } from './config.ts';
import { readRecord } from './json.ts';
import { buildContext, type RoundBackends, type StepContext } from './context.ts';
import { calibSet, ownerInputs, type CalibAnswer } from './owner-inputs.ts';
import { loadProtocolBundle } from './rules.ts';
import type { CalibCategory, ProtocolCalibration } from './protocol.ts';
import { canonicalJson } from './seal.ts';
import { sha256 } from './store.ts';
import { IntegrityError } from './task.ts';
import { fakePorts } from './testing/fakes.ts';
import { DEFAULT_FIXTURE, fixtureWorld, type FixtureWorld } from './testing/fixture-world.ts';
import { ownerSim, type OwnerSim } from './testing/owner-sim.ts';

function calibration(): ProtocolCalibration {
  const bundle = loadProtocolBundle(join(import.meta.dirname, '..'));
  if (!bundle.ok) throw new Error(bundle.error);
  return bundle.value.protocol.calibration;
}

const CAL = calibration();

function pair(id: string, category: CalibCategory, known = false): CalibPairRecord {
  return { id, category, a: 'C00-T01', b: 'C00-T02', known_better: known ? 'C00-T01' : null, authors: ['DeepSeek'], split: 'visible' };
}

function call(order: 'ab' | 'ba', decisive: string | null): VerdictRecord {
  const [text1, text2] = order === 'ab' ? ['C00-T01', 'C00-T02'] : ['C00-T02', 'C00-T01'];
  const family: Family = 'Moonshot';
  const base = { pair: 'C00-P01', family, judge: 'kimi', order, text1, text2, call: calibTaskId('C00-P01', 'kimi', order), benchmark_version: 'v1' };
  if (decisive === null) return { ...base, status: 'void', decisive: null, picks: {}, quotes: {}, error: 'unfenced' };
  return { ...base, status: 'ok', decisive, picks: { q1: decisive }, quotes: { q1: 'x' }, error: null };
}

test('pairOutcome truth table: agree needs both orders ok on the owner text; split → inconsistent; void → no agreement, counted', () => {
  const p = pair('C00-P01', 'known', true);
  const T1 = 'C00-T01';
  const T2 = 'C00-T02';
  const row = (ab: string | null, ba: string | null, owner: string): Omit<PairOutcome, 'pair' | 'category'> => {
    const { pair: _p, category: _c, ...rest } = pairOutcome(p, owner, call('ab', ab), call('ba', ba));
    return rest;
  };
  assert.deepEqual(row(T1, T1, T1), { judged: true, consistent: true, agree: true, knownCorrect: true, void: 0 });
  assert.deepEqual(row(T2, T2, T1), { judged: true, consistent: true, agree: false, knownCorrect: false, void: 0 });
  assert.deepEqual(row(T1, T2, T1), { judged: true, consistent: false, agree: false, knownCorrect: false, void: 0 });
  assert.deepEqual(row(T1, null, T1), { judged: true, consistent: false, agree: false, knownCorrect: false, void: 1 });
  assert.deepEqual(row(null, null, T1), { judged: true, consistent: false, agree: false, knownCorrect: false, void: 2 });
  const { pair: _p, category: _c, ...unjudged } = pairOutcome(pair('C00-P02', 'stance'), T1, null, null);
  assert.deepEqual(unjudged, { judged: false, consistent: false, agree: false, knownCorrect: null, void: 0 });
});

/** m non-known outcomes (`agree` of them agreeing, spread over the non-known categories) and k known (`correct` right). */
function outcomes(agree: number, m: number, correct: number, k: number): PairOutcome[] {
  const cats: CalibCategory[] = ['cross_model', 'stance', 'canon_vs_rewrite'];
  const nonknown = Array.from({ length: m }, (_, i): PairOutcome => ({
    pair: `C00-P${i}`, category: cats[i % 3] ?? 'stance', judged: true, consistent: i < agree, agree: i < agree, knownCorrect: null, void: 0,
  }));
  const known = Array.from({ length: k }, (_, i): PairOutcome => ({
    pair: `C00-K${i}`, category: 'known', judged: true, consistent: i < correct, agree: false, knownCorrect: i < correct, void: 0,
  }));
  const author: PairOutcome = { pair: 'C00-PX', category: 'stance', judged: false, consistent: false, agree: false, knownCorrect: null, void: 0 };
  return [...nonknown, ...known, author];
}

test('scoreFamily: round 0 13/18 + 5/6 qualifies, 12/18 or 4/6 does not, OpenAI 9/12 qualifies; requal 8/9 + 3/3 passes, 9/9 + 2/3 fails', () => {
  const q = (a: number, m: number, c: number, k: number, kind: 'round0' | 'requal' = 'round0'): boolean => scoreFamily('Moonshot', outcomes(a, m, c, k), kind, CAL).qualified;
  assert.equal(q(13, 18, 5, 6), true);
  assert.equal(q(12, 18, 6, 6), false);
  assert.equal(q(13, 18, 4, 6), false);
  assert.equal(q(9, 12, 5, 6), true);
  assert.equal(q(8, 12, 6, 6), false);
  assert.equal(q(8, 9, 3, 3, 'requal'), true);
  assert.equal(q(9, 9, 2, 3, 'requal'), false);
  assert.equal(q(7, 9, 3, 3, 'requal'), false);
  const s = scoreFamily('OpenAI', outcomes(10, 12, 6, 6), 'round0', CAL);
  assert.deepEqual([s.nonknown.m, s.nonknown.agree, s.nonknown.need, s.known.k, s.known.correct, s.known.need], [12, 10, 9, 6, 6, 5]);
  assert.deepEqual(s.orderConsistency, { n: 18, consistent: 16 });
  assert.deepEqual(s.byCategory, { canon_vs_rewrite: { m: 4, agree: 3 }, cross_model: { m: 4, agree: 4 }, stance: { m: 4, agree: 3 } });
  assert.ok(s.nonknown.wilson90.lo > 0.5 && s.nonknown.wilson90.hi < 1);
  assert.equal(scoreFamily('xAI', outcomes(0, 0, 0, 0), 'round0', CAL).qualified, false, 'a family that judged nothing never qualifies');
});

function answer(slot: number, pairId: string, chosen: string, ms: number | null = null): CalibAnswer {
  return { slot, pair: pairId, left: 'C00-T01', right: 'C00-T02', choice: chosen === 'C00-T01' ? 'left' : 'right', chosen, answered_at: '2026-10-01T00:00:00.000Z', ms };
}

test('ownerRetest: 3 of 4 retests repeat the first choice', () => {
  const display: DisplayRecord[] = [1, 2, 3, 4].map((n) => ({ slot: n, pair: `C00-P0${n}`, left: 'C00-T01', right: 'C00-T02', retest_of: null }));
  for (const n of [1, 2, 3, 4]) display.push({ slot: 24 + n, pair: `C00-P0${n}`, left: 'C00-T02', right: 'C00-T01', retest_of: n });
  const answers = [1, 2, 3, 4].flatMap((n) => [answer(n, `C00-P0${n}`, 'C00-T01'), answer(24 + n, `C00-P0${n}`, n === 4 ? 'C00-T02' : 'C00-T01')]);
  const r = ownerRetest(display, answers, CAL.intervalZ);
  assert.deepEqual([r.n, r.consistent], [4, 3]);
  assert.ok(r.wilson90.lo > 0.2 && r.wilson90.hi < 1);
});

test('writerModels counts first answers and ok panel calls per model; recommendWriter: best rate with ownerN ≥ 2, ties → current default', () => {
  const texts = (model: string | null): CalibSetRecord['texts'][string] => ({
    path: 'texts/x.md', sha256: 'a'.repeat(64), role: model === null ? 'passage' : 'rewrite', model, author_family: 'DeepSeek', stance: null, source: null, of: null, call: null,
  });
  const set: CalibSetRecord = {
    kind: 'round0', family: null, reason: null, seed: 'ab'.repeat(8), built_at: '2026-10-01T00:00:00.000Z', size: 3,
    texts: { 'C00-T01': texts(null), 'C00-T02': texts('m-a'), 'C00-T03': texts('m-a'), 'C00-T04': texts('m-b') },
    pairs: [
      { ...pair('C00-P01', 'canon_vs_rewrite'), a: 'C00-T01', b: 'C00-T02' },
      { ...pair('C00-P02', 'cross_model'), a: 'C00-T03', b: 'C00-T04' },
      { ...pair('C00-P03', 'stance'), a: 'C00-T02', b: 'C00-T03' },
    ],
    display: [
      { slot: 1, pair: 'C00-P01', left: 'C00-T01', right: 'C00-T02', retest_of: null }, { slot: 2, pair: 'C00-P02', left: 'C00-T03', right: 'C00-T04', retest_of: null },
      { slot: 3, pair: 'C00-P02', left: 'C00-T04', right: 'C00-T03', retest_of: 2 },
    ],
    dryrun: [],
  };
  const answers = [answer(1, 'C00-P01', 'C00-T02'), answer(2, 'C00-P02', 'C00-T04'), answer(3, 'C00-P02', 'C00-T03')];
  const v = (pairId: string, decisive: string | null): VerdictRecord => ({ ...call('ab', decisive), pair: pairId });
  const rows = writerModels(set, answers, [v('C00-P01', 'C00-T02'), v('C00-P02', 'C00-T03'), v('C00-P02', null), v('C00-P03', 'C00-T02')]);
  assert.deepEqual(rows, [
    { model: 'm-a', ownerWins: 1, ownerN: 2, panelWins: 2, panelN: 2 },
    { model: 'm-b', ownerWins: 1, ownerN: 1, panelWins: 0, panelN: 1 },
  ]);
  const row = (model: string, ownerWins: number, ownerN: number): WriterModelRow => ({ model, ownerWins, ownerN, panelWins: 0, panelN: 0 });
  assert.equal(recommendWriter([row('m-a', 3, 4), row('m-b', 1, 2), row('m-c', 1, 1)], 'default'), 'm-a');
  assert.equal(recommendWriter([row('m-a', 2, 4), row('m-b', 1, 2)], 'default'), 'default');
  assert.equal(recommendWriter([row('m-a', 1, 1)], 'default'), 'default');
  assert.equal(recommendWriter([], 'default'), 'default');
});

test('dryrunScore: gate_judge iff of − caught ≤ maxMiss and of > 0', () => {
  const rec = (caught: boolean): DryrunVerdictRecord => ({ id: 'C00-G1', family: 'xAI', judge: 'grok', model: 'grok-model', copy: 'C00-T09', status: 'ok', caught, error: null, call: 'gate-C00-G1-xAI' });
  assert.deepEqual(dryrunScore([rec(true), rec(true), rec(true), rec(false)], 1), { caught: 3, of: 4, gateJudge: true });
  assert.deepEqual(dryrunScore([rec(true), rec(true), rec(false), rec(false)], 1), { caught: 2, of: 4, gateJudge: false });
  assert.deepEqual(dryrunScore([], 1), { caught: 0, of: 0, gateJudge: false });
});

test('reportPath per set kind; the report schema repeats one family schema for every family', () => {
  assert.deepEqual(['C00', 'Q01', 'G02'].map(reportPath), ['calibration/round0.json', 'calibration/requal-Q01.json', 'calibration/gate-G02.json']);
  assert.throws(() => reportPath('R01'));
  const schema: unknown = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'schema', 'calib-report.schema.json'), 'utf8'));
  const props = (key: string): string[] => Object.values(readRecord(readRecord(readRecord(schema, 'properties'), key), 'properties') ?? {}).map((v) => JSON.stringify(v));
  for (const key of ['families', 'gate_dryrun']) {
    assert.equal(props(key).length, 8);
    assert.equal(new Set(props(key)).size, 1, `${key}: every family has the same schema`);
  }
});

const PRIMARY = 'deepseek-fixture-a';
const JUDGES: ReadonlyArray<readonly [string, Family]> = [['codex', 'OpenAI'], ['claude', 'Anthropic'], ['kimi', 'Moonshot'], ['grok', 'xAI']];
const TEXT: Record<string, string> = {
  'C00-T01': '温芮在第一邻里修好了循环泵，林澈把菌毯卷好送回培养架。',
  'C00-T02': '温芮在第二邻里修好了冷凝管，林澈把滤网换好送回工具墙。',
  'C00-T03': '温芮在第三邻里修好了配给簿，林澈把扳手挂回编号牌下面。',
  'C00-T04': '温芮在第三邻里仿佛修好了配给簿，林澈把扳手挂回编号牌下面。',
};

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

/** P01 cross_model, P02 known (T03 better); slot 3 retests slot 1. */
function smallSet(): CalibSetRecord {
  const t = (id: string, model: string, family: Family, of: string | null): CalibSetRecord['texts'][string] => ({
    path: `texts/${id}.md`, sha256: sha256(TEXT[id] ?? ''), role: of === null ? 'rewrite' : 'degraded', model, author_family: family, stance: of === null ? 'resident-day' : null, source: null, of, call: 'calibrewrite-x',
  });
  const texts: CalibSetRecord['texts'] = {
    'C00-T01': t('C00-T01', PRIMARY, 'DeepSeek', null), 'C00-T02': t('C00-T02', 'qwen/fixture-b', 'Alibaba', null),
    'C00-T03': t('C00-T03', PRIMARY, 'DeepSeek', null), 'C00-T04': t('C00-T04', PRIMARY, 'DeepSeek', 'C00-T03'),
  };
  return {
    kind: 'round0', family: null, reason: null, seed: 'ab'.repeat(16), built_at: '2026-08-01T00:00:00.000Z', size: 3, texts,
    pairs: [
      { id: 'C00-P01', category: 'cross_model', a: 'C00-T01', b: 'C00-T02', known_better: null, authors: ['Alibaba', 'DeepSeek'], split: 'visible' },
      { id: 'C00-P02', category: 'known', a: 'C00-T03', b: 'C00-T04', known_better: 'C00-T03', authors: ['DeepSeek'], split: 'reserve' },
    ],
    display: [
      { slot: 1, pair: 'C00-P01', left: 'C00-T01', right: 'C00-T02', retest_of: null }, { slot: 2, pair: 'C00-P02', left: 'C00-T04', right: 'C00-T03', retest_of: null },
      { slot: 3, pair: 'C00-P01', left: 'C00-T02', right: 'C00-T01', retest_of: 1 },
    ],
    dryrun: [],
  };
}

interface W {
  w: FixtureWorld;
  ctx: StepContext;
  sim: OwnerSim;
}

/**
 * C00 after c4: set record + texts, owner answers stamped from `answeredAt` (left, unless the left text has 仿佛), pin.json,
 * and verdicts in which every family but xAI picks T01 / T03 in both orders (xAI always picks position 1).
 */
function scored(answeredAt: string, pinOver: Partial<CalibPin> = {}): W {
  const w = fixtureWorld(mkdtempSync(join(tmpdir(), 'forge-calib-score-')), { ...DEFAULT_FIXTURE, trust: 'none' });
  const set = smallSet();
  put(w.root, 'calibration/pairs.json', `${JSON.stringify({ schema: 'calib-pairs/1', sets: { C00: set } }, null, 2)}\n`);
  for (const [id, text] of Object.entries(TEXT)) put(w.root, `calibration/texts/${id}.md`, text);
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: answeredAt, seed: 'calib-score' });
  const sim = ownerSim(w.root, ports.clock);
  sim.answerCalibration('C00', (p) => (p.leftText.includes('仿佛') ? 'right' : 'left'));
  const config = loadConfig(w.root, { requireLocal: true });
  if (!config.ok) throw new Error(config.error);
  const b = fakeBackend('x', 'DeepSeek', () => '');
  const backends: RoundBackends = {
    writers: [], baseline: b, decoy: b, defect: b, judges: JUDGES.map(([id, f]) => ({ backend: fakeBackend(id, f, () => ''), concurrency: 1 })), forecasters: [], maintainer: b, mergeEditor: b, calibGateway: new Map(),
  };
  const built = buildContext({
    root: w.root, repo: w.repo, roundId: 'C00', pipeline: 'calibration', paths: calibPaths(w.root, 'C00'), config: config.value,
    deps: { ports, backends: () => backends, env: {}, pid: 7, isAlive: () => true, log: () => undefined }, startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
  });
  if (!built.ok) throw new Error(built.error);
  const ctx = built.value;
  const answers = ownerInputs(w.root).calibAnswers();
  const pairs = calibSet(w.root, 'C00');
  if (answers.state !== 'ok' || !pairs.ok) throw new Error('fixture: answers or pairs unreadable');
  const judges: CalibPin['judges'] = {};
  for (const [id, f] of JUDGES) judges[f] = { id, model: `fake-${id}` };
  const pin: CalibPin = {
    set: 'C00', benchmark_version: 'v1', benchmark_sha256: sha256(readFileSync(join(w.root, 'benchmark', 'v1.json'), 'utf8')), protocol_bundle_sha256: ctx.bundleSha256,
    pairs_sha256: pairs.value.pairsSha256, answers_sha256: sha256(canonicalJson(answers.value.sets['C00'])), judges, ...pinOver,
  };
  put(w.root, `calibration/C00/${PIN_FILE}`, `${JSON.stringify(pin, null, 2)}\n`);
  for (const p of set.pairs) {
    for (const [id, family] of JUDGES) {
      for (const order of CALIB_ORDERS) {
        const [text1, text2] = order === 'ab' ? [p.a, p.b] : [p.b, p.a];
        const decisive = family === 'xAI' ? text1 : p.a;
        const v: VerdictRecord = { pair: p.id, family, judge: id, order, text1, text2, status: 'ok', decisive, picks: { q1: decisive }, quotes: { q1: 'x' }, error: null, call: calibTaskId(p.id, id, order), benchmark_version: 'v1' };
        put(w.root, verdictPath(ctx.paths, family, p.id, order).slice(w.root.length + 1), `${JSON.stringify(v, null, 2)}\n`);
      }
    }
  }
  return { w, ctx, sim };
}

function report(ctx: StepContext): CalibReport {
  const built = calibReport(ctx);
  if (built.kind !== 'report') throw new Error('calibReport waited');
  return built.report;
}

test('valid C00 report: 3 qualified families may start canon rounds; owner, writer and pin fields; parseCalibReport round-trips', () => {
  const { w, ctx } = scored('2026-10-01T00:00:00.000Z');
  const r = report(ctx);
  assert.deepEqual([r.valid, r.invalid_reason, r.qualified, r.canon_rounds_may_start], [true, null, ['Anthropic', 'Moonshot', 'OpenAI'], true]);
  assert.deepEqual(r.families.xAI?.order_consistency, { n: 2, consistent: 0 });
  assert.deepEqual([r.families.OpenAI?.nonknown.m, r.families.OpenAI?.nonknown.agree, r.families.OpenAI?.known], [1, 1, { k: 1, correct: 1, need: 0 }]);
  assert.deepEqual(r.owner?.retest.n, 1);
  assert.deepEqual([r.owner?.retest.consistent, r.owner?.known, r.owner?.median_ms], [0, { n: 1, correct: 1 }, null]);
  assert.deepEqual(r.writer_models.map((m) => [m.model, m.owner_wins, m.owner_n]), [[PRIMARY, 1, 1], ['qwen/fixture-b', 0, 1]]);
  assert.deepEqual(r.writer_recommendation?.model, 'deepseek-fixture');
  assert.equal(r.pin_sha256, sha256(readFileSync(join(w.root, 'calibration', 'C00', PIN_FILE), 'utf8')));
  const copy: unknown = JSON.parse(JSON.stringify(r));
  assert.deepEqual(parseCalibReport(copy), { ok: true, value: r });
  assert.equal(parseCalibReport({ ...r, qualified: ['OpenAI'] }).ok, false);
  assert.equal(parseCalibReport({ ...r, valid: false, invalid_reason: 'x' }).ok, false, 'an invalid report qualifies nobody');
});

test('valid: false when v1 was not logged before the first C00 answer (equal time included), or the answers changed after the pin', () => {
  for (const at of ['2026-08-15T00:00:00.000Z', '2026-09-01T00:00:00.000Z']) {
    const r = report(scored(at).ctx);
    assert.equal(r.valid, false, at);
    assert.match(r.invalid_reason ?? '', /not before the first answer/u);
    assert.deepEqual([r.qualified, r.canon_rounds_may_start], [[], false]);
    assert.ok(Object.values(r.families).every((f) => !f.qualified));
  }
  const changed = report(scored('2026-10-01T00:00:00.000Z', { answers_sha256: 'e'.repeat(64) }).ctx);
  assert.deepEqual([changed.valid, changed.qualified], [false, []]);
  assert.match(changed.invalid_reason ?? '', /changed after c4-judge pinned it/u);
});

test('a verdict owed by a pinned judge is missing → IntegrityError', () => {
  const { ctx } = scored('2026-10-01T00:00:00.000Z');
  rmSync(verdictPath(ctx.paths, 'Moonshot', 'C00-P02', 'ba'));
  assert.throws(() => calibReport(ctx), (e) => e instanceof IntegrityError && /verdict Moonshot C00-P02-ba is missing/u.test(e.message));
});

test('c5 writes round0.json once (a rerun reuses it) and rebuilds calibration/status.json', async () => {
  const { w, ctx } = scored('2026-10-01T00:00:00.000Z');
  const out = await scoreStep.run(ctx, null);
  assert.equal(out.kind, 'done');
  if (out.kind === 'done') assert.deepEqual(out.outputs, ['calibration/round0.json']);
  assert.ok(existsSync(join(w.root, 'calibration', 'status.json')));
  const reports = readCalibReports(w.root);
  assert.ok(reports.ok);
  assert.deepEqual(reports.value.map((r) => [r.set, r.qualified.length]), [['C00', 3]]);
  const path = join(w.root, 'calibration', 'round0.json');
  const edited = { ...reports.value[0], writer_recommendation: { model: 'deepseek-fixture', basis: 'kept' } };
  writeFileSync(path, `${JSON.stringify(edited, null, 2)}\n`);
  assert.equal((await scoreStep.run(ctx, null)).kind, 'done');
  assert.match(readFileSync(path, 'utf8'), /"basis": "kept"/u);
});

test('c5: owner answers the reader rejects (hand edit, deleted file) → IntegrityError, no report; a repaired file scores normally', async () => {
  const { w, ctx, sim } = scored('2026-10-01T00:00:00.000Z');
  const report0 = join(w.root, 'calibration', 'round0.json');
  sim.tamper('calibration/owner-answers.json', (text) => `${text}\n`);
  await assert.rejects(scoreStep.run(ctx, null), (e) => e instanceof IntegrityError && /SHA-256 differs from its latest owner-log entry/u.test(e.message));
  assert.equal(existsSync(report0), false);
  sim.tamper('calibration/owner-answers.json', (text) => text.slice(0, -1));
  assert.equal((await scoreStep.run(ctx, null)).kind, 'done');
  const reports = readCalibReports(w.root);
  assert.ok(reports.ok);
  assert.deepEqual(reports.value.map((r) => [r.set, r.valid, r.qualified.length]), [['C00', true, 3]]);

  const gone = scored('2026-10-01T00:00:00.000Z');
  gone.sim.removeOwnerFile('calibration/owner-answers.json');
  await assert.rejects(scoreStep.run(gone.ctx, null), (e) => e instanceof IntegrityError && /owner-answers\.json is missing/u.test(e.message));
  assert.equal(existsSync(join(gone.w.root, 'calibration', 'round0.json')), false);
});

/** xAI dry-run verdicts on four copies (all caught) by the pinned grok / fake-grok; `last` edits the C00-G4 record. */
function writeDryrun(ctx: StepContext, last: Partial<Pick<DryrunVerdictRecord, 'family' | 'judge' | 'model'>> = {}): void {
  for (const n of [1, 2, 3, 4]) {
    const id = `C00-G${n}`;
    const who: Pick<DryrunVerdictRecord, 'family' | 'judge' | 'model'> = { family: 'xAI', judge: 'grok', model: 'fake-grok', ...(n === 4 ? last : {}) };
    const rec: DryrunVerdictRecord = { id, ...who, copy: `C00-T0${n}`, status: 'ok', caught: true, error: null, call: `gate-${id}-${who.family}` };
    put(ctx.root, ctx.files.rel(dryrunPath(ctx.paths, rec.family, id)), `${JSON.stringify(rec, null, 2)}\n`);
  }
}

test('gate_dryrun counts the dry-run verdicts of the pinned judges: xAI caught 4/4 → gate_judge', () => {
  const { ctx } = scored('2026-10-01T00:00:00.000Z');
  writeDryrun(ctx);
  assert.deepEqual(report(ctx).gate_dryrun, { xAI: { caught: 4, of: 4, gate_judge: true } });
});

test('a dry-run verdict whose judge or model is not the pinned judge of its family → IntegrityError, no report', async () => {
  const cases: Array<[Partial<Pick<DryrunVerdictRecord, 'family' | 'judge' | 'model'>>, RegExp]> = [
    [{ model: 'grok-next' }, /dryrun\/xAI\/C00-G4\.json: judge grok\/grok-next is not the pinned xAI judge grok\/fake-grok/u],
    [{ judge: 'grok-2' }, /dryrun\/xAI\/C00-G4\.json: judge grok-2\/fake-grok is not the pinned xAI judge grok\/fake-grok/u],
    [{ family: 'Zhipu' }, /dryrun\/Zhipu\/C00-G4\.json: no Zhipu judge is pinned/u],
  ];
  for (const [last, pattern] of cases) {
    const { w, ctx } = scored('2026-10-01T00:00:00.000Z');
    writeDryrun(ctx, last);
    assert.throws(() => calibReport(ctx), (e) => e instanceof IntegrityError && pattern.test(e.message), JSON.stringify(last));
    await assert.rejects(scoreStep.run(ctx, null), (e) => e instanceof IntegrityError && pattern.test(e.message));
    assert.equal(existsSync(join(w.root, 'calibration', 'round0.json')), false);
  }
});
