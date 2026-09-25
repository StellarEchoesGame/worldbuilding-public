import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { Backend, CallOptions } from './adapters/types.ts';
import { isQuotaError } from './adapters/types.ts';
import { callOutputPath, callRecordPath } from './calls.ts';
import type { RoundFiles, StepContext } from './context.ts';
import { err, ok } from './result.ts';
import { loadSchema, validate } from './schema.ts';
import { roundPaths, sha256, writeJson, writeText, type RoundPaths } from './store.ts';
import {
  IntegrityError, NO_RUN_CONTROL, QuotaExhausted, readTaskRecord, runTaskWith, timeoutFor, type TaskContext, type TaskRunControl, type TaskSpec,
} from './task.ts';
import { FIXTURE_GATEWAY_HOST } from './testing/fixture-world.ts';
import { callLog, fakeRouter, type Route } from './testing/scripted.ts';

const REDACTED = '[redacted:gateway-host]';

/** Compile-time check: every StepContext is a TaskContext. */
const stepIsTaskContext = (c: StepContext): TaskContext => c;

/** runTask / runSealedTask on a TaskContext (outside runSteps: never aborted, no --redo-from). */
function runT<T>(ctx: TaskContext, backend: Backend, spec: TaskSpec<T>, control: TaskRunControl = NO_RUN_CONTROL) {
  return runTaskWith(ctx, control, backend, spec, 'round');
}

function runS<T>(ctx: TaskContext, backend: Backend, spec: TaskSpec<T>) {
  return runTaskWith(ctx, NO_RUN_CONTROL, backend, spec, 'sealed');
}

function testFiles(root: string, writes: string[]): RoundFiles {
  const rel = (p: string): string => relative(root, p);
  const log = (p: string): string => { writes.push(rel(p)); return rel(p); };
  return {
    root,
    rel,
    writeJson: (p, v) => { writeJson(p, v); return log(p); },
    writeText: (p, t) => { writeText(p, t); return log(p); },
    appendLine: (p, v) => { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, `${JSON.stringify(v)}\n`); return log(p); },
    appendLines: (p, vs) => { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, vs.map((v) => `${JSON.stringify(v)}\n`).join('')); return log(p); },
    createExclusive: (p, t) => {
      mkdirSync(dirname(p), { recursive: true });
      if (existsSync(p)) return false;
      writeFileSync(p, t, { flag: 'wx' });
      log(p);
      return true;
    },
    move: (from, to) => { mkdirSync(dirname(to), { recursive: true }); renameSync(from, to); return log(to); },
    remove: (p) => { rmSync(p, { force: true }); },
  };
}

interface Harness {
  root: string;
  paths: RoundPaths;
  ctx: TaskContext;
  writes: string[];
  logs: string[];
  slept: number[];
  judge: Backend;
  done(): void;
}

function stub(id: string): Backend {
  return { id, family: 'Anthropic', model: id, call: () => Promise.reject(new Error(`unexpected call to ${id}`)) };
}

function harness(over: Partial<TaskContext> = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'forge-task-'));
  const paths = roundPaths(root, 'R01');
  const writes: string[] = [];
  const logs: string[] = [];
  const slept: number[] = [];
  let t = Date.parse('2026-09-25T00:00:00.000Z');
  const judge = stub('judge-xai');
  const ctx: TaskContext = {
    paths,
    files: testFiles(root, writes),
    backends: { judges: [{ backend: judge, concurrency: 2 }], maintainer: stub('maintainer'), mergeEditor: stub('merge-editor') },
    ports: { clock: { now: () => new Date(t).toISOString(), sleep: (ms) => { slept.push(ms); t += ms; return Promise.resolve(); } } },
    timeouts: { judgeMs: 111, writerMs: 222, maintainerMs: 333 },
    quota: { isQuota: isQuotaError, delaysMs: [60_000, 120_000], budgetMs: 300_000 },
    hooks: {},
    limiters: new Map(),
    redact: (text) => text.split(FIXTURE_GATEWAY_HOST).join(REDACTED),
    log: (m) => { logs.push(m); },
    progress: (step, status, detail) => {
      mkdirSync(dirname(paths.progress), { recursive: true });
      appendFileSync(paths.progress, `${JSON.stringify({ step, status, detail })}\n`);
    },
    ...over,
  };
  return { root, paths, ctx, writes, logs, slept, judge, done: () => rmSync(root, { recursive: true }) };
}

