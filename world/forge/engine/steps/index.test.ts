import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freezeCommand, roundCommand } from '../cli-round.ts';
import type { RunHooks } from '../context.ts';
import { isRecord, readArray, readNumber, readRecord, readString } from '../json.ts';
import { sha256Bytes } from '../marker.ts';
import { mirrorMarker } from '../mirror.ts';
import { probeMarker } from '../probe.ts';
import { LOCK_FILE, readStatus, STEP_IDS, verifyChain } from '../runner.ts';
import { unwrap } from '../tasks/fenced.ts';
import { FIXTURE_GATEWAY_HOST } from '../testing/fixture-world.ts';
import {
  allCalls, DECOY_LOVER, deps, filesUnder, must, pickTopic, readObject, ROUND, schemaErrors, SEALED_VALUE, world,
} from '../testing/round-script.ts';
import { ROUND_STEPS } from './index.ts';

/*
 * Cross-module fixture round (PR-A + PR-B; the world lives in testing/round-script.ts): the real ROUND_STEPS
 * 00-start … 09b-decision through `forge round
 * start|run|status` and `forge freeze --check`, on fixtureWorld with fake ports and backends scripted per role. The
 * owner approves the protocol, picks the topic, answers the audit and decides through owner-sim; the run is killed
 * inside 04-write and again inside 06b (throwing afterCall hooks, the in-process crash path) and each new "process"
 * resumes with zero repeated paid calls.
 */

const PID_KILLED = 4101;
const PID_RESUME = 4102;
const PID_TASTE_KILLED = 4103;
const PID_FINAL = 4104;
const KILL_AFTER = 'write-W2';
/** The 06b kill fires in the afterCall of this many-th taste call. */
const KILL_TASTE_AT = 5;

test('ROUND_STEPS ids are a prefix of STEP_IDS in order, ending at 11e-agreement (PR-A … 05a, PR-B 05b … 09b, PR-D 10a … 11e)', () => {
  const ids = ROUND_STEPS.map((s) => s.id);
  assert.deepEqual(ids, STEP_IDS.slice(0, ids.length));
  assert.equal(ids[ids.indexOf('05a-gate-mech') + 1], '05b-defect');
  assert.equal(ids[ids.indexOf('09b-decision') + 1], '10a-regate');
  assert.equal(ids[ids.length - 1], '11e-agreement');
});

