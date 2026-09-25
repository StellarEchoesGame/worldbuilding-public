import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeBackend } from './adapters/fake.ts';
import { calibPaths, type CalibSetRecord } from './calib-build.ts';
import {
  answersStep, calibTaskId, dryrunStep, dryrunTaskId, jobsFor, judgeStep, parseDryrunVerdict, parseVerdictRecord, pinDiff, readDryrunVerdicts, readPin,
  readVerdicts, verdictPath, type CalibPin, type DryrunVerdictRecord, type VerdictRecord,
} from './calib-run.ts';
import { loadConfig, type Family } from './config.ts';
import { buildContext, type RoundBackends, type RunHooks, type StepContext } from './context.ts';
import { readString } from './json.ts';
import { LOCK_FILE, runSteps, type RunReport, type StepDef } from './runner.ts';
import { sha256 } from './store.ts';
import { IntegrityError } from './task.ts';
import { quoteSpan, unwrap } from './tasks/fenced.ts';
import { body, INJECTED, put, setRecord, writeSet } from './testing/calib-set.ts';
import { fakePorts, type FakePorts } from './testing/fakes.ts';
import { DEFAULT_FIXTURE, fixtureWorld, type FixtureOptions, type FixtureWorld } from './testing/fixture-world.ts';
import { ownerSim, type OwnerSim } from './testing/owner-sim.ts';
import { callLog, fakeRouter, type FakeRouter, type Route } from './testing/scripted.ts';

const JUDGES: ReadonlyArray<readonly [string, Family]> = [['codex', 'OpenAI'], ['claude', 'Anthropic'], ['kimi', 'Moonshot'], ['grok', 'xAI']];

function fenced(value: unknown): string {
  return ['```json', JSON.stringify(value), '```'].join('\n');
}

/** Taste judge: prefers the text without 仿佛 (else text 1) on both questions. */
const tasteRoute: Route = (prompt) => {
  const t1 = unwrap(prompt, '文本甲') ?? '';
  const t2 = unwrap(prompt, '文本乙') ?? '';
  const pick = t1.includes('仿佛') ? 2 : 1;
  const quote = [...(pick === 1 ? t1 : t2)].slice(0, 12).join('');
  return fenced({ answers: { q1: { pick, quote }, q2: { pick, quote } } });
};

/** Gate judge: flags the injected sentence against F01 when the subject carries it. */
const gateRoute: Route = (prompt) => {
  const subject = unwrap(prompt, '文本甲') ?? '';
  if (!subject.includes(INJECTED)) return fenced({ contradiction: false, findings: [] });
  return fenced({ contradiction: true, findings: [{ quote: INJECTED, against: 'F01', reason: '与冻结事实相反' }] });
};

interface H {
  w: FixtureWorld;
  set: string;
  ports: FakePorts;
  sim: OwnerSim;
  judges: FakeRouter[];
  ctx(hooks?: RunHooks, backends?: RoundBackends): StepContext;
  backends(): RoundBackends;
}

interface Setup {
  set?: string;
  kind?: CalibSetRecord['kind'];
  family?: Family | null;
  fixture?: FixtureOptions;
  taste?: (family: Family) => Route;
}

function harness(opts: Setup = {}): H {
  const set = opts.set ?? 'C00';
  const w = fixtureWorld(mkdtempSync(join(tmpdir(), 'forge-calib-run-')), opts.fixture ?? { ...DEFAULT_FIXTURE, trust: 'none' });
  writeSet(w.root, set, setRecord(set, opts.kind ?? 'round0', opts.family ?? null));
  const config = loadConfig(w.root, { requireLocal: true });
  if (!config.ok) throw new Error(config.error);
  const cfg = config.value;
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: '2026-10-01T06:00:00.000Z', seed: 'calib-run' });
  const judges = JUDGES.map(([id, family]) => fakeRouter({ calib: opts.taste?.(family) ?? tasteRoute, gate: gateRoute }, { id, family, model: `${id}-model` }));
  const b = fakeBackend('x', 'DeepSeek', () => '');
  const backends = (): RoundBackends => ({
    writers: [], baseline: b, decoy: b, defect: b, judges: judges.map((backend) => ({ backend, concurrency: 2 })), forecasters: [], maintainer: b, mergeEditor: b, calibGateway: new Map(),
  });
  const ctx = (hooks?: RunHooks, bs?: RoundBackends): StepContext => {
    const deps = { ports, backends: () => bs ?? backends(), env: {}, pid: 7, isAlive: () => true, log: () => undefined };
    const built = buildContext({
      root: w.root, repo: w.repo, roundId: set, pipeline: 'calibration', paths: calibPaths(w.root, set), config: cfg,
      deps: hooks === undefined ? deps : { ...deps, hooks }, startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
    });
    if (!built.ok) throw new Error(built.error);
    return built.value;
  };
  return { w, set, ports, sim: ownerSim(w.root, ports.clock), judges, ctx, backends };
}

