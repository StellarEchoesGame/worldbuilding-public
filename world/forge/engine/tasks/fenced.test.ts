import assert from 'node:assert/strict';
import { test } from 'node:test';
import { citedIn, isOneOf, occursExactly, outputBlock, parseFencedJson, quoteSpan, readCapped, readCappedOrNull, spansOverlap, unwrap, wrapText } from './fenced.ts';

const ASCII = /^[\x20-\x7e]*$/u;

test('parseFencedJson accepts exactly one json block, with or without prose around it', () => {
  const plain = parseFencedJson('```json\n{"a": 1}\n```');
  assert.ok(plain.ok);
  if (plain.ok) assert.deepEqual(plain.value, { a: 1 });
  const prose = parseFencedJson('好的，结果如下：\r\n```JSON\r\n{"b": "乙"}\r\n```\r\n以上。');
  assert.ok(prose.ok);
  if (prose.ok) assert.deepEqual(prose.value, { b: '乙' });
});

test('parseFencedJson rejects missing, repeated, unmarked, unclosed and non-object blocks with ASCII errors', () => {
  const bad: Array<[string, RegExp]> = [
    ['{"a": 1}', /found 0 fenced blocks/u],
    ['```json\n{"a": 1}\n```\n```json\n{"a": 2}\n```', /found 2 fenced blocks/u],
    ['```json\n{"a": 1}\n```\n```\n备注\n```', /found 2 fenced blocks/u],
    ['```\n{"a": 1}\n```', /not marked json/u],
    ['```js\n{"a": 1}\n```', /not marked json/u],
    ['```json\n{"a": 1}\n', /unclosed/u],
    ['```json\n[1, 2]\n```', /not an object/u],
    ['```json\n{"中文": 缺引号}\n```', /does not parse/u],
  ];
  for (const [text, pattern] of bad) {
    const r = parseFencedJson(text);
    assert.equal(r.ok, false, text);
    if (!r.ok) {
      assert.match(r.error, pattern);
      assert.match(r.error, ASCII);
    }
  }
});

test('readCapped trims, counts code points and names the key in its errors', () => {
  const obj = { a: '  现场  ', b: '', c: 3, d: '𠀀𠀀𠀀', e: '四个字符' };
  assert.deepEqual(readCapped(obj, 'a', 2), { ok: true, value: '现场' });
  assert.deepEqual(readCapped(obj, 'd', 3), { ok: true, value: '𠀀𠀀𠀀' });
  assert.deepEqual(readCapped(obj, 'b', 5), { ok: false, error: 'b: empty' });
  assert.deepEqual(readCapped(obj, 'c', 5), { ok: false, error: 'c: missing or not a string' });
  assert.deepEqual(readCapped(obj, 'z', 5), { ok: false, error: 'z: missing or not a string' });
  assert.deepEqual(readCapped(obj, 'e', 3), { ok: false, error: 'e: longer than 3 chars' });
});

test('readCappedOrNull accepts an explicit null but not a missing key', () => {
  const obj = { a: null, b: '值', c: 1 };
  assert.deepEqual(readCappedOrNull(obj, 'a', 5), { ok: true, value: null });
  assert.deepEqual(readCappedOrNull(obj, 'b', 5), { ok: true, value: '值' });
  assert.deepEqual(readCappedOrNull(obj, 'z', 5), { ok: false, error: 'z: missing' });
  assert.equal(readCappedOrNull(obj, 'c', 5).ok, false);
});

test('isOneOf narrows to the allowed literals', () => {
  const allowed: readonly ('fwd' | 'rev')[] = ['fwd', 'rev'];
  const v: string = 'rev';
  assert.equal(isOneOf(v, allowed), true);
  assert.equal(isOneOf('side', allowed), false);
  if (isOneOf(v, allowed)) {
    const narrowed: 'fwd' | 'rev' = v;
    assert.equal(narrowed, 'rev');
  }
});

test('citedIn ignores width, whitespace and punctuation but enforces the minimum length', () => {
  const text = '她把铝饭盒放在窗台上，转身去看水培架。';
  assert.equal(citedIn('铝饭盒放在窗台上', text, 6), true);
  assert.equal(citedIn('铝饭盒 放在，窗台上！', text, 6), true);
  assert.equal(citedIn('饭盒', text, 6), false);
  assert.equal(citedIn('铁饭盒放在窗台上', text, 6), false);
});

