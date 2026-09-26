import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopbackOnly } from '../../../engine/loopback.ts';
import { serverRefusal } from './bind.ts';

test('loopback hosts: 127.0.0.0/8, ::1 and localhost, with brackets and ports', () => {
  for (const h of ['127.0.0.1', '127.0.0.1:4391', '127.255.3.9', 'localhost', 'LOCALHOST:80', '::1', '[::1]', '[::1]:4391', 'localhost.']) {
    assert.equal(loopbackOnly(h), true, h);
  }
});

test('non-loopback hosts are refused', () => {
  for (const h of ['0.0.0.0', '192.168.1.5', '10.0.0.1:4391', '::', '[::]', '[::ffff:127.0.0.1]', 'example.com', 'localhost.example.com', '127.0.0.1.nip.io', '128.0.0.1', '127.0.0.256', '127.1', '', ' ', '127.0.0.1:abc', '127.0.0.1:', '::1:4391']) {
    assert.equal(loopbackOnly(h), false, JSON.stringify(h));
  }
});

const fine = { bindHost: undefined, requestHost: '127.0.0.1:4391', markers: [], realData: true };

test('serverRefusal: null on loopback without markers', () => {
  assert.equal(serverRefusal(fine), null);
  assert.equal(serverRefusal({ ...fine, bindHost: '127.0.0.1' }), null);
  assert.equal(serverRefusal({ ...fine, bindHost: 'localhost', requestHost: 'localhost:4391' }), null);
});

test('serverRefusal: a non-loopback bind or request host is refused', () => {
  assert.match(serverRefusal({ ...fine, bindHost: '0.0.0.0' }) ?? '', /本机/u);
  assert.match(serverRefusal({ ...fine, bindHost: '' }) ?? '', /本机/u);
  assert.match(serverRefusal({ ...fine, requestHost: 'evil.example:4391' }) ?? '', /本机/u);
});

test('serverRefusal: an agent marker refuses real data only', () => {
  assert.match(serverRefusal({ ...fine, markers: ['CLAUDECODE'] }) ?? '', /CLAUDECODE/u);
  assert.equal(serverRefusal({ ...fine, markers: ['CLAUDECODE'], realData: false }), null);
});
