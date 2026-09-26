import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CandidateVerdict } from './bench-check.ts';
import {
  baseActivation, buildLogEntry, decideOutcome, INITIAL_CYCLE, initialPaths, initialRefusal, needsReplay, OUTCOME_FILE, PROPOSAL_FILE, readOutcome, readProposal,
  readValidate, VALIDATE_FILE, type ProposalFile, type ValidateFile,
} from './bench-cycle.ts';
import { parseBenchLog, type ReplaySummary } from './bench-log.ts';
import type { ChangeOutput, NoChangeOutput } from './bench-propose.ts';
import { DEFAULT_ACTIVATION } from './bench-validate.ts';
import { ownerInputs } from './owner-inputs.ts';
import { roundPaths } from './store.ts';
import { writeSet, setRecord } from './testing/calib-set.ts';
import { fakeClock } from './testing/fakes.ts';
import { FIXTURE_AT } from './testing/fixture-world.ts';
import { ownerSim } from './testing/owner-sim.ts';

const HEX = 'b'.repeat(64);
const CHANGE: ChangeOutput = { kind: 'change', body: { taste: {} }, reasons: [{ change: '改问题', keys: ['taste'], evidence_ids: ['E-R01-RES'], expected_effect: '更贴近 owner' }] };
const NO_CHANGE: NoChangeOutput = { kind: 'no_change', reasons: [{ text: '证据不足', evidence_ids: ['E-R01-AGR-xAI'] }] };

function verdict(over: Partial<CandidateVerdict>): CandidateVerdict {
  return { ok: true, errors: [], changedKeys: ['taste'], activation: 'replay', noChange: false, slotErrors: [], versionErrors: [], ...over };
}

function summary(passed: boolean): ReplaySummary {
  return { labels: ['C00-P01'], families: ['xAI'], pooled: { old: 4, new: passed ? 4 : 2, n: 4 }, per_family: { xAI: { old: 4, new: passed ? 4 : 2, n: 4, void: 0 } }, passed, reason: passed ? 'ok' : 'family_drop' };
}

test('decideOutcome: the six outcomes, first match wins', () => {
  assert.equal(decideOutcome({ output: null, verdict: null, replay: null }), 'no_change_invalid');
  assert.equal(decideOutcome({ output: NO_CHANGE, verdict: null, replay: null }), 'no_change');
  assert.equal(decideOutcome({ output: CHANGE, verdict: verdict({ ok: false, noChange: true, errors: ['change output equals head'], activation: null }), replay: null }), 'no_change', 'noChange before !ok');
  assert.equal(decideOutcome({ output: CHANGE, verdict: verdict({ ok: false, errors: ['protected key gate'], activation: null }), replay: null }), 'rejected_validate');
  assert.equal(decideOutcome({ output: CHANGE, verdict: verdict({}), replay: summary(false) }), 'rejected_by_replay');
  assert.equal(decideOutcome({ output: CHANGE, verdict: verdict({ activation: 'owner' }), replay: summary(false) }), 'rejected_by_replay', 'a failed replay rejects inside a hold too');
  assert.equal(decideOutcome({ output: CHANGE, verdict: verdict({ activation: 'owner' }), replay: summary(true) }), 'pending_owner');
  assert.equal(decideOutcome({ output: CHANGE, verdict: verdict({ activation: 'owner', changedKeys: ['decoy_recipe'] }), replay: null }), 'pending_owner');
  assert.equal(decideOutcome({ output: CHANGE, verdict: verdict({}), replay: summary(true) }), 'activate');
  assert.equal(decideOutcome({ output: CHANGE, verdict: verdict({ activation: 'auto', changedKeys: ['cliche_list'] }), replay: null }), 'activate');
  assert.equal(decideOutcome({ output: CHANGE, verdict: null, replay: null }), 'rejected_validate', 'a change without a verdict is never activated');
});

test('baseActivation / needsReplay: the keys own classes before any hold; unknown key → owner; nothing changed → null', () => {
  assert.equal(baseActivation([], DEFAULT_ACTIVATION), null);
  assert.equal(baseActivation(['cliche_list', 'bars'], DEFAULT_ACTIVATION), 'auto');
  assert.equal(baseActivation(['cliche_list', 'taste'], DEFAULT_ACTIVATION), 'replay');
  assert.equal(baseActivation(['taste', 'decoy_recipe'], DEFAULT_ACTIVATION), 'owner');
  assert.equal(baseActivation(['mystery'], DEFAULT_ACTIVATION), 'owner');
  assert.equal(needsReplay(['taste', 'decoy_recipe'], DEFAULT_ACTIVATION), true, 'replay still runs when another key makes the version owner class');
  assert.equal(needsReplay(['decoy_recipe', 'mystery'], DEFAULT_ACTIVATION), false);
  assert.equal(needsReplay([], DEFAULT_ACTIVATION), false);
});

