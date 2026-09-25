import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateMark, readGate, type GateCheckView } from './data.ts';

test('gate checks carry their flags, defaulting to none', () => {
  const g = readGate({
    pass: true,
    checks: [
      { name: 'length', ok: true, detail: '10 / 2500 字' },
      { name: 'forbidden_words', ok: true, detail: '否定句待复核：…', flags: ['这里没有配给站。', 3, '远航号没有穿过星门。'] },
      { name: 'markup', ok: false, detail: '含链接', flags: 'not a list' },
    ],
  });
  assert.equal(g.pass, true);
  assert.deepEqual(g.checks, [
    { name: 'length', ok: true, detail: '10 / 2500 字', flags: [] },
    { name: 'forbidden_words', ok: true, detail: '否定句待复核：…', flags: ['这里没有配给站。', '远航号没有穿过星门。'] },
    { name: 'markup', ok: false, detail: '含链接', flags: [] },
  ]);
});

test('a missing gate record reads as not passed with no checks', () => {
  assert.deepEqual(readGate(null), { pass: false, checks: [] });
});

test('a gate check shows ✔ when ok, ⚠ when ok with flags, ✖ when not ok', () => {
  const check = (ok: boolean, flags: string[]): GateCheckView => ({ name: 'forbidden_words', ok, detail: '', flags });
  assert.equal(gateMark(check(true, [])), '✔');
  assert.equal(gateMark(check(true, ['这里没有配给站。'])), '⚠');
  assert.equal(gateMark(check(false, [])), '✖');
  assert.equal(gateMark(check(false, ['这里没有配给站。'])), '✖');
});
