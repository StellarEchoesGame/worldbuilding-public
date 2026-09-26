import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeBackend } from './adapters/fake.ts';
import { activeBenchmark } from './bench-active.ts';
import { BENCH_PROMPT_SLOTS, promptSlotErrors, rollbackHolds, roundNumber, validateBenchFile, validateCandidate } from './bench-check.ts';
import { decideOutcome } from './bench-cycle.ts';
import { appendBenchLogOnce, readBenchLog, writeVersion, type BenchLogEntry } from './bench-log.ts';
import { assembleCandidate } from './bench-propose.ts';
import { DEFAULT_ACTIVATION, type Activation } from './bench-validate.ts';
import { loadConfig } from './config.ts';
import { buildContext, type RoundBackends, type StepContext } from './context.ts';
import { isRecord, type JsonRecord } from './json.ts';
import { ownerInputs } from './owner-inputs.ts';
import { roundPaths } from './store.ts';
import { fakeClock, fakePorts } from './testing/fakes.ts';
import { DEFAULT_FIXTURE, fixtureWorld } from './testing/fixture-world.ts';
import { ownerSim, type OwnerSim } from './testing/owner-sim.ts';

const TEMPLATE = '先读{TEXT_1}，再读{TEXT_2}。{DECOY_PAIR}回答：{QUESTIONS}';
const EVIDENCE = 'E-R03-AGR-Moonshot';

interface World {
  dir: string;
  ctx: StepContext;
  sim: OwnerSim;
  v1: JsonRecord;
}

function world(roundId = 'R03'): World {
  const dir = mkdtempSync(join(tmpdir(), 'forge-bench-check-'));
  const w = fixtureWorld(dir, DEFAULT_FIXTURE);
  const config = loadConfig(w.root, { requireLocal: true });
  if (!config.ok) throw new Error(config.error);
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: '2026-10-01T00:00:00.000Z', seed: 'check-seed' });
  const b = fakeBackend('x', 'DeepSeek', () => '');
  const backends: RoundBackends = {
    writers: [{ slot: 'W1', backend: b }], baseline: b, decoy: b, defect: b, judges: [], forecasters: [], maintainer: b, mergeEditor: b, calibGateway: new Map(),
  };
  const built = buildContext({
    root: w.root, repo: w.repo, roundId, pipeline: 'round', paths: roundPaths(w.root, roundId), config: config.value,
    deps: { ports, backends: () => backends, env: {}, pid: 7, isAlive: () => true, log: () => undefined },
    startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
  });
  if (!built.ok) throw new Error(built.error);
  const v1: unknown = JSON.parse(readFileSync(join(w.root, 'benchmark/v1.json'), 'utf8'));
  if (!isRecord(v1)) throw new Error('fixture v1 is not an object');
  return { dir, ctx: built.value, sim: ownerSim(w.root, fakeClock('2026-10-02T00:00:00.000Z')), v1 };
}

/** A maintainer candidate on `parent` with `edit` applied to its body, citing evidence for `keys`. */
function candidate(parent: JsonRecord, version: string, keys: string[], edit: (body: JsonRecord) => void, root = false): JsonRecord {
  const body: JsonRecord = structuredClone(parent);
  for (const meta of ['version', 'parent', 'created_at', 'author', 'reasons']) delete body[meta];
  edit(body);
  const parentVersion = typeof parent['version'] === 'string' && !root ? parent['version'] : null;
  return assembleCandidate(
    { kind: 'change', body, reasons: [{ change: '调整', keys, evidence_ids: root ? [] : [EVIDENCE], expected_effect: '更好' }] },
    { version, parent: parentVersion, createdAt: '2026-10-01T00:00:00.000Z', model: 'fable' },
  );
}

function logEntry(c: JsonRecord, sha256: string, at: string, cycle: string): BenchLogEntry {
  const version = typeof c['version'] === 'string' ? c['version'] : '';
  return {
    at, cycle, outcome: 'activate', version, parent: 'v1', sha256, path: `benchmark/${version}.json`, activation: 'auto', changed_keys: [],
    evidence_packet: null, evidence_packet_sha256: null, evidence_ids: [], reasons: [], errors: [], replay: null, dropped_cliches: [],
    protocol_bundle_sha256: 'f'.repeat(64), calls: [], source: 'engine',
  };
}

