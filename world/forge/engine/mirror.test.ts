import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fakeBackend } from './adapters/fake.ts';
import type { CardEntry, CardFact, CardJson } from './card.ts';
import { loadConfig } from './config.ts';
import { buildContext, type RoundBackends, type StepContext } from './context.ts';
import { sourcesFromRound } from './inputs.ts';
import { mergeDecisionFrom } from './merge.ts';
import { mirroredAt, readMirrorLog } from './mirror-log.ts';
import {
  MIRROR_BACKOFF_CAP_MS, drainMirrors, mirrorBackoffMs, mirrorIssue, mirrorMarker, pendingMirrors, type PendingMirror,
} from './mirror.ts';
import { ownerInputs, sha256Bytes } from './owner-inputs.ts';
import { runSteps, type StepDef } from './runner.ts';
import { roundPaths, sha256 } from './store.ts';
import type { ChampionPairResult, RoundTally, SubmissionMeasures } from './tally.ts';
import { fakePorts, type FakePorts } from './testing/fakes.ts';
import { DEFAULT_FIXTURE, FIXTURE_GATEWAY_HOST, fixtureWorld } from './testing/fixture-world.ts';
import { ownerSim, type OwnerSim } from './testing/owner-sim.ts';

const ROUND = 'R01';
const ISSUE = 12;
const START = '2026-10-01T06:00:00.000Z';
const MIN = 60_000;
/** Candidate texts and card excerpts: never in a mirror body. */
const SCENE = { W1: '温芮把借来的扳手挂回工具墙。', W3: '林澈在冷凝管旁数着循环泵的节拍。' };
const WANTS = '想在换班前把滤网换好';
const SHOT = '扳手挂回墙上的特写';
const MODELS = { W1: 'model-w1-fixture', W3: 'model-w3-fixture' };
const CLAIMS = { A1: '第三邻里的工具墙按班次编号', A2: '冷凝管每晚换一次滤网', B1: '借用签写在柜门内侧', LEAK: `借用签上印着 ${FIXTURE_GATEWAY_HOST} 的字样` };

interface H {
  dir: string;
  ctx: StepContext;
  ports: FakePorts;
  sim: OwnerSim;
}

