import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Backend } from './adapters/types.ts';
import { callWithRetry, limiter } from './calls.ts';
import { ok } from './result.ts';
import { roundPaths } from './store.ts';

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