const mustSayOk = (t: string) => (t.startsWith('OK') ? ok(t.slice(2).trim()) : err<string>('output must start with OK'));

function spec(id: string, over: Partial<TaskSpec<string>> = {}): TaskSpec<string> {
  return { id, role: '测试角色', prompt: `请回答 ${id}`, parse: mustSayOk, ...over };
}

function router(routes: Record<string, Route>, id = 'gw-kimi'): ReturnType<typeof fakeRouter> {
  return fakeRouter(routes, { id, family: 'Moonshot', model: `model-${id}` });
}

test('fakeRouter routes by task-id kind, falls back to the role and reports unrouted calls', async () => {
  const counts: number[] = [];
  const r = router({
    write: (_p, n, meta) => { counts.push(n); return `OK ${meta.taskId}#${meta.attempt}`; },
    测试角色: () => 'OK by role',
  });
  const opts = (taskId: string, role = 'x'): CallOptions => ({ role, timeoutMs: 1, taskId, attempt: 1 });
  assert.equal((await r.call('p', opts('write-W1'))).text, 'OK write-W1#1');
  assert.equal((await r.call('p', opts('write-W2'))).text, 'OK write-W2#1');
  assert.equal((await r.call('p', opts('gate-W1-xAI-1', '测试角色'))).text, 'OK by role');
  const none = await r.call('p', opts('taste-W1-Moonshot-s1-fwd'));
  assert.equal(none.ok, false);
  assert.equal(none.error, 'no route: taste');
  assert.equal((await r.call('p', opts('constructor-x'))).error, 'no route: constructor', 'prototype keys are not routes');
  assert.deepEqual(counts, [1, 2]);
  assert.deepEqual(callLog(r), ['write-W1#1', 'write-W2#1', 'gate-W1-xAI-1#1', 'taste-W1-Moonshot-s1-fwd#1', 'constructor-x#1']);
  assert.equal(r.log()[0]?.family, 'Moonshot');
  await r.settled();
});

test('runTask writes a task record and later runs reuse it without a call', async () => {
  const h = harness();
  const b = router({ write: () => 'OK 一段文字', gate: () => 'nope' });
  const first = await runT(h.ctx, b, spec('write-W1'));
  assert.equal(first.value, '一段文字');
  const path = join(h.paths.tasks, 'write-W1.json');
  const rec = readTaskRecord(path);
  assert.ok(rec !== null && rec.ok);
  assert.equal(rec.value.status, 'ok');
  assert.equal(rec.value.backend, 'gw-kimi');
  assert.equal(rec.value.family, 'Moonshot');
  assert.equal(rec.value.prompt_sha256, sha256('请回答 write-W1'));
  assert.equal(rec.value.role_sha256, sha256('测试角色'));
  assert.equal(rec.value.text, 'OK 一段文字');
  assert.deepEqual(rec.value.calls, ['write-W1-a1']);
  assert.equal(rec.value.finished_at, '2026-09-25T00:00:00.000Z');
  const again = await runT(h.ctx, b, spec('write-W1'));
  assert.equal(again.value, '一段文字');
  assert.equal(again.attempts, 1);
  const voided = await runT(h.ctx, b, spec('gate-W1-xAI-1'));
  assert.equal(voided.value, null);
  assert.equal(voided.error, 'output must start with OK');
  const voidAgain = await runT(h.ctx, b, spec('gate-W1-xAI-1'));
  assert.equal(voidAgain.value, null, 'a void is final for its id');
  assert.equal(voidAgain.attempts, 2);
  assert.deepEqual(callLog(b), ['write-W1#1', 'gate-W1-xAI-1#1', 'gate-W1-xAI-1#2']);
  assert.equal(stepIsTaskContext.length, 1);
  h.done();
});

