import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Backend } from './adapters/types.ts';
import { isRecord, readNumber, readRecord, readString } from './json.ts';
import { err, ok, type Result } from './result.ts';
import { readJson, type RoundPaths } from './store.ts';

/** USD per million tokens, keyed by requested model id (prices.json `per_million`). */
export type Prices = Record<string, { input: number; output: number }>;

export function parsePrices(value: unknown): Result<Prices> {
  if (readString(value, 'currency') !== 'USD') return err('prices.json: currency must be "USD"');
  const table = readRecord(value, 'per_million');
  if (table === null) return err('prices.json: per_million must be an object');
  const out: Prices = {};
  for (const [model, entry] of Object.entries(table)) {
    const input = readNumber(entry, 'input');
    const output = readNumber(entry, 'output');
    if (input === null || output === null || !(input >= 0) || !(output >= 0)) return err(`prices.json: ${model} needs input and output prices >= 0`);
    out[model] = { input, output };
  }
  return ok(out);
}

export function costOf(prices: Prices, model: string, tokensIn: number | null, tokensOut: number | null): number | null {
  const price = prices[model];
  if (price === undefined || tokensIn === null || tokensOut === null) return null;
  return (tokensIn * price.input + tokensOut * price.output) / 1_000_000;
}

/** Fills a missing cost from reported tokens and prices.json; a cost the CLI reported itself (Claude, Grok) is kept. */
export function withPrices(backend: Backend, prices: Prices): Backend {
  return {
    ...backend,
    call: async (prompt, opts) => {
      const r = await backend.call(prompt, opts);
      return r.costUsd !== null ? r : { ...r, costUsd: costOf(prices, backend.model, r.tokensIn, r.tokensOut) };
    },
  };
}

export interface BackendCost {
  /** Call records, retries included. */
  attempts: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  unpriced_calls: number;
}

export interface RoundCost {
  total_usd: number;
  unpriced_calls: number;
  by_backend: Record<string, BackendCost>;
}

const round10 = (x: number): number => Math.round(x * 1e10) / 1e10;

/** Sums the round's call records (calls/*.json, one per attempt) per backend; records without a cost count as unpriced. */
export function roundCost(paths: RoundPaths): RoundCost {
  let names: string[] = [];
  try {
    names = readdirSync(paths.calls).filter((n) => n.endsWith('.json')).sort();
  } catch {
    names = [];
  }
  const by: Record<string, BackendCost> = {};
  for (const name of names) {
    const rec = readJson(join(paths.calls, name));
    if (!isRecord(rec)) continue;
    const backend = readString(rec, 'backend') ?? 'unknown';
    const entry = by[backend] ?? { attempts: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, unpriced_calls: 0 };
    const cost = readNumber(rec, 'cost_usd');
    entry.attempts += 1;
    entry.tokens_in += readNumber(rec, 'tokens_in') ?? 0;
    entry.tokens_out += readNumber(rec, 'tokens_out') ?? 0;
    if (cost === null) entry.unpriced_calls += 1;
    else entry.cost_usd = round10(entry.cost_usd + cost);
    by[backend] = entry;
  }
  const all = Object.values(by);
  return {
    total_usd: round10(all.reduce((s, b) => s + b.cost_usd, 0)),
    unpriced_calls: all.reduce((s, b) => s + b.unpriced_calls, 0),
    by_backend: by,
  };
}
