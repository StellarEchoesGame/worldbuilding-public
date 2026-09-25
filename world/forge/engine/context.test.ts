import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fakeBackend } from './adapters/fake.ts';
import { isQuotaError, type Backend } from './adapters/types.ts';
import { parseCell } from './brief.ts';
import { loadConfig, type ForgeConfig } from './config.ts';
import {
  buildContext,
  OwnerFileError,
  OWNER_ONLY,
  normalizeForGuard,
  parseStartRecord,
  QUOTA_BUDGET_MS,
  QUOTA_DELAYS_MS,
  readGithubConfig,
  roundFiles,
  WriteRootError,
  type ContextInput,
  type EngineDeps,
  type RoundBackends,
  type RoundFiles,
  type StepContext,
} from './context.ts';
import { buildFreeze } from './freeze.ts';
import { isRecord, readArray, readRecord, readString } from './json.ts';
import { loadProtocolBundle } from './rules.ts';
import { parseAliases, parseRows } from './thinmap.ts';
import { writeMarker } from './marker.ts';
import type { Pipeline, StepId } from './runner.ts';
import { roundPaths } from './store.ts';
import { IntegrityError } from './task.ts';
import { fakePorts, type FakePorts } from './testing/fakes.ts';
import {
  DEFAULT_FIXTURE,
  FIXTURE_AT,
  FIXTURE_CHAMPION_TEXT,
  FIXTURE_GATEWAY_HOST,
  FIXTURE_REFERENCE_FILES,
  fixtureWorld,
  type FixtureOptions,
  type FixtureWorld,
} from './testing/fixture-world.ts';
import { ownerSim } from './testing/owner-sim.ts';

const HEX = 'a'.repeat(64);

function tempWorld(): { dir: string; repo: string; root: string } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-context-'));
  const repo = join(dir, 'repo');
  const root = join(repo, 'world', 'forge');
  mkdirSync(join(repo, 'world', 'current'), { recursive: true });
  mkdirSync(root, { recursive: true });
  return { dir, repo, root };
}

function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.set(p, readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return out;
}

test('normalizeForGuard resolves . and .., symlinked parents, NFC and case', () => {
  const { dir, root } = tempWorld();
  mkdirSync(join(root, 'rounds', 'R01'), { recursive: true });
  symlinkSync(root, join(root, 'rounds', 'R01', 'up'));
  assert.equal(normalizeForGuard(root, 'rounds/R01/./audit.json'), 'rounds/r01/audit.json');
  assert.equal(normalizeForGuard(root, 'rounds/R09/../R01/Audit.json'), 'rounds/r01/audit.json');
  assert.equal(normalizeForGuard(root, '../forge/owner-log.jsonl'), 'owner-log.jsonl');
  assert.equal(normalizeForGuard(root, join(root, 'Calibration', 'Owner-Answers.json')), 'calibration/owner-answers.json');
  assert.equal(normalizeForGuard(root, 'rounds/R01/up/owner-log.jsonl'), 'owner-log.jsonl');
  assert.equal(normalizeForGuard(root, 'rounds/R01/up/../owner-log.jsonl'), '../owner-log.jsonl');
  assert.equal(normalizeForGuard(realpathSync(root), `${root}/x.json`), 'x.json');
  assert.equal(normalizeForGuard(root, 'notes/étÉ.md'), 'notes/été.md');
  assert.equal(normalizeForGuard(root, '../current/BOOK.md'), '../current/book.md');
  rmSync(dir, { recursive: true });
});