test('ok and void task records written by runTask validate against schema/task.schema.json', async () => {
  const h = harness();
  const schema = loadSchema(JSON.parse(readFileSync(new URL('../schema/task.schema.json', import.meta.url), 'utf8')));
  assert.ok(schema.ok);
  const b = router({ write: () => 'OK 一段文字', gate: () => 'nope' });
  await runT(h.ctx, b, spec('write-W1'));
  await runT(h.ctx, b, spec('gate-W1-xAI-1'));
  for (const id of ['write-W1', 'gate-W1-xAI-1']) {
    const raw: unknown = JSON.parse(readFileSync(join(h.paths.tasks, `${id}.json`), 'utf8'));
    assert.deepEqual(validate(schema.value, raw), [], id);
  }
  h.done();
});

test('a stored record whose prompt, role, backend or text differs is an IntegrityError', async () => {
  const h = harness();
  const b = router({ write: () => 'OK x' });
  await runT(h.ctx, b, spec('write-W1'));
  await assert.rejects(runT(h.ctx, b, spec('write-W1', { prompt: '改过的提示' })), (e: unknown) => e instanceof IntegrityError && /prompt_sha256/u.test(e.message));
  await assert.rejects(runT(h.ctx, b, spec('write-W1', { role: '另一个角色' })), (e: unknown) => e instanceof IntegrityError && /role_sha256/u.test(e.message));
  await assert.rejects(runT(h.ctx, router({ write: () => 'OK x' }, 'gw-other'), spec('write-W1')),
    (e: unknown) => e instanceof IntegrityError && /backend gw-kimi \(now gw-other\)/u.test(e.message) && e.message.includes('rounds/R01/tasks/write-W1.json'));
  // Same backend id, another model or family (writers.json edited before 02c pins it): never reused.
  const swapped = fakeRouter({ write: () => 'OK x' }, { id: 'gw-kimi', family: 'Moonshot', model: 'model-other' });
  await assert.rejects(runT(h.ctx, swapped, spec('write-W1')), (e: unknown) => e instanceof IntegrityError && /model model-gw-kimi \(now model-other\)/u.test(e.message));
  const refamilied = fakeRouter({ write: () => 'OK x' }, { id: 'gw-kimi', family: 'DeepSeek', model: 'model-gw-kimi' });
  await assert.rejects(runT(h.ctx, refamilied, spec('write-W1')), (e: unknown) => e instanceof IntegrityError && /family Moonshot \(now DeepSeek\)/u.test(e.message));
  const path = join(h.paths.tasks, 'write-W1.json');
  writeFileSync(path, readFileSync(path, 'utf8').replace('"OK x"', '"OK y"'));
  await assert.rejects(runT(h.ctx, b, spec('write-W1')), (e: unknown) => e instanceof IntegrityError && /text_sha256/u.test(e.message));
  writeFileSync(path, '{"id": "write-W1"');
  await assert.rejects(runT(h.ctx, b, spec('write-W1')), (e: unknown) => e instanceof IntegrityError && /malformed/u.test(e.message));
  assert.deepEqual(callLog(b), ['write-W1#1'], 'no call is ever made for a mismatching record');
  await assert.rejects(runT(h.ctx, b, spec('bad id')), /invalid task id/u);
  h.done();
});

test('readTaskRecord: absent → null, malformed → err', () => {
  const h = harness();
  assert.equal(readTaskRecord(join(h.paths.tasks, 'none.json')), null);
  mkdirSync(h.paths.tasks, { recursive: true });
  const path = join(h.paths.tasks, 'x.json');
  writeFileSync(path, 'not json');
  assert.equal(readTaskRecord(path)?.ok, false);
  writeFileSync(path, JSON.stringify({ id: 'x', backend: 'b', model: 'm', family: 'Nobody' }));
  const bad = readTaskRecord(path);
  assert.ok(bad !== null && !bad.ok);
  assert.match(bad.error, /family/u);
  h.done();
});

