import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { benchCommand, benchStatusLines, benchValidateCommand, parseBenchArgs, r00Refusal } from './cli-bench.ts';
import type { ForgeRoots } from './cli-round.ts';
import { isRecord, type JsonRecord } from './json.ts';
import { sha256Bytes } from './owner-inputs.ts';
import { e2eWorld, forgeHarness } from './testing/e2e-script.ts';
import { fakeClock } from './testing/fakes.ts';
import { DEFAULT_FIXTURE, fixtureWorld, type FixtureOptions } from './testing/fixture-world.ts';
import { ownerSim } from './testing/owner-sim.ts';
import { filesUnder } from './testing/round-script.ts';

/*
 * `forge bench …` (cli-bench.ts): argument forms, the deps-free file validation (holds from the owner log unless
 * --rollbacks), the --status resolution lines, and the refusals of the round-0 commands. The step sub-commands run the
 * cycle steps of bench-cycle.ts on the shared runner; engine/e2e.test.ts drives them end to end.
 */

function fixture(opts: FixtureOptions): { dir: string; at: ForgeRoots } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-cli-bench-'));
  const w = fixtureWorld(dir, opts);
  return { dir, at: { root: w.root, repo: w.repo } };
}

function obj(path: string): JsonRecord {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(value)) throw new Error(`${path}: not an object`);
  return value;
}

