import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readMarker } from '../marker.ts';
import { parseMergePointer } from '../merge.ts';
import { readPostMerge } from '../postmerge.ts';
import { canonicalJson } from '../seal.ts';
import { callLog } from '../testing/scripted.ts';
import { diskCanon, goodEditorReply, listOf, MERGE_BRANCH, mergeHarness, readRoundJson, type MergeHarness } from '../testing/fake-assembler.ts';
import { sha256Bytes } from '../marker.ts';

const R = 'rounds/R01';
const WC = 'world/current';
const SCENES = `${WC}/reference/09-scenes-and-people.md`;
const REGISTER = `${WC}/reference/07-register-and-creation.md`;
const ECOLOGY = `${WC}/reference/05-ecology-and-everyday.md`;
const TECH = `${WC}/reference/02-technology-and-infrastructure.md`;

function pick(r: { state: string; step: string | null; waitingFor: string | null; exitCode: number }): unknown {
  return { state: r.state, step: r.step, waitingFor: r.waitingFor, exitCode: r.exitCode };
}

function d8(h: MergeHarness): string {
  const m = readMarker(join(h.ctx.paths.markers, '09b-decision.json'));
  assert.ok(m !== null && m.ok);
  const sha = Object.values(m.value.inputs)[0] ?? '';
  return sha.slice(0, 8);
}

/** d8 of the newest decision file (before or after 09b pinned it). */
function d8Of(h: MergeHarness): string {
  const expected = [...h.sim.expected().entries()].filter(([k]) => /^rounds\/R01\/decision/u.test(k)).map(([k]) => k).sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  const file = expected.at(-1) ?? '';
  return sha256Bytes(readFileSync(join(h.world.root, file))).slice(0, 8);
}

function markerResult(h: MergeHarness, step: string): string | null {
  const m = readMarker(join(h.ctx.paths.markers, `${step}.json`));
  return m === null || !m.ok ? null : m.value.result;
}

