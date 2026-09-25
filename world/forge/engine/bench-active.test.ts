import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeBackend } from './adapters/fake.ts';
import type { Backend } from './adapters/types.ts';
import { activeBenchmark, AUTO_DELAY_MS, resolveBenchmark, type Resolution, type ResolveInputs } from './bench-active.ts';
import { appendBenchLogOnce, writeVersion, type BenchLogEntry, type BenchOutcome } from './bench-log.ts';
import { loadConfig } from './config.ts';
import { buildContext, type RoundBackends, type StepContext } from './context.ts';
import { appendMirrorEntry } from './mirror-log.ts';
import type { OwnerLogEntry } from './owner-inputs.ts';
import type { Result } from './result.ts';
import { roundPaths } from './store.ts';
import { IntegrityError } from './task.ts';
import { fakePorts, type FakePorts } from './testing/fakes.ts';
import { DEFAULT_FIXTURE, FIXTURE_AT, fixtureWorld, type FixtureOptions } from './testing/fixture-world.ts';
import { ownerSim } from './testing/owner-sim.ts';

const sha = (text: string): string => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const H = 3_600_000;
const T0 = Date.parse('2026-09-20T00:00:00.000Z');
const T1 = Date.parse('2026-10-01T00:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

const text = (v: string): string => `${JSON.stringify({ version: v, parent: null }, null, 2)}\n`;

interface World {
  files: Record<string, string>;
  log: BenchLogEntry[];
  owner: OwnerLogEntry[];
  posted: Array<{ version: string; createdAt: string }>;
}

function world(): World {
  return { files: {}, log: [], owner: [], posted: [] };
}

function logged(w: World, version: string, outcome: BenchOutcome, atMs: number): void {
  const path = `benchmark/${version}.json`;
  w.files[path] = text(version);
  w.log.push({
    at: iso(atMs),
    cycle: `R${String(w.log.length).padStart(2, '0')}`,
    outcome,
    version,
    parent: null,
    sha256: sha(text(version)),
    path,
    activation: outcome === 'pending_owner' ? 'owner' : 'auto',
    changed_keys: [],
    evidence_packet: null,
    evidence_packet_sha256: null,
    evidence_ids: [],
    reasons: [],
    errors: [],
    replay: null,
    dropped_cliches: [],
    protocol_bundle_sha256: 'c'.repeat(64),
    calls: [],
    source: 'engine',
  });
}

function owner(w: World, action: 'bench_diff_viewed' | 'bench_approved' | 'rollback', version: string, atMs: number, over: Partial<OwnerLogEntry> = {}): void {
  w.owner.push({
    at: iso(atMs),
    action,
    round: null,
    file: `benchmark/${version}.json`,
    sha256: sha(text(version)),
    source: 'ui',
    version,
    from: action === 'rollback' ? 'v9' : null,
    set: null,
    slots: null,
    ...over,
  });
}

function inputs(w: World): ResolveInputs {
  return { log: w.log, owner: w.owner, posted: w.posted, files: (p) => w.files[p] ?? null, autoDelayMs: AUTO_DELAY_MS };
}

function resolve(w: World, atMs: number, mode: 'effective' | 'head' = 'effective'): Result<Resolution> {
  return resolveBenchmark(inputs(w), iso(atMs), mode);
}

function pick(w: World, atMs: number, mode: 'effective' | 'head' = 'effective'): string {
  const r = resolve(w, atMs, mode);
  return r.ok ? `${r.value.version}/${r.value.via}@${r.value.since}` : `err:${r.error}`;
}

/** v1 active since T0 (viewed at once); v2 logged `activate` at T1. */
function base(): World {
  const w = world();
  logged(w, 'v1', 'activate', T0);
  owner(w, 'bench_diff_viewed', 'v1', T0);
  logged(w, 'v2', 'activate', T1);
  return w;
}

test('activate: effective at the first matching bench_diff_viewed', () => {
  const w = base();
  owner(w, 'bench_diff_viewed', 'v2', T1 + H);
  assert.equal(pick(w, T1 + H / 2), `v1/activate@${iso(T0)}`);
  assert.equal(pick(w, T1 + H), `v2/activate@${iso(T1 + H)}`);
  const full = resolve(w, T1 + 2 * H);
  assert.deepEqual(full, { ok: true, value: { version: 'v2', sha256: sha(text('v2')), path: 'benchmark/v2.json', via: 'activate', since: iso(T1 + H) } });
  if (full.ok) assert.deepEqual(Object.keys(full.value), ['version', 'sha256', 'path', 'via', 'since']);
});

test('activate: a view with another sha256, or logged before the activation, does not count', () => {
  const w = base();
  owner(w, 'bench_diff_viewed', 'v2', T1 - H);
  owner(w, 'bench_diff_viewed', 'v2', T1 + H, { sha256: 'f'.repeat(64) });
  assert.equal(pick(w, T1 + 40 * 24 * H), `v1/activate@${iso(T0)}`);
});

test('activate: effective 24 h after the posted notice, never without one', () => {
  const w = base();
  assert.equal(pick(w, T1 + 400 * 24 * H), `v1/activate@${iso(T0)}`, 'no notice, no view → never effective');
  w.posted.push({ version: 'v2', createdAt: iso(T1 + 2 * H) });
  w.posted.push({ version: 'v1', createdAt: iso(T1) });
  assert.equal(pick(w, T1 + 26 * H - 1), `v1/activate@${iso(T0)}`);
  assert.equal(pick(w, T1 + 26 * H), `v2/activate@${iso(T1 + 26 * H)}`);
  owner(w, 'bench_diff_viewed', 'v2', T1 + 30 * H);
  assert.equal(pick(w, T1 + 31 * H), `v2/activate@${iso(T1 + 26 * H)}`, 'min(view, notice + 24 h)');
});

test('activate: the auto clock starts at the log line when the notice timestamp is earlier (clock skew)', () => {
  const w = base();
  w.posted.push({ version: 'v2', createdAt: iso(T1 - 5 * H) });
  assert.equal(pick(w, T1 + 24 * H - 1), `v1/activate@${iso(T0)}`);
  assert.equal(pick(w, T1 + 24 * H), `v2/activate@${iso(T1 + 24 * H)}`);
});

test('head mode counts in-flight activations at their log time', () => {
  const w = base();
  assert.equal(pick(w, T1 + 60_000, 'head'), `v2/activate@${iso(T1)}`);
  assert.equal(pick(w, T1 + 60_000), `v1/activate@${iso(T0)}`);
  assert.equal(pick(w, T1 - 1, 'head'), `v1/activate@${iso(T0)}`);
});

test('pending_owner: effective from the first matching approval', () => {
  const w = world();
  logged(w, 'v1', 'pending_owner', T0);
  assert.equal(pick(w, T1), 'err:no active benchmark');
  assert.equal(pick(w, T1, 'head'), 'err:no active benchmark', 'an unapproved pending version is never head');
  owner(w, 'bench_approved', 'v1', T0 + H, { sha256: 'e'.repeat(64) });
  owner(w, 'bench_approved', 'v1', T0 + 3 * H);
  owner(w, 'bench_approved', 'v1', T0 + 5 * H);
  assert.equal(pick(w, T0 + 2 * H), 'err:no active benchmark');
  assert.equal(pick(w, T0 + 3 * H), `v1/approved@${iso(T0 + 3 * H)}`);
  assert.equal(pick(w, T0 + 9 * H, 'head'), `v1/approved@${iso(T0 + 3 * H)}`);
});

test('pending_owner: approval after a later version or rollback is ignored; approval before supersession counts', () => {
  const later = base();
  logged(later, 'v3', 'pending_owner', T1 + H);
  logged(later, 'v4', 'activate', T1 + 2 * H);
  owner(later, 'bench_approved', 'v3', T1 + 3 * H);
  assert.equal(pick(later, T1 + 4 * H), `v1/activate@${iso(T0)}`);
  assert.equal(pick(later, T1 + 4 * H, 'head'), `v4/activate@${iso(T1 + 2 * H)}`);

  const rolled = base();
  owner(rolled, 'bench_diff_viewed', 'v2', T1 + H);
  logged(rolled, 'v3', 'pending_owner', T1 + 2 * H);
  owner(rolled, 'rollback', 'v1', T1 + 3 * H, { from: 'v2' });
  owner(rolled, 'bench_approved', 'v3', T1 + 4 * H);
  assert.equal(pick(rolled, T1 + 5 * H), `v1/rollback@${iso(T1 + 3 * H)}`);

  const early = base();
  logged(early, 'v3', 'pending_owner', T1 + H);
  owner(early, 'bench_approved', 'v3', T1 + 2 * H);
  logged(early, 'v4', 'activate', T1 + 3 * H);
  assert.equal(pick(early, T1 + 4 * H), `v3/approved@${iso(T1 + 2 * H)}`);
});

/** base() with v2 viewed at T1 + 1 h. */
function v2Active(): World {
  const w = base();
  owner(w, 'bench_diff_viewed', 'v2', T1 + H);
  return w;
}

test('rollback: a later rollback wins, an earlier one loses to a later version', () => {
  const w = v2Active();
  owner(w, 'rollback', 'v1', T1 + 2 * H, { from: 'v2' });
  assert.equal(pick(w, T1 + 2 * H - 1), `v2/activate@${iso(T1 + H)}`);
  assert.equal(pick(w, T1 + 2 * H), `v1/rollback@${iso(T1 + 2 * H)}`);
  assert.equal(pick(w, T1 + 3 * H, 'head'), `v1/rollback@${iso(T1 + 2 * H)}`, 'the rollback target becomes head');
  logged(w, 'v3', 'activate', T1 + 5 * H);
  owner(w, 'bench_diff_viewed', 'v3', T1 + 6 * H);
  assert.equal(pick(w, T1 + 5 * H + 1), `v1/rollback@${iso(T1 + 2 * H)}`);
  assert.equal(pick(w, T1 + 7 * H), `v3/activate@${iso(T1 + 6 * H)}`);
});

test('rollback: a tie with a version moment goes to the rollback', () => {
  const head = base();
  owner(head, 'rollback', 'v1', T1, { from: 'v2' });
  assert.equal(pick(head, T1 + H, 'head'), `v1/rollback@${iso(T1)}`);
  const effective = base();
  owner(effective, 'bench_diff_viewed', 'v2', T1);
  owner(effective, 'rollback', 'v1', T1, { from: 'v2' });
  assert.equal(pick(effective, T1 + H), `v1/rollback@${iso(T1)}`);
});

test('rollback: ignored when its sha256 differs from the log or the target was never active or approved', () => {
  const w = v2Active();
  owner(w, 'rollback', 'v1', T1 + 2 * H, { from: 'v2', sha256: 'd'.repeat(64) });
  logged(w, 'v3', 'pending_owner', T1 + 3 * H);
  owner(w, 'rollback', 'v3', T1 + 4 * H, { from: 'v2' });
  owner(w, 'rollback', 'v7', T1 + 4 * H, { from: 'v2' });
  logged(w, 'v4', 'rejected_validate', T1 + 5 * H);
  owner(w, 'rollback', 'v4', T1 + 6 * H, { from: 'v2' });
  assert.equal(pick(w, T1 + 7 * H), `v2/activate@${iso(T1 + H)}`);
  owner(w, 'bench_approved', 'v3', T1 + 8 * H, { from: null });
  owner(w, 'rollback', 'v3', T1 + 8 * H - 1, { from: 'v2' });
  assert.equal(pick(w, T1 + 8 * H - 1), `v2/activate@${iso(T1 + H)}`, 'a rollback clicked before the approval does not count');
  assert.equal(pick(w, T1 + 9 * H), `v3/approved@${iso(T1 + 8 * H)}`, 'the approval itself still counts');
});

test('rollback: an activate target counts only once it was effective (view, or notice + 24 h) by the click', () => {
  const w = base();
  owner(w, 'rollback', 'v2', T1 + H, { from: 'v1' });
  assert.equal(pick(w, T1 + 2 * H), `v1/activate@${iso(T0)}`, 'v2 was logged but never viewed and no notice was posted');
  owner(w, 'bench_diff_viewed', 'v2', T1 + 3 * H);
  owner(w, 'rollback', 'v2', T1 + 2 * H, { from: 'v1' });
  assert.equal(pick(w, T1 + 3 * H - 1), `v1/activate@${iso(T0)}`, 'a click before the target took effect does not count');
  assert.equal(pick(w, T1 + 3 * H), `v2/activate@${iso(T1 + 3 * H)}`);
});

test('rollback: an approved pending version is a valid target', () => {
  const w = world();
  logged(w, 'v1', 'pending_owner', T0);
  owner(w, 'bench_approved', 'v1', T0 + H);
  logged(w, 'v2', 'activate', T1);
  owner(w, 'bench_diff_viewed', 'v2', T1 + H);
  owner(w, 'rollback', 'v1', T1 + 2 * H, { from: 'v2' });
  assert.equal(pick(w, T1 + 3 * H), `v1/rollback@${iso(T1 + 2 * H)}`);
});

test('the chosen file is re-hashed: an edited or missing file is a hard error, other files are not read', () => {
  const w = v2Active();
  w.files['benchmark/v1.json'] = '{"edited":true}\n';
  assert.equal(pick(w, T1 + 2 * H), `v2/activate@${iso(T1 + H)}`);
  w.files['benchmark/v2.json'] = `${text('v2')} `;
  assert.throws(() => resolve(w, T1 + 2 * H), (e: unknown) => e instanceof IntegrityError && /benchmark\/v2\.json was edited/u.test(e.message));
  delete w.files['benchmark/v2.json'];
  assert.throws(() => resolve(w, T1 + 2 * H), IntegrityError);
});

test('no candidate → err(no active benchmark); a bad at is an err', () => {
  assert.equal(pick(world(), T1), 'err:no active benchmark');
  const w = base();
  assert.equal(pick(w, T0 - 1), 'err:no active benchmark');
  const r = resolveBenchmark(inputs(w), 'yesterday', 'effective');
  assert.equal(r.ok, false);
});

test('lineage: an older version taking effect late never reverts a newer effective one', () => {
  const w = base();
  logged(w, 'v3', 'activate', T1 + 2 * H);
  owner(w, 'bench_diff_viewed', 'v3', T1 + 3 * H);
  owner(w, 'bench_diff_viewed', 'v2', T1 + 4 * H);
  assert.equal(pick(w, T1 + 5 * H), `v3/activate@${iso(T1 + 3 * H)}`);
  const pending = base();
  pending.posted.push({ version: 'v2', createdAt: iso(T1) });
  logged(pending, 'v3', 'pending_owner', T1 + H);
  owner(pending, 'bench_approved', 'v3', T1 + 2 * H);
  assert.equal(pick(pending, T1 + 30 * H), `v3/approved@${iso(T1 + 2 * H)}`);
});

test('lineage: a version still in flight when the owner rolled back never takes effect afterwards', () => {
  const w = v2Active();
  logged(w, 'v3', 'activate', T1 + 2 * H);
  w.posted.push({ version: 'v3', createdAt: iso(T1 + 2 * H) });
  owner(w, 'rollback', 'v1', T1 + 3 * H, { from: 'v2' });
  assert.equal(pick(w, T1 + 40 * H), `v1/rollback@${iso(T1 + 3 * H)}`);
  assert.equal(pick(w, T1 + 40 * H, 'head'), `v1/rollback@${iso(T1 + 3 * H)}`);
});

interface Harness {
  ctx: StepContext;
  ports: FakePorts;
  root: string;
}

function harness(opts: FixtureOptions): Harness {
  const w = fixtureWorld(mkdtempSync(join(tmpdir(), 'forge-bench-active-')), opts);
  const config = loadConfig(w.root, { requireLocal: true });
  if (!config.ok) throw new Error(config.error);
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: '2026-10-01T00:00:00.000Z', seed: 'bench-active-seed' });
  const reply = (): string => '```json\n{}\n```';
  const gateway = (id: string): Backend => fakeBackend(id, 'DeepSeek', reply);
  const judges = config.value.judges.map((j) => ({ backend: fakeBackend(j.id, j.family, reply), concurrency: j.concurrency }));
  const backends: RoundBackends = {
    writers: ['W1', 'W2', 'W3'].map((slot) => ({ slot, backend: gateway(slot) })),
    baseline: gateway('BASE'),
    decoy: gateway('decoy'),
    defect: gateway('defect'),
    judges,
    forecasters: judges.map((j) => j.backend),
    maintainer: fakeBackend('maintainer', 'Anthropic', reply),
    mergeEditor: fakeBackend('merge_editor', 'Anthropic', reply),
    calibGateway: new Map(),
  };
  const built = buildContext({
    root: w.root,
    repo: w.repo,
    roundId: 'R01',
    pipeline: 'round',
    paths: roundPaths(w.root, 'R01'),
    config: config.value,
    deps: { ports, backends: () => backends, env: {}, pid: 4242, isAlive: (pid) => pid === 4242, log: () => undefined },
    startOptions: { cell: null, seed: null },
    quotaBudgetMs: null,
  });
  if (!built.ok) throw new Error(built.error);
  return { ctx: built.value, ports, root: w.root };
}

