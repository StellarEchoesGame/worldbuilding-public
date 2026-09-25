import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { FakeReply } from '../adapters/fake.ts';
import { loadConfig, type Family } from '../config.ts';
import { buildContext, type RoundBackends, type StepContext } from '../context.ts';
import { buildFreeze, type FreezeFlag } from '../freeze.ts';
import { isRecord } from '../json.ts';
import { sha256Bytes } from '../marker.ts';
import { probeFiles, parseProbeRecord } from '../probe.ts';
import { runSteps, stepsSha256, type StepDef, type StepId } from '../runner.ts';
import { loadSchema, validate } from '../schema.ts';
import { roundPaths, sha256 } from '../store.ts';
import { surpriseRoles } from '../tasks/assign.ts';
import { unwrap } from '../tasks/fenced.ts';
import { CANON_AUTHOR } from '../tasks/surprise.ts';
import { fakePorts, type FakePorts } from '../testing/fakes.ts';
import { DEFAULT_FIXTURE, FIXTURE_AT, FIXTURE_WRITER_MODEL, fixtureWorld, type FixtureWorld } from '../testing/fixture-world.ts';
import { callLog, fakeRouter, type FakeRouter, type Route } from '../testing/scripted.ts';
import type { BriefJson } from './brief.ts';
import { forecastStep } from './forecast.ts';
import { measurePath, type RecallFile } from './measures.ts';
import { probeMirrorStep } from './probe-mirror.ts';
import { sealStep } from './seal.ts';
import { readUnsealFile, surpriseFor, surpriseStep, unsealPath, unsealStep } from './surprise.ts';

const ROUND = 'R01';
const BRANCH = 'forge/r01';
const ISSUE = 12;
const START_ISO = '2026-10-01T00:00:00.000Z';
const JUDGES: readonly Family[] = ['Anthropic', 'Moonshot', 'OpenAI', 'xAI'];
const TEXT = '温芮把借来的扳手挂回第三邻里的工具墙。循环泵换了节拍，走廊里的灯带转成琥珀色。林澈说冷凝管今晚要换滤网。';
const CANON_FILE = 'reference/05-ecology-and-everyday.md';
const CANON_TEXT = '在远航号的第三邻里，维修工在配给簿上记下每一次借用和归还。\n\n循环泵的节拍决定邻里的作息。';

function sealedValue(id: string, i: number): string {
  return `封存预测${id}号${i}件铝饭盒`;
}

