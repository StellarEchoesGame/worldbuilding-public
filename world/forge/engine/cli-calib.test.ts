import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fakeBackend } from './adapters/fake.ts';
import { anonymizeText } from './anonymize.ts';
import { calibPaths, readCalibSet, type CalibSetRecord } from './calib-build.ts';
import { readVerdicts } from './calib-run.ts';
import { parseCalibReport } from './calib-score.ts';
import { buildRefusal, calibBranch, calibCommand, defaultSet, nextSetId, parseCalibArgs, pendingBuild } from './cli-calib.ts';
import { calibModels, gatewayId, productionBackends, type ForgeRoots } from './cli-round.ts';
import { loadConfig, type Family } from './config.ts';
import type { EngineDeps, RoundBackends, RunHooks } from './context.ts';
import { parsePrices } from './cost.ts';
import { sha256Bytes } from './owner-inputs.ts';
import { loadProtocolBundle } from './rules.ts';
import { seededShuffle, sha256 } from './store.ts';
import { unwrap } from './tasks/fenced.ts';
import { splitSentences } from './text.ts';
import { fakePorts, type FakePorts } from './testing/fakes.ts';
import { DEFAULT_FIXTURE, addCalibrationPassages, fixtureWorld, type FixtureWorld } from './testing/fixture-world.ts';
import { ownerSim, type OwnerSim } from './testing/owner-sim.ts';
import { fakeRouter, type FakeRouter, type Route } from './testing/scripted.ts';
import { parseTrustStatus, trustPins, type FamilyTrust, type TrustStatus } from './trust-status.ts';
import { parseLabelLedger, visibleLabels } from './trust.ts';

const JUDGES: ReadonlyArray<readonly [string, Family]> = [['codex', 'OpenAI'], ['claude', 'Anthropic'], ['kimi', 'Moonshot'], ['grok', 'xAI']];
/** The sentence every fake defect copy injects (a gate judge that sees it flags it against X01). */
const INJECTED = '据说早在先遣队之前这里就有人住过。';

