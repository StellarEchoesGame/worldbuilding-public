import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { roundCommand } from '../../../../engine/cli-round.ts';
import { sha256Bytes } from '../../../../engine/owner-inputs.ts';
import { readStatus } from '../../../../engine/runner.ts';
import { deps, must, pickTopic, readObject, ROUND, world, type World } from '../../../../engine/testing/round-script.ts';
import { submitRedecision, type DecisionInput } from '../owner.ts';
import { redecideView } from './redecide.ts';

/*
 * 重新决策 view on the round-script world (as engine/steps/merge-pipeline.test.ts): the round waits at 09b, the owner
 * decides with facts from two candidates, a contradicting re-gate fails 10a and the engine rewinds to 09b.
 */

const PID = 7201;

async function run(x: World, argv: readonly string[]): Promise<number> {
  return roundCommand(argv, deps(x, PID), x.at);
}

async function toDecision(): Promise<World> {
  const x = world({ claims: true });
  x.sim.approveProtocol();
  assert.equal(await run(x, ['start', ROUND]), 2, x.logs.join('\n'));
  pickTopic(x, join(x.w.root, 'rounds', ROUND));
  assert.equal(await run(x, ['run', ROUND]), 2, x.logs.join('\n'));
  x.sim.answerAudit(ROUND, () => 'left');
  assert.equal(await run(x, ['run', ROUND]), 2, x.logs.join('\n'));
  assert.equal(must(readStatus(x.w.root, ROUND)).waiting_for, 'decision');
  return x;
}

function labels(x: World): { base: string; donor: string } {
  const l = readObject(join(x.w.root, 'rounds', ROUND, 'labels.json'));
  const of = (id: string): string => Object.entries(l).find(([, v]) => v === id)?.[0] ?? '';
  return { base: of('W1'), donor: of('W2-r2') };
}

/** Decides with base + donor facts; the contradicting re-gate rewinds the round to 09b. */
async function rewound(): Promise<{ x: World; base: string; donor: string; sha: string }> {
  const x = await toDecision();
  const { base, donor } = labels(x);
  x.script.mergeContradiction = (kind) => kind === 'regate';
  x.sim.decide(ROUND, { pick: base, reason: '平', fav: base, publish: 'no', facts: [`${base}:A-01`, `${donor}:A-01`] });
  const sha = sha256Bytes(readFileSync(join(x.w.root, 'rounds', ROUND, 'decision.json')));
  const view = redecideView(x.w.root, ROUND);
  assert.equal(view.allowed, false, 'no gate record yet');
  assert.match(view.reason ?? '', /过门/u);
  assert.equal(view.current?.sha256, sha);
  assert.equal(await run(x, ['run', ROUND]), 2, x.logs.join('\n'));
  assert.equal(must(readStatus(x.w.root, ROUND)).step, '09b-decision');
  return { x, base, donor, sha };
}

test('redecideView: a bad round id or a round without a decision is not open', async () => {
  const x = await toDecision();
  const bad = redecideView(x.w.root, '../R01');
  assert.equal(bad.allowed, false);
  assert.equal(bad.current, null);
  const none = redecideView(x.w.root, ROUND);
  assert.deepEqual(none, { round: ROUND, allowed: false, reason: '这一轮还没有决策，请先提交第一份决策。', current: null, rejectionPath: null, nextFile: null, rejection: null, unlogged: [] });
});

test('redecideView: open after a contradicting re-gate rewound the round (current decision, rejection path, next file)', async () => {
  const { x, base, donor, sha } = await rewound();
  const view = redecideView(x.w.root, ROUND);
  assert.equal(view.reason, null);
  assert.equal(view.allowed, true);
  assert.deepEqual(view.current, { file: `rounds/${ROUND}/decision.json`, sha256: sha, pick: base, base: null, facts: [`${base}:A-01`, `${donor}:A-01`] });
  assert.equal(view.rejectionPath, `rounds/${ROUND}/merge/${sha.slice(0, 8)}/regate.json`);
  assert.equal(view.nextFile, 'decision-2.json');
  assert.ok(view.rejection !== null);
  assert.equal(view.rejection.status, 'fail');
  assert.deepEqual(view.rejection.trialLabels, []);
  assert.equal(view.rejection.judges.length, 2);
  for (const j of view.rejection.judges) {
    assert.equal(j.yes, true);
    assert.ok(j.findings.length > 0 && j.findings.every((f) => f.reason !== '' && f.quote !== ''), 'each yes judge shows its findings');
  }

  // the owner re-decides: decision-2.json has no gate record, so the page closes again
  x.sim.redecide(ROUND, { pick: base, reason: '平', fav: base, publish: 'no', facts: [`${base}:A-01`] });
  const after = redecideView(x.w.root, ROUND);
  assert.equal(after.allowed, false);
  assert.equal(after.current?.file, `rounds/${ROUND}/decision-2.json`);
  assert.equal(after.nextFile, 'decision-3.json');
});

