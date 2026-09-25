import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeBackend } from './adapters/fake.ts';
import { failure, isQuotaError, type Backend, type CallOptions, type CallResult } from './adapters/types.ts';
import {
  callOutputPath, callRecordPath, callWithRetry, limiter, QuotaExhausted, recordCall, recoverCall, type CallWriter,
} from './calls.ts';
import { readString } from './json.ts';
import { err, ok } from './result.ts';
import { readJson, roundPaths, writeJson, writeText, type RoundPaths } from './store.ts';

test('a backend that throws is retried once and then reported as a failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-calls-'));
  let calls = 0;
  const backend: Backend = { id: 'x', family: 'OpenAI', model: 'm', call: () => { calls += 1; return Promise.reject(new Error('boom')); } };
  const r = await callWithRetry(roundPaths(root, 'P01'), backend, 'lbl', 'prompt', 'role', 1000, (t) => ok(t));
  assert.equal(r.value, null);
  assert.equal(r.attempts, 2);
  assert.equal(calls, 2);
  assert.match(r.error ?? '', /boom/);
  rmSync(root, { recursive: true });
});

test('limiter never runs more than n tasks at once', async () => {
  const limit = limiter(2);
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 6 }, () => limit(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
  })));
  assert.equal(peak, 2);
});

const HOST = 'fixture-gateway.invalid';
const redactHost = (text: string): string => text.split(HOST).join('[redacted:gateway-host]');

function result(over: Partial<CallResult>): CallResult {
  return { ok: true, text: 'OK', servedModel: 'm', version: null, ms: 1, tokensIn: 1, tokensOut: 1, costUsd: null, error: null, raw: 'raw', ...over };
}

function tempPaths(): { root: string; paths: RoundPaths } {
  const root = mkdtempSync(join(tmpdir(), 'forge-calls-'));
  return { root, paths: roundPaths(root, 'R01') };
}

/** A CallWriter that logs each write as `<kind> <basename>` before delegating to the store writers. */
function spyWriter(order: string[]): CallWriter {
  return {
    writeJson: (path: string, value: unknown) => { order.push(`json ${path.split('/').at(-1) ?? ''}`); writeJson(path, value); },
    writeText: (path: string, text: string) => { order.push(`text ${path.split('/').at(-1) ?? ''}`); writeText(path, text); },
  };
}

function scripted(replies: ReadonlyArray<string | { error: string }>): Backend & { seen: CallOptions[]; prompts: string[] } {
  const seen: CallOptions[] = [];
  const prompts: string[] = [];
  let n = 0;
  const inner = fakeBackend('b', 'Moonshot', (prompt, opts) => {
    seen.push(opts);
    prompts.push(prompt);
    const r = replies[Math.min(n, replies.length - 1)] ?? { error: 'no reply' };
    n += 1;
    return r;
  });
  return { ...inner, seen, prompts };
}

test('isQuotaError classifies 429, rate-limit, quota and usage-limit failures only', () => {
  for (const e of ['gateway HTTP 429', 'gateway error: Rate limit reached for requests', 'gateway error: You exceeded your current quota', 'exit 1: insufficient_quota',
    'exit 1: Claude AI usage limit reached', 'Too Many Requests', 'status code: 429', 'RESOURCE_EXHAUSTED', 'rate_limit_exceeded']) {
    assert.equal(isQuotaError(failure(e, 1, '', null)), true, e);
  }
  for (const e of ['timeout after 4290 ms', 'empty output', 'served model x is not in accepted_served', `gateway request failed: getaddrinfo ${HOST}`, 'exit 1: line 429 bad']) {
    assert.equal(isQuotaError(failure(e, 1, '', null)), false, e);
  }
  assert.equal(isQuotaError(result({ text: 'the quota was 429' })), false, 'a successful call is never a quota error');
});

