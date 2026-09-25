import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWriterOutput } from './writer-output.ts';

const good = [
  '```submission',
  '# 灯下',
  '温芮把旧水壶放回架上。',
  '```',
  '```delta',
  '{"new_proper_nouns":["水壶巷"],"claims":[{"id":"A-01","kind":"author_fact","claim":"邻里共用一把旧水壶","status":"状态与路径实例","row_id":"SHIP","attaches_to":"04","extends":"F07","misuse":"不是配给制度","source_quote":"温芮把旧水壶放回架上","register":true}]}',
  '```',
  '```interface',
  '{"shots":[{},{},{}],"object":{"name":"旧水壶"},"hook":{"trigger":"x"}}',
  '```',
  '种子：',
  '- 一',
  '- 二',
  '- 三',
].join('\n');

test('parses the three blocks and seeds', () => {
  const r = parseWriterOutput(good);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.match(r.value.submission, /温芮/);
  assert.deepEqual(r.value.delta.newProperNouns, ['水壶巷']);
  assert.equal(r.value.delta.claims[0]?.register, true);
  assert.equal(r.value.delta.claims[0]?.sourceQuote, '温芮把旧水壶放回架上');
  assert.deepEqual(r.value.seeds, ['一', '二', '三']);
  assert.equal(r.value.iface.shots.length, 3);
});

test('reports a missing block by name', () => {
  const r = parseWriterOutput(good.replace('```interface', '```other'));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /interface/);
});

test('reports invalid delta JSON', () => {
  const r = parseWriterOutput(good.replace('{"new_proper_nouns"', '{new_proper_nouns'));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /delta/);
});

test('accepts a submission containing an inner fenced block marker line', () => {
  const r = parseWriterOutput(good.replace('温芮把旧水壶放回架上。', '温芮把旧水壶放回架上。\n~~~\n注\n~~~'));
  assert.equal(r.ok, true);
});