test('RoundFiles refuses every owner-only spelling for every write method and changes nothing', () => {
  const { dir, repo, root } = tempWorld();
  const owned = ['owner-log.jsonl', 'rounds/R01/audit.json', 'rounds/R01/decision.json', 'rounds/R01/decision-2.json', 'calibration/owner-answers.json'];
  for (const f of owned) {
    mkdirSync(join(root, f, '..'), { recursive: true });
    writeFileSync(join(root, f), `owner ${f}\n`);
  }
  writeFileSync(join(root, 'engine.json'), '{}\n');
  symlinkSync(root, join(root, 'rounds', 'R01', 'up'));
  const before = snapshot(root);
  const files = roundFiles(root, repo);
  const spellings = [
    ...owned,
    'rounds/R01/./audit.json',
    'rounds/R01/Audit.json',
    'ROUNDS/r01/AUDIT.JSON',
    'rounds/R01/./decision-3.json',
    'rounds/R02/decision.json',
    'calibration/Owner-Answers.json',
    '../forge/owner-log.jsonl',
    join(root, 'owner-log.jsonl'),
    join(root, 'rounds', 'R01', 'audit.json'),
    'rounds/R01/up/owner-log.jsonl',
    'rounds/R01/up/rounds/R01/decision.json',
  ];
  const writes: Array<[string, (f: RoundFiles, p: string) => unknown]> = [
    ['writeJson', (f, p) => f.writeJson(p, { x: 1 })],
    ['writeText', (f, p) => f.writeText(p, 'x')],
    ['appendLine', (f, p) => f.appendLine(p, { x: 1 })],
    ['appendLines', (f, p) => f.appendLines(p, [{ x: 1 }])],
    ['createExclusive', (f, p) => f.createExclusive(p, 'x')],
    ['move to', (f, p) => f.move(join(root, 'engine.json'), p)],
    ['move from', (f, p) => f.move(p, join(root, 'moved.json'))],
    ['remove', (f, p) => f.remove(p)],
  ];
  for (const p of spellings) {
    for (const [name, write] of writes) assert.throws(() => write(files, p), OwnerFileError, `${name} ${p}`);
  }
  assert.deepEqual(snapshot(root), before);
  assert.equal(OWNER_ONLY.length, 4);
  rmSync(dir, { recursive: true });
});

test('RoundFiles refuses paths outside the forge root and world/current, and final symlinks', () => {
  const { dir, repo, root } = tempWorld();
  const files = roundFiles(root, repo);
  writeFileSync(join(root, 'owner-log.jsonl'), 'owner\n');
  symlinkSync(join(root, 'owner-log.jsonl'), join(root, 'alias.jsonl'));
  symlinkSync(join(dir, 'elsewhere.json'), join(root, 'dangling.json'));
  for (const p of ['../../README.md', join(dir, 'x.json'), '../../../escape.json', '../other/x.json']) {
    assert.throws(() => files.writeText(p, 'x'), WriteRootError, p);
  }
  assert.throws(() => files.appendLine('alias.jsonl', { x: 1 }), WriteRootError);
  assert.throws(() => files.writeJson('dangling.json', {}), WriteRootError);
  linkSync(join(root, 'owner-log.jsonl'), join(root, 'hard.jsonl'));
  assert.throws(() => files.appendLine('hard.jsonl', { x: 1 }), WriteRootError);
  assert.equal(readFileSync(join(root, 'owner-log.jsonl'), 'utf8'), 'owner\n');
  assert.equal(existsSync(join(dir, 'elsewhere.json')), false);
  rmSync(dir, { recursive: true });
});

