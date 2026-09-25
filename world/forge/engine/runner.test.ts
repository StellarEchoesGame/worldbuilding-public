import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunHooks, StepContext } from './context.ts';
import { buildFreeze } from './freeze.ts';
import { readMarker, sha256Bytes } from './marker.ts';
import { loadSchema, validate } from './schema.ts';
import {
  CALIB_STEP_IDS, INITIAL_STEP_IDS, LOCK_FILE, STEP_IDS, acquireEngineLock, activeRun, readStatus, runSteps, verifyChain,
  type RunOptions, type StepDef, type StepId, type StepOutcome,
} from './runner.ts';
import { appendRecords, readLines, readRecords } from './store.ts';
import { IntegrityError, QuotaExhausted } from './task.ts';
import { toyContext, toyPaidStep, toyStartStep, toyWorld, toyWriteStep, type ToyContextOptions, type ToyWorld } from './testing/kill-child.ts';

const H = (s: string | Buffer): string => sha256Bytes(typeof s === 'string' ? Buffer.from(s, 'utf8') : s);

function world(): ToyWorld {
  return toyWorld(mkdtempSync(join(tmpdir(), 'forge-runner-')));
}

function opts(steps: readonly StepDef[], over: Partial<RunOptions> = {}): RunOptions {
  return { pipeline: 'round', steps, until: null, from: null, redoFrom: null, pid: 1, isAlive: (p) => p === 1, ...over };
}

/** One runner invocation on a fresh context (like a new process). */
function run(w: ToyWorld, steps: readonly StepDef[], over: Partial<RunOptions> = {}, ctxOpts: ToyContextOptions = {}): ReturnType<typeof runSteps> {
  return runSteps(toyContext(w, ctxOpts), opts(steps, over));
}

function round(w: ToyWorld, ...parts: string[]): string {
  return join(w.root, 'rounds', 'R01', ...parts);
}

function markerResult(w: ToyWorld, ...parts: string[]): string | null {
  const m = readMarker(round(w, 'markers', ...parts));
  return m !== null && m.ok ? m.value.result : null;
}

/** A step that waits for `topic` every time it runs. */
function waitStep(id: StepId): StepDef {
  return { id, run: async () => ({ kind: 'wait', waitingFor: 'topic', detail: 'waiting', inputs: [], outputs: [] }) };
}

function outcomeStep(id: StepId, make: (ctx: StepContext) => Promise<StepOutcome>): StepDef {
  return { id, run: (ctx) => make(ctx) };
}

test('a hook-thrown crash aborts runAll: undispatched siblings never call, in-flight ones settle, lock and running status stay', async () => {
  const w = world();
  const steps = [toyStartStep, toyPaidStep('01-topic', ['t1', 't2', 't3', 't4', 't5', 't6'])];
  const crash: RunHooks = {
    beforeCall: (id) => {
      if (id === 't3') throw new Error('simulated kill');
    },
  };
  await assert.rejects(run(w, steps, { pid: 1, isAlive: () => true }, { hooks: crash, concurrency: 2 }), /simulated kill/u);
  assert.deepEqual(readLines(w.callLog), ['t1#1', 't2#1']);
  assert.ok(existsSync(round(w, 'tasks', 't2.json')), 'the in-flight sibling settled');
  assert.ok(!existsSync(round(w, 'markers', '01-topic.json')));
  assert.match(readFileSync(join(w.root, LOCK_FILE), 'utf8'), /"pid":1/u);
  const status = readStatus(w.root, 'R01');
  assert.ok(status.ok);
  assert.equal(status.value.state, 'running');

  const logs: string[] = [];
  const again = await run(w, steps, { pid: 2, isAlive: (p) => p === 2 }, { logs, concurrency: 2 });
  assert.equal(again.exitCode, 0, again.detail);
  assert.ok(logs.includes('lock taken over from pid 1'));
  const calls = readLines(w.callLog);
  assert.deepEqual(calls, ['t1#1', 't2#1', 't3#1', 't4#1', 't5#1', 't6#1'], 'zero repeated paid calls');
  const marker = readMarker(round(w, 'markers', '01-topic.json'));
  assert.ok(marker !== null && marker.ok);
  assert.deepEqual(marker.value.tasks, { ok: 6, void: 0, calls: 6 }, 'counts every record of the step, including the killed attempt\'s');
  rmSync(w.dir, { recursive: true });
});

