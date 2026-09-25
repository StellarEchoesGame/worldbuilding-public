import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from './adapters/process.ts';
import { approvalDiff, diffApprovalStep, parseFinal, prBody, prepareFinalStep, type FinalJson } from './final.ts';
import { sha256Bytes } from './marker.ts';
import { APPROVAL_DIFF_COMMAND, gitPort } from './ports-cli.ts';
import { IntegrityError } from './task.ts';
import { mergeHarness, type MergeHarness } from './testing/fake-assembler.ts';

const ECOLOGY = 'world/current/reference/05-ecology-and-everyday.md';
const EMPTY_SHA = sha256Bytes(Buffer.from('', 'utf8'));

/** 07a's unseal.json (engine-owned; the merge harness starts at 09b and writes none). */
function writeUnseal(h: MergeHarness): void {
  mkdirSync(h.ctx.paths.dir, { recursive: true });
  const unseal = { round: 'R01', status: 'valid', reasons: [], remote: 'unavailable', forecasters: 5, checked_at: '2026-10-01T01:00:00.000Z' };
  writeFileSync(join(h.ctx.paths.dir, 'unseal.json'), `${JSON.stringify(unseal, null, 2)}\n`);
  mkdirSync(join(h.ctx.paths.dir, 'unsealed'), { recursive: true });
  const recheck = { round: 'R01', seal: 'verified', remote: 'verified', published: true, checked_at: '2026-10-01T02:00:00.000Z' };
  writeFileSync(join(h.ctx.paths.dir, 'unsealed', 'recheck.json'), `${JSON.stringify(recheck, null, 2)}\n`);
}

function finalOf(h: MergeHarness): FinalJson {
  const f = parseFinal(JSON.parse(readFileSync(join(h.ctx.paths.dir, 'final.json'), 'utf8')));
  assert.ok(f.ok, f.ok ? '' : f.error);
  return f.value;
}

async function merged(): Promise<MergeHarness> {
  const h = await mergeHarness();
  h.decide({ pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: ['A:A-01'] });
  const r = await h.run();
  assert.equal(r.exitCode, 0, r.detail);
  writeUnseal(h);
  return h;
}

test('approval diff: SHA-256 stable across two runs; any later world/current edit changes it', async () => {
  const h = await merged();
  const base = h.ctx.start().base_sha;
  const a = await approvalDiff(h.ctx, base);
  const b = await approvalDiff(h.ctx, base);
  assert.ok(a.ok && b.ok);
  assert.equal(a.value.sha256, b.value.sha256);
  assert.equal(a.value.text, b.value.text);
  assert.equal(a.value.sha256, sha256Bytes(Buffer.from(a.value.text, 'utf8')));
  assert.match(a.value.text, /09-scenes-and-people\.md/u);
  appendFileSync(join(h.world.repo, ECOLOGY), '补一句。\n');
  const c = await approvalDiff(h.ctx, base);
  assert.ok(c.ok);
  assert.notEqual(c.value.sha256, a.value.sha256);
  rmSync(h.dir, { recursive: true, force: true });
});

