import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fakeBackend } from '../adapters/fake.ts';
import { loadConfig, type Family } from '../config.ts';
import { buildContext, type RoundBackends, type StepContext } from '../context.ts';
import { buildFreeze } from '../freeze.ts';
import { readMarker, sha256Bytes, writeMarker, type Marker } from '../marker.ts';
import type { PairEntry, PairKind } from '../pairs.ts';
import { runSteps, type RunReport } from '../runner.ts';
import { loadSchema, validate } from '../schema.ts';
import { seededSplit } from '../split.ts';
import { roundPaths } from '../store.ts';
import { IntegrityError } from '../task.ts';
import { fakePorts, type FakePorts } from '../testing/fakes.ts';
import { DEFAULT_FIXTURE, FIXTURE_AT, fixtureWorld } from '../testing/fixture-world.ts';
import { ownerSim, type OwnerSim } from '../testing/owner-sim.ts';
import { AUDIT_PAIRS, auditStep, buildAuditSet, decisionStep, parseAuditSet, type AuditSetFile } from './owner-waits.ts';

const JUDGES: readonly Family[] = ['Anthropic', 'Moonshot', 'OpenAI', 'xAI'];
const SUBS = ['W1', 'W2-r2', 'W3'];

interface H {
  dir: string;
  ctx: StepContext;
  ports: FakePorts;
  sim: OwnerSim;
}

function put(ctx: StepContext, rel: string, value: unknown): void {
  const path = join(ctx.paths.dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function entry(id: string, kind: PairKind, left: string, right: string, families: readonly Family[]): PairEntry {
  return { id, kind, left, right, families: [...families], shadow: [], effective: [...families], dropped: [] };
}

function pairsFile(ctx: StepContext, rel: string, pairs: readonly PairEntry[]): void {
  const ids = [...new Set(pairs.flatMap((p) => [p.left, p.right]))];
  const kindOf = (id: string): string => (id === 'BASE' ? 'champion' : id.startsWith('AN') ? 'anchor' : 'submission');
  const texts = Object.fromEntries(ids.map((id) => [id, { id, kind: kindOf(id), file: `rounds/R01/submissions/${id}.json`, sha256: 'a'.repeat(64), authors: [] }]));
  put(ctx, rel, { round: 'R01', champion: 'BASE', texts, pairs });
}

function writerText(id: string): string {
  const delta = { new_proper_nouns: [], claims: [] };
  const iface = { shots: [{}, {}, {}], object: {}, hook: {} };
  return ['```submission', `${id} 的正文。`, '```', '```delta', JSON.stringify(delta), '```', '```interface', JSON.stringify(iface), '```'].join('\n');
}

/** R01 after 08: champion pairs W1, W2-r2, W3; aux pairs W1.W3 (sub–sub) and W1.AN1 (anchor); labels A/B/C. */
function round(ctx: StepContext, opts: { aux?: boolean } = {}): void {
  pairsFile(ctx, 'pairs.json', SUBS.map((s) => entry(s, 'champion', s, 'BASE', JUDGES)));
  if (opts.aux !== false) pairsFile(ctx, 'taste/aux/pairs.json', [entry('W1.W3', 'sub_sub', 'W1', 'W3', ['Anthropic', 'OpenAI']), entry('W1.AN1', 'anchor', 'W1', 'AN1', ['Moonshot', 'xAI'])]);
  put(ctx, 'labels.json', { A: 'W3', B: 'W1', C: 'W2-r2' });
  for (const id of SUBS) put(ctx, `submissions/${id}.json`, { id, kind: 'writer', model: 'm', family: 'DeepSeek', stance: 's', ok: true, error: null, text: writerText(id) });
}

function harness(seed = 'seed-audit'): H {
  const dir = mkdtempSync(join(tmpdir(), 'forge-owner-waits-'));
  const w = fixtureWorld(dir, DEFAULT_FIXTURE);
  const config = loadConfig(w.root, { requireLocal: true });
  if (!config.ok) throw new Error(config.error);
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: '2026-10-01T06:00:00.000Z', seed: 'waits' });
  const b = fakeBackend('x', 'DeepSeek', () => '');
  const backends: RoundBackends = { writers: [], baseline: b, decoy: b, defect: b, judges: [], forecasters: [], maintainer: b, mergeEditor: b, calibGateway: new Map() };
  const built = buildContext({
    root: w.root, repo: w.repo, roundId: 'R01', pipeline: 'round', paths: roundPaths(w.root, 'R01'), config: config.value,
    deps: { ports, backends: () => backends, env: {}, pid: 7, isAlive: () => true, log: () => undefined },
    startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
  });
  if (!built.ok) throw new Error(built.error);
  const ctx = built.value;
  mkdirSync(ctx.paths.dir, { recursive: true });
  const benchSha = sha256Bytes(readFileSync(join(w.root, 'benchmark', 'v1.json')));
  const freeze = buildFreeze({
    round: 'R01', files: { 'brief.json': 'x' }, benchmarkVersion: 'v1', eligibleFamilies: [...JUDGES], flags: {}, protocolBundleSha256: ctx.bundleSha256,
    probeCreatedAt: '2026-10-01T00:05:00.000Z', seed, benchmarkResolution: { version: 'v1', sha256: benchSha, path: 'benchmark/v1.json', via: 'activate', since: FIXTURE_AT },
  });
  writeFileSync(ctx.paths.freeze, `${JSON.stringify(freeze, null, 2)}\n`);
  writeMarker(ctx.files, join(ctx.paths.markers, '02c-freeze.json'), {
    v: 1, round: 'R01', step: '02c-freeze', completed_at: '2026-10-01T00:00:00.000Z', result: 'done', skipped: null,
    inputs: {}, outputs: {}, external: {}, local: {}, tasks: { ok: 0, void: 0, calls: 0 }, prev: null,
  });
  return { dir, ctx, ports, sim: ownerSim(w.root, ports.clock) };
}

