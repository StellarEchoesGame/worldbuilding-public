import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecord } from './json.ts';
import { OWNER_ANSWERS, OWNER_LOG, decisionDirName, ownerInputs, parseOwnerLogEntry, protocolGateAt, readOwnerLog, sha256Bytes } from './owner-inputs.ts';
import { BUNDLE_FILES } from './protocol.ts';
import { loadProtocolBundle } from './rules.ts';
import { canonicalJson } from './seal.ts';
import type { FakeClock } from './testing/fakes.ts';
import { ownerSim } from './testing/owner-sim.ts';
import { submitBenchApproval, submitCalibAnswers, submitDiffApproval, submitRedecision, submitRollback, submitTopic } from '../ui/src/lib/owner.ts';

const FORGE = dirname(dirname(fileURLToPath(import.meta.url)));
const START = '2026-09-25T00:00:00.000Z';

/** Local stand-in for fakes.ts fakeClock (same interface). */
function testClock(startIso: string): FakeClock {
  let t = Date.parse(startIso);
  const slept: number[] = [];
  return {
    now: () => new Date(t).toISOString(),
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
    slept: () => slept,
  };
}

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function putJson(root: string, rel: string, value: unknown): void {
  put(root, rel, `${JSON.stringify(value, null, 2)}\n`);
}

function sha(root: string, rel: string): string {
  return sha256Bytes(readFileSync(join(root, rel)));
}

function sub(body: string, facts: number): string {
  const claims = Array.from({ length: facts }, (_, i) => ({ id: `A-0${i + 1}`, kind: 'author_fact', claim: `事实${i + 1}`, status: '状态与路径实例', row_id: 'SHIP', attaches_to: '04', extends: 'F07', misuse: 'm', source_quote: body.slice(0, 8), register: true }));
  const text = ['```submission', body, '```', '```delta', JSON.stringify({ new_proper_nouns: [], claims }), '```', '```interface', '{"shots":[{},{},{}],"object":{},"hook":{}}', '```'].join('\n');
  return JSON.stringify({ id: 'x', kind: 'writer', model: 'm', family: 'DeepSeek', stance: 's', ok: true, error: null, text });
}

/** Temp forge root: real bundle copy, one round R01 with labels, audit set and two submissions. */
function world(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-owner-inputs-'));
  for (const name of BUNDLE_FILES) copyFileSync(join(FORGE, name), join(root, name));
  putJson(root, 'rounds/R01/labels.json', { A: 'W1', B: 'W2' });
  putJson(root, 'rounds/R01/audit-set.json', { pairs: [{ id: 'R01-audit-1', left: 'A', right: 'BASE' }, { id: 'R01-audit-2', left: 'BASE', right: 'B' }] });
  put(root, 'rounds/R01/submissions/W1.json', sub('温芮把旧水壶放回架上，炉子还热着。', 2));
  put(root, 'rounds/R01/submissions/W2.json', sub('林澈在走廊尽头停下，听见循环泵换了节拍。', 2));
  return root;
}

const pickLeft = (): 'left' => 'left';
const DECISION = { pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: ['A:A-01', 'B:A-01'] };

test('existing UI owner-log lines (no version) parse with null extras', () => {
  const r = parseOwnerLogEntry({ at: START, action: 'audit', round: 'P01', file: 'rounds/P01/audit.json', sha256: 'a'.repeat(64), source: 'ui' });
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual([r.value.version, r.value.from, r.value.set, r.value.slots], [null, null, null, null]);
  assert.equal(parseOwnerLogEntry({ at: START, action: 'rollback', round: null, file: 'benchmark/v1.json', sha256: 'a'.repeat(64), source: 'ui', version: 'v1' }).ok, false);
  assert.equal(parseOwnerLogEntry({ at: START, action: 'audit', round: 'R01', file: 'x', sha256: 'a'.repeat(64), source: 'engine' }).ok, false);
});