function fenced(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

/** The fake degrade answer: the first three sentences get a generic tail (3 verbatim changes, same sentence count). */
function degraded(original: string): { text: string; changes: Array<{ from: string; to: string }> } {
  const changes = splitSentences(original).slice(0, 3).map((s) => ({ from: s, to: `${s.slice(0, -1)}，宛如往常。` }));
  let text = original;
  for (const c of changes) text = text.replace(c.from, c.to);
  return { text, changes };
}

/**
 * Gateway (rewrite, degrade) and defect-writer routes whose replies are derived from the prompt, so every parse
 * passes. A rewrite is the passage's sentences shuffled by the model and the whole prompt (stance included), so the
 * two rewrites of a cross_model or stance pair differ, plus one sentence of its own (parse refuses a pure copy).
 */
const writerRoutes = (model: string): Record<string, Route> => ({
  calibrewrite: (prompt) => fenced({ text: `${seededShuffle(splitSentences(unwrap(prompt, '原文') ?? ''), model, sha256(prompt)).join('')}这一天就这样过去了。` }),
  calibdegrade: (prompt) => fenced(degraded(unwrap(prompt, '现场') ?? '')),
  defect: (prompt) => {
    const first = (unwrap(prompt, '正文') ?? '').split('\n')[0] ?? '';
    const against = (unwrap(prompt, '条目') ?? '').split('｜')[0] ?? '';
    return fenced({ sentence_no: 1, original: first.replace(/^〔S\d+〕/u, ''), replacement: INJECTED, against });
  },
});

/** Gate judge: flags the injected sentence (binding: X01 is a forbidden move) when the subject carries it. */
const gateRoute: Route = (prompt) => {
  const subject = unwrap(prompt, '文本甲') ?? '';
  if (!subject.includes(INJECTED)) return fenced({ contradiction: false, findings: [] });
  return fenced({ contradiction: true, findings: [{ quote: INJECTED, against: 'X01', reason: '与禁用写法相冲突' }] });
};

function tasteReply(pick: 1 | 2, t1: string, t2: string): string {
  const quote = [...(pick === 1 ? t1 : t2)].slice(0, 12).join('');
  return fenced({ answers: { q1: { pick, quote }, q2: { pick, quote } } });
}

interface H {
  dir: string;
  w: FixtureWorld;
  ports: FakePorts;
  sim: OwnerSim;
  at: ForgeRoots;
  logs: string[];
  writers: FakeRouter[];
  judges: FakeRouter[];
  /** Anonymized text → true when the non-xAI judges pick it (filled by `teach` once the set and answers exist). */
  preferred: Map<string, boolean>;
  deps(hooks?: RunHooks, pid?: number): EngineDeps;
}

/** Fixture world with passage-grade canon, fake ports on `main`, fake gateway / defect writers and four scripted judges. */
function harness(): H {
  const dir = mkdtempSync(join(tmpdir(), 'forge-cli-calib-'));
  const w = fixtureWorld(dir, { ...DEFAULT_FIXTURE, trust: 'none' });
  addCalibrationPassages(w);
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: '2026-10-01T00:00:00.000Z', seed: 'cli-calib' });
  const preferred = new Map<string, boolean>();
  // xAI always picks position 1 (order-inconsistent); the others pick the text `preferred` marks.
  const taste = (family: Family): Route => (prompt) => {
    const t1 = unwrap(prompt, '文本甲') ?? '';
    const t2 = unwrap(prompt, '文本乙') ?? '';
    if (family === 'xAI') return tasteReply(1, t1, t2);
    const p1 = preferred.get(t1);
    if (p1 === undefined || preferred.get(t2) === undefined) throw new Error('taste judge: a text the test did not teach');
    return tasteReply(p1 ? 1 : 2, t1, t2);
  };
  const judges = JUDGES.map(([id, family]) => fakeRouter({ calib: taste(family), gate: gateRoute }, { id, family, model: `${id}-model` }));
  const writers = [
    fakeRouter(writerRoutes('deepseek-fixture-a'), { id: gatewayId('deepseek-fixture-a'), family: 'DeepSeek', model: 'deepseek-fixture-a' }),
    fakeRouter(writerRoutes('qwen/fixture-b'), { id: gatewayId('qwen/fixture-b'), family: 'Alibaba', model: 'qwen/fixture-b' }),
    fakeRouter(writerRoutes('deepseek-fixture'), { id: 'defect', family: 'DeepSeek', model: 'deepseek-fixture' }),
  ];
  const [a, b, defect] = writers;
  if (a === undefined || b === undefined || defect === undefined) throw new Error('fixture routers');
  const x = fakeBackend('x', 'DeepSeek', () => '');
  const backends: RoundBackends = {
    writers: [], baseline: x, decoy: x, defect, judges: judges.map((backend) => ({ backend, concurrency: 3 })), forecasters: [], maintainer: x, mergeEditor: x,
    calibGateway: new Map([['deepseek-fixture-a', a], ['qwen/fixture-b', b]]),
  };
  const logs: string[] = [];
  const deps = (hooks?: RunHooks, pid = 4242): EngineDeps => {
    const base: EngineDeps = { ports, backends: () => backends, env: {}, pid, isAlive: () => false, log: (l) => logs.push(l) };
    return hooks === undefined ? base : { ...base, hooks };
  };
  return { dir, w, ports, sim: ownerSim(w.root, ports.clock), at: { root: w.root, repo: w.repo }, logs, writers, judges, preferred, deps };
}

/** The owner answered `left` everywhere: judges prefer known_better on known pairs, else the owner's first answer. */
function teach(h: H, set: CalibSetRecord): void {
  for (const p of set.pairs) {
    const first = set.display.find((d) => d.pair === p.id && d.retest_of === null);
    const want = p.known_better ?? first?.left;
    for (const id of [p.a, p.b]) {
      const t = set.texts[id];
      if (t === undefined) throw new Error(`no text ${id}`);
      h.preferred.set(anonymizeText(readFileSync(join(h.w.root, 'calibration', t.path), 'utf8')), id === want);
    }
  }
}

function fileSha(path: string): string {
  return existsSync(path) ? sha256Bytes(readFileSync(path)) : 'absent';
}

function judgeCalls(h: H, kind: string): string[] {
  return h.judges.flatMap((j) => j.log().filter((c) => c.taskId.startsWith(`${kind}-`)).map((c) => `${c.taskId}#${c.attempt}`));
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
}

async function calib(h: H, argv: readonly string[], deps: EngineDeps = h.deps()): Promise<number> {
  h.logs.length = 0;
  return calibCommand(argv, deps, h.at);
}

