import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callWithRetry } from '../calls.ts';
import { ok } from '../result.ts';
import { roundPaths } from '../store.ts';
import { fakeBackend } from './fake.ts';
import { checkServed } from './served.ts';
import type { Backend, CallResult } from './types.ts';

/** The judge adapter applies checkServed to every call; this wraps the fake adapter the same way. */
function withServedCheck(backend: Backend, accepted: readonly string[]): Backend {
  return { ...backend, call: async (prompt, opts) => checkServed(await backend.call(prompt, opts), accepted) };
}

function result(over: Partial<CallResult>): CallResult {
  return { ok: true, text: 'OK', servedModel: 'm-1', version: 'v', ms: 1, tokensIn: 1, tokensOut: 1, costUsd: null, error: null, raw: '', ...over };
}

test('checkServed passes an accepted served model and any model when the list is empty', () => {
  assert.equal(checkServed(result({}), ['m-1']).ok, true);
  assert.equal(checkServed(result({ servedModel: 'other' }), []).ok, true);
  assert.equal(checkServed(result({ servedModel: null }), []).ok, true);
});

test('checkServed voids a served model outside the list, or a missing one when a list exists', () => {
  const wrong = checkServed(result({ servedModel: 'm-2' }), ['m-1']);
  assert.equal(wrong.ok, false);
  assert.match(wrong.error ?? '', /served model m-2 is not in accepted_served/u);
  assert.equal(wrong.servedModel, 'm-2', 'the served model stays recorded for provenance');
  const missing = checkServed(result({ servedModel: null }), ['m-1']);
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? '', /served model not reported/u);
  assert.equal(checkServed(result({ ok: false, error: 'boom', servedModel: 'm-2' }), ['m-1']).error, 'boom', 'an earlier failure is kept');
});

test('a served-model mismatch on the fake adapter is retried once and then voids the call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-served-'));
  const paths = roundPaths(root, 'P01');
  const fake = fakeBackend('j', 'xAI', () => 'OK');
  const r = await callWithRetry(paths, withServedCheck(fake, ['grok-4.7']), 'lbl', 'p', 'role', 1000, (t) => ok(t));
  assert.equal(r.value, null);
  assert.equal(r.attempts, 2);
  assert.equal(fake.calls.length, 2);
  assert.match(r.error ?? '', /served model fake-j is not in accepted_served/u);
  const records = readdirSync(paths.calls).sort().map((f) => JSON.parse(readFileSync(join(paths.calls, f), 'utf8')));
  assert.deepEqual(records.map((x) => [x.ok, x.served_model]), [[false, 'fake-j'], [false, 'fake-j']]);
  rmSync(root, { recursive: true });
});

test('a failure followed by a success on the fake adapter is one retry, not a void', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-served-'));
  let n = 0;
  const fake = fakeBackend('j', 'xAI', () => (++n === 1 ? { error: 'rate limited' } : 'OK'));
  const r = await callWithRetry(roundPaths(root, 'P01'), withServedCheck(fake, ['fake-j']), 'lbl', 'p', 'role', 1000, (t) => ok(t));
  assert.equal(r.value, 'OK');
  assert.equal(r.attempts, 2);
  rmSync(root, { recursive: true });
});

test('two failed attempts on the fake adapter void the call with the last error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-served-'));
  const fake = fakeBackend('j', 'xAI', () => '');
  const r = await callWithRetry(roundPaths(root, 'P01'), fake, 'lbl', 'p', 'role', 1000, (t) => ok(t));
  assert.equal(r.value, null);
  assert.equal(r.attempts, 2);
  assert.equal(r.error, 'empty output');
  rmSync(root, { recursive: true });
});
