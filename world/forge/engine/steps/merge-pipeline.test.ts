import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mergeCommand, mirrorCommand, postMergeCommand } from '../cli-merge.ts';
import { roundCommand } from '../cli-round.ts';
import { isRecord, readArray, readRecord, readString } from '../json.ts';
import { readMarker, sha256Bytes } from '../marker.ts';
import { mirrorMarker } from '../mirror.ts';
import { ownerInputs } from '../owner-inputs.ts';
import { probeMarker } from '../probe.ts';
import { readStatus, verifyChain } from '../runner.ts';
import { FORECAST_COUNT } from '../tasks/forecast.ts';
import { diskCanon } from '../testing/fake-assembler.ts';
import { FIXTURE_GATEWAY_HOST } from '../testing/fixture-world.ts';
import { allCalls, deps, filesUnder, must, pickTopic, readObject, ROUND, world, type World } from '../testing/round-script.ts';
import { ROUND_STEPS } from './index.ts';

/*
 * PR-D fixture pipeline: the scripted round of testing/round-script.ts (every writer registers one fact) through
 * `forge round start|run` to the owner's decision, then `forge merge R01` and `forge round run` on to 11e-agreement,
 * all through the CLI command functions. A decision with facts from two candidates meets a contradicting re-gate
 * judge (rewind to 09b, canon = main); the owner re-decides with the base's own fact only and the merge commits
 * reference 8.2; 11a–11e publish the seal, pool the forecasts, crown the pick, tag the scene and rebuild trust.
 */

const PID = 5101;
const ISSUE_OF = (x: World): number => x.ports.github.issues()[0]?.number ?? -1;

function status(x: World): { state: string; step: string | null; waiting_for: string | null; detail: string; done: readonly string[] } {
  return must(readStatus(x.w.root, ROUND));
}

