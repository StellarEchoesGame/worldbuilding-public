import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocalConfig, PrefixRule } from '../../../../engine/config.ts';
import { configModels, configView, familyWarning, gatewayModels, MODEL_LIST_TIMEOUT_MS, type FetchLike } from './config.ts';

const FORGE = join(import.meta.dirname, '..', '..', '..', '..');
const HOST = 'fixture-gateway.invalid';
const PREFIXES: PrefixRule[] = [{ prefix: 'deepseek', family: 'DeepSeek' }, { prefix: 'gpt-', family: 'OpenAI' }, { prefix: 'qwen/', family: 'Alibaba' }];

function fixture(withLocal: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-config-view-'));
  for (const f of ['writers.json', 'judges.json', 'families.json', 'prices.json']) copyFileSync(join(FORGE, f), join(root, f));
  writeFileSync(join(root, 'gw.env'), 'GW_KEY="sk-fixture-secret"\n');
  if (withLocal) {
    writeFileSync(join(root, 'local.json'), JSON.stringify({ gateway: { base_url: `https://${HOST}/`, env_file: 'gw.env', key_var: 'GW_KEY' }, binaries: {}, codex_auth: '~/.codex/auth.json', kimi_home: '~/.kimi', private_phrases: [] }));
  }
  return root;
}

function local(root: string): LocalConfig {
  return { gatewayBaseUrl: `https://${HOST}`, gatewayEnvFile: join(root, 'gw.env'), gatewayKeyVar: 'GW_KEY', binaries: { codex: 'codex', claude: 'claude', kimi: 'kimi', grok: 'grok' }, codexAuth: '', kimiHome: '', privatePhrases: [] };
}

test('familyWarning: unknown family, judge family, or none', () => {
  assert.match(familyWarning('mystery/model', PREFIXES, ['OpenAI']) ?? '', /未知家族/u);
  assert.match(familyWarning('gpt-6', PREFIXES, ['OpenAI']) ?? '', /OpenAI/u);
  assert.equal(familyWarning('deepseek/v4', PREFIXES, ['OpenAI']), null);
});

test('gatewayModels: GET /v1/models with the Bearer key, sorted ids with families and warnings', async () => {
  const root = fixture(false);
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    seen.push({ url, auth: init.headers['Authorization'] });
    return { ok: true, status: 200, json: async () => ({ object: 'list', data: [{ id: 'qwen/qwen-4' }, { id: 'gpt-6' }, { id: 'deepseek/v4' }, { nope: 1 }] }) };
  };
  const r = await gatewayModels(local(root), PREFIXES, ['OpenAI'], fetchImpl, 1000);
  assert.ok(r.ok);
  assert.deepEqual(r.models.map((m) => [m.id, m.family, m.warning !== null]), [['deepseek/v4', 'DeepSeek', false], ['gpt-6', 'OpenAI', true], ['qwen/qwen-4', 'Alibaba', false]]);
  assert.deepEqual(seen, [{ url: `https://${HOST}/v1/models`, auth: 'Bearer sk-fixture-secret' }]);
  rmSync(root, { recursive: true });
});

test('gatewayModels errors never carry the host or the key', async () => {
  const root = fixture(false);
  const cases: FetchLike[] = [
    async () => { throw new TypeError(`fetch failed: getaddrinfo ENOTFOUND ${HOST} (https://${HOST}/v1/models)`, { cause: new Error(`connect ${HOST} sk-fixture-secret`) }); },
    async () => ({ ok: false, status: 502, json: async () => ({ error: `upstream ${HOST}` }) }),
    async () => ({ ok: true, status: 200, json: async () => ({ data: 'x' }) }),
    async (_url, init) => new Promise((_done, fail) => init.signal.addEventListener('abort', () => fail(init.signal.reason))),
  ];
  for (const f of cases) {
    const r = await gatewayModels(local(root), PREFIXES, [], f, 50);
    assert.ok(!r.ok);
    assert.ok(!r.error.includes(HOST) && !r.error.includes('sk-fixture-secret'), r.error);
  }
  const noKey = await gatewayModels({ ...local(root), gatewayKeyVar: 'MISSING' }, PREFIXES, [], cases[0] ?? (async () => { throw new Error('x'); }), 50);
  assert.ok(!noKey.ok && /密钥/u.test(noKey.error));
  rmSync(root, { recursive: true });
});

test('configView: slots, baseline, judges, prices, judge families; local presence only', () => {
  const root = fixture(true);
  const v = configView(root);
  assert.equal(v.writers.error, null);
  assert.deepEqual(v.writers.slots.map((s) => [s.id, s.family]), [['W1', 'DeepSeek'], ['W2', 'DeepSeek'], ['W3', 'DeepSeek']]);
  assert.equal(v.writers.baseline?.id, 'BASE');
  assert.ok(v.judges.present && v.judges.list.some((j) => j.id === 'maintainer'));
  assert.deepEqual(v.local, { present: true, error: null });
  assert.ok(v.prices.present && v.prices.error === null);
  assert.deepEqual([...v.judgeFamilies].sort(), ['Anthropic', 'Moonshot', 'OpenAI', 'xAI']);
  assert.equal(v.locked, null);
  assert.ok(!JSON.stringify(v).includes(HOST));
  rmSync(root, { recursive: true });
});

test('configView: locked by a frozen unfinished round; a broken local.json is reported without its content', () => {
  const root = fixture(false);
  mkdirSync(join(root, 'rounds', 'R01'), { recursive: true });
  writeFileSync(join(root, 'rounds', 'R01', 'freeze.json'), '{}');
  assert.match(configView(root).locked ?? '', /R01/u);
  writeFileSync(join(root, 'local.json'), `{"gateway": {"base_url": "https://${HOST}"`);
  const v = configView(root);
  assert.equal(v.local.present, true);
  assert.ok(v.local.error !== null && !v.local.error.includes(HOST));
  rmSync(root, { recursive: true });
});

test('configModels: no local.json → notice; else the gateway list with the env file resolved against the forge root', async () => {
  const bare = fixture(false);
  const none = await configModels(bare, async () => { throw new Error('not called'); }, 50);
  assert.ok(!none.ok && /local\.json/u.test(none.error));
  const root = fixture(true);
  const r = await configModels(root, async (_url, init) => ({ ok: init.headers['Authorization'] === 'Bearer sk-fixture-secret', status: 401, json: async () => ({ data: [{ id: 'gpt-6' }] }) }), 50);
  assert.ok(r.ok && r.models[0]?.warning !== null);
  rmSync(bare, { recursive: true });
  rmSync(root, { recursive: true });
});

test('MODEL_LIST_TIMEOUT_MS is the contract 5 s, and the timeout notice states the seconds it was given', async () => {
  assert.equal(MODEL_LIST_TIMEOUT_MS, 5000);
  const root = fixture(false);
  const timedOut: FetchLike = async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  const r = await gatewayModels(local(root), PREFIXES, [], timedOut, MODEL_LIST_TIMEOUT_MS);
  assert.ok(!r.ok);
  assert.equal(r.error, '网关 5 秒内没有返回模型列表。');
  const short = await gatewayModels(local(root), PREFIXES, [], timedOut, 1500);
  assert.ok(!short.ok && short.error === '网关 1.5 秒内没有返回模型列表。', short.ok ? '' : short.error);
  rmSync(root, { recursive: true });
});