test('readOwnerLog ignores a torn last line and rejects a bad middle line', () => {
  const root = world();
  assert.deepEqual(readOwnerLog(root), { ok: true, value: [] });
  const line = JSON.stringify({ at: START, action: 'protocol_approved', round: null, file: 'protocol-bundle', sha256: 'b'.repeat(64), source: 'ui' });
  put(root, OWNER_LOG, `${line}\n{"at":"2026-09-25T00:00:01.000Z","act`);
  const torn = readOwnerLog(root);
  assert.ok(torn.ok && torn.value.length === 1);
  put(root, OWNER_LOG, `${line}\n{"at":"2026-09-25T00:00:01.000Z","act\n${line}\n`);
  const bad = readOwnerLog(root);
  assert.ok(!bad.ok);
  if (!bad.ok) assert.match(bad.error, /line 2/u);
  rmSync(root, { recursive: true });
});

test('protocolGate waits until the latest protocol_approved equals the bundle', () => {
  const root = world();
  const bundle = loadProtocolBundle(root);
  assert.ok(bundle.ok);
  if (!bundle.ok) return;
  const owner = ownerInputs(root);
  const waiting = protocolGateAt(root, owner, bundle.value.bundleSha256);
  assert.ok(waiting !== null && waiting.kind === 'wait' && waiting.waitingFor === 'protocol_approval');
  if (waiting !== null && waiting.kind === 'wait') assert.equal(waiting.detail, `协议包 ${bundle.value.bundleSha256.slice(0, 12)} 尚未在基准页批准`);
  const sim = ownerSim(root, testClock(START));
  sim.approveProtocol();
  assert.equal(protocolGateAt(root, owner, bundle.value.bundleSha256), null);
  // a later approval of another bundle hash supersedes it
  appendFileSync(join(root, OWNER_LOG), `${JSON.stringify({ at: '2026-09-26T00:00:00.000Z', action: 'protocol_approved', round: null, file: 'protocol-bundle', sha256: 'c'.repeat(64), source: 'ui' })}\n`);
  assert.equal(protocolGateAt(root, owner, bundle.value.bundleSha256)?.kind, 'wait');
  assert.equal(owner.protocolApproval('c'.repeat(64))?.sha256, 'c'.repeat(64));
  // a bad middle line → owner_log_repair
  const text = readFileSync(join(root, OWNER_LOG), 'utf8');
  put(root, OWNER_LOG, `not json\n${text}`);
  const repair = protocolGateAt(root, owner, 'c'.repeat(64));
  assert.ok(repair !== null && repair.kind === 'wait' && repair.waitingFor === 'owner_log_repair');
  rmSync(root, { recursive: true });
});

test('topic: UI file needs its log entry, engine auto_default / fixed files do not', () => {
  const root = world();
  const owner = ownerInputs(root);
  assert.deepEqual(owner.topic('R01'), { state: 'missing' });
  putJson(root, 'rounds/R01/topic-offer.json', { round: 'R01', offered_at: START, top3: [{ row_id: 'SHIP', layer: 'object', priority: 3 }] });
  assert.ok(!submitTopic(root, 'R01', { row_id: 'SHIP', layer: 'mechanism' }, START).ok);
  const sim = ownerSim(root, testClock(START));
  sim.pickTopic('R01', { row_id: 'SHIP', layer: 'object' });
  const read = owner.topic('R01');
  assert.ok(read.state === 'ok' && read.value.source === 'ui' && read.sha256 === sim.expected().get('rounds/R01/topic.json'));
  const again = submitTopic(root, 'R01', { row_id: 'SHIP', layer: 'object' }, START);
  assert.ok(!again.ok && again.status === 409);
  // the same bytes without their entry → repair; other bytes → invalid
  const logged = readFileSync(join(root, OWNER_LOG), 'utf8');
  put(root, OWNER_LOG, '');
  assert.equal(owner.topic('R01').state, 'repair');
  put(root, OWNER_LOG, logged);
  put(root, 'rounds/R01/topic.json', readFileSync(join(root, 'rounds/R01/topic.json'), 'utf8').replace('object', 'mechanism'));
  assert.equal(owner.topic('R01').state, 'invalid');
  putJson(root, 'rounds/R02/topic.json', { round: 'R02', row_id: 'SHIP', layer: 'object', cell: null, source: 'auto_default', chosen_at: START });
  assert.equal(owner.topic('R02').state, 'ok');
  putJson(root, 'rounds/R03/topic.json', { round: 'R03', row_id: 'SHIP', layer: 'lunch', cell: null, source: 'fixed', chosen_at: START });
  assert.equal(owner.topic('R03').state, 'invalid');
  rmSync(root, { recursive: true });
});

