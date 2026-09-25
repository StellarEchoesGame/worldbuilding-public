import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeBackend } from './adapters/fake.ts';
import { costOf, parsePrices, roundCost, withPrices } from './cost.ts';
import { roundPaths } from './store.ts';

const PRICES = { currency: 'USD', note: 'n', per_million: { 'deepseek/deepseek-v4.1-flash': { input: 0.3, output: 1.2 } } };

test('parsePrices reads per-million input and output prices and rejects malformed entries', () => {
  const p = parsePrices(PRICES);
  assert.ok(p.ok, p.ok ? '' : p.error);
  assert.deepEqual(p.value['deepseek/deepseek-v4.1-flash'], { input: 0.3, output: 1.2 });
  assert.equal(parsePrices({ currency: 'USD', per_million: { m: { input: -1, output: 1 } } }).ok, false);
  assert.equal(parsePrices({ currency: 'USD', per_million: { m: { input: 1 } } }).ok, false);
  assert.equal(parsePrices({}).ok, false);
  const empty = parsePrices({ currency: 'USD', per_million: {} });
  assert.ok(empty.ok);
  assert.equal(parsePrices({ currency: 'CNY', per_million: {} }).ok, false, 'costs are summed as USD, so another currency is refused');
  assert.equal(parsePrices({ per_million: {} }).ok, false, 'the currency must be stated');
});

test('costOf multiplies tokens by the per-million price and is null without a price or tokens', () => {
  const p = parsePrices(PRICES);
  assert.ok(p.ok);
  assert.equal(costOf(p.value, 'deepseek/deepseek-v4.1-flash', 1_000_000, 500_000), 0.9);
  assert.equal(costOf(p.value, 'unknown/model', 10, 10), null);
  assert.equal(costOf(p.value, 'deepseek/deepseek-v4.1-flash', null, 10), null);
});

test('withPrices fills a missing cost from tokens and keeps a cost the backend reported', async () => {
  const p = parsePrices({ currency: 'USD', per_million: { 'fake-w': { input: 1, output: 2 }, 'fake-c': { input: 1, output: 1 } } });
  assert.ok(p.ok);
  const w = fakeBackend('w', 'DeepSeek', () => 'x'.repeat(10));
  w.model = 'fake-w';
  const r = await withPrices(w, p.value).call('abcd', { role: 'r', timeoutMs: 1, taskId: 't', attempt: 1 });
  assert.equal(r.costUsd, (4 * 1 + 10 * 2) / 1_000_000);
  const reported = withPrices({ ...fakeBackend('c', 'Anthropic', () => 'ok'), model: 'fake-c', call: (prompt) => fakeBackend('c', 'Anthropic', () => 'ok').call(prompt, { role: 'r', timeoutMs: 1, taskId: 't', attempt: 1 }).then((x) => ({ ...x, costUsd: 0.5 })) }, p.value);
  assert.equal((await reported.call('p', { role: 'r', timeoutMs: 1, taskId: 't', attempt: 1 })).costUsd, 0.5);
});

test('roundCost sums tokens and cost per backend and counts unpriced calls', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-cost-'));
  const paths = roundPaths(root, 'P01');
  mkdirSync(paths.calls, { recursive: true });
  const call = (label: string, backend: string, tin: number | null, tout: number | null, cost: number | null): void =>
    writeFileSync(join(paths.calls, `${label}.json`), JSON.stringify({ label, backend, family: 'X', tokens_in: tin, tokens_out: tout, cost_usd: cost }));
  call('a', 'W1', 100, 50, 0.01);
  call('b', 'W1', 200, 20, 0.02);
  call('c', 'codex', null, null, null);
  call('d', 'claude', 10, 5, 0.5);
  const c = roundCost(paths);
  assert.deepEqual(c.by_backend['W1'], { attempts: 2, tokens_in: 300, tokens_out: 70, cost_usd: 0.03, unpriced_calls: 0 });
  assert.deepEqual(c.by_backend['codex'], { attempts: 1, tokens_in: 0, tokens_out: 0, cost_usd: 0, unpriced_calls: 1 });
  assert.equal(c.total_usd, 0.53);
  assert.equal(c.unpriced_calls, 1);
  rmSync(root, { recursive: true });
});

test('roundCost skips quota retries, which never count as attempts or unpriced calls', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-cost-'));
  const paths = roundPaths(root, 'R01');
  mkdirSync(paths.calls, { recursive: true });
  writeFileSync(join(paths.calls, 'w-a1-q1.json'), JSON.stringify({ label: 'w-a1-q1', backend: 'W1', tokens_in: null, tokens_out: null, cost_usd: null, quota: true }));
  writeFileSync(join(paths.calls, 'w-a1.json'), JSON.stringify({ label: 'w-a1', backend: 'W1', tokens_in: 10, tokens_out: 5, cost_usd: 0.01, quota: false }));
  const c = roundCost(paths);
  assert.deepEqual(c.by_backend['W1'], { attempts: 1, tokens_in: 10, tokens_out: 5, cost_usd: 0.01, unpriced_calls: 0 });
  assert.equal(c.unpriced_calls, 0);
  rmSync(root, { recursive: true });
});
