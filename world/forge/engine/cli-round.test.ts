import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeBackend } from './adapters/fake.ts';
import { freezeCommand, gatewayId, openRoundProblem, parseArgs, productionBackends, roundCommand, type ForgeRoots } from './cli-round.ts';
import { loadConfig } from './config.ts';
import { buildContext, roundFiles, type EngineDeps, type RoundBackends } from './context.ts';
import { buildFreeze } from './freeze.ts';
import { sha256Bytes, writeMarker } from './marker.ts';
import { parsePrices } from './cost.ts';
import { loadProtocolBundle } from './rules.ts';
import type { StepId } from './runner.ts';
import { ROUND_STEPS } from './steps/index.ts';
import { roundPaths } from './store.ts';
import { fakePorts, type FakePorts } from './testing/fakes.ts';
import { DEFAULT_FIXTURE, fixtureWorld, type FixtureWorld } from './testing/fixture-world.ts';

interface H {
  dir: string;
  w: FixtureWorld;
  ports: FakePorts;
  deps: EngineDeps;
  at: ForgeRoots;
  logs: string[];
}

function harness(): H {
  const dir = mkdtempSync(join(tmpdir(), 'forge-cli-round-'));
  const w = fixtureWorld(dir, DEFAULT_FIXTURE);
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: '2026-10-01T00:00:00.000Z', seed: 'cli-seed' });
  const b = fakeBackend('x', 'DeepSeek', () => '');
  const backends: RoundBackends = {
    writers: ['W1', 'W2', 'W3'].map((slot) => ({ slot, backend: fakeBackend(slot, 'DeepSeek', () => '') })),
    baseline: b, decoy: b, defect: b, judges: [], forecasters: [], maintainer: b, mergeEditor: b, calibGateway: new Map(),
  };
  const logs: string[] = [];
  const deps: EngineDeps = { ports, backends: () => backends, env: {}, pid: 4242, isAlive: () => false, log: (l) => logs.push(l) };
  return { dir, w, ports, deps, at: { root: w.root, repo: w.repo }, logs };
}

test('parseArgs: valued and bare options, positionals, unknown / missing / repeated options', () => {
  const r = parseArgs(['R01', '--until', '04-write', '--json'], ['--until'], ['--json']);
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(r.value.positional, ['R01']);
    assert.equal(r.value.values.get('--until'), '04-write');
    assert.ok(r.value.switches.has('--json'));
  }
  assert.deepEqual(parseArgs(['--nope'], [], []), { ok: false, error: 'unknown option --nope' });
  assert.deepEqual(parseArgs(['--until'], ['--until'], []), { ok: false, error: '--until needs a value' });
  assert.deepEqual(parseArgs(['--until', 'a', '--until', 'b'], ['--until'], []), { ok: false, error: '--until given twice' });
});

test('round commands refuse bad usage with exit 1 before touching the round', async () => {
  const h = harness();
  const cases: Array<[string[], RegExp]> = [
    [['nope'], /usage: forge round start/u],
    [['run', 'R01'], /R01 is not started; run forge round start R01 first/u],
    [['start', 'R00'], /R00 is round 0/u],
    [['start', 'P01'], /round ids look like R01/u],
    [['start', 'R01', '--cell', '../outside.json'], /inside the forge root/u],
    [['start', 'R01', '--seed', 'XYZ'], /--seed must be/u],
    [['run', 'R01', '--until', 'nope'], /not a step id/u],
    [['run', 'R01', '--from', '04-write', '--redo-from', '04-write'], /exclude each other/u],
    [['status', 'R01'], /not started\?/u],
  ];
  for (const [argv, want] of cases) {
    h.logs.length = 0;
    assert.equal(await roundCommand(argv, h.deps, h.at), 1, argv.join(' '));
    assert.match(h.logs.join('\n'), want);
  }
  assert.equal(existsSync(join(h.w.root, 'rounds', 'R01')), false);
  rmSync(h.dir, { recursive: true });
});

