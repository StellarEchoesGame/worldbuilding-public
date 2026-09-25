import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Bytes } from '../marker.ts';
import { mergeAttempt, mergecheckWith, mergeConstants, restoreCanon, runMergecheck } from '../merge.ts';
import { diskCanon, MERGE_BRANCH, mergeHarness, readRoundJson, type MergeHarness } from '../testing/fake-assembler.ts';

const R = 'rounds/R01';
const SINGLE = { pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: ['A:A-01'] };

function pick(r: { state: string; step: string | null; waitingFor: string | null; exitCode: number }): unknown {
  return { state: r.state, step: r.step, waitingFor: r.waitingFor, exitCode: r.exitCode };
}

function d8(h: MergeHarness): string {
  return sha256Bytes(readFileSync(join(h.world.root, R, 'decision.json'))).slice(0, 8);
}

function field(value: unknown, key: string): unknown {
  return Reflect.get(Object(value), key);
}

test('crash in the middle of 10c → the rerun restores from base_sha first, then re-applies (same canon as an uninterrupted run)', async () => {
  const clean = await mergeHarness();
  clean.decide(SINGLE);
  assert.equal((await clean.run()).exitCode, 0);
  const expected = diskCanon(clean.world.repo);
  rmSync(clean.dir, { recursive: true });

  let crash = true;
  const h = await mergeHarness({
    assembler: (inner) => ({
      assemble: (rev) => {
        if (!crash) return inner.assemble(rev);
        crash = false;
        return Promise.reject(new Error('killed inside the assembler'));
      },
    }),
  });
  h.decide(SINGLE);
  await assert.rejects(h.run(), /killed inside the assembler/u);
  const half = diskCanon(h.world.repo);
  assert.notEqual(half['world/current/reference/09-scenes-and-people.md'], undefined, 'edit files were written before the crash');
  writeFileSync(join(h.world.repo, 'world/current/reference/stray.md'), '崩溃前留下的文件\n');
  unlinkSync(join(h.world.root, '.forge.lock'));
  assert.deepEqual(pick(await h.run()), { state: 'done', step: '10f-commit', waitingFor: null, exitCode: 0 });
  const apply = readRoundJson(h, `${R}/merge/${d8(h)}/apply.json`);
  const restored = field(apply, 'restored');
  assert.ok(Array.isArray(restored) && restored.includes('reference/09-scenes-and-people.md') && restored.includes('reference/stray.md'));
  assert.deepEqual(diskCanon(h.world.repo), expected);
  assert.equal(h.ports.git.commits(MERGE_BRANCH).length, 1);
  rmSync(h.dir, { recursive: true });
});

test('fake assembler altering base_book_sha256 → restored from base_sha, apply.json failed, exit 5', async () => {
  const h = await mergeHarness({ faults: { alterBaseBookSha256: true, alsoWrite: {} } });
  h.decide(SINGLE);
  assert.deepEqual(pick(await h.run()), { state: 'failed', step: '10c-apply', waitingFor: null, exitCode: 5 });
  const apply = readRoundJson(h, `${R}/merge/${d8(h)}/apply.json`);
  assert.equal(field(apply, 'status'), 'failed');
  assert.deepEqual(field(apply, 'reasons'), ['hashes.json base_book_sha256 differs from base_sha']);
  assert.deepEqual(field(apply, 'changed'), []);
  assert.ok(!Object.hasOwn(Object(field(apply, 'written')), 'reference/REFERENCE.md'), 'assembler outputs are hashed only for an applied record');
  assert.deepEqual(diskCanon(h.world.repo), h.mainCanon());
  assert.deepEqual(h.ports.git.commits(MERGE_BRANCH), []);
  rmSync(h.dir, { recursive: true });
});

test('an assembler that writes an extra file → mergecheck reports it, restored (the extra file removed), exit 5', async () => {
  const h = await mergeHarness({ faults: { alterBaseBookSha256: false, alsoWrite: { 'reference/checks.json': '{}\n' } } });
  h.decide(SINGLE);
  assert.deepEqual(pick(await h.run()), { state: 'failed', step: '10c-apply', waitingFor: null, exitCode: 5 });
  const dir = `${R}/merge/${d8(h)}`;
  assert.deepEqual(field(readRoundJson(h, `${dir}/apply.json`), 'reasons'), ['mergecheck: unexpected change: reference/checks.json']);
  assert.deepEqual(readRoundJson(h, `${dir}/mergecheck.json`), { ok: false, violations: ['unexpected change: reference/checks.json'] });
  assert.deepEqual(diskCanon(h.world.repo), h.mainCanon());
  rmSync(h.dir, { recursive: true });
});

test('crash after 10c → the rerun resumes at 10d and makes one commit; a push failure is blocked (4), the rerun pushes the same commit', async () => {
  const h = await mergeHarness();
  h.decide(SINGLE);
  assert.equal((await h.run('10c-apply')).exitCode, 0);
  const applied = diskCanon(h.world.repo);
  h.ports.git.failNext('push', 1);
  assert.deepEqual(pick(await h.run()), { state: 'blocked', step: '10f-commit', waitingFor: null, exitCode: 4 });
  assert.equal(h.ports.git.commits(MERGE_BRANCH).length, 1);
  assert.deepEqual(h.ports.git.pushes(), []);
  assert.deepEqual(pick(await h.run()), { state: 'done', step: '10f-commit', waitingFor: null, exitCode: 0 });
  assert.equal(h.ports.git.commits(MERGE_BRANCH).length, 1);
  assert.deepEqual(h.ports.git.pushes(), [MERGE_BRANCH]);
  assert.deepEqual(diskCanon(h.world.repo), applied);
  assert.deepEqual(h.assembler.revisions(), ['8.2']);
  rmSync(h.dir, { recursive: true });
});

