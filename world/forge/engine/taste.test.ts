import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBenchmark, parseVerdict, tastePrompt, type Benchmark } from './taste.ts';

const bench: Benchmark = {
  version: 'v0', decisive: 'q1', minQuoteChars: 8, role: '评委', instructions: '只输出 JSON',
  questions: [{ id: 'q1', text: '更想待在哪一篇？' }, { id: 'q2', text: '更记得住哪个人？' }],
};
const t1 = '温芮把旧水壶放回架上，炉子还热着。';
const t2 = '林澈在走廊尽头停下，听见循环泵换了节拍。';

test('parseBenchmark reads the committed v0 shape', () => {
  const r = parseBenchmark({ version: 'v0', decisive: 'q1', minQuoteChars: 8, role: 'r', instructions: 'i', questions: [{ id: 'q1', text: 't' }] });
  assert.equal(r.ok, true);
  assert.equal(parseBenchmark({ version: 'v0', decisive: 'q9', role: 'r', instructions: 'i', questions: [{ id: 'q1', text: 't' }] }).ok, false);
});

test('tastePrompt shows both texts with numbered labels and the questions', () => {
  const p = tastePrompt(bench, t1, t2);
  assert.ok(p.indexOf('【第 1 篇】') < p.indexOf(t1));
  assert.ok(p.indexOf(t1) < p.indexOf('【第 2 篇】'));
  assert.ok(p.includes('更想待在哪一篇？'));
  assert.ok(p.includes('"q1"'));
});

test('parseVerdict accepts fenced JSON and checks quotes against the picked text', () => {
  const r = parseVerdict('```json\n{"q1":{"pick":2,"quote":"听见循环泵换了节拍"},"q2":{"pick":1,"quote":"温芮把旧水壶放回架上"}}\n```', bench, t1, t2);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value.picks, { q1: 2, q2: 1 });
});

test('parseVerdict rejects a quote taken from the other text', () => {
  const r = parseVerdict('{"q1":{"pick":1,"quote":"听见循环泵换了节拍"},"q2":{"pick":1,"quote":"温芮把旧水壶放回架上"}}', bench, t1, t2);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /q1/);
});

test('parseVerdict rejects a missing question or a pick outside 1 and 2', () => {
  assert.equal(parseVerdict('{"q1":{"pick":1,"quote":"温芮把旧水壶放回架上"}}', bench, t1, t2).ok, false);
  assert.equal(parseVerdict('{"q1":{"pick":3,"quote":"温芮把旧水壶放回架上"},"q2":{"pick":1,"quote":"温芮把旧水壶放回架上"}}', bench, t1, t2).ok, false);
  assert.equal(parseVerdict('无法判断', bench, t1, t2).ok, false);
});