function fenced(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

function forecastReply(id: string): string {
  const slots = ['主角', '愿望', '代价', '物件', '习俗', '声音', '气味', '结局'];
  return fenced({ forecasts: slots.map((slot, i) => ({ slot, value: sealedValue(id, i) })) });
}

function brief(seed: string): BriefJson {
  return {
    round: ROUND, kind: 'round', row_id: 'SHIP', layer: '日常', topic_source: 'fixed',
    cell: {
      id: 'ship-neighbourhood', row_id: 'SHIP', title: '第三邻里的夜班', entity: '远航号第三邻里', time: '跃迁后第三年',
      layers: ['日常'], setting_notes: [], protagonists: ['温芮'], forbidden: [], stances: [{ id: 'daily', text: '住民的一天' }],
    },
    canon: { revision: '8.1', book_sha256: 'a'.repeat(64), reference_sha256: 'b'.repeat(64) },
    canon_passages: [{ file: CANON_FILE, text: CANON_TEXT }],
    facts: [], regression: [], regression_stale: [], forbidden: [], cliches: [], requirements: ['一个具名主角'], interface_requirements: [], aliases: ['远航号'],
    seed, created_at: START_ISO,
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The ids of `〔label〕` lines `D1｜…` / `P07｜…`. */
function idsOf(prompt: string, label: string): string[] {
  return (unwrap(prompt, label) ?? '').split('\n').map((l) => l.split('｜')[0] ?? '').filter((x) => x !== '');
}

const matchRoute: Route = (prompt) => {
  const writerForecast = (unwrap(prompt, '预测') ?? '').split('\n').find((l) => l.includes(sealedValue('gw-deepseek', 3)))?.split('｜')[0] ?? null;
  return fenced({ matches: idsOf(prompt, '细节').map((d) => (d === 'D1' ? { detail: d, forecast: writerForecast, relation: 'same' } : { detail: d, forecast: null, relation: 'none' })) });
};

const chainRoute: Route = (prompt) => {
  const offered = unwrap(prompt, '正典') ?? '';
  const file = /〔文件：([^〕]+)〕/u.exec(offered)?.[1] ?? '';
  return fenced({ chains: idsOf(prompt, '细节').map((d) => ({ detail: d, canon: { file, quote: '维修工在配给簿上记下每一次借用和归还' }, steps: ['借用要登记，所以工具会被还回原处。'], lands_on: '扳手挂回工具墙' })) });
};

const acceptRoute: Route = (prompt) => fenced({ verdicts: idsOf(prompt, '链').map((d) => ({ detail: d, accept: true, reason: '登记推出归还' })) });

interface H {
  dir: string;
  w: FixtureWorld;
  ports: FakePorts;
  ctx: StepContext;
  routers: FakeRouter[];
  seed: string;
}

interface Opts {
  seed?: string;
  flags?: Record<string, FreezeFlag>;
  routes?: (family: Family) => Record<string, Route>;
  voidForecasts?: boolean;
  surpriseActive?: boolean;
}

/** Fixture round run through 02c (toy) → 03a → 03b → 03c with the real steps; then W1 and its recall file exist. */
async function harness(opts: Opts = {}): Promise<H> {
  const seed = opts.seed ?? 'e'.repeat(64);
  const dir = mkdtempSync(join(tmpdir(), 'forge-surprise-'));
  const w = fixtureWorld(dir, DEFAULT_FIXTURE);
  const loaded = loadConfig(w.root, { requireLocal: true });
  if (!loaded.ok) throw new Error(loaded.error);
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: START_ISO, seed: 'surprise-ports' });
  const baseSha = await ports.git.resolveRef('main');
  assert.ok(baseSha.ok);
  assert.ok((await ports.git.createBranch(BRANCH, 'main')).ok);
  assert.ok((await ports.git.checkout(BRANCH)).ok);
  const routers: FakeRouter[] = [];
  const forecast = (id: string): Route => (): FakeReply => (opts.voidForecasts === true ? { error: 'forecaster down' } : forecastReply(id));
  const judges = loaded.value.judges.map((j) => {
    const extra = opts.routes === undefined ? {} : opts.routes(j.family);
    const r = fakeRouter({ forecast: forecast(j.id), match: matchRoute, chain: chainRoute, accept: acceptRoute, ...extra }, { id: j.id, family: j.family, model: j.model });
    routers.push(r);
    return { backend: r, concurrency: j.concurrency };
  });
  const gateway = fakeRouter({ forecast: forecast('gw-deepseek') }, { id: 'gw-deepseek', family: 'DeepSeek', model: FIXTURE_WRITER_MODEL });
  const plain = fakeRouter({}, { id: 'W1', family: 'DeepSeek', model: FIXTURE_WRITER_MODEL });
  const backends: RoundBackends = {
    writers: [{ slot: 'W1', backend: plain }], baseline: plain, decoy: plain, defect: plain, judges, forecasters: [...judges.map((j) => j.backend), gateway],
    maintainer: plain, mergeEditor: plain, calibGateway: new Map(),
  };
  const built = buildContext({
    root: w.root, repo: w.repo, roundId: ROUND, pipeline: 'round', paths: roundPaths(w.root, ROUND), config: loaded.value,
    deps: { ports, backends: () => backends, env: {}, pid: 1001, isAlive: (pid) => pid === 1001, log: () => undefined },
    startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
  });
  if (!built.ok) throw new Error(built.error);
  const ctx = built.value;
  mkdirSync(ctx.paths.dir, { recursive: true });
  writeFileSync(ctx.paths.start, json({
    round: ROUND, seed, branch: BRANCH, base_sha: baseSha.value, issue: { number: ISSUE, url: `https://github.invalid/fake/issues/${ISSUE}` },
    bundle_sha256: ctx.bundleSha256, doctor_sha256: sha256('doctor'), started_at: START_ISO, cell: 'cells/ship.json',
  }));
  writeFileSync(ctx.paths.topic, json({ round: ROUND, row_id: 'SHIP', layer: '日常', cell: 'cells/ship.json', source: 'fixed', chosen_at: START_ISO }));
  writeFileSync(ctx.paths.brief, json(brief(seed)));
  let benchPath = 'benchmark/v1.json';
  if (opts.surpriseActive === false) {
    const v1: unknown = JSON.parse(readFileSync(join(w.root, benchPath), 'utf8'));
    if (!isRecord(v1)) throw new Error('v1');
    benchPath = 'benchmark/v2.json';
    writeFileSync(join(w.root, benchPath), json({ ...v1, version: 'v2', parent: 'v1', measures: { surprise: { active: false, prompt: null } } }));
  }
  const flags = opts.flags ?? { Anthropic: 'ok', Moonshot: 'ok', OpenAI: 'ok', xAI: 'ok' };
  const pipe: StepId[] = ['02c-freeze', '03a-forecast', '03b-seal', '03c-probe-mirror'];
  const toyFreeze: StepDef = {
    id: '02c-freeze',
    run: async (c) => {
      const version = benchPath === 'benchmark/v1.json' ? 'v1' : 'v2';
      const record = buildFreeze({
        round: ROUND, files: { 'brief.json': readFileSync(c.paths.brief, 'utf8') }, benchmarkVersion: version,
        eligibleFamilies: Object.keys(flags).filter((f) => flags[f] === 'ok'), flags, protocolBundleSha256: c.bundleSha256, probeCreatedAt: null, seed,
        stepsSha256: stepsSha256(pipe), benchmarkResolution: { version, sha256: sha256Bytes(readFileSync(join(c.root, benchPath))), path: benchPath, via: 'activate', since: FIXTURE_AT },
        gateFamilies: [...JUDGES], trustStatusSha256: null, skills: {},
      });
      return { kind: 'done', inputs: [c.files.rel(c.paths.brief)], outputs: [c.files.writeJson(c.paths.freeze, record)], external: [] };
    },
  };
  const report = await runSteps(ctx, { pipeline: 'round', steps: [toyFreeze, forecastStep, sealStep, probeMirrorStep], until: null, from: null, redoFrom: null, pid: 1001, isAlive: (p) => p === 1001 });
  assert.equal(report.exitCode, 0, report.detail ?? '');
  const writer = ['```submission', TEXT, '```', '```delta', '{"new_proper_nouns":[],"claims":[]}', '```', '```interface', '{"shots":[{},{},{}],"object":{"n":1},"hook":{"h":1}}', '```', '种子：', '- 一'].join('\n');
  mkdirSync(ctx.paths.submissions, { recursive: true });
  writeFileSync(join(ctx.paths.submissions, 'W1.json'), JSON.stringify({ id: 'W1', kind: 'writer', model: FIXTURE_WRITER_MODEL, family: 'DeepSeek', stance: 'daily', ok: true, error: null, text: writer }));
  const recall: RecallFile = {
    round: ROUND, submission: 'W1', hook: 0.5,
    calls: JUDGES.map((family) => ({ family, task: `recall-W1-${family}`, status: 'ok', image: '灯带', quote: '灯带转成琥珀色', error: null })),
    details: [
      { id: 'D1', submission: 'W1', image: '琥珀色灯带', quote: '走廊里的灯带转成琥珀色', families: ['Anthropic', 'Moonshot'] },
      { id: 'D2', submission: 'W1', image: '扳手', quote: '借来的扳手挂回第三邻里', families: ['OpenAI'] },
    ],
  };
  mkdirSync(join(ctx.paths.measures, 'recall'), { recursive: true });
  writeFileSync(measurePath(ctx, 'recall', 'W1'), json(recall));
  return { dir, w, ports, ctx, routers, seed };
}

function calls(h: H): string[] {
  return h.routers.flatMap(callLog).filter((c) => !c.startsWith('forecast-')).sort();
}

function readJsonAt(path: string): Record<string, unknown> {
  const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(v)) throw new Error(`${path} is not an object`);
  return v;
}