test('forge calib build / run / score: C00 end to end on the fixture world (kill and resume inside c4-judge)', async () => {
  const h = harness();
  const root = h.w.root;
  const ownerLog = join(root, 'owner-log.jsonl');
  const ownerAnswers = join(root, 'calibration', 'owner-answers.json');
  const pairsFile = join(root, 'calibration', 'pairs.json');
  assert.equal(await calib(h, ['run']), 1, 'nothing built yet');
  assert.match(h.logs.join('\n'), /C00 is not built/u);

  const logBefore = fileSha(ownerLog);
  assert.equal(await calib(h, ['build']), 0, h.logs.join('\n'));
  const cur = await h.ports.git.currentBranch();
  assert.deepEqual(cur, { ok: true, value: 'forge/r00' }, 'C00 runs on forge/r00');
  const writerTasks = h.writers.flatMap((r) => r.log().map((c) => c.taskId));
  assert.equal(new Set(writerTasks).size, 46, '42 gateway rewrites / degrades + 4 dry-run defect copies');
  const set = readCalibSet(root, 'C00');
  assert.ok(set.ok);
  if (!set.ok) return;
  assert.deepEqual([set.value.size, set.value.pairs.length, set.value.dryrun.length], [28, 24, 4]);
  const pairsBytes = readFileSync(pairsFile, 'utf8');
  assert.equal(await calib(h, ['build']), 1, 'a second build is refused');
  assert.match(h.logs.join('\n'), /C00 is already built/u);
  assert.equal(readFileSync(pairsFile, 'utf8'), pairsBytes, 'the pairs.json set is never rewritten');

  assert.equal(await calib(h, ['run']), 2, h.logs.join('\n'));
  assert.match(h.logs.join('\n'), /waiting for calib_answers/u);
  const paths = calibPaths(root, 'C00');
  assert.deepEqual(filesUnder(paths.taste), [], 'no taste verdict before the owner answered');
  assert.equal(filesUnder(paths.gate).length, 16, '4 dry-run copies × 4 judge families');
  assert.equal(judgeCalls(h, 'calib').length, 0);
  assert.equal(await calib(h, ['score']), 1, 'score needs c4-judge');
  assert.equal(fileSha(ownerLog), logBefore, 'build and run leave owner-log.jsonl alone');
  assert.equal(fileSha(ownerAnswers), 'absent');

  h.sim.answerCalibration('C00', () => 'left');
  const answersSha = fileSha(ownerAnswers);
  const logSha = fileSha(ownerLog);
  teach(h, set.value);
  let n = 0;
  const kill: RunHooks = { beforeCall: (taskId) => { if (taskId.startsWith('calib-') && (n += 1) > 60) throw new Error('killed inside c4-judge'); } };
  await assert.rejects(calib(h, ['run'], h.deps(kill, 5001)), /killed inside c4-judge/u);
  await Promise.all(h.judges.map((j) => j.settled()));
  const killed = judgeCalls(h, 'calib');
  assert.ok(killed.length >= 60 && killed.length < 180, `${killed.length} calls before the kill`);
  assert.equal(await calib(h, ['run'], h.deps(undefined, 5002)), 0, h.logs.join('\n'));
  const all = judgeCalls(h, 'calib');
  assert.equal(all.length, 180, '180 taste calls in all (the fake routers log every call of both runs)');
  assert.equal(new Set(all).size, 180, 'no finished call is repeated');
  assert.equal(all.filter((c) => !killed.includes(c)).length, 180 - killed.length);
  const verdicts = readVerdicts(paths);
  assert.ok(verdicts.ok && verdicts.value.length === 180);

  assert.equal(await calib(h, ['score']), 0, h.logs.join('\n'));
  const report = parseCalibReport(JSON.parse(readFileSync(join(root, 'calibration', 'round0.json'), 'utf8')));
  assert.ok(report.ok, report.ok ? '' : report.error);
  if (!report.ok) return;
  assert.equal(report.value.valid, true, report.value.invalid_reason ?? '');
  assert.deepEqual([...report.value.qualified].sort(), ['Anthropic', 'Moonshot', 'OpenAI'], JSON.stringify(report.value.families));
  assert.equal(report.value.families.xAI?.qualified, false);
  assert.equal(report.value.families.xAI?.nonknown.agree, 0);
  assert.equal(report.value.gate_dryrun.xAI?.gate_judge, true);
  assert.equal(report.value.canon_rounds_may_start, true);

  const statusText = readFileSync(join(root, 'calibration', 'status.json'), 'utf8');
  const status = parseTrustStatus(JSON.parse(statusText));
  assert.ok(status.ok, status.ok ? '' : status.error);
  if (!status.ok) return;
  assert.deepEqual([status.value.families.xAI?.qualified, status.value.families.xAI?.gate_judge], [false, true]);
  const config = loadConfig(root, { requireLocal: true });
  const bundle = loadProtocolBundle(root);
  assert.ok(config.ok && bundle.ok);
  if (!config.ok || !bundle.ok) return;
  const pins = trustPins(status.value, 'R01', config.value.judges, new Set(), bundle.value.protocol.calibration);
  assert.ok(pins.ok, pins.ok ? '' : pins.error);
  if (pins.ok) {
    assert.deepEqual([...pins.value.eligibleFamilies].sort(), ['Anthropic', 'Moonshot', 'OpenAI']);
    assert.equal(pins.value.gateFamilies.length, 4);
  }
  const labelsText = readFileSync(join(root, 'calibration', 'labels.json'), 'utf8');
  const ledger = parseLabelLedger(JSON.parse(labelsText));
  assert.ok(ledger.ok, ledger.ok ? '' : ledger.error);
  if (ledger.ok) assert.deepEqual([ledger.value.labels.length, visibleLabels(ledger.value).length], [24, 12]);
  assert.deepEqual([fileSha(ownerAnswers), fileSha(ownerLog)], [answersSha, logSha], 'run and score leave the owner files alone');
  assert.equal(await calib(h, ['score']), 0);
  assert.deepEqual([readFileSync(join(root, 'calibration', 'status.json'), 'utf8'), readFileSync(join(root, 'calibration', 'labels.json'), 'utf8')], [statusText, labelsText], 'a rerun is byte-identical');

  // Between rounds: requal refusals, then Q01 on forge/calib-q01 once forge/r00 is merged.
  const refusals: Array<[string[], RegExp]> = [
    [['build', '--requal', 'xAI', '--reason', 'suspension'], /xAI is not suspended/u],
    [['build', '--requal', 'OpenAI', '--reason', 'calibration_fail'], /OpenAI is qualified/u],
    [['build', '--requal', 'xAI', '--reason', 'calibration_fail'], /on branch forge\/r00 with a dirty working tree/u],
  ];
  for (const [argv, want] of refusals) {
    assert.equal(await calib(h, argv), 1, argv.join(' '));
    assert.match(h.logs.join('\n'), want);
  }
  assert.ok(!existsSync(join(root, 'calibration', 'Q01')), 'a refused build writes nothing');
  assert.ok((await h.ports.git.commit([h.w.repo], 'round 0 calibration')).ok);
  assert.equal(await calib(h, ['build', '--requal', 'xAI', '--reason', 'calibration_fail']), 1);
  assert.match(h.logs.join('\n'), /forge\/r00 not merged into main yet/u);
  h.ports.git.mergeToMain('forge/r00');
  assert.ok((await h.ports.git.checkout('main')).ok);
  const gatewayBefore = h.writers.slice(0, 2).flatMap((r) => r.log()).length;
  assert.equal(await calib(h, ['build', '--requal', 'xAI', '--reason', 'calibration_fail']), 0, h.logs.join('\n'));
  assert.deepEqual(await h.ports.git.currentBranch(), { ok: true, value: 'forge/calib-q01' });
  assert.equal(h.writers.slice(0, 2).flatMap((r) => r.log()).length - gatewayBefore, 21, '3 canon_vs_rewrite × 1 + 3 cross_model × 2 + 3 stance × 2 + 3 known × 2');
  const q01 = readCalibSet(root, 'Q01');
  assert.ok(q01.ok && q01.value.family === 'xAI' && q01.value.reason === 'calibration_fail' && q01.value.pairs.length === 12);
  assert.deepEqual(defaultSet(root), { ok: true, value: 'Q01' });
  assert.equal(await calib(h, ['run']), 2, 'a requal set waits for its owner answers');
  assert.match(h.logs.join('\n'), /Q01: waiting at c3-owner-answers/u);
  assert.equal(await calib(h, ['build', '--gate', 'xAI']), 1, 'Q01 is still open on its branch');
  assert.match(h.logs.join('\n'), /on branch forge\/calib-q01 with a dirty working tree; calibration set G01 runs on forge\/calib-g01/u);
  assert.ok(!existsSync(join(root, 'calibration', 'G01')));

  const leaks = filesUnder(root).filter((f) => relative(root, f).split(sep).join('/') !== 'local.json' && readFileSync(f).includes(h.w.gatewayHost));
  assert.deepEqual(leaks, [], 'the gateway host only in the git-ignored local.json');
  rmSync(h.dir, { recursive: true });
});