test('round start refuses (exit 1) while an earlier round branch is not merged into main', async () => {
  const h = harness();
  const git = h.ports.git;
  assert.ok((await git.createBranch('forge/r01', 'main')).ok);
  assert.ok((await git.checkout('forge/r01')).ok);
  mkdirSync(join(h.w.root, 'rounds', 'R01'), { recursive: true });
  writeFileSync(join(h.w.root, 'rounds', 'R01', 'note.txt'), 'r01\n');
  assert.ok((await git.commit(['world/forge/rounds/R01/note.txt'], 'r01')).ok);
  assert.ok((await git.checkout('main')).ok);
  assert.equal(await roundCommand(['start', 'R02', '--cell', 'cells/E2E-R02.json'], h.deps, h.at), 1);
  assert.match(h.logs.join('\n'), /forge\/r01 not merged into main yet/u);
  assert.equal(existsSync(join(h.w.root, 'rounds', 'R02')), false);
  git.mergeToMain('forge/r01');
  const config = loadConfig(h.w.root, { requireLocal: true });
  if (!config.ok) throw new Error(config.error);
  const ctx = buildContext({ root: h.w.root, repo: h.w.repo, roundId: 'R02', pipeline: 'round', paths: roundPaths(h.w.root, 'R02'), config: config.value, deps: h.deps, startOptions: { cell: null, seed: null }, quotaBudgetMs: null });
  assert.ok(ctx.ok);
  if (ctx.ok) assert.equal(await openRoundProblem(ctx.value), null);
  rmSync(h.dir, { recursive: true });
});

test('round start accepts an earlier round whose PR was squash-merged (the branch is no ancestor of main)', async () => {
  const h = harness();
  const git = h.ports.git;
  assert.ok((await git.createBranch('forge/r01', 'main')).ok);
  assert.ok((await git.checkout('forge/r01')).ok);
  mkdirSync(join(h.w.root, 'rounds', 'R01'), { recursive: true });
  writeFileSync(join(h.w.root, 'rounds', 'R01', 'start.json'), '{}\n');
  assert.ok((await git.commit(['world/forge/rounds/R01/start.json'], 'r01')).ok);
  assert.ok((await git.checkout('main')).ok);
  assert.equal(await roundCommand(['start', 'R02', '--cell', 'cells/E2E-R02.json'], h.deps, h.at), 1, 'unmerged: refused');
  git.squashToMain('forge/r01');
  assert.deepEqual(await git.isAncestor('forge/r01', 'main'), { ok: true, value: false });
  const code = await roundCommand(['start', 'R02', '--cell', 'cells/E2E-R02.json'], h.deps, h.at);
  assert.notEqual(code, 1, h.logs.join('\n'));
  assert.equal(existsSync(join(h.w.root, 'rounds', 'R02', 'start.json')), true);
  rmSync(h.dir, { recursive: true });
});

test('round start runs 00-start and 01-topic, status reports it, --verify checks the chain, a second start is refused', async () => {
  const h = harness();
  const code = await roundCommand(['start', 'R01', '--cell', 'cells/E2E-R01.json', '--seed', 'ab'.repeat(8)], h.deps, h.at);
  assert.equal(code, 0, h.logs.join('\n'));
  assert.match(h.logs.join('\n'), /R01: done at 01-topic: --until 01-topic reached/u);
  assert.ok(existsSync(join(h.w.root, 'rounds', 'R01', 'markers', '01-topic.json')));
  assert.equal(existsSync(join(h.w.root, 'rounds', 'R01', 'markers', '02a-brief.json')), false);
  h.logs.length = 0;
  assert.equal(await roundCommand(['status', 'R01', '--verify'], h.deps, h.at), 0);
  assert.match(h.logs.join('\n'), /R01: done at 01-topic/u);
  assert.match(h.logs.join('\n'), new RegExp(`2/${ROUND_STEPS.length} steps done`, 'u'));
  assert.match(h.logs.join('\n'), /marker chain verified/u);
  h.logs.length = 0;
  assert.equal(await roundCommand(['status', 'R01', '--json'], h.deps, h.at), 0);
  const status: unknown = JSON.parse(h.logs[0] ?? 'null');
  assert.equal(typeof status === 'object' && status !== null ? Reflect.get(status, 'state') : null, 'done');
  h.logs.length = 0;
  assert.equal(await roundCommand(['start', 'R01'], h.deps, h.at), 1);
  assert.match(h.logs.join('\n'), /already started/u);
  const start = join(h.w.root, 'rounds', 'R01', 'start.json');
  writeFileSync(start, readFileSync(start, 'utf8').replace('"round"', '"round" '));
  h.logs.length = 0;
  assert.equal(await roundCommand(['status', 'R01', '--verify'], h.deps, h.at), 3);
  assert.match(h.logs.join('\n'), /start\.json/u);
  rmSync(h.dir, { recursive: true });
});

const CHAIN: readonly StepId[] = ['00-start', '01-topic', '02a-brief', '02b-baseline', '02c-freeze'];