function report(h: H): Record<string, unknown> {
  const subs = readJsonAt(join(h.ctx.paths.dir, 'surprise.json'))['submissions'];
  const w1 = isRecord(subs) ? subs['W1'] : null;
  if (!isRecord(w1)) throw new Error('no W1 report');
  return w1;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** No sealed forecast value in any file outside .sealed/ and .runs/ (prompts live in .runs/ only). */
function assertNoLeak(h: H): void {
  for (const p of walk(h.w.root)) {
    const rel = relative(h.w.root, p);
    if (rel.startsWith('.sealed') || rel.startsWith('.runs')) continue;
    const text = readFileSync(p, 'utf8');
    assert.ok(!text.includes('封存预测'), `sealed value leaked into ${rel}`);
  }
}

/** A seed whose surpriseRoles over `pool` for W1 satisfies `want`. */
function seedWhere(pool: readonly Family[], want: (acceptor: Family | null, matchers: readonly Family[]) => boolean): string {
  for (let i = 1; i < 500; i += 1) {
    const seed = i.toString(16).padStart(8, '0');
    const r = surpriseRoles(pool, seed, 'W1');
    if (want(r.acceptor, r.matchers)) return seed;
  }
  throw new Error('no seed found');
}

const SCHEMAS = new Map(['unseal', 'surprise'].map((n) => [n, loadSchema(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'schema', `${n}.schema.json`), 'utf8')))]));

