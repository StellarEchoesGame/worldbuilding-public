import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArray, readString, stringArray, isRecord } from './json.ts';
import { loadProtocolBundle } from './rules.ts';
import { loadSchema, validate } from './schema.ts';
import { parseRows } from './thinmap.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '..', '..');
const json = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

test('fact-status.json validates and covers F01–F15 with verbatim 07 cells and known rows', () => {
  const schema = loadSchema(json('schema/fact-status.schema.json'));
  assert.ok(schema.ok, schema.ok ? '' : schema.error);
  const status = json('fact-status.json');
  assert.deepEqual(validate(schema.value, status), []);
  const rows = parseRows(json('map/rows.json'));
  assert.ok(rows.ok);
  const rowIds = new Set(['ALL', ...rows.value.map((r) => r.row_id)]);
  const register = readFileSync(join(REPO, 'world/current/reference/07-register-and-creation.md'), 'utf8');
  const facts = readArray(status, 'facts') ?? [];
  assert.deepEqual(facts.map((f) => readString(f, 'id')), Array.from({ length: 15 }, (_, i) => `F${String(i + 1).padStart(2, '0')}`));
  for (const f of facts) {
    const id = readString(f, 'id') ?? '?';
    assert.ok(register.includes(`| ${id} | ${readString(f, 'fact') ?? ''} |`), `${id} fact is not verbatim in 07`);
    for (const row of (isRecord(f) ? stringArray(f['rows']) : null) ?? []) assert.ok(rowIds.has(row), `${id} names unknown row ${row}`);
  }
});

test('every forbidden word in PROTOCOL.md protects a sentence that is verbatim in the named canon file', () => {
  const bundle = loadProtocolBundle(ROOT);
  assert.ok(bundle.ok, bundle.ok ? '' : bundle.error);
  for (const { term, protects } of bundle.value.protocol.forbidden) {
    const m = /^(world\/current\/[^:]+):\d+ 「(.+?)」(?: \((.+)\))?$/u.exec(protects);
    assert.ok(m !== null, `${term}: protects must look like "world/current/<file>:<line> 「<quote>」 (<optional note>)"`);
    const [, file, quote, note] = m;
    assert.ok(file !== undefined && quote !== undefined);
    const text = readFileSync(join(REPO, file), 'utf8');
    assert.ok(text.includes(quote), `${term}: quote not found in ${file}`);
    const misuse = note === undefined ? undefined : /「(.+)」/u.exec(note)?.[1];
    if (misuse !== undefined) assert.ok(text.includes(misuse), `${term}: noted misuse ${misuse} not found in ${file}`);
  }
});

test('the fixture Rxx extends a sentence that is verbatim in canon, and its reversal is not', () => {
  const bundle = loadProtocolBundle(ROOT);
  assert.ok(bundle.ok);
  const { fixtureRxx } = bundle.value.protocol;
  const ecology = readFileSync(join(REPO, 'world/current/reference/05-ecology-and-everyday.md'), 'utf8');
  assert.ok(ecology.includes(fixtureRxx.extends));
  assert.ok(!ecology.includes(fixtureRxx.reversal));
});