/** Logs v2 (cliche_list + decoy_recipe changed from v1, then `extra`) as an activate the owner viewed, then rolls back to v1. */
function rolledBack(w: World, frozen: string | null, extra: (body: JsonRecord) => void = () => undefined): JsonRecord {
  const v2 = candidate(w.v1, 'v2', ['cliche_list', 'decoy_recipe'], (b) => {
    b['cliche_list'] = ['另一条陈词'];
    b['decoy_recipe'] = { details: 3, instructions: '换三个细节。' };
    extra(b);
  });
  const ref = writeVersion(w.ctx.files, w.ctx.root, v2);
  if (!ref.ok) throw new Error(ref.error);
  appendBenchLogOnce(w.ctx.files, w.ctx.root, logEntry(v2, ref.value.sha256, '2026-10-01T12:00:00.000Z', 'R01'));
  w.sim.viewBenchDiff('v2');
  if (frozen !== null) {
    mkdirSync(join(w.ctx.root, 'rounds', frozen), { recursive: true });
    writeFileSync(join(w.ctx.root, 'rounds', frozen, 'freeze.json'), '{}\n');
  }
  w.sim.rollback('v1', 'v2');
  return v2;
}

function log(w: World): BenchLogEntry[] {
  const r = readBenchLog(w.ctx.root);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

test('BENCH_PROMPT_SLOTS slots taste.template with the taste-template PROMPT_SLOTS', () => {
  assert.deepEqual(BENCH_PROMPT_SLOTS, { 'taste.template': ['TEXT_1', 'TEXT_2', 'DECOY_PAIR', 'QUESTIONS'] });
});

test('promptSlotErrors: missing, duplicated and unknown slots are all reported; absent or null template is the default', () => {
  const withTemplate = (template: unknown): JsonRecord => ({ author: { kind: 'maintainer', model: 'm' }, taste: { role: 'r', template } });
  assert.deepEqual(promptSlotErrors(withTemplate(TEMPLATE), BENCH_PROMPT_SLOTS), []);
  assert.deepEqual(promptSlotErrors(withTemplate(null), BENCH_PROMPT_SLOTS), []);
  assert.deepEqual(promptSlotErrors({ author: { kind: 'maintainer' }, taste: { role: 'r' } }, BENCH_PROMPT_SLOTS), []);
  assert.deepEqual(promptSlotErrors({ author: { kind: 'maintainer' } }, BENCH_PROMPT_SLOTS), []);
  assert.deepEqual(promptSlotErrors(withTemplate('{TEXT_1}{TEXT_1}{TEXT_2}{QUESTIONS}{EXTRA}'), BENCH_PROMPT_SLOTS), [
    'taste.template: slot {TEXT_1} occurs 2 times',
    'taste.template: missing slot {DECOY_PAIR}',
    'taste.template: unknown slot {EXTRA}',
  ]);
  assert.deepEqual(promptSlotErrors(withTemplate(7), BENCH_PROMPT_SLOTS), ['taste.template: not a string']);
  assert.deepEqual(promptSlotErrors({ ...withTemplate('{NOPE}'), author: { kind: 'prototype', model: null } }, BENCH_PROMPT_SLOTS), [], 'prototype author exempt');
  assert.deepEqual(promptSlotErrors({ a: { b: 'x {B}' } }, { 'a.b': ['A'] }), ['a.b: missing slot {A}', 'a.b: unknown slot {B}']);
});

test('roundNumber: R00 → 0, R03 → 3; prototype, calibration and malformed ids are errors', () => {
  assert.deepEqual(roundNumber('R00'), { ok: true, value: 0 });
  assert.deepEqual(roundNumber('R03'), { ok: true, value: 3 });
  assert.deepEqual(roundNumber('R42'), { ok: true, value: 42 });
  for (const id of ['P01', 'C00', 'Q01', 'R3', 'R003', 'r03', 'R00-init', '']) {
    const r = roundNumber(id);
    assert.equal(r.ok, false, id);
    if (!r.ok) assert.match(r.error, /not a round id/u);
  }
});

test('rollbackHolds: none without rollbacks; keys = diff(from, target); round from the owner entry (null → 0)', () => {
  const w = world();
  assert.deepEqual(rollbackHolds(w.ctx.root, ownerInputs(w.ctx.root), log(w), w.ctx.protocol.activation), { ok: true, value: [] });
  rolledBack(w, null);
  assert.deepEqual(rollbackHolds(w.ctx.root, ownerInputs(w.ctx.root), log(w), w.ctx.protocol.activation), { ok: true, value: [{ round: 0, rolledBackKeys: ['cliche_list', 'decoy_recipe'] }] });
  rmSync(w.dir, { recursive: true });

  const frozen = world();
  rolledBack(frozen, 'R02');
  assert.deepEqual(rollbackHolds(frozen.ctx.root, ownerInputs(frozen.ctx.root), log(frozen), frozen.ctx.protocol.activation), { ok: true, value: [{ round: 2, rolledBackKeys: ['cliche_list', 'decoy_recipe'] }] });
  rmSync(frozen.dir, { recursive: true });
});

test('rollbackHolds: a rollback whose target has no activate / pending_owner line is skipped (as bench-active ignores it); other holds are kept', () => {
  const w = world();
  rolledBack(w, null);
  // a hand-written line the UI would refuse: v9 was never logged as activate or pending_owner
  const unlogged = { at: '2026-10-03T00:00:00.000Z', action: 'rollback', round: 'R03', file: 'benchmark/v9.json', sha256: '9'.repeat(64), source: 'ui', version: 'v9', from: 'v2' };
  appendFileSync(join(w.ctx.root, 'owner-log.jsonl'), `${JSON.stringify(unlogged)}\n`);
  const owner = ownerInputs(w.ctx.root);
  assert.equal(owner.rollbacks().length, 2);
  assert.deepEqual(rollbackHolds(w.ctx.root, owner, log(w), w.ctx.protocol.activation), { ok: true, value: [{ round: 0, rolledBackKeys: ['cliche_list', 'decoy_recipe'] }] });
  const head = activeBenchmark(w.ctx, 'head', '2026-10-04T00:00:00.000Z');
  assert.ok(head.ok, head.ok ? '' : head.error);
  assert.deepEqual([head.value.version, head.value.via], ['v1', 'rollback'], 'bench-active counts the first rollback and ignores the v9 one');
  const noTarget = log(w).filter((e) => e.version !== 'v1');
  assert.deepEqual(rollbackHolds(w.ctx.root, owner, noTarget, w.ctx.protocol.activation), { ok: true, value: [] }, 'no logged target: both skipped');
  rmSync(w.dir, { recursive: true });
});

test('rollbackHolds: an edited target or from version file is an error; so is a from version missing from the log', () => {
  const w = world();
  rolledBack(w, null);
  const owner = ownerInputs(w.ctx.root);
  const v2Path = join(w.ctx.root, 'benchmark/v2.json');
  const v2Bytes = readFileSync(v2Path);
  writeFileSync(v2Path, '{"edited": true}\n');
  const editedFrom = rollbackHolds(w.ctx.root, owner, log(w), w.ctx.protocol.activation);
  assert.equal(editedFrom.ok, false);
  if (!editedFrom.ok) assert.match(editedFrom.error, /rollback 1: benchmark\/v2\.json does not match its logged sha256/u);
  writeFileSync(v2Path, v2Bytes);
  const v1Path = join(w.ctx.root, 'benchmark/v1.json');
  const v1Bytes = readFileSync(v1Path);
  writeFileSync(v1Path, `${v1Bytes.toString('utf8')}\n`);
  const editedTarget = rollbackHolds(w.ctx.root, owner, log(w), w.ctx.protocol.activation);
  assert.equal(editedTarget.ok, false, 'the owner clicked the logged bytes; the file no longer has them');
  if (!editedTarget.ok) assert.match(editedTarget.error, /rollback 1: benchmark\/v1\.json does not match its logged sha256/u);
  writeFileSync(v1Path, v1Bytes);
  // bench-active counts a rollback whatever its `from` says, so a hold it cannot diff must not vanish
  const noFrom = rollbackHolds(w.ctx.root, owner, log(w).filter((e) => e.version !== 'v2'), w.ctx.protocol.activation);
  assert.equal(noFrom.ok, false);
  if (!noFrom.ok) assert.match(noFrom.error, /rollback 1: v2 is not a logged version/u);
  rmSync(w.dir, { recursive: true });
});

test('rollbackHolds: keys are diffed over the activation map it is given, not the default one', () => {
  const w = world();
  rolledBack(w, null, (b) => { b['house_style'] = '新风格'; });
  const owner = ownerInputs(w.ctx.root);
  assert.deepEqual(rollbackHolds(w.ctx.root, owner, log(w), DEFAULT_ACTIVATION), { ok: true, value: [{ round: 0, rolledBackKeys: ['cliche_list', 'decoy_recipe'] }] });
  const widened: Readonly<Record<string, Activation>> = { ...DEFAULT_ACTIVATION, house_style: 'owner' };
  assert.deepEqual(rollbackHolds(w.ctx.root, owner, log(w), widened), { ok: true, value: [{ round: 0, rolledBackKeys: ['cliche_list', 'decoy_recipe', 'house_style'] }] });
  rmSync(w.dir, { recursive: true });
});

test('rollbackHolds: a rollback whose sha256 differs from the logged target is skipped (as bench-active ignores it)', () => {
  const w = world();
  rolledBack(w, null);
  // a hand-written line the UI would refuse: the owner's sha256 is not the logged sha256 of v1
  const forged = { at: '2026-10-03T00:00:00.000Z', action: 'rollback', round: 'R03', file: 'benchmark/v1.json', sha256: 'e'.repeat(64), source: 'ui', version: 'v1', from: 'v2' };
  appendFileSync(join(w.ctx.root, 'owner-log.jsonl'), `${JSON.stringify(forged)}\n`);
  const owner = ownerInputs(w.ctx.root);
  assert.equal(owner.rollbacks().length, 2);
  assert.deepEqual(rollbackHolds(w.ctx.root, owner, log(w), w.ctx.protocol.activation), { ok: true, value: [{ round: 0, rolledBackKeys: ['cliche_list', 'decoy_recipe'] }] });
  rmSync(w.dir, { recursive: true });
});

test('validateCandidate: a valid auto change passes with empty slot and version errors', () => {
  const w = world();
  const c = candidate(w.v1, 'v2', ['cliche_list'], (b) => { b['cliche_list'] = ['新陈词']; });
  const v = validateCandidate(w.ctx, c, w.v1, [], 'v2');
  assert.deepEqual(v, { ok: true, errors: [], changedKeys: ['cliche_list'], activation: 'auto', noChange: false, slotErrors: [], versionErrors: [] });
  rmSync(w.dir, { recursive: true });
});

test('validateCandidate: a version other than the allocated one and a bad template make it not ok', () => {
  const w = world();
  const c = candidate(w.v1, 'v2', ['cliche_list'], (b) => { b['cliche_list'] = ['新陈词']; });
  const wrong = validateCandidate(w.ctx, c, w.v1, [], 'v5');
  assert.equal(wrong.ok, false);
  assert.equal(wrong.activation, null);
  assert.deepEqual(wrong.versionErrors, ['version must be the allocated v5, got v2']);
  const slotted = candidate(w.v1, 'v2', ['taste'], (b) => {
    const taste = b['taste'];
    b['taste'] = { ...(isRecord(taste) ? taste : {}), template: '{TEXT_1}{TEXT_2}{QUESTIONS}' };
  });
  const bad = validateCandidate(w.ctx, slotted, w.v1, [], 'v2');
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.slotErrors, ['taste.template: missing slot {DECOY_PAIR}']);
  assert.deepEqual(bad.versionErrors, []);
  rmSync(w.dir, { recursive: true });
});

