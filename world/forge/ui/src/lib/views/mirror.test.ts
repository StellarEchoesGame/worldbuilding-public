import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { submitDiffApproval } from '../owner.ts';
import { mirrorView } from './mirror.ts';

const NOW = '2026-09-10T00:00:00.000Z';

/** R01 with an approved final diff (one queued diff_approval mirror) and a mirror log; R02 with a broken log. */
function fixture(): { root: string; diffSha: string } {
  const root = mkdtempSync(join(tmpdir(), 'forge-mirror-view-'));
  const dir = join(root, 'rounds', 'R01');
  mkdirSync(dir, { recursive: true });
  const diff = '--- a/x\n+++ b/x\n';
  const diffSha = createHash('sha256').update(diff).digest('hex');
  writeFileSync(join(dir, 'approval.diff'), diff);
  writeFileSync(join(dir, 'final.json'), JSON.stringify({ approval_diff_sha256: diffSha }));
  const approved = submitDiffApproval(root, 'R01', diffSha, '2026-09-09T00:00:00.000Z');
  assert.ok(approved.ok, approved.ok ? '' : approved.error);
  const sha = (c: string): string => c.repeat(64);
  const log = [
    { at: '2026-09-08T00:00:00.000Z', kind: 'probe', key: 'R01', source_sha256: sha('a'), status: 'posted', comment_id: 11, created_at: '2026-09-08T00:00:01Z', url: 'https://github.com/o/r/issues/1#issuecomment-11', error: null },
    { at: '2026-09-09T12:00:00.000Z', kind: 'diff_approval', key: diffSha, source_sha256: diffSha, status: 'failed', comment_id: null, created_at: null, url: null, error: 'HTTP 502' },
  ];
  writeFileSync(join(dir, 'mirror.jsonl'), log.map((l) => `${JSON.stringify(l)}\n`).join(''));
  mkdirSync(join(root, 'rounds', 'R02'), { recursive: true });
  writeFileSync(join(root, 'rounds', 'R02', 'mirror.jsonl'), 'not json\n');
  mkdirSync(join(root, 'rounds', 'R03'), { recursive: true });
  return { root, diffSha };
}

test('mirrorView: pending items with failures, next attempt and last error; posted entries from the log', () => {
  const { root, diffSha } = fixture();
  const v = mirrorView(root, NOW, true);
  assert.equal(v.retryDisabled, null);
  const r01 = v.rounds.find((r) => r.round === 'R01');
  assert.ok(r01 !== undefined && r01.error === null);
  assert.equal(r01.items.length, 1);
  const item = r01.items[0];
  assert.equal(item?.kind, 'diff_approval');
  assert.equal(item?.key, diffSha);
  assert.equal(item?.failures, 1);
  assert.equal(item?.lastError, 'HTTP 502');
  assert.equal(item?.nextAttemptAt, '2026-09-09T12:02:00.000Z');
  assert.ok((item?.preview.length ?? 0) > 0 && (item?.preview.length ?? 0) <= 600);
  assert.deepEqual(r01.posted, [{ kind: 'probe', key: 'R01', createdAt: '2026-09-08T00:00:01Z', url: 'https://github.com/o/r/issues/1#issuecomment-11' }]);
  rmSync(root, { recursive: true });
});

test('mirrorView: an unreadable log is a per-round error; rounds without mirrors are left out', () => {
  const { root } = fixture();
  const v = mirrorView(root, NOW, true);
  const r02 = v.rounds.find((r) => r.round === 'R02');
  assert.ok(r02 !== undefined && r02.error !== null && r02.items.length === 0);
  assert.equal(v.rounds.some((r) => r.round === 'R03'), false);
  assert.deepEqual(v.rounds.map((r) => r.round), ['R01', 'R02']);
  rmSync(root, { recursive: true });
});

test('mirrorView: retry is disabled on fixture data; no rounds dir → no rounds', () => {
  const { root } = fixture();
  assert.match(mirrorView(root, NOW, false).retryDisabled ?? '', /夹具|真实/u);
  const empty = mkdtempSync(join(tmpdir(), 'forge-mirror-empty-'));
  assert.deepEqual(mirrorView(empty, NOW, true), { rounds: [], retryDisabled: null });
  rmSync(root, { recursive: true });
  rmSync(empty, { recursive: true });
});