test('audit: hash mismatch → invalid, no entry → repair, keys must equal the pinned audit set', () => {
  const root = world();
  const sim = ownerSim(root, testClock(START));
  const owner = ownerInputs(root);
  assert.deepEqual(owner.audit('R01'), { state: 'missing' });
  sim.answerAudit('R01', pickLeft);
  const read = owner.audit('R01');
  assert.ok(read.state === 'ok' && read.value.answers.length === 2 && read.value.answers[0]?.chosen === 'A');
  // the 09a marker pins the audit set the owner answered
  putJson(root, 'rounds/R01/markers/09a-audit.json', { v: 1, outputs: { 'rounds/R01/audit-set.json': sha(root, 'rounds/R01/audit-set.json') } });
  assert.equal(owner.audit('R01').state, 'ok');
  const set = readFileSync(join(root, 'rounds/R01/audit-set.json'), 'utf8');
  putJson(root, 'rounds/R01/audit-set.json', { pairs: [{ id: 'R01-audit-1', left: 'A', right: 'BASE' }, { id: 'R01-audit-3', left: 'BASE', right: 'B' }] });
  assert.equal(owner.audit('R01').state, 'invalid');
  putJson(root, 'rounds/R01/markers/09a-audit.json', { v: 1, outputs: { 'rounds/R01/audit-set.json': sha(root, 'rounds/R01/audit-set.json') } });
  const keys = owner.audit('R01');
  assert.ok(keys.state === 'invalid' && /R01-audit-2 is not in/u.test(keys.error));
  put(root, 'rounds/R01/audit-set.json', set);
  putJson(root, 'rounds/R01/markers/09a-audit.json', { v: 1, outputs: { 'rounds/R01/audit-set.json': sha(root, 'rounds/R01/audit-set.json') } });
  const audit = readFileSync(join(root, 'rounds/R01/audit.json'), 'utf8');
  put(root, 'rounds/R01/audit.json', audit.replace('"answered_at"', '"source": "ui",\n  "answered_at"'));
  assert.equal(owner.audit('R01').state, 'invalid');
  put(root, 'rounds/R01/audit.json', audit);
  const log = readFileSync(join(root, OWNER_LOG), 'utf8');
  put(root, OWNER_LOG, `{"at":"2026-09-25T00:00:00.000Z","act\n${log}`);
  const torn = owner.audit('R01');
  assert.ok(torn.state === 'repair' && /line 1/u.test(torn.detail));
  assert.deepEqual(owner.entries(), []);
  put(root, OWNER_LOG, '');
  assert.equal(owner.audit('R01').state, 'repair');
  rmSync(root, { recursive: true });
});

/** Simulates the engine's 10a rewind for the current decision: regate record + 09b marker moved to stale/<n>/. */
function rejectDecision(root: string, rel: string, n: number, status: string): string {
  const d = sha(root, rel);
  putJson(root, `rounds/R01/merge/${d.slice(0, 8)}/regate.json`, { status });
  putJson(root, `rounds/R01/markers/stale/${n}/09b-decision.json`, { v: 1, step: '09b-decision', inputs: { [rel]: d } });
  return d;
}

