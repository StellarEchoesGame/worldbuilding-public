import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rollbackHolds } from '../../../engine/bench-check.ts';
import { readBenchLog } from '../../../engine/bench-log.ts';
import { isRecord, readArray } from '../../../engine/json.ts';
import { OWNER_LOG, ownerInputs, sha256Bytes } from '../../../engine/owner-inputs.ts';
import { loadProtocolBundle } from '../../../engine/rules.ts';
import { setRecord, writeSet } from '../../../engine/testing/calib-set.ts';
import { fixtureWorld } from '../../../engine/testing/fixture-world.ts';
import { submitAudit, submitCalibAnswers, submitDecision, submitRollback, submitBenchView, submitTopic } from './owner.ts';

function sub(body: string, facts: number): string {
  const claims = Array.from({ length: facts }, (_, i) => ({ id: `A-0${i + 1}`, kind: 'author_fact', claim: `事实${i + 1}`, status: '状态与路径实例', row_id: 'SHIP', attaches_to: '04', extends: 'F07', misuse: 'm', source_quote: body.slice(0, 8), register: true }));
  const text = ['```submission', body, '```', '```delta', JSON.stringify({ new_proper_nouns: [], claims }), '```', '```interface', '{"shots":[{},{},{}],"object":{},"hook":{}}', '```'].join('\n');
  return JSON.stringify({ id: 'x', kind: 'writer', model: 'm', family: 'DeepSeek', stance: 's', ok: true, error: null, text });
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-owner-'));
  const dir = join(root, 'rounds', 'P01');
  mkdirSync(join(dir, 'submissions'), { recursive: true });
  writeFileSync(join(dir, 'labels.json'), JSON.stringify({ A: 'W1', B: 'W2' }));
  writeFileSync(join(dir, 'audit-set.json'), JSON.stringify({ pairs: [{ id: 'audit-1', left: 'A', right: 'BASE' }, { id: 'audit-2', left: 'BASE', right: 'B' }] }));
  writeFileSync(join(dir, 'submissions', 'W1.json'), sub('温芮把旧水壶放回架上，炉子还热着。', 7));
  writeFileSync(join(dir, 'submissions', 'W2.json'), sub('林澈在走廊尽头停下，听见循环泵换了节拍。', 2));
  return root;
}

const now = '2026-09-25T00:00:00.000Z';

test('the audit needs an answer for every pair and is written once', () => {
  const root = fixture();
  const partial = submitAudit(root, 'P01', { 'audit-1': 'left' }, now);
  assert.ok(!partial.ok && partial.status === 400);
  const good = submitAudit(root, 'P01', { 'audit-1': 'left', 'audit-2': 'right' }, now);
  assert.equal(good.ok, true);
  const audit: unknown = JSON.parse(readFileSync(join(root, 'rounds/P01/audit.json'), 'utf8'));
  assert.match(JSON.stringify(audit), /"chosen":"A".*"chosen":"B"/u);
  assert.match(JSON.stringify(audit), /"source":"ui"/u);
  assert.match(readFileSync(join(root, 'owner-log.jsonl'), 'utf8'), /"action":"audit"/u);
  const again = submitAudit(root, 'P01', { 'audit-1': 'right', 'audit-2': 'right' }, now);
  assert.ok(!again.ok && again.status === 409);
  rmSync(root, { recursive: true });
});

test('a decision before the audit is refused', () => {
  const root = fixture();
  const r = submitDecision(root, 'P01', { pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: [] }, now);
  assert.ok(!r.ok && r.status === 409);
  rmSync(root, { recursive: true });
});

test('a decision validates pick, reason and at most six facts', () => {
  const root = fixture();
  submitAudit(root, 'P01', { 'audit-1': 'left', 'audit-2': 'right' }, now);
  const seven = Array.from({ length: 7 }, (_, i) => `A:A-0${i + 1}`);
  const tooMany = submitDecision(root, 'P01', { pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: seven }, now);
  assert.ok(!tooMany.ok && tooMany.status === 400);
  const unknown = submitDecision(root, 'P01', { pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: ['B:A-09'] }, now);
  assert.ok(!unknown.ok && unknown.status === 400);
  const badPick = submitDecision(root, 'P01', { pick: 'Z', reason: '平', fav: 'A', publish: 'no', facts: [] }, now);
  assert.ok(!badPick.ok && badPick.status === 400);
  const good = submitDecision(root, 'P01', { pick: 'A', reason: '偏', fav: 'B', publish: 'no', happened: 'on', facts: ['A:A-01', 'B:A-02'] }, now);
  assert.equal(good.ok, true);
  const decision: unknown = JSON.parse(readFileSync(join(root, 'rounds/P01/decision.json'), 'utf8'));
  assert.match(JSON.stringify(decision), /"pick_submission":"W1"/u);
  assert.match(JSON.stringify(decision), /"happened":true/u);
  assert.ok(existsSync(join(root, 'owner-log.jsonl')));
  const again = submitDecision(root, 'P01', { pick: 'none', reason: '平', fav: 'none', publish: 'no', facts: [] }, now);
  assert.ok(!again.ok && again.status === 409);
  rmSync(root, { recursive: true });
});