/** freeze.json (skills pinned) and a marker chain 00–02c whose 02c marker lists writers.json and freeze.json. */
function frozenRound(h: H, stepsSha256?: string): void {
  const dir = join(h.w.root, 'rounds', 'R01');
  mkdirSync(join(dir, 'markers'), { recursive: true });
  const skill = (n: string): string => sha256Bytes(readFileSync(join(h.w.root, 'skills', `${n}.md`)));
  const freeze = buildFreeze({
    round: 'R01', files: {}, benchmarkVersion: 'v1', eligibleFamilies: [], flags: {}, protocolBundleSha256: bundleSha(h), probeCreatedAt: null,
    seed: 'seed', skills: { 'systemic-worldbuilding': skill('systemic-worldbuilding'), 'metabolic-cultures': skill('metabolic-cultures') },
    ...(stepsSha256 === undefined ? {} : { stepsSha256 }),
  });
  writeFileSync(join(dir, 'freeze.json'), `${JSON.stringify(freeze, null, 2)}\n`);
  const hashOf = (rel: string): string => sha256Bytes(readFileSync(join(h.w.root, rel)));
  let prev: string | null = null;
  const files = roundFiles(h.w.root, h.w.repo);
  for (const step of CHAIN) {
    const last = step === '02c-freeze';
    const path = join(dir, 'markers', `${step}.json`);
    writeMarker(files, path, {
      v: 1, round: 'R01', step, completed_at: '2026-10-01T00:00:00.000Z', result: 'done', skipped: null,
      inputs: last ? { 'writers.json': hashOf('writers.json') } : {}, outputs: last ? { 'rounds/R01/freeze.json': hashOf('rounds/R01/freeze.json') } : {},
      external: {}, local: {}, tasks: { ok: 0, void: 0, calls: 0 }, prev,
    });
    prev = sha256Bytes(readFileSync(path));
  }
}

function bundleSha(h: H): string {
  const bundle = loadProtocolBundle(h.w.root);
  if (!bundle.ok) throw new Error(bundle.error);
  return bundle.value.bundleSha256;
}

test('freeze --check: clean → 0; a pinned writers.json or skill snapshot edit → 3; usage errors → 1', async () => {
  const h = harness();
  assert.equal(await freezeCommand(['--check'], h.deps, h.at), 1, 'no frozen round yet');
  frozenRound(h);
  assert.equal(await freezeCommand(['--check'], h.deps, h.at), 0, h.logs.join('\n'));
  assert.match(h.logs.join('\n'), /R01: freeze\.json matches the current inputs/u);
  assert.equal(await freezeCommand(['R01'], h.deps, h.at), 1, '--check is required');
  assert.equal(await freezeCommand(['--check', 'R02'], h.deps, h.at), 1);
  writeFileSync(join(h.w.root, 'skills', 'metabolic-cultures.md'), '# edited\n');
  writeFileSync(join(h.w.root, 'writers.json'), '{}\n');
  h.logs.length = 0;
  assert.equal(await freezeCommand(['--check', 'R01'], h.deps, h.at), 3);
  const out = h.logs.join('\n');
  assert.match(out, /skills\/metabolic-cultures\.md: pinned skill snapshot changed since 02c-freeze/u);
  assert.match(out, /writers\.json/u);
  rmSync(h.dir, { recursive: true });
});

test('freeze --check reports a steps_sha256 pinned by another build', async () => {
  const h = harness();
  frozenRound(h, 'a'.repeat(64));
  assert.equal(await freezeCommand(['--check', 'R01'], h.deps, h.at), 3);
  assert.match(h.logs.join('\n'), /steps_sha256: freeze\.json pins a different step list/u);
  rmSync(h.dir, { recursive: true });
});

test('productionBackends: gateway writers by slot, task-id-safe gateway forecaster ids, no call made', () => {
  const h = harness();
  const config = loadConfig(h.w.root, { requireLocal: true });
  const prices = parsePrices(JSON.parse(readFileSync(join(h.w.root, 'prices.json'), 'utf8')));
  if (!config.ok || !prices.ok) throw new Error('fixture config');
  const b = productionBackends(config.value, prices.value);
  assert.deepEqual(b.writers.map((w) => [w.slot, w.backend.id]), [['W1', 'W1'], ['W2', 'W2'], ['W3', 'W3']]);
  assert.equal(b.baseline.id, 'BASE');
  assert.deepEqual(b.forecasters.filter((f) => f.id.startsWith('gateway-')).map((f) => f.id), [gatewayId('deepseek-fixture')]);
  assert.equal(gatewayId('deepseek/deepseek-v4.1-flash'), 'gateway-deepseek_deepseek-v4.1-flash');
  assert.equal(b.judges.length, config.value.judges.length);
  rmSync(h.dir, { recursive: true });
});