/** c1 is C1's; here the set record already exists, so a stand-in marks it. */
const builtStep: StepDef = { id: 'c1-build', run: async () => ({ kind: 'done', inputs: [], outputs: [], external: ['calibration/pairs.json'] }) };

function run(ctx: StepContext, pid = 7, isAlive: (pid: number) => boolean = () => true): Promise<RunReport> {
  return runSteps(ctx, { pipeline: 'calibration', steps: [builtStep, dryrunStep, answersStep, judgeStep], until: 'c4-judge', from: null, redoFrom: null, pid, isAlive });
}

function short(r: RunReport): Pick<RunReport, 'state' | 'step' | 'waitingFor' | 'exitCode'> {
  return { state: r.state, step: r.step, waitingFor: r.waitingFor, exitCode: r.exitCode };
}

/** The owner prefers the right-hand text everywhere. */
function answerAll(h: H, slots?: readonly number[]): void {
  h.sim.answerCalibration(h.set, () => 'right', slots);
}

function calibCalls(h: H): string[] {
  return h.judges.flatMap((j) => callLog(j)).filter((c) => c.startsWith('calib-'));
}

test('task ids and file paths follow the index', () => {
  assert.equal(calibTaskId('C00-P03', 'kimi', 'ab'), 'calib-C00-kimi-P03-ab');
  assert.equal(dryrunTaskId('C00-G1', 'xAI'), 'gate-C00-G1-xAI');
  assert.throws(() => calibTaskId('P03', 'kimi', 'ab'));
  const paths = calibPaths('/f', 'C00');
  assert.equal(verdictPath(paths, 'Moonshot', 'C00-P03', 'ba'), join('/f', 'calibration', 'C00', 'verdicts', 'Moonshot', 'C00-P03-ba.json'));
});

/** 6 pairs per category; canon_vs_rewrite pairs carry an OpenAI-authored 8.1 passage. */
function fullRecord(kind: CalibSetRecord['kind'], family: Family | null): CalibSetRecord {
  const base = setRecord('C00', kind, family);
  const cats: ReadonlyArray<CalibSetRecord['pairs'][number]['category']> = ['canon_vs_rewrite', 'cross_model', 'stance', 'known'];
  const pairs = cats.flatMap((category, i) => Array.from({ length: 6 }, (_, k) => ({
    id: `C00-P${String(i * 6 + k + 1).padStart(2, '0')}`, category, a: 'C00-T01', b: 'C00-T02', known_better: category === 'known' ? 'C00-T01' : null,
    authors: category === 'canon_vs_rewrite' ? ['DeepSeek', 'OpenAI'] : ['DeepSeek'], split: 'none',
  } satisfies CalibSetRecord['pairs'][number])));
  return { ...base, kind, family, pairs };
}