test('parseCalibArgs / calibBranch: build, run and score forms; bad flags are usage errors', () => {
  assert.deepEqual(parseCalibArgs(['build']), { ok: true, value: { cmd: 'build', req: { kind: 'round0' }, quotaBudgetMs: null } });
  assert.deepEqual(parseCalibArgs(['build', '--requal', 'xAI', '--reason', 'suspension', '--quota-budget-min', '5']), { ok: true, value: { cmd: 'build', req: { kind: 'requal', family: 'xAI', reason: 'suspension' }, quotaBudgetMs: 300_000 } });
  assert.deepEqual(parseCalibArgs(['build', '--gate', 'OpenAI']), { ok: true, value: { cmd: 'build', req: { kind: 'gate', family: 'OpenAI' }, quotaBudgetMs: null } });
  assert.deepEqual(parseCalibArgs(['run', '--set', 'Q02', '--only', 'c4-judge']), { ok: true, value: { cmd: 'run', set: 'Q02', only: 'c4-judge', quotaBudgetMs: null } });
  assert.deepEqual(parseCalibArgs(['score']), { ok: true, value: { cmd: 'score', set: null } });
  const bad: Array<[string[], RegExp]> = [
    [[], /usage: forge calib build/u],
    [['build', '--requal', 'xAI'], /--reason calibration_fail\|suspension/u],
    [['build', '--requal', 'xAI', '--reason', 'boredom'], /--reason calibration_fail\|suspension/u],
    [['build', '--reason', 'suspension'], /--reason needs --requal/u],
    [['build', '--requal', 'xAI', '--reason', 'suspension', '--gate', 'xAI'], /exclude each other/u],
    [['build', '--gate', 'Nobody'], /not a family/u],
    [['build', 'C00'], /usage: forge calib build/u],
    [['run', '--set', 'R01'], /set ids look like C00/u],
    [['run', '--only', 'c5-score'], /calib run steps are c2-gate-dryrun, c3-owner-answers, c4-judge/u],
    [['score', '--only', 'c5-score'], /unknown option --only/u],
    [['run', '--quota-budget-min', '0'], /--quota-budget-min must be/u],
  ];
  for (const [argv, want] of bad) {
    const r = parseCalibArgs(argv);
    assert.equal(r.ok, false, argv.join(' '));
    if (!r.ok) assert.match(r.error, want, argv.join(' '));
  }
  assert.deepEqual(['C00', 'Q01', 'G12'].map(calibBranch), ['forge/r00', 'forge/calib-q01', 'forge/calib-g12']);
});