test('RoundFiles writes tmp + rename under the allowed roots and returns forge-root-relative keys', () => {
  const { dir, repo, root } = tempWorld();
  const files = roundFiles(root, repo);
  assert.equal(files.writeJson(join(root, 'rounds', 'R01', 'brief.json'), { b: 1 }), 'rounds/R01/brief.json');
  assert.equal(readFileSync(join(root, 'rounds', 'R01', 'brief.json'), 'utf8'), '{\n  "b": 1\n}\n');
  assert.equal(files.writeText(join(repo, 'world', 'current', 'reference', '09.md'), '九\n'), '../current/reference/09.md');
  assert.equal(files.writeText('.sealed/R01/sealed.json', 's'), '.sealed/R01/sealed.json');
  assert.equal(files.writeText('.runs/R01/x-a1.out.txt', 'o'), '.runs/R01/x-a1.out.txt');
  assert.equal(files.writeJson('rounds/R01/brief.json', { b: 2 }), 'rounds/R01/brief.json');
  assert.equal(files.rel(join(realpathSync(root), 'rounds', 'R01', 'brief.json')), 'rounds/R01/brief.json');
  assert.equal(files.root, root);
  const leftovers = [...snapshot(dir).keys()].filter((p) => p.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  rmSync(dir, { recursive: true });
});

test('RoundFiles appends JSON lines (torn tail cut), creates exclusively, moves and removes', () => {
  const { dir, repo, root } = tempWorld();
  const files = roundFiles(root, repo);
  const log = join(root, 'rounds', 'R01', 'progress.jsonl');
  assert.equal(files.appendLine(log, { a: 1 }), 'rounds/R01/progress.jsonl');
  writeFileSync(log, `${readFileSync(log, 'utf8')}{"torn":`);
  files.appendLines(log, [{ b: 2 }, { c: 3 }]);
  assert.equal(readFileSync(log, 'utf8'), '{"a":1}\n{"b":2}\n{"c":3}\n');
  const topic = join(root, 'rounds', 'R01', 'topic.json');
  assert.equal(files.createExclusive(topic, 'first\n'), true);
  assert.equal(files.createExclusive(topic, 'second\n'), false);
  assert.equal(readFileSync(topic, 'utf8'), 'first\n');
  assert.deepEqual(readdirSync(dirname(topic)).filter((n) => n.endsWith('.tmp')), [], 'exclusive create (tmp + link) leaves no tmp file');
  const marker = join(root, 'rounds', 'R01', 'markers', '09b-decision.json');
  files.writeText(marker, 'm');
  assert.equal(files.move(marker, join(root, 'rounds', 'R01', 'markers', 'stale', '1', '09b-decision.json')), 'rounds/R01/markers/stale/1/09b-decision.json');
  assert.equal(existsSync(marker), false);
  assert.throws(() => files.move(join(root, 'rounds', 'R01'), join(root, 'rounds', 'R01-moved')), /refusing to move a non-file: rounds\/R01/u);
  assert.equal(existsSync(join(root, 'rounds', 'R01', 'topic.json')), true, 'a directory move would carry owner files past the guard');
  files.remove(topic);
  files.remove(topic);
  assert.equal(existsSync(topic), false);
  rmSync(dir, { recursive: true });
});

function startRecord(): Record<string, unknown> {
  return {
    round: 'R01',
    seed: 'b'.repeat(64),
    branch: 'forge/r01',
    base_sha: 'c'.repeat(40),
    issue: { number: 7, url: 'https://github.com/fixture/forge/issues/7' },
    bundle_sha256: HEX,
    doctor_sha256: HEX,
    started_at: '2026-10-01T00:00:00.000Z',
    cell: 'cells/E2E-R01.json',
  };
}

test('parseStartRecord accepts start.json and rejects malformed fields', () => {
  const good = parseStartRecord(startRecord());
  assert.ok(good.ok);
  if (good.ok) assert.equal(good.value.issue.number, 7);
  const { cell: _cell, ...noCell } = startRecord();
  const absent = parseStartRecord(noCell);
  assert.ok(absent.ok && absent.value.cell === null);
  const bad: Array<Record<string, unknown>> = [
    { round: 'round-1' },
    { seed: '' },
    { base_sha: null },
    { issue: { number: 0, url: 'u' } },
    { bundle_sha256: 'short' },
    { doctor_sha256: 'A'.repeat(64) },
    { started_at: 'yesterday' },
    { cell: 3 },
  ];
  for (const patch of bad) assert.equal(parseStartRecord({ ...startRecord(), ...patch }).ok, false, JSON.stringify(patch));
  assert.equal(parseStartRecord(null).ok, false);
});

test('readGithubConfig reads github.json coordinates and rejects bad ones', () => {
  const { dir, root } = tempWorld();
  assert.equal(readGithubConfig(root).ok, false);
  writeFileSync(join(root, 'github.json'), JSON.stringify({ repo: 'fixture/forge', epic_issue: 1, base_branch: 'main' }));
  assert.deepEqual(readGithubConfig(root), { ok: true, value: { repo: 'fixture/forge', epicIssue: 1, baseBranch: 'main' } });
  for (const bad of [{ repo: 'noslash', epic_issue: 1, base_branch: 'main' }, { repo: 'a/b', epic_issue: 1.5, base_branch: 'main' }, { repo: 'a/b', epic_issue: 1, base_branch: '' }]) {
    writeFileSync(join(root, 'github.json'), JSON.stringify(bad));
    assert.equal(readGithubConfig(root).ok, false, JSON.stringify(bad));
  }
  writeFileSync(join(root, 'github.json'), '{');
  assert.equal(readGithubConfig(root).ok, false);
  rmSync(dir, { recursive: true });
});

function sha(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface Harness {
  dir: string;
  w: FixtureWorld;
  config: ForgeConfig;
  ports: FakePorts;
  backends: RoundBackends;
  logs: string[];
  input: ContextInput;
}

function harness(opts: FixtureOptions = DEFAULT_FIXTURE, roundId = 'R01', pipeline: Pipeline = 'round'): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'forge-context-'));
  const w = fixtureWorld(dir, opts);
  const loaded = loadConfig(w.root, { requireLocal: true });
  if (!loaded.ok) throw new Error(loaded.error);
  const config = loaded.value;
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: '2026-10-01T00:00:00.000Z', seed: 'context-seed' });
  const reply = (): string => '```json\n{}\n```';
  const gateway = (id: string): Backend => fakeBackend(id, 'DeepSeek', reply);
  const judges = config.judges.map((j) => ({ backend: fakeBackend(j.id, j.family, reply), concurrency: j.concurrency }));
  const backends: RoundBackends = {
    writers: ['W1', 'W2', 'W3'].map((slot) => ({ slot, backend: gateway(slot) })),
    baseline: gateway('BASE'),
    decoy: gateway('decoy'),
    defect: gateway('defect'),
    judges,
    forecasters: [...judges.map((j) => j.backend), gateway('forecast-gateway')],
    maintainer: fakeBackend('maintainer', 'Anthropic', reply),
    mergeEditor: fakeBackend('merge_editor', 'Anthropic', reply),
    calibGateway: new Map([['qwen/fixture-b', fakeBackend('calib-qwen', 'Alibaba', reply)]]),
  };
  const logs: string[] = [];
  const deps: EngineDeps = { ports, backends: () => backends, env: {}, pid: 1001, isAlive: (pid) => pid === 1001, log: (l) => logs.push(l) };
  const input: ContextInput = {
    root: w.root,
    repo: w.repo,
    roundId,
    pipeline,
    paths: roundPaths(w.root, roundId),
    config,
    deps,
    startOptions: { cell: null, seed: null },
    quotaBudgetMs: null,
  };
  return { dir, w, config, ports, backends, logs, input };
}