test('recordCall writes .out.txt before the call JSON and recoverCall checks output_sha256', () => {
  const { root, paths } = tempPaths();
  const order: string[] = [];
  const backend = fakeBackend('b', 'xAI', () => 'x');
  recordCall(paths, 't-a1', backend, 'p', result({ text: '好的 OK' }), { files: spyWriter(order), startedAt: '2026-09-25T00:00:00.000Z', at: '2026-09-25T00:00:01.000Z' });
  assert.deepEqual(order, ['text t-a1.out.txt', 'text t-a1.txt', 'json t-a1.json']);
  const rec = readJson(callRecordPath(paths, 't-a1'));
  assert.equal(readString(rec, 'started_at'), '2026-09-25T00:00:00.000Z');
  assert.equal(readString(rec, 'at'), '2026-09-25T00:00:01.000Z');
  assert.equal(recoverCall(paths, 't-a1')?.text, '好的 OK');
  assert.equal(recoverCall(paths, 't-a2'), null, 'absent');
  writeFileSync(callOutputPath(paths, 't-a1'), '好的 OK!');
  assert.equal(recoverCall(paths, 't-a1'), null, 'a tampered .out.txt is not recovered');
  rmSync(callOutputPath(paths, 't-a1'));
  assert.equal(recoverCall(paths, 't-a1'), null, 'a missing .out.txt (fresh clone) is not recovered');
  recordCall(paths, 't-a1-q1', backend, 'p', failure('HTTP 429', 1, '', null), { quota: true });
  assert.equal(recoverCall(paths, 't-a1-q1'), null, 'quota tries are never recovered');
  rmSync(root, { recursive: true });
});

const mustSayOk = (t: string) => (t.startsWith('OK') ? ok(t) : err<string>('output must start with OK'));

test('callWithRetry passes {taskId, attempt} and uses retryPrompt for attempt 2 after a validation failure only', async () => {
  const { root, paths } = tempPaths();
  const b = scripted(['bad', 'OK fixed']);
  const r = await callWithRetry(paths, b, 'write-W1', 'first', 'role', 1000, mustSayOk, { retryPrompt: (e) => `retry: ${e}` });
  assert.equal(r.value, 'OK fixed');
  assert.deepEqual(b.seen.map((o) => [o.taskId, o.attempt]), [['write-W1', 1], ['write-W1', 2]]);
  assert.deepEqual(b.prompts, ['first', 'retry: output must start with OK']);
  assert.equal(readString(readJson(callRecordPath(paths, 'write-W1-a2')), 'prompt_sha256')?.length, 64);
  const failed = scripted([{ error: 'empty output' }, 'OK']);
  await callWithRetry(paths, failed, 'write-W2', 'first', 'role', 1000, mustSayOk, { retryPrompt: (e) => `retry: ${e}` });
  assert.deepEqual(failed.prompts, ['first', 'first'], 'a call failure (not a validation failure) retries the identical prompt');
  rmSync(root, { recursive: true });
});

test('quota tries back off under -a<k>-q<n>, are not counted, and end in QuotaExhausted once the budget is spent', async () => {
  const { root, paths } = tempPaths();
  const slept: number[] = [];
  const policy = { isQuota: isQuotaError, delaysMs: [10, 20], budgetMs: 45 };
  const sleep = (ms: number) => { slept.push(ms); return Promise.resolve(); };
  const recovers = scripted([{ error: 'HTTP 429' }, { error: 'HTTP 429' }, 'OK']);
  const r = await callWithRetry(paths, recovers, 'gate-W1-xAI-1', 'p', 'role', 1000, mustSayOk, { quota: policy, sleep });
  assert.equal(r.value, 'OK');
  assert.equal(r.attempts, 1, 'quota tries are never attempts');
  assert.deepEqual(slept, [10, 20]);
  assert.deepEqual(recovers.seen.map((o) => o.attempt), [1, 1, 1]);
  assert.deepEqual(readdirSync(paths.calls).filter((n) => n.startsWith('gate-W1')).sort(), ['gate-W1-xAI-1-a1-q1.json', 'gate-W1-xAI-1-a1-q2.json', 'gate-W1-xAI-1-a1.json']);
  slept.length = 0;
  const stuck = scripted([{ error: `gateway error: rate limit on ${HOST}` }]);
  await assert.rejects(
    callWithRetry(paths, stuck, 'gate-W2-xAI-1', 'p', 'role', 1000, mustSayOk, { quota: policy, sleep, redact: redactHost }),
    (e: unknown) => e instanceof QuotaExhausted && !e.message.includes(HOST) && e.message.includes('[redacted:gateway-host]'),
  );
  assert.deepEqual(slept, [10, 20], 'a third wait of 20 ms would exceed the 45 ms budget');
  assert.equal(existsSync(callRecordPath(paths, 'gate-W2-xAI-1-a1')), false, 'no counted attempt');
  assert.equal(existsSync(callRecordPath(paths, 'gate-W2-xAI-1-a1-q3')), true);
  const again = scripted([{ error: 'HTTP 429' }, 'OK']);
  await callWithRetry(paths, again, 'gate-W2-xAI-1', 'p', 'role', 1000, mustSayOk, { quota: policy, sleep });
  assert.equal(existsSync(callRecordPath(paths, 'gate-W2-xAI-1-a1-q4')), true, 'a resumed task numbers its quota tries after the earlier ones');
  assert.equal(readJson(callRecordPath(paths, 'gate-W2-xAI-1-a1-q4')) !== null, true);
  rmSync(root, { recursive: true });
});