function run(h: H): Promise<RunReport> {
  return runSteps(h.ctx, { pipeline: 'round', steps: [auditStep, decisionStep], until: null, from: null, redoFrom: null, pid: 7, isAlive: () => true });
}

function marker(h: H, step: string): Marker {
  const m = readMarker(join(h.ctx.paths.markers, `${step}.json`));
  if (m === null || !m.ok) throw new Error(`${step} marker missing or bad`);
  return m.value;
}

function auditSet(h: H): AuditSetFile {
  const set = parseAuditSet(JSON.parse(readFileSync(join(h.ctx.paths.dir, 'audit-set.json'), 'utf8')));
  if (set === null) throw new Error('audit-set.json does not parse');
  return set;
}

const AUDIT_REL = 'rounds/R01/audit.json';
const SET_REL = 'rounds/R01/audit-set.json';

test('09a writes audit-set.json (split 2/2 by seed) before any answer, waits for audit; answers → 09b waits for decision; decide → done', async () => {
  const h = harness();
  round(h.ctx);
  assert.deepEqual(pickReport(await run(h)), { state: 'waiting', step: '09a-audit', waitingFor: 'audit', exitCode: 2 });
  const set = auditSet(h);
  const ids = ['R01-audit-1', 'R01-audit-2', 'R01-audit-3', 'R01-audit-4'];
  assert.deepEqual(set.pairs.map((p) => p.id), ids);
  assert.deepEqual(set.pairs.map((p) => p.label), ids);
  const split = seededSplit(ids, 'seed-audit', 'labels:split', 2);
  assert.deepEqual(Object.fromEntries(set.pairs.map((p) => [p.id, p.split])), split);
  assert.deepEqual(Object.values(split).sort(), ['reserve', 'reserve', 'visible', 'visible']);
  assert.deepEqual(set.created_at, '2026-10-01T06:00:00.000Z');
  assert.throws(() => readFileSync(join(h.ctx.paths.dir, 'audit.json')), /ENOENT/u, 'no answer yet');
  const waiting = marker(h, '09a-audit');
  assert.equal(waiting.result, 'waiting');
  assert.equal(waiting.outputs[SET_REL], sha256Bytes(readFileSync(join(h.ctx.paths.dir, 'audit-set.json'))));
  assert.deepEqual(Object.keys(waiting.inputs), ['rounds/R01/labels.json', 'rounds/R01/pairs.json', 'rounds/R01/taste/aux/pairs.json']);

  h.sim.answerAudit('R01', () => 'left');
  assert.deepEqual(pickReport(await run(h)), { state: 'waiting', step: '09b-decision', waitingFor: 'decision', exitCode: 2 });
  const done = marker(h, '09a-audit');
  assert.equal(done.result, 'done');
  assert.equal(done.inputs[AUDIT_REL], h.sim.expected().get(AUDIT_REL));
  assert.equal(done.outputs[SET_REL], waiting.outputs[SET_REL], 'the answered set is the one the waiting marker pinned');

  h.sim.decide('R01', { pick: 'B', reason: '平', fav: 'B', publish: 'no', facts: [] });
  assert.deepEqual(pickReport(await run(h)), { state: 'done', step: '09b-decision', waitingFor: null, exitCode: 0 });
  assert.equal(marker(h, '09b-decision').inputs['rounds/R01/decision.json'], h.sim.expected().get('rounds/R01/decision.json'));
  assert.equal(h.ctx.decision().pick_submission, 'W1');
  rmSync(h.dir, { recursive: true });
});