/** A crash between an owner file write and its log line: the last owner-log line never landed. */
function dropLastLogLine(root: string): void {
  const path = join(root, OWNER_LOG);
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l !== '');
  writeFileSync(path, lines.slice(0, -1).map((l) => `${l}\n`).join(''));
}

test('an audit or decision file whose log line was lost is re-logged by the next POST, which still does not overwrite it', () => {
  const root = fixture();
  assert.equal(submitAudit(root, 'P01', { 'audit-1': 'left', 'audit-2': 'right' }, now).ok, true);
  dropLastLogLine(root);
  assert.equal(ownerInputs(root).audit('P01').state, 'repair');
  const again = submitAudit(root, 'P01', { 'audit-1': 'right', 'audit-2': 'right' }, now);
  assert.ok(!again.ok && again.status === 409);
  assert.equal(ownerInputs(root).audit('P01').state, 'ok');
  assert.match(readFileSync(join(root, 'rounds/P01/audit.json'), 'utf8'), /"chosen": "A"/u);
  assert.equal(submitDecision(root, 'P01', { pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: [] }, now).ok, true);
  dropLastLogLine(root);
  const decision = submitDecision(root, 'P01', { pick: 'B', reason: '平', fav: 'B', publish: 'no', facts: [] }, now);
  assert.ok(!decision.ok && decision.status === 409);
  const log = readFileSync(join(root, OWNER_LOG), 'utf8');
  assert.equal(log.match(/"action":"decision"/gu)?.length, 1);
  assert.match(readFileSync(join(root, 'rounds/P01/decision.json'), 'utf8'), /"pick": ?"A"/u);
  rmSync(root, { recursive: true });
});

test('a topic file whose log line was lost is re-logged by the next POST', () => {
  const root = fixture();
  writeFileSync(join(root, 'rounds/P01/topic-offer.json'), JSON.stringify({ top3: [{ row_id: 'SHIP', layer: 'L1' }] }));
  assert.equal(submitTopic(root, 'P01', { row_id: 'SHIP', layer: 'L1' }, now).ok, true);
  dropLastLogLine(root);
  const again = submitTopic(root, 'P01', { row_id: 'SHIP', layer: 'L1' }, now);
  assert.ok(!again.ok && again.status === 409);
  assert.equal(readFileSync(join(root, OWNER_LOG), 'utf8').match(/"action":"topic"/gu)?.length, 1);
  rmSync(root, { recursive: true });
});

const at = (i: number): string => `2026-09-20T00:00:${String(i).padStart(2, '0')}.000Z`;

function calibWorld(sets: readonly string[]): string {
  const root = fixtureWorld(mkdtempSync(join(tmpdir(), 'forge-owner-calib-')), { benchmark: 'active', champions: 'none', trust: 'none', protocolApproved: true }).root;
  const merged: Record<string, unknown> = {};
  for (const set of sets) {
    writeSet(root, set, setRecord(set, 'round0', null));
    const one: unknown = JSON.parse(readFileSync(join(root, 'calibration', 'pairs.json'), 'utf8'));
    if (isRecord(one) && isRecord(one['sets'])) Object.assign(merged, one['sets']);
  }
  writeFileSync(join(root, 'calibration', 'pairs.json'), `${JSON.stringify({ schema: 'calib-pairs/1', sets: merged }, null, 2)}\n`);
  return root;
}

function answerAll(root: string, set: string, from: number): void {
  for (let s = 1; s <= 5; s += 1) assert.equal(submitCalibAnswers(root, set, [{ slot: s, choice: 'left', ms: null }], at(from + s)).ok, true);
}

test('calibration: a lost log line for a set\'s last slot is re-logged by any later POST, even a refused one', () => {
  const root = calibWorld(['C00']);
  answerAll(root, 'C00', 0);
  dropLastLogLine(root);
  assert.equal(ownerInputs(root).calibAnswers().state, 'repair');
  const retry = submitCalibAnswers(root, 'C00', [{ slot: 5, choice: 'left', ms: null }], at(30));
  assert.ok(!retry.ok && retry.status === 409);
  const read = ownerInputs(root).calibAnswers();
  assert.equal(read.state, 'ok', read.state === 'invalid' ? read.error : read.state);
  const answers: unknown = JSON.parse(readFileSync(join(root, 'calibration/owner-answers.json'), 'utf8'));
  assert.equal(isRecord(answers) && isRecord(answers['sets']) ? readArray(answers['sets']['C00'], 'answers')?.length : null, 5);
  rmSync(root, { recursive: true });
});

