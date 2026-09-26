import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STEP_IDS } from '../../../../engine/runner.ts';
import { submitDiffApproval, submitProtocolApproval } from '../owner.ts';
import { overviewView } from './overview.ts';

const FORGE = join(import.meta.dirname, '..', '..', '..', '..');
const NOW = '2026-09-10T00:00:00.000Z';

function put(root: string, rel: string, value: unknown): void {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}

function status(round: string, state: string, waiting: string | null, done: readonly string[], detail = ''): unknown {
  return { round, state, step: null, waiting_for: waiting, detail, since: NOW, exit_code: null, done };
}

function call(backend: string, at: string, served: string, version: string | null, quota = false): unknown {
  return { label: `${backend}-${at}`, backend, family: 'Anthropic', requested_model: 'opus', served_model: served, version, ok: true, error: null, ms: 1, tokens_in: 1, tokens_out: 1, cost_usd: null, prompt_sha256: 'a'.repeat(64), output_sha256: 'b'.repeat(64), quota, started_at: at, at };
}

function trustFamily(n: number, k: number, state: string): unknown {
  return {
    qualified: true, qualified_by: 'C00', requal_used: { calibration_fail: false, suspension: false }, gate_judge: state !== 'suspended', gate_by: state !== 'suspended' ? 'C00' : null,
    agreement: { epoch: 'C00', n, k, alpha: 1 + k, beta: 1 + n - k, mean: Math.round(((1 + k) / (2 + n)) * 10_000) / 10_000, ci90: [0.3, 0.9], p_below: 0.05, state },
    suspended_at: state === 'suspended' ? 'R01' : null,
  };
}

/** A champion call file of pair W1-vs-CH, session 0, as 06b writes it (engine/pairs.ts parseTasteCallFile). */
function tasteCall(root: string, family: string, order: 'fwd' | 'rev', o: { status?: 'ok' | 'void'; shadow?: boolean; decoy?: boolean }): void {
  const ok = (o.status ?? 'ok') === 'ok';
  const decoy = o.decoy ?? false;
  put(root, `rounds/R01/taste/W1-vs-CH/${family}-s0-${order}.json`, {
    round: 'R01', pair: 'W1-vs-CH', kind: 'champion', family, shadow: o.shadow ?? false, session: 0, rerun: false, order, task: `T-${family}-${order}`,
    text1: 'W1', text2: 'CH', status: ok ? 'ok' : 'void', picks: ok ? { Q1: 'W1' } : {}, quotes: {}, decisive: ok ? 'W1' : null,
    decoy_at: 3, decoy_pick: decoy ? 3 : null, preferred_decoy: decoy, error: ok ? null : 'void',
  });
}