test('rewind writes a rewind marker, moves target…step to markers/stale/<n>/ and waits for the decision', async () => {
  const w = world();
  let regates = 0;
  const regate = outcomeStep('10a-regate', async (ctx) => {
    regates += 1;
    const d8 = `d${regates}`;
    const rel = ctx.files.writeJson(join(ctx.paths.merge, d8, 'regate.json'), { status: regates === 1 ? 'fail' : 'pass' });
    return regates === 1 ? { kind: 'rewind', to: '09b-decision', detail: `regate_failed:${d8}`, outputs: [rel] } : { kind: 'done', inputs: [], outputs: [rel], external: [] };
  });
  const steps = [toyStartStep, toyWriteStep('09a-audit', 'audit-set.json', '{}\n'), toyWriteStep('09b-decision', 'decision-pin.txt', 'pin\n'), regate];
  const first = await run(w, steps);
  assert.deepEqual({ state: first.state, exit: first.exitCode, step: first.step, waiting: first.waitingFor, detail: first.detail }, { state: 'waiting', exit: 2, step: '09b-decision', waiting: 'decision', detail: 'regate_failed:d1' });
  assert.deepEqual(readdirSync(round(w, 'markers', 'stale', '1')).sort(), ['09b-decision.json', '10a-regate.json']);
  assert.ok(!existsSync(round(w, 'markers', '09b-decision.json')));
  const stale = readMarker(round(w, 'markers', 'stale', '1', '10a-regate.json'));
  assert.ok(stale !== null && stale.ok);
  assert.equal(stale.value.result, 'rewind');
  assert.deepEqual(stale.value.outputs, { 'rounds/R01/merge/d1/regate.json': H('{\n  "status": "fail"\n}\n') });
  assert.equal(stale.value.prev, H(readFileSync(round(w, 'markers', 'stale', '1', '09b-decision.json'))));
  assert.deepEqual(verifyChain(w.root, 'rounds/R01', steps.map((s) => s.id)), []);
  const status = readStatus(w.root, 'R01');
  assert.ok(status.ok);
  assert.deepEqual([status.value.state, status.value.waiting_for, status.value.exit_code], ['waiting', 'decision', 2]);
  assert.deepEqual(status.value.done, ['00-start', '09a-audit']);

  const second = await run(w, steps);
  assert.equal(second.exitCode, 0, second.detail);
  assert.equal(markerResult(w, '10a-regate.json'), 'done');
  assert.ok(existsSync(round(w, 'merge', 'd1', 'regate.json')), 'the failed attempt stays as evidence');
  rmSync(w.dir, { recursive: true });
});

/** 02c toy: pins the bundle, the pipeline hash and benchmark v1; lists the pinned files as marker inputs. */
const toyFreezeStep: StepDef = {
  id: '02c-freeze',
  run: async (ctx) => {
    const active = activeRun(ctx);
    if (active === null) throw new Error('02c outside runSteps');
    const bench = readFileSync(join(ctx.root, 'benchmark', 'v1.json'));
    const freeze = buildFreeze({
      round: 'R01', files: {}, benchmarkVersion: 'v1', eligibleFamilies: [], flags: {}, protocolBundleSha256: ctx.bundleSha256, probeCreatedAt: null,
      seed: 'toy-seed', stepsSha256: active.stepsSha256, gateFamilies: [], trustStatusSha256: null, skills: {},
      benchmarkResolution: { version: 'v1', sha256: H(bench), path: 'benchmark/v1.json', via: 'activate', since: ctx.ports.clock.now() },
    });
    const rel = ctx.files.writeJson(ctx.paths.freeze, freeze);
    return { kind: 'done', inputs: ['judges.json', 'families.json', 'writers.json', 'fact-status.json', 'benchmark/v1.json'], outputs: [rel], external: [] };
  },
};

