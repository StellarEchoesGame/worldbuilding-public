import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { roundCommand } from '../../../engine/cli-round.ts';
import { readArray, readString } from '../../../engine/json.ts';
import { sha256Bytes } from '../../../engine/marker.ts';
import { readOwnerLog, type OwnerLogEntry } from '../../../engine/owner-inputs.ts';
import { loadProtocolBundle } from '../../../engine/rules.ts';
import { readStatus } from '../../../engine/runner.ts';
import { FIXTURE_GATEWAY_HOST } from '../../../engine/testing/fixture-world.ts';
import { deps, must, readObject, ROUND, schemaErrors, world, type World } from '../../../engine/testing/round-script.ts';
import { formActions, inputNamesWithValue, inputValues, redirectError, startServer, type Page, type UiServer } from './server.ts';

/*
 * The built UI server (ui/src/test/server.ts) on the scripted round of engine/testing/round-script.ts (every writer
 * registers one fact A-01), driven to 09b through the CLI command functions like engine/steps/index.test.ts; every
 * owner action goes through the server's POST routes. Covers the request guards (token, Origin, Host), the protocol
 * approval, the topic pick, the audit gate on the decision page, the 6-fact limit, a schema-valid decision with its
 * owner-log entry, and the redecision gate (refused without a rejected gate record, accepted after 10a failed).
 */

const PID = 6101;
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

/** POST through the server, then one fake second passes (as owner-sim does). */
async function post(path: string, form: Readonly<Record<string, string | readonly string[]>>): Promise<Page> {
  const page = await server.post(path, form);
  x.ports.clock.advance(1000);
  return page;
}

async function run(argv: readonly string[]): Promise<number> {
  return roundCommand(argv, deps(x, PID), x.at);
}

function ownerLog(): OwnerLogEntry[] {
  return must(readOwnerLog(root));
}

/** GET a walk-through page: 200, no gateway host, no UI token in the body. */
async function page(path: string): Promise<Page> {
  const p = await server.get(path);
  assert.equal(p.status, 200, `${path}: ${p.status} ${p.location ?? ''} ${p.text.slice(0, 300)}`);
  assert.equal(p.text.includes(FIXTURE_GATEWAY_HOST), false, `${path} shows the gateway host`);
  assert.equal(p.text.includes(server.token), false, `${path} shows the UI token`);
  return p;
}

function ownerLogBytes(): string {
  return readFileSync(join(root, 'owner-log.jsonl'), 'utf8');
}

function labelOf(submission: string): string {
  return Object.entries(readObject(join(dir(), 'labels.json'))).find(([, v]) => v === submission)?.[0] ?? '';
}

test('token: no cookie or a wrong cookie gets 401 on GET and POST; /login with a wrong token 401', async () => {
  const logged = ownerLogBytes();
  for (const cookie of [null, 'forge_token=wrong', `forge_token=${server.token}x`]) {
    assert.equal((await server.get('/', { cookie })).status, 401, String(cookie));
    assert.equal((await server.post('/api/protocol/approve', { sha256: '0'.repeat(64) }, { cookie })).status, 401, String(cookie));
  }
  assert.equal((await server.get('/login?t=wrong', { cookie: null })).status, 401);
  const login = await server.get(`/login?t=${server.token}`, { cookie: null });
  assert.deepEqual([login.status, login.location], [303, '/']);
  assert.equal(ownerLogBytes(), logged, 'nothing was logged');
});

/** The middleware guard's refusal (ui/src/lib/guard.ts) and Astro's `security.checkOrigin` refusal, as served. */
const GUARD_ORIGIN = /来源不符，拒绝写入。/u;
const ASTRO_ORIGIN = /Cross-site POST form submissions are forbidden/u;

