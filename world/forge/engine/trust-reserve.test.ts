import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANCHOR_IDS } from './pairs.ts';
import { CHAMPION_ID } from './submission.ts';
import { reserveLabels, type Label, type LabelLedger, type LabelText } from './trust.ts';

function text(id: string, sha: string): LabelText {
  return { id, path: `rounds/R01/${id}.json`, sha256: sha.repeat(64), authors: ['DeepSeek'] };
}

function label(id: string, round: string, seq: number, split: Label['split'], texts: LabelText[]): Label {
  return { id, source: 'audit', round, seq, texts, owner_chosen: texts[0]?.id ?? '', answered_at: '2026-10-01T00:00:00Z', split, use: 'agreement', trials: {} };
}

test('reserveLabels leaves out a reserve label whose non-shared text was shown by a visible label (champion and anchors recur and do not count)', () => {
  const champion = text(CHAMPION_ID, 'c');
  const anchor = text(ANCHOR_IDS[0] ?? 'AN1', 'a');
  const ledger: LabelLedger = {
    schema: 'calib-labels/1',
    labels: [
      label('R01-audit-1', 'R01', 1, 'visible', [champion, text('W1', '1')]),
      label('R01-audit-2', 'R01', 2, 'reserve', [champion, text('W2', '2')]),
      label('R01-audit-3', 'R01', 3, 'reserve', [champion, text('W1', '1')]),
      label('R01-audit-4', 'R01', 4, 'visible', [anchor, text('W3', '3')]),
      label('R02-audit-1', 'R02', 1, 'reserve', [anchor, text('W4', '4')]),
      label('R02-audit-2', 'R02', 2, 'reserve', [text('W3', '3'), text('W5', '5')]),
    ],
  };
  const ids = reserveLabels(ledger, 16).map((l) => l.id);
  assert.deepEqual(ids, ['R02-audit-1', 'R01-audit-2'], 'W1 (R01-audit-3) and W3 (R02-audit-2) were shown by visible labels; the champion and the anchor do not count');
});
