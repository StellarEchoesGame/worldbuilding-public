import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CalibSetRecord } from '../../../engine/calib-build.ts';
import { isRecord, readArray, readNumber, readRecord } from '../../../engine/json.ts';
import { sha256Bytes } from '../../../engine/marker.ts';
import { ownerInputs, readOwnerLog, type OwnerLogEntry } from '../../../engine/owner-inputs.ts';
import { loadProtocolBundle } from '../../../engine/rules.ts';
import { setRecord, writeSet } from '../../../engine/testing/calib-set.ts';
import { fakeClock, type FakeClock } from '../../../engine/testing/fakes.ts';
import { FIXTURE_GATEWAY_HOST, fixtureWorld, type FixtureWorld } from '../../../engine/testing/fixture-world.ts';
import { must, START_ISO } from '../../../engine/testing/round-script.ts';
import { formFields, inputValues, redirectError, startServer, type Page, type UiServer } from './server.ts';

/*
 * 基准 and 校准 on the built UI server, on a fixture world (no round): benchmark v1 active, plus a v2 `pending_owner`
 * line of cycle R01 written the way the engine's 11j would (v1 + one more cliché); a hand-built calibration set C00
 * (engine/testing/calib-set.ts, five display slots). Covers the bench diff view, the approval and the rollback with
 * the SHA-256 each page showed, and calibration answers that persist and resume across POSTs and reloads.
 */

const SET = 'C00';
const SLOTS = 5;
let dir: string;
let w: FixtureWorld;
let clock: FakeClock;
let server: UiServer;
let v1Sha: string;
let v2Sha: string;
let calib: CalibSetRecord;

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** benchmark/v2.json (v1 plus one cliché) and its pending_owner log line (the shape of fixture-world's v1 line). */
function addPendingV2(root: string): void {
  const v1: unknown = JSON.parse(readFileSync(join(root, 'benchmark', 'v1.json'), 'utf8'));
  if (!isRecord(v1)) throw new Error('benchmark/v1.json is not an object');
  const cliches = (readArray(v1, 'cliche_list') ?? []).filter((c) => typeof c === 'string');
  const v2 = json({ ...v1, version: 'v2', parent: 'v1', created_at: '2026-09-20T00:00:00.000Z', cliche_list: [...cliches, '岁月静好'] });
  writeFileSync(join(root, 'benchmark', 'v2.json'), v2);
  const line = {
    at: '2026-09-20T00:00:00.000Z', cycle: 'R01', outcome: 'pending_owner', version: 'v2', parent: 'v1', sha256: sha256Bytes(Buffer.from(v2)),
    path: 'benchmark/v2.json', activation: 'owner', changed_keys: ['cliche_list'], evidence_packet: null, evidence_packet_sha256: null,
    evidence_ids: [], reasons: [], errors: [], replay: null, dropped_cliches: [], protocol_bundle_sha256: must(loadProtocolBundle(root)).bundleSha256,
    calls: [], source: 'engine',
  };
  appendFileSync(join(root, 'benchmark', 'log.jsonl'), `${JSON.stringify(line)}\n`);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'forge-ui-bench-'));
  w = fixtureWorld(dir, { benchmark: 'active', champions: 'none', trust: 'none', protocolApproved: true });
  addPendingV2(w.root);
  calib = setRecord(SET, 'round0', null);
  writeSet(w.root, SET, calib);
  v1Sha = sha256Bytes(readFileSync(join(w.root, 'benchmark', 'v1.json')));
  v2Sha = sha256Bytes(readFileSync(join(w.root, 'benchmark', 'v2.json')));
  clock = fakeClock(START_ISO);
  server = await startServer({ dataDir: w.root, now: () => clock.now() });
});