function proposal(output: ProposalFile['output']): ProposalFile {
  return {
    cycle: 'R01', version: 'v3', parent: 'v2', parent_sha256: HEX, evidence_packet: 'benchmark/evidence/R01.json', evidence_packet_sha256: HEX, output,
    errors: output === null ? ['fenced: no json block'] : [], task: 'bench-propose-R01', calls: ['rounds/R01/calls/bench-propose-R01-a1.json'], model: 'fixture-maintainer', dropped_cliches: ['星辰大海'],
  };
}

const BASE = { at: '2026-10-02T00:00:00.000Z', cycle: 'R01', bundleSha256: HEX, written: null, candidatePath: null, candidateSha256: null };

test('buildLogEntry: activate / pending_owner name benchmark/vN.json with the written sha and the post-hold activation', () => {
  const written = { version: 'v3', sha256: 'c'.repeat(64), path: 'benchmark/v3.json' };
  const e = buildLogEntry({ ...BASE, outcome: 'pending_owner', proposal: proposal(CHANGE), verdict: verdict({ activation: 'owner' }), replay: summary(true), written, candidatePath: null, candidateSha256: null });
  assert.equal(e.version, 'v3');
  assert.equal(e.path, 'benchmark/v3.json');
  assert.equal(e.sha256, written.sha256);
  assert.equal(e.activation, 'owner');
  assert.deepEqual(e.changed_keys, ['taste']);
  assert.deepEqual(e.evidence_ids, ['E-R01-RES']);
  assert.deepEqual(e.reasons, [{ text: '改问题', keys: ['taste'], evidence_ids: ['E-R01-RES'] }]);
  assert.deepEqual(e.dropped_cliches, ['星辰大海']);
  assert.deepEqual(e.calls, ['rounds/R01/calls/bench-propose-R01-a1.json']);
  assert.equal(e.source, 'engine');
  assert.equal(e.protocol_bundle_sha256, HEX);
  assert.ok(parseBenchLog([e]).ok);
});

test('buildLogEntry: rejected_by_replay names the round-local candidate; no_change / no_change_invalid carry no version', () => {
  const rejected = buildLogEntry({ ...BASE, outcome: 'rejected_by_replay', proposal: proposal(CHANGE), verdict: verdict({}), replay: summary(false), candidatePath: 'rounds/R01/bench/candidate.json', candidateSha256: 'd'.repeat(64) });
  assert.equal(rejected.version, 'v3');
  assert.equal(rejected.path, 'rounds/R01/bench/candidate.json');
  assert.equal(rejected.sha256, 'd'.repeat(64));
  assert.deepEqual(rejected.replay, summary(false));
  assert.ok(parseBenchLog([rejected]).ok);
  const same = buildLogEntry({ ...BASE, outcome: 'no_change', proposal: proposal(CHANGE), verdict: verdict({ ok: false, noChange: true, changedKeys: [], activation: null, errors: ['change output equals head'] }), replay: null, candidatePath: 'rounds/R01/bench/candidate.json', candidateSha256: 'd'.repeat(64) });
  assert.deepEqual([same.version, same.path, same.sha256, same.activation], [null, null, null, null]);
  assert.deepEqual(same.errors, ['change output equals head']);
  const kept = buildLogEntry({ ...BASE, outcome: 'no_change', proposal: proposal(NO_CHANGE), verdict: null, replay: null });
  assert.deepEqual(kept.reasons, [{ text: '证据不足', keys: [], evidence_ids: ['E-R01-AGR-xAI'] }]);
  assert.deepEqual(kept.errors, []);
  const invalid = buildLogEntry({ ...BASE, outcome: 'no_change_invalid', proposal: proposal(null), verdict: null, replay: null });
  assert.deepEqual([invalid.version, invalid.reasons, invalid.evidence_ids, invalid.errors], [null, [], [], ['fenced: no json block']]);
  const validateErr = buildLogEntry({ ...BASE, outcome: 'rejected_validate', proposal: proposal(CHANGE), verdict: verdict({ ok: false, activation: null, errors: ['protected key gate'], slotErrors: ['taste.template: missing slot {TEXT_1}'], versionErrors: ['version must be v3'] }), replay: null, candidatePath: 'rounds/R01/bench/candidate.json', candidateSha256: 'd'.repeat(64) });
  assert.deepEqual(validateErr.errors, ['protected key gate', 'taste.template: missing slot {TEXT_1}', 'version must be v3']);
  assert.ok(parseBenchLog([rejected, { ...same, cycle: 'R02' }, { ...invalid, cycle: 'R03' }, { ...validateErr, cycle: 'R04', version: 'v4' }]).ok);
});