test('resume after 02c re-checks the freeze pins: bundle, judges.json, fact table, pinned benchmark and steps_sha256 drift → exit 3; an owner rollback is not drift', async () => {
  const w = world();
  const steps = [toyStartStep, toyFreezeStep, waitStep('03a-forecast')];
  assert.equal((await run(w, steps)).exitCode, 2);
  const drifted = async (file: string, edit: (text: string) => string, pattern: RegExp): Promise<void> => {
    const path = join(w.root, file);
    const original = readFileSync(path);
    writeFileSync(path, edit(original.toString('utf8')));
    const r = await run(w, steps);
    assert.equal(r.exitCode, 3, `${file}: ${r.detail}`);
    assert.equal(r.state, 'integrity');
    assert.match(r.detail, pattern);
    writeFileSync(path, original);
    assert.equal((await run(w, steps)).exitCode, 2, `restored ${file}`);
  };
  await drifted('fact-status.json', (t) => t.replace('[]', '["F99"]'), /fact-status\.json/u);
  await drifted('judges.json', (t) => `${t}\n`, /protocol bundle changed[\s\S]*judges\.json|judges\.json[\s\S]*protocol bundle changed/u);
  await drifted('benchmark/v1.json', (t) => t.replace('v1', 'v1-edited'), /benchmark\/v1\.json: pinned benchmark changed/u);
  await drifted('PROTOCOL.md', (t) => `${t}\n`, /protocol bundle changed since 02c-freeze/u);
  writeFileSync(join(w.root, 'owner-log.jsonl'), `${JSON.stringify({ at: '2026-10-01T01:00:00.000Z', action: 'rollback', round: null, file: 'benchmark/v1.json', sha256: H('x'), source: 'ui', version: 'v1', from: 'v2' })}\n`);
  assert.equal((await run(w, steps)).exitCode, 2, 'an owner-log rollback is not drift');
  const longer = await run(w, [...steps, waitStep('03b-seal')]);
  assert.equal(longer.exitCode, 3);
  assert.match(longer.detail, /steps_sha256/u);
  rmSync(w.dir, { recursive: true });
});

test('branch check: wrong branch with a clean tree is checked out; with a dirty tree → exit 1 without a status write', async () => {
  const w = world();
  const steps = [toyStartStep, waitStep('01-topic')];
  assert.equal((await run(w, steps)).exitCode, 2);
  const clean = { branch: 'main', clean: true, checkouts: [] };
  assert.equal((await run(w, steps, {}, { git: clean })).exitCode, 2);
  assert.deepEqual(clean.checkouts, ['forge/r01']);
  const before = readFileSync(round(w, 'status.json'));
  const dirty = { branch: 'main', clean: false, checkouts: [] };
  const r = await run(w, steps, {}, { git: dirty });
  assert.deepEqual([r.exitCode, r.state], [1, 'usage']);
  assert.match(r.detail, /dirty/u);
  assert.deepEqual(dirty.checkouts, []);
  assert.deepEqual(readFileSync(round(w, 'status.json')), before);
  assert.ok(!existsSync(join(w.root, LOCK_FILE)), 'a usage exit releases the lock');
  // A usage exit after a step of this run was marked reports where the run stopped instead of restoring.
  const w2 = world();
  const git = { branch: 'forge/r01', clean: true, checkouts: [] };
  const leaves = outcomeStep('01-topic', async () => {
    git.branch = 'main';
    git.clean = false;
    return { kind: 'done', inputs: [], outputs: [], external: [] };
  });
  const mid = await run(w2, [toyStartStep, leaves, waitStep('02a-brief')], {}, { git });
  assert.deepEqual([mid.exitCode, mid.state], [1, 'usage']);
  const status = readStatus(w2.root, 'R01');
  assert.ok(status.ok);
  assert.deepEqual([status.value.state, status.value.step, status.value.exit_code, status.value.done], ['blocked', '02a-brief', 1, ['00-start', '01-topic']]);
  rmSync(w.dir, { recursive: true });
  rmSync(w2.dir, { recursive: true });
});