test('a fixture round runs 00-start … 09b-decision through the CLI: kills inside 04-write and 06b resume with no repeated paid call; owner waits at 09a and 09b', async () => {
  const x = world();
  const round = join(x.w.root, 'rounds', ROUND);
  const status = () => must(readStatus(x.w.root, ROUND));
  const ids = ROUND_STEPS.map((s) => s.id).slice(0, ROUND_STEPS.findIndex((s) => s.id === '09b-decision') + 1);
  const prefix = ids.slice(0, ids.indexOf('05a-gate-mech') + 1);

  // 00-start waits for the protocol approval before touching git or GitHub.
  assert.equal(await roundCommand(['start', ROUND], deps(x, PID_KILLED), x.at), 2, x.logs.join('\n'));
  assert.equal(status().waiting_for, 'protocol_approval');
  assert.equal(x.ports.github.issues().length, 0);
  x.sim.approveProtocol();

  // round start again: 00-start done (branch, sub-issue under the epic), 01-topic waits for the owner's pick.
  assert.equal(await roundCommand(['start', ROUND], deps(x, PID_KILLED), x.at), 2, x.logs.join('\n'));
  assert.equal(status().step, '01-topic');
  assert.equal(status().waiting_for, 'topic');
  assert.deepEqual(await x.ports.git.currentBranch(), { ok: true, value: 'forge/r01' });
  const issues = x.ports.github.issues();
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.parent, 1, 'the round sub-issue hangs under github.json epic_issue');
  pickTopic(x, round);

  // round run is killed inside 04-write: W2's call record is written, its task record is not.
  const kill: RunHooks = {
    afterCall: (taskId) => {
      if (taskId === KILL_AFTER) throw new Error('simulated kill');
    },
  };
  await assert.rejects(roundCommand(['run', ROUND], deps(x, PID_KILLED, kill), x.at), /simulated kill/u);
  assert.match(readFileSync(join(x.w.root, LOCK_FILE), 'utf8'), new RegExp(`"pid":${PID_KILLED}`, 'u'), 'a crash leaves the lock');
  assert.equal(status().state, 'running', 'a crash is never shown as the previous state');
  assert.equal(existsSync(join(round, 'calls', `${KILL_AFTER}-a1.json`)), true);
  assert.equal(existsSync(join(round, 'tasks', `${KILL_AFTER}.json`)), false);
  assert.equal(existsSync(join(round, 'markers', '03c-probe-mirror.json')), true);
  assert.equal(existsSync(join(round, 'markers', '04-write.json')), false);
  const beforeResume = allCalls(x);

  // A new process resumes to 05a: the dead lock is taken over, W2 is recovered from calls/ + .runs, nothing is called twice.
  assert.equal(await roundCommand(['run', ROUND, '--until', '05a-gate-mech'], deps(x, PID_RESUME), x.at), 0, x.logs.join('\n'));
  const calls = allCalls(x);
  assert.equal(new Set(calls).size, calls.length, `a paid call was repeated: ${calls.join(', ')}`);
  assert.ok(beforeResume.includes(`${KILL_AFTER}#1`));
  const forecasters = x.backends.forecasters.map((b) => `forecast-${b.id}#1`);
  assert.deepEqual([...calls].sort(), ['baseline-BASE#1', ...forecasters, 'write-W1#1', 'write-W2#1', 'write-W3#1', 'write-W3#2'].sort());
  assert.equal(status().state, 'done');
  assert.deepEqual(status().done, prefix);
  assert.equal(existsSync(join(x.w.root, LOCK_FILE)), false);
  assert.match(readFileSync(join(round, 'progress.jsonl'), 'utf8'), new RegExp(`lock taken over from pid ${PID_KILLED}`, 'u'));
  assert.deepEqual(verifyChain(x.w.root, `rounds/${ROUND}`, prefix), []);
  assert.equal(await roundCommand(['status', ROUND, '--verify'], deps(x, PID_RESUME), x.at), 0, x.logs.join('\n'));
  assert.equal(await freezeCommand(['--check', ROUND], deps(x, PID_RESUME), x.at), 0, x.logs.join('\n'));

  // Git and GitHub: one 03c commit on the round branch (start, topic, brief, freeze, probes.sha256), one push, one probe comment.
  const commits = x.ports.git.commits('forge/r01');
  assert.equal(commits.length, 1);
  for (const f of ['start.json', 'topic.json', 'brief.json', 'freeze.json', 'probes.sha256']) assert.ok(commits[0]?.paths.includes(`world/forge/rounds/${ROUND}/${f}`), f);
  assert.deepEqual(x.ports.git.pushes(), ['forge/r01']);
  const comments = x.ports.github.comments(issues[0]?.number);
  assert.equal(comments.length, 1);
  assert.ok(comments[0]?.body.startsWith(probeMarker(ROUND)));

  // W3's first-attempt gateway error is stored redacted; the retry answered.
  const w3: unknown = JSON.parse(readFileSync(join(round, 'calls', 'write-W3-a1.json'), 'utf8'));
  assert.match(readString(w3, 'error') ?? '', /\[redacted:gateway-host\]/u);
  assert.equal(readString(JSON.parse(readFileSync(join(round, 'tasks', 'write-W3.json'), 'utf8')), 'status'), 'ok');

  // PR-B: the run is killed inside 06b (after the KILL_TASTE_AT-th taste call); 05b … 06a are marked, 06b is not.
  let taste = 0;
  const tasteKill: RunHooks = {
    afterCall: (taskId) => {
      if (taskId.startsWith('taste-')) taste += 1;
      if (taste === KILL_TASTE_AT) throw new Error('simulated kill in 06b');
    },
  };
  await assert.rejects(roundCommand(['run', ROUND], deps(x, PID_TASTE_KILLED, tasteKill), x.at), /simulated kill in 06b/u);
  for (const step of ['05b-defect', '05c-gate-llm', '05d-resubmit', '06a-decoy']) assert.equal(existsSync(join(round, 'markers', `${step}.json`)), true, step);
  assert.equal(existsSync(join(round, 'markers', '06b-champion-pairs.json')), false);
  const beforeTasteResume = allCalls(x);

  // A new process resumes: 06b … 08, then 09a writes audit-set.json and waits for the owner's audit (exit 2).
  assert.equal(await roundCommand(['run', ROUND], deps(x, PID_FINAL), x.at), 2, x.logs.join('\n'));
  assert.equal(status().step, '09a-audit');
  assert.equal(status().waiting_for, 'audit');
  const resumed = allCalls(x);
  assert.equal(new Set(resumed).size, resumed.length, `a paid call was repeated after the 06b kill: ${resumed.join(', ')}`);
  assert.ok(beforeTasteResume.filter((c) => c.startsWith('taste-')).length >= KILL_TASTE_AT);
  assert.match(readFileSync(join(round, 'progress.jsonl'), 'utf8'), new RegExp(`lock taken over from pid ${PID_TASTE_KILLED}`, 'u'));

  // 09a: audit-set.json exists before any answer, 4 pairs split 2 visible / 2 reserve, each with a label.
  assert.equal(existsSync(join(round, 'audit.json')), false);
  const auditSet = readObject(join(round, 'audit-set.json'));
  assert.deepEqual(schemaErrors(x.w.root, 'audit-set', auditSet), []);
  const auditPairs = readArray(auditSet, 'pairs') ?? [];
  assert.equal(auditPairs.length, 4);
  const splits = auditPairs.map((p) => readString(p, 'split'));
  assert.equal(splits.filter((s) => s === 'visible').length, 2);
  assert.equal(splits.filter((s) => s === 'reserve').length, 2);
  for (const p of auditPairs) assert.ok((readString(p, 'label') ?? '') !== '');
  const auditSetBytes = readFileSync(join(round, 'audit-set.json'));

  // owner-sim answers the audit → 09a done, 09b waits for the decision; audit-set.json is reused, never rewritten.
  x.sim.answerAudit(ROUND, () => 'left');
  assert.equal(await roundCommand(['run', ROUND], deps(x, PID_FINAL), x.at), 2, x.logs.join('\n'));
  assert.equal(status().step, '09b-decision');
  assert.equal(status().waiting_for, 'decision');
  assert.deepEqual(readFileSync(join(round, 'audit-set.json')), auditSetBytes);

  // owner-sim decides → 09b done (this test stops there; steps/merge-pipeline.test.ts goes on).
  const labels = readObject(join(round, 'labels.json'));
  const pick = Object.keys(labels).sort()[0] ?? '';
  assert.notEqual(pick, '');
  x.sim.decide(ROUND, { pick, reason: '平', fav: pick, publish: 'no', facts: [] });
  assert.equal(await roundCommand(['run', ROUND, '--until', '09b-decision'], deps(x, PID_FINAL), x.at), 0, x.logs.join('\n'));
  assert.equal(status().state, 'done');
  assert.deepEqual(status().done, ids);
  assert.equal(existsSync(join(x.w.root, LOCK_FILE)), false);
  assert.deepEqual(verifyChain(x.w.root, `rounds/${ROUND}`, ids), []);
  assert.equal(await roundCommand(['status', ROUND, '--verify'], deps(x, PID_FINAL), x.at), 0, x.logs.join('\n'));
  const finalCalls = allCalls(x);
  assert.equal(new Set(finalCalls).size, finalCalls.length, `a paid call was repeated: ${finalCalls.join(', ')}`);

  // 05b: one defect copy per round, of one seeded gate-bound submission, sent only to that submission's gate judges.
  const gateFile = (name: string): Record<string, unknown> => readObject(join(round, 'gate', `${name}.json`));
  const defect = gateFile('defect');
  assert.deepEqual(schemaErrors(x.w.root, 'gate', defect, 'defect'), []);
  assert.equal(readString(defect, 'status'), 'ok');
  const defectSub = readString(defect, 'submission') ?? '';
  assert.deepEqual(finalCalls.filter((c) => c.startsWith('defect-')), [`defect-${defectSub}#1`]);
  const subGate = gateFile(defectSub);
  assert.deepEqual(schemaErrors(x.w.root, 'gate', subGate, 'submission'), []);
  const judgesOfSub = readArray(subGate, 'judges') ?? [];
  const copyFamilies = finalCalls.filter((c) => c.startsWith('gatecopy-')).map((c) => c.split('-')[2] ?? '');
  for (const c of finalCalls.filter((c) => c.startsWith('gatecopy-'))) assert.ok(c.startsWith(`gatecopy-${defectSub}-`), c);
  assert.deepEqual([...copyFamilies].sort(), judgesOfSub.map((j) => readString(j, 'family') ?? '').sort(), 'the copy reaches exactly that submission\'s judges');

  // 05c: the family that missed the copy loses all its verdicts of the round; a reserve replaces it (fresh calls).
  const llm = gateFile('llm');
  assert.deepEqual(schemaErrors(x.w.root, 'gate', llm, 'llm'), []);
  const blind = x.script.blind;
  assert.ok(blind !== null);
  assert.deepEqual((readArray(llm, 'voided_families') ?? []).map((v) => [readString(v, 'family'), readString(v, 'reason')]), [[blind, 'missed_copy']]);
  assert.equal(readString(llm, 'defect_submission'), defectSub);
  assert.ok(judgesOfSub.some((j) => isRecord(j) && j['family'] === blind && j['voided'] === true));
  assert.ok(judgesOfSub.some((j) => isRecord(j) && j['reserve'] === true && j['caught'] === true), 'a reserve family judged the copy and caught it');
  for (const sub of ['W1', 'W2', 'W3']) {
    const g = gateFile(sub);
    assert.equal((readArray(g, 'counted') ?? []).includes(blind), false, `${sub}: the blind family's verdict never counts`);
  }
  assert.equal(readString(readRecord(readRecord(llm, 'submissions'), 'W2'), 'outcome'), 'fail');

  // 05d: W2 failed the gate → one blind resubmission (byte-identical prompt, new task id), a fresh `-re` gate pass
  // by families not voided in 05c, no new defect copy.
  const resubmit = gateFile('resubmit');
  assert.deepEqual(schemaErrors(x.w.root, 'gate', resubmit, 'resubmit'), []);
  assert.deepEqual(readArray(resubmit, 'passing'), ['W1', 'W2-r2', 'W3']);
  const w2Router = x.backends.writers.find((w) => w.slot === 'W2')?.backend;
  const w2Prompts = x.routers.find((r) => r === w2Router)?.log() ?? [];
  assert.deepEqual(w2Prompts.map((c) => c.taskId), ['write-W2', 'write-W2-r2']);
  assert.equal(w2Prompts[1]?.prompt, w2Prompts[0]?.prompt, 'the resubmission prompt equals the first (no gate feedback)');
  const regate = finalCalls.filter((c) => c.startsWith('gate-W2-r2-'));
  assert.equal(regate.length, 2);
  for (const c of regate) assert.match(c, /-re#1$/u);
  assert.equal(regate.some((c) => c.includes(`-${blind}-`)), false);
  assert.equal(finalCalls.some((c) => c.startsWith('gatecopy-W2-r2')), false);
  assert.equal(existsSync(join(round, 'submissions', 'W2-r2.json')), true);

  // 06a / 06b: the decoy is applied by the engine; the decoy lover prefers it in W1's s1 and in the rerun s1r → it
  // drops out of E for W1 only (|E| 4 → 3, bar 6/6); the other pairs keep all four families (bar 7/8).
  assert.equal(existsSync(join(round, 'decoy.json')), true);
  assert.equal(existsSync(join(round, 'submissions', 'DECOY.json')), true);
  assert.deepEqual(finalCalls.filter((c) => c.startsWith('decoy-')), ['decoy-DECOY#1']);
  const pairsFile = readObject(join(round, 'pairs.json'));
  assert.deepEqual(schemaErrors(x.w.root, 'pairs', pairsFile), []);
  const w1Pair = (readArray(pairsFile, 'pairs') ?? []).find((p) => readString(p, 'id') === 'W1');
  assert.deepEqual(readArray(w1Pair, 'dropped'), [DECOY_LOVER]);
  assert.equal(finalCalls.filter((c) => c.startsWith(`taste-W1-${DECOY_LOVER}-s1r-`)).length, 2);
  assert.equal(finalCalls.filter((c) => /^taste-[^-]+(-r2)?-[A-Za-z]+-s\dr-/u.test(c)).length, 2, 'only the decoy lover reran');
  const tally = readObject(join(round, 'tally.json'));
  assert.deepEqual(schemaErrors(x.w.root, 'tally', tally), []);
  const champion = (pair: string): unknown => (readArray(tally, 'champion_pairs') ?? []).find((p) => readString(p, 'pair') === pair);
  assert.equal((readArray(champion('W1'), 'e') ?? []).length, 3);
  assert.equal(readString(champion('W1'), 'bar'), '6/6');
  assert.equal(readString(champion('W3'), 'bar'), '7/8');
  assert.equal(readNumber(readRecord(tally, 'voids'), 'dropped_families'), 1);

  // 06c: every sub–sub pair judged by 2 seeded families × one call per order, no decoy, no rerun.
  const aux = readObject(join(round, 'taste', 'aux', 'pairs.json'));
  assert.deepEqual(schemaErrors(x.w.root, 'pairs', aux), []);
  assert.deepEqual((readArray(aux, 'pairs') ?? []).map((p) => readString(p, 'kind')), ['sub_sub', 'sub_sub', 'sub_sub']);
  const auxCalls = finalCalls.filter((c) => /^taste-W[^-]*(-r2)?\.W/u.test(c));
  assert.equal(auxCalls.length, 12);
  assert.equal(auxCalls.some((c) => /-s\dr-|-s[1-9]-/u.test(c)), false);
  for (const c of x.routers.flatMap((r) => r.log()).filter((c) => /^taste-W[^-]*(-r2)?\.W/u.test(c.taskId))) assert.equal(unwrap(c.prompt, '文本丙'), null, c.taskId);

  // 06d: the four measure files per passing submission validate; 07a: the unseal is valid and holds no plaintext;
  // 07b: a surprise report per passing submission.
  for (const sub of ['W1', 'W2-r2', 'W3']) {
    for (const kind of ['recall', 'skin-swap', 'cold-reader', 'producer']) {
      assert.deepEqual(schemaErrors(x.w.root, 'measures', readObject(join(round, 'measures', kind, `${sub}.json`))), [], `${kind}/${sub}`);
    }
  }
  const unseal = readObject(join(round, 'unseal.json'));
  assert.deepEqual(schemaErrors(x.w.root, 'unseal', unseal), []);
  assert.equal(readString(unseal, 'status'), 'valid', JSON.stringify(unseal));
  assert.equal(readNumber(unseal, 'forecasters'), x.backends.forecasters.length);
  const surprise = readObject(join(round, 'surprise.json'));
  assert.deepEqual(schemaErrors(x.w.root, 'surprise', surprise), []);
  assert.deepEqual(Object.keys(readRecord(surprise, 'submissions') ?? {}).sort(), ['W1', 'W2-r2', 'W3']);
  const firstMatch = finalCalls.findIndex((c) => c.startsWith('match-'));
  assert.ok(firstMatch > 0);

  // 08: tally / card validate; labels map A/B/C to the passing submissions; cost from the call records; wild seeds.
  const card = readObject(join(round, 'card.json'));
  assert.deepEqual(schemaErrors(x.w.root, 'card', card), []);
  assert.deepEqual((readArray(card, 'entries') ?? []).map((e) => readString(e, 'submission')).sort(), ['W1', 'W2-r2', 'W3']);
  assert.deepEqual(Object.values(labels).sort(), ['W1', 'W2-r2', 'W3']);
  assert.deepEqual(Object.keys(labels).sort(), ['A', 'B', 'C']);
  const cost = readObject(join(round, 'cost.json'));
  const attempts = Object.values(readRecord(cost, 'by_backend') ?? {}).reduce<number>((n, b) => n + (readNumber(b, 'attempts') ?? 0), 0);
  assert.ok(attempts > 0);
  assert.deepEqual(readRecord(readObject(join(round, 'wild-seeds.json')), 'seeds'), { W1: ['一'], 'W2-r2': ['一'], W3: ['一'] });

  // Git and GitHub: PR-B steps commit nothing; the end-of-run drains posted the card (after the audit) and the
  // decision, each once, next to the probe.
  assert.equal(x.ports.git.commits('forge/r01').length, 1);
  const bodies = x.ports.github.comments().map((c) => c.body.split('\n', 1)[0] ?? '');
  const decisionSha = sha256Bytes(readFileSync(join(round, 'decision.json')));
  assert.deepEqual(bodies, [probeMarker(ROUND), mirrorMarker('card', ROUND, ROUND), mirrorMarker('decision', ROUND, decisionSha)]);

  // No gateway host in any engine-written file; no sealed forecast value in a tracked file, a GitHub body or any
  // prompt except the surprise matchers' (after 07a unsealed).
  const tracked = filesUnder(x.w.root, x.w.root).filter((rel) => !rel.startsWith('.sealed/') && !rel.includes('.runs/') && rel !== 'local.json');
  const written = [...filesUnder(x.w.root, round), ...filesUnder(x.w.root, join(x.w.root, '.sealed'))];
  for (const rel of written) assert.equal(readFileSync(join(x.w.root, rel), 'utf8').includes(FIXTURE_GATEWAY_HOST), false, rel);
  for (const rel of tracked) assert.equal(SEALED_VALUE.test(readFileSync(join(x.w.root, rel), 'utf8')), false, rel);
  for (const i of x.ports.github.issues()) assert.equal(SEALED_VALUE.test(`${i.title}\n${i.body}`), false, i.title);
  for (const c of x.ports.github.comments()) assert.equal(SEALED_VALUE.test(c.body), false, c.body);
  const prompts = x.routers.flatMap((r) => r.log());
  assert.ok(prompts.some((c) => c.taskId.startsWith('match-') && SEALED_VALUE.test(c.prompt)), 'the matchers see the unsealed forecasts');
  for (const c of prompts) if (!c.taskId.startsWith('match-')) assert.equal(SEALED_VALUE.test(c.prompt), false, c.taskId);

  // The engine wrote no owner-only file: owner-log.jsonl, topic.json, audit.json and decision.json are byte-identical
  // to what owner-sim wrote.
  const owned = [...x.sim.expected().keys()];
  for (const f of ['owner-log.jsonl', `rounds/${ROUND}/topic.json`, `rounds/${ROUND}/audit.json`, `rounds/${ROUND}/decision.json`]) assert.ok(owned.includes(f), f);
  for (const [rel, sha] of x.sim.expected()) assert.equal(sha256Bytes(readFileSync(join(x.w.root, rel))), sha, rel);
  rmSync(x.dir, { recursive: true, force: true });
});