test('jobsFor: C00 with 4 judges → 180 jobs (OpenAI 36); one judge per family; Q only its family; G none', () => {
  const second: Family = 'OpenAI';
  const judges: Array<{ id: string; family: Family }> = [...JUDGES.map(([id, family]) => ({ id, family })), { id: 'codex-2', family: second }];
  const jobs = jobsFor('C00', fullRecord('round0', null), judges);
  assert.equal(jobs.length, 180);
  const per = (f: Family): number => jobs.filter((j) => j.family === f).length;
  assert.deepEqual([per('OpenAI'), per('Anthropic'), per('Moonshot'), per('xAI')], [36, 48, 48, 48]);
  assert.ok(jobs.every((j) => j.judge !== 'codex-2'));
  assert.equal(new Set(jobs.map((j) => `${j.family}|${j.pair}|${j.order}`)).size, 180);
  assert.deepEqual(jobs.filter((j) => j.pair === 'C00-P01').map((j) => j.family), ['Anthropic', 'Anthropic', 'Moonshot', 'Moonshot', 'xAI', 'xAI']);
  assert.ok(jobsFor('Q01', fullRecord('requal', 'xAI'), judges).every((j) => j.family === 'xAI'));
  assert.equal(jobsFor('Q01', fullRecord('requal', 'OpenAI'), judges).length, 36);
  assert.deepEqual(jobsFor('G01', fullRecord('gate', 'xAI'), judges), []);
});

function verdict(over: Partial<VerdictRecord> = {}): VerdictRecord {
  return {
    pair: 'C00-P03', family: 'Moonshot', judge: 'kimi', order: 'ab', text1: 'C00-T05', text2: 'C00-T06', status: 'ok', decisive: 'C00-T05',
    picks: { q1: 'C00-T05', q2: 'C00-T06' }, quotes: { q1: 'x', q2: 'y' }, error: null, call: 'calib-C00-kimi-P03-ab', benchmark_version: 'v1', ...over,
  };
}

test('parseVerdictRecord: ok and void verdicts; rejects void with picks, a foreign decisive, a wrong call id', () => {
  assert.deepEqual(parseVerdictRecord(verdict()), { ok: true, value: verdict() });
  const v = verdict({ status: 'void', decisive: null, picks: {}, quotes: {}, error: 'unfenced' });
  assert.deepEqual(parseVerdictRecord(v), { ok: true, value: v });
  assert.equal(parseVerdictRecord({ ...v, picks: { q1: 'C00-T05' } }).ok, false);
  assert.equal(parseVerdictRecord(verdict({ decisive: 'C00-T07' })).ok, false);
  assert.equal(parseVerdictRecord(verdict({ call: 'calib-C00-grok-P03-ab' })).ok, false);
  assert.equal(parseVerdictRecord({ ...verdict(), extra: 1 }).ok, false);
});

test('verdict parsers: an id part that forms no task id is a parse error, never a throw; c4 meets such a file → integrity, exit 3', async () => {
  for (const judge of ['kimi code', 'k/3', 'k'.repeat(150)]) {
    assert.deepEqual(parseVerdictRecord(verdict({ judge, call: `calib-C00-${judge}-P03-ab` })), { ok: false, error: 'judge: not a task-id token' });
  }
  const dry: DryrunVerdictRecord = { id: 'C00-G1', family: 'xAI', judge: 'grok', model: 'grok-model', copy: 'C00-T09', status: 'ok', caught: true, error: null, call: 'gate-C00-G1-xAI' };
  assert.deepEqual(parseDryrunVerdict(dry), { ok: true, value: dry });
  const { model: _model, ...modelless } = dry;
  assert.equal(parseDryrunVerdict(modelless).ok, false, 'a dry-run verdict names the model that produced it');
  assert.equal(parseDryrunVerdict({ ...dry, model: '' }).ok, false);
  assert.deepEqual(parseDryrunVerdict({ ...dry, id: 'C00 G1', call: 'gate-C00 G1-xAI' }), { ok: false, error: 'id: not a task-id token' });
  const h = harness();
  answerAll(h);
  const bad = verdict({ judge: 'kimi code', call: 'calib-C00-kimi code-P03-ab' });
  put(h.w.root, 'calibration/C00/verdicts/Moonshot/C00-P03-ab.json', `${JSON.stringify(bad, null, 2)}\n`);
  const r = await run(h.ctx());
  assert.deepEqual(short(r), { state: 'integrity', step: 'c4-judge', waitingFor: null, exitCode: 3 });
  assert.match(r.detail, /C00-P03-ab\.json: judge: not a task-id token/u);
});