test('validateCandidate: a change whose body equals the head is a no-change verdict with the fixed error', () => {
  const w = world();
  const same = candidate(w.v1, 'v2', ['cliche_list'], () => undefined);
  const v = validateCandidate(w.ctx, same, w.v1, [], 'v2');
  assert.deepEqual(v, { ok: false, errors: ['change output equals head'], changedKeys: [], activation: null, noChange: true, slotErrors: [], versionErrors: [] });
  rmSync(w.dir, { recursive: true });
});

test('validateCandidate: a change equal to the head but carrying a protected key is rejected, not a no-change', () => {
  const w = world();
  const gated = candidate(w.v1, 'v2', ['cliche_list'], (b) => { b['gate'] = { rule: '放宽' }; });
  const v = validateCandidate(w.ctx, gated, w.v1, [], 'v2');
  assert.equal(v.noChange, false);
  assert.equal(v.ok, false);
  assert.equal(v.activation, null);
  assert.ok(v.errors.includes('protected key gate'), v.errors.join('; '));
  assert.ok(!v.errors.includes('change output equals head'), v.errors.join('; '));
  assert.equal(decideOutcome({ output: { kind: 'change', body: {}, reasons: [] }, verdict: v, replay: null }), 'rejected_validate');
  rmSync(w.dir, { recursive: true });
});

