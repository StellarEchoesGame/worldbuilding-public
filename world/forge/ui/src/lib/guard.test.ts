import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guard } from './guard.ts';

const base = { method: 'GET', cookieToken: 'tok', expectedToken: 'tok', origin: null, requestOrigin: 'http://127.0.0.1:4391' };

test('a matching cookie passes a GET', () => {
  assert.deepEqual(guard(base), { ok: true });
});

test('a missing or wrong cookie is 401', () => {
  assert.equal(guard({ ...base, cookieToken: null }).ok, false);
  const r = guard({ ...base, cookieToken: 'nope' });
  assert.ok(!r.ok && r.status === 401);
});

test('a server started without a token refuses everything', () => {
  const r = guard({ ...base, expectedToken: null });
  assert.ok(!r.ok && r.status === 403);
});

test('a POST needs a same-origin Origin header', () => {
  assert.deepEqual(guard({ ...base, method: 'POST', origin: 'http://127.0.0.1:4391' }), { ok: true });
  const cross = guard({ ...base, method: 'POST', origin: 'http://evil.example' });
  assert.ok(!cross.ok && cross.status === 403);
  const missing = guard({ ...base, method: 'POST', origin: null });
  assert.ok(!missing.ok && missing.status === 403);
});
