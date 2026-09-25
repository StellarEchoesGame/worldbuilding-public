import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeBackend } from './adapters/fake.ts';
import { loadConfig } from './config.ts';
import { OwnerFileError, buildContext, type EngineDeps, type RoundBackends, type RoundFiles } from './context.ts';
import { roundPaths } from './store.ts';
import { fakePorts } from './testing/fakes.ts';
import { DEFAULT_FIXTURE, fixtureWorld } from './testing/fixture-world.ts';

/*
 * The runtime owner-file guard of RoundFiles. The source lint (only store.ts / context.ts write files; nothing outside
 * tests imports engine/testing/) lives in write-lint.test.ts alone.
 */

function roundFiles(dir: string): { root: string; files: RoundFiles } {
  const w = fixtureWorld(dir, DEFAULT_FIXTURE);
  const config = loadConfig(w.root, { requireLocal: true });
  if (!config.ok) throw new Error(config.error);
  const backend = fakeBackend('guard', 'DeepSeek', () => ({ error: 'unused' }));
  const backends: RoundBackends = {
    writers: [{ slot: 'W1', backend }], baseline: backend, decoy: backend, defect: backend, judges: [], forecasters: [],
    maintainer: backend, mergeEditor: backend, calibGateway: new Map(),
  };
  const deps: EngineDeps = {
    ports: fakePorts({ repoDir: w.repo, main: w.main, startIso: '2026-09-25T00:00:00.000Z', seed: 'guard' }),
    backends: () => backends, env: {}, pid: 4242, isAlive: () => false, log: () => {},
  };
  const ctx = buildContext({
    root: w.root, repo: w.repo, roundId: 'R01', pipeline: 'round', paths: roundPaths(w.root, 'R01'), config: config.value, deps,
    startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
  });
  if (!ctx.ok) throw new Error(ctx.error);
  return { root: w.root, files: ctx.value.files };
}

test('RoundFiles throws OwnerFileError on every owner-only path form and writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-owner-guard-'));
  const { root, files } = roundFiles(dir);
  files.writeText(join(root, 'rounds/R01/scratch.txt'), 'x');
  symlinkSync(join(root, 'rounds'), join(root, 'alias'));
  const owned = [
    `${root}/owner-log.jsonl`,
    `${root}/../forge/owner-log.jsonl`,
    `${root}/rounds/R01/audit.json`,
    `${root}/rounds/R01/./audit.json`,
    `${root}/rounds/R01/Audit.json`,
    `${root}/rounds/R01/decision.json`,
    `${root}/rounds/R01/./decision-3.json`,
    `${root}/rounds/R02/DECISION-2.json`,
    `${root}/calibration/owner-answers.json`,
    `${root}/calibration/Owner-Answers.json`,
    `${root}/alias/R01/audit.json`,
    `${root}/alias/R09/audit.json`,
  ];
  const before = existsSync(join(root, 'owner-log.jsonl')) ? readFileSync(join(root, 'owner-log.jsonl')) : null;
  for (const path of owned) {
    assert.throws(() => files.writeJson(path, { x: 1 }), OwnerFileError, path);
    assert.throws(() => files.writeText(path, 'x'), OwnerFileError, path);
    assert.throws(() => files.appendLine(path, { x: 1 }), OwnerFileError, path);
    assert.throws(() => files.appendLines(path, [{ x: 1 }]), OwnerFileError, path);
    assert.throws(() => files.createExclusive(path, 'x'), OwnerFileError, path);
    assert.throws(() => files.remove(path), OwnerFileError, path);
  }
  assert.throws(() => files.move(join(root, 'rounds/R01/scratch.txt'), `${root}/rounds/R01/./decision.json`), OwnerFileError);
  for (const path of owned.slice(2)) assert.equal(existsSync(path), false, path);
  assert.equal(existsSync(join(root, 'rounds/R09')), false);
  assert.deepEqual(existsSync(join(root, 'owner-log.jsonl')) ? readFileSync(join(root, 'owner-log.jsonl')) : null, before);
  // an ordinary round file next to them is written
  assert.equal(files.writeJson(join(root, 'rounds/R01/audit-set.json'), { pairs: [] }), 'rounds/R01/audit-set.json');
  rmSync(dir, { recursive: true });
});
