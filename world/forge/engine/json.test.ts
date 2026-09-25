import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonObject, isRecord, readArray, readNumber, readString } from './json.ts';

test('isRecord rejects arrays and null', () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
});

test('readers return typed values or null', () => {
  const o: unknown = { a: 'x', b: 2, c: [1] };
  assert.equal(readString(o, 'a'), 'x');
  assert.equal(readString(o, 'b'), null);
  assert.equal(readNumber(o, 'b'), 2);
  assert.deepEqual(readArray(o, 'c'), [1]);
  assert.equal(readArray(o, 'a'), null);
});

test('extractJsonObject finds a bare, fenced or prose-wrapped object', () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJsonObject('结果如下：\n```json\n{"a":{"b":"}"}}\n```\n完'), { a: { b: '}' } });
  assert.equal(extractJsonObject('没有 JSON'), null);
});