function schemaErrors(name: string, value: unknown): string[] {
  const s = SCHEMAS.get(name);
  if (s === undefined || !s.ok) return ['schema missing'];
  return validate(s.value, value);
}

test('07a writes unseal.json without forecasts; 07b with 4 families: matchers ×2, chain writer, acceptor → full; writer_default tagged', async () => {
  const seed = seedWhere(JUDGES, (a) => a !== null && a !== CANON_AUTHOR);
  const h = await harness({ seed });
  const u = await unsealStep.run(h.ctx, null);
  assert.equal(u.kind, 'done');
  if (u.kind !== 'done') return;
  assert.deepEqual(u.outputs, ['rounds/R01/unseal.json']);
  assert.deepEqual(u.inputs, ['rounds/R01/probes.sha256', 'rounds/R01/probe.json', '.sealed/R01/sealed.json', '.sealed/R01/nonce.hex']);
  const unsealed = readUnsealFile(h.ctx);
  assert.ok(unsealed.ok);
  assert.deepEqual([unsealed.value.status, unsealed.value.remote, unsealed.value.reasons, unsealed.value.forecasters], ['valid', 'verified', [], 5]);
  assert.deepEqual(schemaErrors('unseal', readJsonAt(unsealPath(h.ctx))), []);
  const out = await surpriseFor(h.ctx, ['W1']);
  assert.equal(out.kind, 'done');
  const roles = surpriseRoles(JUDGES, seed, 'W1');
  assert.deepEqual(calls(h), [`accept-W1-${roles.acceptor}#1`, `chain-W1-${roles.chainWriter}#1`, ...roles.matchers.map((f) => `match-W1-${f}#1`)].sort());
  const r = report(h);
  assert.deepEqual([r['status'], r['surprising'], r['eligible'], r['forecast'], r['drift'], r['unresolved'], r['acceptor_reused']], ['full', 1, 2, 1, 0, 0, false]);
  assert.deepEqual(r['roles'], { matchers: roles.matchers, chain_writer: roles.chainWriter, acceptor: roles.acceptor });
  const details = Array.isArray(r['details']) ? r['details'].filter(isRecord) : [];
  assert.deepEqual(details.map((d) => [d['id'], d['outcome'], d['writer_default']]), [['D1', 'forecast', true], ['D2', 'surprising', false]]);
  assert.match(String(Array.isArray(details[0]?.['forecasts']) ? details[0]?.['forecasts'][0] : ''), /^P\d{2}$/u, 'opaque forecast ids only');
  const chain = details[1]?.['chain'];
  assert.ok(isRecord(chain) && isRecord(chain['canon']) && chain['canon']['file'] === CANON_FILE);
  assert.equal(details[1]?.['accept_reason'], '登记推出归还');
  assert.deepEqual(schemaErrors('surprise', readJsonAt(join(h.ctx.paths.dir, 'surprise.json'))), []);
  const matchPrompt = h.routers.flatMap((x) => x.log()).find((c) => c.taskId.startsWith('match-'))?.prompt ?? '';
  assert.ok(matchPrompt.includes(sealedValue('claude', 0)), 'the matcher sees forecast values after the unseal');
  const lines = (unwrap(matchPrompt, '预测') ?? '').split('\n');
  assert.equal(lines.length, 40);
  for (const line of lines) assert.match(line, /^P\d{2}｜[^｜]+｜封存预测/u, 'id｜slot｜value, no forecaster or model');
  assert.ok(!matchPrompt.includes(FIXTURE_WRITER_MODEL));
  assertNoLeak(h);
  const before = calls(h).length;
  assert.equal((await surpriseFor(h.ctx, ['W1'])).kind, 'done');
  assert.equal(calls(h).length, before, 'resume reuses the task records');
  rmSync(h.dir, { recursive: true });
});

