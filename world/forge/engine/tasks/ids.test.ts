import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskKind } from '../testing/scripted.ts';
import { auditPairId, auxPairId, decoyTaskId, defectTaskId, gateTaskId, measureTaskId, resubmissionId, surpriseTaskId, taskId, tasteTaskId } from './ids.ts';

test('PR-B task ids follow the plan §3.3 convention and route on their kind', () => {
  assert.equal(defectTaskId('W2'), 'defect-W2');
  assert.equal(gateTaskId('W2', 'xAI', 1, { copy: false, resubmission: false }), 'gate-W2-xAI-1');
  assert.equal(gateTaskId('W2', 'xAI', 3, { copy: true, resubmission: false }), 'gatecopy-W2-xAI-3');
  assert.equal(gateTaskId(resubmissionId('W1'), 'Moonshot', 1, { copy: false, resubmission: true }), 'gate-W1-r2-Moonshot-1-re');
  assert.equal(decoyTaskId(1), 'decoy-DECOY');
  assert.equal(decoyTaskId(2), 'decoy-DECOY-t2');
  assert.equal(tasteTaskId('W1', 'Moonshot', 1, true, 'rev'), 'taste-W1-Moonshot-s1r-rev');
  assert.equal(tasteTaskId(auxPairId('W3', 'W1', 'sub_sub'), 'xAI', 0, false, 'fwd'), 'taste-W1.W3-xAI-s0-fwd');
  assert.equal(auxPairId('W2-r2', 'AN1', 'anchor'), 'W2-r2.AN1');
  assert.equal(measureTaskId('producer', 'W1', 'OpenAI', true), 'producer-W1-OpenAI-2');
  assert.equal(measureTaskId('recall', 'W1-r2', 'Anthropic', false), 'recall-W1-r2-Anthropic');
  assert.equal(surpriseTaskId('accept', 'W1', 'DeepSeek'), 'accept-W1-DeepSeek');
  assert.equal(auditPairId('R01', 3), 'R01-audit-3');
  const kinds = [defectTaskId('W1'), gateTaskId('W1', 'xAI', 1, { copy: true, resubmission: false }), decoyTaskId(3), tasteTaskId('W1.AN1', 'xAI', 0, false, 'rev'), measureTaskId('skin', 'W1', 'xAI', false), surpriseTaskId('match', 'W1', 'xAI')].map(taskKind);
  assert.deepEqual(kinds, ['defect', 'gatecopy', 'decoy', 'taste', 'skin', 'match']);
});

test('id builders refuse malformed input instead of writing an unsafe label', () => {
  assert.throws(() => taskId('bad id'), /not a task id/u);
  assert.throws(() => gateTaskId('W1', 'xAI', 0, { copy: false, resubmission: false }), /positive integer/u);
  assert.throws(() => decoyTaskId(0), /positive integer/u);
  assert.throws(() => tasteTaskId('W1', 'xAI', -1, false, 'fwd'), /non-negative/u);
  assert.throws(() => measureTaskId('recall', 'W1', 'xAI', true), /only the producer/u);
  assert.throws(() => auditPairId('R01', 0), /positive integer/u);
});