function family(over: Partial<FamilyTrust>): FamilyTrust {
  return {
    qualified: true, qualified_by: 'C00', requal_used: { calibration_fail: false, suspension: false }, gate_judge: true, gate_by: 'C00',
    agreement: { epoch: 'C00', n: 0, k: 0, alpha: 1, beta: 1, mean: 0.5, ci90: [0.05, 0.95], p_below: 0.6, state: 'ok' }, suspended_at: null, ...over,
  };
}

test('buildRefusal: C00 once; requal only for an unqualified / suspended family with that reason unused; gate needs a judge family', () => {
  const status: TrustStatus = {
    schema: 'trust-status/1', updated_after: 'C00', labels_sha256: 'a'.repeat(64),
    families: {
      OpenAI: family({}), xAI: family({ qualified: false, qualified_by: null, requal_used: { calibration_fail: true, suspension: false } }),
      Moonshot: family({ qualified: false, qualified_by: null }), Anthropic: family({ suspended_at: 'R03', agreement: { ...family({}).agreement, state: 'suspended' } }),
    },
  };
  const c00 = ['C00'];
  assert.equal(buildRefusal(null, { kind: 'round0' }, []), null);
  assert.match(buildRefusal(status, { kind: 'round0' }, c00) ?? '', /C00 is already built/u);
  assert.match(buildRefusal(null, { kind: 'gate', family: 'xAI' }, []) ?? '', /score C00 first/u);
  assert.match(buildRefusal(null, { kind: 'gate', family: 'xAI' }, c00) ?? '', /status\.json is missing/u);
  assert.equal(buildRefusal(status, { kind: 'requal', family: 'Moonshot', reason: 'calibration_fail' }, c00), null);
  assert.match(buildRefusal(status, { kind: 'requal', family: 'OpenAI', reason: 'calibration_fail' }, c00) ?? '', /OpenAI is qualified/u);
  assert.match(buildRefusal(status, { kind: 'requal', family: 'xAI', reason: 'calibration_fail' }, c00) ?? '', /already used its calibration_fail/u);
  assert.equal(buildRefusal(status, { kind: 'requal', family: 'Anthropic', reason: 'suspension' }, c00), null);
  assert.match(buildRefusal(status, { kind: 'requal', family: 'OpenAI', reason: 'suspension' }, c00) ?? '', /OpenAI is not suspended/u);
  assert.equal(buildRefusal(status, { kind: 'gate', family: 'xAI' }, c00), null);
  assert.match(buildRefusal(status, { kind: 'gate', family: 'DeepSeek' }, c00) ?? '', /DeepSeek is not a judge family/u);
});