test('pinDiff: equal pins → []; benchmark bytes, answers and a judge model are named', () => {
  const pin: CalibPin = {
    set: 'C00', benchmark_version: 'v1', benchmark_sha256: 'a'.repeat(64), protocol_bundle_sha256: 'b'.repeat(64), pairs_sha256: 'c'.repeat(64),
    answers_sha256: 'd'.repeat(64), judges: { Moonshot: { id: 'kimi', model: 'k3' } },
  };
  assert.deepEqual(pinDiff(pin, { ...pin }), []);
  const drift = pinDiff(pin, { ...pin, benchmark_sha256: 'e'.repeat(64), answers_sha256: 'f'.repeat(64), judges: { Moonshot: { id: 'kimi', model: 'k4' }, xAI: { id: 'grok', model: 'g' } } });
  assert.deepEqual(drift, ['benchmark file changed (v1)', 'owner answers changed', 'judge changed: Moonshot kimi/k3 → kimi/k4', 'judge not pinned: xAI']);
});

test('c2 runs without owner answers; c3 waits (0/5, then 4/5) and no taste verdict exists; complete answers → c4 pins and judges', async () => {
  const h = harness();
  const paths = calibPaths(h.w.root, h.set);
  const first = await run(h.ctx());
  assert.deepEqual(short(first), { state: 'waiting', step: 'c3-owner-answers', waitingFor: 'calib_answers', exitCode: 2 });
  assert.match(first.detail, /0\/5/u);
  const dry = readDryrunVerdicts(paths);
  assert.ok(dry.ok);
  assert.deepEqual(dry.value.map((d) => [d.family, d.status, d.caught]), JUDGES.map(([, f]) => [f, 'ok', true]).sort());
  answerAll(h, [1, 2, 3, 4]);
  const partial = await run(h.ctx());
  assert.deepEqual(short(partial), short(first));
  assert.match(partial.detail, /4\/5/u);
  assert.equal(existsSync(paths.taste), false);
  assert.equal(readPin(paths), null);
  assert.deepEqual(calibCalls(h), []);
  answerAll(h);
  assert.deepEqual(short(await run(h.ctx())), { state: 'done', step: 'c4-judge', waitingFor: null, exitCode: 0 });
  const verdicts = readVerdicts(paths);
  assert.ok(verdicts.ok);
  assert.equal(verdicts.value.length, 30);
  assert.equal(calibCalls(h).length, 30);
  assert.ok(!verdicts.value.some((v) => v.family === 'OpenAI' && v.pair === 'C00-P01'), 'a family never judges a pair it authored');
  assert.ok(verdicts.value.filter((v) => v.pair === 'C00-P04').every((v) => v.status === 'ok' && v.decisive === 'C00-T07'));
  const ba = verdicts.value.find((v) => v.family === 'xAI' && v.pair === 'C00-P02' && v.order === 'ba');
  assert.deepEqual([ba?.text1, ba?.text2, ba?.call, ba?.benchmark_version], ['C00-T04', 'C00-T03', 'calib-C00-grok-P02-ba', 'v1']);
  const pin = readPin(paths);
  assert.ok(pin !== null && pin.ok);
  assert.equal(pin.value.benchmark_version, 'v1');
  assert.equal(pin.value.benchmark_sha256, sha256(readFileSync(join(h.w.root, 'benchmark', 'v1.json'), 'utf8')));
  assert.deepEqual(Object.keys(pin.value.judges).sort(), ['Anthropic', 'Moonshot', 'OpenAI', 'xAI']);
});

/** Rewrites the dry-run copy C00-T09 to `text`; the record keeps calib-build's injected_span, measured on the raw text. */
function rewriteCopy(h: H, text: string): void {
  const record = setRecord(h.set, 'round0', null);
  const id = `${h.set}-T09`;
  const span = quoteSpan(INJECTED, text) ?? { start: 0, end: 0 };
  const t = record.texts[id];
  if (t === undefined) throw new Error(`fixture: no ${id}`);
  writeSet(h.w.root, h.set, {
    ...record, texts: { ...record.texts, [id]: { ...t, sha256: sha256(text) } },
    dryrun: record.dryrun.map((d) => ({ ...d, injected_span: span })),
  });
  put(h.w.root, `calibration/texts/${id}.md`, text);
}