test('activeBenchmark: fixture v1 active since its view; the text is the pinned file', () => {
  const h = harness(DEFAULT_FIXTURE);
  const r = activeBenchmark(h.ctx, 'effective');
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.equal(r.value.version, 'v1');
  assert.equal(r.value.via, 'activate');
  const view = h.ctx.owner.entries().find((e) => e.action === 'bench_diff_viewed' && e.version === 'v1');
  assert.ok(view !== undefined && view.at >= FIXTURE_AT);
  assert.equal(r.value.since, view.at);
  assert.equal(r.value.text, readFileSync(join(h.root, 'benchmark', 'v1.json'), 'utf8'));
  assert.equal(sha(r.value.text), r.value.sha256);
});

test('activeBenchmark: pending v1 waits for bench_approved; none → err', () => {
  const none = harness({ ...DEFAULT_FIXTURE, benchmark: 'none' });
  assert.deepEqual(activeBenchmark(none.ctx, 'effective'), { ok: false, error: 'no active benchmark' });
  const h = harness({ ...DEFAULT_FIXTURE, benchmark: 'pending' });
  assert.deepEqual(activeBenchmark(h.ctx, 'head'), { ok: false, error: 'no active benchmark' });
  h.ports.clock.advance(H);
  ownerSim(h.root, h.ports.clock).approveBench('v1');
  const r = activeBenchmark(h.ctx, 'effective');
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.equal(r.value.via, 'approved');
  assert.equal(r.value.since, h.ctx.owner.entries().find((e) => e.action === 'bench_approved')?.at);
});