test('a chain quoting an 8.1 canon sentence is never offered to an OpenAI acceptor (4 families → matcher reused; 3 families → the other matcher)', async () => {
  const seed4 = seedWhere(JUDGES, (a) => a === CANON_AUTHOR);
  const h = await harness({ seed: seed4 });
  assert.equal((await unsealStep.run(h.ctx, null)).kind, 'done');
  assert.equal((await surpriseFor(h.ctx, ['W1'])).kind, 'done');
  const roles = surpriseRoles(JUDGES, seed4, 'W1');
  assert.equal(roles.acceptor, 'OpenAI', 'the seeded acceptor would have been OpenAI');
  assert.ok(!calls(h).some((c) => c.startsWith('accept-W1-OpenAI')));
  const r = report(h);
  const expected = roles.matchers.find((f) => f !== 'OpenAI');
  assert.deepEqual([r['status'], r['acceptor_reused'], isRecord(r['roles']) ? r['roles']['acceptor'] : null], ['reused', true, expected]);
  assert.ok(calls(h).includes(`accept-W1-${expected}#1`), 'a fresh session of a matcher family, distinct task id');
  rmSync(h.dir, { recursive: true });

  const three: Family[] = ['Anthropic', 'Moonshot', 'OpenAI'];
  const seed3 = seedWhere(three, (_a, m) => m[0] === 'OpenAI');
  const h3 = await harness({ seed: seed3, flags: { Anthropic: 'ok', Moonshot: 'ok', OpenAI: 'ok', xAI: 'unqualified' } });
  assert.equal((await unsealStep.run(h3.ctx, null)).kind, 'done');
  assert.equal((await surpriseFor(h3.ctx, ['W1'])).kind, 'done');
  const r3 = surpriseRoles(three, seed3, 'W1');
  assert.ok(!calls(h3).some((c) => c.startsWith('accept-W1-OpenAI')));
  assert.ok(calls(h3).includes(`accept-W1-${r3.matchers[1]}#1`));
  assert.deepEqual([report(h3)['status'], report(h3)['acceptor_reused']], ['reused', true]);
  rmSync(h3.dir, { recursive: true });
});

