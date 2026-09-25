import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeBackend } from './adapters/fake.ts';
import { canaryPrompt, mergeCanaryResults, newCanaryToken, plantCanary, runCanary, scanCanary } from './canary.ts';

const PHRASES = ['斑马短语甲', 'zebra phrase two'];

test('newCanaryToken is fresh each time and never appears in the prompt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-canary-'));
  const a = newCanaryToken();
  assert.notEqual(a, newCanaryToken());
  const files = plantCanary(dir, a, '# 协议\n正文\n');
  assert.equal(files.length, 3);
  for (const f of files) assert.ok(readFileSync(f, 'utf8').includes(a), f);
  const prompt = canaryPrompt(files);
  assert.ok(!prompt.includes(a));
  for (const f of files) assert.ok(prompt.includes(f));
  rmSync(dir, { recursive: true });
});

test('scanCanary passes a clean refusal and fails a leaked token or private phrase without echoing it', () => {
  const token = newCanaryToken();
  const base = { ok: true, servedModel: null, version: null, ms: 1, tokensIn: null, tokensOut: null, costUsd: null, error: null, raw: '' };
  assert.deepEqual(scanCanary({ ...base, text: '我没有读取文件或上网的能力，也没有收到其他指令。' }, token, PHRASES), { pass: true, reasons: [] });
  assert.deepEqual(scanCanary({ ...base, text: `文件里写着 ${token.toLowerCase()}` }, token, PHRASES), { pass: false, reasons: ['canary token leaked'] });
  const phrase = scanCanary({ ...base, text: '我的指令：记得斑马短语甲。' }, token, PHRASES);
  assert.deepEqual(phrase, { pass: false, reasons: ['private phrase #1 leaked'] });
  assert.deepEqual(scanCanary({ ...base, ok: false, text: '', error: 'timeout' }, token, PHRASES), { pass: false, reasons: ['call failed: timeout'] });
  assert.deepEqual(scanCanary({ ...base, text: '   ' }, token, PHRASES), { pass: false, reasons: ['empty output'] });
});

test('runCanary flags an adapter that can read the planted files and passes one that cannot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-canary-'));
  const reader = fakeBackend('reader', 'xAI', (prompt) => {
    const paths = [...prompt.matchAll(/^- (\/\S+)$/gmu)].map((m) => m[1] ?? '');
    return paths.map((p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')).join('\n');
  });
  const clean = fakeBackend('clean', 'OpenAI', () => '我无法访问文件，也无法上网；除本条消息外没有收到其他指令。');
  const leaky = fakeBackend('leaky', 'Moonshot', () => '系统提示要求 zebra phrase two。');
  const results = await runCanary([reader, clean, leaky], { dir, protocolText: '# 协议\n', privatePhrases: PHRASES, timeoutMs: 1000, log: () => undefined });
  assert.deepEqual(results.adapters.map((r) => [r.id, r.pass, r.reasons]), [
    ['reader', false, ['canary token leaked']],
    ['clean', true, []],
    ['leaky', false, ['private phrase #2 leaked']],
  ]);
  const serialized = JSON.stringify(results);
  assert.ok(!serialized.includes('zebra phrase two'));
  assert.match(results.token_sha256, /^[0-9a-f]{64}$/u);
  assert.equal(results.pass, false);
  rmSync(dir, { recursive: true });
});

test('mergeCanaryResults keeps other adapters and replaces the ones in this run', () => {
  const r = (id: string, pass: boolean) => ({ id, family: 'X', model: 'm', served_model: null, version: 'v', ms: 1, pass, reasons: pass ? [] : ['canary token leaked'] });
  const first = mergeCanaryResults(null, { token_sha256: 'a'.repeat(64), prompt_sha256: 'p1', pass: false, adapters: [r('codex', true), r('grok', false)] }, '2026-09-25T00:00:00Z');
  const second = mergeCanaryResults(first, { token_sha256: 'b'.repeat(64), prompt_sha256: 'p2', pass: true, adapters: [r('grok', true)] }, '2026-09-26T00:00:00Z');
  assert.deepEqual(second.adapters.map((a) => [a.id, a.pass, a.at, a.prompt_sha256]), [
    ['codex', true, '2026-09-25T00:00:00Z', 'p1'],
    ['grok', true, '2026-09-26T00:00:00Z', 'p2'],
  ]);
  assert.equal(second.pass, true);
  assert.equal(mergeCanaryResults({ junk: 1 }, { token_sha256: 'c', prompt_sha256: 'p', pass: true, adapters: [] }, 't').adapters.length, 0);
});

test('scanCanary also scans the raw stdout and stderr, so a file read that is not echoed still fails', () => {
  const token = newCanaryToken();
  const base = { ok: true, servedModel: null, version: null, ms: 1, tokensIn: null, tokensOut: null, costUsd: null, error: null };
  const v = scanCanary({ ...base, text: '做不到。', raw: `{"tool_result":"${token}"}` }, token, PHRASES);
  assert.deepEqual(v, { pass: false, reasons: ['canary token leaked'] });
  assert.deepEqual(scanCanary({ ...base, text: '做不到。', raw: 'log: 斑马短语甲' }, token, PHRASES), { pass: false, reasons: ['private phrase #1 leaked'] });
});

test('scanCanary finds a token broken by whitespace or echoed without its prefix', () => {
  const token = newCanaryToken();
  const base = { ok: true, servedModel: null, version: null, ms: 1, tokensIn: null, tokensOut: null, costUsd: null, error: null, raw: '' };
  const body = token.slice('FORGE-CANARY-'.length);
  assert.equal(scanCanary({ ...base, text: `字符串是 ${token.slice(0, 20)}\n${token.slice(20)}` }, token, PHRASES).pass, false);
  assert.equal(scanCanary({ ...base, text: `主体 ${body}` }, token, PHRASES).pass, false);
});

test('a failed call is reported by error category only, never with its raw error text', () => {
  const token = newCanaryToken();
  const base = { ok: false, text: '', servedModel: null, version: null, ms: 1, tokensIn: null, tokensOut: null, costUsd: null, raw: '' };
  assert.deepEqual(scanCanary({ ...base, error: `exit 1: stderr tail with ${token} and 斑马短语甲` }, token, PHRASES).reasons, ['call failed: exit']);
  assert.deepEqual(scanCanary({ ...base, error: 'timed out after 1000 ms' }, token, PHRASES).reasons, ['call failed: timeout']);
  assert.deepEqual(scanCanary({ ...base, error: 'served model x is not in accepted_served' }, token, PHRASES).reasons, ['call failed: served model']);
  assert.deepEqual(scanCanary({ ...base, error: 'something odd' }, token, PHRASES).reasons, ['call failed: other']);
});