test('decision chain: decision-2.json only after a non-pass gate record with 09b stale', () => {
  const root = world();
  const sim = ownerSim(root, testClock(START));
  const owner = ownerInputs(root);
  assert.throws(() => sim.decide('R01', DECISION), /请先完成盲审/u);
  sim.answerAudit('R01', pickLeft);
  sim.decide('R01', DECISION);
  const first = owner.decision('R01');
  assert.ok(first.state === 'ok' && first.value.supersedes === null && first.value.base === null && first.value.facts.length === 2);
  // no gate record yet → the UI refuses a second decision
  assert.throws(() => sim.redecide('R01', { ...DECISION, facts: ['A:A-01'] }), /过门记录/u);
  // a passing re-gate is not a rejection; an unverified one fails the step instead
  const d1 = sha(root, 'rounds/R01/decision.json');
  putJson(root, `rounds/R01/merge/${d1.slice(0, 8)}/regate.json`, { status: 'unverified' });
  assert.equal(owner.decision('R01').state, 'ok');
  // failing re-gate → superseded (runner WAITs decision); the UI waits for the engine's rewind
  putJson(root, `rounds/R01/merge/${d1.slice(0, 8)}/regate.json`, { status: 'fail' });
  assert.deepEqual(owner.decision('R01'), { state: 'superseded', sha256: d1 });
  assert.throws(() => sim.redecide('R01', { ...DECISION, facts: ['A:A-01'] }), /退回 9b/u);
  rejectDecision(root, 'rounds/R01/decision.json', 1, 'fail');
  sim.redecide('R01', { ...DECISION, facts: ['A:A-01'], base: 'B' });
  const second = owner.decision('R01');
  assert.ok(second.state === 'ok' && second.value.file === 'rounds/R01/decision-2.json');
  if (second.state === 'ok') {
    assert.equal(second.value.supersedes, d1);
    assert.equal(second.value.base, 'B');
    assert.equal(second.sha256, sim.expected().get('rounds/R01/decision-2.json'));
  }
  // a post-merge split continues (not superseded); a post-merge fail sends it back
  const d2 = sha(root, 'rounds/R01/decision-2.json');
  putJson(root, `rounds/R01/merge/${d2.slice(0, 8)}/postmerge-gate.json`, { status: 'split' });
  assert.equal(owner.decision('R01').state, 'ok');
  putJson(root, `rounds/R01/merge/${d2.slice(0, 8)}/postmerge-gate.json`, { status: 'fail' });
  assert.deepEqual(owner.decision('R01'), { state: 'superseded', sha256: d2 });
  rmSync(root, { recursive: true });
});

test('decision chain: an unjustified decision-2.json is invalid, a gap or a missing entry is caught', () => {
  const root = world();
  const sim = ownerSim(root, testClock(START));
  const owner = ownerInputs(root);
  sim.answerAudit('R01', pickLeft);
  sim.decide('R01', DECISION);
  const d1 = rejectDecision(root, 'rounds/R01/decision.json', 1, 'split');
  sim.redecide('R01', { ...DECISION, facts: [] });
  assert.equal(owner.decision('R01').state, 'ok');
  // the gate record passes after all (or never existed) → decision-2.json is invalid
  putJson(root, `rounds/R01/merge/${d1.slice(0, 8)}/regate.json`, { status: 'pass' });
  const unjustified = owner.decision('R01');
  assert.ok(unjustified.state === 'invalid' && /no non-pass gate record/u.test(unjustified.error));
  putJson(root, `rounds/R01/merge/${d1.slice(0, 8)}/regate.json`, { status: 'split' });
  rmSync(join(root, 'rounds/R01/markers/stale'), { recursive: true });
  const notStale = owner.decision('R01');
  assert.ok(notStale.state === 'invalid' && /stale 09b/u.test(notStale.error));
  putJson(root, 'rounds/R01/markers/stale/1/09b-decision.json', { inputs: { 'rounds/R01/decision.json': d1 } });
  assert.equal(owner.decision('R01').state, 'ok');
  // a gap in the chain
  put(root, 'rounds/R01/decision-4.json', readFileSync(join(root, 'rounds/R01/decision-2.json'), 'utf8'));
  assert.equal(owner.decision('R01').state, 'invalid');
  rmSync(join(root, 'rounds/R01/decision-4.json'));
  // decision-2.json whose owner-log line was lost → repair; a changed byte → invalid
  const log = readFileSync(join(root, OWNER_LOG), 'utf8');
  put(root, OWNER_LOG, `${log.trimEnd().split('\n').slice(0, -1).join('\n')}\n`);
  assert.equal(owner.decision('R01').state, 'repair');
  put(root, OWNER_LOG, log);
  const d2 = readFileSync(join(root, 'rounds/R01/decision-2.json'), 'utf8');
  put(root, 'rounds/R01/decision-2.json', d2.replace('"平"', '"偏"'));
  assert.equal(owner.decision('R01').state, 'invalid');
  rmSync(root, { recursive: true });
});