test('10a refuses a canon change a merge cannot make (failed), restoreCanon puts back edits, deletions and new files', async () => {
  const h = await mergeHarness();
  h.decide(SINGLE);
  appendFileSync(join(h.world.repo, 'world/current/BOOK.md'), '手改。\n');
  assert.deepEqual(pick(await h.run()), { state: 'failed', step: '10a-regate', waitingFor: null, exitCode: 5 });
  unlinkSync(join(h.world.repo, 'world/current/reference/08-cross-system-cases.md'));
  writeFileSync(join(h.world.repo, 'world/current/reference/new.md'), '新文件\n');
  const restored = await restoreCanon(h.ctx, mergeAttempt(h.ctx).baseSha);
  assert.deepEqual(restored, { ok: true, value: ['BOOK.md', 'reference/08-cross-system-cases.md', 'reference/new.md'] });
  assert.deepEqual(diskCanon(h.world.repo), h.mainCanon());
  rmSync(h.dir, { recursive: true });
});

test('runMergecheck on an untouched tree reports the missing scene; an unknown base ref is an error', async () => {
  const h = await mergeHarness();
  h.decide(SINGLE);
  assert.equal((await h.run('09b-decision')).exitCode, 0);
  const d = { round: 'R01', baseLabel: 'A', title: '留饭签', rows: ['SHIP'], registered: [{ rxx: 'R01-01', label: 'A', factId: 'A-01' }] };
  const r = await runMergecheck(h.ctx, d, 'main');
  assert.ok(r.ok);
  assert.equal(r.value.ok, false);
  assert.ok(r.value.violations.includes('09: no scene appended'));
  const env = { root: h.world.root, repo: h.world.repo, git: h.ctx.ports.git, constants: mergeConstants(h.ctx.protocol), rowIds: ['SHIP'] };
  assert.deepEqual(await mergecheckWith(env, d, 'no-such-ref'), { ok: false, error: 'unknown git ref no-such-ref' });
  rmSync(h.dir, { recursive: true });
});

test('a hand edit of an untouched 01–06 file after 10c → 10d failed (5); a new 01–06 file after 10e → 10f failed (5); no commit either way', async () => {
  const h = await mergeHarness();
  h.decide(SINGLE);
  assert.equal((await h.run('10c-apply')).exitCode, 0);
  appendFileSync(join(h.world.repo, 'world/current/reference/01-space-and-history.md'), '\n手改的新规则：舰上禁止饮酒。\n');
  const report = await h.run();
  assert.deepEqual(pick(report), { state: 'failed', step: '10d-post-merge-freeze', waitingFor: null, exitCode: 5 });
  assert.match(report.detail ?? '', /reference\/01-space-and-history\.md/u);
  assert.ok(!existsSync(join(h.world.root, R, 'merge', d8(h), 'post-merge.json')));
  assert.deepEqual(h.ports.git.commits(MERGE_BRANCH), []);
  rmSync(h.dir, { recursive: true });

  const g = await mergeHarness();
  g.decide(SINGLE);
  assert.equal((await g.run('10e-post-merge-gate')).exitCode, 0);
  const stray = join(g.world.repo, 'world/current/reference/06-new-rules.md');
  writeFileSync(stray, '# 新规则\n\n凭空加的正典。\n');
  const failed = await g.run();
  assert.deepEqual(pick(failed), { state: 'failed', step: '10f-commit', waitingFor: null, exitCode: 5 });
  assert.match(failed.detail ?? '', /reference\/06-new-rules\.md/u);
  assert.deepEqual(g.ports.git.commits(MERGE_BRANCH), []);
  unlinkSync(stray);
  assert.deepEqual(pick(await g.run()), { state: 'done', step: '10f-commit', waitingFor: null, exitCode: 0 });
  assert.ok(g.ports.git.commits(MERGE_BRANCH)[0]?.paths.every((p) => !p.includes('06-new-rules')));
  rmSync(g.dir, { recursive: true });
});

test('an assembler output edited after 10c → 10d failed (5) naming it, nothing pinned; put back → 10d done; apply.json hashes both outputs', async () => {
  const h = await mergeHarness();
  h.decide(SINGLE);
  assert.equal((await h.run('10c-apply')).exitCode, 0);
  const wc = (rel: string): string => join(h.world.repo, 'world/current', rel);
  const written = field(readRoundJson(h, `${R}/merge/${d8(h)}/apply.json`), 'written');
  for (const rel of ['reference/REFERENCE.md', 'reference/hashes.json']) assert.equal(field(written, rel), sha256Bytes(readFileSync(wc(rel))), rel);
  const post = join(h.world.root, R, 'merge', d8(h), 'post-merge.json');
  const edits: Array<[string, string]> = [['reference/REFERENCE.md', 'x'], ['reference/hashes.json', '\n']];
  for (const [rel, extra] of edits) {
    const bytes = readFileSync(wc(rel));
    appendFileSync(wc(rel), extra);
    const report = await h.run('10d-post-merge-freeze');
    assert.deepEqual(pick(report), { state: 'failed', step: '10d-post-merge-freeze', waitingFor: null, exitCode: 5 }, rel);
    assert.ok((report.detail ?? '').includes(`world/current changed since 10c: ${rel}`), report.detail ?? '');
    assert.ok(!existsSync(post), rel);
    writeFileSync(wc(rel), bytes);
  }
  assert.equal((await h.run('10d-post-merge-freeze')).exitCode, 0);
  assert.ok(existsSync(post));
  assert.deepEqual(h.ports.git.commits(MERGE_BRANCH), []);
  rmSync(h.dir, { recursive: true });
});
