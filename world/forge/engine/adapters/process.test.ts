import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProcess } from './process.ts';

test('runProcess captures stdout, feeds stdin and applies env changes', async () => {
  process.env['FORGE_U'] = 'present';
  const r = await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout); process.stderr.write(String(process.env.FORGE_T) + String(process.env.FORGE_U))'], {
    envSet: { FORGE_T: 'set' },
    envUnset: ['FORGE_U'],
    cwd: process.cwd(),
    stdin: '输入',
    timeoutMs: 10_000,
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '输入');
  assert.equal(r.stderr, 'setundefined');
  assert.equal(r.timedOut, false);
});

test('runProcess kills a hung process at the timeout', async () => {
  const r = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { envSet: {}, envUnset: [], cwd: process.cwd(), stdin: null, timeoutMs: 300 });
  assert.equal(r.timedOut, true);
});
