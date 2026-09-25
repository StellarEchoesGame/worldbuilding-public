import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeBackend } from '../adapters/fake.ts';
import { loadConfig } from '../config.ts';
import { buildContext, type RoundBackends, type StepContext } from '../context.ts';
import { roundPaths } from '../store.ts';
import { fakePorts } from '../testing/fakes.ts';
import { DEFAULT_FIXTURE, fixtureWorld } from '../testing/fixture-world.ts';
import type { FactRow } from './brief.ts';
import { drillFixture, gateFacts, readDefectFile } from './defect.ts';
import { negatedFlags, readMechanicalFile } from './gate-mech.ts';

const F01: FactRow = { id: 'F01', kind: 'fact', text: '没有星门。', status: '共同事实', rows: ['ALL'] };

function context(dir: string, roundId: string): StepContext {
  const w = fixtureWorld(dir, DEFAULT_FIXTURE);
  const config = loadConfig(w.root, { requireLocal: true });
  if (!config.ok) throw new Error(config.error);
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: '2026-10-01T00:00:00.000Z', seed: 'defect-seed' });
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
  mkdirSync(built.value.paths.gate, { recursive: true });
  return built.value;
}

const OK_DEFECT = {
  round: 'R01', status: 'ok', type: 'D1', submission: 'W2', task: 'defect-W2', against: 'F01', sentence_no: 2, original: '原句。', injected: '改写后的一句。',
  injected_span: { start: 3, end: 9 }, copy: '甲。改写后的一句。', copy_sha256: 'a'.repeat(64), error: null,
};

test('readDefectFile parses ok / void / none records and rejects malformed ones naming only the path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-defect-'));
  const ctx = context(dir, 'R01');
  const path = join(ctx.paths.gate, 'defect.json');
  assert.deepEqual(readDefectFile(ctx), { ok: false, error: 'rounds/R01/gate/defect.json is missing' });
  writeFileSync(path, JSON.stringify(OK_DEFECT));
  assert.deepEqual(readDefectFile(ctx), { ok: true, value: OK_DEFECT });
  const bad: Array<[string, unknown, RegExp]> = [
    ['not json', '{', /is not JSON/u],
    ['bad status', { ...OK_DEFECT, status: 'maybe' }, /status: expected ok, void or none/u],
    ['ok without copy', { ...OK_DEFECT, copy: null }, /status ok without copy/u],
    ['bad span', { ...OK_DEFECT, injected_span: { start: 5, end: 2 } }, /injected_span/u],
    ['void without submission', { ...OK_DEFECT, status: 'void', submission: null }, /status void without submission/u],
    ['string field wrong type', { ...OK_DEFECT, against: 3 }, /against: expected a string or null/u],
  ];
  for (const [name, value, pattern] of bad) {
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    const r = readDefectFile(ctx);
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.match(r.error, pattern, name);
  }
  rmSync(dir, { recursive: true });
});

test('readMechanicalFile keeps slot order and flags; negatedFlags reads the forbidden_words check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-defect-'));
  const ctx = context(dir, 'R01');
  const path = join(ctx.paths.gate, 'mechanical.json');
  const flagged = { name: 'forbidden_words', ok: true, detail: 'd', flags: ['没有星门的夜里。'] };
  writeFileSync(path, JSON.stringify({
    round: 'R01',
    submissions: {
      W2: { status: 'pass', pass: true, checks: [{ name: 'length', ok: true, detail: 'd' }, flagged], error: null },
      W1: { status: 'missing', pass: false, checks: [], error: 'no submission file' },
    },
  }));
  const r = readMechanicalFile(ctx);
  assert.ok(r.ok);
  assert.deepEqual(Object.keys(r.value.submissions), ['W2', 'W1']);
  assert.deepEqual(negatedFlags(r.value.submissions['W2']), ['没有星门的夜里。']);
  assert.deepEqual(negatedFlags(r.value.submissions['W1']), []);
  assert.deepEqual(negatedFlags(undefined), []);
  writeFileSync(path, JSON.stringify({ round: 'R01', submissions: { W1: { status: 'pass', pass: true, checks: [{ name: 1 }], error: null } } }));
  assert.deepEqual(readMechanicalFile(ctx), { ok: false, error: 'rounds/R01/gate/mechanical.json: malformed entry W1' });
  rmSync(dir, { recursive: true });
});

test('drillFixture only in round 00; gateFacts adds fixture-rxx (registered, binding) once in a drill', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-defect-'));
  const r01 = context(join(dir, 'a'), 'R01');
  const r00 = context(join(dir, 'b'), 'R00');
  assert.equal(drillFixture(r01), null);
  const fixture = drillFixture(r00);
  assert.ok(fixture !== null);
  assert.equal(fixture.rxx, 'R00-01');
  assert.deepEqual(gateFacts({ facts: [F01] }, null), [F01]);
  const facts = gateFacts({ facts: [F01] }, fixture);
  assert.deepEqual(facts.map((f) => [f.id, f.kind, f.status]), [['F01', 'fact', '共同事实'], ['R00-01', 'registered', '状态与路径实例']]);
  assert.equal(gateFacts({ facts }, fixture).length, 2, 'never added twice');
  rmSync(dir, { recursive: true });
});