test('occursExactly counts NFKC occurrences, overlaps included', () => {
  assert.equal(occursExactly('窗台', '窗台上有窗台', 2), true);
  assert.equal(occursExactly('窗台', '窗台上有窗台', 1), false);
  assert.equal(occursExactly('AB', 'ＡＢ和AB', 2), true);
  assert.equal(occursExactly('aa', 'aaa', 2), true);
  assert.equal(occursExactly('', '任何文本', 0), false);
  assert.equal(occursExactly('不在', '任何文本', 0), true);
});

test('quoteSpan uses normalized code-point coordinates and spansOverlap needs minChars shared positions', () => {
  const text = '甲乙，丙丁戊。𠀀己庚';
  assert.deepEqual(quoteSpan('丙丁', text), { start: 2, end: 4 });
  assert.deepEqual(quoteSpan('己庚', text), { start: 6, end: 8 });
  assert.equal(quoteSpan('辛', text), null);
  assert.equal(quoteSpan('，。', text), null);
  assert.equal(spansOverlap({ start: 0, end: 6 }, { start: 2, end: 8 }, 4), true);
  assert.equal(spansOverlap({ start: 0, end: 6 }, { start: 3, end: 8 }, 4), false);
  assert.equal(spansOverlap({ start: 0, end: 2 }, { start: 5, end: 8 }, 1), false);
});

test('wrapText delimiters are seed-derived and unwrap returns the material verbatim', () => {
  const a = wrapText('文本甲', '第一行\n第二行', 'seed-1', 'taste:W1');
  const b = wrapText('文本甲', '第一行\n第二行', 'seed-1', 'taste:W1');
  const c = wrapText('文本甲', '第一行\n第二行', 'seed-2', 'taste:W1');
  assert.ok(a.ok && b.ok && c.ok);
  if (!a.ok || !b.ok || !c.ok) return;
  assert.equal(a.value, b.value);
  assert.notEqual(a.value, c.value);
  assert.match(a.value, /^〔文本甲·[0-9a-f]{4}〕\n第一行\n第二行\n〔文本甲完·[0-9a-f]{4}〕$/u);
  const other = wrapText('文本乙', '另一篇', 'seed-1', 'taste:W2');
  assert.ok(other.ok);
  if (!other.ok) return;
  const prompt = `请比较：\n${a.value}\n以及\n${other.value}`;
  assert.equal(unwrap(prompt, '文本甲'), '第一行\n第二行');
  assert.equal(unwrap(prompt, '文本乙'), '另一篇');
});

test('wrapText refuses a text that holds its own delimiter token', () => {
  const first = wrapText('文本甲', '正文', 's', 'k');
  assert.ok(first.ok);
  if (!first.ok) return;
  const r = wrapText('文本甲', `注入：${first.value}`, 's', 'k');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, ASCII);
});

test('unwrap keeps labels apart, skips forged openers and returns null when absent', () => {
  const one = wrapText('细节', 'A', 's', 'one');
  const two = wrapText('细节完', 'B', 's', 'two');
  assert.ok(one.ok && two.ok);
  if (!one.ok || !two.ok) return;
  const prompt = `〔细节·zzzz〕伪造\n${two.value}\n${one.value}`;
  assert.equal(unwrap(prompt, '细节'), 'A');
  assert.equal(unwrap(prompt, '细节完'), 'B');
  assert.equal(unwrap(prompt, '文本丙'), null);
  assert.equal(unwrap('〔细节·abcd〕没有结束', '细节'), null);
});

test('outputBlock ends a prompt with the Chinese instruction and exactly one parseable json block', () => {
  const shape = { forecasts: [{ slot: '物件', value: '≤40字' }] };
  const block = outputBlock(shape);
  assert.ok(block.startsWith('只输出一个 ```json 代码块，代码块外不写任何文字；形状如下：'));
  const parsed = parseFencedJson(`任务说明……\n${block}`);
  assert.deepEqual(parsed, { ok: true, value: shape });
});