/** Repo-relative → content of main's world/current (the fixture canon). */
function mainCanon(x: World): Record<string, string> {
  return Object.fromEntries(Object.entries(x.w.main).filter(([p]) => p.startsWith('world/current/')).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** First lines of every GitHub comment, in creation order. */
function markers(x: World): string[] {
  return x.ports.github.comments().map((c) => c.body.split('\n', 1)[0] ?? '');
}

function markerResult(x: World, rel: string): string | null {
  const m = readMarker(join(x.w.root, 'rounds', ROUND, 'markers', rel));
  return m === null || !m.ok ? null : m.value.result;
}

async function round(x: World, argv: readonly string[]): Promise<number> {
  return roundCommand(argv, deps(x, PID), x.at);
}

/** Labels of W1 (the pick and base) and of W2's resubmission (the fact donor). */
function labelsOf(x: World): { base: string; donor: string } {
  const labels = readObject(join(x.w.root, 'rounds', ROUND, 'labels.json'));
  const of = (id: string): string => Object.entries(labels).find(([, v]) => v === id)?.[0] ?? '';
  return { base: of('W1'), donor: of('W2-r2') };
}

/** Brings the scripted round to 09b waiting for the decision (the audit answered), checking the card waits for the audit. */
async function toDecision(x: World): Promise<void> {
  x.sim.approveProtocol();
  assert.equal(await round(x, ['start', ROUND]), 2, x.logs.join('\n'));
  pickTopic(x, join(x.w.root, 'rounds', ROUND));
  assert.equal(await round(x, ['run', ROUND]), 2, x.logs.join('\n'));
  assert.equal(status(x).waiting_for, 'audit');
  assert.deepEqual(markers(x), [probeMarker(ROUND)], 'no card comment before the audit (blindness)');
  x.sim.answerAudit(ROUND, () => 'left');
  assert.equal(await round(x, ['run', ROUND]), 2, x.logs.join('\n'));
  assert.equal(status(x).waiting_for, 'decision');
  assert.deepEqual(markers(x), [probeMarker(ROUND), mirrorMarker('card', ROUND, ROUND)], 'the card is mirrored once the audit exists');
}

test('forge merge on the scripted round: a contradicting re-gate rewinds to 09b; a re-decision merges 8.2; round run finishes 11a–11e; mirrors post once', async () => {
  const x = world({ claims: true });
  const dir = join(x.w.root, 'rounds', ROUND);
  await toDecision(x);
  const { base, donor } = labelsOf(x);
  assert.ok(base !== '' && donor !== '' && base !== donor);

  // forge merge is refused (exit 1) until 09b pins a decision.
  assert.equal(await mergeCommand([ROUND], deps(x, PID), x.at), 1);
  assert.match(x.logs.at(-1) ?? '', /09b-decision is not marked/u);

  // A+B facts and a contradicting re-gate judge: 09b pins decision.json, 10a fails and rewinds (exit 2).
  x.script.mergeContradiction = (kind) => kind === 'regate';
  x.sim.decide(ROUND, { pick: base, reason: '平', fav: base, publish: 'no', facts: [`${base}:A-01`, `${donor}:A-01`] });
  const d8a = sha256Bytes(readFileSync(join(dir, 'decision.json'))).slice(0, 8);
  assert.equal(await round(x, ['run', ROUND]), 2, x.logs.join('\n'));
  const rewound = status(x);
  assert.deepEqual([rewound.step, rewound.waiting_for, rewound.detail], ['09b-decision', 'decision', `regate_failed:${d8a}`]);
  const regate = readObject(join(dir, 'merge', d8a, 'regate.json'));
  assert.equal(regate['status'], 'fail');
  const judges = readArray(regate, 'judges') ?? [];
  assert.equal(judges.length, 2);
  for (const j of judges) assert.equal(isRecord(j) ? j['yes'] : null, true);
  assert.deepEqual(readdirSync(join(dir, 'markers', 'stale', '1')).sort(), ['09b-decision.json', '10a-regate.json']);
  assert.equal(markerResult(x, 'stale/1/10a-regate.json'), 'rewind');
  assert.equal(existsSync(join(dir, 'markers', '09b-decision.json')), false);
  assert.deepEqual(diskCanon(x.w.repo), mainCanon(x), 'world/current equals main after the rewind');
  assert.equal(x.ports.git.commits('forge/r01').length, 1, 'no merge commit');
  assert.equal(ownerInputs(x.w.root).decision(ROUND).state, 'superseded');
  assert.deepEqual(markers(x), [probeMarker(ROUND), mirrorMarker('card', ROUND, ROUND)], 'a superseded decision is never mirrored');

  // The owner re-decides (the base's own fact only): forge merge still waits for 09b; round run pins decision-2.json.
  x.script.mergeContradiction = () => false;
  x.sim.redecide(ROUND, { pick: base, reason: '平', fav: base, publish: 'no', facts: [`${base}:A-01`] });
  assert.equal(await mergeCommand([ROUND], deps(x, PID), x.at), 1);
  // a failing mirror post never changes the exit code; the decision stays pending (backoff) until a later drain
  x.ports.github.failNext('createComment', 1);
  assert.equal(await round(x, ['run', ROUND, '--until', '09b-decision']), 0, x.logs.join('\n'));
  assert.equal(markers(x).length, 2);
  x.ports.clock.advance(2 * 60_000);
  const decision2 = sha256Bytes(readFileSync(join(dir, 'decision-2.json')));
  const d8b = decision2.slice(0, 8);
  assert.notEqual(d8b, d8a);
  const paidBefore = allCalls(x);

  // forge merge: 10a skip, 10b–10f under d8b, one merge commit with exact paths; the failed attempt dir stays.
  assert.equal(await mergeCommand([ROUND], deps(x, PID), x.at), 0, x.logs.join('\n'));
  assert.deepEqual([status(x).state, status(x).step], ['done', '10f-commit']);
  assert.equal(markerResult(x, '10a-regate.json'), 'skip');
  for (const f of ['plan', 'edit', 'apply', 'mergecheck', 'post-merge', 'postmerge-gate']) assert.ok(existsSync(join(dir, 'merge', d8b, `${f}.json`)), f);
  assert.equal(existsSync(join(dir, 'merge', d8b, 'regate.json')), false);
  assert.ok(existsSync(join(dir, 'merge', d8a, 'regate.json')), 'the failed attempt stays as evidence');
  const paid = allCalls(x).filter((c) => !paidBefore.includes(c));
  assert.deepEqual(paid.filter((c) => !c.startsWith('postmerge-')), [`merge-${d8b}#1`]);
  assert.equal(paid.filter((c) => c.startsWith(`postmerge-${d8b}-`)).length, 2);
  for (const step of ['10b-merge-edit', '10c-apply', '10d-post-merge-freeze', '10e-post-merge-gate', '10f-commit']) assert.equal(markerResult(x, `${step}.json`), 'done', step);
  assert.equal(readObject(join(dir, 'merge', d8b, 'postmerge-gate.json'))['status'], 'pass');
  assert.equal(readObject(join(dir, 'merge', d8b, 'plan.json'))['editor'], 'llm');
  assert.deepEqual(readObject(join(dir, 'merge', d8b, 'mergecheck.json')), { ok: true, violations: [] });
  assert.deepEqual(readObject(join(dir, 'merge.json')), { round: ROUND, current: d8b, decision_sha256: decision2, status: 'merged_on_branch', revision: '8.2', reasons: [] });
  const canon = diskCanon(x.w.repo);
  const main = mainCanon(x);
  const manifest: unknown = JSON.parse(canon['world/current/reference/manifest.json'] ?? '');
  assert.equal(readString(manifest, 'revision'), '8.2');
  assert.ok((readArray(manifest, 'files') ?? []).includes('09-scenes-and-people.md'));
  assert.equal(canon['world/current/BOOK.md'], main['world/current/BOOK.md']);
  const baseBook = (tree: Record<string, string>): string | null => readString(JSON.parse(tree['world/current/reference/hashes.json'] ?? '{}'), 'base_book_sha256');
  assert.equal(baseBook(canon), baseBook(main));
  assert.match(canon['world/current/reference/09-scenes-and-people.md'] ?? '', /## R01｜配给簿/u);
  const commits = x.ports.git.commits('forge/r01');
  assert.equal(commits.length, 2);
  assert.equal(commits[1]?.message, `feat: add sample scene R01, reference 8.2 (#${ISSUE_OF(x)})`);
  assert.deepEqual([...(commits[1]?.paths ?? [])].sort(), [
    'world/current/REVISION.md', 'world/current/reference/05-ecology-and-everyday.md', 'world/current/reference/07-register-and-creation.md',
    'world/current/reference/09-scenes-and-people.md', 'world/current/reference/CHANGES.md', 'world/current/reference/REFERENCE.md',
    'world/current/reference/hashes.json', 'world/current/reference/manifest.json', 'world/forge/rounds/R01/merge.json',
    `world/forge/rounds/R01/merge/${d8a}/regate.json`,
    ...['apply', 'edit', 'mergecheck', 'plan', 'post-merge', 'postmerge-gate'].map((f) => `world/forge/rounds/R01/merge/${d8b}/${f}.json`),
  ], 'the commit holds the changed canon, both attempt dirs (the fake expands rounds/R01/merge) and merge.json');
  assert.equal(await postMergeCommand(['--post-merge', '--check'], deps(x, PID), x.at), 0, x.logs.join('\n'));
  assert.equal(await postMergeCommand(['--post-merge', ROUND], deps(x, PID), x.at), 0, x.logs.join('\n'));
  assert.match(x.logs.at(-1) ?? '', new RegExp(`rounds/R01/merge/${d8b}/post-merge\\.json pinned`, 'u'));
  assert.deepEqual(markers(x), [probeMarker(ROUND), mirrorMarker('card', ROUND, ROUND), mirrorMarker('decision', ROUND, decision2)]);

  // round run continues 11a–11e to done (the build's pipeline ends at 11e).
  const labelsBefore = readFileSync(join(x.w.root, 'calibration', 'status.json'), 'utf8');
  assert.equal(await round(x, ['run', ROUND]), 0, x.logs.join('\n'));
  const ids = ROUND_STEPS.map((s) => s.id);
  assert.deepEqual([status(x).state, status(x).done], ['done', ids]);
  assert.deepEqual(verifyChain(x.w.root, `rounds/${ROUND}`, ids), []);
  assert.deepEqual(readFileSync(join(dir, 'unsealed', 'sealed.json')), readFileSync(join(x.w.root, '.sealed', ROUND, 'sealed.json')));
  assert.equal(readObject(join(dir, 'unsealed', 'recheck.json'))['seal'], 'verified');
  const pool = readFileSync(join(x.w.root, 'regression', 'forecast-pool.jsonl'), 'utf8').trim().split('\n');
  assert.equal(pool.length, x.backends.forecasters.length * FORECAST_COUNT);
  const rowId = readString(readObject(join(dir, 'brief.json')), 'row_id') ?? '';
  const champion = readRecord(readObject(join(x.w.root, 'champions.json')), rowId);
  assert.deepEqual([readString(champion, 'kind'), readString(champion, 'round'), readString(champion, 'submission')], ['owner_pick', ROUND, 'W1']);
  const tagging = readObject(join(dir, 'tagging.json'));
  assert.ok((readArray(tagging, 'kept') ?? []).length > 0, JSON.stringify(tagging));
  assert.ok(Object.keys(readRecord(readObject(join(x.w.root, 'map', 'tags.json')), 'cells') ?? {}).length > 0);
  assert.equal(typeof readObject(join(dir, 'thinmap-delta.json'))['all_targets_above'], 'boolean');
  assert.ok(existsSync(join(x.w.root, 'calibration', 'labels.json')));
  assert.notEqual(readFileSync(join(x.w.root, 'calibration', 'status.json'), 'utf8'), labelsBefore, '11e rebuilt the trust status');
  const paidDone = allCalls(x);
  assert.equal(new Set(paidDone).size, paidDone.length, 'no paid call repeated');

  // Idempotent: another run changes nothing and calls nothing; mirrors: the card and decision-2 exactly once.
  assert.equal(await round(x, ['run', ROUND]), 0, x.logs.join('\n'));
  assert.deepEqual(allCalls(x), paidDone);
  assert.equal(await mirrorCommand(['--round', ROUND], deps(x, PID), x.at), 0);
  assert.equal(await mirrorCommand(['--dry-run'], deps(x, PID), x.at), 0);
  assert.match(x.logs.at(-1) ?? '', /no pending mirror/u);
  assert.deepEqual(markers(x), [probeMarker(ROUND), mirrorMarker('card', ROUND, ROUND), mirrorMarker('decision', ROUND, decision2)]);

  // Owner files are byte-identical to what owner-sim wrote; no gateway host in any file or comment.
  for (const [rel, sha] of x.sim.expected()) assert.equal(sha256Bytes(readFileSync(join(x.w.root, rel))), sha, rel);
  const written = [...filesUnder(x.w.root, x.w.root).filter((rel) => rel !== 'local.json').map((rel) => join(x.w.root, rel)), ...Object.keys(canon).map((rel) => join(x.w.repo, rel))];
  for (const path of written) assert.equal(readFileSync(path, 'utf8').includes(FIXTURE_GATEWAY_HOST), false, path);
  for (const c of x.ports.github.comments()) assert.equal(c.body.includes(FIXTURE_GATEWAY_HOST), false);
  rmSync(x.dir, { recursive: true, force: true });
});
