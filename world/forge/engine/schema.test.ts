import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema, validate, type Schema } from './schema.ts';

const person: Schema = {
  type: 'object',
  required: ['name', 'age'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 5 },
    age: { type: 'integer', minimum: 0 },
    role: { type: 'string', enum: ['a', 'b'] },
    tags: { type: 'array', items: { type: 'string', pattern: '^[a-z]+$' }, maxItems: 2 },
    ref: { type: ['string', 'null'] },
  },
};

test('a valid value has no errors', () => {
  assert.deepEqual(validate(person, { name: '温芮', age: 3, role: 'a', tags: ['x'], ref: null }), []);
});

test('errors carry JSON paths', () => {
  const errors = validate(person, { name: '', age: 1.5, role: 'c', tags: ['X', 'y', 'z'], extra: 1 });
  assert.deepEqual(errors.sort(), [
    '$: unexpected property extra',
    '$.age: expected integer',
    '$.name: shorter than 1',
    '$.role: not one of a, b',
    '$.tags: more than 2 items',
    '$.tags[0]: does not match ^[a-z]+$',
  ].sort());
});

test('missing required properties and wrong root type are reported', () => {
  assert.deepEqual(validate(person, { name: 'x' }), ['$: missing age']);
  assert.deepEqual(validate(person, []), ['$: expected object']);
});

test('lengths count code points, not UTF-16 units', () => {
  assert.deepEqual(validate({ type: 'string', maxLength: 1 }, '𠀀'), []);
});

test('loadSchema rejects keywords the validator does not implement', () => {
  const r = loadSchema({ type: 'object', oneOf: [] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /oneOf/);
  assert.equal(loadSchema(person).ok, true);
});
