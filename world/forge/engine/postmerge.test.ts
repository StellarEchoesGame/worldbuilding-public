import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeAttempt } from './merge.ts';
import { buildPostMerge, checkPostMerge, parsePostMerge, readPostMerge } from './postmerge.ts';
import { canonicalJson } from './seal.ts';
import { mergeHarness, type MergeHarness } from './testing/fake-assembler.ts';
import type { CanonEdit } from './tasks/merge-editor.ts';

async function merged(): Promise<{ h: MergeHarness; d8: string; sha: string; edit: CanonEdit }> {
  const h = await mergeHarness();
  h.decide({ pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: ['A:A-01'] });
  assert.equal((await h.run('10d-post-merge-freeze')).exitCode, 0);
  const a = mergeAttempt(h.ctx);
  const raw: unknown = JSON.parse(readFileSync(join(a.dir, 'edit.json'), 'utf8'));
  const e: unknown = Reflect.get(Object(raw), 'edit');
  const files: unknown = Reflect.get(Object(e), 'files');
  const scene: unknown = Reflect.get(Object(e), 'scene');
  const rxx: unknown = Reflect.get(Object(e), 'rxx');
  assert.ok(typeof scene === 'string' && Array.isArray(rxx) && typeof files === 'object' && files !== null);
  const edit: CanonEdit = { files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, String(v)])), scene, rxx: rxx.map(String) };
  return { h, d8: a.d8, sha: a.decisionSha256, edit };
}

test('10d post-merge.json: canonical bytes, stable across rebuilds, gate fields copied from freeze.json', async () => {
  const { h, d8, sha, edit } = await merged();
  const pinned = readPostMerge(h.ctx.paths, d8);
  assert.ok(pinned !== null && pinned.ok);
  const again = buildPostMerge(h.ctx, edit, sha);
  assert.ok(again.ok);
  assert.equal(canonicalJson(again.value), readFileSync(join(h.ctx.paths.merge, d8, 'post-merge.json'), 'utf8'));
  const freeze = h.ctx.freeze();
  assert.deepEqual(pinned.value.gate, {
    fact_table_sha256: freeze.sha256['fact-status.json'], regression_sha256: freeze.sha256['regression'], protocol_bundle_sha256: freeze.protocol_bundle_sha256,
    benchmark_version: 'v1', eligible_gate_families: ['Anthropic', 'Moonshot', 'OpenAI', 'xAI'], seed_key: `postmerge:${d8}`,
  });
  assert.deepEqual(Object.keys(pinned.value.files).sort(), [
    'BOOK.md', 'REVISION.md', 'reference/05-ecology-and-everyday.md', 'reference/07-register-and-creation.md', 'reference/09-scenes-and-people.md',
    'reference/CHANGES.md', 'reference/REFERENCE.md', 'reference/hashes.json', 'reference/manifest.json',
  ]);
  assert.equal(pinned.value.revision, '8.2');
  assert.equal(pinned.value.scene.chars, [...edit.scene].length);
  assert.deepEqual(parsePostMerge(JSON.parse(canonicalJson(pinned.value))), pinned);
  rmSync(h.dir, { recursive: true });
});

test('checkPostMerge: [] on the applied tree; an extra edit to 09 is reported; a changed fact-status.json does not move the pinned hash', async () => {
  const { h, d8, sha, edit } = await merged();
  const pinned = readPostMerge(h.ctx.paths, d8);
  assert.ok(pinned !== null && pinned.ok);
  assert.deepEqual(checkPostMerge(h.ctx, pinned.value), []);
  appendFileSync(join(h.world.repo, 'world/current/reference/09-scenes-and-people.md'), '多写的一句。\n');
  assert.deepEqual(checkPostMerge(h.ctx, pinned.value), ['file changed: reference/09-scenes-and-people.md']);
  writeFileSync(join(h.world.root, 'fact-status.json'), '{"facts":[]}\n');
  const rebuilt = buildPostMerge(h.ctx, edit, sha);
  assert.ok(rebuilt.ok);
  assert.equal(rebuilt.value.gate.fact_table_sha256, pinned.value.gate.fact_table_sha256);
  assert.equal(parsePostMerge({ ...pinned.value, kind: 'other' }).ok, false);
  assert.equal(readPostMerge(h.ctx.paths, '00000000'), null);
  rmSync(h.dir, { recursive: true });
});