test('Origin: a form POST with a foreign or missing Origin gets 403 from Astro checkOrigin (ahead of the middleware), with a valid token; nothing is written', async () => {
  const sha = must(loadProtocolBundle(root)).bundleSha256;
  const logged = ownerLogBytes();
  for (const origin of ['http://evil.example', `http://localhost:1`, null]) {
    const p = await server.post('/api/protocol/approve', { sha256: sha }, { origin });
    assert.equal(p.status, 403, `${String(origin)}: ${p.status}`);
    assert.match(p.text, ASTRO_ORIGIN, `${String(origin)}: ${p.text.slice(0, 200)}`);
  }
  assert.equal(ownerLogBytes(), logged);
});

test('Origin: a JSON POST with a foreign or missing Origin passes checkOrigin and gets 403 from the middleware guard, with a valid token; nothing is written', async () => {
  const sha = must(loadProtocolBundle(root)).bundleSha256;
  const logged = ownerLogBytes();
  for (const origin of ['http://evil.example', `http://localhost:1`, null]) {
    const p = await server.postRaw('/api/protocol/approve', JSON.stringify({ sha256: sha }), 'application/json', { origin });
    assert.equal(p.status, 403, `${String(origin)}: ${p.status}`);
    assert.match(p.text, GUARD_ORIGIN, `${String(origin)}: ${p.text.slice(0, 200)}`);
  }
  assert.equal(ownerLogBytes(), logged);
});

test('Origin: a POST without a content type and a foreign or missing Origin gets 403 from Astro checkOrigin too (it treats no content type as a form); nothing is written', async () => {
  const sha = must(loadProtocolBundle(root)).bundleSha256;
  const logged = ownerLogBytes();
  for (const origin of ['http://evil.example', null]) {
    const p = await server.postRaw('/api/protocol/approve', `sha256=${sha}`, null, { origin });
    assert.equal(p.status, 403, `${String(origin)}: ${p.status}`);
    assert.match(p.text, ASTRO_ORIGIN, `${String(origin)}: ${p.text.slice(0, 200)}`);
  }
  assert.equal(ownerLogBytes(), logged);
});

test('a non-loopback Host header is refused with 403 on every path, /login included', async () => {
  for (const path of ['/', '/login', `/login?t=${server.token}`, '/benchmark', '/rounds']) {
    const p = await server.getWithHost(path, 'forge.example.com');
    assert.equal(p.status, 403, path);
    assert.equal(p.text.includes(server.token), false);
  }
  assert.equal((await server.getWithHost('/', `127.0.0.1:${new URL(server.base).port}`)).status, 200, 'a loopback Host is served');
});

test('protocol approval: /benchmark shows the bundle SHA-256; the POST logs protocol_approved with it; the round starts', async () => {
  assert.equal(await run(['start', ROUND]), 2, x.logs.join('\n'));
  assert.equal(must(readStatus(root, ROUND)).waiting_for, 'protocol_approval');
  const bench = await page('/benchmark');
  assert.ok(formActions(bench.text).includes('/api/protocol/approve'));
  const shown = inputValues(bench.text, 'sha256').at(-1) ?? '';
  assert.equal(shown, must(loadProtocolBundle(root)).bundleSha256);
  const p = await post('/api/protocol/approve', { sha256: shown });
  assert.deepEqual([p.status, p.location], [303, '/benchmark']);
  const last = ownerLog().at(-1);
  assert.deepEqual([last?.action, last?.sha256, last?.file], ['protocol_approved', shown, 'protocol-bundle']);
  assert.equal(await run(['start', ROUND]), 2, x.logs.join('\n'));
  assert.equal(must(readStatus(root, ROUND)).waiting_for, 'topic');
});

