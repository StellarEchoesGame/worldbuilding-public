import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CalibSetRecord } from '../../../../engine/calib-build.ts';
import { body, put, setRecord, writeSet } from '../../../../engine/testing/calib-set.ts';
import { ownerInputs } from '../../../../engine/owner-inputs.ts';
import { submitCalibAnswers } from '../owner.ts';
import { calibSets, calibView } from './calib.ts';

const now = '2026-10-02T00:00:00.000Z';

/** C00 (round0), Q01 (requal) and G01 (gate). */
function records(): Record<string, CalibSetRecord> {
  return { C00: setRecord('C00', 'round0', null), Q01: setRecord('Q01', 'requal', 'DeepSeek'), G01: setRecord('G01', 'gate', 'DeepSeek') };
}

/** calibration/pairs.json holding these sets (an engine file: c1-build writes it). */
function writePairs(root: string, sets: Readonly<Record<string, CalibSetRecord>>): void {
  put(root, 'calibration/pairs.json', `${JSON.stringify({ schema: 'calib-pairs/1', sets }, null, 2)}\n`);
}

/** records() in one pairs.json, texts as c1-build leaves them. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-ui-calib-'));
  const sets = records();
  for (const [set, record] of Object.entries(sets)) writeSet(root, set, record);
  writePairs(root, sets);
  return root;
}

function answer(root: string, set: string, slot: number, choice: 'left' | 'right'): void {
  const r = submitCalibAnswers(root, set, [{ slot, choice, ms: 1200 }], now);
  assert.ok(r.ok, r.ok ? '' : r.error);
}

test('calibSets lists round0 and requal sets with progress; gate sets are never listed', () => {
  const root = fixture();
  assert.deepEqual(calibSets(root), [
    { set: 'C00', kind: 'round0', total: 5, answered: 0, complete: false, pinned: false },
    { set: 'Q01', kind: 'requal', total: 5, answered: 0, complete: false, pinned: false },
  ]);
  answer(root, 'C00', 2, 'left');
  put(root, 'calibration/Q01/pin.json', '{}\n');
  const [c00, q01] = calibSets(root);
  assert.equal(c00?.answered, 1);
  assert.equal(q01?.pinned, true);
  rmSync(root, { recursive: true });
});

test('calibSets is empty without pairs.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-ui-calib-'));
  assert.deepEqual(calibSets(root), []);
  rmSync(root, { recursive: true });
});

test('calibView shows the lowest unanswered display slot, blind', () => {
  const root = fixture();
  const view = calibView(root, 'C00');
  assert.ok(view !== null);
  assert.equal(view.error, null);
  assert.equal(view.stale, false);
  assert.deepEqual(view.next, { slot: 1, position: 1, total: 5, leftText: body(3), rightText: body(4) });
  const html = JSON.stringify(view);
  for (const leak of ['C00-T', 'C00-P', 'DeepSeek', 'Alibaba', 'rewrite', 'fixture']) assert.ok(!html.includes(leak), leak);
  rmSync(root, { recursive: true });
});

test('calibView resumes after partial answers and finishes when every slot is answered', () => {
  const root = fixture();
  answer(root, 'C00', 1, 'left');
  answer(root, 'C00', 3, 'right');
  const mid = calibView(root, 'C00');
  assert.equal(mid?.answered, 2);
  assert.equal(mid?.next?.slot, 2);
  assert.equal(mid?.next?.position, 2);
  assert.equal(mid?.next?.leftText, body(2));
  answer(root, 'C00', 2, 'left');
  assert.equal(calibView(root, 'C00')?.next?.slot, 4);
  answer(root, 'C00', 4, 'left');
  answer(root, 'C00', 5, 'right');
  const done = calibView(root, 'C00');
  assert.equal(done?.next, null);
  assert.equal(done?.answered, 5);
  assert.equal(ownerInputs(root).calibAnswers().state, 'ok');
  assert.equal(calibSets(root)[0]?.complete, true);
  rmSync(root, { recursive: true });
});

test('calibView refuses unknown, gate and malformed set ids', () => {
  const root = fixture();
  assert.equal(calibView(root, 'G01'), null);
  assert.equal(calibView(root, 'C07'), null);
  assert.equal(calibView(root, '../C00'), null);
  rmSync(root, { recursive: true });
});

test('calibView reports answers given on other pairs as stale once C00 is rebuilt in pairs.json; submitCalibAnswers refuses', () => {
  const root = fixture();
  answer(root, 'C00', 1, 'left');
  assert.equal(calibView(root, 'C00')?.stale, false);
  // the engine rebuilds C00 (a new built_at): its canonical JSON, hence pairsSha256, changes under the answer
  writePairs(root, { ...records(), C00: { ...setRecord('C00', 'round0', null), built_at: '2026-10-03T00:00:00.000Z' } });
  const view = calibView(root, 'C00');
  assert.equal(view?.stale, true);
  assert.equal(view?.answered, 1);
  const r = submitCalibAnswers(root, 'C00', [{ slot: 2, choice: 'left', ms: null }], now);
  assert.deepEqual(r.ok ? null : [r.status, r.error], [409, '校准对已经变化，不能继续提交。'], 'stale ⇔ the submit refuses');
  rmSync(root, { recursive: true });
});

test('calibView reports a missing text instead of showing a half slot', () => {
  const root = fixture();
  rmSync(join(root, 'calibration/texts/C00-T03.md'));
  const view = calibView(root, 'C00');
  assert.equal(view?.next, null);
  assert.match(view?.error ?? '', /文本/u);
  rmSync(root, { recursive: true });
});

test('calibView reports an unreadable text (a directory in its place) instead of throwing', () => {
  const root = fixture();
  rmSync(join(root, 'calibration/texts/C00-T03.md'));
  mkdirSync(join(root, 'calibration/texts/C00-T03.md'));
  const view = calibView(root, 'C00');
  assert.equal(view?.next, null);
  assert.match(view?.error ?? '', /无法读取/u);
  rmSync(root, { recursive: true });
});