function context(input: ContextInput): StepContext {
  const built = buildContext(input);
  if (!built.ok) throw new Error(built.error);
  return built.value;
}

function mark(ctx: StepContext, step: StepId, result: 'done' | 'waiting', inputs: Record<string, string> = {}): void {
  writeMarker(ctx.files, join(ctx.paths.markers, `${step}.json`), {
    v: 1,
    round: ctx.roundId,
    step,
    completed_at: ctx.ports.clock.now(),
    result,
    skipped: null,
    inputs,
    outputs: {},
    external: {},
    local: {},
    tasks: { ok: 0, void: 0, calls: 0 },
    prev: null,
  });
}

test('buildContext scans GitHub bodies and commits, and progress redacts errors and stamps the fake clock', async () => {
  const h = harness();
  const ctx = context(h.input);
  const leak = await ctx.ports.github.createComment(1, `见 https://${FIXTURE_GATEWAY_HOST}/v1`);
  assert.equal(leak.ok, false);
  if (!leak.ok) {
    assert.match(leak.error, /^public-content scan: /u);
    assert.equal(leak.error.includes(FIXTURE_GATEWAY_HOST), false);
  }
  assert.equal(h.ports.github.comments().length, 0);
  assert.equal((await ctx.ports.github.createComment(1, '<!-- forge:probe R01 p -->')).ok, true);
  writeFileSync(join(h.w.root, 'leak.txt'), `host ${FIXTURE_GATEWAY_HOST}\n`);
  const commit = await ctx.ports.git.commit([join(h.w.root, 'leak.txt')], 'chore: leak');
  assert.equal(commit.ok, false);
  assert.deepEqual(h.ports.git.commits('main').map((c) => c.message), []);
  h.ports.clock.advance(5000);
  ctx.progress('00-start', 'error', `gateway request failed: getaddrinfo ENOTFOUND ${FIXTURE_GATEWAY_HOST}`);
  const line: unknown = JSON.parse(readFileSync(ctx.paths.progress, 'utf8'));
  assert.deepEqual(line, { at: '2026-10-01T00:00:05.000Z', step: '00-start', status: 'error', detail: 'gateway request failed: getaddrinfo ENOTFOUND [redacted:gateway-host]' });
  assert.equal(ctx.redact(`x ${FIXTURE_GATEWAY_HOST} y`), 'x [redacted:gateway-host] y');
  ctx.log('hello');
  assert.deepEqual(h.logs, ['hello']);
  assert.equal(ctx.github.epicIssue, 1);
  assert.equal(ctx.files.root, h.w.root);
  rmSync(h.dir, { recursive: true });
});