test('--redo-from moves markers to markers/stale/<n>/ and is refused ≤ 03c after probe.json, ≤ 06d once 07a is marked, ≤ 09b once audit.json exists', async () => {
  const w = world();
  const ids: StepId[] = ['03c-probe-mirror', '06d-measures', '07a-unseal', '09b-decision', '10a-regate'];
  const steps = [toyStartStep, ...ids.map((id) => toyWriteStep(id, `${id}.txt`, `${id}\n`))];
  assert.equal((await run(w, steps)).exitCode, 0);
  const redo = await run(w, steps, { redoFrom: '09b-decision' });
  assert.equal(redo.exitCode, 0, redo.detail);
  assert.deepEqual(readdirSync(round(w, 'markers', 'stale', '1')).sort(), ['09b-decision.json', '10a-regate.json']);
  assert.equal(markerResult(w, '10a-regate.json'), 'done');
  const refused = async (target: StepId, pattern: RegExp): Promise<void> => {
    const before = readFileSync(round(w, 'status.json'));
    const r = await run(w, steps, { redoFrom: target });
    assert.deepEqual([r.exitCode, r.state], [1, 'usage'], r.detail);
    assert.match(r.detail, pattern);
    assert.deepEqual(readFileSync(round(w, 'status.json')), before, 'a refused redo writes no status');
  };
  writeFileSync(round(w, 'audit.json'), '{}');
  await refused('09b-decision', /audit\.json/u);
  assert.equal((await run(w, steps, { redoFrom: '10a-regate' })).exitCode, 0);
  assert.deepEqual(readdirSync(round(w, 'markers', 'stale')).sort(), ['1', '2']);
  await refused('06d-measures', /07a-unseal is marked/u);
  writeFileSync(round(w, 'probe.json'), '{}');
  await refused('03c-probe-mirror', /probe is published/u);
  await refused('00-start', /probe is published/u);
  rmSync(w.dir, { recursive: true });
});

test('engine logs: a torn progress tail is cut before the next append; a bad middle line → exit 3', async () => {
  const w = world();
  const steps = [toyStartStep, waitStep('01-topic')];
  const progressPath = round(w, 'progress.jsonl');
  mkdirSync(round(w), { recursive: true });
  writeFileSync(progressPath, '{"at":"t0","step":"x","status":"info","detail":""}\n{"at":"t1","st');
  assert.equal((await run(w, steps)).exitCode, 2);
  const text = readFileSync(progressPath, 'utf8');
  assert.ok(!text.includes('"st{'), 'the torn fragment is gone, not glued to the next line');
  assert.ok(text.endsWith('\n'));
  const records = readRecords(progressPath);
  assert.ok(records.ok);
  assert.ok(records.value.length > 2);
  writeFileSync(progressPath, `not json\n${text}`);
  const r = await run(w, steps);
  assert.deepEqual([r.exitCode, r.state], [3, 'integrity']);
  assert.match(r.detail, /rounds\/R01\/progress\.jsonl: line 1/u);
  rmSync(w.dir, { recursive: true });
});

test('engine lock: wx + {pid, started_at} token; a live holder → exit 1; a dead holder is taken over; release only removes its own token', async () => {
  const w = world();
  const now = '2026-10-01T00:00:00.000Z';
  const first = acquireEngineLock(w.root, 10, () => true, now);
  assert.ok(first.ok);
  const lockPath = join(w.root, LOCK_FILE);
  assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), { pid: 10, started_at: now });
  const second = acquireEngineLock(w.root, 11, () => true, now);
  assert.ok(!second.ok);
  assert.match(second.error, /held by pid 10/u);
  const r = await run(w, [toyStartStep], { pid: 11, isAlive: () => true });
  assert.deepEqual([r.exitCode, r.state], [1, 'usage']);
  assert.ok(!existsSync(round(w, 'status.json')), 'a live lock blocks before any status write');
  const taken = acquireEngineLock(w.root, 12, (pid) => pid === 12, now);
  assert.ok(taken.ok);
  assert.equal(taken.value.takenOverFrom, 10);
  first.value.release();
  assert.ok(existsSync(lockPath), "a stale holder's release leaves the new token");
  taken.value.release();
  assert.ok(!existsSync(lockPath));
  writeFileSync(lockPath, '{"pid":');
  const torn = acquireEngineLock(w.root, 13, () => false, now);
  assert.ok(!torn.ok);
  assert.match(torn.error, /unreadable/u);
  // Two takers of one dead lock: A replaces it while B decides; B's rename moves A's live lock, so B puts it back.
  writeFileSync(lockPath, `${JSON.stringify({ pid: 20, started_at: now })}\n`);
  const liveA = `${JSON.stringify({ pid: 21, started_at: now })}\n`;
  let raced = false;
  const b = acquireEngineLock(w.root, 22, (pid) => {
    if (pid === 20 && !raced) {
      raced = true;
      rmSync(lockPath);
      writeFileSync(lockPath, liveA);
      return false;
    }
    return pid === 21;
  }, now);
  assert.ok(!b.ok);
  assert.match(b.error, /held by pid 21/u);
  assert.equal(readFileSync(lockPath, 'utf8'), liveA, "A's live lock survives B's takeover attempt");
  assert.deepEqual(readdirSync(w.root).filter((n) => n.startsWith(LOCK_FILE)), [LOCK_FILE], 'no aside file is left');
  rmSync(w.dir, { recursive: true });
});

