import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeBackend } from '../adapters/fake.ts';
import { loadConfig } from '../config.ts';
import { buildContext, type RoundBackends } from '../context.ts';
import { isRecord, readRecord, readString } from '../json.ts';
import { roundPaths } from '../store.ts';
import { fakePorts } from '../testing/fakes.ts';
import { DEFAULT_FIXTURE, fixtureWorld } from '../testing/fixture-world.ts';
import { gateMechStep } from './gate-mech.ts';

function writerText(body: string): string {
  return ['```submission', body, '```', '```delta', '{"new_proper_nouns":[],"claims":[]}', '```', '```interface', '{"shots":[{},{},{}],"object":{"n":1},"hook":{"h":1}}', '```', '种子：', '- 一'].join('\n');
}

test('05a gates every writer slot with the protocol rules into gate/mechanical.json (pass, fail, void, absent)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-gatemech-'));
  const w = fixtureWorld(dir, DEFAULT_FIXTURE);
  const config = loadConfig(w.root, { requireLocal: true });
  if (!config.ok) throw new Error(config.error);
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: '2026-10-01T00:00:00.000Z', seed: 'gate-seed' });
  const b = fakeBackend('x', 'DeepSeek', () => '');
  const backends: RoundBackends = {
    writers: ['W1', 'W2', 'W3', 'W4'].map((slot) => ({ slot, backend: b })),
    baseline: b, decoy: b, defect: b, judges: [], forecasters: [], maintainer: b, mergeEditor: b, calibGateway: new Map(),
  };
  const built = buildContext({
    root: w.root, repo: w.repo, roundId: 'R01', pipeline: 'round', paths: roundPaths(w.root, 'R01'), config: config.value,
    deps: { ports, backends: () => backends, env: {}, pid: 7, isAlive: () => true, log: () => undefined },
    startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
  });
  if (!built.ok) throw new Error(built.error);
  const ctx = built.value;
  mkdirSync(ctx.paths.submissions, { recursive: true });
  const sub = (slot: string, ok: boolean, text: string): void => {
    writeFileSync(join(ctx.paths.submissions, `${slot}.json`), JSON.stringify({ id: slot, kind: 'writer', model: 'm', family: 'DeepSeek', stance: 's', ok, error: ok ? null : 'missing ```submission block', text }));
  };
  sub('W1', true, writerText('温芮把借来的扳手挂回工具墙。循环泵换了节拍。'));
  sub('W2', true, writerText('循环泵换了节拍。'.repeat(400)));
  sub('W3', false, '');
  const out = await gateMechStep.run(ctx, null);
  assert.deepEqual(out, {
    kind: 'done',
    inputs: ['rounds/R01/submissions/W1.json', 'rounds/R01/submissions/W2.json', 'rounds/R01/submissions/W3.json'],
    outputs: ['rounds/R01/gate/mechanical.json'],
    external: [],
  });
  const file: unknown = JSON.parse(readFileSync(join(ctx.paths.gate, 'mechanical.json'), 'utf8'));
  const subs = readRecord(file, 'submissions');
  const status = (slot: string): unknown => {
    const e = readRecord(subs, slot);
    return isRecord(e) ? e['status'] : null;
  };
  assert.deepEqual(['W1', 'W2', 'W3', 'W4'].map(status), ['pass', 'fail', 'missing', 'missing']);
  const w2 = readRecord(subs, 'W2');
  const checks = isRecord(w2) && Array.isArray(w2['checks']) ? w2['checks'] : [];
  assert.ok(checks.some((c) => isRecord(c) && c['name'] === 'length' && c['ok'] === false));
  assert.equal(readString(readRecord(subs, 'W3'), 'error'), 'missing ```submission block');
  assert.equal(readString(readRecord(subs, 'W4'), 'error'), 'no submission file');
  rmSync(dir, { recursive: true });
});