test('topic: /topic/R01 offers the top 3; one POST writes topic.json and logs it; a second POST is refused', async () => {
  const top = readArray(readObject(join(dir(), 'topic-offer.json')), 'top3') ?? [];
  const pick = (v: unknown): { row_id: string; layer: string } => ({ row_id: readString(v, 'row_id') ?? '', layer: readString(v, 'layer') ?? '' });
  const first: unknown = top[0];
  const second: unknown = top[1] ?? first;
  const shown = await page(`/topic/${ROUND}`);
  assert.ok(formActions(shown.text).includes(`/api/rounds/${ROUND}/topic`));
  assert.ok(shown.text.includes(pick(first).row_id));
  await page('/topic');
  const p = await post(`/api/rounds/${ROUND}/topic`, pick(first));
  assert.deepEqual([p.status, p.location], [303, `/topic/${ROUND}`]);
  assert.deepEqual(schemaErrors(root, 'topic', readObject(join(dir(), 'topic.json'))), []);
  assert.deepEqual([ownerLog().at(-1)?.action, ownerLog().at(-1)?.file], ['topic', `rounds/${ROUND}/topic.json`]);
  const topicBytes = readFileSync(join(dir(), 'topic.json'));
  const again = await post(`/api/rounds/${ROUND}/topic`, pick(second));
  assert.equal(again.status, 303);
  assert.notEqual(redirectError(again.location), null, 'the second pick is refused');
  assert.deepEqual(readFileSync(join(dir(), 'topic.json')), topicBytes);
  const readOnly = await page(`/topic/${ROUND}`);
  assert.equal(formActions(readOnly.text).includes(`/api/rounds/${ROUND}/topic`), false, 'read-only once topic.json exists');
});

test('the decision page redirects to the audit until the audit is answered; the audit POST unlocks it', async () => {
  assert.equal(await run(['run', ROUND]), 2, x.logs.join('\n'));
  assert.equal(must(readStatus(root, ROUND)).waiting_for, 'audit');
  const locked = await server.get(`/rounds/${ROUND}/decide`);
  assert.deepEqual([locked.status, locked.location], [303, `/rounds/${ROUND}/audit`]);
  const auditPage = await page(`/rounds/${ROUND}/audit`);
  await page(`/rounds/${ROUND}`);
  await page('/rounds');
  const pairIds = inputNamesWithValue(auditPage.text, 'left');
  assert.ok(pairIds.length >= 2, auditPage.text.slice(0, 500));
  const tooFew = await post(`/api/rounds/${ROUND}/audit`, { [pairIds[0] ?? '']: 'left' });
  assert.notEqual(redirectError(tooFew.location), null, 'an incomplete audit is refused');
  const answers = Object.fromEntries(pairIds.map((id) => [id, 'left']));
  const p = await post(`/api/rounds/${ROUND}/audit`, answers);
  assert.deepEqual([p.status, p.location], [303, `/rounds/${ROUND}`]);
  assert.deepEqual(schemaErrors(root, 'audit', readObject(join(dir(), 'audit.json'))), []);
  assert.equal(ownerLog().at(-1)?.action, 'audit');
  assert.equal(await run(['run', ROUND]), 2, x.logs.join('\n'));
  assert.equal(must(readStatus(root, ROUND)).waiting_for, 'decision');
  const decide = await page(`/rounds/${ROUND}/decide`);
  assert.ok(formActions(decide.text).includes(`/api/rounds/${ROUND}/decision`));
  assert.ok(inputNamesWithValue(decide.text, '').includes('base'), 'the decision form offers a base (default: same as the pick)');
});

test('a decision with a 7th fact is refused and writes nothing', async () => {
  const facts = ['A', 'B', 'C', 'A', 'B', 'C', 'A'].map((l, i) => `${l}:A-0${i + 1}`);
  const p = await post(`/api/rounds/${ROUND}/decision`, { pick: 'A', reason: '平', fav: 'A', publish: 'no', facts });
  assert.equal(p.status, 303);
  assert.match(redirectError(p.location) ?? '', /最多登记 6 条事实/u);
  assert.ok((p.location ?? '').startsWith(`/rounds/${ROUND}/decide?error=`));
  assert.equal(existsSync(join(dir(), 'decision.json')), false);
});