test('buildContext sets limiters for every backend (one shared gateway pool of 3), timeouts, quota and hooks', async () => {
  const h = harness();
  const hooks = { beforeCall: (): void => undefined };
  const ctx = context({ ...h.input, quotaBudgetMs: 60_000, deps: { ...h.input.deps, hooks } });
  const b = h.backends;
  const ids = [...b.writers.map((x) => x.backend.id), b.baseline.id, b.decoy.id, b.defect.id, ...b.judges.map((j) => j.backend.id), ...b.forecasters.map((f) => f.id), b.maintainer.id, b.mergeEditor.id, 'calib-qwen'];
  for (const id of ids) assert.ok(ctx.limiters.has(id), id);
  const pool = ctx.limiters.get('W1');
  assert.equal(ctx.limiters.get('BASE'), pool);
  assert.equal(ctx.limiters.get('forecast-gateway'), pool);
  assert.equal(ctx.limiters.get('calib-qwen'), pool);
  assert.notEqual(ctx.limiters.get('codex'), pool);
  let active = 0;
  let peak = 0;
  const job = async (): Promise<void> => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((r) => setImmediate(r));
    active -= 1;
  };
  const via = (id: string): Promise<void> => {
    const l = ctx.limiters.get(id);
    if (l === undefined) throw new Error(id);
    return l(job);
  };
  await Promise.all([via('W1'), via('W2'), via('W3'), via('BASE'), via('decoy'), via('defect')]);
  assert.equal(peak, 3);
  assert.deepEqual(ctx.timeouts, { judgeMs: h.config.judgeTimeoutMs, writerMs: h.config.writerTimeoutMs, maintainerMs: h.config.judgeTimeoutMs });
  assert.equal(ctx.quota.isQuota, isQuotaError);
  assert.deepEqual(ctx.quota.delaysMs, QUOTA_DELAYS_MS);
  assert.equal(ctx.quota.budgetMs, 60_000);
  assert.equal(context(h.input).quota.budgetMs, QUOTA_BUDGET_MS);
  assert.equal(ctx.hooks, hooks);
  assert.deepEqual(context(h.input).hooks, {});
  rmSync(h.dir, { recursive: true });
});

test('start, seed, freeze, benchmark and rules follow start.json, the 02c marker and the pinned benchmark', () => {
  const h = harness();
  const ctx = context(h.input);
  assert.throws(() => ctx.start(), /start\.json/u);
  assert.throws(() => ctx.seed(), /start\.json/u);
  assert.throws(() => ctx.freeze(), /before 02c-freeze/u);
  assert.throws(() => ctx.benchmark(), /before 02c-freeze/u);
  assert.equal(ctx.rules.barFourFamilies, 7);
  ctx.files.writeJson(ctx.paths.start, startRecord());
  assert.equal(ctx.start().branch, 'forge/r01');
  assert.equal(ctx.seed(), 'b'.repeat(64));
  // A benchmark with a stricter bar, pinned by freeze.json.
  const v1: unknown = JSON.parse(readFileSync(join(h.w.root, 'benchmark', 'v1.json'), 'utf8'));
  assert.ok(isRecord(v1));
  const v2 = { ...v1, version: 'v2', bars: { beats_champion_four_families: 8 } };
  const v2Text = `${JSON.stringify(v2, null, 2)}\n`;
  ctx.files.writeText(join(h.w.root, 'benchmark', 'v2.json'), v2Text);
  const freeze = buildFreeze({
    round: 'R01',
    files: { 'brief.json': '{}' },
    benchmarkVersion: 'v2',
    eligibleFamilies: ['Anthropic'],
    flags: { Anthropic: 'ok' },
    protocolBundleSha256: ctx.bundleSha256,
    probeCreatedAt: null,
    seed: 'f'.repeat(64),
    benchmarkResolution: { version: 'v2', sha256: sha(v2Text), path: 'benchmark/v2.json', via: 'approved', since: FIXTURE_AT },
  });
  ctx.files.writeJson(ctx.paths.freeze, freeze);
  mark(ctx, '02c-freeze', 'waiting');
  assert.throws(() => ctx.freeze(), /before 02c-freeze/u);
  assert.equal(ctx.seed(), 'b'.repeat(64));
  mark(ctx, '02c-freeze', 'done');
  assert.equal(ctx.freeze().benchmark_version, 'v2');
  assert.equal(ctx.seed(), 'f'.repeat(64));
  assert.equal(ctx.benchmark().version, 'v2');
  assert.equal(ctx.rules.barFourFamilies, 8);
  writeFileSync(join(h.w.root, 'benchmark', 'v2.json'), `${v2Text} `);
  assert.throws(() => ctx.benchmark(), IntegrityError);
  ctx.files.writeText(ctx.paths.start, '{');
  assert.throws(() => ctx.start(), IntegrityError);
  rmSync(h.dir, { recursive: true });
});

