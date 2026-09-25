import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_NEGATION_EXCEPTIONS, DEFAULT_NEGATIONS } from './gate.ts';
import { benchContext, effectiveBar, findBenchmark, loadProtocolBundle, parseRollbacks, roundRules } from './rules.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('the committed protocol bundle parses and hashes', () => {
  const r = loadProtocolBundle(ROOT);
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.equal(r.value.protocol.version, '1.1');
  assert.match(r.value.bundleSha256, /^[0-9a-f]{64}$/u);
});

test('a byte change in families.json changes the bundle hash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-rules-'));
  for (const f of ['PROTOCOL.md', 'families.json', 'judges.json']) writeFileSync(join(dir, f), readFileSync(join(ROOT, f)));
  const before = loadProtocolBundle(dir);
  writeFileSync(join(dir, 'families.json'), `${readFileSync(join(ROOT, 'families.json'), 'utf8')}\n`);
  const after = loadProtocolBundle(dir);
  assert.ok(before.ok && after.ok);
  assert.notEqual(before.value.bundleSha256, after.value.bundleSha256);
  rmSync(dir, { recursive: true });
});

test('a missing or broken protocol file is an error, not a throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-rules-'));
  const missing = loadProtocolBundle(dir);
  assert.equal(missing.ok, false);
  for (const f of ['families.json', 'judges.json']) writeFileSync(join(dir, f), '{}');
  writeFileSync(join(dir, 'PROTOCOL.md'), '# no blocks\n');
  const broken = loadProtocolBundle(dir);
  assert.equal(broken.ok, false);
  assert.match(broken.ok ? '' : broken.error, /protocol/u);
  rmSync(dir, { recursive: true });
});

test('the effective bar is the stricter of protocol and benchmark', () => {
  assert.equal(effectiveBar(7, { bars: { beats_champion_four_families: 7 } }), 7);
  assert.equal(effectiveBar(7, { bars: { beats_champion_four_families: 8 } }), 8);
  assert.equal(effectiveBar(8, { bars: { beats_champion_four_families: 7 } }), 8);
  assert.equal(effectiveBar(7, {}), 7);
});

test('round rules carry the protocol limits, forbidden words and negations', () => {
  const r = loadProtocolBundle(ROOT);
  assert.ok(r.ok);
  const rules = roundRules(r.value.protocol, {});
  assert.equal(rules.limits.maxChars, 2500);
  assert.ok(rules.forbidden.some((w) => w.term === '星门'));
  assert.ok(!rules.forbidden.some((w) => w.term === '归航号'));
  assert.ok(rules.negations.includes('没有'));
  assert.ok(rules.negationExceptions.includes('不久'));
  assert.equal(rules.barFourFamilies, 7);
});

test('the bench context takes activation, protected keys and hold from the protocol', () => {
  const r = loadProtocolBundle(ROOT);
  assert.ok(r.ok);
  const ctx = benchContext(ROOT, r.value.protocol, 4, []);
  assert.ok(ctx.ok, ctx.ok ? '' : ctx.error);
  assert.equal(ctx.value.activation['taste'], 'replay');
  assert.equal(ctx.value.activation['decoy_recipe'], 'owner');
  assert.ok(ctx.value.protectedKeys.includes('fact_status'));
  assert.equal(ctx.value.holdRounds, 3);
  assert.equal(ctx.value.currentRound, 4);
});

test('findBenchmark locates a benchmark file by its version field', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-rules-'));
  mkdirSync(join(dir, 'benchmark'));
  writeFileSync(join(dir, 'benchmark', 'v0.json'), JSON.stringify({ version: 'v0.1-prototype', parent: null }));
  writeFileSync(join(dir, 'benchmark', 'v1.json'), JSON.stringify({ version: 'v1', parent: null }));
  writeFileSync(join(dir, 'benchmark', 'log.jsonl'), '{}\n');
  const found = findBenchmark(dir, 'v0.1-prototype');
  assert.ok(found.ok, found.ok ? '' : found.error);
  assert.equal(found.value.path, join(dir, 'benchmark', 'v0.json'));
  const missing = findBenchmark(dir, 'v9');
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? '' : missing.error, /no benchmark with version v9/u);
  rmSync(dir, { recursive: true });
});

test('findBenchmark reports two files claiming the same version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-rules-'));
  mkdirSync(join(dir, 'benchmark'));
  writeFileSync(join(dir, 'benchmark', 'a.json'), JSON.stringify({ version: 'v1' }));
  writeFileSync(join(dir, 'benchmark', 'b.json'), JSON.stringify({ version: 'v1' }));
  assert.match(((r) => (r.ok ? '' : r.error))(findBenchmark(dir, 'v1')), /more than one benchmark/u);
  rmSync(dir, { recursive: true });
});

test('the gate defaults equal the protocol negation blocks, so tests and rounds judge alike', () => {
  const r = loadProtocolBundle(ROOT);
  assert.ok(r.ok);
  assert.deepEqual(r.value.protocol.negations, [...DEFAULT_NEGATIONS]);
  assert.deepEqual(r.value.protocol.negationExceptions, [...DEFAULT_NEGATION_EXCEPTIONS]);
});

test('parseRollbacks reads round numbers and rolled-back keys, and rejects malformed entries', () => {
  const r = parseRollbacks([{ round: 3, rolled_back_keys: ['taste', 'bars'] }]);
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.deepEqual(r.value, [{ round: 3, rolledBackKeys: ['taste', 'bars'] }]);
  assert.equal(parseRollbacks({}).ok, false);
  assert.equal(parseRollbacks([{ round: 1.5, rolled_back_keys: [] }]).ok, false);
  assert.equal(parseRollbacks([{ round: 2 }]).ok, false);
});