test('a redecision is refused while the round has no rejected gate record', async () => {
  const p = await post(`/api/rounds/${ROUND}/redecision`, { pick: 'A', reason: '平', fav: 'A', publish: 'no' });
  assert.notEqual(redirectError(p.location), null);
  const view = await page(`/rounds/${ROUND}/redecide`);
  assert.equal(formActions(view.text).includes(`/api/rounds/${ROUND}/redecision`), false, 'no form without a gate rejection');
});

test('a valid decision POST writes a schema-valid decision.json and its owner-log entry', async () => {
  const base = labelOf('W1');
  const donor = labelOf('W2-r2');
  assert.ok(base !== '' && donor !== '');
  const p = await post(`/api/rounds/${ROUND}/decision`, { pick: base, reason: '平', fav: base, publish: 'no', facts: [`${base}:A-01`, `${donor}:A-01`] });
  assert.deepEqual([p.status, p.location], [303, `/rounds/${ROUND}`]);
  const file = join(dir(), 'decision.json');
  const decision = readObject(file);
  assert.deepEqual(schemaErrors(root, 'decision', decision), []);
  assert.deepEqual([decision['pick'], decision['base'], decision['source']], [base, null, 'ui']);
  assert.equal(readArray(decision, 'facts')?.length, 2);
  const last = ownerLog().at(-1);
  assert.deepEqual([last?.action, last?.round, last?.file, last?.sha256], ['decision', ROUND, `rounds/${ROUND}/decision.json`, sha256Bytes(readFileSync(file))]);
  assert.equal(last?.at, decision['decided_at'], 'the entry is stamped on the engine clock');
  const again = await post(`/api/rounds/${ROUND}/decision`, { pick: base, reason: '平', fav: base, publish: 'no' });
  assert.notEqual(redirectError(again.location), null, 'a second decision is refused');
});

test('redecision: accepted after the contradicting re-gate rewinds to 09b, refused again once the new decision stands', async () => {
  x.script.mergeContradiction = (kind) => kind === 'regate';
  assert.equal(await run(['run', ROUND]), 2, x.logs.join('\n'));
  const st = must(readStatus(root, ROUND));
  assert.deepEqual([st.step, st.waiting_for], ['09b-decision', 'decision']);
  assert.match(st.detail, /^regate_failed:/u);
  x.script.mergeContradiction = () => false;
  const todo = await server.get(`/rounds/${ROUND}/decide`);
  assert.deepEqual([todo.status, todo.location], [303, `/rounds/${ROUND}/redecide`], 'the 决策 to-do leads to the redecision');
  const view = await page(`/rounds/${ROUND}/redecide`);
  assert.ok(formActions(view.text).includes(`/api/rounds/${ROUND}/redecision`), 'the redecision form is offered');
  const base = labelOf('W1');
  const p = await post(`/api/rounds/${ROUND}/redecision`, { pick: base, reason: '平', fav: base, publish: 'no', facts: [`${base}:A-01`], base: '' });
  assert.deepEqual([p.status, p.location], [303, `/rounds/${ROUND}`]);
  const file = join(dir(), 'decision-2.json');
  const decision = readObject(file);
  assert.deepEqual(schemaErrors(root, 'decision', decision), []);
  assert.equal(decision['supersedes'], sha256Bytes(readFileSync(join(dir(), 'decision.json'))));
  assert.deepEqual([ownerLog().at(-1)?.action, ownerLog().at(-1)?.file], ['decision', `rounds/${ROUND}/decision-2.json`]);
  const again = await post(`/api/rounds/${ROUND}/redecision`, { pick: base, reason: '平', fav: base, publish: 'no' });
  assert.notEqual(redirectError(again.location), null);
  assert.equal(existsSync(join(dir(), 'decision-3.json')), false);
  assert.equal(await run(['run', ROUND, '--until', '09b-decision']), 0, x.logs.join('\n'));
  assert.equal(must(readStatus(root, ROUND)).state, 'done', 'the engine accepts the UI-written redecision');
});