function calibWorld(root: string): void {
  const texts: Record<string, { path: string }> = {};
  for (const id of ['C00-T01', 'C00-T02', 'C00-T03', 'C00-T04']) {
    texts[id] = { path: `texts/${id}.md` };
    put(root, `calibration/texts/${id}.md`, `文本 ${id}`);
  }
  putJson(root, 'calibration/pairs.json', {
    schema: 'calib-pairs/1',
    sets: {
      C00: {
        seed: 'ab'.repeat(32), texts,
        display: [
          { slot: 1, pair: 'C00-P01', left: 'C00-T01', right: 'C00-T02', retest_of: null },
          { slot: 2, pair: 'C00-P02', left: 'C00-T03', right: 'C00-T04', retest_of: null },
          { slot: 3, pair: 'C00-P01', left: 'C00-T02', right: 'C00-T01', retest_of: 1 },
        ],
      },
    },
  });
}

test('calibration answers: (a)–(d), partial POSTs, and a crash between file and log', () => {
  const root = world();
  calibWorld(root);
  const sim = ownerSim(root, testClock(START));
  const owner = ownerInputs(root);
  assert.deepEqual(owner.calibAnswers(), { state: 'missing' });
  sim.answerCalibration('C00', (p) => (p.leftText === '文本 C00-T01' ? 'right' : 'left'), [1]);
  sim.answerCalibration('C00', pickLeft);
  const read = owner.calibAnswers();
  assert.ok(read.state === 'ok');
  if (read.state === 'ok') {
    const answers = read.value.sets['C00']?.answers ?? [];
    assert.deepEqual(answers.map((a) => [a.slot, a.chosen]), [[1, 'C00-T02'], [2, 'C00-T03'], [3, 'C00-T02']]);
    const pairs: unknown = JSON.parse(readFileSync(join(root, 'calibration/pairs.json'), 'utf8'));
    assert.equal(read.value.sets['C00']?.pairs_sha256, sha256Bytes(Buffer.from(canonicalJson(readRecord(readRecord(pairs, 'sets'), 'C00')), 'utf8')));
  }
  const again = submitCalibAnswers(root, 'C00', [{ slot: 2, choice: 'right', ms: 10 }], START);
  assert.ok(!again.ok && again.status === 409);
  // (d) a tampered chosen, logged as if by the UI → still invalid
  const file = readFileSync(join(root, OWNER_ANSWERS), 'utf8');
  const tampered = file.replace('"chosen": "C00-T03"', '"chosen": "C00-T04"');
  put(root, OWNER_ANSWERS, tampered);
  assert.equal(owner.calibAnswers().state, 'invalid');
  appendFileSync(join(root, OWNER_LOG), `${JSON.stringify({ at: '2026-09-26T00:00:00.000Z', action: 'calib_answers', round: null, file: OWNER_ANSWERS, sha256: sha(root, OWNER_ANSWERS), source: 'ui', set: 'C00', slots: [2] })}\n`);
  assert.equal(owner.calibAnswers().state, 'invalid');
  rmSync(root, { recursive: true });
});

test('calibration answers: changed pairs → invalid; unlogged answers → repair, healed by the next POST', () => {
  const root = world();
  calibWorld(root);
  const owner = ownerInputs(root);
  assert.ok(submitCalibAnswers(root, 'C00', [{ slot: 1, choice: 'left', ms: 1200 }], START).ok);
  const log = readFileSync(join(root, OWNER_LOG), 'utf8');
  put(root, OWNER_LOG, '');
  assert.equal(owner.calibAnswers().state, 'repair');
  put(root, OWNER_LOG, log);
  // crash between the file write of the second POST and its log line
  assert.ok(submitCalibAnswers(root, 'C00', [{ slot: 2, choice: 'left', ms: null }], '2026-09-25T00:00:05.000Z').ok);
  put(root, OWNER_LOG, log);
  assert.equal(owner.calibAnswers().state, 'repair');
  assert.ok(submitCalibAnswers(root, 'C00', [{ slot: 3, choice: 'right', ms: null }], '2026-09-25T00:00:09.000Z').ok);
  const healed = owner.calibAnswers();
  assert.ok(healed.state === 'ok' && healed.value.sets['C00']?.answers.length === 3);
  // the crashed slot 2 is re-logged on its own line before the new answer's line
  assert.deepEqual(owner.entries().slice(-2).map((e) => e.slots), [[2], [3]]);
  const pairs = readFileSync(join(root, 'calibration/pairs.json'), 'utf8');
  put(root, 'calibration/pairs.json', pairs.replace('"C00-P02"', '"C00-P09"'));
  assert.equal(owner.calibAnswers().state, 'invalid');
  rmSync(root, { recursive: true });
});