test('a kill after 03c amended freeze.json but before its marker resumes: 03c reruns without a second comment and marks', async () => {
  const x = world();
  const round = join(x.w.root, 'rounds', ROUND);
  x.sim.approveProtocol();
  assert.equal(await roundCommand(['start', ROUND], deps(x, PID_KILLED), x.at), 2, x.logs.join('\n'));
  const offered = readArray(JSON.parse(readFileSync(join(round, 'topic-offer.json'), 'utf8')), 'top3')?.[0];
  const rowId = readString(offered, 'row_id');
  const layer = readString(offered, 'layer');
  assert.ok(rowId !== null && layer !== null);
  x.sim.pickTopic(ROUND, { row_id: rowId, layer });
  assert.equal(await roundCommand(['run', ROUND, '--until', '03c-probe-mirror'], deps(x, PID_KILLED), x.at), 0, x.logs.join('\n'));
  const freeze: unknown = JSON.parse(readFileSync(join(round, 'freeze.json'), 'utf8'));
  assert.notEqual(readString(freeze, 'probe_created_at'), null, '03c amended freeze.json');
  // The state a kill between settle() and the runner's marker write leaves behind: probe.json, amended freeze.json, no 03c marker.
  rmSync(join(round, 'markers', '03c-probe-mirror.json'));
  assert.equal(await roundCommand(['run', ROUND, '--until', '03c-probe-mirror'], deps(x, PID_RESUME), x.at), 0, x.logs.join('\n'));
  assert.equal(existsSync(join(round, 'markers', '03c-probe-mirror.json')), true);
  assert.deepEqual(verifyChain(x.w.root, `rounds/${ROUND}`, ROUND_STEPS.map((s) => s.id)), []);
  assert.equal(x.ports.github.comments(x.ports.github.issues()[0]?.number).length, 1);
  assert.deepEqual(x.ports.git.pushes(), ['forge/r01']);
  // freeze.json changed in any other key than probe_created_at is still an integrity problem.
  rmSync(join(round, 'markers', '03c-probe-mirror.json'));
  const text = readFileSync(join(round, 'freeze.json'), 'utf8');
  writeFileSync(join(round, 'freeze.json'), text.replace('"seed": "', '"seed": "0'));
  assert.equal(await roundCommand(['run', ROUND, '--until', '03c-probe-mirror'], deps(x, PID_RESUME), x.at), 3, x.logs.join('\n'));
  rmSync(x.dir, { recursive: true, force: true });
});