test('12a on a merged round: approval.diff, final.json (8.2, mergecheck ok, BOOK unchanged, llm editor, recheck remote) and pr-body.md; 12b waits until the owner approves that diff', async () => {
  const h = await merged();
  const out = await prepareFinalStep.run(h.ctx, null);
  assert.equal(out.kind, 'done');
  const final = finalOf(h);
  assert.equal(final.status, 'merged_on_branch');
  assert.equal(final.revision, '8.2');
  assert.deepEqual(final.rxx, ['R01-01']);
  assert.equal(final.approval_diff_sha256, sha256Bytes(readFileSync(join(h.ctx.paths.dir, 'approval.diff'))));
  assert.deepEqual(final.mergecheck, { ok: true, violations: [] });
  assert.equal(final.book_sha256_unchanged, true);
  assert.match(final.reference_book_sha256 ?? '', /^[0-9a-f]{64}$/u);
  assert.deepEqual(final.post_merge_check, []);
  assert.equal(final.postmerge_split, false);
  assert.equal(final.editor, 'llm');
  assert.equal(final.thinmap, null);
  assert.equal(final.maintainer, null);
  assert.deepEqual(final.unseal, { status: 'valid', remote: 'verified' });
  const body = readFileSync(join(h.ctx.paths.dir, 'pr-body.md'), 'utf8');
  assert.ok(body.includes(final.approval_diff_sha256));
  assert.match(body, /## Reviewer checklist/u);
  assert.match(body, /`owner-log\.jsonl` line \d+: decision/u);
  assert.equal(/closes #/iu.test(body), false);

  const waiting = await diffApprovalStep.run(h.ctx, null);
  assert.equal(waiting.kind, 'wait');
  assert.equal(waiting.kind === 'wait' ? waiting.waitingFor : null, 'diff_approval');
  h.sim.approveDiff('R01');
  assert.equal((await diffApprovalStep.run(h.ctx, null)).kind, 'done');

  // a later canon edit makes the recomputed diff differ from the approved hash, and 12b refuses a changed approval.diff
  appendFileSync(join(h.world.repo, ECOLOGY), '补一句。\n');
  const again = await approvalDiff(h.ctx, h.ctx.start().base_sha);
  assert.ok(again.ok);
  assert.notEqual(again.value.sha256, final.approval_diff_sha256);
  appendFileSync(join(h.ctx.paths.dir, 'approval.diff'), 'x');
  await assert.rejects(diffApprovalStep.run(h.ctx, null), /does not match final\.json/u);
  rmSync(h.dir, { recursive: true, force: true });
});

test('12a refuses a merge.json that belongs to another decision than the 09b-pinned one', async () => {
  const h = await merged();
  const path = join(h.ctx.paths.dir, 'merge.json');
  const pointer: unknown = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(typeof pointer === 'object' && pointer !== null);
  // a well-formed pointer to another decision's attempt (current and decision_sha256 agree)
  writeFileSync(path, `${JSON.stringify({ ...pointer, current: 'dddddddd', decision_sha256: 'd'.repeat(64) }, null, 2)}\n`);
  await assert.rejects(prepareFinalStep.run(h.ctx, null), (e: unknown) => {
    assert.ok(e instanceof IntegrityError);
    assert.match(e.message, /^rounds\/R01\/merge\.json belongs to decision dddddddd, not the pinned [0-9a-f]{8}$/u);
    return true;
  });
  assert.equal(existsSync(join(h.ctx.paths.dir, 'final.json')), false);
  rmSync(h.dir, { recursive: true, force: true });
});

test('12b recomputes the approval diff: a world/current edit after 12a is refused even once the owner approved the stale hash; a git error is blocked', async () => {
  const h = await merged();
  assert.equal((await prepareFinalStep.run(h.ctx, null)).kind, 'done');
  const diffBytes = readFileSync(join(h.ctx.paths.dir, 'approval.diff'));
  h.sim.approveDiff('R01');
  h.ports.git.failNext('diff', 1);
  const blocked = await diffApprovalStep.run(h.ctx, null);
  assert.equal(blocked.kind, 'blocked');
  assert.match(blocked.kind === 'blocked' ? blocked.detail : '', /^12b-diff-approval: git diff /u);
  assert.equal((await diffApprovalStep.run(h.ctx, null)).kind, 'done');
  // only the canon changes: approval.diff and final.json still agree with each other
  appendFileSync(join(h.world.repo, ECOLOGY), '补一句。\n');
  await assert.rejects(diffApprovalStep.run(h.ctx, null), /world\/current changed after 12a/u);
  assert.deepEqual(readFileSync(join(h.ctx.paths.dir, 'approval.diff')), diffBytes);
  rmSync(h.dir, { recursive: true, force: true });
});

test('12a after pick none: empty approval diff, status no_merge, still waiting for (and accepting) the approval', async () => {
  const h = await mergeHarness();
  h.decide({ pick: 'none', reason: '平', fav: 'A', publish: 'no', facts: [] });
  assert.equal((await h.run()).exitCode, 0);
  writeUnseal(h);
  assert.equal((await prepareFinalStep.run(h.ctx, null)).kind, 'done');
  const final = finalOf(h);
  assert.equal(final.status, 'no_merge');
  assert.equal(final.revision, null);
  assert.equal(final.approval_diff_sha256, EMPTY_SHA);
  assert.equal(readFileSync(join(h.ctx.paths.dir, 'approval.diff'), 'utf8'), '');
  assert.equal(final.mergecheck, null);
  assert.equal(final.editor, null);
  assert.equal(final.book_sha256_unchanged, true);
  assert.equal((await diffApprovalStep.run(h.ctx, null)).kind, 'wait');
  h.sim.approveDiff('R01');
  assert.equal((await diffApprovalStep.run(h.ctx, null)).kind, 'done');
  rmSync(h.dir, { recursive: true, force: true });
});

const FINAL: FinalJson = {
  round: 'R01', status: 'merged_on_branch', revision: '8.2', rxx: ['R01-01', 'R01-02'], approval_diff_sha256: 'a'.repeat(64),
  mergecheck: { ok: true, violations: [] }, book_sha256_unchanged: true, reference_book_sha256: 'b'.repeat(64), post_merge_check: [],
  postmerge_split: true, editor: 'fallback', thinmap: { all_targets_above: false, snapshot: 'present' }, maintainer: null, unseal: { status: 'valid', remote: 'verified' },
};

test('parseFinal round-trips a final.json and refuses malformed fields', () => {
  assert.deepEqual(parseFinal(JSON.parse(JSON.stringify(FINAL))), { ok: true, value: FINAL });
  const bad: ReadonlyArray<Record<string, unknown>> = [
    { status: 'merged' }, { approval_diff_sha256: 'x' }, { editor: 'human' }, { unseal: { status: 'valid', remote: 'down' } },
    { mergecheck: { ok: 'yes' } }, { thinmap: {} }, { thinmap: { all_targets_above: false } }, { thinmap: { all_targets_above: false, snapshot: 'gone' } }, { post_merge_check: null }, { reference_book_sha256: 'short' },
    { maintainer: { outcome: 'activate', version: 3, evidence_ids: [] } },
  ];
  for (const patch of bad) assert.equal(parseFinal({ ...FINAL, ...patch }).ok, false, JSON.stringify(patch));
  assert.equal(parseFinal([]).ok, false);
});

test('prBody reports a missing round-0 snapshot as not measured instead of a false "above"', () => {
  const body = prBody({ ...FINAL, thinmap: { all_targets_above: false, snapshot: 'missing' } }, 7, []);
  assert.match(body, /Thin map: round-0 snapshot missing \(F1-05\): not measured\./u);
  assert.doesNotMatch(body, /above the round-0 snapshot: no/u);
  assert.match(prBody(FINAL, 7, []), /every target cell above the round-0 snapshot: no/u);
});

test('prBody: English summary, checklist flags split / fallback, evidence listed, no Closes line', () => {
  const body = prBody(FINAL, 7, ['`rounds/R01/final.json`']);
  assert.match(body, /^## Summary\n\nRound R01 \(#7\) merges one sample scene into the reference, revision 8\.2: R01-01, R01-02\./u);
  assert.match(body, /Post-merge gate split: yes; merge editor: fallback \(deterministic fallback plan/u);
  assert.match(body, /every target cell above the round-0 snapshot: no/u);
  assert.match(body, /- `rounds\/R01\/final\.json`/u);
  assert.equal(/closes/iu.test(body), false);
  const none = prBody({ ...FINAL, status: 'no_merge', revision: null, rxx: [], mergecheck: null, editor: null, thinmap: null }, 7, []);
  assert.match(none, /ends without a merge/u);
  assert.match(none, /mergecheck: not run \(no merge\)/u);
  assert.match(none, /- \(none\)/u);
});

test('approval diff bytes (real git) ignore core.abbrev, diff.algorithm, indent heuristic, prefixes and path quoting config', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'forge-final-diff-'));
  const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '--quiet', '--initial-branch=main');
  const canon = join(repo, 'world', 'current');
  mkdirSync(canon, { recursive: true });
  const lines = ['# 生态', '', ...Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? '' : `line ${String(i)} {`)), '}'];
  writeFileSync(join(canon, 'ecology.md'), `${lines.join('\n')}\n`);
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@fixture-gateway.invalid', 'commit', '--quiet', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  const edited = [...lines.slice(0, 6), 'inserted {', 'line 1 {', '}', '', ...lines.slice(6, 12), 'changed', ...lines.slice(13)];
  writeFileSync(join(canon, 'ecology.md'), `${edited.join('\n')}\n`);
  writeFileSync(join(canon, '新条目.md'), '新\n');
  const port = gitPort(repo, runProcess);
  const plain = await port.diff(base, ['world/current']);
  assert.ok(plain.ok, plain.ok ? '' : plain.error);
  assert.match(plain.value, /^index [0-9a-f]{40}\.\.[0-9a-f]{40}/mu);
  const config: ReadonlyArray<[string, string]> = [
    ['core.abbrev', '12'], ['diff.algorithm', 'patience'], ['diff.indentHeuristic', 'false'], ['diff.interHunkContext', '20'],
    ['core.quotePath', 'false'], ['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true'], ['diff.suppressBlankEmpty', 'true'],
  ];
  for (const [key, value] of config) git('config', key, value);
  const tuned = await port.diff(base, ['world/current']);
  assert.ok(tuned.ok, tuned.ok ? '' : tuned.error);
  assert.equal(sha256Bytes(Buffer.from(tuned.value, 'utf8')), sha256Bytes(Buffer.from(plain.value, 'utf8')));
  assert.equal(tuned.value, plain.value);
  // the reviewer command printed in pr-body.md reproduces the same bytes from the committed tree
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@fixture-gateway.invalid', 'commit', '--quiet', '-m', 'edit');
  const argv = APPROVAL_DIFF_COMMAND.replace('<merge-base>', base).split(' ').slice(1);
  assert.equal(execFileSync('git', ['-C', repo, ...argv], { encoding: 'utf8' }), plain.value);
  assert.ok(prBody(FINAL, 7, []).includes(`\`${APPROVAL_DIFF_COMMAND}\``));
  rmSync(repo, { recursive: true, force: true });
});