test('calibration: a lost log line in one set is re-logged when the owner answers another set', () => {
  const root = calibWorld(['C01', 'C00']);
  answerAll(root, 'C00', 0);
  dropLastLogLine(root);
  assert.equal(submitCalibAnswers(root, 'C01', [{ slot: 1, choice: 'left', ms: null }], at(30)).ok, true);
  const read = ownerInputs(root).calibAnswers();
  assert.equal(read.state, 'ok', read.state === 'invalid' ? read.error : read.state);
  rmSync(root, { recursive: true });
});

/** Appends an auto `activate` line (cycle R0<n> for v<n>) for benchmark/<v>.json = <parent> with one list key extended. */
function addVersion(root: string, v: string, parent: string, when: string, key: 'cliche_list' | 'interface_checklist_extra'): string {
  const cycle = `R0${v.slice(1)}`;
  const base: unknown = JSON.parse(readFileSync(join(root, 'benchmark', `${parent}.json`), 'utf8'));
  assert.ok(isRecord(base));
  const list = readArray(base, key) ?? [];
  const body = `${JSON.stringify({ ...base, version: v, parent, created_at: when, [key]: [...list, `${v}-extra`] }, null, 2)}\n`;
  writeFileSync(join(root, 'benchmark', `${v}.json`), body);
  const bundle = loadProtocolBundle(root);
  assert.ok(bundle.ok);
  const sha = sha256Bytes(Buffer.from(body));
  const line = {
    at: when, cycle, outcome: 'activate', version: v, parent, sha256: sha, path: `benchmark/${v}.json`, activation: 'auto', changed_keys: [key],
    evidence_packet: null, evidence_packet_sha256: null, evidence_ids: [], reasons: [], errors: [], replay: null, dropped_cliches: [],
    protocol_bundle_sha256: bundle.value.bundleSha256, calls: [], source: 'engine',
  };
  appendFileSync(join(root, 'benchmark', 'log.jsonl'), `${JSON.stringify(line)}\n`);
  return sha;
}

function holds(root: string): ReturnType<typeof rollbackHolds> {
  const log = readBenchLog(root);
  const bundle = loadProtocolBundle(root);
  assert.ok(log.ok && bundle.ok);
  return rollbackHolds(root, ownerInputs(root), log.value, bundle.value.protocol.activation);
}

function benchWorld(): { root: string; v1: string } {
  const root = fixtureWorld(mkdtempSync(join(tmpdir(), 'forge-owner-bench-')), { benchmark: 'active', champions: 'none', trust: 'none', protocolApproved: true }).root;
  return { root, v1: sha256Bytes(readFileSync(join(root, 'benchmark', 'v1.json'))) };
}

test('a rollback whose `from` is not a logged version is refused (rollbackHolds would fail on it forever)', () => {
  const { root, v1 } = benchWorld();
  const v2 = addVersion(root, 'v2', 'v1', '2026-09-20T00:00:00.000Z', 'cliche_list');
  assert.equal(submitBenchView(root, 'v2', v2, '2026-09-20T00:01:00.000Z').ok, true);
  const r = submitRollback(root, { version: 'v1', from: 'v9', sha256: v1 }, '2026-09-20T00:02:00.000Z');
  assert.ok(!r.ok && r.status === 409);
  assert.deepEqual(ownerInputs(root).rollbacks(), []);
  assert.ok(submitRollback(root, { version: 'v1', from: 'v2', sha256: v1 }, '2026-09-20T00:03:00.000Z').ok);
  assert.deepEqual(holds(root), { ok: true, value: [{ round: 0, rolledBackKeys: ['cliche_list'] }] });
  rmSync(root, { recursive: true });
});

test('a rollback from a version that is no longer effective (stale page) is refused', () => {
  const { root, v1 } = benchWorld();
  const v2 = addVersion(root, 'v2', 'v1', '2026-09-20T00:00:00.000Z', 'cliche_list');
  assert.equal(submitBenchView(root, 'v2', v2, '2026-09-20T00:01:00.000Z').ok, true);
  const v3 = addVersion(root, 'v3', 'v2', '2026-09-21T00:00:00.000Z', 'interface_checklist_extra');
  const view3 = submitBenchView(root, 'v3', v3, '2026-09-21T00:01:00.000Z');
  assert.equal(view3.ok, true, view3.ok ? '' : view3.error);
  const stale = submitRollback(root, { version: 'v1', from: 'v2', sha256: v1 }, '2026-09-21T00:02:00.000Z');
  assert.ok(!stale.ok && stale.status === 409 && stale.error.includes('刷新'));
  assert.ok(submitRollback(root, { version: 'v1', from: 'v3', sha256: v1 }, '2026-09-21T00:03:00.000Z').ok);
  assert.deepEqual(holds(root), { ok: true, value: [{ round: 0, rolledBackKeys: ['cliche_list', 'interface_checklist_extra'] }] });
  rmSync(root, { recursive: true });
});
