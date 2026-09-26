import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Bytes } from '../../../../engine/owner-inputs.ts';
import type { FinalJson } from '../../../../engine/final.ts';
import { submitDiffApproval } from '../owner.ts';
import { finalView } from './final.ts';

/* 定稿 view on a hand-built round directory: final.json, approval.diff, pr-body.md, status.json, bench/outcome.json. */

const ROUND = 'R01';
const AT = '2026-10-02T00:00:00.000Z';
const DIFF = [
  'diff --git a/world/current/05-ecology-and-everyday.md b/world/current/05-ecology-and-everyday.md',
  '--- a/world/current/05-ecology-and-everyday.md',
  '+++ b/world/current/05-ecology-and-everyday.md',
  '@@ -1,2 +1,3 @@',
  ' 第一行',
  '-旧的一行',
  '+新的一行',
  '+另一行',
  '',
].join('\n');

function sha(text: string): string {
  return sha256Bytes(Buffer.from(text, 'utf8'));
}

function finalJson(diffSha: string): FinalJson {
  return {
    round: ROUND, status: 'merged_on_branch', revision: '8.2', rxx: ['R01-01'], approval_diff_sha256: diffSha,
    mergecheck: { ok: true, violations: [] }, book_sha256_unchanged: true, reference_book_sha256: null, post_merge_check: [],
    postmerge_split: false, editor: 'llm', thinmap: { all_targets_above: true, snapshot: 'present' },
    maintainer: { outcome: 'no_change_invalid', version: null, evidence_ids: [] }, unseal: { status: 'valid', remote: 'verified' },
  };
}

const OUTCOME = {
  at: AT, cycle: ROUND, outcome: 'no_change_invalid', version: null, parent: 'v1', sha256: null, path: null, activation: null,
  changed_keys: [], evidence_packet: null, evidence_packet_sha256: null, evidence_ids: [], reasons: [], errors: ['void proposal'],
  replay: null, dropped_cliches: [], protocol_bundle_sha256: 'a'.repeat(64), calls: [], source: 'engine',
};

const STATUS = {
  round: ROUND, state: 'waiting', step: '12b-diff-approval', waiting_for: 'diff_approval', detail: '定稿差异待 owner 批准',
  since: AT, exit_code: 2, done: ['00-start', '12a-prepare'],
};

function roundDir(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'forge-final-view-'));
  const dir = join(root, 'rounds', ROUND);
  mkdirSync(join(dir, 'bench'), { recursive: true });
  return { root, dir };
}

function prepared(): { root: string; dir: string } {
  const r = roundDir();
  writeFileSync(join(r.dir, 'approval.diff'), DIFF);
  writeFileSync(join(r.dir, 'final.json'), `${JSON.stringify(finalJson(sha(DIFF)), null, 2)}\n`);
  writeFileSync(join(r.dir, 'pr-body.md'), '## Summary\n\nRound R01.\n');
  writeFileSync(join(r.dir, 'status.json'), JSON.stringify(STATUS));
  writeFileSync(join(r.dir, 'bench', 'outcome.json'), JSON.stringify(OUTCOME));
  return r;
}

test('finalView: null for a bad id or a missing round', () => {
  const { root } = roundDir();
  assert.equal(finalView(root, 'R02'), null);
  assert.equal(finalView(root, 'r01'), null);
});

test('finalView: before 12a (no final.json) nothing to approve, no error', () => {
  const { root } = roundDir();
  const view = finalView(root, ROUND);
  assert.ok(view !== null);
  assert.deepEqual([view.final, view.finalError, view.diffText, view.diffSha256, view.diffMatches, view.prBody, view.outcome, view.approvedAt, view.canApprove], [null, null, null, null, false, null, null, null, false]);
});

test('finalView: after 12a the summary, the diff and its SHA-256, the PR body, the outcome and the status; approvable', () => {
  const { root } = prepared();
  const view = finalView(root, ROUND);
  assert.ok(view !== null && view.final !== null);
  assert.equal(view.finalError, null);
  assert.deepEqual(view.final, finalJson(sha(DIFF)));
  assert.equal(view.diffText, DIFF);
  assert.equal(view.diffSha256, sha(DIFF));
  assert.equal(view.diffMatches, true);
  assert.equal(view.prBody, '## Summary\n\nRound R01.\n');
  assert.equal(view.outcome?.outcome, 'no_change_invalid');
  assert.equal(view.outcomeError, null);
  assert.equal(view.status?.waiting_for, 'diff_approval');
  assert.equal(view.approvedAt, null);
  assert.equal(view.canApprove, true);
});

test('finalView: once approved through submitDiffApproval the approval time is shown and the button is gone', () => {
  const { root } = prepared();
  const shown = finalView(root, ROUND)?.diffSha256 ?? '';
  const r = submitDiffApproval(root, ROUND, shown, '2026-10-02T01:00:00.000Z');
  assert.equal(r.ok, true);
  const view = finalView(root, ROUND);
  assert.equal(view?.approvedAt, '2026-10-02T01:00:00.000Z');
  assert.equal(view?.canApprove, false);
});

test('finalView: a diff that no longer matches final.json cannot be approved', () => {
  const { root, dir } = prepared();
  writeFileSync(join(dir, 'approval.diff'), `${DIFF}+改过\n`);
  const view = finalView(root, ROUND);
  assert.ok(view !== null);
  assert.equal(view.diffMatches, false);
  assert.equal(view.canApprove, false);
  assert.notEqual(view.diffSha256, view.final?.approval_diff_sha256);
});

test('finalView: a malformed final.json or outcome.json is reported, not thrown', () => {
  const { root, dir } = prepared();
  writeFileSync(join(dir, 'final.json'), '{"round":"R01"}');
  writeFileSync(join(dir, 'bench', 'outcome.json'), '{"torn');
  const view = finalView(root, ROUND);
  assert.ok(view !== null);
  assert.equal(view.final, null);
  assert.ok(view.finalError !== null);
  assert.equal(view.canApprove, false);
  assert.equal(view.outcome, null);
  assert.ok(view.outcomeError !== null);
});

test('finalView: a no_merge round approves the empty diff', () => {
  const { root, dir } = roundDir();
  writeFileSync(join(dir, 'approval.diff'), '');
  writeFileSync(join(dir, 'final.json'), JSON.stringify({ ...finalJson(sha('')), status: 'no_merge', revision: null, rxx: [], mergecheck: null }));
  const view = finalView(root, ROUND);
  assert.equal(view?.diffText, '');
  assert.equal(view?.canApprove, true);
});