test('quota errors back off on the clock under -a<k>-q<n>, end in QuotaExhausted with no task record, and are never recovered', async () => {
  const h = harness();
  const b = router({ gate: () => ({ error: 'gateway HTTP 429' }) });
  await assert.rejects(runT(h.ctx, b, spec('gate-W1-xAI-1')), (e: unknown) => e instanceof QuotaExhausted && /gate-W1-xAI-1/u.test(e.message));
  assert.deepEqual(h.slept, [60_000, 120_000, 120_000], 'a fourth wait would pass the 300 s budget');
  assert.equal(existsSync(join(h.paths.tasks, 'gate-W1-xAI-1.json')), false, 'no task record');
  assert.deepEqual(readdirSync(h.paths.calls).sort(), ['gate-W1-xAI-1-a1-q1.json', 'gate-W1-xAI-1-a1-q2.json', 'gate-W1-xAI-1-a1-q3.json', 'gate-W1-xAI-1-a1-q4.json']);
  const progress = readFileSync(h.paths.progress, 'utf8');
  assert.match(progress, /gate-W1-xAI-1-a1-q1: quota, waiting 60 s/u);
  assert.match(progress, /quota budget exhausted/u);
  const healthy = router({ gate: () => 'OK 通过' });
  const r = await runT(h.ctx, healthy, spec('gate-W1-xAI-1'));
  assert.equal(r.value, '通过');
  assert.equal(r.attempts, 1, 'quota tries never count as attempts');
  assert.deepEqual(callLog(healthy), ['gate-W1-xAI-1#1'], 'the resumed task calls again on the same backend');
  assert.deepEqual(callLog(b), Array.from({ length: 4 }, () => 'gate-W1-xAI-1#1'));
  h.done();
});

test('.out.txt is written before the call JSON; a call whose output_sha256 mismatches is not recovered', async () => {
  const h = harness();
  const crash = { afterCall: (id: string) => { if (id === 'write-W1') throw new Error('killed after the call record'); } };
  const first = router({ write: () => 'OK 第一次' });
  await assert.rejects(runT({ ...h.ctx, hooks: crash }, first, spec('write-W1')), /killed/u);
  const out = h.writes.indexOf('.runs/R01/write-W1-a1.out.txt');
  const call = h.writes.indexOf('rounds/R01/calls/write-W1-a1.json');
  assert.ok(out !== -1 && call !== -1 && out < call, `${out} < ${call}`);
  assert.equal(existsSync(join(h.paths.tasks, 'write-W1.json')), false);
  writeFileSync(callOutputPath(h.paths, 'write-W1-a1'), 'OK 被改过');
  const second = router({ write: () => 'OK 第二次' });
  const r = await runT(h.ctx, second, spec('write-W1'));
  assert.equal(r.value, '第二次', 'the tampered call is not recovered');
  assert.deepEqual(callLog(second), ['write-W1#1']);
  const recovered = router({ write: () => 'OK 不该调用' });
  const reused = await runT({ ...h.ctx, hooks: crash }, recovered, spec('write-W1'));
  assert.equal(reused.value, '第二次', 'the task record exists: no call, so the crashing hook never fires');
  assert.deepEqual(callLog(recovered), []);
  h.done();
});

test('a recovered attempt-1 validation failure resumes at attempt 2 with retryPrompt, never a third call', async () => {
  const h = harness();
  const retryPrompt = (e: string): string => `上次输出无效（${e}），请重写。`;
  const killAt2 = { beforeCall: (_id: string, attempt: number) => { if (attempt === 2) throw new Error('killed before attempt 2'); } };
  const first = router({ write: () => '不合格' });
  await assert.rejects(runT({ ...h.ctx, hooks: killAt2 }, first, spec('write-W1', { retryPrompt })), /killed/u);
  assert.deepEqual(callLog(first), ['write-W1#1']);
  const second = router({ write: (_p, _n, meta) => (meta.attempt === 2 ? 'OK 重写' : '不该有第一次') });
  const r = await runT(h.ctx, second, spec('write-W1', { retryPrompt }));
  assert.equal(r.value, '重写');
  assert.equal(r.attempts, 2);
  assert.deepEqual(callLog(second), ['write-W1#2'], 'attempt 1 comes from its record');
  assert.equal(second.log()[0]?.prompt, '上次输出无效（output must start with OK），请重写。');
  const rec = readTaskRecord(join(h.paths.tasks, 'write-W1.json'));
  assert.ok(rec !== null && rec.ok);
  assert.deepEqual(rec.value.calls, ['write-W1-a1', 'write-W1-a2']);
  assert.equal(rec.value.prompt_sha256, sha256('请回答 write-W1'), 'only the first prompt is in the task record');

  const killAfter2 = { afterCall: (_id: string, attempt: number) => { if (attempt === 2) throw new Error('killed after attempt 2'); } };
  const bad = router({ write: () => '仍不合格' });
  await assert.rejects(runT({ ...h.ctx, hooks: killAfter2 }, bad, spec('write-W2', { retryPrompt })), /killed/u);
  const none = router({ write: () => 'OK 第三次' });
  const v = await runT(h.ctx, none, spec('write-W2', { retryPrompt }));
  assert.equal(v.value, null, 'decided from the recorded attempt 2');
  assert.deepEqual(callLog(none), [], 'never a third call');
  h.done();
});

