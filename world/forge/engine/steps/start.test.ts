import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fakeBackend } from '../adapters/fake.ts';
import type { Backend } from '../adapters/types.ts';
import { loadConfig } from '../config.ts';
import { roundCommand } from '../cli-round.ts';
import { buildContext, parseStartRecord, type EngineDeps, type RoundBackends, type StartOptions, type StepContext } from '../context.ts';
import { err, type Result } from '../result.ts';
import { runSteps, verifyChain, type RunReport, type StepDef } from '../runner.ts';
import { roundPaths, sha256 } from '../store.ts';
import { fakeDoctor, fakePorts, type FakePorts } from '../testing/fakes.ts';
import { DEFAULT_FIXTURE, fixtureWorld, type FixtureOptions, type FixtureWorld } from '../testing/fixture-world.ts';
import { calibrationSets, openRoundBranches, roundBranch, roundIssueMarker, startStep } from './start.ts';

interface Harness {
  w: FixtureWorld;
  ports: FakePorts;
  ctx: StepContext;
  deps: EngineDeps;
  logs: string[];
}

function harness(opts: FixtureOptions = DEFAULT_FIXTURE, roundId = 'R01', startOptions: StartOptions = { cell: 'cells/E2E-R01.json', seed: null }, doctor: Result<string> | null = null, same: Pick<Harness, 'w' | 'ports'> | null = null): Harness {
  const w = same?.w ?? fixtureWorld(mkdtempSync(join(tmpdir(), 'forge-start-')), opts);
  const loaded = loadConfig(w.root, { requireLocal: true });
  if (!loaded.ok) throw new Error(loaded.error);
  const ports = same?.ports ?? fakePorts({ repoDir: w.repo, main: w.main, startIso: '2026-10-01T00:00:00.000Z', seed: 'start-seed' });
  if (doctor !== null) ports.doctor = fakeDoctor(doctor);
  const reply = (): string => '```json\n{}\n```';
  const gw = (id: string): Backend => fakeBackend(id, 'DeepSeek', reply);
  const judges = loaded.value.judges.map((j) => ({ backend: fakeBackend(j.id, j.family, reply), concurrency: j.concurrency }));
  const backends: RoundBackends = {
    writers: ['W1', 'W2', 'W3'].map((slot) => ({ slot, backend: gw(slot) })),
    baseline: gw('BASE'), decoy: gw('decoy'), defect: gw('defect'), judges,
    forecasters: judges.map((j) => j.backend), maintainer: gw('maintainer'), mergeEditor: gw('merge_editor'), calibGateway: new Map(),
  };
  const logs: string[] = [];
  const deps: EngineDeps = { ports, backends: () => backends, env: {}, pid: 4242, isAlive: (pid) => pid === 4242, log: (l) => logs.push(l) };
  const built = buildContext({
    root: w.root, repo: w.repo, roundId, pipeline: 'round', paths: roundPaths(w.root, roundId), config: loaded.value,
    deps, startOptions, quotaBudgetMs: null,
  });
  if (!built.ok) throw new Error(built.error);
  return { w, ports, ctx: built.value, deps, logs };
}

function run(ctx: StepContext, steps: readonly StepDef[] = [startStep]): Promise<RunReport> {
  return runSteps(ctx, { pipeline: 'round', steps, until: null, from: null, redoFrom: null, pid: 4242, isAlive: (pid) => pid === 4242 });
}

function startJson(ctx: StepContext): Record<string, unknown> {
  const raw: unknown = JSON.parse(readFileSync(ctx.paths.start, 'utf8'));
  const parsed = parseStartRecord(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return { ...parsed.value };
}

test('00-start: branch forge/r01 from main, one round sub-issue under the epic, seed from Entropy, start.json', async () => {
  const h = harness();
  const mainSha = await h.ports.git.resolveRef('main');
  assert.ok(mainSha.ok);
  const report = await run(h.ctx);
  assert.equal(report.exitCode, 0, report.detail);
  const start = startJson(h.ctx);
  assert.equal(start['branch'], 'forge/r01');
  assert.equal(start['base_sha'], mainSha.value);
  assert.equal(start['cell'], 'cells/E2E-R01.json');
  assert.equal(start['bundle_sha256'], h.ctx.bundleSha256);
  assert.equal(start['doctor_sha256'], sha256('doctor: every backend green (fake)'));
  assert.match(String(start['seed']), /^[0-9a-f]{16}$/u);
  assert.equal(start['started_at'], '2026-10-01T00:00:00.000Z');
  const current = await h.ports.git.currentBranch();
  assert.deepEqual(current, { ok: true, value: 'forge/r01' });
  const issues = h.ports.github.issues();
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.parent, 1);
  assert.ok(issues[0]?.body.includes('<!-- forge:round R01 -->'));
  assert.deepEqual(start['issue'], { number: issues[0]?.number, url: issues[0]?.url });
  // The bundle is pinned by start.json only: an edit before 02c is left to the 02c protocol gate, not a marker mismatch.
  const protocol = join(h.w.root, 'PROTOCOL.md');
  writeFileSync(protocol, `${readFileSync(protocol, 'utf8')}\n`);
  assert.deepEqual(verifyChain(h.w.root, 'rounds/R01', ['00-start']), []);
});