test('validateCandidate: a root version (null head) is owner class; a held key is upgraded to owner', () => {
  const w = world();
  const root = candidate(w.v1, 'v1', ['taste'], () => undefined, true);
  const rootVerdict = validateCandidate(w.ctx, root, null, [], 'v1');
  assert.equal(rootVerdict.ok, true, rootVerdict.errors.join('; '));
  assert.equal(rootVerdict.activation, 'owner');
  const c = candidate(w.v1, 'v2', ['cliche_list'], (b) => { b['cliche_list'] = ['新陈词']; });
  assert.equal(validateCandidate(w.ctx, c, w.v1, [{ round: 1, rolledBackKeys: ['cliche_list'] }], 'v2').activation, 'owner', 'R03 is inside a hold from R01');
  assert.equal(validateCandidate(w.ctx, c, w.v1, [{ round: 0, rolledBackKeys: ['cliche_list'] }], 'v2').activation, 'auto', 'R03 is past a hold from R00');
  rmSync(w.dir, { recursive: true });
});

test('validateBenchFile: holds default to the owner-log rollbacks when --rollbacks is absent', () => {
  const w = world();
  rolledBack(w, null);
  const c = candidate(w.v1, 'v3', ['cliche_list'], (b) => { b['cliche_list'] = ['新陈词']; });
  const held = validateBenchFile(w.ctx.root, w.ctx.protocol, { candidate: c, parent: w.v1, round: 1, rollbacks: null });
  assert.ok(held.ok, held.ok ? '' : held.error);
  assert.equal(held.value.activation, 'owner', 'cliche_list was rolled back at round 0; round 1 is inside the 3-round hold');
  const explicit = validateBenchFile(w.ctx.root, w.ctx.protocol, { candidate: c, parent: w.v1, round: 1, rollbacks: [] });
  assert.ok(explicit.ok);
  assert.equal(explicit.value.activation, 'auto', 'an explicit empty --rollbacks list wins');
  const after = validateBenchFile(w.ctx.root, w.ctx.protocol, { candidate: c, parent: w.v1, round: 3, rollbacks: null });
  assert.ok(after.ok);
  assert.equal(after.value.activation, 'auto', 'the hold ends after 3 rounds');
  writeFileSync(join(w.ctx.root, 'benchmark/log.jsonl'), 'not json\n{"also": "bad"}\n');
  const broken = validateBenchFile(w.ctx.root, w.ctx.protocol, { candidate: c, parent: w.v1, round: 1, rollbacks: null });
  assert.equal(broken.ok, false);
  if (!broken.ok) assert.match(broken.error, /benchmark\/log\.jsonl/u);
  rmSync(w.dir, { recursive: true });
});
