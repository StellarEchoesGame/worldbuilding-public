import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentMarkers, launchHost, waitForServer } from './ui-launch.ts';

test('agent session markers are detected: exact Claude names and the CODEX_ / KIMI_ / GROK_ prefixes', () => {
  assert.deepEqual(agentMarkers({ CLAUDECODE: '1', PATH: '/bin' }), ['CLAUDECODE']);
  assert.deepEqual(agentMarkers({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), ['CLAUDE_CODE_ENTRYPOINT']);
  assert.deepEqual(agentMarkers({ CODEX_SANDBOX: 'seatbelt' }), ['CODEX_SANDBOX']);
  assert.deepEqual(agentMarkers({ KIMI_API_BASE: 'x', GROK_SESSION: 'y', CODEX_PORT_RANGE: '1-2' }), ['CODEX_PORT_RANGE', 'GROK_SESSION', 'KIMI_API_BASE']);
});

test('ordinary terminal variables are not markers', () => {
  assert.deepEqual(agentMarkers({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/x', MY_CODEX_NOTE: '1', HOME: '/h' }), []);
});

test('launchHost: --host defaults to 127.0.0.1 and accepts only loopback', () => {
  assert.deepEqual(launchHost([]), { ok: true, value: '127.0.0.1' });
  assert.deepEqual(launchHost(['--no-open', '--host', 'localhost']), { ok: true, value: 'localhost' });
  assert.deepEqual(launchHost(['--host', '::1']), { ok: true, value: '::1' });
  assert.deepEqual(launchHost(['--host=localhost']), { ok: true, value: 'localhost' });
  for (const bad of [['--host', '0.0.0.0'], ['--host', '192.168.1.2'], ['--host'], ['--host', '--no-open'], ['--host=0.0.0.0'], ['--host=']]) {
    const r = launchHost(bad);
    assert.equal(r.ok, false, bad.join(' '));
  }
});

test('waitForServer resolves once any HTTP response arrives, and fails on timeout', async () => {
  const server = createServer((_req, res) => { res.statusCode = 401; res.end(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  assert.equal(await waitForServer(`http://127.0.0.1:${port}/login`, 2000), true);
  server.close();
  assert.equal(await waitForServer('http://127.0.0.1:9/login', 300), false);
});

/** `node engine/cli.ts ui …` in a child with `env` (no inherited agent markers unless given); refusals exit before the build. */
function forgeUi(args: readonly string[], env: Readonly<Record<string, string>>): { status: number | null; stderr: string } {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => agentMarkers({ [k]: '1' }).length === 0 && k !== 'HOST'));
  const r = spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'ui', '--no-open', ...args], { env: { ...clean, ...env }, encoding: 'utf8', timeout: 20_000 });
  return { status: r.status, stderr: r.stderr };
}

test('forge ui refuses the real data directory under an agent marker (exact name or prefix) and exits 1 before building', () => {
  for (const marker of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'KIMI_SESSION', 'GROK_HOME']) {
    const r = forgeUi([], { [marker]: '1' });
    assert.equal(r.status, 1, `${marker}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`代理会话标记（${marker}）`, 'u'));
    assert.doesNotMatch(r.stderr, /构建/u);
  }
});

test('forge ui refuses --data pointing at a symlinked alias of the real data directory under an agent marker', () => {
  const base = mkdtempSync(join(tmpdir(), 'forge-ui-alias-'));
  try {
    const alias = join(base, 'forge');
    symlinkSync(join(import.meta.dirname, '..'), alias);
    const r = forgeUi(['--data', alias], { CLAUDECODE: '1' });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /代理会话标记（CLAUDECODE）/u);
    assert.doesNotMatch(r.stderr, /构建/u);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('forge ui refuses a non-loopback --host or HOST before anything else', () => {
  const flag = forgeUi(['--host', '0.0.0.0'], {});
  assert.equal(flag.status, 1);
  assert.match(flag.stderr, /不是本机地址/u);
  const env = forgeUi([], { HOST: '0.0.0.0' });
  assert.equal(env.status, 1);
  assert.match(env.stderr, /HOST=0\.0\.0\.0/u);
});