function benchWorld(root: string): Record<string, string> {
  const shas: Record<string, string> = {};
  const lines: string[] = [];
  const log: Array<[string, string, string]> = [['v1', 'R00-init', 'pending_owner'], ['v2', 'R00', 'activate'], ['v3', 'R01', 'pending_owner']];
  for (const [i, [version, cycle, outcome]] of log.entries()) {
    putJson(root, `benchmark/${version}.json`, { version, note: `基准 ${version}` });
    shas[version] = sha(root, `benchmark/${version}.json`);
    lines.push(JSON.stringify({
      at: `2026-09-2${i + 1}T00:00:00.000Z`, cycle, outcome, version, parent: i === 0 ? null : `v${i}`, sha256: shas[version], path: `benchmark/${version}.json`,
      activation: outcome === 'pending_owner' ? 'owner' : 'auto', changed_keys: [], evidence_packet: null, evidence_packet_sha256: null, evidence_ids: [],
      reasons: [], errors: [], replay: null, dropped_cliches: [], protocol_bundle_sha256: 'c'.repeat(64), calls: [], source: 'engine',
    }));
  }
  put(root, 'benchmark/log.jsonl', `${lines.join('\n')}\n`);
  putJson(root, 'rounds/R01/freeze.json', {});
  putJson(root, 'rounds/R02/freeze.json', {});
  return shas;
}

test('bench view / approval / rollback entries and their UI refusals', () => {
  const root = world();
  const shas = benchWorld(root);
  const clock = testClock('2026-09-24T00:00:00.000Z');
  const sim = ownerSim(root, clock);
  const owner = ownerInputs(root);
  sim.viewBenchDiff('v2');
  assert.equal(owner.benchDiffViewed('v2', shas['v2'] ?? ''), '2026-09-24T00:00:00.000Z');
  assert.equal(owner.benchDiffViewed('v2', 'd'.repeat(64)), null);
  // v1 was superseded by the later v2 activation
  assert.throws(() => sim.approveBench('v1'), /取代/u);
  const wrongSha = submitBenchApproval(root, 'v3', 'd'.repeat(64), clock.now());
  assert.ok(!wrongSha.ok && wrongSha.status === 409);
  sim.approveBench('v3');
  assert.equal(owner.benchApproved('v3', shas['v3'] ?? ''), '2026-09-24T00:00:01.000Z');
  // rollback targets: once active (v2) or approved (v3); never-approved v1 is refused
  assert.throws(() => sim.rollback('v1', 'v3'), /曾经生效或已批准/u);
  clock.advance(86_400_000);
  sim.rollback('v2', 'v3');
  assert.deepEqual(owner.rollbacks(), [{ at: '2026-09-25T00:00:02.000Z', version: 'v2', from: 'v3', sha256: shas['v2'], round: 'R02' }]);
  const late = submitBenchApproval(root, 'v3', shas['v3'] ?? '', clock.now());
  assert.ok(!late.ok && late.status === 409);
  putJson(root, 'benchmark/v2.json', { version: 'v2', note: '改过' });
  const edited = submitRollback(root, { version: 'v2', from: 'v3', sha256: sha(root, 'benchmark/v2.json') }, clock.now());
  assert.ok(!edited.ok && edited.status === 409);
  // The UI reads the benchmark log with the engine's reader: a line the engine rejects refuses (409), never skipped.
  appendFileSync(join(root, 'benchmark', 'log.jsonl'), '{"at":"2026-09-26T00:00:00.000Z","outcome":"activate","version":"v4"}\n');
  const bad = submitBenchApproval(root, 'v3', shas['v3'] ?? '', clock.now());
  assert.ok(!bad.ok && bad.status === 409 && bad.error.startsWith('基准日志需要修复'));
  rmSync(root, { recursive: true });
});

