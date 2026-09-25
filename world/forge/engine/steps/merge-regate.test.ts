import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Family } from '../config.ts';
import { sha256Bytes } from '../marker.ts';
import { parseMergePointer } from '../merge.ts';
import { diskCanon, MERGE_BRANCH, mergeHarness, readRoundJson, type MergeHarness } from '../testing/fake-assembler.ts';

const R = 'rounds/R01';
const A_B = { pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: ['A:A-01', 'B:A-01'] };

function pick(r: { state: string; step: string | null; waitingFor: string | null; exitCode: number }): unknown {
  return { state: r.state, step: r.step, waitingFor: r.waitingFor, exitCode: r.exitCode };
}

function latestD8(h: MergeHarness): string {
  const files = [...h.sim.expected().keys()].filter((k) => /^rounds\/R01\/decision/u.test(k)).sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  return sha256Bytes(readFileSync(join(h.world.root, files.at(-1) ?? ''))).slice(0, 8);
}

function field(value: unknown, key: string): unknown {
  return Reflect.get(Object(value), key);
}

function judgeTasks(h: MergeHarness, prefix: string): string[] {
  return [...h.judges.values()].flatMap((r) => r.log().filter((c) => c.taskId.startsWith(prefix)).map((c) => `${c.taskId}#${c.attempt}`)).sort();
}

