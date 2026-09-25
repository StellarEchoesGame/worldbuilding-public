import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { agentMarkers, waitForServer } from './ui-launch.ts';

test('agent session markers are detected', () => {
  assert.deepEqual(agentMarkers({ CLAUDECODE: '1', PATH: '/bin' }), ['CLAUDECODE']);
  assert.deepEqual(agentMarkers({ CODEX_SANDBOX: 'seatbelt' }), ['CODEX_SANDBOX']);
});

test("the owner's own terminal variables are not markers", () => {
  assert.deepEqual(agentMarkers({ CODEX_PORT_RANGE: '1-2', KIMI_API_BASE: 'x', PATH: '/bin' }), []);
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