function decisionFile(pick: string, supersedes: string | null): string {
  const d = { round: 'R01', pick, pick_submission: 'W1', champion: 'BASE', facts: [{ label: pick, submission: 'W1', id: 'A-01', claim: '邻里共用工具柜不上锁' }], reason: '平', fav: pick, publish: 'yes', happened: false, source: 'ui', decided_at: '2026-10-02T00:00:00.000Z', supersedes };
  return `${JSON.stringify(d, null, 2)}\n`;
}

test('decision() reads the latest decision file pinned by the 09b marker and refuses a changed one', () => {
  const h = harness();
  const ctx = context(h.input);
  assert.throws(() => ctx.decision(), /before 09b-decision/u);
  const first = decisionFile('A', null);
  const second = decisionFile('B', sha(first));
  mkdirSync(ctx.paths.dir, { recursive: true });
  writeFileSync(join(ctx.paths.dir, 'decision.json'), first);
  writeFileSync(join(ctx.paths.dir, 'decision-2.json'), second);
  mark(ctx, '09b-decision', 'waiting', { 'rounds/R01/decision.json': sha(first) });
  assert.throws(() => ctx.decision(), /before 09b-decision/u);
  mark(ctx, '09b-decision', 'done', { 'rounds/R01/decision.json': sha(first), 'rounds/R01/decision-2.json': sha(second) });
  const d = ctx.decision();
  assert.equal(d.pick, 'B');
  assert.equal(d.file, 'rounds/R01/decision-2.json');
  assert.equal(d.supersedes, sha(first));
  assert.equal(d.base, null);
  assert.deepEqual(d.facts.map((f) => f.id), ['A-01']);
  writeFileSync(join(ctx.paths.dir, 'decision-2.json'), decisionFile('C', sha(first)));
  assert.throws(() => ctx.decision(), IntegrityError);
  mark(ctx, '09b-decision', 'done', { 'rounds/R01/audit.json': HEX });
  assert.throws(() => ctx.decision(), IntegrityError);
  rmSync(h.dir, { recursive: true });
});

test('owner is read afresh on every access, so a UI entry written after buildContext is seen', () => {
  const h = harness({ ...DEFAULT_FIXTURE, protocolApproved: false, benchmark: 'pending' });
  const ctx = context(h.input);
  assert.equal(ctx.owner.protocolApproval(ctx.bundleSha256), null);
  ownerSim(h.w.root, h.ports.clock).approveProtocol();
  assert.notEqual(ctx.owner.protocolApproval(ctx.bundleSha256), null);
  rmSync(h.dir, { recursive: true });
});