function capturing(id: string, seen: CallOptions[], reply = 'OK'): Backend {
  return { id, family: 'xAI', model: id, call: (_p, o) => { seen.push(o); return Promise.resolve({ ok: true, text: reply, servedModel: id, version: null, ms: 1, tokensIn: 1, tokensOut: 1, costUsd: null, error: null, raw: '' }); } };
}

test('backend.call receives {taskId, attempt} and the timeout of the backend role; the backend limiter wraps the call', async () => {
  const seen: CallOptions[] = [];
  const judge = capturing('judge-xai', seen);
  const maintainer = capturing('maintainer', seen);
  let limited = 0;
  const h = harness({
    backends: { judges: [{ backend: judge, concurrency: 1 }], maintainer, mergeEditor: stub('merge-editor') },
    limiters: new Map([['judge-xai', <T>(fn: () => Promise<T>): Promise<T> => { limited += 1; return fn(); }]]),
  });
  await runT(h.ctx, judge, spec('gate-W1-xAI-1'));
  await runT(h.ctx, maintainer, spec('bench-propose-R01'));
  await runT(h.ctx, capturing('gw-deepseek', seen), spec('write-W1'));
  assert.deepEqual(seen.map((o) => [o.taskId, o.attempt, o.timeoutMs, o.role]), [
    ['gate-W1-xAI-1', 1, 111, '测试角色'], ['bench-propose-R01', 1, 333, '测试角色'], ['write-W1', 1, 222, '测试角色'],
  ]);
  assert.equal(limited, 1);
  assert.equal(timeoutFor(h.ctx, stub('merge-editor')), 333);
  h.done();
});

test('retryPrompt is used for attempt 2 only; without it the identical prompt is resent', async () => {
  const h = harness();
  const b = router({ decoy: (_p, n) => (n === 1 ? 'bad' : 'OK 好'), gate: (_p, n) => (n === 1 ? 'bad' : 'OK 好') });
  await runT(h.ctx, b, spec('decoy-DECOY', { retryPrompt: (e) => `重试：${e}` }));
  await runT(h.ctx, b, spec('gate-W1-xAI-1'));
  assert.deepEqual(b.log().map((c) => c.prompt), ['请回答 decoy-DECOY', '重试：output must start with OK', '请回答 gate-W1-xAI-1', '请回答 gate-W1-xAI-1']);
  h.done();
});

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name));
}

test('an adapter error holding the gateway host is stored redacted in calls/, tasks/ and progress.jsonl', async () => {
  const h = harness();
  const b = router({ write: () => ({ error: `gateway request failed: getaddrinfo ENOTFOUND ${FIXTURE_GATEWAY_HOST}` }) });
  const r = await runT(h.ctx, b, spec('write-W3'));
  assert.equal(r.value, null);
  assert.equal(r.error, `gateway request failed: getaddrinfo ENOTFOUND ${REDACTED}`);
  const files = [...filesUnder(h.paths.calls), ...filesUnder(h.paths.tasks), h.paths.progress];
  assert.equal(files.length, 4);
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    assert.equal(text.includes(FIXTURE_GATEWAY_HOST), false, f);
    assert.equal(text.includes(REDACTED), true, f);
  }
  h.done();
});

