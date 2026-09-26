import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSchema, validate } from '../../../engine/schema.ts';
import { world } from '../../../engine/testing/round-script.ts';
import { parseGameNeed } from '../../../engine/thinmap.ts';
import { writeGameNeed } from './game-need.ts';

function fresh(): string {
  const root = world().w.root;
  rmSync(join(root, 'map', 'game-need.json'), { force: true });
  return root;
}

test('writeGameNeed: writes {weights} once, schema-valid and parseGameNeed-valid', () => {
  const root = fresh();
  const r = writeGameNeed(root, { SHIP: 3, 'S1-冷湾': 0.5 });
  assert.deepEqual(r, { ok: true, file: join(root, 'map', 'game-need.json') });
  const value: unknown = JSON.parse(readFileSync(join(root, 'map', 'game-need.json'), 'utf8'));
  assert.deepEqual(value, { weights: { SHIP: 3, 'S1-冷湾': 0.5 } });
  const schema = loadSchema(JSON.parse(readFileSync(join(root, 'schema', 'game-need.schema.json'), 'utf8')));
  assert.ok(schema.ok);
  assert.deepEqual(validate(schema.value, value), []);
  assert.ok(parseGameNeed(value).ok);
});

test('writeGameNeed: 409 once the file exists (never overwrites)', () => {
  const root = fresh();
  writeFileSync(join(root, 'map', 'game-need.json'), '{"weights":{"SHIP":1}}\n');
  const r = writeGameNeed(root, { SHIP: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.ok ? 0 : r.status, 409);
  assert.equal(readFileSync(join(root, 'map', 'game-need.json'), 'utf8'), '{"weights":{"SHIP":1}}\n');
});

test('writeGameNeed: 400 for an unknown row, a negative or non-finite weight, or no weights; nothing written', () => {
  const root = fresh();
  for (const weights of [{ NOPE: 1 }, { SHIP: -1 }, { SHIP: Number.NaN }, { SHIP: Number.POSITIVE_INFINITY }, {}, { constructor: 1 }]) {
    const r = writeGameNeed(root, weights);
    assert.equal(r.ok ? 0 : r.status, 400, JSON.stringify(weights));
    assert.equal(existsSync(join(root, 'map', 'game-need.json')), false);
  }
});

test('writeGameNeed: 409 when map/rows.json cannot be read', () => {
  const root = fresh();
  rmSync(join(root, 'map', 'rows.json'));
  const r = writeGameNeed(root, { SHIP: 1 });
  assert.equal(r.ok ? 0 : r.status, 409);
  assert.equal(existsSync(join(root, 'map', 'game-need.json')), false);
});