test('a wait writes a pending marker; re-entry gets it and does not redo the engine half; the answer turns it into a done marker', async () => {
  const w = world();
  let engineHalf = 0;
  const audit: StepDef = {
    id: '09a-audit',
    run: async (ctx, pending) => {
      const set = join(ctx.paths.dir, 'audit-set.json');
      if (pending === null) {
        engineHalf += 1;
        ctx.files.writeJson(set, { pairs: [1, 2] });
      } else {
        assert.ok(Object.hasOwn(pending.outputs, 'rounds/R01/audit-set.json'));
      }
      const answers = join(ctx.paths.dir, 'audit.json');
      if (!existsSync(answers)) return { kind: 'wait', waitingFor: 'audit', detail: '盲审待回答', inputs: [], outputs: [ctx.files.rel(set)] };
      return { kind: 'done', inputs: [ctx.files.rel(answers)], outputs: [ctx.files.rel(set)], external: [] };
    },
  };
  const steps = [toyStartStep, audit];
  const first = await run(w, steps);
  assert.deepEqual([first.exitCode, first.waitingFor], [2, 'audit']);
  assert.equal(markerResult(w, '09a-audit.json'), 'waiting');
  assert.equal((await run(w, steps)).exitCode, 2);
  assert.equal(engineHalf, 1);
  const set = round(w, 'audit-set.json');
  const original = readFileSync(set);
  writeFileSync(set, '{"pairs":[9]}');
  const tampered = await run(w, steps);
  assert.equal(tampered.exitCode, 3);
  assert.match(tampered.detail, /rounds\/R01\/audit-set\.json/u);
  writeFileSync(set, original);
  writeFileSync(round(w, 'audit.json'), '{"answers":[]}');
  assert.equal((await run(w, steps)).exitCode, 0);
  assert.equal(engineHalf, 1);
  assert.equal(markerResult(w, '09a-audit.json'), 'done');
  rmSync(w.dir, { recursive: true });
});

test('verifyChain detects a broken prev, a gap and a tampered output; runSteps refuses with exit 3 listing the path', async () => {
  const w = world();
  const steps = [toyStartStep, toyWriteStep('01-topic', 'topic.json', '{"a":1}\n'), toyWriteStep('02a-brief', 'brief.json', '{"b":1}\n', ['rounds/R01/topic.json'])];
  const ids = steps.map((s) => s.id);
  assert.equal((await run(w, steps)).exitCode, 0);
  assert.deepEqual(verifyChain(w.root, 'rounds/R01', ids), []);
  writeFileSync(round(w, 'brief.json'), '{"b":2}\n');
  const tampered = await run(w, steps);
  assert.deepEqual([tampered.exitCode, tampered.state], [3, 'integrity']);
  assert.match(tampered.detail, /rounds\/R01\/brief\.json: content does not match its marker hash/u);
  writeFileSync(round(w, 'brief.json'), '{"b":1}\n');
  const startMarker = round(w, 'markers', '00-start.json');
  const original = readFileSync(startMarker, 'utf8');
  writeFileSync(startMarker, original.replace('\n}', '\n }'));
  assert.ok(verifyChain(w.root, 'rounds/R01', ids).includes('rounds/R01/markers/01-topic.json: prev does not match 00-start'));
  assert.equal((await run(w, steps)).exitCode, 3);
  writeFileSync(startMarker, original);
  rmSync(round(w, 'markers', '01-topic.json'));
  assert.ok(verifyChain(w.root, 'rounds/R01', ids).some((p) => p.includes('02a-brief.json: present although 01-topic has no marker')));
  rmSync(w.dir, { recursive: true });
});