test('00-start is idempotent: a rerun after a crash reuses the branch, the sub-issue and the seed', async () => {
  const h = harness(DEFAULT_FIXTURE, 'R01', { cell: null, seed: null });
  const first = await startStep.run(h.ctx, null);
  assert.equal(first.kind, 'done');
  const before = startJson(h.ctx);
  rmSync(h.ctx.paths.start);
  const second = await startStep.run(h.ctx, null);
  assert.equal(second.kind, 'done');
  assert.equal(h.ports.github.issues().length, 1);
  const after = startJson(h.ctx);
  assert.equal(after['base_sha'], before['base_sha']);
  assert.equal(after['cell'], null);
  assert.equal(h.ports.git.calls().filter((c) => c.op === 'createBranch').length, 1);
  const drawn = String(after['seed']);
  assert.match(drawn, /^[0-9a-f]{16}$/u);
  // A new process resumes the crashed attempt with another --seed: the unmarked start.json's entropy seed wins.
  const resumed = harness(DEFAULT_FIXTURE, 'R01', { cell: null, seed: '00ff00ff00ff00ff' }, null, h);
  const third = await startStep.run(resumed.ctx, null);
  assert.equal(third.kind, 'done');
  assert.equal(startJson(resumed.ctx)['seed'], drawn);
  assert.deepEqual(startJson(resumed.ctx), after, 'an unmarked start.json keeps its seed, base and start time');
});

test('00-start finds a sub-issue created before a crash by its marker', async () => {
  const h = harness();
  const pre = await h.ports.github.createIssue({ title: 'WB-F1 round R01', body: `<!-- forge:${roundIssueMarker('R01')} -->\nearlier attempt`, labels: [], parent: 1 });
  assert.ok(pre.ok);
  assert.equal((await run(h.ctx)).exitCode, 0);
  assert.equal(h.ports.github.issues().length, 1);
  assert.deepEqual(startJson(h.ctx)['issue'], pre.value);
});

test('00-start waits for the protocol approval before touching git or GitHub', async () => {
  const h = harness({ ...DEFAULT_FIXTURE, protocolApproved: false });
  const report = await run(h.ctx);
  assert.equal(report.exitCode, 2);
  assert.equal(report.waitingFor, 'protocol_approval');
  assert.equal(h.ports.github.calls().length, 0);
  assert.equal(h.ports.git.calls().filter((c) => c.op === 'createBranch').length, 0);
});

test('00-start: doctor red → failed (5); GitHub down → blocked (4); a bad --seed → failed', async () => {
  const red = harness(DEFAULT_FIXTURE, 'R01', { cell: null, seed: null }, err('judge kimi: served model mismatch'));
  const r1 = await run(red.ctx);
  assert.equal(r1.exitCode, 5);
  assert.match(r1.detail, /^doctor: /u);
  const down = harness();
  down.ports.github.failNext('findIssue', 1);
  const r2 = await run(down.ctx);
  assert.equal(r2.exitCode, 4);
  assert.match(r2.detail, /^github: /u);
  const again = await run(down.ctx);
  assert.equal(again.exitCode, 0, 'rerun after GitHub heals');
  const bad = harness(DEFAULT_FIXTURE, 'R01', { cell: null, seed: 'NOT-HEX' });
  assert.equal((await run(bad.ctx)).exitCode, 5);
  const noCell = harness(DEFAULT_FIXTURE, 'R01', { cell: 'cells/missing.json', seed: null });
  assert.equal((await run(noCell.ctx)).exitCode, 5);
});

test('one open round: R02 is blocked while forge/r01 carries unmerged commits, and starts once it is merged', async () => {
  const h = harness(DEFAULT_FIXTURE, 'R02', { cell: 'cells/E2E-R02.json', seed: null });
  const git = h.ports.git;
  assert.ok((await git.createBranch(roundBranch('R01'), 'main')).ok);
  assert.ok((await git.checkout('forge/r01')).ok);
  writeFileSync(join(h.w.root, 'README-R01.md'), 'round 1 work\n');
  assert.ok((await git.commit(['world/forge/README-R01.md'], 'chore: R01 bookkeeping')).ok);
  assert.ok((await git.checkout('main')).ok);
  assert.deepEqual(await openRoundBranches(git, h.w.root, 'R02', 'main', []), { ok: true, value: ['forge/r01'] });
  const blocked = await run(h.ctx);
  assert.equal(blocked.exitCode, 4);
  assert.match(blocked.detail, /forge\/r01 not merged into main/u);
  git.mergeToMain('forge/r01');
  assert.deepEqual(await openRoundBranches(git, h.w.root, 'R02', 'main', []), { ok: true, value: [] });
  const started = await run(h.ctx);
  assert.equal(started.exitCode, 0, started.detail);
  assert.equal(startJson(h.ctx)['branch'], 'forge/r02');
});

