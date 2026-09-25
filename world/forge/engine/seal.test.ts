import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJson, newNonce, seal, verifySeal } from './seal.ts';

function fixedNonce(): Buffer {
  return Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7 + 1));
}

test('canonicalJson sorts keys recursively and emits no whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, 2], c: true } }), '{"a":{"c":true,"d":[1,2]},"b":1}\n');
});

test('canonicalJson orders keys by UTF-16 code units, not code points', () => {
  // U+1F600 is stored as the surrogate pair D83D DE00, which sorts before U+FF01
  assert.equal(canonicalJson({ '！': 1, '😀': 2, a: 3, B: 4 }), '{"B":4,"a":3,"😀":2,"！":1}\n');
});

test('canonicalJson NFC-normalises keys and values', () => {
  const decomposed = canonicalJson({ 'é': ['é', { 'café': 'x' }] });
  const composed = canonicalJson({ 'é': ['é', { 'café': 'x' }] });
  assert.equal(decomposed, composed);
  assert.equal(composed, '{"é":["é",{"café":"x"}]}\n');
});

test('canonicalJson keeps nested array order and ends with a single LF', () => {
  const text = canonicalJson([3, 1, [2, 0], null, 'z', false]);
  assert.equal(text, '[3,1,[2,0],null,"z",false]\n');
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'));
  assert.equal(canonicalJson('x'), '"x"\n');
});

test('canonicalJson formats numbers like JSON.stringify', () => {
  assert.equal(canonicalJson([0.1, 1e21, -0, 42, -3.5]), `[0.1,${JSON.stringify(1e21)},0,42,-3.5]\n`);
});

test('canonicalJson throws TypeError on non-JSON values', () => {
  assert.throws(() => canonicalJson(undefined), TypeError);
  assert.throws(() => canonicalJson({ a: undefined }), TypeError);
  assert.throws(() => canonicalJson([1, undefined]), TypeError);
  assert.throws(() => canonicalJson(Number.NaN), TypeError);
  assert.throws(() => canonicalJson({ a: Number.POSITIVE_INFINITY }), TypeError);
  assert.throws(() => canonicalJson(() => 1), TypeError);
  assert.throws(() => canonicalJson(Symbol('s')), TypeError);
  assert.throws(() => canonicalJson(10n), TypeError);
  assert.throws(() => canonicalJson(new Date(0)), TypeError);
  assert.throws(() => canonicalJson(new Map()), TypeError);
});

test('canonicalJson rejects cycles and keys that collide after NFC', () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), TypeError);
  assert.throws(() => canonicalJson({ 'é': 1, 'é': 2 }), TypeError);
});

test('canonicalJson accepts a shared (non-cyclic) reference twice', () => {
  const shared = { k: 1 };
  assert.equal(canonicalJson({ a: shared, b: [shared] }), '{"a":{"k":1},"b":[{"k":1}]}\n');
});

test('seal probe equals an independently computed hash of nonce bytes then canonical bytes', () => {
  const nonce = fixedNonce();
  const value = { winner: 'B', scores: [3, 1], note: 'café' };
  const sealed = seal(value, nonce);
  const expectedCanonical = '{"note":"café","scores":[3,1],"winner":"B"}\n';
  assert.equal(sealed.canonical, expectedCanonical);
  assert.equal(sealed.nonceHex, nonce.toString('hex'));
  const expectedProbe = createHash('sha256')
    .update(Buffer.concat([nonce, Buffer.from(expectedCanonical, 'utf8')]))
    .digest('hex');
  assert.equal(sealed.probe, expectedProbe);
  assert.match(sealed.probe, /^[0-9a-f]{64}$/u);
});

test('verifySeal accepts the original and rejects a one-byte change of canonical or nonce', () => {
  const sealed = seal({ a: 1, b: 'x' }, fixedNonce());
  assert.equal(verifySeal(sealed.canonical, sealed.nonceHex, sealed.probe), true);
  const changedCanonical = sealed.canonical.replace('"x"', '"y"');
  assert.notEqual(changedCanonical, sealed.canonical);
  assert.equal(verifySeal(changedCanonical, sealed.nonceHex, sealed.probe), false);
  const lastNibble = sealed.nonceHex.slice(-1) === '0' ? '1' : '0';
  const changedNonce = `${sealed.nonceHex.slice(0, -1)}${lastNibble}`;
  assert.equal(verifySeal(sealed.canonical, changedNonce, sealed.probe), false);
  assert.equal(verifySeal(sealed.canonical.trimEnd(), sealed.nonceHex, sealed.probe), false);
});

test('verifySeal returns false on malformed hex instead of throwing', () => {
  const sealed = seal([1], fixedNonce());
  assert.equal(verifySeal(sealed.canonical, sealed.nonceHex.slice(0, -2), sealed.probe), false);
  assert.equal(verifySeal(sealed.canonical, `${sealed.nonceHex.slice(0, -1)}g`, sealed.probe), false);
  assert.equal(verifySeal(sealed.canonical, `${sealed.nonceHex}0`, sealed.probe), false);
  assert.equal(verifySeal(sealed.canonical, sealed.nonceHex.toUpperCase(), sealed.probe), false);
  assert.equal(verifySeal(sealed.canonical, sealed.nonceHex, sealed.probe.slice(1)), false);
  assert.equal(verifySeal(sealed.canonical, sealed.nonceHex, sealed.probe.toUpperCase()), false);
  assert.equal(verifySeal(sealed.canonical, '', ''), false);
});

test('seal requires a nonce of exactly 32 bytes', () => {
  assert.throws(() => seal({}, Buffer.alloc(31)), RangeError);
  assert.throws(() => seal({}, Buffer.alloc(33)), RangeError);
  assert.doesNotThrow(() => seal({}, Buffer.alloc(32)));
});

test('seal propagates canonicalJson TypeError for non-JSON values', () => {
  assert.throws(() => seal({ a: Number.NaN }, fixedNonce()), TypeError);
});

test('newNonce returns 32 fresh random bytes', () => {
  const a = newNonce();
  const b = newNonce();
  assert.equal(a.length, 32);
  assert.equal(b.length, 32);
  assert.equal(a.equals(b), false);
});