test('calibration and bench pipelines read the set seed and the C00 pin; bench-initial pins nothing', () => {
  const h = harness(DEFAULT_FIXTURE, 'C00', 'calibration');
  const v1 = readFileSync(join(h.w.root, 'benchmark', 'v1.json'));
  const early = context(h.input);
  assert.throws(() => early.benchmark(), /calibration\/C00\/pin\.json/u);
  assert.equal(early.rules.barFourFamilies, 7);
  mkdirSync(join(h.w.root, 'calibration', 'C00'), { recursive: true });
  writeFileSync(join(h.w.root, 'calibration', 'pairs.json'), JSON.stringify({ schema: 'calib-pairs/1', sets: { C00: { seed: 'calib-seed' } } }));
  writeFileSync(join(h.w.root, 'calibration', 'C00', 'pin.json'), JSON.stringify({ set: 'C00', benchmark_version: 'v1', benchmark_sha256: sha(v1) }));
  const calib = context(h.input);
  assert.equal(calib.seed(), 'calib-seed');
  assert.equal(calib.benchmark().version, 'v1');
  assert.throws(() => calib.freeze(), /before 02c-freeze/u);
  const r00 = context({ ...h.input, roundId: 'R00', pipeline: 'bench-r00', paths: roundPaths(h.w.root, 'R00') });
  assert.equal(r00.benchmark().version, 'v1');
  const initial = context({ ...h.input, roundId: 'R00', pipeline: 'bench-initial', paths: roundPaths(h.w.root, 'R00') });
  assert.throws(() => initial.benchmark(), /bench-initial/u);
  assert.equal(initial.rules.barFourFamilies, 7);
  rmSync(h.dir, { recursive: true });
});

test('buildContext refuses mismatched paths, a missing github.json and failing backends', () => {
  const h = harness();
  assert.equal(buildContext({ ...h.input, paths: roundPaths(h.w.root, 'R02') }).ok, false);
  const failing = buildContext({ ...h.input, deps: { ...h.input.deps, backends: () => { throw new Error('no gateway key'); } } });
  assert.deepEqual(failing, { ok: false, error: 'backends: no gateway key' });
  rmSync(join(h.w.root, 'github.json'));
  assert.equal(buildContext(h.input).ok, false);
  rmSync(h.dir, { recursive: true });
});

function readJsonFile(path: string): unknown {
  const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return v;
}

test('fixtureWorld: real bundle, consistent canon hashes, quotes and blocks, host only in local.json, clean main', async () => {
  const h = harness();
  const { w } = h;
  const real = join(import.meta.dirname, '..');
  for (const f of ['PROTOCOL.md', 'families.json', 'judges.json']) assert.equal(w.main[`world/forge/${f}`], readFileSync(join(real, f), 'utf8'), f);
  const bundle = loadProtocolBundle(w.root);
  assert.ok(bundle.ok);
  assert.equal(h.config.slots.map((s) => s.model).join(), 'deepseek-fixture,deepseek-fixture,deepseek-fixture');
  assert.equal(h.config.local?.gatewayBaseUrl, `https://${FIXTURE_GATEWAY_HOST}`);
  assert.equal(Object.hasOwn(w.main, 'world/forge/local.json'), false);
  for (const [path, text] of Object.entries(w.main)) assert.equal(text.includes(FIXTURE_GATEWAY_HOST), false, path);
  assert.deepEqual(await h.ports.git.isClean([w.repo]), { ok: true, value: true });

  const cur = (rel: string): string => readFileSync(join(w.repo, 'world', 'current', rel), 'utf8');
  const hashes = readJsonFile(join(w.repo, 'world/current/reference/hashes.json'));
  assert.equal(readString(hashes, 'base_book_sha256'), sha(cur('BOOK.md')));
  assert.equal(readString(hashes, 'reference_book_sha256'), sha(cur('reference/REFERENCE.md')));
  for (const f of FIXTURE_REFERENCE_FILES) assert.equal(readString(readRecord(hashes, 'documents'), f), sha(cur(`reference/${f}`)), f);
  const canonText = FIXTURE_REFERENCE_FILES.map((f) => cur(`reference/${f}`)).join('\n');
  for (const mark of ['仿佛', '宛如', '某种', '预言']) assert.equal(canonText.includes(mark), false, mark);
  assert.ok(cur('reference/05-ecology-and-everyday.md').includes(bundle.ok ? bundle.value.protocol.fixtureRxx.extends : '?'));
  for (const f of FIXTURE_REFERENCE_FILES.filter((x) => !x.startsWith('07-'))) {
    const blocks = cur(`reference/${f}`).split(/\n\s*\n/u).filter((b) => !b.startsWith('#') && [...b.trim()].length >= 250 && [...b.trim()].length <= 600);
    assert.ok(blocks.length >= 2, `${f}: ${blocks.length} calibration-sized blocks`);
  }
  const factIds = (readArray(readJsonFile(join(w.root, 'fact-status.json')), 'facts') ?? []).map((x) => readString(x, 'id'));
  for (const id of factIds) assert.match(cur('reference/07-register-and-creation.md'), new RegExp(`^\\| ${id ?? '?'} \\|`, 'mu'));

  const aliases = parseAliases(readJsonFile(join(w.root, 'map/aliases.json')));
  const rows = parseRows(readJsonFile(join(w.root, 'map/rows.json')));
  assert.ok(aliases.ok && rows.ok);
  if (aliases.ok) for (const a of aliases.value) assert.ok(cur(a.first_quote.file).includes(a.first_quote.quote), a.row_id);
  for (const q of readArray(readJsonFile(join(w.root, 'regression/wb-b1.json')), 'quotes') ?? []) assert.ok(canonText.includes(readString(q, 'quote') ?? '?'));
  for (const c of w.cells) {
    const parsed = parseCell(readJsonFile(join(w.root, c)));
    assert.ok(parsed.ok, c);
    if (parsed.ok && rows.ok) assert.ok(rows.value.some((r) => r.row_id === parsed.value.rowId), c);
    if (parsed.ok) assert.equal(parsed.value.stances.length, 4);
  }
  const canary = readJsonFile(join(w.root, 'canary/results.json'));
  assert.deepEqual((readArray(canary, 'adapters') ?? []).map((a) => readString(a, 'id')), ['claude', 'codex', 'grok', 'kimi']);
  rmSync(h.dir, { recursive: true });
});