test('c2 scores the injected sentence in the anonymized subject the judge saw (a numbered list before it still counts as caught)', async () => {
  const h = harness();
  const copy = `1. ${body(7)}\n2. 林澈把菌毯卷好送回培养架。\n3. 见[手册](https://example.invalid/a/b/c)。${INJECTED}`;
  rewriteCopy(h, copy);
  const r = await run(h.ctx());
  assert.deepEqual(short(r), { state: 'waiting', step: 'c3-owner-answers', waitingFor: 'calib_answers', exitCode: 2 });
  const dry = readDryrunVerdicts(calibPaths(h.w.root, h.set));
  assert.ok(dry.ok);
  assert.deepEqual(dry.value.map((d) => [d.family, d.status, d.caught]), JUDGES.map(([, f]) => [f, 'ok', true]).sort());
});

test('c2: an injected sentence absent from the displayed copy → integrity, exit 3', async () => {
  const h = harness();
  rewriteCopy(h, body(7));
  const r = await run(h.ctx());
  assert.deepEqual(short(r), { state: 'integrity', step: 'c2-gate-dryrun', waitingFor: null, exitCode: 3 });
  assert.match(r.detail, /injected sentence/u);
});

test('owner answers the reader rejects (answered on other pairs) → integrity, exit 3, no taste call', async () => {
  const h = harness();
  answerAll(h);
  const record = setRecord(h.set, 'round0', null);
  writeSet(h.w.root, h.set, { ...record, built_at: '2026-10-02T00:00:00.000Z' });
  const r = await run(h.ctx());
  assert.deepEqual(short(r), { state: 'integrity', step: 'c3-owner-answers', waitingFor: null, exitCode: 3 });
  assert.match(r.detail, /pairs_sha256/u);
  assert.deepEqual(calibCalls(h), []);
});

test('owner-answers.json whose SHA-256 differs from the last calib_answers owner-log entry → c3 integrity, exit 3, no taste verdict; undone → done', async () => {
  const h = harness();
  answerAll(h);
  const file = 'calibration/owner-answers.json';
  const logged = readFileSync(join(h.w.root, file), 'utf8');
  // slot 1 (left T03, right T04) flipped to the left text, choice and chosen consistent, so only the hash tells
  h.sim.tamper(file, (text) => text.replace('"choice": "right"', '"choice": "left"').replace('"chosen": "C00-T04"', '"chosen": "C00-T03"'));
  assert.notEqual(readFileSync(join(h.w.root, file), 'utf8'), logged);
  await assert.rejects(answersStep.run(h.ctx(), null), (e) => e instanceof IntegrityError && /owner-answers\.json: SHA-256 differs from its latest owner-log entry/u.test(e.message));
  const r = await run(h.ctx());
  assert.deepEqual(short(r), { state: 'integrity', step: 'c3-owner-answers', waitingFor: null, exitCode: 3 });
  assert.equal(existsSync(calibPaths(h.w.root, h.set).taste), false);
  assert.deepEqual(calibCalls(h), []);
  h.sim.tamper(file, () => logged);
  assert.deepEqual(short(await run(h.ctx())), { state: 'done', step: 'c4-judge', waitingFor: null, exitCode: 0 });
  assert.equal(calibCalls(h).length, 30);
});

test('a killed c4 resumes without repeating a finished call', async () => {
  const h = harness();
  answerAll(h);
  let n = 0;
  const kill: RunHooks = {
    beforeCall: (taskId) => {
      if (taskId.startsWith('calib-') && ++n === 9) throw new Error('killed mid-run');
    },
  };
  await assert.rejects(run(h.ctx(kill)), /killed mid-run/u);
  const before = calibCalls(h).length;
  assert.ok(before >= 8 && before < 30, `killed after ${before} calls`);
  assert.deepEqual(short(await run(h.ctx(), 8, () => false)), { state: 'done', step: 'c4-judge', waitingFor: null, exitCode: 0 });
  const calls = calibCalls(h);
  assert.equal(calls.length, 30);
  assert.equal(new Set(calls).size, 30);
});