test('without a quota policy a quota error counts as an ordinary failed attempt (prototype behaviour)', async () => {
  const { root, paths } = tempPaths();
  const b = scripted([{ error: 'HTTP 429' }, 'OK']);
  const r = await callWithRetry(paths, b, 't', 'p', 'role', 1000, mustSayOk);
  assert.equal(r.attempts, 2);
  assert.equal(r.value, 'OK');
  rmSync(root, { recursive: true });
});

test('hooks fire beforeCall → call → record → afterCall → validate; a throwing hook is a crash; recovered attempts fire none', async () => {
  const { root, paths } = tempPaths();
  const events: string[] = [];
  const backend: Backend = {
    id: 'b', family: 'xAI', model: 'm',
    call: (_p, o) => { events.push(`call ${o.attempt} recorded=${existsSync(callRecordPath(paths, `${o.taskId}-a${o.attempt}`))}`); return Promise.resolve(result({ text: o.attempt === 1 ? 'bad' : 'OK' })); },
  };
  const hooks = {
    beforeCall: (id: string, a: number) => { events.push(`before ${id} ${a}`); },
    afterCall: (id: string, a: number) => { events.push(`after ${id} ${a} recorded=${existsSync(callRecordPath(paths, `${id}-a${a}`))}`); },
  };
  const validate = (t: string) => { events.push(`validate ${t}`); return mustSayOk(t); };
  const r = await callWithRetry(paths, backend, 't', 'p', 'role', 1000, validate, { hooks });
  assert.equal(r.value, 'OK');
  assert.deepEqual(events, [
    'before t 1', 'call 1 recorded=false', 'after t 1 recorded=true', 'validate bad',
    'before t 2', 'call 2 recorded=false', 'after t 2 recorded=true', 'validate OK',
  ]);
  events.length = 0;
  const crash = { beforeCall: (_id: string, a: number) => { if (a === 2) throw new Error('killed'); } };
  await assert.rejects(callWithRetry(paths, backend, 'u', 'p', 'role', 1000, mustSayOk, { hooks: crash }), /killed/u);
  assert.equal(existsSync(callRecordPath(paths, 'u-a1')), true);
  assert.equal(existsSync(callRecordPath(paths, 'u-a2')), false);
  events.length = 0;
  const again = await callWithRetry(paths, backend, 'u', 'p', 'role', 1000, validate, {
    hooks, recover: (a) => recoverCall(paths, `u-a${a}`),
  });
  assert.equal(again.value, 'OK');
  assert.deepEqual(events, ['validate bad', 'before u 2', 'call 2 recorded=false', 'after u 2 recorded=true', 'validate OK'],
    'attempt 1 is recovered without hooks or a call; attempt 2 is called once');
  rmSync(root, { recursive: true });
});

test('errors are redacted before they reach calls/ and the returned result; records carry the injected clock', async () => {
  const { root, paths } = tempPaths();
  const b = scripted([{ error: `gateway request failed: getaddrinfo ENOTFOUND ${HOST}` }]);
  let t = 0;
  const now = () => new Date(Date.UTC(2026, 8, 25, 0, 0, t++)).toISOString();
  const r = await callWithRetry(paths, b, 't', 'p', 'role', 1000, mustSayOk, { redact: redactHost, now });
  assert.equal(r.error, 'gateway request failed: getaddrinfo ENOTFOUND [redacted:gateway-host]');
  assert.equal(r.last?.error, r.error);
  for (const name of readdirSync(paths.calls)) assert.equal(readFileSync(join(paths.calls, name), 'utf8').includes(HOST), false, name);
  const a1 = readJson(callRecordPath(paths, 't-a1'));
  assert.equal(readString(a1, 'started_at'), '2026-09-25T00:00:00.000Z');
  assert.equal(readString(a1, 'at'), '2026-09-25T00:00:01.000Z');
  rmSync(root, { recursive: true });
});