test('initialPaths: bench-initial lives flat in benchmark/initial (bench = dir), runs and sealed under bench-initial', () => {
  const p = initialPaths('/forge');
  assert.equal(p.id, 'R00');
  assert.equal(p.dir, '/forge/benchmark/initial');
  assert.equal(p.bench, p.dir);
  assert.equal(p.markers, '/forge/benchmark/initial/markers');
  assert.equal(p.tasks, '/forge/benchmark/initial/tasks');
  assert.equal(p.calls, '/forge/benchmark/initial/calls');
  assert.equal(p.status, '/forge/benchmark/initial/status.json');
  assert.equal(p.runs, '/forge/.runs/bench-initial');
  assert.equal(p.sealed, '/forge/.sealed/bench-initial');
  assert.equal(INITIAL_CYCLE, 'R00-init');
});

test('initialRefusal: none on a fresh root; refused once calibration/owner-answers.json or a calib_answers entry exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-initial-'));
  assert.equal(initialRefusal(root, ownerInputs(root)), null);
  writeSet(root, 'C00', setRecord('C00', 'round0', null));
  const sim = ownerSim(root, fakeClock(FIXTURE_AT));
  sim.answerCalibration('C00', () => 'left', [1]);
  assert.match(initialRefusal(root, ownerInputs(root)) ?? '', /calib_answers/u);
  sim.removeOwnerFile('calibration/owner-answers.json');
  assert.match(initialRefusal(root, ownerInputs(root)) ?? '', /calib_answers/u, 'the owner-log entry alone refuses');
  const bare = mkdtempSync(join(tmpdir(), 'forge-initial-'));
  ownerSim(bare, fakeClock(FIXTURE_AT)).writeUnlogged('calibration/owner-answers.json', { sets: {} });
  assert.match(initialRefusal(bare, ownerInputs(bare)) ?? '', /owner-answers\.json/u, 'the answers file alone refuses');
});

function put(dir: string, name: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

test('readProposal / readValidate / readOutcome: null when absent, the value back, err naming the file when malformed', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-cycle-files-'));
  const paths = roundPaths(root, 'R01');
  assert.equal(readProposal(paths), null);
  assert.equal(readValidate(paths), null);
  assert.equal(readOutcome(paths), null);
  for (const p of [proposal(CHANGE), proposal(NO_CHANGE), proposal(null)]) {
    put(paths.bench, PROPOSAL_FILE, p);
    assert.deepEqual(readProposal(paths), { ok: true, value: p });
  }
  const v: ValidateFile = { version: 'v3', parent: 'v2', verdict: verdict({ activation: 'owner' }), base_activation: 'replay', holds: [{ round: 1, rolledBackKeys: ['taste'] }] };
  put(paths.bench, VALIDATE_FILE, v);
  assert.deepEqual(readValidate(paths), { ok: true, value: v });
  const line = buildLogEntry({ ...BASE, outcome: 'no_change', proposal: proposal(NO_CHANGE), verdict: null, replay: null });
  put(paths.bench, OUTCOME_FILE, line);
  assert.deepEqual(readOutcome(paths), { ok: true, value: line });
  put(paths.bench, PROPOSAL_FILE, { ...proposal(CHANGE), version: 'v0.1' });
  const bad = readProposal(paths);
  assert.ok(bad !== null && !bad.ok && bad.error.startsWith('rounds/R01/bench/proposal.json'));
  put(paths.bench, PROPOSAL_FILE, { ...proposal(CHANGE), output: { kind: 'change', reasons: [] } });
  assert.ok(readProposal(paths)?.ok === false, 'a change output needs a body');
  put(paths.bench, VALIDATE_FILE, { ...v, verdict: { ...v.verdict, activation: 'later' } });
  assert.ok(readValidate(paths)?.ok === false);
  put(paths.bench, OUTCOME_FILE, { ...line, outcome: 'maybe' });
  assert.ok(readOutcome(paths)?.ok === false);
  put(paths.bench, OUTCOME_FILE, '{not json');
  const torn = readOutcome(paths);
  assert.ok(torn !== null && !torn.ok && torn.error.includes('rounds/R01/bench/outcome.json'));
});