test('amendment rule: only 03c-probe-mirror may re-list freeze.json with a new hash', async () => {
  const w = world();
  const amend = (id: StepId): StepDef => ({
    id,
    run: async (ctx) => {
      const rel = ctx.files.writeText(ctx.paths.freeze, `{"amended_by":"${id}"}\n`);
      return { kind: 'done', inputs: [], outputs: [rel], external: [] };
    },
  });
  const allowed = [toyStartStep, toyWriteStep('02c-freeze', 'freeze.json', '{}\n'), amend('03c-probe-mirror')];
  assert.equal((await run(w, allowed)).exitCode, 0);
  assert.deepEqual(verifyChain(w.root, 'rounds/R01', allowed.map((s) => s.id)), []);
  const w2 = world();
  const refused = [toyStartStep, toyWriteStep('02c-freeze', 'freeze.json', '{}\n'), amend('04-write')];
  assert.equal((await run(w2, refused)).exitCode, 0);
  assert.deepEqual(verifyChain(w2.root, 'rounds/R01', refused.map((s) => s.id)), ['rounds/R01/freeze.json: re-listed by 04-write with a hash that differs from 02c-freeze']);
  assert.equal((await run(w2, refused)).exitCode, 3);
  rmSync(w.dir, { recursive: true });
  rmSync(w2.dir, { recursive: true });
});

test('outcomes and typed errors map onto the exit table and release the lock; status.json validates', async () => {
  const schema = loadSchema(JSON.parse(readFileSync(new URL('../schema/status.schema.json', import.meta.url), 'utf8')));
  assert.ok(schema.ok);
  const cases: Array<[StepDef, number, string]> = [
    [outcomeStep('01-topic', async () => ({ kind: 'blocked', detail: 'probe_mirror:comment' })), 4, 'blocked'],
    [outcomeStep('01-topic', async () => ({ kind: 'failed', detail: 'doctor red' })), 5, 'failed'],
    [outcomeStep('01-topic', async () => Promise.reject(new QuotaExhausted('quota budget spent'))), 4, 'blocked'],
    [outcomeStep('01-topic', async () => Promise.reject(new IntegrityError('prompt_sha256 mismatch'))), 3, 'integrity'],
    [outcomeStep('01-topic', async () => ({ kind: 'failed', detail: 'gateway request failed: fixture-gateway.invalid' })), 5, 'failed'],
  ];
  for (const [step, exit, state] of cases) {
    const w = world();
    const r = await run(w, [toyStartStep, step]);
    assert.deepEqual([r.exitCode, r.state, r.step], [exit, state, '01-topic']);
    assert.ok(!r.detail.includes('fixture-gateway.invalid'));
    const status = readStatus(w.root, 'R01');
    assert.ok(status.ok);
    assert.deepEqual([status.value.state, status.value.exit_code, status.value.done], [state, exit, ['00-start']]);
    assert.ok(!readFileSync(round(w, 'status.json'), 'utf8').includes('fixture-gateway.invalid'));
    assert.deepEqual(validate(schema.value, JSON.parse(readFileSync(round(w, 'status.json'), 'utf8'))), []);
    assert.ok(!existsSync(round(w, 'markers', '01-topic.json')));
    assert.ok(!existsSync(join(w.root, LOCK_FILE)));
    rmSync(w.dir, { recursive: true });
  }
});

test('--until stops with done after that step; --from refuses while an earlier step is unmarked; a skip writes a marker', async () => {
  const w = world();
  const skip = outcomeStep('02a-brief', async () => ({ kind: 'skip', reason: 'nothing to brief' }));
  const steps = [toyStartStep, toyWriteStep('01-topic', 'topic.json', '{}\n'), skip];
  const from = await run(w, steps, { from: '01-topic' });
  assert.deepEqual([from.exitCode, from.state], [1, 'usage']);
  assert.match(from.detail, /00-start is not marked/u);
  const until = await run(w, steps, { until: '00-start' });
  assert.deepEqual([until.exitCode, until.state, until.step], [0, 'done', '00-start']);
  assert.ok(!existsSync(round(w, 'markers', '01-topic.json')));
  assert.equal((await run(w, steps, { from: '01-topic' })).exitCode, 0);
  const m = readMarker(round(w, 'markers', '02a-brief.json'));
  assert.ok(m !== null && m.ok);
  assert.deepEqual([m.value.result, m.value.skipped], ['skip', 'nothing to brief']);
  const bad = await run(w, steps, { until: '09b-decision' });
  assert.deepEqual([bad.exitCode, bad.state], [1, 'usage']);
  rmSync(w.dir, { recursive: true });
});

