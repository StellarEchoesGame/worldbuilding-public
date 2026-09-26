import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { activeBenchmark } from './bench-active.ts';
import { rollbackHolds } from './bench-check.ts';
import { readBenchLog, type BenchLogEntry } from './bench-log.ts';
import { parseReplayResult } from './bench-replay.ts';
import { readCalibSet } from './calib-build.ts';
import { parseCalibReport } from './calib-score.ts';
import { roundContext } from './cli-round.ts';
import { OwnerFileError, type StepContext } from './context.ts';
import { isRecord, readArray, readBoolean, readRecord, readString } from './json.ts';
import { readMarker, sha256Bytes } from './marker.ts';
import { mirrorMarker } from './mirror.ts';
import { ownerInputs } from './owner-inputs.ts';
import { pairVerdicts } from './pairs.ts';
import { PROBE_ATTEMPTS, PROBE_DELAYS_MS, probeMarker } from './probe.ts';
import { readStatus, verifyChain, STEP_IDS, type RoundStatus } from './runner.ts';
import { sha256 } from './store.ts';
import { displayText } from './submission.ts';
import { parseTrustStatus } from './trust-status.ts';
import { parseLabelLedger, readLabelLedger, reserveLabels, visibleLabels, type Label, type LabelText } from './trust.ts';
import { splitSentences } from './text.ts';
import { parseWriterOutput } from './writer-output.ts';
import { E2E_DECOY_LOVER, REPLAY_Q, e2eWorld, forgeHarness, ownerChoice, callsOf, writerPrompts, type E2EWorld } from './testing/e2e-script.ts';
import { FIXTURE_GATEWAY_HOST } from './testing/fixture-world.ts';
import {
  assertNoForecastLeak, assertNoHost, assertNoTestingImports, assertOwnerFiles, killSwitch, markerBytes, paidLogger, reserveLeaks, settle, SimulatedKill, trackedFiles,
  type ReserveText,
} from './testing/guards.ts';
import { SEALED_VALUE, filesUnder, head, readObject } from './testing/round-script.ts';

/*
 * Issue #6 acceptance (plan "End-to-end fixture round", s6): one fixture world driven only through the CLI command
 * functions (forge(argv) → exit code) from round 0 (v1, calibration C00, the R00 cycle) through R01 (blocked probe,
 * kill and resume, void session pair, owner waits, failed re-gate, merge, rejected_by_replay, diff approval), R02 (pick
 * none, the pending version approved) and R03 up to its freeze (the owner's rollback). Every forge() call is followed
 * by the guards (owner files, gateway host, sealed forecast values). Scenario variants are listed in the PR-E contract
 * index ("PR-E as built").
 */

const ENGINE_DIR = import.meta.dirname;

function guards(x: E2EWorld): void {
  const root = x.w.root;
  assertOwnerFiles(root, x.sim.expected());
  assertNoHost(x.w.repo, root, x.ports.git, FIXTURE_GATEWAY_HOST);
  assertNoForecastLeak(x.w.repo, root, writerPrompts(x), SEALED_VALUE, existsSync(join(root, 'rounds', 'R01', 'unsealed', 'sealed.json')));
}

function status(x: E2EWorld, round: string): RoundStatus {
  const s = readStatus(x.w.root, round);
  if (!s.ok) throw new Error(s.error);
  return s.value;
}

function json(path: string): Record<string, unknown> {
  return readObject(path);
}

function logLines(x: E2EWorld): BenchLogEntry[] {
  const log = readBenchLog(x.w.root);
  if (!log.ok) throw new Error(log.error);
  return log.value;
}

function markerOf(x: E2EWorld, rel: string): Record<string, unknown> | null {
  const m = readMarker(join(x.w.root, rel));
  return m === null || !m.ok ? null : { result: m.value.result, skipped: m.value.skipped, inputs: m.value.inputs };
}

/** First comment line of every GitHub comment on `issue` (null = every issue), in creation order. */
function commentMarkers(x: E2EWorld, issue: number | null = null): string[] {
  return x.ports.github.comments().filter((c) => issue === null || c.issue === issue).map((c) => c.body.split('\n', 1)[0] ?? '');
}

function ledger(x: E2EWorld): Label[] {
  const parsed = parseLabelLedger(JSON.parse(readFileSync(join(x.w.root, 'calibration', 'labels.json'), 'utf8')));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value.labels;
}

/** reserveLeaks inputs from the ledger (trust.ts reader): every C00 reserve label text, and every visible label text. */
interface ReserveMaterial {
  reserve: ReserveText[];
  shown: string[];
}

/** A label text as the evidence packet reads it (`.md` file, champion.json `text`, a submission's display text), sha-checked. */
function labelTextOf(root: string, tx: LabelText): string {
  const raw = readFileSync(join(root, tx.path), 'utf8');
  let text: string | null = raw;
  if (!tx.path.endsWith('.md')) {
    const value: unknown = JSON.parse(raw);
    if (tx.path.endsWith('/champion.json')) text = readString(value, 'text');
    else {
      const out = readBoolean(value, 'ok') === true ? parseWriterOutput(readString(value, 'text') ?? '') : null;
      text = out !== null && out.ok ? displayText(out.value) : null;
    }
  }
  assert.ok(text !== null && sha256(text) === tx.sha256, `${tx.path} does not hash to the ledger's ${tx.id}`);
  return text;
}

function reserveMaterial(x: E2EWorld): ReserveMaterial {
  const read = readLabelLedger(x.w.root);
  if (read === null || !read.ok) throw new Error(read === null ? 'calibration/labels.json is missing' : read.error);
  const textOf = (tx: LabelText): string => labelTextOf(x.w.root, tx);
  const c00 = read.value.labels.filter((l) => l.round === 'C00' && l.split === 'reserve');
  assert.equal(c00.length, 12, 'the 12 C00 reserve labels');
  const reserve = c00.flatMap((l) => l.texts.map((tx) => {
    assert.equal(tx.path, `calibration/texts/${tx.id}.md`);
    return { id: tx.id, label: l.id, text: textOf(tx) };
  }));
  return { reserve, shown: read.value.labels.filter((l) => l.split === 'visible').flatMap((l) => l.texts.map(textOf)) };
}