test('diff approval carries the shown approval-diff SHA-256', () => {
  const root = world();
  const sim = ownerSim(root, testClock(START));
  const owner = ownerInputs(root);
  assert.throws(() => sim.approveDiff('R01'), /final\.json/u);
  put(root, 'rounds/R01/approval.diff', '--- a/world/current/x.md\n+++ b/world/current/x.md\n');
  const diffSha = sha(root, 'rounds/R01/approval.diff');
  putJson(root, 'rounds/R01/final.json', { round: 'R01', approval_diff_sha256: diffSha });
  const stale = submitDiffApproval(root, 'R01', 'e'.repeat(64), START);
  assert.ok(!stale.ok && stale.status === 409);
  sim.approveDiff('R01');
  assert.equal(owner.diffApproved('R01', diffSha), START);
  assert.equal(owner.diffApproved('R01', 'e'.repeat(64)), null);
  assert.equal(owner.entries().at(-1)?.file, 'rounds/R01/approval.diff');
  rmSync(root, { recursive: true });
});

test('UI writers cut a torn owner-log tail before appending; the owner-sim records what it wrote', () => {
  const root = world();
  const sim = ownerSim(root, testClock(START));
  sim.approveProtocol();
  appendFileSync(join(root, OWNER_LOG), '{"at":"2026-09-25T00:00:01.000Z","action":"au');
  assert.equal(readOwnerLog(root).ok, true);
  sim.answerAudit('R01', pickLeft);
  const text = readFileSync(join(root, OWNER_LOG), 'utf8');
  assert.equal(text.includes('"au{'), false);
  assert.equal(text.split('\n').filter((l) => l !== '').length, 2);
  const read = readOwnerLog(root);
  assert.ok(read.ok && read.value.map((e) => e.action).join() === 'protocol_approved,audit');
  assert.deepEqual([...sim.expected().keys()].sort(), [OWNER_LOG, 'rounds/R01/audit.json']);
  assert.equal(sim.expected().get(OWNER_LOG), sha(root, OWNER_LOG));
  assert.ok(read.ok && read.value[0]?.at === START && read.value[1]?.at === '2026-09-25T00:00:01.000Z');
  const redecide = submitRedecision(root, 'R01', DECISION, START);
  assert.ok(!redecide.ok && redecide.status === 409);
  rmSync(root, { recursive: true });
});

test('a present but malformed gate record makes the decision invalid instead of passing', () => {
  const root = world();
  const sim = ownerSim(root, testClock(START));
  const owner = ownerInputs(root);
  sim.answerAudit('R01', pickLeft);
  sim.decide('R01', DECISION);
  const d1 = sha(root, 'rounds/R01/decision.json');
  putJson(root, `rounds/R01/merge/${decisionDirName(d1)}/regate.json`, { status: 'passed' });
  const read = owner.decision('R01');
  assert.equal(read.state, 'invalid');
  assert.match(read.state === 'invalid' ? read.error : '', /regate\.json/u);
  putJson(root, `rounds/R01/merge/${decisionDirName(d1)}/regate.json`, { status: 'pass' });
  putJson(root, `rounds/R01/merge/${decisionDirName(d1)}/postmerge-gate.json`, { verdict: 'fail' });
  assert.equal(owner.decision('R01').state, 'invalid');
  // A present record that is not JSON at all (torn or hand-edited) is malformed too, not absent.
  rmSync(join(root, 'rounds', 'R01', 'merge', decisionDirName(d1), 'postmerge-gate.json'));
  writeFileSync(join(root, 'rounds', 'R01', 'merge', decisionDirName(d1), 'regate.json'), '{');
  assert.equal(owner.decision('R01').state, 'invalid');
  rmSync(root, { recursive: true });
});
