import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentMarkers } from './ui-launch.ts';

test('agent session markers are detected', () => {
  assert.deepEqual(agentMarkers({ CLAUDECODE: '1', PATH: '/bin' }), ['CLAUDECODE']);
  assert.deepEqual(agentMarkers({ CODEX_SANDBOX: 'seatbelt' }), ['CODEX_SANDBOX']);
});

test("the owner's own terminal variables are not markers", () => {
  assert.deepEqual(agentMarkers({ CODEX_PORT_RANGE: '1-2', KIMI_API_BASE: 'x', PATH: '/bin' }), []);
});
