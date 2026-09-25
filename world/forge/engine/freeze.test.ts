import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildFreeze, diffFreeze, parseFreeze, type FreezeInput } from './freeze.ts';
import { isRecord, type JsonRecord } from './json.ts';
import { loadSchema, validate, type Schema } from './schema.ts';

const utf8Hex = (text: string): string => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const bundle = utf8Hex('bundle');

function jsonCopy(value: unknown): JsonRecord {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  if (!isRecord(parsed)) throw new Error('expected a JSON object');
  return parsed;
}

function input(over: Partial<FreezeInput>): FreezeInput {
  return {
    round: 'R01',
    files: {
      'BOOK.md': '# 书\n温芮把旧水壶放回架上。\n',
      'REFERENCE.md': '参考\n',
      'brief.json': '{"row":"SHIP"}\n',
      champion: '冠军稿。\n',
      benchmark: '{"version":"v1"}\n',
      'writers.json': '{"slots":[]}\n',
      'skill:metabolic-cultures': 'skill body\n',
    },
    benchmarkVersion: 'v1',
    eligibleFamilies: ['Anthropic', 'DeepSeek', 'OpenAI', 'Moonshot'],
    flags: { Anthropic: 'ok', DeepSeek: 'flagged', xAI: 'suspended' },
    protocolBundleSha256: bundle,
    probeCreatedAt: null,
    ...over,
  };
}

function freezeSchema(): Schema {
  const raw: unknown = JSON.parse(readFileSync(new URL('../schema/freeze.schema.json', import.meta.url), 'utf8'));
  const loaded = loadSchema(raw);
  if (!loaded.ok) throw new Error(loaded.error);
  return loaded.value;
}

test('buildFreeze hashes the UTF-8 bytes of every file and copies the metadata', () => {
  const src = input({ probeCreatedAt: '2026-09-25T08:00:00.000Z' });
  const record = buildFreeze(src);
  assert.equal(record.round, 'R01');
  assert.equal(record.benchmark_version, 'v1');
  assert.deepEqual(record.eligible_families, ['Anthropic', 'DeepSeek', 'OpenAI', 'Moonshot']);
  assert.deepEqual(record.flags, { Anthropic: 'ok', DeepSeek: 'flagged', xAI: 'suspended' });
  assert.equal(record.protocol_bundle_sha256, bundle);
  assert.equal(record.probe_created_at, '2026-09-25T08:00:00.000Z');
  assert.deepEqual(Object.keys(record.sha256).sort(), Object.keys(src.files).sort());
  for (const [name, content] of Object.entries(src.files)) assert.equal(record.sha256[name], utf8Hex(content));
});

test('the record does not alias the input arrays and objects', () => {
  const src = input({});
  const record = buildFreeze(src);
  src.eligibleFamilies.push('xAI');
  src.flags['Moonshot'] = 'suspended';
  assert.deepEqual(record.eligible_families, ['Anthropic', 'DeepSeek', 'OpenAI', 'Moonshot']);
  assert.equal(record.flags['Moonshot'], undefined);
});

test('buildFreeze is independent of the order the files are given in', () => {
  const src = input({});
  const reversed = Object.fromEntries(Object.entries(src.files).reverse());
  assert.equal(JSON.stringify(buildFreeze(input({ files: reversed }))), JSON.stringify(buildFreeze(src)));
});

test('a built record validates against schema/freeze.schema.json', () => {
  const schema = freezeSchema();
  assert.deepEqual(validate(schema, buildFreeze(input({}))), []);
  assert.deepEqual(validate(schema, buildFreeze(input({ probeCreatedAt: '2026-09-25T08:00:00.000Z' }))), []);
});