function put(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

test('parseBenchArgs: step forms map to 11f–11j; --initial only for R00; --status; the file form of validate; usage errors', () => {
  assert.deepEqual(parseBenchArgs(['evidence', 'R01']), { ok: true, value: { cmd: 'step', step: '11f-bench-evidence', round: 'R01', quotaBudgetMs: null } });
  assert.deepEqual(parseBenchArgs(['propose', 'R02', '--quota-budget-min', '5']), { ok: true, value: { cmd: 'step', step: '11g-bench-propose', round: 'R02', quotaBudgetMs: 300_000 } });
  assert.deepEqual(parseBenchArgs(['validate', 'R00']), { ok: true, value: { cmd: 'step', step: '11h-bench-validate', round: 'R00', quotaBudgetMs: null } });
  assert.deepEqual(parseBenchArgs(['replay', 'R03']), { ok: true, value: { cmd: 'step', step: '11i-bench-replay', round: 'R03', quotaBudgetMs: null } });
  assert.deepEqual(parseBenchArgs(['activate', 'R01']), { ok: true, value: { cmd: 'step', step: '11j-bench-outcome', round: 'R01', quotaBudgetMs: null } });
  assert.deepEqual(parseBenchArgs(['propose', 'R00', '--initial']), { ok: true, value: { cmd: 'initial', quotaBudgetMs: null } });
  assert.deepEqual(parseBenchArgs(['activate', '--status']), { ok: true, value: { cmd: 'status' } });
  assert.deepEqual(parseBenchArgs(['activate', 'R02', '--status']), { ok: true, value: { cmd: 'status' } });
  assert.deepEqual(parseBenchArgs(['validate', 'cand.json', '--parent', 'p.json', '--round', '4', '--rollbacks', 'r.json']), {
    ok: true, value: { cmd: 'validate-file', file: 'cand.json', parent: 'p.json', round: 4, rollbacks: 'r.json' },
  });
  assert.deepEqual(parseBenchArgs(['validate', 'cand.json']), { ok: true, value: { cmd: 'validate-file', file: 'cand.json', parent: null, round: null, rollbacks: null } });
  const refused: string[][] = [
    [], ['publish', 'R01'], ['evidence'], ['evidence', 'P01'], ['evidence', 'R01', 'R02'], ['propose', 'R01', '--initial'], ['evidence', 'R01', '--initial'],
    ['evidence', 'R01', '--quota-budget-min', '5'], ['validate', 'cand.json', '--round', '-1'], ['activate', 'X1', '--status'], ['replay', 'R01', '--status'],
  ];
  for (const argv of refused) assert.equal(parseBenchArgs(argv).ok, false, argv.join(' '));
});

test('benchValidateCommand: verdict JSON, parent by name, holds from the owner log unless --rollbacks; exit 1 on a rejected or unreadable candidate', () => {
  const { dir, at } = fixture(DEFAULT_FIXTURE);
  const v1 = obj(join(at.root, 'benchmark', 'v1.json'));
  const candidate = {
    ...v1, version: 'v2', parent: 'v1', cliche_list: ['时光在指缝间流走', '岁月如梭'],
    reasons: [{ change: '多一个陈词', keys: ['cliche_list'], evidence_ids: ['E-R01-RC'], expected_effect: '少一个套话' }],
  };
  put(join(dir, 'cand.json'), candidate);
  const out: string[] = [];
  const err: string[] = [];
  const sinks = { out: (l: string) => void out.push(l), err: (l: string) => void err.push(l) };
  assert.equal(benchValidateCommand(['cand.json', '--round', '1'], at, dir, sinks), 0, err.join('\n'));
  const verdict: unknown = JSON.parse(out.join('\n'));
  assert.ok(isRecord(verdict));
  assert.deepEqual([verdict['ok'], verdict['activation'], verdict['changedKeys']], [true, 'auto', ['cliche_list']]);
  assert.match(err.join('\n'), /^parent v1: /mu);
  // a rollback hold on cliche_list (explicit --rollbacks) upgrades the change to owner class
  put(join(dir, 'holds.json'), [{ round: 1, rolled_back_keys: ['cliche_list'] }]);
  out.length = 0;
  assert.equal(benchValidateCommand(['cand.json', '--round', '2', '--rollbacks', 'holds.json'], at, dir, sinks), 0);
  const held: unknown = JSON.parse(out.join('\n'));
  assert.equal(isRecord(held) ? held['activation'] : null, 'owner');
  // no reason for the changed key → rejected (exit 1, verdict still printed)
  put(join(dir, 'bad.json'), { ...candidate, reasons: [] });
  out.length = 0;
  assert.equal(benchValidateCommand(['bad.json', '--parent', join(at.root, 'benchmark', 'v1.json')], at, dir, sinks), 1);
  const rejected: unknown = JSON.parse(out.join('\n'));
  assert.equal(isRecord(rejected) ? rejected['ok'] : null, false);
  writeFileSync(join(dir, 'broken.json'), '{');
  err.length = 0;
  assert.equal(benchValidateCommand(['broken.json'], at, dir, sinks), 1);
  assert.match(err.join('\n'), /^forge: cannot read .*broken\.json as JSON/u);
  assert.equal(benchValidateCommand(['R01'], at, dir, sinks), 1, 'the RNN form runs step 11h (benchCommand), not the file check');
  rmSync(dir, { recursive: true, force: true });
});

test('benchValidateCommand: without --round the owner-log holds are judged at the newest frozen round + 1 (printed); --round overrides', () => {
  const { dir, at } = fixture(DEFAULT_FIXTURE);
  const root = at.root;
  const frozen = (ids: readonly string[]): void => { for (const id of ids) put(join(root, 'rounds', id, 'freeze.json'), {}); };
  const v1 = obj(join(root, 'benchmark', 'v1.json'));
  put(join(dir, 'cand.json'), {
    ...v1, version: 'v3', parent: 'v1', cliche_list: ['新陈词'],
    reasons: [{ change: '换一个陈词', keys: ['cliche_list'], evidence_ids: ['E-R02-RC'], expected_effect: '少一个套话' }],
  });
  const out: string[] = [];
  const err: string[] = [];
  const sinks = { out: (l: string) => void out.push(l), err: (l: string) => void err.push(l) };
  const activation = (argv: readonly string[]): unknown => {
    out.length = 0;
    err.length = 0;
    assert.equal(benchValidateCommand(argv, at, dir, sinks), 0, err.join('\n'));
    const verdict: unknown = JSON.parse(out.join('\n'));
    return isRecord(verdict) ? verdict['activation'] : null;
  };
  assert.equal(activation(['cand.json']), 'auto', 'no rollback yet');
  assert.match(err.join('\n'), /^round 1 \(no frozen round\)/mu);
  // v2 (cliche_list changed) logged as an activate the owner viewed, rolled back to v1 while R02 is the newest frozen round
  put(join(root, 'benchmark', 'v2.json'), { ...v1, version: 'v2', parent: 'v1', cliche_list: ['另一条陈词'] });
  const v1Line: unknown = JSON.parse(readFileSync(join(root, 'benchmark', 'log.jsonl'), 'utf8').split('\n')[0] ?? '');
  assert.ok(isRecord(v1Line));
  const v2Sha = sha256Bytes(readFileSync(join(root, 'benchmark', 'v2.json')));
  const v2Line = { ...v1Line, at: '2026-10-01T12:00:00.000Z', cycle: 'R01', outcome: 'activate', version: 'v2', parent: 'v1', sha256: v2Sha, path: 'benchmark/v2.json', activation: 'auto' };
  appendFileSync(join(root, 'benchmark', 'log.jsonl'), `${JSON.stringify(v2Line)}\n`);
  frozen(['R01', 'R02']);
  const sim = ownerSim(root, fakeClock('2026-10-02T00:00:00.000Z'));
  sim.viewBenchDiff('v2');
  sim.rollback('v1', 'v2');
  assert.equal(activation(['cand.json']), 'owner', 'R03 is inside the hold from R02');
  assert.match(err.join('\n'), /^round 3 \(newest frozen round R02 \+ 1\)/mu);
  frozen(['R03', 'R04', 'R05']);
  assert.equal(activation(['cand.json']), 'auto', 'R06 is past the 3-round hold from R02');
  assert.match(err.join('\n'), /^round 6 \(newest frozen round R05 \+ 1\)/mu);
  assert.equal(activation(['cand.json', '--round', '4']), 'owner', 'an explicit --round wins');
  assert.doesNotMatch(err.join('\n'), /^round /mu);
  rmSync(dir, { recursive: true, force: true });
});

test('benchStatusLines: effective / head resolution and the versions waiting for the owner', () => {
  const pending = fixture({ ...DEFAULT_FIXTURE, benchmark: 'pending' });
  const lines = benchStatusLines(pending.at.root, '2026-10-01T00:00:00.000Z');
  assert.ok(lines.ok, lines.ok ? '' : lines.error);
  assert.match(lines.value.join('\n'), /^effective \(the next freeze pins it\): none \(no active benchmark\)$/mu);
  assert.match(lines.value.join('\n'), /^pending owner approval: v1 \(logged 2026-09-01T00:00:00\.000Z\); 基准 v1 待 owner 批准$/mu);
  const active = fixture(DEFAULT_FIXTURE);
  const ok = benchStatusLines(active.at.root, '2026-10-01T00:00:00.000Z');
  assert.ok(ok.ok);
  assert.match(ok.value.join('\n'), /^effective \(the next freeze pins it\): v1 via activate since /mu);
  assert.match(ok.value.join('\n'), /^head \(the next proposal builds on it\): v1 via activate since /mu);
  assert.match(ok.value.join('\n'), /^pending owner approval: none$/mu);
  writeFileSync(join(active.at.root, 'benchmark', 'v1.json'), '{}\n');
  const edited = benchStatusLines(active.at.root, '2026-10-01T00:00:00.000Z');
  assert.ok(!edited.ok && /was edited/u.test(edited.error), 'an edited version file is an error, not a resolution');
  for (const d of [pending.dir, active.dir]) rmSync(d, { recursive: true, force: true });
});

test('benchCommand: --initial behind the protocol gate on forge/r00 and refused once calibration answers exist; R00 before calib score, unstarted rounds and --status', async () => {
  const x = e2eWorld();
  const { forge } = forgeHarness(x, () => undefined);
  const root = x.w.root;
  const maintainerCalls = (): number => x.routers.find((r) => r.id === 'maintainer')?.log().length ?? -1;
  assert.equal(await forge(['bench', 'evidence', 'R00']), 1);
  assert.match(x.logs.at(-1) ?? '', /C00 c5-score is not marked/u);
  assert.equal(r00Refusal(root)?.includes('forge calib'), true);
  assert.equal(await forge(['bench', 'evidence', 'R01']), 1);
  assert.match(x.logs.at(-1) ?? '', /R01 is not started/u);
  assert.equal(await forge(['bench', 'publish', 'R01']), 1);
  const before = filesUnder(root, root).sort();
  assert.equal(await forge(['bench', 'activate', '--status']), 0);
  assert.match(x.logs.at(-2) ?? '', /^head .*: none \(no active benchmark\)$/u);
  assert.deepEqual(filesUnder(root, root).sort(), before, '--status writes nothing');

  assert.equal(await forge(['bench', 'propose', 'R00', '--initial']), 2, x.logs.join('\n'));
  assert.deepEqual(await x.ports.git.currentBranch(), { ok: true, value: 'forge/r00' });
  assert.equal(maintainerCalls(), 0, 'the protocol gate comes before any call');
  x.sim.approveProtocol();
  assert.equal(await forge(['bench', 'propose', 'R00', '--initial']), 0, x.logs.join('\n'));
  assert.equal(maintainerCalls(), 1);
  assert.ok(existsSync(join(root, 'benchmark', 'v1.json')));
  assert.equal(await forge(['bench', 'propose', 'R00', '--initial']), 0, 'a finished bench-initial pipeline reruns as a no-op');
  assert.equal(maintainerCalls(), 1);
  x.sim.writeUnlogged('calibration/owner-answers.json', { sets: {} });
  assert.equal(await forge(['bench', 'propose', 'R00', '--initial']), 1);
  assert.match(x.logs.at(-1) ?? '', /owner-answers\.json exists/u);
  assert.equal(maintainerCalls(), 1);
  rmSync(x.dir, { recursive: true, force: true });
});