test('one open round: an unmerged forge/calib-<set> blocks a round started from main, where pairs.json lacks the set', async () => {
  const h = harness();
  const git = h.ports.git;
  assert.ok((await git.createBranch('forge/calib-q01', 'main')).ok);
  assert.ok((await git.checkout('forge/calib-q01')).ok);
  mkdirSync(join(h.w.root, 'calibration', 'Q01', 'markers'), { recursive: true });
  writeFileSync(join(h.w.root, 'calibration', 'pairs.json'), `${JSON.stringify({ sets: { Q01: {} } })}\n`);
  writeFileSync(join(h.w.root, 'calibration', 'Q01', 'markers', 'c1-build.json'), '{}\n');
  assert.ok((await git.commit(['world/forge/calibration/pairs.json', 'world/forge/calibration/Q01/markers/c1-build.json'], 'chore: calibration Q01')).ok);
  assert.ok((await git.checkout('main')).ok);
  const sets = calibrationSets(h.w.root);
  assert.ok(sets.ok);
  assert.equal(sets.value.includes('Q01'), false, 'main does not list the unmerged set');
  assert.deepEqual(await openRoundBranches(git, h.w.root, 'R01', 'main', sets.value), { ok: true, value: ['forge/calib-q01'] });
  const blocked = await run(h.ctx);
  assert.equal(blocked.exitCode, 4);
  assert.match(blocked.detail, /forge\/calib-q01 not merged into main/u);
  git.mergeToMain('forge/calib-q01');
  assert.deepEqual(await openRoundBranches(git, h.w.root, 'R01', 'main', []), { ok: true, value: [] });
  assert.equal((await run(h.ctx)).exitCode, 0);
});

/** Commits `files` (forge-root-relative, content `{}`) on forge/r00, created from main if absent, then checks out main. */
async function commitOnR00(h: Harness, files: readonly string[], message: string): Promise<void> {
  const git = h.ports.git;
  const exists = await git.branchExists(roundBranch('R00'));
  assert.ok(exists.ok);
  if (!exists.value) assert.ok((await git.createBranch(roundBranch('R00'), 'main')).ok);
  assert.ok((await git.checkout('forge/r00')).ok);
  for (const rel of files) {
    mkdirSync(dirname(join(h.w.root, rel)), { recursive: true });
    writeFileSync(join(h.w.root, rel), '{}\n');
  }
  assert.ok((await git.commit(files.map((rel) => `world/forge/${rel}`), message)).ok);
  assert.ok((await git.checkout('main')).ok);
}

const C00_MARKER = 'calibration/C00/markers/c5-score.json';
const R00_EVIDENCE = 'benchmark/evidence/R00.json';

test('one open round: a squash-merged forge/r00 counts as merged by benchmark/evidence/R00.json (only the R00 bench cycle writes it; round 0 writes no start.json)', async () => {
  const h = harness();
  const git = h.ports.git;
  await commitOnR00(h, [R00_EVIDENCE], 'chore: round 0');
  assert.deepEqual(await openRoundBranches(git, h.w.root, 'R01', 'main', []), { ok: true, value: ['forge/r00'] });
  git.squashToMain('forge/r00');
  assert.deepEqual(await git.isAncestor('forge/r00', 'main'), { ok: true, value: false }, 'a squash merge never makes the branch an ancestor');
  assert.deepEqual(await openRoundBranches(git, h.w.root, 'R01', 'main', []), { ok: true, value: [] });
  const started = await run(h.ctx);
  assert.equal(started.exitCode, 0, started.detail);
});

test('one open round: the squash-merged C00 PR alone leaves forge/r00 open (its R00 bench cycle is not on main), so round start R01 is refused', async () => {
  const h = harness();
  const git = h.ports.git;
  await commitOnR00(h, [C00_MARKER], 'chore: calibration C00');
  git.squashToMain('forge/r00');
  await commitOnR00(h, ['rounds/R00/bench/proposal.json'], 'chore: R00 bench cycle, unmerged');
  const marker = await git.show('main', join(h.w.root, C00_MARKER));
  assert.ok(marker.ok && marker.value !== null, 'main holds the C00 c5-score marker');
  assert.deepEqual(await openRoundBranches(git, h.w.root, 'R01', 'main', []), { ok: true, value: ['forge/r00'] });
  const at = { root: h.w.root, repo: h.w.repo };
  assert.equal(await roundCommand(['start', 'R01', '--cell', 'cells/E2E-R01.json'], h.deps, at), 1);
  assert.match(h.logs.join('\n'), /forge\/r00 not merged into main yet/u);
  assert.equal(existsSync(h.ctx.paths.start), false, 'a refused start writes no start.json');
  await commitOnR00(h, [R00_EVIDENCE], 'chore: R00 bench cycle 11f');
  git.squashToMain('forge/r00');
  assert.deepEqual(await openRoundBranches(git, h.w.root, 'R01', 'main', []), { ok: true, value: [] });
  h.logs.length = 0;
  assert.notEqual(await roundCommand(['start', 'R01', '--cell', 'cells/E2E-R01.json'], h.deps, at), 1, h.logs.join('\n'));
  assert.equal(existsSync(h.ctx.paths.start), true);
});