function pickReport(r: RunReport): Pick<RunReport, 'state' | 'step' | 'waitingFor' | 'exitCode'> {
  return { state: r.state, step: r.step, waitingFor: r.waitingFor, exitCode: r.exitCode };
}

test('09a re-entry (waiting marker) and a rerun after a crash before the marker reuse audit-set.json byte for byte', async () => {
  const h = harness();
  round(h.ctx);
  await run(h);
  const bytes = readFileSync(join(h.ctx.paths.dir, 'audit-set.json'), 'utf8');
  h.ports.clock.advance(3_600_000);
  assert.deepEqual(pickReport(await run(h)), { state: 'waiting', step: '09a-audit', waitingFor: 'audit', exitCode: 2 });
  assert.equal(readFileSync(join(h.ctx.paths.dir, 'audit-set.json'), 'utf8'), bytes, 'waiting re-entry');
  rmSync(join(h.ctx.paths.markers, '09a-audit.json'));
  const out = await auditStep.run(h.ctx, null);
  assert.equal(out.kind, 'wait');
  assert.equal(readFileSync(join(h.ctx.paths.dir, 'audit-set.json'), 'utf8'), bytes, 'no marker, same draw → file kept (created_at unchanged)');
  rmSync(h.dir, { recursive: true });
});

test('buildAuditSet: 4 of the judged pairs by seed, display ids only, both sides by seed, fewer pairs → all of them', () => {
  const pairs = [...SUBS.map((s) => entry(s, 'champion', s, 'BASE', JUDGES)), entry('W1.W3', 'sub_sub', 'W1', 'W3', JUDGES), entry('W1.AN1', 'anchor', 'W1', 'AN1', JUDGES)];
  const labels = new Map([['W3', 'A'], ['W1', 'B'], ['W2-r2', 'C']]);
  const draws = new Set<string>();
  const sides = new Set<string>();
  for (const seed of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']) {
    const set = buildAuditSet('R01', seed, pairs, labels, 2, '2026-10-01T00:00:00.000Z');
    assert.deepEqual(buildAuditSet('R01', seed, [...pairs].reverse(), labels, 2, '2026-10-01T00:00:00.000Z'), set, 'independent of input order');
    assert.equal(set.pairs.length, AUDIT_PAIRS);
    assert.equal(new Set(set.pairs.map((p) => p.pair)).size, AUDIT_PAIRS);
    for (const p of set.pairs) {
      for (const side of [p.left, p.right]) assert.ok(['A', 'B', 'C', 'BASE', 'AN1'].includes(side), side);
      const judged = pairs.find((q) => q.id === p.pair);
      assert.equal(p.kind, judged?.kind);
      if (p.pair === 'W1') sides.add(p.left);
    }
    draws.add(set.pairs.map((p) => p.pair).join(','));
  }
  assert.ok(draws.size > 1, 'the seed draws the pairs');
  assert.deepEqual([...sides].sort(), ['B', 'BASE'], 'the seed decides the side');
  const three = buildAuditSet('R01', 's1', pairs.slice(0, 3), labels, 2, '2026-10-01T00:00:00.000Z');
  assert.deepEqual(three.pairs.map((p) => p.id), ['R01-audit-1', 'R01-audit-2', 'R01-audit-3']);
  assert.equal(three.pairs.filter((p) => p.split === 'visible').length, 2);
  assert.throws(() => buildAuditSet('R01', 's1', [entry('W9', 'champion', 'W9', 'BASE', JUDGES)], labels, 2, 'x'), (e: unknown) => e instanceof IntegrityError && /W9/u.test(e.message));
});

