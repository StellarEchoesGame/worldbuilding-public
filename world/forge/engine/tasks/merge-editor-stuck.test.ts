import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '../json.ts';
import { sha256Bytes } from '../marker.ts';
import { mergeHarness, readRoundJson, type MergeHarness } from '../testing/fake-assembler.ts';

/**
 * Decisions no editor plan can merge (review finding: 10b's fallback failed mergecheck and the round dead-ended at
 * exit 5): an unterminated base line renders cleanly now; a donor quote no single sentence carries and a malformed
 * 07 cell rewind at 10a (`regate_failed:<d8>`), so the owner can supersede the decision.
 */

const R = 'rounds/R01';

/** Rewrites one harness submission's writer text (submission body and delta JSON alike) before the run. */
function editSubmission(h: MergeHarness, id: string, from: string, to: string): void {
  const path = join(h.ctx.paths.submissions, `${id}.json`);
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(isRecord(raw) && typeof raw['text'] === 'string');
  assert.ok(raw['text'].includes(from), `${id} contains ${from}`);
  writeFileSync(path, `${JSON.stringify({ ...raw, text: raw['text'].replace(from, to) }, null, 2)}\n`);
}

function latestD8(h: MergeHarness): string {
  const files = [...h.sim.expected().keys()].filter((k) => /^rounds\/R01\/decision/u.test(k)).sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  return sha256Bytes(readFileSync(join(h.world.root, files.at(-1) ?? ''))).slice(0, 8);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function outcome(r: { state: string; step: string | null; waitingFor: string | null; exitCode: number; detail?: string | null }): unknown {
  return { state: r.state, step: r.step, waitingFor: r.waitingFor, exitCode: r.exitCode };
}

test('a base line without a terminator before a single newline: the void editor falls back to a clean plan and the merge lands', async () => {
  const h = await mergeHarness();
  editSubmission(h, 'W1', '核对配给簿。邻里', '核对配给簿\n邻里');
  h.scripts.editor = () => 'no json';
  h.decide({ pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: ['A:A-01'] });
  const d8 = latestD8(h);
  assert.deepEqual(outcome(await h.run()), { state: 'done', step: '10f-commit', waitingFor: null, exitCode: 0 });
  assert.equal(field(readRoundJson(h, `${R}/merge/${d8}/edit.json`), 'editor'), 'fallback');
  const scene = h.canon()['world/current/reference/09-scenes-and-people.md'] ?? '';
  assert.match(scene, /核对配给簿\n\n邻里的留饭签/u, 'the unterminated sentence ends its paragraph');
  rmSync(h.dir, { recursive: true });
});

test('a donor quote spanning two sentences: 10a writes regate fail with no judge call and rewinds; the owner can redecide', async () => {
  const h = await mergeHarness();
  editSubmission(h, 'W2', '"source_quote":"循环泵的节拍每到换班就慢下来"', '"source_quote":"就慢下来。住户听见节拍"');
  h.scripts.editor = () => 'not json';
  h.decide({ pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: ['A:A-01', 'B:A-01'] });
  const d1 = latestD8(h);
  const r = await h.run();
  assert.deepEqual(outcome(r), { state: 'waiting', step: '09b-decision', waitingFor: 'decision', exitCode: 2 });
  const regate = readRoundJson(h, `${R}/merge/${d1}/regate.json`);
  assert.equal(field(regate, 'status'), 'fail');
  assert.deepEqual(field(field(regate, 'mechanical'), 'violations'), ['R01-02: no donor sentence carries the whole source quote']);
  assert.deepEqual(field(regate, 'judges'), []);
  assert.ok([...h.judges.values()].every((j) => j.log().length === 0), 'no judge call');
  assert.equal(h.editor.log().length, 0, 'no editor call');
  assert.deepEqual(h.canon(), h.mainCanon());
  assert.equal(h.ctx.owner.decision('R01').state, 'superseded');
  h.redecide({ pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: ['A:A-01'] });
  assert.deepEqual(outcome(await h.run()), { state: 'done', step: '10f-commit', waitingFor: null, exitCode: 0 });
  rmSync(h.dir, { recursive: true });
});

test('a bar in a base-only fact\'s misuse: 10a (otherwise a skip) writes regate fail and rewinds instead of 10b failing on every rerun', async () => {
  const h = await mergeHarness();
  editSubmission(h, 'W1', '写成全舰通行的规矩', '写成全舰|通行的规矩');
  h.decide({ pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: ['A:A-01'] });
  const d1 = latestD8(h);
  assert.deepEqual(outcome(await h.run()), { state: 'waiting', step: '09b-decision', waitingFor: 'decision', exitCode: 2 });
  const regate = readRoundJson(h, `${R}/merge/${d1}/regate.json`);
  assert.equal(field(regate, 'status'), 'fail');
  assert.deepEqual(field(field(regate, 'mechanical'), 'violations'), ['R01-01: misuse contains | or a line break']);
  assert.equal(h.ctx.owner.decision('R01').state, 'superseded');
  h.redecide({ pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: [] });
  assert.deepEqual(outcome(await h.run()), { state: 'done', step: '10f-commit', waitingFor: null, exitCode: 0 });
  rmSync(h.dir, { recursive: true });
});