test('4 / 3 / 2 / 1 eligible families → full / reused / match_only / insufficient', async () => {
  const cases: Array<{ flags: Record<string, FreezeFlag>; status: string; kinds: string[]; outcomes: string[] }> = [
    { flags: { Anthropic: 'ok', Moonshot: 'ok', OpenAI: 'unqualified', xAI: 'ok' }, status: 'reused', kinds: ['accept', 'chain', 'match', 'match'], outcomes: ['forecast', 'surprising'] },
    { flags: { Anthropic: 'ok', Moonshot: 'ok', OpenAI: 'unqualified', xAI: 'flagged' }, status: 'match_only', kinds: ['match', 'match'], outcomes: ['forecast', 'unresolved'] },
    { flags: { Anthropic: 'ok', Moonshot: 'suspended', OpenAI: 'unqualified', xAI: 'flagged' }, status: 'insufficient', kinds: [], outcomes: ['unresolved', 'unresolved'] },
  ];
  for (const c of cases) {
    const h = await harness({ flags: c.flags });
    assert.equal((await unsealStep.run(h.ctx, null)).kind, 'done');
    assert.equal((await surpriseFor(h.ctx, ['W1'])).kind, 'done');
    const r = report(h);
    assert.equal(r['status'], c.status);
    assert.deepEqual(calls(h).map((x) => x.split('-')[0]).sort(), c.kinds, c.status);
    const details = Array.isArray(r['details']) ? r['details'].filter(isRecord) : [];
    assert.deepEqual(details.map((d) => d['outcome']), c.outcomes, c.status);
    assert.equal(r['eligible'], c.outcomes.filter((o) => o !== 'unresolved').length, 'eligible excludes unresolved details');
    rmSync(h.dir, { recursive: true });
  }
});

test('voids: a void matcher makes every detail forecast; a void chain writer leaves open details unresolved; a void acceptor too', async () => {
  const junk: Route = () => 'no fence';
  const firstMatcher = surpriseRoles(JUDGES, 'e'.repeat(64), 'W1').matchers[0];
  const matcherVoid = await harness({ routes: (f) => (f === firstMatcher ? { match: junk } : {}) });
  await unsealStep.run(matcherVoid.ctx, null);
  await surpriseFor(matcherVoid.ctx, ['W1']);
  const outcomes = (h: H): unknown[] => {
    const details = report(h)['details'];
    return Array.isArray(details) ? details.map((d: unknown) => (isRecord(d) ? d['outcome'] : null)) : [];
  };
  assert.deepEqual(outcomes(matcherVoid), ['forecast', 'forecast']);
  assert.ok(calls(matcherVoid).includes(`match-W1-${firstMatcher}#2`) && !calls(matcherVoid).some((c) => c.startsWith('chain-')));
  rmSync(matcherVoid.dir, { recursive: true });
  const chainVoid = await harness({ routes: () => ({ chain: junk }) });
  await unsealStep.run(chainVoid.ctx, null);
  await surpriseFor(chainVoid.ctx, ['W1']);
  assert.deepEqual(outcomes(chainVoid), ['forecast', 'unresolved']);
  assert.ok(!calls(chainVoid).some((c) => c.startsWith('accept-')));
  rmSync(chainVoid.dir, { recursive: true });
  const acceptVoid = await harness({ routes: () => ({ accept: junk }) });
  await unsealStep.run(acceptVoid.ctx, null);
  await surpriseFor(acceptVoid.ctx, ['W1']);
  assert.deepEqual(outcomes(acceptVoid), ['forecast', 'unresolved']);
  assert.equal(report(acceptVoid)['eligible'], 1);
  rmSync(acceptVoid.dir, { recursive: true });
});