test('redecideView: closed while the engine has not moved the 09b marker to stale, and on a broken chain', async () => {
  const { x } = await rewound();
  const markers = join(x.w.root, 'rounds', ROUND, 'markers');
  renameSync(join(markers, 'stale'), join(markers, 'stale-moved'));
  const unpinned = redecideView(x.w.root, ROUND);
  assert.equal(unpinned.allowed, false);
  assert.match(unpinned.reason ?? '', /引擎还没有把这一轮退回 9b/u);
  assert.ok(unpinned.rejectionPath !== null);
  renameSync(join(markers, 'stale-moved'), join(markers, 'stale'));

  // a chain gap through the owner's own tools: redecide (decision-2.json), then the hand-deleted decision.json
  const { base } = labels(x);
  x.sim.redecide(ROUND, { pick: base, reason: '平', fav: base, publish: 'no', facts: [`${base}:A-01`] });
  x.sim.removeOwnerFile(`rounds/${ROUND}/decision.json`);
  assert.equal(existsSync(join(x.w.root, 'rounds', ROUND, 'decision-2.json')), true);
  const gap = redecideView(x.w.root, ROUND);
  assert.equal(gap.allowed, false);
  assert.match(gap.reason ?? '', /决策链有问题/u);
  assert.equal(gap.current, null);
});

test('redecideView: a malformed gate record is not a rejection', async () => {
  const { x, sha } = await rewound();
  writeFileSync(join(x.w.root, 'rounds', ROUND, 'merge', sha.slice(0, 8), 'regate.json'), '{"status":"maybe"}');
  const view = redecideView(x.w.root, ROUND);
  assert.equal(view.allowed, false);
  assert.match(view.reason ?? '', /无法读取/u);
  assert.equal(view.rejectionPath, `rounds/${ROUND}/merge/${sha.slice(0, 8)}/regate.json`);
});

const EMPTY: DecisionInput = { pick: '', reason: '', fav: '', publish: '', facts: [] };

test('redecideView: a chain file without its owner-log line closes the page as submitRedecision would, and names the file', async () => {
  const { x } = await rewound();
  const log = join(x.w.root, 'owner-log.jsonl');
  const lines = readFileSync(log, 'utf8').split('\n');
  // the owner log lost the decision line (a crash between the file write and the log append, or a hand edit)
  writeFileSync(log, lines.filter((l) => !l.includes('"action":"decision"')).join('\n'));
  const view = redecideView(x.w.root, ROUND);
  assert.equal(view.allowed, false);
  assert.match(view.reason ?? '', /没有记入 owner 日志/u);
  assert.deepEqual(view.unlogged, [`rounds/${ROUND}/decision.json`]);
  // the page's repair button posts an empty form: submitRedecision re-logs first and refuses without writing a decision
  const repaired = submitRedecision(x.w.root, ROUND, EMPTY, x.ports.clock.now());
  assert.ok(!repaired.ok && repaired.status === 409 && /补记/u.test(repaired.error));
  assert.equal(existsSync(join(x.w.root, 'rounds', ROUND, 'decision-2.json')), false);
  const after = redecideView(x.w.root, ROUND);
  assert.deepEqual([after.allowed, after.reason, after.unlogged], [true, null, []]);
});

test('redecideView: an unlogged newest decision file names it (not the gate-record reason); an unreadable chain file is reported, not thrown', async () => {
  const { x, base, sha } = await rewound();
  x.sim.writeUnlogged(`rounds/${ROUND}/decision-2.json`, { round: ROUND, pick: base, supersedes: sha });
  const view = redecideView(x.w.root, ROUND);
  assert.equal(view.allowed, false);
  assert.deepEqual(view.unlogged, [`rounds/${ROUND}/decision-2.json`]);
  x.sim.removeOwnerFile(`rounds/${ROUND}/decision-2.json`);
  mkdirSync(join(x.w.root, 'rounds', ROUND, 'decision-2.json'));
  const unreadable = redecideView(x.w.root, ROUND);
  assert.equal(unreadable.allowed, false);
  assert.match(unreadable.reason ?? '', /decision-2\.json 无法读取/u);
  assert.ok(!(unreadable.reason ?? '').includes(x.w.root));
});