/** Prompts of every attempt of the maintainer task `taskId` (at least one). */
function maintainerPrompts(x: E2EWorld, taskId: string): string[] {
  const prompts = x.routers.find((rt) => rt.id === 'maintainer')?.log().filter((c) => c.taskId === taskId).map((c) => c.prompt) ?? [];
  assert.ok(prompts.length > 0, `no maintainer prompt for ${taskId}`);
  return prompts;
}

/** No C00 reserve label id, text id, 12-character head or sentence in any prompt of the maintainer task `taskId`. */
function assertNoReserve(x: E2EWorld, taskId: string, m: ReserveMaterial): void {
  for (const prompt of maintainerPrompts(x, taskId)) assert.deepEqual(reserveLeaks(prompt, m.reserve, m.shown), [], `reserve material in the ${taskId} prompt`);
}

/** Resolution (`effective` / `head`) through a round-0 context at the fake clock's now. */
function resolved(x: E2EWorld, mode: 'effective' | 'head'): string {
  const ctx = context(x, 'R00');
  const r = activeBenchmark(ctx, mode);
  return r.ok ? `${r.value.version}/${r.value.via}` : `err:${r.error}`;
}

function context(x: E2EWorld, round: string): StepContext {
  const ctx = roundContext(x.at, { ports: x.ports, backends: () => x.backends, env: {}, pid: 999, isAlive: () => false, log: () => undefined }, round, round === 'R00' ? 'bench-r00' : 'round', { cell: null, seed: null }, null);
  if (!ctx.ok) throw new Error(ctx.error);
  return ctx.value;
}

/** Commits every non-ignored file on the current branch (what the round's PR carries), merges the branch, checks out main. */
async function mergeBranch(x: E2EWorld, branch: string): Promise<void> {
  const committed = await x.ports.git.commit([x.w.repo], `test: the ${branch} PR`);
  assert.ok(committed.ok, committed.ok ? '' : committed.error);
  x.ports.git.mergeToMain(branch);
  assert.ok((await x.ports.git.checkout('main')).ok);
}

/** `rounds/<r>/<file>` keys of a marker's inputs. */
function hasInput(m: Record<string, unknown> | null, rel: string): boolean {
  return m !== null && isRecord(m['inputs']) && Object.hasOwn(m['inputs'], rel);
}

/** `taskId#attempt` of every judge call whose task id starts with `<kind>-`. */
function judgeCalls(x: E2EWorld, kind: string): string[] {
  const ids = new Set(x.backends.judges.map((j) => j.backend.id));
  return x.routers.filter((r) => ids.has(r.id)).flatMap((r) => r.log().filter((c) => c.taskId.startsWith(`${kind}-`)).map((c) => `${c.taskId}#${c.attempt}`));
}

function gatewayCalls(x: E2EWorld): string[] {
  return x.routers.filter((r) => r.id.startsWith('gateway-') && r.id !== 'gateway-deepseek-fixture').flatMap((r) => r.log().map((c) => `${c.taskId}#${c.attempt}`));
}