test('single-candidate decision: no regate, 07 rows byte-exact, one index line, manifest 8.2, BOOK unchanged, notes, exact commit, merge.json', async () => {
  const h = await mergeHarness();
  h.decide({ pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: ['A:A-01', 'A:A-02'] });
  assert.deepEqual(pick(await h.run()), { state: 'done', step: '10f-commit', waitingFor: null, exitCode: 0 });
  const dir = `${R}/merge/${d8(h)}`;
  assert.equal(markerResult(h, '10a-regate'), 'skip');
  assert.ok(!existsSync(join(h.world.root, dir, 'regate.json')));
  assert.equal(h.judges.get('Anthropic')?.log().filter((c) => c.taskId.startsWith('regate-')).length, 0);
  const main = h.mainCanon();
  const now = diskCanon(h.world.repo);
  const rows = [
    '| R01-01 | SHIP | 邻里的留饭签挂在食堂门口的铁钩上 | 已选地方事实 | 05-ecology-and-everyday.md | 无 | 写成全舰通行的规矩 | R01 |',
    '| R01-02 | SHIP | 冷凝管的滤网由夜班维修工更换 | 已选地方事实 | 02-technology-and-infrastructure.md | F03 | 写成全舰通行的规矩 | R01 |',
  ];
  const c = h.ctx.protocol.merge;
  assert.equal(now[REGISTER], `${main[REGISTER]}\n${c.pointer07}\n\n${c.heading8}\n\n${c.tableHeader8}\n${rows.join('\n')}\n`);
  assert.equal(now[ECOLOGY], `${main[ECOLOGY]}\n现场：见09 §R01（R01-01）\n`);
  assert.equal(now[TECH], `${main[TECH]}\n现场：见09 §R01（R01-02）\n`);
  const scene = '## R01｜留饭签\n\n地点：SHIP｜时间锚：任一常态日｜路径依赖：标准成功路径｜地位：状态与路径实例·示例｜本场登记事实：R01-01、R01-02\n\n'
    + '温芮在第三邻里的公共桌边核对配给簿。邻里的留饭签挂在食堂门口的铁钩上。林澈说冷凝管今晚要换滤网。两个人一起把菌毯卷好，送回培养架。\n';
  assert.equal(now[SCENES], `${c.preamble09}\n\n${scene}`);
  const manifest: unknown = JSON.parse(now[`${WC}/reference/manifest.json`] ?? '');
  assert.equal(Reflect.get(Object(manifest), 'revision'), '8.2');
  assert.deepEqual(listOf(manifest, 'files').at(-1), '09-scenes-and-people.md');
  assert.equal(listOf(manifest, 'header')[0], '# 群星回响 · 世界设定参考集 8.2');
  assert.deepEqual(listOf(manifest, 'header').slice(-c.manifestHeader.length), c.manifestHeader);
  assert.equal(now[`${WC}/BOOK.md`], main[`${WC}/BOOK.md`]);
  assert.equal(now[`${WC}/reference/CHANGES.md`], `${main[`${WC}/reference/CHANGES.md`]}\n## 8.2 样本现场 R01\n本场登记事实：R01-01、R01-02\n`);
  assert.equal(now[`${WC}/REVISION.md`], `${main[`${WC}/REVISION.md`]}\n## 8.2 样本现场 R01\n本场登记事实：R01-01、R01-02\n`);
  const changed = Object.keys(now).filter((p) => now[p] !== main[p]).sort();
  assert.deepEqual(changed, [`${WC}/REVISION.md`, TECH, ECOLOGY, REGISTER, `${WC}/reference/CHANGES.md`, `${WC}/reference/REFERENCE.md`, SCENES, `${WC}/reference/hashes.json`, `${WC}/reference/manifest.json`].sort());
  assert.deepEqual(h.assembler.revisions(), ['8.2']);
  const commits = h.ports.git.commits(MERGE_BRANCH);
  assert.equal(commits.length, 1);
  assert.equal(commits[0]?.message, 'feat: add sample scene R01, reference 8.2 (#7)');
  const roundFiles = ['apply.json', 'edit.json', 'mergecheck.json', 'plan.json', 'post-merge.json', 'postmerge-gate.json'].map((f) => `world/forge/${dir}/${f}`);
  assert.deepEqual(commits[0]?.paths, [...changed, ...roundFiles, `world/forge/${R}/merge.json`].sort());
  assert.deepEqual(h.ports.git.pushes(), [MERGE_BRANCH]);
  const pointer = parseMergePointer(readRoundJson(h, `${R}/merge.json`));
  assert.ok(pointer.ok);
  assert.deepEqual({ current: pointer.value.current, revision: pointer.value.revision, reasons: pointer.value.reasons, status: pointer.value.status }, { current: d8(h), revision: '8.2', reasons: [], status: 'merged_on_branch' });
  assert.deepEqual(readRoundJson(h, `${dir}/mergecheck.json`), { ok: true, violations: [] });
  const apply = readRoundJson(h, `${dir}/apply.json`);
  assert.equal(Reflect.get(Object(apply), 'status'), 'applied');
  assert.deepEqual(Object.keys(Object(Reflect.get(Object(apply), 'written'))), changed.map((p) => p.slice(WC.length + 1)), 'apply.json hashes every changed path, assembler outputs included');
  const plan = readRoundJson(h, `${dir}/plan.json`);
  assert.equal(Reflect.get(Object(plan), 'editor'), 'llm');
  assert.deepEqual(callLog(h.editor), [`merge-${d8(h)}#1`]);
  const post = readPostMerge(h.ctx.paths, d8(h));
  assert.ok(post !== null && post.ok);
  assert.equal(readFileSync(join(h.world.root, dir, 'post-merge.json'), 'utf8'), canonicalJson(post.value));
  assert.equal(post.value.revision, '8.2');
  assert.deepEqual(post.value.scene.rxx, ['R01-01', 'R01-02']);
  assert.equal(post.value.gate.seed_key, `postmerge:${d8(h)}`);
  const gate = readRoundJson(h, `${dir}/postmerge-gate.json`);
  assert.equal(Reflect.get(Object(gate), 'status'), 'pass');
  rmSync(h.dir, { recursive: true });
});