function put(ctx: StepContext, rel: string, value: unknown): void {
  const path = join(ctx.paths.dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writerText(id: 'W1' | 'W3', claims: ReadonlyArray<{ id: string; claim: string }>): string {
  const delta = {
    new_proper_nouns: [],
    claims: claims.map((c) => ({
      id: c.id, kind: 'author_fact', claim: c.claim, status: '状态与路径实例', row_id: 'SHIP', attaches_to: '05', extends: 'F07', misuse: 'x', source_quote: SCENE[id], register: true,
    })),
  };
  const iface = { shots: [{}, {}, {}], object: {}, hook: {} };
  return ['```submission', SCENE[id], '```', '```delta', JSON.stringify(delta), '```', '```interface', JSON.stringify(iface), '```'].join('\n');
}

function measures(): SubmissionMeasures {
  return { hook: 0.5, skin_swap: 'inactive', cold_reader: { status: 'inactive', clarity: null }, interface: 'pass', surprise: { status: 'inactive', surprising: 0, eligible: 0 } };
}

function pair(label: string, submission: string, trial: boolean): ChampionPairResult {
  return {
    pair: `${submission}.BASE`, submission, label, e: trial ? ['Anthropic', 'Moonshot'] : ['Anthropic', 'Moonshot', 'OpenAI', 'xAI'], shadow: [], dropped: [],
    wins_by_family: { Anthropic: 2, Moonshot: 2 }, total_wins: trial ? 4 : 7, needed: trial ? 4 : 7, bar: trial ? 'trial' : '7/8', beats_champion: !trial, trial,
    signs: { plus: 3, minus: 1, tie: 0 }, p_value: 0.03,
  };
}

function tally(): RoundTally {
  return {
    v: 2, round: ROUND, benchmark: 'v1', champion: 'owner_pick', session_pairs: 2, champion_pairs: [pair('A', 'W3', false), pair('B', 'W1', true)], aux_pairs: [],
    ordering: { W1: 0.4, W3: 0.6 }, gate: { W1: 'pass', W3: 'pass' }, measures: { W1: measures(), W3: measures() },
    voids: { calls: 40, void_tasks: 1, retried_tasks: 2, session_reruns: 0, dropped_families: 1 },
  };
}

function entry(label: string, submission: 'W1' | 'W3', trial: boolean, facts: CardFact[]): CardEntry {
  return {
    submission, slot: submission, label, resubmitted: false, flags: trial ? ['trial'] : [], mergeable: !trial,
    wins: { total: trial ? 4 : 7, needed: trial ? 4 : 7, e: trial ? 2 : 4, bar: trial ? 'trial' : '7/8', beats_champion: !trial, by_family: { Anthropic: 2 } },
    gate: { outcome: 'pass', counted: ['Anthropic', 'Moonshot'], path_instance_notes: [] },
    protagonist: { name: '温芮', wants: WANTS, cost: null, source: 'cold_reader' },
    interface: { status: 'pass', shots: [SHOT], object: null, hook: null, play_type: null },
    measures: measures(), facts, text_sha256: sha256(SCENE[submission]),
  };
}

function fact(id: string, claim: string): CardFact {
  return { id, claim, kind: 'author_fact', register: true, flags: [] };
}

function card(b1: string): CardJson {
  return {
    v: 1, round: ROUND, row_id: 'SHIP', benchmark: 'v1', champion: 'owner_pick', flags: [],
    entries: [entry('A', 'W3', false, [fact('c1', CLAIMS.A1), fact('c2', CLAIMS.A2)]), entry('B', 'W1', true, [fact('c1', b1)])],
  };
}

/** R01 after 08 (labels A = W3, B = W1; tally.json, card.json, audit-set.json), start.json on issue #12; no owner file yet. */
function harness(opts: { leak?: boolean } = {}): H {
  const dir = mkdtempSync(join(tmpdir(), 'forge-mirror-'));
  const w = fixtureWorld(dir, DEFAULT_FIXTURE);
  const config = loadConfig(w.root, { requireLocal: true });
  if (!config.ok) throw new Error(config.error);
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: START, seed: 'mirror' });
  const b = fakeBackend('x', 'DeepSeek', () => '');
  const backends: RoundBackends = { writers: [], baseline: b, decoy: b, defect: b, judges: [], forecasters: [], maintainer: b, mergeEditor: b, calibGateway: new Map() };
  const built = buildContext({
    root: w.root, repo: w.repo, roundId: ROUND, pipeline: 'round', paths: roundPaths(w.root, ROUND), config: config.value,
    deps: { ports, backends: () => backends, env: {}, pid: 7, isAlive: () => true, log: () => undefined },
    startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
  });
  if (!built.ok) throw new Error(built.error);
  const ctx = built.value;
  const b1 = opts.leak === true ? CLAIMS.LEAK : CLAIMS.B1;
  put(ctx, 'start.json', {
    round: ROUND, seed: 'e'.repeat(64), branch: 'forge/r01', base_sha: 'f'.repeat(40), issue: { number: ISSUE, url: `https://github.invalid/fake/issues/${ISSUE}` },
    bundle_sha256: ctx.bundleSha256, doctor_sha256: sha256('doctor'), started_at: START, cell: 'cells/ship.json',
  });
  put(ctx, 'labels.json', { A: 'W3', B: 'W1' });
  put(ctx, 'submissions/W3.json', { id: 'W3', kind: 'writer', model: MODELS.W3, family: 'DeepSeek', stance: 's', ok: true, error: null, text: writerText('W3', [{ id: 'c1', claim: CLAIMS.A1 }, { id: 'c2', claim: CLAIMS.A2 }]) });
  put(ctx, 'submissions/W1.json', { id: 'W1', kind: 'writer', model: MODELS.W1, family: 'DeepSeek', stance: 's', ok: true, error: null, text: writerText('W1', [{ id: 'c1', claim: b1 }]) });
  put(ctx, 'audit-set.json', { round: ROUND, pairs: [{ id: 'R01-audit-1', left: 'A', right: 'B' }] });
  put(ctx, 'tally.json', tally());
  put(ctx, 'card.json', card(b1));
  return { dir, ctx, ports, sim: ownerSim(w.root, ports.clock) };
}