test('pin drift refuses the rerun: a changed benchmark file or judge model → IntegrityError', async () => {
  const h = harness();
  answerAll(h);
  assert.equal((await run(h.ctx())).state, 'done');
  const other = h.backends();
  const claude = other.judges.find((j) => j.backend.family === 'Anthropic');
  if (claude === undefined) throw new Error('no claude');
  claude.backend = fakeRouter({ calib: tasteRoute }, { id: 'claude', family: 'Anthropic', model: 'claude-next' });
  await assert.rejects(judgeStep.run(h.ctx(undefined, other), null), (e) => e instanceof IntegrityError && /judge changed: Anthropic/u.test(e.message));
  put(h.w.root, 'benchmark/v1.json', `${readFileSync(join(h.w.root, 'benchmark', 'v1.json'), 'utf8')}\n`);
  await assert.rejects(judgeStep.run(h.ctx(), null), (e) => e instanceof IntegrityError && /benchmark file changed \(v1\)/u.test(e.message));
  assert.equal(calibCalls(h).length, 30);
});

test('a twice-invalid output is stored void, is final and is not retried on rerun', async () => {
  const refuse: Route = (prompt, call, meta) => (meta.taskId === 'calib-C00-grok-P03-ab' ? '我拒绝回答。' : tasteRoute(prompt, call, meta));
  const h = harness({ taste: (family) => (family === 'xAI' ? refuse : tasteRoute) });
  answerAll(h);
  assert.equal((await run(h.ctx())).state, 'done');
  const read = readVerdicts(calibPaths(h.w.root, h.set));
  assert.ok(read.ok);
  const v = read.value.find((x) => x.call === 'calib-C00-grok-P03-ab');
  assert.deepEqual([v?.status, v?.decisive, v?.picks], ['void', null, {}]);
  assert.equal(typeof v?.error, 'string');
  assert.deepEqual(calibCalls(h).filter((c) => c.startsWith('calib-C00-grok-P03-ab')), ['calib-C00-grok-P03-ab#1', 'calib-C00-grok-P03-ab#2']);
  const before = calibCalls(h).length;
  assert.equal(before, 31);
  const again = await judgeStep.run(h.ctx(), null);
  assert.equal(again.kind, 'done');
  assert.equal(calibCalls(h).length, before);
});

test('C00 without an effective benchmark waits for approval before pinning; Q sets skip c2 and judge with their family only', async () => {
  const pending = harness({ fixture: { ...DEFAULT_FIXTURE, trust: 'none', benchmark: 'pending' } });
  answerAll(pending);
  const r = await run(pending.ctx());
  assert.deepEqual(short(r), { state: 'waiting', step: 'c4-judge', waitingFor: 'benchmark_approval', exitCode: 2 });
  assert.equal(readPin(calibPaths(pending.w.root, 'C00')), null);
  const q = harness({ set: 'Q01', kind: 'requal', family: 'xAI' });
  answerAll(q);
  assert.equal((await run(q.ctx())).state, 'done');
  const paths = calibPaths(q.w.root, 'Q01');
  assert.deepEqual(readDryrunVerdicts(paths), { ok: true, value: [] });
  const verdicts = readVerdicts(paths);
  assert.ok(verdicts.ok);
  assert.equal(verdicts.value.length, 8);
  assert.ok(verdicts.value.every((v) => v.family === 'xAI'));
  const pin = readPin(paths);
  assert.ok(pin !== null && pin.ok);
  assert.deepEqual(Object.keys(pin.value.judges), ['xAI']);
});

