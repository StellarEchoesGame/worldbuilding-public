import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mergeCommand, postMergeCommand } from '../../../engine/cli-merge.ts';
import { roundCommand } from '../../../engine/cli-round.ts';
import { readArray, readString } from '../../../engine/json.ts';
import { sha256Bytes } from '../../../engine/marker.ts';
import { readOwnerLog } from '../../../engine/owner-inputs.ts';
import { readStatus } from '../../../engine/runner.ts';
import { FIXTURE_GATEWAY_HOST } from '../../../engine/testing/fixture-world.ts';
import { deps, must, readObject, ROUND, world, type World } from '../../../engine/testing/round-script.ts';
import { formActions, formFields, inputNamesWithValue, inputValues, redirectError, startServer, type Page, type UiServer } from './server.ts';

/*
 * Walk-through on the built UI server: the scripted round of engine/testing/round-script.ts (every writer registers one
 * fact) from the protocol approval to 12b-diff-approval, like engine/steps/merge-pipeline.test.ts, with every owner
 * action posted to the server (protocol, topic, audit, decision with facts from two candidates, diff approval) and the
 * engine driven in-process through the CLI command functions. The re-gate passes, so the redecision stays refused.
 * Every page of the walk answers 200 with no gateway host and no UI token.
 */

const PID = 6201;
let x: World;
let server: UiServer;
let root: string;
const dir = (): string => join(root, 'rounds', ROUND);

before(async () => {
  x = world({ claims: true });
  root = x.w.root;
  server = await startServer({ dataDir: root, now: () => x.ports.clock.now() });
});

after(async () => {
  await server.stop();
  rmSync(x.dir, { recursive: true, force: true });
});

async function post(path: string, form: Readonly<Record<string, string | readonly string[]>>): Promise<Page> {
  const page = await server.post(path, form);
  x.ports.clock.advance(1000);
  assert.equal(page.status, 303, `${path}: ${page.status} ${page.text.slice(0, 200)}`);
  assert.equal(redirectError(page.location), null, `${path}: ${page.location ?? ''}`);
  return page;
}

async function run(argv: readonly string[]): Promise<number> {
  return roundCommand(argv, deps(x, PID), x.at);
}

/** Pages GET during the walk (path → status); the last test checks the list covers every section. */
const walked = new Map<string, number>();

async function page(path: string): Promise<Page> {
  const p = await server.get(path);
  walked.set(path, p.status);
  assert.equal(p.status, 200, `${path}: ${p.status} ${p.location ?? ''} ${p.text.slice(0, 300)}`);
  assert.equal(p.text.includes(FIXTURE_GATEWAY_HOST), false, `${path} shows the gateway host`);
  assert.equal(p.text.includes(server.token), false, `${path} shows the UI token`);
  return p;
}

function labelOf(submission: string): string {
  return Object.entries(readObject(join(dir(), 'labels.json'))).find(([, v]) => v === submission)?.[0] ?? '';
}

test('walk to 09b: protocol, topic, audit and decision posted through the server; 总览 选题 轮次 盲审 决策 pages answer 200', async () => {
  await page('/');
  await page('/rounds');
  assert.equal(await run(['start', ROUND]), 2, x.logs.join('\n'));
  const bench = await page('/benchmark');
  await post('/api/protocol/approve', { sha256: inputValues(bench.text, 'sha256').at(-1) ?? '' });
  assert.equal(await run(['start', ROUND]), 2, x.logs.join('\n'));
  await page('/topic');
  const topic = await page(`/topic/${ROUND}`);
  const top = readArray(readObject(join(dir(), 'topic-offer.json')), 'top3')?.[0];
  assert.ok(formActions(topic.text).includes(`/api/rounds/${ROUND}/topic`));
  await post(`/api/rounds/${ROUND}/topic`, { row_id: readString(top, 'row_id') ?? '', layer: readString(top, 'layer') ?? '' });
  await page(`/topic/${ROUND}`);
  await page('/game-need');
  assert.equal(await run(['run', ROUND]), 2, x.logs.join('\n'));
  const audit = await page(`/rounds/${ROUND}/audit`);
  const pairIds = inputNamesWithValue(audit.text, 'left');
  assert.ok(pairIds.length >= 2);
  await post(`/api/rounds/${ROUND}/audit`, Object.fromEntries(pairIds.map((id) => [id, 'left'])));
  assert.equal(await run(['run', ROUND]), 2, x.logs.join('\n'));
  await page(`/rounds/${ROUND}/decide`);
  const base = labelOf('W1');
  const donor = labelOf('W2-r2');
  await post(`/api/rounds/${ROUND}/decision`, { pick: base, reason: '平', fav: base, publish: 'no', facts: [`${base}:A-01`, `${donor}:A-01`] });
  await page(`/rounds/${ROUND}`);
  assert.equal(await run(['run', ROUND, '--until', '09b-decision']), 0, x.logs.join('\n'));
});