function pending(h: H): PendingMirror[] {
  const r = pendingMirrors(h.ctx.root, ROUND, h.ports.clock.now());
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function one(h: H, kind: PendingMirror['kind']): PendingMirror {
  const p = pending(h).find((m) => m.kind === kind);
  if (p === undefined) throw new Error(`no pending ${kind}`);
  return p;
}

function decide(h: H, facts: string[], base = 'A'): string {
  h.sim.decide(ROUND, { pick: 'A', base, reason: '平', fav: 'B', publish: 'no', facts });
  return sha256Bytes(readFileSync(join(h.ctx.paths.dir, 'decision.json')));
}

function createCalls(h: H): number {
  return h.ports.github.calls().filter((c) => c.op === 'createComment').length;
}

function assertNoCandidateText(body: string): void {
  for (const text of [SCENE.W1, SCENE.W3, WANTS, SHOT]) assert.ok(!body.includes(text), `body carries candidate text ${text}`);
}

test('mirrorMarker is the first-line marker; mirrorBackoffMs is min(2^n min, 6 h)', () => {
  assert.equal(mirrorMarker('decision', ROUND, 'a'.repeat(64)), `<!-- forge:decision R01 ${'a'.repeat(64)} -->`);
  assert.equal(mirrorMarker('card', ROUND, ROUND), '<!-- forge:card R01 R01 -->');
  assert.deepEqual([1, 2, 3, 8].map((n) => mirrorBackoffMs(n) / MIN), [2, 4, 8, 256]);
  assert.equal(mirrorBackoffMs(9), MIRROR_BACKOFF_CAP_MS);
  assert.equal(mirrorBackoffMs(40), 6 * 3600 * 1000);
});

test('card is not pending before audit.json; after the audit it is, with labels, bars and verdicts but no author model; probe is never queued', () => {
  const h = harness();
  put(h.ctx, 'probe.json', { probe: 'a'.repeat(64) });
  assert.deepEqual(pending(h), [], 'tally.json + card.json alone are not enough (blindness)');
  h.sim.answerAudit(ROUND, () => 'left');
  const p = one(h, 'card');
  assert.deepEqual(pending(h).map((m) => m.kind), ['card']);
  assert.equal(p.key, ROUND);
  assert.equal(p.failures, 0);
  assert.equal(p.nextAttemptAt, h.ports.clock.now(), 'a fresh mirror is due at once');
  const shas = ['tally.json', 'card.json', 'audit.json'].map((f) => sha256Bytes(readFileSync(join(h.ctx.paths.dir, f))));
  assert.equal(p.source_sha256, sha256(shas.join('\n')));
  assert.equal(p.body.split('\n')[0], '<!-- forge:card R01 R01 -->');
  for (const word of ['A', 'B', '7/8', 'trial', 'beats champion', 'pass', 'SHIP', 'v1']) assert.ok(p.body.includes(word), `card body lacks ${word}`);
  assert.ok(p.body.includes('| B | trial | 4 | 4 | 2 | trial (not mergeable) | pass | no |'), 'a trial verdict says why it cannot merge');
  assert.ok(p.body.includes('| A | 7/8 | 7 | 7 | 4 | beats champion | pass | yes |'), 'only trial verdicts carry the note');
  assert.ok(p.body.includes(sha256(SCENE.W3)), 'text hashes are evidence');
  for (const model of Object.values(MODELS)) assert.ok(!p.body.includes(model), 'no author model before a decision');
  assertNoCandidateText(p.body);
  for (const claim of [CLAIMS.A1, CLAIMS.A2, CLAIMS.B1]) assert.ok(!p.body.includes(claim), 'card claims wait for the decision body');
  rmSync(h.dir, { recursive: true });
});

test('an ok decision is pending under its file SHA-256 with exactly the Rxx the merge registers; the card body then names author models', () => {
  const h = harness();
  put(h.ctx, 'submissions/BASE.json', { id: 'BASE', kind: 'baseline', model: 'model-base-fixture', family: 'DeepSeek', stance: null, ok: true, error: null, text: writerText('W1', []) });
  h.sim.answerAudit(ROUND, () => 'left');
  // ticked out of card order (A c1, c2, then B c1), onto base B ≠ pick A, so A's facts are donors
  const sha = decide(h, ['B:c1', 'A:c2', 'A:c1'], 'B');
  assert.deepEqual(pending(h).map((m) => m.kind), ['card', 'decision']);
  const d = one(h, 'decision');
  assert.deepEqual([d.key, d.source_sha256], [sha, sha]);
  assert.equal(d.body.split('\n')[0], `<!-- forge:decision R01 ${sha} -->`);
  const listed = d.body.split('\n').filter((l) => /^- R01-\d{2} /u.test(l));
  assert.deepEqual(listed, [`- R01-01 · label A, fact \`c1\` — ${CLAIMS.A1}`, `- R01-02 · label A, fact \`c2\` — ${CLAIMS.A2}`, `- R01-03 · label B, fact \`c1\` — ${CLAIMS.B1}`]);
  const decision = ownerInputs(h.ctx.root).decision(ROUND);
  const sources = sourcesFromRound(h.ctx.root, ROUND);
  const merged = decision.state === 'ok' && sources.ok ? mergeDecisionFrom(decision.value, sources.value, 'SHIP') : null;
  if (merged === null || !merged.ok) throw new Error('fixture: the merge cannot number the decision');
  assert.deepEqual(listed.map((l) => l.split(' — ')[0]), merged.value.registered.map((r) => `- ${r.rxx} · label ${r.label}, fact \`${r.factId}\``));
  assertNoCandidateText(d.body);
  const c = one(h, 'card');
  for (const model of Object.values(MODELS)) assert.ok(c.body.includes(model), `card body lacks ${model} once the decision is ok`);
  rmSync(h.dir, { recursive: true });
});

test('facts the merge cannot number get no Rxx in the decision body: owner order and the reason instead', () => {
  const h = harness();
  h.sim.answerAudit(ROUND, () => 'left');
  decide(h, ['A:c2', 'A:c1']);
  const c = card(CLAIMS.B1);
  put(h.ctx, 'card.json', { ...c, entries: c.entries.map((e) => (e.label === 'A' ? { ...e, facts: e.facts.filter((f) => f.id !== 'c2') } : e)) });
  const d = one(h, 'decision');
  assert.ok(!/R01-\d{2}/u.test(d.body), 'the card lacks A/c2, so mergeDecisionFrom rejects the decision: no invented Rxx');
  assert.ok(d.body.includes("Facts not numbered (2): the merge cannot register them (decision: fact A/c2 is not in that candidate's delta)."));
  assert.ok(d.body.indexOf(CLAIMS.A2) < d.body.indexOf(CLAIMS.A1), 'listed in the owner order');
  rmSync(h.dir, { recursive: true });
});

test('drain posts each mirror once; a second drain makes no GitHub call; mirroredAt returns the fake created_at', async () => {
  const h = harness();
  h.sim.answerAudit(ROUND, () => 'left');
  const sha = decide(h, ['A:c1']);
  assert.deepEqual(await drainMirrors(h.ctx), { posted: 2, failed: 0, rejected: 0 });
  const comments = h.ports.github.comments(ISSUE);
  assert.deepEqual(comments.map((c) => c.body.split('\n')[0]), ['<!-- forge:card R01 R01 -->', `<!-- forge:decision R01 ${sha} -->`]);
  assert.equal(mirroredAt(h.ctx.root, ROUND, 'decision', sha), comments[1]?.createdAt);
  assert.deepEqual(pending(h), []);
  const calls = h.ports.github.calls().length;
  assert.deepEqual(await drainMirrors(h.ctx), { posted: 0, failed: 0, rejected: 0 });
  assert.equal(h.ports.github.calls().length, calls, 'nothing pending → no listComments either');
  rmSync(h.dir, { recursive: true });
});

test('a superseded decision is never posted; the redecision is, under its own SHA-256', async () => {
  const h = harness();
  h.sim.answerAudit(ROUND, () => 'left');
  assert.deepEqual(await drainMirrors(h.ctx), { posted: 1, failed: 0, rejected: 0 });
  const first = decide(h, ['A:c1', 'B:c1']);
  put(h.ctx, `merge/${first.slice(0, 8)}/regate.json`, { status: 'fail' });
  assert.deepEqual(pending(h), [], 'owner.decision() is superseded: nothing to mirror');
  assert.deepEqual(await drainMirrors(h.ctx), { posted: 0, failed: 0, rejected: 0 });
  put(h.ctx, 'markers/stale/1/09b-decision.json', { inputs: { 'rounds/R01/decision.json': first } });
  h.sim.redecide(ROUND, { pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: ['A:c1'] });
  const second = sha256Bytes(readFileSync(join(h.ctx.paths.dir, 'decision-2.json')));
  assert.deepEqual(pending(h).map((m) => [m.kind, m.key]), [['decision', second]]);
  assert.deepEqual(await drainMirrors(h.ctx), { posted: 1, failed: 0, rejected: 0 });
  const bodies = h.ports.github.comments(ISSUE).map((c) => c.body);
  assert.equal(bodies.filter((b) => b.startsWith(`<!-- forge:decision R01 ${first}`)).length, 0, 'the superseded file is never mirrored');
  assert.ok(bodies.some((b) => b.includes(`supersedes \`${first}\``)), 'its hash appears only as the provenance of the redecision');
  assert.ok(bodies.some((b) => b.startsWith(`<!-- forge:decision R01 ${second} -->`)));
  rmSync(h.dir, { recursive: true });
});

test('failures back off 2, 4, 8 min from the last failure; a mirror not due makes no call', async () => {
  const h = harness();
  h.sim.answerAudit(ROUND, () => 'left');
  h.ports.github.failNext('createComment', 3);
  const due = async (failures: number, waitMin: number): Promise<void> => {
    const report = await drainMirrors(h.ctx);
    assert.deepEqual(report, { posted: 0, failed: 1, rejected: 0 });
    const p = one(h, 'card');
    const last = readMirrorLog(h.ctx.root, ROUND);
    assert.ok(last.ok);
    const at = last.value.at(-1)?.at ?? '';
    assert.equal(p.failures, failures);
    assert.equal(p.nextAttemptAt, new Date(Date.parse(at) + waitMin * MIN).toISOString());
    assert.equal(p.lastError, 'fake github: createComment failed');
    const calls = createCalls(h);
    h.ports.clock.advance(waitMin * MIN - 1000);
    assert.deepEqual(await drainMirrors(h.ctx), { posted: 0, failed: 0, rejected: 0 });
    assert.equal(createCalls(h), calls, 'not due yet');
    h.ports.clock.advance(1000);
  };
  await due(1, 2);
  await due(2, 4);
  await due(3, 8);
  assert.deepEqual(await drainMirrors(h.ctx), { posted: 1, failed: 0, rejected: 0 });
  assert.equal(createCalls(h), 4);
  rmSync(h.dir, { recursive: true });
});

test('the fixture gateway host in a body → rejected_scan without any GitHub call, never retried automatically', async () => {
  const h = harness({ leak: true });
  h.sim.answerAudit(ROUND, () => 'left');
  assert.deepEqual(await drainMirrors(h.ctx), { posted: 1, failed: 0, rejected: 0 }, 'the card carries no claim, so it posts');
  decide(h, ['B:c1']);
  const calls = h.ports.github.calls().length;
  assert.deepEqual(await drainMirrors(h.ctx), { posted: 0, failed: 0, rejected: 1 });
  assert.equal(h.ports.github.calls().length, calls, 'no listComments, no createComment');
  const log = readMirrorLog(h.ctx.root, ROUND);
  assert.ok(log.ok);
  const last = log.value.at(-1);
  assert.equal(last?.status, 'rejected_scan');
  assert.equal(last?.kind, 'decision');
  assert.ok(last?.error !== null && last?.error !== undefined && !last.error.includes(FIXTURE_GATEWAY_HOST), 'the error never echoes the host');
  const p = one(h, 'decision');
  assert.deepEqual([p.failures, p.nextAttemptAt], [1, null]);
  h.ports.clock.advance(7 * 3600 * 1000);
  assert.deepEqual(await drainMirrors(h.ctx), { posted: 0, failed: 0, rejected: 0 });
  assert.equal(h.ports.github.calls().length, calls);
  assert.ok(h.ports.github.comments().every((c) => !c.body.includes(FIXTURE_GATEWAY_HOST)));
  rmSync(h.dir, { recursive: true });
});

test('crash after post / fresh clone: a trusted marker comment of the same source is re-recorded, not posted again', async () => {
  const h = harness();
  h.sim.answerAudit(ROUND, () => 'left');
  const p = one(h, 'card');
  // neither an untrusted copy nor a trusted card comment of another source counts as posted
  h.ports.github.inject(ISSUE, p.body, 'NONE');
  h.ports.github.inject(ISSUE, `${mirrorMarker('card', ROUND, ROUND)}\nold card, source \`${'0'.repeat(64)}\`\n`);
  assert.deepEqual(await drainMirrors(h.ctx), { posted: 1, failed: 0, rejected: 0 });
  assert.equal(createCalls(h), 1);
  const posted = h.ports.github.comments(ISSUE).at(-1);
  assert.equal(posted?.body, p.body);
  // the local log is git-ignored: a fresh clone (or a crash before the append) has none
  rmSync(join(h.ctx.paths.dir, 'mirror.jsonl'));
  h.ports.clock.advance(MIN);
  assert.deepEqual(await drainMirrors(h.ctx), { posted: 1, failed: 0, rejected: 0 });
  assert.equal(createCalls(h), 1, 'reused, not posted again');
  assert.equal(mirroredAt(h.ctx.root, ROUND, 'card', ROUND), posted?.createdAt);
  const log = readMirrorLog(h.ctx.root, ROUND);
  assert.ok(log.ok);
  assert.deepEqual(log.value.map((e) => [e.status, e.comment_id, e.url]), [['posted', posted?.id, posted?.url]]);
  rmSync(h.dir, { recursive: true });
});

test('listComments failing → failed entries, no createComment (a crashed post may exist)', async () => {
  const h = harness();
  h.sim.answerAudit(ROUND, () => 'left');
  h.ports.github.failNext('listComments', 1);
  assert.deepEqual(await drainMirrors(h.ctx), { posted: 0, failed: 1, rejected: 0 });
  assert.equal(createCalls(h), 0);
  assert.equal(one(h, 'card').failures, 1);
  rmSync(h.dir, { recursive: true });
});

test('a failing mirror never changes a run exit code or status: the caller ignores the drain report', async () => {
  const h = harness();
  h.sim.answerAudit(ROUND, () => 'left');
  assert.ok((await h.ports.git.createBranch('forge/r01', 'main')).ok);
  assert.ok((await h.ports.git.checkout('forge/r01')).ok);
  const toy: StepDef = { id: '00-start', run: async () => ({ kind: 'done', inputs: [], outputs: [], external: [] }) };
  const run = async (): Promise<number> => {
    const report = await runSteps(h.ctx, { pipeline: 'round', steps: [toy], until: null, from: null, redoFrom: null, pid: 7, isAlive: () => true });
    await drainMirrors(h.ctx);
    return report.exitCode;
  };
  h.ports.github.failNext('listComments', 1);
  assert.equal(await run(), 0);
  assert.equal(one(h, 'card').failures, 1, 'the drain inside the run did fail');
  const status = readFileSync(h.ctx.paths.status, 'utf8');
  // an unreadable mirror log (bad middle line) is logged, never thrown
  writeFileSync(join(h.ctx.paths.dir, 'mirror.jsonl'), '{"bad":1}\n{"bad":2}\n');
  assert.equal(pendingMirrors(h.ctx.root, ROUND, START).ok, false, 'pendingMirrors reports the unreadable log as err');
  assert.deepEqual(await drainMirrors(h.ctx), { posted: 0, failed: 0, rejected: 0 });
  assert.equal(readFileSync(h.ctx.paths.status, 'utf8'), status, 'status.json untouched by the drain');
  assert.equal(await run(), 0);
  rmSync(h.dir, { recursive: true });
});

test('bench_notice is keyed by version from this cycle; diff_approval by the approved diff SHA-256; mirrorIssue; a drain leaves nothing pending', async () => {
  const h = harness();
  const logPath = join(h.ctx.root, 'benchmark', 'log.jsonl');
  const init: unknown = JSON.parse(readFileSync(logPath, 'utf8').trim());
  const notice = {
    ...(typeof init === 'object' && init !== null ? init : {}), at: START, cycle: ROUND, outcome: 'pending_owner', version: 'v2', parent: 'v1', sha256: 'c'.repeat(64),
    path: 'benchmark/v2.json', activation: 'owner', changed_keys: ['cliches'], evidence_ids: ['E-R01-card-A'],
  };
  writeFileSync(logPath, `${readFileSync(logPath, 'utf8')}${JSON.stringify(notice)}\n`);
  const b = one(h, 'bench_notice');
  assert.equal(b.key, 'v2');
  assert.equal(b.body.split('\n')[0], '<!-- forge:bench_notice R01 v2 -->');
  for (const word of ['pending_owner', 'v2', 'v1', 'cliches', 'E-R01-card-A', 'c'.repeat(64)]) assert.ok(b.body.includes(word), `bench body lacks ${word}`);
  assert.ok(!b.body.includes('benchmark/v2.json'), 'no file paths');
  assert.deepEqual(pending(h).map((m) => m.kind), ['bench_notice'], 'the R00-init entry belongs to another cycle');

  const diff = 'diff --git a/world/current/x.md b/world/current/x.md\n';
  writeFileSync(join(h.ctx.paths.dir, 'approval.diff'), diff);
  const diffSha = sha256Bytes(Buffer.from(diff, 'utf8'));
  put(h.ctx, 'final.json', { round: ROUND, approval_diff_sha256: diffSha });
  assert.ok(pending(h).every((m) => m.kind !== 'diff_approval'), 'not before the owner approves');
  h.sim.approveDiff(ROUND);
  const d = one(h, 'diff_approval');
  assert.deepEqual([d.key, d.source_sha256], [diffSha, diffSha]);
  assert.equal(d.body.split('\n')[0], `<!-- forge:diff_approval R01 ${diffSha} -->`);

  assert.deepEqual(mirrorIssue(h.ctx.root, ROUND), { ok: true, value: ISSUE });
  assert.deepEqual(mirrorIssue(h.ctx.root, 'R00'), { ok: true, value: 1 }, 'R00 posts on the epic issue of github.json');
  assert.equal(mirrorIssue(h.ctx.root, 'R02').ok, false);
  assert.deepEqual(await drainMirrors(h.ctx), { posted: 2, failed: 0, rejected: 0 });
  assert.deepEqual(pending(h), []);
  rmSync(h.dir, { recursive: true });
});