test('pick = none: 10a–10f skip, no merge directory, no merge.json, no commit', async () => {
  const h = await mergeHarness();
  h.decide({ pick: 'none', reason: '平', fav: 'A', publish: 'no', facts: [] });
  assert.deepEqual(pick(await h.run()), { state: 'done', step: '10f-commit', waitingFor: null, exitCode: 0 });
  for (const step of ['10a-regate', '10b-merge-edit', '10c-apply', '10d-post-merge-freeze', '10e-post-merge-gate', '10f-commit']) assert.equal(markerResult(h, step), 'skip', step);
  assert.ok(!existsSync(h.ctx.paths.merge));
  assert.ok(!existsSync(join(h.ctx.paths.dir, 'merge.json')));
  assert.deepEqual(h.ports.git.commits(MERGE_BRANCH), []);
  assert.deepEqual(diskCanon(h.world.repo), h.mainCanon());
  rmSync(h.dir, { recursive: true });
});

test('a base or fact donor whose champion pair was trial → regate.json status trial, no calls, no canon write, rewind to 09b', async () => {
  const h = await mergeHarness({ trial: ['B'] });
  h.decide({ pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: ['A:A-01', 'B:A-01'] });
  const first = d8Of(h);
  assert.deepEqual(pick(await h.run()), { state: 'waiting', step: '09b-decision', waitingFor: 'decision', exitCode: 2 });
  const record = readRoundJson(h, `${R}/merge/${first}/regate.json`);
  assert.equal(Reflect.get(Object(record), 'status'), 'trial');
  assert.deepEqual(listOf(record, 'trial_labels'), ['B']);
  for (const router of h.judges.values()) assert.deepEqual(router.log(), []);
  assert.deepEqual(diskCanon(h.world.repo), h.mainCanon());
  assert.equal(markerResult(h, '09b-decision'), null, '09b moved to markers/stale');
  assert.ok(existsSync(join(h.ctx.paths.markers, 'stale', '1', '10a-regate.json')));
  assert.equal(h.ctx.owner.decision('R01').state, 'superseded');
  rmSync(h.dir, { recursive: true });
});

test('editor: an invalid first plan is retried with the error quoted; two failing plans → fallbackPlan, flagged editor fallback', async () => {
  const h = await mergeHarness();
  h.scripts.editor = (prompt, call) => (call === 1 ? '不是 JSON' : goodEditorReply(prompt));
  h.decide({ pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: ['A:A-01'] });
  assert.equal((await h.run('10b-merge-edit')).exitCode, 0);
  const dir = `${R}/merge/${d8Of(h)}`;
  const plan = readRoundJson(h, `${dir}/plan.json`);
  assert.equal(Reflect.get(Object(plan), 'editor'), 'llm');
  assert.equal(Reflect.get(Object(plan), 'attempts'), 2);
  const second = h.editor.log()[1]?.prompt ?? '';
  assert.match(second, /上一次的输出没有通过检查：/u);
  rmSync(h.dir, { recursive: true });

  const g = await mergeHarness();
  const reorder = (prompt: string): string => goodEditorReply(prompt).replace('"index":1', '"index":9').replace('"index":2', '"index":1').replace('"index":9', '"index":2');
  g.scripts.editor = (prompt) => reorder(prompt);
  g.decide({ pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: ['A:A-01'] });
  assert.deepEqual(pick(await g.run()), { state: 'done', step: '10f-commit', waitingFor: null, exitCode: 0 });
  const gdir = `${R}/merge/${d8Of(g)}`;
  assert.equal(Reflect.get(Object(readRoundJson(g, `${gdir}/plan.json`)), 'editor'), 'fallback');
  assert.equal(Reflect.get(Object(readRoundJson(g, `${gdir}/edit.json`)), 'editor'), 'fallback');
  assert.match(g.editor.log()[1]?.prompt ?? '', /mergecheck: .*base sentence out of order/u);
  assert.equal(Reflect.get(Object(readRoundJson(g, `${gdir}/edit.json`)), 'title'), '母舰 · 邻里常态日');
  rmSync(g.dir, { recursive: true });
});