test('activeBenchmark: a posted bench_notice starts the 24 h clock; a bad log line is an integrity error', () => {
  const h = harness(DEFAULT_FIXTURE);
  const v2 = writeVersion(h.ctx.files, h.root, { version: 'v2', parent: 'v1' });
  assert.ok(v2.ok);
  const at = h.ports.clock.now();
  appendBenchLogOnce(h.ctx.files, h.root, {
    at, cycle: 'R00', outcome: 'activate', version: 'v2', parent: 'v1', sha256: v2.value.sha256, path: v2.value.path, activation: 'auto',
    changed_keys: [], evidence_packet: null, evidence_packet_sha256: null, evidence_ids: [], reasons: [], errors: [], replay: null,
    dropped_cliches: [], protocol_bundle_sha256: h.ctx.bundleSha256, calls: [], source: 'engine',
  });
  h.ports.clock.advance(2 * H);
  const created = h.ports.clock.now();
  appendMirrorEntry(h.ctx.files, 'R00', { at: created, kind: 'bench_notice', key: 'v2', source_sha256: v2.value.sha256, status: 'posted', comment_id: 7, created_at: created, url: 'https://github.com/o/r/issues/1#issuecomment-7', error: null });
  h.ports.clock.advance(24 * H - 1);
  assert.equal(pickVersion(h.ctx), 'v1');
  assert.equal(pickVersion(h.ctx, 'head'), 'v2');
  h.ports.clock.advance(1);
  assert.equal(pickVersion(h.ctx), 'v2');
  appendFileSync(join(h.root, 'benchmark', 'log.jsonl'), '{"torn":\n');
  assert.throws(() => activeBenchmark(h.ctx, 'effective'), IntegrityError);
});

function pickVersion(ctx: StepContext, mode: 'effective' | 'head' = 'effective'): string {
  const r = activeBenchmark(ctx, mode);
  return r.ok ? r.value.version : `err:${r.error}`;
}