test('the schema rejects malformed records', () => {
  const schema = freezeSchema();
  const good = jsonCopy(buildFreeze(input({})));
  const errorsFor = (patch: Record<string, unknown>): string[] => validate(schema, { ...good, ...patch });
  assert.ok(errorsFor({ round: 'round-1' }).some((e) => e.startsWith('$.round:')));
  assert.ok(errorsFor({ protocol_bundle_sha256: 'ABC' }).some((e) => e.startsWith('$.protocol_bundle_sha256:')));
  assert.ok(errorsFor({ sha256: { benchmark: 'nothex' } }).some((e) => e.startsWith('$.sha256.benchmark:')));
  assert.ok(errorsFor({ benchmark_version: '1' }).some((e) => e.startsWith('$.benchmark_version:')));
  assert.ok(errorsFor({ eligible_families: [''] }).some((e) => e.startsWith('$.eligible_families[0]:')));
  assert.ok(errorsFor({ probe_created_at: 3 }).some((e) => e.startsWith('$.probe_created_at:')));
  assert.ok(errorsFor({ extra: true }).includes('$: unexpected property extra'));
  const withoutFlags = { ...good };
  delete withoutFlags['flags'];
  assert.ok(validate(schema, withoutFlags).includes('$: missing flags'));
});

test('round trip: a record rebuilt from the same files has no differences, also after JSON serialisation', () => {
  const pinned = buildFreeze(input({}));
  assert.deepEqual(diffFreeze(pinned, buildFreeze(input({}))), []);
  const parsed = parseFreeze(jsonCopy(pinned));
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.value, pinned);
    assert.deepEqual(diffFreeze(parsed.value, buildFreeze(input({}))), []);
  }
});

test('a benchmark content change shows up in diffFreeze', () => {
  const src = input({});
  const pinned = buildFreeze(src);
  const current = buildFreeze(input({ files: { ...src.files, benchmark: '{"version":"v1","bars":{}}\n' } }));
  assert.deepEqual(diffFreeze(pinned, current), ['frozen file changed: benchmark']);
});

test('diffFreeze lists changed, missing and extra names in name order', () => {
  const src = input({});
  const pinned = buildFreeze(src);
  const rest = { ...src.files };
  delete rest['skill:metabolic-cultures'];
  const current = buildFreeze(input({ files: { ...rest, 'BOOK.md': 'changed\n', 'skill:systemic-worldbuilding': 'new\n' } }));
  assert.deepEqual(diffFreeze(pinned, current), [
    'frozen file changed: BOOK.md',
    'frozen file missing: skill:metabolic-cultures',
    'file not in freeze: skill:systemic-worldbuilding',
  ]);
});

test('diffFreeze reports a changed protocol bundle and a changed benchmark version after the file changes', () => {
  const src = input({});
  const pinned = buildFreeze(src);
  const current = buildFreeze(input({ files: { ...src.files, 'BOOK.md': 'changed\n' }, benchmarkVersion: 'v2', protocolBundleSha256: utf8Hex('other bundle') }));
  assert.deepEqual(diffFreeze(pinned, current), ['frozen file changed: BOOK.md', 'protocol bundle changed', 'benchmark version changed: v1 → v2']);
  assert.deepEqual(diffFreeze(pinned, buildFreeze(input({ protocolBundleSha256: utf8Hex('other bundle') }))), ['protocol bundle changed']);
  assert.deepEqual(diffFreeze(pinned, buildFreeze(input({ benchmarkVersion: 'v1.1' }))), ['benchmark version changed: v1 → v1.1']);
});

test('diffFreeze does not treat flags or eligible families as drift, since resume reuses the frozen values', () => {
  const pinned = buildFreeze(input({}));
  const current = buildFreeze(input({ flags: { Anthropic: 'suspended' }, eligibleFamilies: ['OpenAI'], probeCreatedAt: '2026-09-25T08:00:00.000Z' }));
  assert.deepEqual(diffFreeze(pinned, current), []);
});

test('parseFreeze rejects values that are not freeze records', () => {
  const good = jsonCopy(buildFreeze(input({})));
  const bad: Array<[unknown, RegExp]> = [
    [null, /object/u],
    [{ ...good, round: 3 }, /round/u],
    [{ ...good, sha256: { benchmark: 'zz' } }, /sha256\.benchmark/u],
    [{ ...good, sha256: [] }, /sha256/u],
    [{ ...good, flags: { Anthropic: 'maybe' } }, /flags\.Anthropic/u],
    [{ ...good, eligible_families: ['a', 1] }, /eligible_families/u],
    [{ ...good, protocol_bundle_sha256: 'x' }, /protocol_bundle_sha256/u],
    [{ ...good, probe_created_at: 5 }, /probe_created_at/u],
    [{ ...good, benchmark_version: null }, /benchmark_version/u],
  ];
  for (const [value, pattern] of bad) {
    const r = parseFreeze(value);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, pattern);
  }
});