/** R01 done (costs, tally, taste files, calls); R02 waiting for the audit (progress, costs, calls); a calibration set waiting for answers. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-overview-'));
  for (const f of ['PROTOCOL.md', 'families.json', 'judges.json']) copyFileSync(join(FORGE, f), join(root, f));
  put(root, 'rounds/R01/status.json', status('R01', 'done', null, STEP_IDS));
  put(root, 'rounds/R01/cost.json', { total_usd: 1.5, unpriced_calls: 2, by_backend: {} });
  put(root, 'rounds/R01/tally.json', { v: 2, voids: { calls: 40, void_tasks: 3, retried_tasks: 1, session_reruns: 2, dropped_families: 1 } });
  const text = (id: string, kind: string): unknown => ({ id, kind, file: `texts/${id}.md`, sha256: 'd'.repeat(64), authors: ['DeepSeek'] });
  put(root, 'rounds/R01/pairs.json', {
    round: 'R01', champion: 'CH', texts: { W1: text('W1', 'submission'), CH: text('CH', 'champion') },
    pairs: [{ id: 'W1-vs-CH', kind: 'champion', left: 'W1', right: 'CH', families: ['Moonshot', 'OpenAI'], shadow: ['xAI'], effective: ['OpenAI'], dropped: ['Moonshot'] }],
  });
  put(root, 'rounds/R01/taste/aux/pairs.json', { pairs: [] });
  put(root, 'rounds/R01/taste/aux/W1-W2/xAI-s0-fwd.json', { status: 'ok', shadow: false, preferred_decoy: false });
  tasteCall(root, 'OpenAI', 'fwd', { decoy: true });
  tasteCall(root, 'OpenAI', 'rev', {});
  // left out of the decoy rate: a void call (preferred_decoy false by construction) and a shadow family's calls
  tasteCall(root, 'Moonshot', 'fwd', { status: 'void' });
  tasteCall(root, 'Moonshot', 'rev', {});
  tasteCall(root, 'xAI', 'fwd', { shadow: true, decoy: true });
  tasteCall(root, 'xAI', 'rev', { shadow: true });
  put(root, 'rounds/R01/calls/old.json', call('codex', '2026-09-01T00:00:00.000Z', 'gpt-old', '0.1'));
  put(root, 'rounds/R02/status.json', status('R02', 'waiting', 'audit', ['00-start', '01-topic', '02a-brief'], '等待盲审'));
  put(root, 'rounds/R02/cost.json', { total_usd: 0.25, unpriced_calls: 0, by_backend: {} });
  put(root, 'rounds/R02/progress.jsonl', Array.from({ length: 10 }, (_, i) => `${JSON.stringify({ at: `2026-09-0${Math.min(i, 9)}T00:00:00.000Z`, step: `s${i}`, status: 'info', detail: `e${i}` })}\n`).join(''));
  put(root, 'rounds/R02/calls/a.json', call('claude', '2026-09-05T00:00:00.000Z', 'claude-opus-5-5', '2.1.0'));
  put(root, 'rounds/R02/calls/b.json', call('claude', '2026-09-06T00:00:00.000Z', 'claude-opus-5-5[1M]', '2.1.1'));
  put(root, 'rounds/R02/calls/c.json', call('claude', '2026-09-07T00:00:00.000Z', 'quota-try', '9', true));
  put(root, 'rounds/R02/calls/d.json', call('grok', '2026-09-04T00:00:00.000Z', 'grok-4.7-build', null));
  put(root, 'calibration/C00/status.json', status('C00', 'waiting', 'calib_answers', ['c1-build', 'c2-gate-dryrun'], '28 个槽位待回答'));
  put(root, 'calibration/status.json', { schema: 'trust-status/1', updated_after: 'R01', labels_sha256: 'c'.repeat(64), families: { xAI: trustFamily(12, 11, 'ok'), Anthropic: trustFamily(30, 10, 'suspended') } });
  return root;
}

test('overview: active round, step progress and the last 8 progress events', () => {
  const root = fixture();
  const v = overviewView(root, NOW);
  assert.equal(v.active?.round, 'R02');
  assert.equal(v.active?.status?.waiting_for, 'audit');
  assert.equal(v.active?.doneSteps, 3);
  assert.equal(v.active?.totalSteps, STEP_IDS.length);
  assert.deepEqual(v.active?.recent.map((e) => e.detail), ['e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9']);
  assert.equal(v.doctor, null);
  rmSync(root, { recursive: true });
});

test('overview: cost to date sums every round that has a cost.json', () => {
  const root = fixture();
  assert.deepEqual(overviewView(root, NOW).cost, { totalUsd: 1.75, unpricedCalls: 2, rounds: 2 });
  rmSync(root, { recursive: true });
});

test('overview: judge health from calibration/status.json; voids and decoy preferences (ok non-shadow taste calls only) of the latest tally', () => {
  const root = fixture();
  const v = overviewView(root, NOW);
  assert.equal(v.trustError, null);
  assert.deepEqual(v.judges.map((j) => [j.family, j.state, j.n, j.gateJudge]), [['Anthropic', 'suspended', 30, false], ['xAI', 'ok', 12, true]]);
  assert.deepEqual(v.voids, {
    round: 'R01', calls: 40, voidTasks: 3, sessionReruns: 2, droppedFamilies: 1, tasteCalls: 4, decoyPreferred: 1,
    // engine void_decoy (bench-evidence sessionItems): per family over champion session pairs, shadow included
    families: [
      { family: 'Moonshot', sessionPairs: 1, void: 1, decoyFail: 0 },
      { family: 'OpenAI', sessionPairs: 1, void: 1, decoyFail: 1 },
      { family: 'xAI', sessionPairs: 1, void: 1, decoyFail: 1 },
    ],
    familiesError: null,
  });
  put(root, 'rounds/R01/taste/W1-vs-CH/OpenAI-s0-rev.json', '{}');
  const partial = overviewView(root, NOW).voids;
  assert.deepEqual([partial?.tasteCalls, partial?.decoyPreferred, partial?.families], [3, 1, []]);
  assert.match(partial?.familiesError ?? '', /OpenAI-s0-rev\.json/u);
  assert.ok(!(partial?.familiesError ?? '').includes(root));
  put(root, 'calibration/status.json', '{"schema": "trust-status/1"}');
  const broken = overviewView(root, NOW);
  assert.ok(broken.trustError !== null && broken.judges.length === 0);
  rmSync(root, { recursive: true });
});

test('overview: served model and CLI version per backend from the latest round with call records (quota tries skipped)', () => {
  const root = fixture();
  assert.deepEqual(overviewView(root, NOW).backends, [
    { backend: 'claude', family: 'Anthropic', requested: 'opus', served: 'claude-opus-5-5[1M]', version: '2.1.1', at: '2026-09-06T00:00:00.000Z' },
    { backend: 'grok', family: 'Anthropic', requested: 'opus', served: 'grok-4.7-build', version: null, at: '2026-09-04T00:00:00.000Z' },
  ]);
  rmSync(root, { recursive: true });
});

test('overview: owner todos from waiting statuses, calibration sets and a missing protocol approval', () => {
  const root = fixture();
  const v = overviewView(root, NOW);
  assert.deepEqual(v.todos.map((t) => [t.kind, t.round, t.href]), [
    ['protocol_approval', null, '/benchmark'],
    ['audit', 'R02', '/rounds/R02/audit'],
    ['calib_answers', 'C00', '/calibration/C00'],
  ]);
  assert.equal(v.todos.find((t) => t.kind === 'audit')?.detail, '等待盲审');
  rmSync(root, { recursive: true });
});

test('overview: an approved protocol bundle drops its todo; no benchmark log → no effective version and nothing pending', () => {
  const root = fixture();
  const first = overviewView(root, NOW).todos.find((t) => t.kind === 'protocol_approval');
  const sha = /[0-9a-f]{64}/u.exec(first?.detail ?? '')?.[0] ?? '';
  assert.equal(submitProtocolApproval(root, sha, NOW).ok, true);
  const v = overviewView(root, NOW);
  assert.equal(v.todos.some((t) => t.kind === 'protocol_approval'), false);
  assert.equal(v.benchmark.effective, null);
  assert.equal(v.benchmark.head, null);
  assert.deepEqual(v.benchmark.pending, []);
  rmSync(root, { recursive: true });
});

test('overview: pending mirrors per round link counts and errors', () => {
  const root = fixture();
  const diff = 'diff\n';
  const diffSha = createHash('sha256').update(diff).digest('hex');
  put(root, 'rounds/R01/approval.diff', diff);
  put(root, 'rounds/R01/final.json', { approval_diff_sha256: diffSha });
  assert.equal(submitDiffApproval(root, 'R01', diffSha, NOW).ok, true);
  put(root, 'rounds/R02/mirror.jsonl', 'garbage\n');
  const v = overviewView(root, NOW);
  assert.deepEqual(v.mirrors.map((m) => [m.round, m.count, m.error !== null]), [['R01', 1, false], ['R02', 0, true]]);
  rmSync(root, { recursive: true });
});

test('overview: an empty forge root renders without errors', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-overview-empty-'));
  const v = overviewView(root, NOW);
  assert.equal(v.active, null);
  assert.deepEqual(v.cost, { totalUsd: 0, unpricedCalls: 0, rounds: 0 });
  assert.deepEqual([v.judges, v.backends, v.todos, v.mirrors], [[], [], [], []]);
  assert.equal(v.voids, null);
  rmSync(root, { recursive: true });
});

test('overview: an unreadable owner log is a repair to-do whose detail names the file forge-relative, never the root', { skip: process.getuid?.() === 0 ? 'root ignores file modes' : false }, () => {
  const root = fixture();
  put(root, 'owner-log.jsonl', '');
  chmodSync(join(root, 'owner-log.jsonl'), 0o000);
  const denied = overviewView(root, NOW).todos.find((t) => t.kind === 'owner_log_repair');
  chmodSync(join(root, 'owner-log.jsonl'), 0o600);
  assert.ok(denied !== undefined);
  assert.ok(denied.detail.includes('<forge>') && !denied.detail.includes(root), denied.detail);
  rmSync(join(root, 'owner-log.jsonl'));
  mkdirSync(join(root, 'owner-log.jsonl'));
  const dir = overviewView(root, NOW).todos.find((t) => t.kind === 'owner_log_repair');
  assert.ok(dir !== undefined && !dir.detail.includes(root), dir?.detail ?? 'no owner_log_repair to-do');
  // the engine copies the reader's message into the waiting round's status detail (a readable log: no global to-do)
  rmSync(join(root, 'owner-log.jsonl'), { recursive: true });
  put(root, 'rounds/R02/status.json', status('R02', 'waiting', 'owner_log_repair', [], `owner-log.jsonl: EACCES: permission denied, open '${root}/owner-log.jsonl'`));
  const waiting = overviewView(root, NOW);
  const wait = waiting.todos.find((t) => t.kind === 'owner_log_repair' && t.round === 'R02');
  assert.equal(wait?.detail, "owner-log.jsonl: EACCES: permission denied, open '<forge>/owner-log.jsonl'");
  assert.equal(waiting.active?.status?.detail, wait?.detail);
  rmSync(root, { recursive: true });
});