test('sealed tasks write only under .sealed/RNN/ and never under rounds/', async () => {
  const h = harness();
  const b = router({ forecast: () => 'OK 预测' });
  const r = await runS(h.ctx, b, spec('forecast-kimi'));
  assert.equal(r.value, '预测');
  assert.deepEqual(filesUnder(join(h.root, 'rounds')), []);
  assert.deepEqual(filesUnder(join(h.root, '.runs')), []);
  const sealed = filesUnder(h.paths.sealed).map((f) => relative(h.root, f)).sort();
  assert.deepEqual(sealed, [
    '.sealed/R01/calls/forecast-kimi-a1.json', '.sealed/R01/runs/forecast-kimi-a1.out.txt', '.sealed/R01/runs/forecast-kimi-a1.txt',
    '.sealed/R01/tasks/forecast-kimi.json',
  ]);
  assert.match(h.logs.join('\n'), /sealed task forecast-kimi: ok/u);
  const again = await runS(h.ctx, b, spec('forecast-kimi'));
  assert.equal(again.value, '预测');
  assert.deepEqual(callLog(b), ['forecast-kimi#1']);
  assert.equal(existsSync(callRecordPath(h.paths, 'forecast-kimi-a1')), false);
  h.done();
});

test('the run checkpoint runs before every backend call and quota wait, so an aborted run makes no further call', async () => {
  const h = harness();
  let aborted = false;
  let checks = 0;
  const control: TaskRunControl = { ...NO_RUN_CONTROL, checkpoint: () => { checks += 1; if (aborted) throw new Error('run aborted: a sibling job crashed'); } };
  const b = router({ write: () => { aborted = true; return 'bad'; }, gate: () => ({ error: 'HTTP 429' }) });
  await assert.rejects(runT(h.ctx, b, spec('write-W1'), control), /run aborted/u);
  assert.deepEqual(callLog(b), ['write-W1#1'], 'attempt 2 is never called after the abort');
  assert.equal(existsSync(callRecordPath(h.paths, 'write-W1-a1')), true, 'attempt 1 stays recoverable');
  aborted = false;
  checks = 0;
  const q = runT(h.ctx, b, spec('gate-W1-xAI-1'), { ...NO_RUN_CONTROL, checkpoint: () => { checks += 1; if (checks === 2) throw new Error('run aborted: during backoff'); } });
  await assert.rejects(q, /during backoff/u);
  assert.deepEqual(h.slept, [], 'no quota wait after the abort');
  h.done();
});

test('under --redo-from a mismatching task record moves to tasks/stale/<n>/ and the task is called afresh', async () => {
  const h = harness();
  const b = router({ write: (p) => `OK ${p}` });
  await runT(h.ctx, b, spec('write-W1'));
  const redo: TaskRunControl = { ...NO_RUN_CONTROL, redoStale: 2 };
  const same = await runT(h.ctx, b, spec('write-W1'), redo);
  assert.equal(same.value, '请回答 write-W1', 'a matching record is still reused');
  const changed = await runT(h.ctx, b, spec('write-W1', { prompt: '新的提示' }), redo);
  assert.equal(changed.value, '新的提示');
  assert.deepEqual(callLog(b), ['write-W1#1', 'write-W1#1']);
  const stale = readTaskRecord(join(h.paths.tasks, 'stale', '2', 'write-W1.json'));
  assert.ok(stale !== null && stale.ok);
  assert.equal(stale.value.prompt_sha256, sha256('请回答 write-W1'));
  const fresh = readTaskRecord(join(h.paths.tasks, 'write-W1.json'));
  assert.ok(fresh !== null && fresh.ok);
  assert.equal(fresh.value.prompt_sha256, sha256('新的提示'));
  assert.match(h.logs.join('\n'), /moved to rounds\/R01\/tasks\/stale\/2\/write-W1\.json with 3 call file\(s\)/u);
  assert.equal(existsSync(join(h.paths.calls, 'stale', '2', 'write-W1-a1.json')), true, 'the paid call stays as evidence');
  assert.equal(existsSync(join(h.paths.runs, 'stale', '2', 'write-W1-a1.out.txt')), true);
  const freshCall: unknown = JSON.parse(readFileSync(callRecordPath(h.paths, 'write-W1-a1'), 'utf8'));
  assert.equal(typeof freshCall === 'object' && freshCall !== null && 'prompt_sha256' in freshCall ? freshCall.prompt_sha256 : null, sha256('新的提示'));
  h.done();
});