test('fixtureWorld options: champions, benchmark v1 activate / pending / none, trust status, protocol approval', () => {
  const h = harness();
  const champ = readRecord(readJsonFile(join(h.w.root, 'champions.json')), 'SHIP');
  assert.equal(readString(champ, 'kind'), 'owner_pick');
  assert.equal(readString(champ, 'text_sha256'), sha(FIXTURE_CHAMPION_TEXT));
  const v1Sha = sha(readFileSync(join(h.w.root, 'benchmark/v1.json')));
  const log = readFileSync(join(h.w.root, 'benchmark/log.jsonl'), 'utf8').trim().split('\n').map((l): unknown => JSON.parse(l));
  assert.deepEqual(log.map((e) => [readString(e, 'cycle'), readString(e, 'outcome'), readString(e, 'sha256')]), [['R00-init', 'activate', v1Sha]]);
  const owner = readFileSync(join(h.w.root, 'owner-log.jsonl'), 'utf8').trim().split('\n').map((l): unknown => JSON.parse(l));
  assert.deepEqual(owner.map((e) => readString(e, 'action')), ['protocol_approved', 'bench_diff_viewed']);
  assert.equal(readString(owner[1], 'sha256'), v1Sha);
  assert.equal(h.w.main['world/forge/owner-log.jsonl'], readFileSync(join(h.w.root, 'owner-log.jsonl'), 'utf8'));
  const status = readRecord(readJsonFile(join(h.w.root, 'calibration/status.json')), 'families');
  assert.deepEqual(Object.keys(status ?? {}), ['Anthropic', 'Moonshot', 'OpenAI', 'xAI']);
  rmSync(h.dir, { recursive: true });

  const p = harness({ benchmark: 'pending', champions: 'none', trust: { qualified: ['Anthropic', 'OpenAI'] }, protocolApproved: false });
  assert.deepEqual(readJsonFile(join(p.w.root, 'champions.json')), {});
  assert.match(readFileSync(join(p.w.root, 'benchmark/log.jsonl'), 'utf8'), /"outcome":"pending_owner"/u);
  assert.equal(existsSync(join(p.w.root, 'owner-log.jsonl')), false);
  const fam = readRecord(readJsonFile(join(p.w.root, 'calibration/status.json')), 'families');
  assert.deepEqual(['Anthropic', 'Moonshot', 'OpenAI', 'xAI'].map((f) => readRecord(fam, f)?.['qualified']), [true, false, true, false]);
  rmSync(p.dir, { recursive: true });

  const n = harness({ benchmark: 'none', champions: 'ship_owner_pick', trust: 'none', protocolApproved: false });
  assert.equal(existsSync(join(n.w.root, 'benchmark')), false);
  assert.equal(existsSync(join(n.w.root, 'calibration/status.json')), false);
  assert.equal(existsSync(join(n.w.root, 'calibration/build.json')), true);
  rmSync(n.dir, { recursive: true });
});