test('tampered sealed.json / nonce / non-canonical JSON / an early writer call → unseal invalid, 07b skips, the round continues; GitHub down → remote unavailable', async () => {
  const h = await harness();
  const f = probeFiles(h.ctx.paths);
  const sealedText = readFileSync(f.sealed, 'utf8');
  const nonceText = readFileSync(f.nonce, 'utf8');
  const expectInvalid = async (what: string, reason: RegExp): Promise<void> => {
    const out = await unsealStep.run(h.ctx, null);
    assert.equal(out.kind, 'done', `${what}: invalid is a result, not a failure`);
    const u = readUnsealFile(h.ctx);
    assert.ok(u.ok);
    assert.deepEqual([u.value.status, u.value.forecasters], ['invalid', 0], what);
    assert.ok(u.value.reasons.some((x) => reason.test(x)), `${what}: ${u.value.reasons.join(' | ')}`);
    assert.deepEqual(schemaErrors('unseal', readJsonAt(unsealPath(h.ctx))), [], what);
    assert.deepEqual(await surpriseStep.run(h.ctx, null), { kind: 'skip', reason: 'unseal invalid' }, what);
    assert.deepEqual(await surpriseFor(h.ctx, ['W1']), { kind: 'skip', reason: 'unseal invalid' }, what);
    assert.ok(!existsSync(join(h.ctx.paths.dir, 'surprise.json')), what);
    assert.deepEqual(calls(h), [], `${what}: no surprise call`);
    assertNoLeak(h);
  };
  writeFileSync(f.sealed, sealedText.replace(sealedValue('kimi', 3), '被改过的预测'));
  await expectInvalid('tampered sealed.json', /^seal: /u);
  writeFileSync(f.sealed, `${JSON.stringify(JSON.parse(sealedText), null, 1)}\n`);
  await expectInvalid('non-canonical sealed.json', /^canonical: /u);
  writeFileSync(f.sealed, sealedText);
  writeFileSync(f.nonce, `${'0'.repeat(64)}\n`);
  await expectInvalid('tampered nonce', /^seal: /u);
  writeFileSync(f.nonce, nonceText);

  const record = parseProbeRecord(readJsonAt(f.probe));
  assert.ok(record.ok);
  mkdirSync(h.ctx.paths.calls, { recursive: true });
  const early = new Date(Date.parse(record.value.mirrored_at) - 1000).toISOString();
  writeFileSync(join(h.ctx.paths.calls, 'write-W1-a1.json'), json({ label: 'write-W1-a1', started_at: early, at: early }));
  await expectInvalid('writer call started before probe.json.mirrored_at', /^ordering: call write-W1-a1 /u);
  rmSync(join(h.ctx.paths.calls, 'write-W1-a1.json'));

  h.ports.github.failNext('listComments', 1);
  assert.equal((await unsealStep.run(h.ctx, null)).kind, 'done');
  const down = readUnsealFile(h.ctx);
  assert.ok(down.ok);
  assert.deepEqual([down.value.status, down.value.remote], ['valid', 'unavailable']);
  assert.equal((await surpriseFor(h.ctx, ['W1'])).kind, 'done', 'an unreachable GitHub does not stop surprise');
  assert.equal(readJsonAt(join(h.ctx.paths.dir, 'surprise.json'))['remote'], 'unavailable');
  rmSync(h.dir, { recursive: true });
});

test('every forecaster void → unseal invalid (zero forecasters); measures.surprise inactive → 07b skips without calls', async () => {
  const none = await harness({ voidForecasts: true });
  assert.equal((await unsealStep.run(none.ctx, null)).kind, 'done');
  const u = readUnsealFile(none.ctx);
  assert.ok(u.ok);
  assert.deepEqual([u.value.status, u.value.forecasters, u.value.reasons], ['invalid', 0, ['forecasters: every forecaster was void, the seal holds no forecast']]);
  assert.equal((await surpriseFor(none.ctx, ['W1'])).kind, 'skip');
  rmSync(none.dir, { recursive: true });
  const off = await harness({ surpriseActive: false });
  assert.equal((await unsealStep.run(off.ctx, null)).kind, 'done');
  assert.deepEqual(await surpriseFor(off.ctx, ['W1']), { kind: 'skip', reason: 'benchmark v2 measures.surprise inactive' });
  assert.deepEqual(calls(off), []);
  rmSync(off.dir, { recursive: true });
});

test('07b refuses to trust a seal that changed after 07a verified it (integrity)', async () => {
  const h = await harness();
  assert.equal((await unsealStep.run(h.ctx, null)).kind, 'done');
  const f = probeFiles(h.ctx.paths);
  writeFileSync(f.sealed, readFileSync(f.sealed, 'utf8').replace(sealedValue('kimi', 1), '后来改的'));
  await assert.rejects(surpriseFor(h.ctx, ['W1']), /seal no longer verifies/u);
  assert.deepEqual(calls(h), []);
  rmSync(h.dir, { recursive: true });
});