test('marker.schema.json lists every step id; readStatus reports a missing file or bad id', () => {
  const raw: unknown = JSON.parse(readFileSync(new URL('../schema/marker.schema.json', import.meta.url), 'utf8'));
  const schema = loadSchema(raw);
  assert.ok(schema.ok);
  assert.deepEqual(schema.value.properties?.['step']?.enum, [...STEP_IDS, ...CALIB_STEP_IDS, ...INITIAL_STEP_IDS]);
  const w = world();
  assert.ok(!readStatus(w.root, 'R01').ok);
  assert.ok(!readStatus(w.root, '../x').ok);
  rmSync(w.dir, { recursive: true });
});

test('appendRecords writes one batch after cutting a torn tail; readRecords ignores only a torn last line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-append-'));
  const log = join(dir, 'sub', 'log.jsonl');
  appendRecords(log, [{ a: 1 }, { b: '换行\n不拆行' }]);
  assert.equal(readFileSync(log, 'utf8'), '{"a":1}\n{"b":"换行\\n不拆行"}\n');
  writeFileSync(log, `${readFileSync(log, 'utf8')}{"torn":`);
  const before = readRecords(log);
  assert.ok(before.ok);
  assert.equal(before.value.length, 2);
  appendRecords(log, [{ c: 3 }]);
  assert.equal(readFileSync(log, 'utf8'), '{"a":1}\n{"b":"换行\\n不拆行"}\n{"c":3}\n');
  writeFileSync(log, '{"only":');
  appendRecords(log, [{ d: 4 }]);
  assert.equal(readFileSync(log, 'utf8'), '{"d":4}\n');
  appendRecords(log, []);
  assert.equal(readFileSync(log, 'utf8'), '{"d":4}\n');
  assert.throws(() => appendRecords(log, [undefined]), /not JSON-serialisable/u);
  writeFileSync(log, '{"d":4}\n\n{"e":5}\n');
  assert.ok(!readRecords(log).ok, 'a blank middle line is not a record');
  assert.deepEqual(readRecords(join(dir, 'absent.jsonl')), { ok: true, value: [] });
  rmSync(dir, { recursive: true });
});

test('stray *.tmp files are deleted before the run, except an in-flight UI owner write', async () => {
  const w = world();
  mkdirSync(round(w, 'markers'), { recursive: true });
  writeFileSync(round(w, 'markers', '00-start.json.1a2b.tmp'), '{');
  writeFileSync(round(w, 'audit.json.3c4d.tmp'), '{');
  mkdirSync(join(w.root, '.sealed', 'R01'), { recursive: true });
  writeFileSync(join(w.root, '.sealed', 'R01', 'sealed.json.5e6f.tmp'), '{');
  const logs: string[] = [];
  assert.equal((await run(w, [toyStartStep], {}, { logs })).exitCode, 0);
  assert.ok(!existsSync(round(w, 'markers', '00-start.json.1a2b.tmp')));
  assert.ok(!existsSync(join(w.root, '.sealed', 'R01', 'sealed.json.5e6f.tmp')));
  assert.ok(existsSync(round(w, 'audit.json.3c4d.tmp')));
  assert.ok(logs.includes('deleted 2 stray *.tmp file(s)'));
  rmSync(w.dir, { recursive: true });
});

test('a step that lists an append-only engine log (benchmark/log.jsonl) in its marker is a step bug: the run crashes', async () => {
  const w = world();
  const step = outcomeStep('00-start', async (ctx) => {
    const rel = ctx.files.appendLine(join(ctx.root, 'benchmark', 'log.jsonl'), { cycle: 'toy', outcome: 'no_change' });
    return { kind: 'done', inputs: [], outputs: [rel], external: [] };
  });
  await assert.rejects(run(w, [step]), /engine log benchmark\/log\.jsonl must not be listed in a marker/u);
  assert.ok(!existsSync(round(w, 'markers', '00-start.json')));
  rmSync(w.dir, { recursive: true });
});