test('A+B facts with a contradicting judge → split → rewind to 09b, canon = main, no commit; redecide → 10a skip, 10b–10f under a new d8, old dir kept', async () => {
  const h = await mergeHarness();
  let first: Family | null = null;
  h.scripts.judge = (family, kind) => {
    if (kind !== 'regate') return 'no';
    first ??= family;
    return family === first ? 'yes' : 'no';
  };
  h.decide(A_B);
  const d1 = latestD8(h);
  assert.deepEqual(pick(await h.run()), { state: 'waiting', step: '09b-decision', waitingFor: 'decision', exitCode: 2 });
  const regate = readRoundJson(h, `${R}/merge/${d1}/regate.json`);
  assert.equal(field(regate, 'status'), 'split');
  const judges = field(regate, 'judges');
  assert.ok(Array.isArray(judges) && judges.length === 2);
  assert.deepEqual(judgeTasks(h, 'regate-').map((t) => t.replace(/-[A-Za-z]+-(\d)#1$/u, '-$1')).sort(), [`regate-${d1}-1`, `regate-${d1}-2`]);
  assert.deepEqual(diskCanon(h.world.repo), h.mainCanon());
  assert.deepEqual(h.ports.git.commits(MERGE_BRANCH), []);
  assert.equal(h.ctx.owner.decision('R01').state, 'superseded');
  assert.deepEqual(pick(await h.run()), { state: 'waiting', step: '09b-decision', waitingFor: 'decision', exitCode: 2 }, 'no new decision yet');

  h.redecide({ pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: ['A:A-01'] });
  const d2 = latestD8(h);
  assert.notEqual(d2, d1);
  assert.deepEqual(pick(await h.run()), { state: 'done', step: '10f-commit', waitingFor: null, exitCode: 0 });
  assert.ok(existsSync(join(h.ctx.paths.merge, d1, 'regate.json')), 'the failed attempt stays as evidence');
  assert.ok(!existsSync(join(h.ctx.paths.merge, d2, 'regate.json')), '10a skipped: facts only from the base');
  assert.ok(existsSync(join(h.ctx.paths.merge, d2, 'apply.json')));
  const pointer = parseMergePointer(readRoundJson(h, `${R}/merge.json`));
  assert.ok(pointer.ok);
  assert.equal(pointer.value.current, d2);
  const commits = h.ports.git.commits(MERGE_BRANCH);
  assert.equal(commits.length, 1);
  assert.ok(commits[0]?.paths.includes(`world/forge/${R}/merge/${d1}/regate.json`));
  assert.ok(h.editor.log().every((c) => c.taskId === `merge-${d2}`));
  rmSync(h.dir, { recursive: true });
});

test('re-gate: both judges yes → fail and rewind; both no → pass and the merge carries the donor fact', async () => {
  const h = await mergeHarness();
  h.scripts.judge = (_family, kind) => (kind === 'regate' ? 'yes' : 'no');
  h.decide(A_B);
  const d1 = latestD8(h);
  assert.equal((await h.run()).exitCode, 2);
  assert.equal(field(readRoundJson(h, `${R}/merge/${d1}/regate.json`), 'status'), 'fail');
  assert.deepEqual(diskCanon(h.world.repo), h.mainCanon());
  rmSync(h.dir, { recursive: true });

  const g = await mergeHarness();
  g.decide(A_B);
  const d = latestD8(g);
  assert.deepEqual(pick(await g.run()), { state: 'done', step: '10f-commit', waitingFor: null, exitCode: 0 });
  const regate = readRoundJson(g, `${R}/merge/${d}/regate.json`);
  assert.equal(field(regate, 'status'), 'pass');
  assert.deepEqual(field(regate, 'mechanical'), { ok: true, violations: [] });
  assert.match(JSON.stringify(field(regate, 'facts')), /"source_sentences":\["循环泵的节拍每到换班就慢下来。"\]/u);
  const scenes = diskCanon(g.world.repo)['world/current/reference/09-scenes-and-people.md'] ?? '';
  assert.match(scenes, /本场登记事实：R01-01、R01-02\n\n.*循环泵的节拍每到换班就慢下来。/u);
  rmSync(g.dir, { recursive: true });
});

test('re-gate: a void judge is replaced by the next family (n = 3); fewer than two verdicts → unverified, failed (5)', async () => {
  const h = await mergeHarness();
  let voided: Family | null = null;
  h.scripts.judge = (family, kind) => {
    if (kind !== 'regate') return 'no';
    voided ??= family;
    return family === voided ? 'void' : 'no';
  };
  h.decide(A_B);
  const d = latestD8(h);
  assert.equal((await h.run('10a-regate')).exitCode, 0);
  const judges = field(readRoundJson(h, `${R}/merge/${d}/regate.json`), 'judges');
  assert.ok(Array.isArray(judges));
  assert.deepEqual(judges.map((j) => [field(j, 'n'), field(j, 'status')]), [[1, 'void'], [2, 'ok'], [3, 'ok']]);
  rmSync(h.dir, { recursive: true });

  const g = await mergeHarness();
  g.scripts.judge = (_family, kind) => (kind === 'regate' ? 'void' : 'no');
  g.decide(A_B);
  const report = await g.run();
  assert.deepEqual(pick(report), { state: 'failed', step: '10a-regate', waitingFor: null, exitCode: 5 });
  assert.equal(field(readRoundJson(g, `${R}/merge/${latestD8(g)}/regate.json`), 'status'), 'unverified');
  rmSync(g.dir, { recursive: true });
});

test('post-merge gate: split continues (merge.json reasons postmerge_split); both yes → restore + rewind to 09b, no commit', async () => {
  const h = await mergeHarness();
  let first: Family | null = null;
  h.scripts.judge = (family, kind) => {
    if (kind !== 'postmerge') return 'no';
    first ??= family;
    return family === first ? 'yes' : 'no';
  };
  h.decide({ pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: ['A:A-01'] });
  assert.deepEqual(pick(await h.run()), { state: 'done', step: '10f-commit', waitingFor: null, exitCode: 0 });
  const d = latestD8(h);
  assert.equal(field(readRoundJson(h, `${R}/merge/${d}/postmerge-gate.json`), 'status'), 'split');
  assert.deepEqual(field(readRoundJson(h, `${R}/merge.json`), 'reasons'), ['postmerge_split']);
  assert.ok(judgeTasks(h, 'postmerge-').every((t) => t.startsWith(`postmerge-${d}-`)));
  rmSync(h.dir, { recursive: true });

  const g = await mergeHarness();
  g.scripts.judge = (_family, kind) => (kind === 'postmerge' ? 'yes' : 'no');
  g.decide({ pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: ['A:A-01'] });
  assert.deepEqual(pick(await g.run()), { state: 'waiting', step: '09b-decision', waitingFor: 'decision', exitCode: 2 });
  assert.equal(field(readRoundJson(g, `${R}/merge/${latestD8(g)}/postmerge-gate.json`), 'status'), 'fail');
  assert.deepEqual(diskCanon(g.world.repo), g.mainCanon(), 'snapshot restored');
  assert.deepEqual(g.ports.git.commits(MERGE_BRANCH), []);
  assert.equal(g.ctx.owner.decision('R01').state, 'superseded');
  rmSync(g.dir, { recursive: true });
});

test('re-gate outage: all judges void → unverified, failed (5); judges restored → the rerun calls afresh under -t2 ids and passes (void records kept)', async () => {
  const h = await mergeHarness();
  h.scripts.judge = (_family, kind) => (kind === 'regate' ? 'void' : 'no');
  h.decide(A_B);
  const d = latestD8(h);
  assert.deepEqual(pick(await h.run('10a-regate')), { state: 'failed', step: '10a-regate', waitingFor: null, exitCode: 5 });
  const first = readRoundJson(h, `${R}/merge/${d}/regate.json`);
  assert.equal(field(first, 'status'), 'unverified');
  assert.equal(field(first, 'attempts'), 1);
  const voidCalls = judgeTasks(h, 'regate-');
  assert.ok(voidCalls.length > 0 && voidCalls.every((t) => /^regate-[0-9a-f]{8}-[A-Za-z]+-\d#\d$/u.test(t)));

  h.scripts.judge = () => 'no';
  assert.deepEqual(pick(await h.run('10a-regate')), { state: 'done', step: '10a-regate', waitingFor: null, exitCode: 0 });
  const second = readRoundJson(h, `${R}/merge/${d}/regate.json`);
  assert.equal(field(second, 'status'), 'pass');
  assert.equal(field(second, 'attempts'), 2);
  const fresh = judgeTasks(h, 'regate-').filter((t) => !voidCalls.includes(t));
  assert.equal(fresh.length, 2);
  assert.ok(fresh.every((t) => /^regate-[0-9a-f]{8}-[A-Za-z]+-\d-t2#1$/u.test(t)));
  rmSync(h.dir, { recursive: true });
});

test('post-merge outage: unverified → failed (5), the rerun under -t2 ids continues to 10f', async () => {
  const h = await mergeHarness();
  h.scripts.judge = (_family, kind) => (kind === 'postmerge' ? 'void' : 'no');
  h.decide({ pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: ['A:A-01'] });
  const d = latestD8(h);
  assert.deepEqual(pick(await h.run()), { state: 'failed', step: '10e-post-merge-gate', waitingFor: null, exitCode: 5 });
  assert.equal(field(readRoundJson(h, `${R}/merge/${d}/postmerge-gate.json`), 'status'), 'unverified');
  h.scripts.judge = () => 'no';
  assert.deepEqual(pick(await h.run()), { state: 'done', step: '10f-commit', waitingFor: null, exitCode: 0 });
  const record = readRoundJson(h, `${R}/merge/${d}/postmerge-gate.json`);
  assert.deepEqual([field(record, 'status'), field(record, 'attempts')], ['pass', 2]);
  assert.ok(judgeTasks(h, 'postmerge-').some((t) => t.endsWith('-t2#1')));
  rmSync(h.dir, { recursive: true });
});

test('a gate pool of fewer than two families → status fail (mechanical), restore + rewind to 09b so the owner can redecide', async () => {
  const h = await mergeHarness();
  h.decide(A_B);
  const d = latestD8(h);
  // Step 5 voided three of the four gate families: only OpenAI is left.
  mkdirSync(h.ctx.paths.gate, { recursive: true });
  writeFileSync(join(h.ctx.paths.gate, 'llm.json'), JSON.stringify({ voided_families: ['Anthropic', 'Moonshot', 'xAI'].map((family) => ({ family, reason: 'void_call' })) }));
  const report = await h.run('10a-regate');
  assert.deepEqual(pick(report), { state: 'waiting', step: '09b-decision', waitingFor: 'decision', exitCode: 2 });
  const regate = readRoundJson(h, `${R}/merge/${d}/regate.json`);
  assert.equal(field(regate, 'status'), 'fail');
  assert.deepEqual(field(field(regate, 'mechanical'), 'violations'), ['gate pool has fewer than two families']);
  assert.deepEqual(judgeTasks(h, 'regate-'), []);
  assert.equal(h.ctx.owner.decision('R01').state, 'superseded');
  rmSync(h.dir, { recursive: true });
});