test('F1-03 fixture round', { concurrency: 1 }, async (t) => {
  const started = Date.now();
  const x = e2eWorld();
  const h = forgeHarness(x, guards);
  const { forge } = h;
  const root = x.w.root;
  const r01 = join(root, 'rounds', 'R01');
  const lastLogs = (n = 30): string => x.logs.slice(-n).join('\n');

  await t.test('E0 round 0: v1 behind the protocol gate, calibration C00, the R00 cycle → v2 pending_owner', async () => {
    assert.equal(await forge(['bench', 'propose', 'R00', '--initial']), 2, lastLogs());
    assert.deepEqual(await x.ports.git.currentBranch(), { ok: true, value: 'forge/r00' });
    const initialStatus = json(join(root, 'benchmark', 'initial', 'status.json'));
    assert.deepEqual([initialStatus['step'], initialStatus['waiting_for']], ['i1-propose', 'protocol_approval']);
    assert.equal(existsSync(join(root, 'benchmark', 'v1.json')), false);
    assert.deepEqual(callsOf(x, 'maintainer'), []);
    x.sim.approveProtocol();
    assert.equal(await forge(['bench', 'propose', 'R00', '--initial']), 0, lastLogs());
    assert.deepEqual(logLines(x).map((e) => [e.cycle, e.version, e.outcome]), [['R00-init', 'v1', 'pending_owner']]);
    assert.ok(existsSync(join(root, 'benchmark', 'v1.json')));
    assert.deepEqual(callsOf(x, 'maintainer'), ['bench-initial#1']);
    x.sim.viewBenchDiff('v1');
    x.sim.approveBench('v1');

    assert.equal(await forge(['calib', 'build']), 0, lastLogs());
    const set = readCalibSet(root, 'C00');
    assert.ok(set.ok, set.ok ? '' : set.error);
    const built = Object.values(set.value.texts).filter((tx) => tx.call !== null && tx.role !== 'defect');
    for (const tx of built) {
      const rec = json(join(root, 'calibration', 'C00', 'tasks', `${tx.call ?? ''}.json`));
      assert.equal(rec['status'], 'ok', tx.call ?? '');
    }
    assert.equal(gatewayCalls(x).length, built.length, 'one gateway call per built text (no voids)');

    assert.equal(await forge(['calib', 'run']), 2, lastLogs());
    assert.equal(json(join(root, 'calibration', 'C00', 'status.json'))['waiting_for'], 'calib_answers');
    assert.equal(judgeCalls(x, 'gate').length, 16, '4 dry-run copies × 4 families');
    assert.deepEqual(judgeCalls(x, 'calib'), [], 'no taste call before the owner answered');
    x.sim.answerCalibration('C00', ownerChoice);
    assert.equal(await forge(['calib', 'run']), 0, lastLogs());
    assert.equal(judgeCalls(x, 'calib').length, 180, '3 × 48 + OpenAI 36');
    assert.equal(json(join(root, 'calibration', 'C00', 'pin.json'))['benchmark_version'], 'v1');
    assert.equal(await forge(['calib', 'score']), 0, lastLogs());
    const statusFile = parseTrustStatus(JSON.parse(readFileSync(join(root, 'calibration', 'status.json'), 'utf8')));
    assert.ok(statusFile.ok);
    assert.deepEqual(Object.entries(statusFile.value.families).filter(([, f]) => f.qualified).map(([k]) => k).sort(), ['Anthropic', 'Moonshot', 'OpenAI', 'xAI']);
    const report = parseCalibReport(JSON.parse(readFileSync(join(root, 'calibration', 'round0.json'), 'utf8')));
    assert.ok(report.ok && report.value.valid && report.value.canon_rounds_may_start, report.ok ? String(report.value.invalid_reason) : report.error);
    const labels = ledger(x);
    assert.deepEqual([labels.length, labels.filter((l) => l.split === 'visible').length, labels.filter((l) => l.split === 'reserve').length], [24, 12, 12]);
    const category = new Map(set.value.pairs.map((p) => [p.id, p.category]));
    for (const c of new Set(category.values())) {
      const of = labels.filter((l) => category.get(l.id) === c);
      assert.deepEqual([of.filter((l) => l.split === 'visible').length, of.filter((l) => l.split === 'reserve').length], [3, 3], c);
    }

    for (const sub of ['evidence', 'propose', 'validate', 'replay', 'activate']) assert.equal(await forge(['bench', sub, 'R00']), 0, `${sub}: ${lastLogs()}`);
    assert.deepEqual(logLines(x).map((e) => [e.cycle, e.version, e.outcome, e.parent]), [['R00-init', 'v1', 'pending_owner', null], ['R00', 'v2', 'pending_owner', 'v1']]);
    assert.equal(json(join(root, 'benchmark', 'v2.json'))['parent'], 'v1');
    assert.deepEqual(markerOf(x, 'rounds/R00/markers/11i-bench-replay.json')?.['skipped'], 'no replay-class key');
    // PR-A resolution: an unapproved pending_owner version is never head (so no proposal builds on it unapproved)
    assert.deepEqual([resolved(x, 'effective'), resolved(x, 'head')], ['v1/approved', 'v1/approved']);
    await mergeBranch(x, 'forge/r00');
  });

  const E1_START = 'cells/E2E-R01.json';
  let run2Pid = 0;
  await t.test('E1 blocked probe mirror (R01 run 1): exit 4, no writer call, the pending v2 holds its version, round-0 notices drained', async () => {
    x.ports.github.failNext('createComment', PROBE_ATTEMPTS);
    assert.equal(await forge(['round', 'start', 'R01', '--cell', E1_START]), 0, lastLogs());
    assert.ok(x.logs.some((l) => l.startsWith('基准 v2 待 owner 批准')), 'round start reports the pending version');
    const sleptBefore = x.ports.clock.slept().length;
    assert.equal(await forge(['round', 'run', 'R01']), 4, lastLogs());
    const st = status(x, 'R01');
    assert.deepEqual([st.state, st.step, st.detail, st.exit_code], ['blocked', '03c-probe-mirror', 'probe_mirror:comment', 4]);
    assert.deepEqual(st.done, STEP_IDS.slice(0, STEP_IDS.indexOf('03b-seal') + 1));
    assert.equal(existsSync(join(r01, 'probe.json')), false);
    const freeze = json(join(r01, 'freeze.json'));
    assert.equal(freeze['probe_created_at'], null);
    const resolution = readRecord(freeze, 'benchmark_resolution');
    assert.deepEqual([freeze['benchmark_version'], readString(resolution, 'via'), readString(resolution, 'sha256')], ['v1', 'approved', sha256Bytes(readFileSync(join(root, 'benchmark', 'v1.json')))]);
    assert.deepEqual(writerPrompts(x), [], 'zero writer calls');
    assert.equal(existsSync(join(r01, 'submissions')), false);
    const probeTries = x.ports.github.calls().filter((c) => c.op === 'createComment' && (c.args[1] ?? '').startsWith(probeMarker('R01')));
    assert.deepEqual(probeTries.map((c) => c.ok), [false, false, false, false]);
    assert.deepEqual(x.ports.clock.slept().slice(sleptBefore), [...PROBE_DELAYS_MS]);
    assert.deepEqual(commentMarkers(x, 1), [mirrorMarker('bench_notice', 'R00', 'v1'), mirrorMarker('bench_notice', 'R00', 'v2')], 'the end-of-run drain posted both round-0 notices on the epic');
    const commits = x.ports.git.commits('forge/r01');
    assert.equal(commits.length, 1);
    assert.deepEqual([...(commits[0]?.paths ?? [])].sort(), ['brief.json', 'freeze.json', 'probes.sha256', 'start.json', 'topic.json'].map((f) => `world/forge/rounds/R01/${f}`));
    assert.deepEqual(x.ports.git.pushes(), ['forge/r01']);
    assert.equal(judgeCalls(x, 'forecast').length + callsOf(x, 'gateway-deepseek-fixture').length, 5);
    assert.equal(filesUnder(root, join(root, '.sealed', 'R01', 'tasks')).length, 5, 'five sealed forecaster records');
  });

  let before = new Map<string, string>();
  let run2: readonly string[] = [];
  let run3: readonly string[] = [];
  let killed: string | null = null;
  let inflight: string[] = [];
  await t.test('E2 resume after a killed step (runs 2, 3): no repeated paid call, markers ≤ 06a byte-identical, lock taken over', async () => {
    const ks = killSwitch({ phase: 'before', match: /^taste-/u, nth: 5 });
    await assert.rejects(forge(['round', 'run', 'R01'], ks.hooks), (e: unknown) => e instanceof SimulatedKill);
    await settle(x.routers);
    run2Pid = h.pids().at(-1) ?? 0;
    const probes = x.ports.github.comments().filter((c) => c.body.startsWith(probeMarker('R01')));
    assert.equal(probes.length, 1, 'the healed probe is posted exactly once');
    const probe = json(join(r01, 'probe.json'));
    assert.deepEqual([probe['created_at'], json(join(r01, 'freeze.json'))['probe_created_at']], [probes[0]?.createdAt, probes[0]?.createdAt]);
    assert.equal(x.ports.git.commits('forge/r01').length, 1);
    const marked = [...markerBytes(root, 'R01').keys()].sort();
    assert.deepEqual(marked, STEP_IDS.slice(0, STEP_IDS.indexOf('06a-decoy') + 1));
    assert.equal(json(join(root, '.forge.lock'))['pid'], run2Pid, 'a crash releases nothing');
    before = markerBytes(root, 'R01');
    killed = ks.killedAt();
    run2 = ks.paidLog();
    inflight = run2.map((c) => c.split('#')[0] ?? '').filter((id) => !existsSync(join(r01, 'tasks', `${id}.json`)));
    const lg = paidLogger();
    assert.equal(await forge(['round', 'run', 'R01'], lg.hooks), 2, lastLogs());
    run3 = lg.paidLog();
    assert.ok(x.logs.includes(`lock taken over from pid ${run2Pid}`), lastLogs());
    const both = [...run2, ...run3];
    assert.equal(new Set(both).size, both.length, 'no taskId#attempt repeats across runs 2 and 3');
    assert.ok(killed !== null && killed.startsWith('taste-'));
    assert.ok(run3.includes(`${killed}#1`) && !run2.includes(`${killed}#1`), 'the killed call runs only in run 3');
    assert.ok(inflight.length > 0, 'some calls were in flight at the kill');
    for (const id of inflight) {
      assert.ok(!run3.some((c) => c.startsWith(`${id}#`)), `${id} is recovered, not called again`);
      assert.ok(existsSync(join(r01, 'tasks', `${id}.json`)), `${id} got its task record from the recovered call`);
    }
    const upTo = STEP_IDS.indexOf('06a-decoy');
    for (const [step, bytes] of before) if (STEP_IDS.findIndex((s) => s === step) <= upTo) assert.equal(markerBytes(root, 'R01').get(step), bytes, step);
    assert.deepEqual(verifyChain(root, 'rounds/R01', STEP_IDS.slice(0, STEP_IDS.indexOf('09a-audit') + 1)), []);
    assert.equal(existsSync(join(r01, 'markers', 'stale')), false);
    // run 1 made only the 5 sealed forecaster calls; sealed tasks (forecasts, surprise matchers) keep their records under .sealed/
    const records = filesUnder(root, join(r01, 'calls')).length + filesUnder(root, join(root, '.sealed', 'R01', 'calls')).length;
    assert.equal(records, both.length + 5, 'one call record per paid call of runs 2 + 3 (plus run 1\'s forecasts)');
  });

  await t.test('E3 a void session pair drops xAI from W1: |E| = 3, 6/6 beats the champion; the host-carrying W3 transport error is redacted', async () => {
    const tasks = readdirSync(join(r01, 'tasks'));
    const of = (prefix: string): string[] => tasks.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length, -'.json'.length)).sort();
    assert.deepEqual(of(`taste-W1-${E2E_DECOY_LOVER}-`), ['s0-fwd', 's0-rev', 's1-fwd', 's1-rev', 's1r-fwd', 's1r-rev'], 'no s0r');
    for (const f of ['Anthropic', 'Moonshot', 'OpenAI']) assert.deepEqual(of(`taste-W1-${f}-`), ['s0-fwd', 's0-rev', 's1-fwd', 's1-rev'], f);
    for (const f of ['Anthropic', 'Moonshot', 'OpenAI', 'xAI']) assert.deepEqual(of(`taste-W2-r2-${f}-`), ['s0-fwd', 's0-rev', 's1-fwd', 's1-rev'], `W2-r2 ${f}`);
    const sessions = pairVerdicts(root, 'R01', 'W1');
    assert.equal(sessions.find((f) => f.family === E2E_DECOY_LOVER)?.dropped, 'void_after_rerun');
    for (const f of sessions.filter((s) => s.family !== E2E_DECOY_LOVER)) assert.deepEqual([f.dropped, f.sessions.length], [null, 2], f.family);
    const tally = json(join(r01, 'tally.json'));
    const pairs = readArray(tally, 'champion_pairs') ?? [];
    const w1 = pairs.find((p) => readString(p, 'submission') === 'W1');
    assert.ok(isRecord(w1));
    assert.deepEqual([w1['e'], w1['dropped'], w1['needed'], w1['total_wins'], w1['bar'], w1['beats_champion']], [['Anthropic', 'Moonshot', 'OpenAI'], ['xAI'], 6, 6, '6/6', true]);
    assert.equal(json(join(r01, 'champion.json'))['kind'], 'owner_pick', 'judged against the SHIP owner_pick champion');
    const aux = readArray(tally, 'aux_pairs') ?? [];
    assert.ok(aux.length > 0 && aux.every((a) => (readArray(a, 'families') ?? []).length === 2 && isRecord(a) && a['void_calls'] === 0));
    const auxTasks = tasks.filter((f) => f.startsWith('taste-') && f.slice(0, -'.json'.length).includes('.'));
    assert.ok(auxTasks.length === aux.length * 4 && auxTasks.every((f) => /-s0-(fwd|rev)\.json$/u.test(f)), 'aux pairs: 2 families × 2 orders, session 0 only, no rerun');
    // round-script's gate: W2 carries the trap (05d blind resubmission W2-r2, its gate calls carry -re); one defect copy per round
    assert.ok(tasks.filter((f) => /^gate(copy)?-.*-re\.json$/u.test(f)).every((f) => f.startsWith('gate-W2-r2-')), 'only the resubmission is re-gated');
    assert.equal(tasks.filter((f) => f.startsWith('defect-')).length, 1, 'one defect copy per round');
    const w3 = json(join(r01, 'calls', 'write-W3-a1.json'));
    assert.match(readString(w3, 'error') ?? '', /\[redacted:gateway-host\]/u);
    assert.equal(json(join(r01, 'tasks', 'write-W3.json'))['status'], 'ok', 'W3: transport failure on attempt 1, the retry answers');
  });

  const labelOf = (id: string): string => Object.entries(json(join(r01, 'labels.json'))).find(([, v]) => v === id)?.[0] ?? '';
  await t.test('E4 owner waits: audit (blind: no card comment) then decision; the card is mirrored once the audit exists', async () => {
    const st = status(x, 'R01');
    assert.deepEqual([st.state, st.step, st.waiting_for, st.exit_code], ['waiting', '09a-audit', 'audit', 2]);
    const auditSet = readArray(json(join(r01, 'audit-set.json')), 'pairs') ?? [];
    assert.deepEqual(auditSet.map((p) => readString(p, 'id')), ['R01-audit-1', 'R01-audit-2', 'R01-audit-3', 'R01-audit-4']);
    assert.deepEqual(auditSet.map((p) => readString(p, 'split')).filter((v) => v === 'visible').length, 2);
    assert.equal(existsSync(join(r01, 'audit.json')), false);
    assert.equal(commentMarkers(x).filter((m) => m.startsWith('<!-- forge:card')).length, 0, 'no card before the audit (blindness)');
    x.sim.answerAudit('R01', ownerChoice);
    assert.equal(await forge(['round', 'run', 'R01']), 2, lastLogs());
    assert.deepEqual([status(x, 'R01').step, status(x, 'R01').waiting_for], ['09b-decision', 'decision']);
    const m09a = markerOf(x, 'rounds/R01/markers/09a-audit.json');
    assert.equal(isRecord(m09a?.['inputs']) ? m09a['inputs']['rounds/R01/audit.json'] : null, x.sim.expected().get('rounds/R01/audit.json'));
    assert.deepEqual(commentMarkers(x).filter((m) => m.startsWith('<!-- forge:card')), [mirrorMarker('card', 'R01', 'R01')]);
    x.script.mergeContradiction = (kind) => kind === 'regate';
    x.sim.decide('R01', { pick: labelOf('W1'), reason: '平', fav: labelOf('W1'), publish: 'no', facts: [`${labelOf('W1')}:A-01`, `${labelOf('W2-r2')}:A-01`] });
  });

  const mainCanon = (): Record<string, string> => Object.fromEntries(Object.entries(x.ports.git.tree('main')).filter(([p]) => p.startsWith('world/current/')));
  // Every file on disk under world/current (an extra file must fail the comparison, not only a changed or deleted one).
  const diskCanon = (): Record<string, string> => {
    const dir = join(x.w.repo, 'world', 'current');
    const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(x.w.repo, join(e.parentPath, e.name)));
    return Object.fromEntries(files.sort().map((p) => [p, readFileSync(join(x.w.repo, p), 'utf8')]));
  };
  const issueNo = (): number => x.ports.github.issues()[0]?.number ?? -1;
  let d8a = '';
  let d8b = '';
  let decision2 = '';
  await t.test('E5 a failed re-gate returns to 09b (run 5); the re-decision merges reference 8.2 (run 6)', async () => {
    d8a = sha256Bytes(readFileSync(join(r01, 'decision.json'))).slice(0, 8);
    const early = markerBytes(root, 'R01');
    const regateBefore = judgeCalls(x, 'regate').length;
    assert.equal(await forge(['round', 'run', 'R01']), 2, lastLogs());
    const st = status(x, 'R01');
    assert.deepEqual([st.step, st.waiting_for, st.detail, st.exit_code], ['09b-decision', 'decision', `regate_failed:${d8a}`, 2]);
    const regate = json(join(r01, 'merge', d8a, 'regate.json'));
    assert.equal(regate['status'], 'fail');
    assert.deepEqual((readArray(regate, 'judges') ?? []).map((j) => (isRecord(j) ? j['yes'] : null)), [true, true]);
    const regateCalls = judgeCalls(x, 'regate').slice(regateBefore);
    assert.equal(regateCalls.length, 2);
    assert.ok(regateCalls.every((c) => c.startsWith(`regate-${d8a}-`)));
    assert.deepEqual(readdirSync(join(r01, 'markers', 'stale', '1')).sort(), ['09b-decision.json', '10a-regate.json']);
    assert.equal(markerOf(x, 'rounds/R01/markers/stale/1/10a-regate.json')?.['result'], 'rewind');
    assert.equal(existsSync(join(r01, 'markers', '09b-decision.json')), false);
    for (const [step, bytes] of early) if (step !== '09b-decision') assert.equal(markerBytes(root, 'R01').get(step), bytes, step);
    assert.deepEqual(diskCanon(), mainCanon(), 'world/current equals main after the rewind');
    assert.equal(x.ports.git.commits('forge/r01').length, 1);
    assert.equal(ownerInputs(root).decision('R01').state, 'superseded');
    assert.equal(commentMarkers(x).filter((m) => m.startsWith('<!-- forge:decision')).length, 0, 'a superseded decision is never mirrored');

    x.script.mergeContradiction = () => false;
    x.sim.redecide('R01', { pick: labelOf('W1'), reason: '平', fav: labelOf('W1'), publish: 'no', facts: [`${labelOf('W1')}:A-01`] });
    decision2 = sha256Bytes(readFileSync(join(r01, 'decision-2.json')));
    d8b = decision2.slice(0, 8);
    const regateBytes = readFileSync(join(r01, 'merge', d8a, 'regate.json'));
    // E7 override (C00 reserve labels only: the R01 audit labels do not exist before run 6's 11e)
    const reserve = reserveLabels({ schema: 'calib-labels/1', labels: ledger(x) }, 16).filter((l) => l.round === 'C00');
    const xs = reserve.slice(0, 2).map((l) => l.id);
    const ys = reserve.filter((l) => !xs.includes(l.id) && !l.texts.some((tx) => tx.authors.includes('OpenAI'))).slice(0, 2).map((l) => l.id);
    assert.deepEqual([xs.length, ys.length], [2, 2]);
    x.e2e.replay = { newAgainst: new Map([['Moonshot', xs]]), oldAgainst: new Map([['OpenAI', ys]]) };
    assert.equal(await forge(['round', 'run', 'R01']), 2, lastLogs());

    assert.ok(hasInput(markerOf(x, 'rounds/R01/markers/09b-decision.json'), 'rounds/R01/decision-2.json'));
    assert.equal(markerOf(x, 'rounds/R01/markers/10a-regate.json')?.['result'], 'skip');
    assert.equal(judgeCalls(x, `regate-${d8b}`).length, 0);
    for (const f of ['plan', 'edit', 'apply', 'mergecheck', 'post-merge', 'postmerge-gate']) assert.ok(existsSync(join(r01, 'merge', d8b, `${f}.json`)), f);
    assert.equal(json(join(r01, 'merge.json'))['current'], d8b);
    assert.deepEqual(readFileSync(join(r01, 'merge', d8a, 'regate.json')), regateBytes, 'the failed attempt stays as evidence');
    const manifest = json(join(x.w.repo, 'world/current/reference/manifest.json'));
    assert.equal(readString(manifest, 'revision'), '8.2');
    assert.ok((readArray(manifest, 'files') ?? []).includes('09-scenes-and-people.md'));
    assert.equal(readFileSync(join(x.w.repo, 'world/current/BOOK.md'), 'utf8'), mainCanon()['world/current/BOOK.md']);
    const baseBook = (text: string | undefined): string | null => {
      const value: unknown = JSON.parse(text ?? '{}');
      return readString(value, 'base_book_sha256');
    };
    assert.equal(baseBook(readFileSync(join(x.w.repo, 'world/current/reference/hashes.json'), 'utf8')), baseBook(mainCanon()['world/current/reference/hashes.json']));
    assert.deepEqual(json(join(r01, 'merge', d8b, 'mergecheck.json')), { ok: true, violations: [] });
    assert.match(readFileSync(join(x.w.repo, 'world/current/reference/09-scenes-and-people.md'), 'utf8'), /R01-01/u);
    const commits = x.ports.git.commits('forge/r01').map((c) => c.message);
    assert.deepEqual(commits.slice(1), [`feat: add sample scene R01, reference 8.2 (#${issueNo()})`, `chore: bookkeeping for R01 (#${issueNo()})`]);
    const pool = readFileSync(join(root, 'regression', 'forecast-pool.jsonl'), 'utf8').trim().split('\n');
    assert.equal(pool.length, 40, '5 forecasters × 8');
    const ship = readRecord(json(join(root, 'champions.json')), 'SHIP');
    assert.deepEqual([readString(ship, 'kind'), readString(ship, 'round'), readString(ship, 'submission')], ['owner_pick', 'R01', 'W1']);
    const audit = readArray(json(join(r01, 'audit-set.json')), 'pairs') ?? [];
    const r01Labels = ledger(x).filter((l) => l.round === 'R01');
    assert.deepEqual(r01Labels.map((l) => [l.id, l.split]), audit.map((p) => [readString(p, 'id'), readString(p, 'split')]));
  });

  await t.test('E6 pending_owner hold: R01 froze v1 while v2 pends; the R01 packet carries E-R01-PEND-v2', async () => {
    assert.equal(json(join(r01, 'freeze.json'))['benchmark_version'], 'v1');
    const packet = json(join(root, 'benchmark', 'evidence', 'R01.json'));
    const ids = (readArray(packet, 'items') ?? []).map((i) => readString(i, 'id'));
    assert.ok(ids.includes('E-R01-PEND-v2'), ids.join(', '));
    assert.equal(readString(packet, 'head_version'), 'v1');
    // variant: head never counts an unapproved pending_owner version (PR-A bench-active), so the R01 proposal builds on v1
    assert.equal(json(join(r01, 'bench', 'proposal.json'))['parent'], 'v1');
  });

  await t.test('E7 rejected_by_replay (run 6): Moonshot drops 2 under the new question, OpenAI 2 under the old; diff approval (run 7)', async () => {
    const candidate = json(join(r01, 'bench', 'candidate.json'));
    assert.deepEqual([candidate['version'], candidate['parent'], readString(readArray(readRecord(candidate, 'taste'), 'questions')?.[0], 'text')], ['v3', 'v1', REPLAY_Q]);
    const validate = json(join(r01, 'bench', 'validate.json'));
    assert.deepEqual([readRecord(validate, 'verdict')?.['ok'], validate['base_activation']], [true, 'replay']);
    const replay = parseReplayResult(JSON.parse(readFileSync(join(r01, 'bench', 'replay.json'), 'utf8')), context(x, 'R01').protocol.calibration.replayMinPairs);
    assert.ok(replay.ok, replay.ok ? '' : replay.error);
    const r = replay.value;
    const labels = ledger(x);
    const reserve = reserveLabels({ schema: 'calib-labels/1', labels }, 16);
    assert.deepEqual(r.summary.labels, reserve.map((l) => l.id));
    // variant: every R01 reserve label shares a text (W1, W2-r2, W3, the champion) with a visible R01 label, so
    // reserveLabels drops it (PR-C: a shown text is never replay material); the replay runs on the 12 C00 reserve labels
    assert.equal(r.summary.labels.length, 12);
    assert.ok(r.summary.labels.every((id) => id.startsWith('C00-')));
    const shown = new Set(labels.filter((l) => l.split === 'visible').flatMap((l) => l.texts.map((tx) => tx.sha256)));
    for (const l of labels.filter((lb) => lb.round === 'R01' && lb.split === 'reserve')) assert.ok(l.texts.some((tx) => shown.has(tx.sha256)), l.id);
    const visible = new Set(visibleLabels({ schema: 'calib-labels/1', labels }).map((l) => l.id));
    assert.ok(r.summary.labels.every((id) => !visible.has(id)), 'reserve labels only');
    assert.equal(r.summary.pooled.new, r.summary.pooled.old);
    assert.ok(r.summary.pooled.n >= 4);
    const moonshot = r.summary.per_family['Moonshot'];
    const openai = r.summary.per_family['OpenAI'];
    assert.ok(moonshot !== undefined && openai !== undefined);
    assert.deepEqual([moonshot.old - moonshot.new, openai.new - openai.old], [2, 2]);
    assert.deepEqual([r.summary.reason, r.summary.passed], ['family_drop', false]);
    const replayCalls = judgeCalls(x, 'replay');
    assert.equal(replayCalls.length, r.plan.length, 'one call per planned trial');
    assert.ok(r.plan.findIndex((c) => c.version === 'new') < r.plan.findLastIndex((c) => c.version === 'old'), 'old and new interleaved');
    const authorsOf = new Map(labels.map((l) => [l.id, l.texts.flatMap((tx) => tx.authors)]));
    assert.ok(r.plan.every((c) => !(authorsOf.get(c.label) ?? []).includes(c.family)), 'no family judges a label it authored (OpenAI never on canon_vs_rewrite)');
    const log = logLines(x);
    const line = log[2];
    assert.deepEqual([log.length, line?.cycle, line?.version, line?.outcome], [3, 'R01', 'v3', 'rejected_by_replay']);
    assert.equal(line?.sha256, sha256Bytes(readFileSync(join(r01, 'bench', 'candidate.json'))));
    assert.equal(existsSync(join(root, 'benchmark', 'v3.json')), false);
    assert.deepEqual([resolved(x, 'effective'), resolved(x, 'head')], ['v1/approved', 'v1/approved']);
    const [prompt] = maintainerPrompts(x, 'bench-propose-R01');
    assert.ok(prompt !== undefined && prompt.includes('E-R01-PEND-v2'));
    // no C00 reserve label id, text id, 12-character head (a fake judge's quote) or sentence in any maintainer prompt so far
    const material = reserveMaterial(x);
    for (const id of ['bench-initial', 'bench-propose-R00', 'bench-propose-R01']) assertNoReserve(x, id, material);
    // the check bites on the real prompt: one reserve head, or one mid-text sentence, pasted into a copy is caught
    const attributable = (needle: string): boolean => !material.shown.some((sh) => sh.includes(needle));
    const probe = material.reserve.find((rt) => attributable(head(rt.text.trim())));
    const mid = material.reserve.flatMap((rt) => splitSentences(rt.text.trim()).slice(1, -1).filter((sn) => [...sn].length >= 8 && attributable(sn)).map((sn) => ({ rt, sn })))[0];
    assert.ok(probe !== undefined && mid !== undefined, 'an attributable reserve head and sentence exist');
    const probeHead = head(probe.text.trim());
    assert.deepEqual(reserveLeaks(`${prompt}\n${probeHead}`, [probe], material.shown), [`${probe.id}: head 「${probeHead}」`]);
    assert.deepEqual(reserveLeaks(`${prompt}\n${mid.sn}`, [mid.rt], material.shown), [`${mid.rt.id}: sentence 「${mid.sn}」`]);
    const st = status(x, 'R01');
    assert.deepEqual([st.state, st.step, st.waiting_for], ['waiting', '12b-diff-approval', 'diff_approval']);
    const final = json(join(r01, 'final.json'));
    assert.equal(final['approval_diff_sha256'], sha256Bytes(readFileSync(join(r01, 'approval.diff'))));
    assert.deepEqual(final['maintainer'], { outcome: 'rejected_by_replay', version: 'v3', evidence_ids: line?.evidence_ids ?? [] });
    assert.equal(markerOf(x, 'rounds/R01/markers/11k-wiki.json')?.['result'], 'skip');

    x.sim.approveDiff('R01');
    assert.equal(await forge(['round', 'run', 'R01']), 0, lastLogs());
    assert.equal(status(x, 'R01').state, 'done');
    const onIssue = commentMarkers(x, issueNo());
    const diffSha = readString(final, 'approval_diff_sha256') ?? '';
    for (const m of [mirrorMarker('decision', 'R01', decision2), mirrorMarker('bench_notice', 'R01', 'v3'), mirrorMarker('diff_approval', 'R01', diffSha)]) {
      assert.equal(onIssue.filter((c) => c === m).length, 1, m);
    }
    assert.equal(onIssue.filter((c) => c.startsWith('<!-- forge:decision')).length, 1, 'nothing for the superseded decision.json');
    const count = x.ports.github.comments().length;
    assert.equal(await forge(['mirror', '--round', 'R01']), 0);
    assert.equal(x.ports.github.comments().length, count, 'forge mirror posts nothing new');
    assert.equal(await forge(['round', 'start', 'R02', '--cell', 'cells/E2E-R02.json']), 1, 'R01 is still open');
    assert.match(x.logs.at(-1) ?? '', /forge\/r01 not merged/u);
    await mergeBranch(x, 'forge/r01');
  });

  await t.test('E8 the owner rollback takes effect at the next freeze: R02 keeps v2 to the end (pick none), R03 freezes v1', async () => {
    const r02 = join(root, 'rounds', 'R02');
    x.script.decoyLover = 'DeepSeek'; // no judge family: the decoy lover acted in R01 only, so R02 pairs keep |E| = 4
    x.ports.clock.advance(86_400_000);
    x.sim.approveBench('v2');
    const logsAt = x.logs.length;
    assert.equal(await forge(['round', 'start', 'R02', '--cell', 'cells/E2E-R02.json']), 0, lastLogs());
    assert.equal(x.logs.slice(logsAt).some((l) => l.startsWith('基准 ')), false, 'v2 is approved: nothing pends');
    assert.equal(await forge(['round', 'run', 'R02', '--until', '02c-freeze']), 0, lastLogs());
    const freezePath = join(r02, 'freeze.json');
    const resolution = readRecord(json(freezePath), 'benchmark_resolution');
    assert.deepEqual([json(freezePath)['benchmark_version'], readString(resolution, 'via')], ['v2', 'approved']);
    assert.equal(callsOf(x, 'BASE').length, 1, '02b ran once');
    const coldBay = readRecord(json(join(root, 'champions.json')), 'S1-冷湾');
    assert.deepEqual([readString(coldBay, 'kind'), readArray(coldBay, 'authors')], ['baseline', ['DeepSeek']]);
    const h2 = sha256Bytes(readFileSync(freezePath));
    const m02c = markerBytes(root, 'R02').get('02c-freeze');
    x.ports.clock.advance(60_000);
    x.sim.rollback('v1', 'v2');
    const rollbackAt = ownerInputs(root).rollbacks().at(-1)?.at;

    assert.equal(await forge(['round', 'run', 'R02', '--until', '03b-seal']), 0, lastLogs());
    assert.equal(sha256Bytes(readFileSync(freezePath)), h2, 'a resumed round never re-resolves');
    assert.equal(markerBytes(root, 'R02').get('02c-freeze'), m02c);
    assert.equal(await forge(['round', 'run', 'R02']), 2, lastLogs());
    assert.equal(status(x, 'R02').waiting_for, 'audit');
    // 03c amends freeze.json (probe_created_at, the one allowed amendment); the benchmark pin stays v2
    assert.deepEqual(readRecord(json(freezePath), 'benchmark_resolution'), resolution);
    x.sim.answerAudit('R02', ownerChoice);
    assert.equal(await forge(['round', 'run', 'R02']), 2, lastLogs());
    const labels02 = Object.keys(json(join(r02, 'labels.json'))).sort();
    x.sim.decide('R02', { pick: 'none', reason: '平', fav: labels02[0] ?? 'A', publish: 'no', facts: [] });
    assert.equal(await forge(['round', 'run', 'R02']), 2, lastLogs());
    assert.equal(status(x, 'R02').waiting_for, 'diff_approval');
    for (const step of ['10a-regate', '10b-merge-edit', '10c-apply', '10d-post-merge-freeze', '10e-post-merge-gate', '10f-commit', '11c-champion', '11d-tagging', '11k-wiki']) {
      assert.equal(markerOf(x, `rounds/R02/markers/${step}.json`)?.['result'], 'skip', step);
    }
    assert.deepEqual([json(join(r02, 'bench', 'outcome.json'))['outcome'], logLines(x).at(-1)?.cycle], ['no_change', 'R02']);
    assertNoReserve(x, 'bench-propose-R02', reserveMaterial(x));
    assert.deepEqual([json(join(r02, 'final.json'))['status'], readFileSync(join(r02, 'approval.diff'), 'utf8')], ['no_merge', '']);
    const pairs02 = readArray(json(join(r02, 'tally.json')), 'champion_pairs') ?? [];
    assert.ok(pairs02.length > 0 && pairs02.every((p) => (readArray(p, 'e') ?? []).length === 4), 'the baseline is authored by DeepSeek only: |E| = 4');
    x.sim.approveDiff('R02');
    assert.equal(await forge(['round', 'run', 'R02']), 0, lastLogs());
    assert.equal(status(x, 'R02').state, 'done');
    const h2done = sha256Bytes(readFileSync(freezePath));
    await mergeBranch(x, 'forge/r02');

    assert.equal(await forge(['round', 'start', 'R03', '--cell', 'cells/E2E-R03.json']), 0, lastLogs());
    assert.equal(await forge(['round', 'run', 'R03', '--until', '02c-freeze']), 0, lastLogs());
    const r03 = json(join(root, 'rounds', 'R03', 'freeze.json'));
    const res03 = readRecord(r03, 'benchmark_resolution');
    assert.deepEqual(
      [r03['benchmark_version'], readString(res03, 'via'), readString(res03, 'sha256'), readString(res03, 'since')],
      ['v1', 'rollback', sha256Bytes(readFileSync(join(root, 'benchmark', 'v1.json'))), rollbackAt],
    );
    assert.equal(sha256Bytes(readFileSync(freezePath)), h2done, 'R03 leaves R02 untouched');
    const holds = rollbackHolds(root, ownerInputs(root), logLines(x), context(x, 'R03').protocol.activation);
    assert.ok(holds.ok, holds.ok ? '' : holds.error);
    // the rollback was clicked while R02 was the newest frozen round: decoy_recipe is held for hold_rounds (3) cycles from R02
    assert.deepEqual(holds.value, [{ round: 2, rolledBackKeys: ['decoy_recipe'] }]);
    assert.equal(context(x, 'R03').protocol.bars.holdRounds, 3);
  });

  await t.test('E9 guards: owner files only from owner-sim, OwnerFileError on engine writes, benchmark/ contents, no testing imports', async () => {
    assert.deepEqual([...x.sim.expected().keys()].sort(), [
      'calibration/owner-answers.json', 'owner-log.jsonl', 'rounds/R01/audit.json', 'rounds/R01/decision-2.json', 'rounds/R01/decision.json', 'rounds/R02/audit.json', 'rounds/R02/decision.json',
    ]);
    const files = context(x, 'R01').files;
    const probes: Array<() => unknown> = [
      () => files.writeJson(join(root, 'rounds/R01/audit.json'), {}),
      () => files.writeJson(join(root, 'rounds/R01/./decision-3.json'), {}),
      () => files.writeJson(join(root, 'calibration/Owner-Answers.json'), {}),
      () => files.appendLine(join(root, 'owner-log.jsonl'), {}),
    ];
    for (const probe of probes) assert.throws(probe, (e: unknown) => e instanceof OwnerFileError);
    assert.equal(existsSync(join(r01, 'decision-3.json')), false);
    guards(x);
    const bench = filesUnder(root, join(root, 'benchmark')).filter((f) => !f.startsWith('benchmark/initial/')).sort();
    assert.deepEqual(bench, ['benchmark/evidence/R00.json', 'benchmark/evidence/R01.json', 'benchmark/evidence/R02.json', 'benchmark/log.jsonl', 'benchmark/v1.json', 'benchmark/v2.json']);
    assert.ok(filesUnder(root, join(root, 'benchmark', 'initial')).length > 0);
    assert.ok(trackedFiles(x.w.repo, root).every((f) => !f.includes('/.runs/') && !f.includes('/.sealed/') && !f.endsWith('local.json')));
    assertNoTestingImports(ENGINE_DIR);
    assert.ok(root.startsWith(tmpdir()), 'the test never touches the real forge root');
  });

  const calls = x.routers.reduce((n, r) => n + r.log().length, 0);
  assert.ok(calls > 500 && calls < 800, `${calls} fake calls`);
  rmSync(x.dir, { recursive: true, force: true });
  assert.ok(Date.now() - started < 60_000, `e2e took ${Date.now() - started} ms`);
});