test('G sets: c2 judges the copies with the set family only (a miss is recorded), c3 and c4 skip', async () => {
  const h = harness({ set: 'G01', kind: 'gate', family: 'Moonshot' });
  const kimi = h.judges.find((j) => j.family === 'Moonshot');
  const others = h.backends();
  const slot = others.judges.find((j) => j.backend.family === 'Moonshot');
  if (kimi === undefined || slot === undefined) throw new Error('no kimi');
  slot.backend = fakeRouter({ gate: () => fenced({ contradiction: false, findings: [] }) }, { id: 'kimi', family: 'Moonshot', model: 'kimi-model' });
  assert.deepEqual(short(await run(h.ctx(undefined, others))), { state: 'done', step: 'c4-judge', waitingFor: null, exitCode: 0 });
  const paths = calibPaths(h.w.root, 'G01');
  const dry = readDryrunVerdicts(paths);
  assert.ok(dry.ok);
  assert.deepEqual(dry.value.map((d) => [d.id, d.family, d.status, d.caught, d.call]), [['G01-G1', 'Moonshot', 'ok', false, 'gate-G01-G1-Moonshot']]);
  assert.equal(existsSync(paths.taste), false);
  assert.equal(readPin(paths), null);
});

test('a G or Q set whose family has no judge backend → integrity, exit 3, status written and lock released (not a crash)', async () => {
  const g = harness({ set: 'G01', kind: 'gate', family: 'Zhipu' });
  const r = await run(g.ctx());
  assert.deepEqual(short(r), { state: 'integrity', step: 'c2-gate-dryrun', waitingFor: null, exitCode: 3 });
  assert.match(r.detail, /no judge backend of family Zhipu/u);
  const status: unknown = JSON.parse(readFileSync(calibPaths(g.w.root, 'G01').status, 'utf8'));
  assert.deepEqual([readString(status, 'state'), readString(status, 'step')], ['integrity', 'c2-gate-dryrun']);
  assert.equal(existsSync(join(g.w.root, LOCK_FILE)), false);
  const q = harness({ set: 'Q01', kind: 'requal', family: 'Zhipu' });
  answerAll(q);
  const rq = await run(q.ctx());
  assert.deepEqual(short(rq), { state: 'integrity', step: 'c4-judge', waitingFor: null, exitCode: 3 });
  assert.match(rq.detail, /no judge backend of family Zhipu/u);
  assert.equal(existsSync(join(q.w.root, LOCK_FILE)), false);
  assert.equal(readPin(calibPaths(q.w.root, 'Q01')), null);
  assert.deepEqual(calibCalls(q), []);
});

test('dry-run verdicts record the judge model; a file whose model differs from the current backend → c2 rerun integrity, no gate call', async () => {
  const h = harness();
  assert.equal((await run(h.ctx())).state, 'waiting');
  const paths = calibPaths(h.w.root, h.set);
  const dry = readDryrunVerdicts(paths);
  assert.ok(dry.ok);
  assert.deepEqual(dry.value.map((d) => [d.family, d.judge, d.model]), JUDGES.map(([id, f]) => [f, id, `${id}-model`]).sort());
  const other = h.backends();
  const slot = other.judges.find((j) => j.backend.family === 'xAI');
  if (slot === undefined) throw new Error('no grok');
  const next = fakeRouter({ gate: gateRoute }, { id: 'grok', family: 'xAI', model: 'grok-next' });
  slot.backend = next;
  const redo = await runSteps(h.ctx(undefined, other), {
    pipeline: 'calibration', steps: [builtStep, dryrunStep, answersStep, judgeStep], until: 'c4-judge', from: null, redoFrom: 'c2-gate-dryrun', pid: 7, isAlive: () => true,
  });
  assert.deepEqual(short(redo), { state: 'integrity', step: 'c2-gate-dryrun', waitingFor: null, exitCode: 3 });
  assert.match(redo.detail, /dryrun\/xAI\/C00-G1\.json belongs to another judge, model or copy/u);
  assert.deepEqual(callLog(next), []);
  await assert.rejects(dryrunStep.run(h.ctx(undefined, other), null), (e) => e instanceof IntegrityError && /another judge, model or copy/u.test(e.message));
  assert.deepEqual(short(await run(h.ctx())), { state: 'waiting', step: 'c3-owner-answers', waitingFor: 'calib_answers', exitCode: 2 });
});