test('the redecision stays refused while the round\'s gate record is pass (10a passed, merged, waiting at 12b)', async () => {
  assert.equal(await mergeCommand([ROUND], deps(x, PID), x.at), 0, x.logs.join('\n'));
  const d8 = sha256Bytes(readFileSync(join(dir(), 'decision.json'))).slice(0, 8);
  assert.equal(readObject(join(dir(), 'merge', d8, 'regate.json'))['status'], 'pass');
  assert.equal(await postMergeCommand(['--post-merge', ROUND], deps(x, PID), x.at), 0, x.logs.join('\n'));
  assert.equal(await run(['run', ROUND]), 2, x.logs.join('\n'));
  const st = must(readStatus(root, ROUND));
  assert.deepEqual([st.step, st.waiting_for], ['12b-diff-approval', 'diff_approval']);
  const view = await page(`/rounds/${ROUND}/redecide`);
  assert.equal(formActions(view.text).includes(`/api/rounds/${ROUND}/redecision`), false);
  const base = labelOf('W1');
  const p = await server.post(`/api/rounds/${ROUND}/redecision`, { pick: base, reason: '平', fav: base, publish: 'no', facts: [`${base}:A-01`] });
  x.ports.clock.advance(1000);
  assert.match(redirectError(p.location) ?? '', /没有未通过的过门记录/u);
});

test('定稿: the diff approval POST logs diff_approved with the SHA-256 the page showed; the engine then finishes the round', async () => {
  const final = await page(`/rounds/${ROUND}/final`);
  const forms = formFields(final.text, `/api/rounds/${ROUND}/diff-approval`);
  assert.equal(forms.length, 1);
  const shown = forms[0]?.['sha256'] ?? '';
  assert.equal(shown, readString(readObject(join(dir(), 'final.json')), 'approval_diff_sha256'));
  assert.equal(shown, sha256Bytes(readFileSync(join(dir(), 'approval.diff'))));
  const stale = await server.post(`/api/rounds/${ROUND}/diff-approval`, { sha256: '0'.repeat(64) });
  x.ports.clock.advance(1000);
  assert.match(redirectError(stale.location) ?? '', /定稿差异已经变化/u, 'a SHA-256 other than the shown diff is refused');
  const p = await post(`/api/rounds/${ROUND}/diff-approval`, { sha256: shown });
  assert.equal(p.location, `/rounds/${ROUND}/final`);
  const last = must(readOwnerLog(root)).at(-1);
  assert.deepEqual([last?.action, last?.round, last?.sha256, last?.file], ['diff_approved', ROUND, shown, `rounds/${ROUND}/approval.diff`]);
  const approved = await page(`/rounds/${ROUND}/final`);
  assert.equal(formFields(approved.text, `/api/rounds/${ROUND}/diff-approval`).length, 0, 'no second approval form');
  assert.equal(await run(['run', ROUND]), 0, x.logs.join('\n'));
  assert.equal(must(readStatus(root, ROUND)).state, 'done');
});

test('walk: every section of the nav answers 200 on the finished fixture round (校准 基准 配置 镜像 included)', async () => {
  for (const path of ['/', '/topic', `/topic/${ROUND}`, '/rounds', `/rounds/${ROUND}`, `/rounds/${ROUND}/final`, `/rounds/${ROUND}/redecide`, '/calibration', '/benchmark', '/benchmark/v1', '/config', '/mirror', '/game-need']) {
    await page(path);
  }
  const home = await page('/');
  for (const href of ['/', '/topic', '/rounds', '/calibration', '/benchmark', '/config', '/mirror']) assert.ok(home.text.includes(`href="${href}"`), `nav link ${href}`);
  assert.ok(home.text.includes('F1-04'));
  const sections = ['/', '/topic', '/rounds', `/rounds/${ROUND}/audit`, `/rounds/${ROUND}/decide`, `/rounds/${ROUND}/final`, '/calibration', '/benchmark', '/config', '/mirror'];
  for (const s of sections) assert.equal(walked.get(s), 200, `the walk GET ${s}`);
});