test('07b-surprise step: reports exactly passingSubmissions (05c files)', async () => {
  const h = await harness();
  assert.equal((await unsealStep.run(h.ctx, null)).kind, 'done');
  mkdirSync(h.ctx.paths.gate, { recursive: true });
  const entry = { status: 'pass', pass: true, checks: [], error: null };
  writeFileSync(join(h.ctx.paths.gate, 'mechanical.json'), JSON.stringify({ round: ROUND, submissions: { W1: entry } }));
  writeFileSync(join(h.ctx.paths.gate, 'llm.json'), JSON.stringify({
    round: ROUND, defect_submission: null, defect_status: 'none', voided_families: [], submissions: { W1: { outcome: 'split', defect_unverified: false } }, unverified: [],
  }));
  const out = await surpriseStep.run(h.ctx, null);
  assert.equal(out.kind, 'done', out.kind === 'failed' ? out.detail : out.kind);
  if (out.kind !== 'done') return;
  assert.deepEqual(out.outputs, ['rounds/R01/surprise.json']);
  assert.deepEqual(out.inputs, [
    'rounds/R01/unseal.json', 'rounds/R01/brief.json', 'rounds/R01/probes.sha256', '.sealed/R01/sealed.json', '.sealed/R01/nonce.hex',
    'rounds/R01/submissions/W1.json', 'rounds/R01/measures/recall/W1.json',
  ]);
  const subs = readJsonAt(join(h.ctx.paths.dir, 'surprise.json'))['submissions'];
  assert.deepEqual(isRecord(subs) ? Object.keys(subs) : [], ['W1']);
  rmSync(h.dir, { recursive: true });
});

test('a matcher that repeats a sealed forecast value in prose and in an extra key leaks nothing into tracked files', async () => {
  const chatty: Route = (prompt) => {
    const first = (unwrap(prompt, '预测') ?? '').split('\n')[0] ?? '';
    const [id, , value] = first.split('｜');
    const reply = { matches: idsOf(prompt, '细节').map((d) => ({ detail: d, forecast: d === 'D1' ? id : null, relation: d === 'D1' ? 'same' : 'none', why: `预测${value ?? ''}` })) };
    return `${id ?? ''}（${value ?? ''}）与 D1 相同。\n${fenced(reply)}`;
  };
  const h = await harness({ routes: () => ({ match: chatty }) });
  assert.equal((await unsealStep.run(h.ctx, null)).kind, 'done');
  assert.equal((await surpriseFor(h.ctx, ['W1'])).kind, 'done');
  const details = report(h)['details'];
  assert.equal(Array.isArray(details) && isRecord(details[0]) ? details[0]['outcome'] : null, 'forecast', 'the chatty verdict still parses');
  assertNoLeak(h);
  const sealedMatches = readdirSync(h.ctx.paths.sealedTasks).filter((n) => n.startsWith('match-'));
  assert.equal(sealedMatches.length, 2, 'matcher records live under .sealed/');
  assert.ok(!existsSync(h.ctx.paths.tasks) || !readdirSync(h.ctx.paths.tasks).some((n) => n.startsWith('match-')));
  const before = calls(h).length;
  assert.equal((await surpriseFor(h.ctx, ['W1'])).kind, 'done');
  assert.equal(calls(h).length, before, 'resume reuses the sealed matcher records');
  rmSync(h.dir, { recursive: true });
});

test('07b skipping on a redo (unseal now invalid) removes the surprise.json of the earlier run', async () => {
  const h = await harness();
  assert.equal((await unsealStep.run(h.ctx, null)).kind, 'done');
  assert.equal((await surpriseFor(h.ctx, ['W1'])).kind, 'done');
  assert.ok(existsSync(join(h.ctx.paths.dir, 'surprise.json')));
  const f = probeFiles(h.ctx.paths);
  writeFileSync(f.nonce, `${'0'.repeat(64)}\n`);
  assert.equal((await unsealStep.run(h.ctx, null)).kind, 'done');
  assert.deepEqual(await surpriseStep.run(h.ctx, null), { kind: 'skip', reason: 'unseal invalid' });
  assert.ok(!existsSync(join(h.ctx.paths.dir, 'surprise.json')));
  rmSync(h.dir, { recursive: true });
});