test('nextSetId / pendingBuild / defaultSet read pairs.json keys, set dirs and markers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-cli-calib-ids-'));
  const set = (id: string, file: string, text: string): void => {
    mkdirSync(join(dir, 'calibration', id), { recursive: true });
    writeFileSync(join(dir, 'calibration', id, file), text);
  };
  assert.deepEqual([nextSetId(dir, 'round0'), nextSetId(dir, 'requal'), pendingBuild(dir), defaultSet(dir)], [{ ok: true, value: 'C00' }, { ok: true, value: 'Q01' }, { ok: true, value: null }, { ok: true, value: 'C00' }]);
  set('C00', 'request.json', '{}');
  set('Q03', 'notes.txt', '');
  assert.equal(nextSetId(dir, 'round0').ok, false, 'C00 once');
  assert.deepEqual([nextSetId(dir, 'requal'), nextSetId(dir, 'gate')], [{ ok: true, value: 'Q04' }, { ok: true, value: 'G01' }]);
  assert.deepEqual([pendingBuild(dir), defaultSet(dir)], [{ ok: true, value: 'C00' }, { ok: true, value: 'C00' }]);
  set('G01', 'request.json', '{}');
  assert.equal(pendingBuild(dir).ok, false, 'two unfinished builds');
  assert.match(defaultSet(dir).ok ? '' : 'several', /several/u);
  rmSync(dir, { recursive: true });
});

test('productionBackends: calibGateway = one gateway backend per build.json model (calibration pipeline only)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-cli-calib-backends-'));
  const w = fixtureWorld(dir, { ...DEFAULT_FIXTURE, trust: 'none' });
  const config = loadConfig(w.root, { requireLocal: true });
  const prices = parsePrices(JSON.parse(readFileSync(join(w.root, 'prices.json'), 'utf8')));
  if (!config.ok || !prices.ok) throw new Error('fixture config');
  assert.deepEqual(calibModels(config.value), ['deepseek-fixture-a', 'qwen/fixture-b']);
  const b = productionBackends(config.value, prices.value, calibModels(config.value));
  assert.deepEqual([...b.calibGateway].map(([model, be]) => [model, be.id, be.family, be.model]), [
    ['deepseek-fixture-a', 'gateway-deepseek-fixture-a', 'DeepSeek', 'deepseek-fixture-a'], ['qwen/fixture-b', 'gateway-qwen_fixture-b', 'Alibaba', 'qwen/fixture-b'],
  ]);
  assert.equal(productionBackends(config.value, prices.value).calibGateway.size, 0);
  writeFileSync(join(w.root, 'calibration', 'build.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(w.root, 'calibration', 'build.json'), 'utf8')), contrast_models: ['gpt-6-astra'] }));
  assert.deepEqual(calibModels(config.value), [], 'a judge-family model is refused (c1 then fails on the config)');
  rmSync(dir, { recursive: true });
});