test('audit-set.json validates against schema/audit-set.schema.json (also with 3 pairs when 06c skipped)', async () => {
  const schema = loadSchema(JSON.parse(readFileSync(new URL('../../schema/audit-set.schema.json', import.meta.url), 'utf8')));
  if (!schema.ok) throw new Error(schema.error);
  for (const aux of [true, false]) {
    const h = harness();
    round(h.ctx, { aux });
    await run(h);
    const raw: unknown = JSON.parse(readFileSync(join(h.ctx.paths.dir, 'audit-set.json'), 'utf8'));
    assert.deepEqual(validate(schema.value, raw), []);
    assert.equal(auditSet(h).pairs.length, aux ? 4 : 3);
    rmSync(h.dir, { recursive: true });
  }
});

test('09a: audit.json without its owner-log line → WAIT owner_log_repair; edited after logging → integrity; no judged pair → failed', async () => {
  const h = harness();
  round(h.ctx);
  await run(h);
  const answers = auditSet(h).pairs.map((p) => ({ pair: p.id, left: p.left, right: p.right, choice: 'left', chosen: p.left }));
  h.sim.writeUnlogged('rounds/R01/audit.json', { round: 'R01', answers, source: 'ui', answered_at: '2026-10-01T07:00:00.000Z' });
  const repair = await run(h);
  assert.deepEqual(pickReport(repair), { state: 'waiting', step: '09a-audit', waitingFor: 'owner_log_repair', exitCode: 2 });
  h.sim.removeOwnerFile('rounds/R01/audit.json');
  h.sim.answerAudit('R01', () => 'right');
  h.sim.tamper('rounds/R01/audit.json', (text) => text.replace('"right"', '"left"'));
  await assert.rejects(auditStep.run(h.ctx, marker(h, '09a-audit')), (e: unknown) => e instanceof IntegrityError);
  assert.equal((await run(h)).exitCode, 3);
  rmSync(h.dir, { recursive: true });

  const empty = harness();
  pairsFile(empty.ctx, 'pairs.json', []);
  put(empty.ctx, 'labels.json', {});
  assert.deepEqual(await auditStep.run(empty.ctx, null), { kind: 'failed', detail: 'no judged pair to draw the blind audit from' });
  rmSync(empty.dir, { recursive: true });
});

test('09a never redraws an answered set: changed inputs under an existing audit.json → integrity', async () => {
  const h = harness();
  round(h.ctx);
  await run(h);
  h.sim.answerAudit('R01', () => 'left');
  rmSync(join(h.ctx.paths.markers, '09a-audit.json'));
  put(h.ctx, 'labels.json', { A: 'W1', B: 'W3', C: 'W2-r2' });
  await assert.rejects(auditStep.run(h.ctx, null), (e: unknown) => e instanceof IntegrityError && /would change under an answered audit\.json/u.test(e.message));
  rmSync(h.dir, { recursive: true });
});

test('09b: a superseded decision (non-pass re-gate record) and an unlogged decision file both wait', async () => {
  const h = harness();
  round(h.ctx);
  await run(h);
  h.sim.answerAudit('R01', () => 'left');
  await run(h);
  const unlogged = { round: 'R01', pick: 'B', pick_submission: 'W1', base: null, champion: 'BASE', facts: [], reason: '平', fav: 'B', publish: 'no', happened: false, source: 'ui', supersedes: null, decided_at: '2026-10-01T08:00:00.000Z' };
  h.sim.writeUnlogged('rounds/R01/decision.json', unlogged);
  assert.deepEqual(pickReport(await run(h)), { state: 'waiting', step: '09b-decision', waitingFor: 'owner_log_repair', exitCode: 2 });
  h.sim.removeOwnerFile('rounds/R01/decision.json');
  h.sim.decide('R01', { pick: 'B', reason: '平', fav: 'B', publish: 'no', facts: [] });
  const sha = h.sim.expected().get('rounds/R01/decision.json') ?? '';
  put(h.ctx, `merge/${sha.slice(0, 8)}/regate.json`, { status: 'fail' });
  const out = await decisionStep.run(h.ctx, null);
  assert.equal(out.kind, 'wait');
  if (out.kind === 'wait') {
    assert.equal(out.waitingFor, 'decision');
    assert.match(out.detail, new RegExp(sha.slice(0, 12), 'u'));
  }
  rmSync(h.dir, { recursive: true });
});
