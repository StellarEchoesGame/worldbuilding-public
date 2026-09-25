import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.ts';
import { buildContext, type RoundBackends, type StepContext } from '../context.ts';
import { IntegrityError } from '../task.ts';
import { roundPaths } from '../store.ts';
import { fakePorts } from '../testing/fakes.ts';
import { DEFAULT_FIXTURE, FIXTURE_AT, FIXTURE_WRITER_MODEL, fixtureWorld } from '../testing/fixture-world.ts';
import { ownerSim } from '../testing/owner-sim.ts';
import { fakeClock } from '../testing/fakes.ts';
import { fakeRouter } from '../testing/scripted.ts';
import { LABELS_FILE } from '../trust.ts';
import { TRUST_STATUS } from '../trust-status.ts';
import { agreementStep } from './agreement.ts';

function context(): { ctx: StepContext; root: string } {
  const w = fixtureWorld(mkdtempSync(join(tmpdir(), 'forge-agreement-')), DEFAULT_FIXTURE);
  const loaded = loadConfig(w.root, { requireLocal: true });
  if (!loaded.ok) throw new Error(loaded.error);
  const plain = fakeRouter({}, { id: 'W1', family: 'DeepSeek', model: FIXTURE_WRITER_MODEL });
  const judges = loaded.value.judges.map((j) => ({ backend: fakeRouter({}, { id: j.id, family: j.family, model: j.model }), concurrency: j.concurrency }));
  const backends: RoundBackends = {
    writers: [{ slot: 'W1', backend: plain }], baseline: plain, decoy: plain, defect: plain, judges, forecasters: [], maintainer: plain, mergeEditor: plain, calibGateway: new Map(),
  };
  const built = buildContext({
    root: w.root, repo: w.repo, roundId: 'R01', pipeline: 'round', paths: roundPaths(w.root, 'R01'), config: loaded.value,
    deps: { ports: fakePorts({ repoDir: w.repo, main: w.main, startIso: '2026-10-01T00:00:00.000Z', seed: 'agree' }), backends: () => backends, env: {}, pid: 1, isAlive: () => true, log: () => undefined },
    startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
  });
  if (!built.ok) throw new Error(built.error);
  return { ctx: built.value, root: w.root };
}

test('11e: updateTrust ok → done with calibration/{labels,status}.json external, no inputs or outputs', async () => {
  const { ctx, root } = context();
  const out = await agreementStep.run(ctx, null);
  assert.deepEqual(out, { kind: 'done', inputs: [], outputs: [], external: [LABELS_FILE, TRUST_STATUS] });
  const labels: unknown = JSON.parse(readFileSync(join(root, LABELS_FILE), 'utf8'));
  assert.ok(labels !== null && typeof labels === 'object');
  assert.equal(agreementStep.id, '11e-agreement');
});

test('11e: an audit.json without its owner-log line → WAIT owner_log_repair (as calib-score scoreStep), nothing written', async () => {
  const { ctx, root } = context();
  ownerSim(root, fakeClock(FIXTURE_AT)).writeUnlogged('rounds/R01/audit.json', { round: 'R01', answers: [{ pair: 'p', left: 'A', right: 'B', choice: 'left', chosen: 'A' }], answered_at: FIXTURE_AT });
  const out = await agreementStep.run(ctx, null);
  assert.equal(out.kind, 'wait');
  assert.ok(out.kind === 'wait' && out.waitingFor === 'owner_log_repair' && out.detail.includes('owner-log'));
  assert.throws(() => readFileSync(join(root, LABELS_FILE)), /ENOENT/u);
});

test('11e: an integrity problem (malformed calibration/status.json) → IntegrityError', async () => {
  const { ctx, root } = context();
  writeFileSync(join(root, TRUST_STATUS), '{"schema": "nope"}\n');
  await assert.rejects(agreementStep.run(ctx, null), (e: unknown) => e instanceof IntegrityError && /trust/u.test(e.message));
});