after(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function post(path: string, form: Readonly<Record<string, string | readonly string[]>>): Promise<Page> {
  const page = await server.post(path, form);
  clock.advance(1000);
  assert.equal(page.status, 303, `${path}: ${page.status} ${page.text.slice(0, 200)}`);
  return page;
}

async function page(path: string): Promise<Page> {
  const p = await server.get(path);
  assert.equal(p.status, 200, `${path}: ${p.status} ${p.location ?? ''} ${p.text.slice(0, 300)}`);
  assert.equal(p.text.includes(FIXTURE_GATEWAY_HOST), false, `${path} shows the gateway host`);
  assert.equal(p.text.includes(server.token), false, `${path} shows the UI token`);
  return p;
}

function ownerLog(): OwnerLogEntry[] {
  return must(readOwnerLog(w.root));
}

test('基准: the version page logs bench_diff_viewed once for the shown SHA-256; the approval logs bench_approved with it', async () => {
  const index = await page('/benchmark');
  assert.ok(index.text.includes('v2'));
  const version = await page('/benchmark/v2');
  const view = formFields(version.text, '/api/benchmark/view');
  assert.deepEqual(view, [{ version: 'v2', sha256: v2Sha }]);
  const count = ownerLog().length;
  await post('/api/benchmark/view', { version: 'v2', sha256: v2Sha });
  await post('/api/benchmark/view', { version: 'v2', sha256: v2Sha });
  const viewed = ownerLog().slice(count);
  assert.deepEqual(viewed.map((e) => [e.action, e.version, e.sha256]), [['bench_diff_viewed', 'v2', v2Sha]], 'logged once per shown SHA-256');
  assert.deepEqual(formFields((await page('/benchmark/v2')).text, '/api/benchmark/view'), [], 'no view form once viewed');
  const wrong = await post('/api/benchmark/approve', { version: 'v2', sha256: v1Sha });
  assert.notEqual(redirectError(wrong.location), null, 'a SHA-256 other than the file is refused');
  const approve = formFields((await page('/benchmark')).text, '/api/benchmark/approve');
  assert.deepEqual(approve, [{ version: 'v2', sha256: v2Sha }]);
  const p = await post('/api/benchmark/approve', approve[0] ?? {});
  assert.deepEqual([p.location, redirectError(p.location)], ['/benchmark', null]);
  const last = ownerLog().at(-1);
  assert.deepEqual([last?.action, last?.version, last?.sha256, last?.file], ['bench_approved', 'v2', v2Sha, 'benchmark/v2.json']);
});

test('基准: rollback to v1 from the effective v2 logs rollback with v1\'s shown SHA-256', async () => {
  const index = await page('/benchmark');
  const rollback = formFields(index.text, '/api/benchmark/rollback');
  assert.deepEqual(rollback, [{ version: 'v1', from: 'v2', sha256: v1Sha }], index.text.slice(0, 2000));
  const p = await post('/api/benchmark/rollback', rollback[0] ?? {});
  assert.deepEqual([p.location, redirectError(p.location)], ['/benchmark', null]);
  const last = ownerLog().at(-1);
  assert.deepEqual([last?.action, last?.version, last?.from, last?.sha256], ['rollback', 'v1', 'v2', v1Sha]);
  const bad = await post('/api/benchmark/rollback', { version: 'v2', from: 'v2', sha256: v2Sha });
  assert.notEqual(redirectError(bad.location), null);
  await page('/benchmark/v1');
});

/** Model, family, category, pair id or text id: none may reach a calibration page. */
const NOT_BLIND = /deepseek-fixture|DeepSeek|canon_vs_rewrite|C00-P0|C00-T0/u;

/** Text `id` of the set as written to calibration/texts/ (what the page must show verbatim). */
function calibText(id: string): string {
  const path = calib.texts[id]?.path;
  assert.ok(path !== undefined, `text ${id} is in the set`);
  return readFileSync(join(w.root, 'calibration', path), 'utf8');
}

/**
 * The slot the calibration page shows next (its hidden `slot` input), or null when none is left. Every page
 * returned is blind (NOT_BLIND), and an active slot's page shows both of that slot's texts.
 */
async function shownSlot(): Promise<number | null> {
  const p = await page(`/calibration/${SET}`);
  const slot = inputValues(p.text, 'slot')[0];
  assert.equal(NOT_BLIND.test(p.text), false, `slot ${String(slot)}: blind (no model, family, category, pair or text id)`);
  if (slot === undefined) return null;
  const shown = calib.display.find((d) => d.slot === Number(slot));
  assert.ok(shown !== undefined, `slot ${slot} is a display slot of ${SET}`);
  for (const id of [shown.left, shown.right]) assert.ok(p.text.includes(calibText(id)), `slot ${slot} shows the text of its ${id === shown.left ? 'left' : 'right'} side`);
  return Number(slot);
}

function answersOnDisk(): Array<{ slot: number | null; choice: unknown; ms: number | null }> {
  const file: unknown = JSON.parse(readFileSync(join(w.root, 'calibration', 'owner-answers.json'), 'utf8'));
  return (readArray(readRecord(readRecord(file, 'sets'), SET), 'answers') ?? []).map((a) => ({ slot: readNumber(a, 'slot'), choice: isRecord(a) ? a['choice'] : null, ms: readNumber(a, 'ms') }));
}

test('校准: answers persist one POST at a time and resume across a reload; an answered slot is refused; all slots complete the set', async () => {
  const index = await page('/calibration');
  assert.ok(index.text.includes(SET));
  assert.equal(await shownSlot(), 1);
  await post(`/api/calibration/${SET}/answer`, { slot: '1', choice: 'left', ms: '1234' });
  assert.equal(await shownSlot(), 2);
  await post(`/api/calibration/${SET}/answer`, { slot: '2', choice: 'right', ms: '' });
  assert.equal(await shownSlot(), 3, 'resumes at the first unanswered slot');
  assert.equal(await shownSlot(), 3, 'a reload shows the same slot');
  assert.deepEqual(answersOnDisk(), [{ slot: 1, choice: 'left', ms: 1234 }, { slot: 2, choice: 'right', ms: null }]);
  const logged = ownerLog().filter((e) => e.action === 'calib_answers');
  assert.deepEqual(logged.map((e) => [e.set, e.slots]), [[SET, [1]], [SET, [2]]]);
  const dup = await post(`/api/calibration/${SET}/answer`, { slot: '1', choice: 'right' });
  assert.match(redirectError(dup.location) ?? '', /已经回答过/u);
  const badChoice = await post(`/api/calibration/${SET}/answer`, { slot: '3', choice: 'middle' });
  assert.notEqual(redirectError(badChoice.location), null);
  assert.equal(answersOnDisk().length, 2, 'refused POSTs write nothing');
  for (let slot = 3; slot <= SLOTS; slot += 1) {
    assert.equal(await shownSlot(), slot);
    const p = await post(`/api/calibration/${SET}/answer`, { slot: String(slot), choice: slot % 2 === 0 ? 'left' : 'right', ms: String(slot * 100) });
    assert.deepEqual([p.location, redirectError(p.location)], [`/calibration/${SET}`, null]);
  }
  assert.equal(await shownSlot(), null, 'no slot left');
  assert.deepEqual(answersOnDisk().map((a) => a.slot), [1, 2, 3, 4, 5]);
  const read = ownerInputs(w.root).calibAnswers();
  assert.equal(read.state, 'ok', 'the engine reader accepts the UI-written answers');
  const bodies = [(await page('/calibration')).text, (await page(`/calibration/${SET}`)).text];
  for (const text of bodies) assert.equal(NOT_BLIND.test(text), false, 'blind: no model, family, category, pair or text id');
});
