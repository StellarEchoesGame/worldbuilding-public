import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { activeBenchmark } from './bench-active.ts';
import { CANDIDATE_FILE, OUTCOME_FILE, outcomeStep, PROPOSAL_FILE, proposeStep, readOutcome, readProposal, readValidate, replayStep, validateStep } from './bench-cycle.ts';
import { readBenchLog } from './bench-log.ts';
import { MAINTAINER_KEYS } from './bench-validate.ts';
import { loadConfig, type Family } from './config.ts';
import { buildContext, type RoundBackends, type StepContext } from './context.ts';
import { isRecord, type JsonRecord } from './json.ts';
import type { StepOutcome } from './runner.ts';
import { roundPaths, sha256 } from './store.ts';
import { unwrap } from './tasks/fenced.ts';
import { fakePorts, type FakeClock } from './testing/fakes.ts';
import { DEFAULT_FIXTURE, FIXTURE_WRITER_MODEL, fixtureWorld, type FixtureOptions } from './testing/fixture-world.ts';
import { ownerSim, type OwnerSim } from './testing/owner-sim.ts';
import { callLog, fakeRouter, type FakeRouter, type Route } from './testing/scripted.ts';
import { LABELS_FILE } from './trust.ts';

/*
 * 11g–11j on a fixture round R01 (steps called directly): a hand-written evidence packet (one reserve_count item),
 * six C00 reserve labels for the replay, a scripted maintainer that edits the head it is shown, and replay judges
 * that answer for the owner unless `against(family, label, isNew)` says otherwise.
 */

const OWNER_MARK = '主人选中的这一篇';
const NEW_Q = '哪一篇里的地方，你读完还想再回去看一眼？';
const START = '2026-10-01T00:00:00.000Z';
const EVIDENCE_ID = 'E-R01-RES';

type Against = (family: Family, label: string, isNew: boolean) => boolean;

interface CycleWorld {
  ctx: StepContext;
  root: string;
  repo: string;
  sim: OwnerSim;
  clock: FakeClock;
  maintainer: FakeRouter;
  judges: FakeRouter[];
}

function fence(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

function put(root: string, rel: string, text: string): string {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
  return sha256(text);
}

function json(prompt: string, label: string): JsonRecord {
  const value: unknown = JSON.parse(unwrap(prompt, label) ?? 'null');
  if (!isRecord(value)) throw new Error(`maintainer fake: no ${label} in the prompt`);
  return value;
}

/** A change of the head it is shown: `edit` rewrites the maintainer keys, the one reason cites the packet's first item. */
function changeRoute(keys: readonly string[], edit: (body: JsonRecord) => void): Route {
  return (prompt) => {
    const head = json(prompt, '当前版本');
    const items = json(prompt, '证据包')['items'];
    const first = Array.isArray(items) && isRecord(items[0]) ? items[0]['id'] : null;
    const body: JsonRecord = Object.fromEntries(MAINTAINER_KEYS.map((k) => [k, structuredClone(head[k])]));
    edit(body);
    return fence({ kind: 'change', body, reasons: [{ change: '按证据调整', keys, evidence_ids: [first], expected_effect: '更贴近 owner 的选择' }] });
  };
}

function replayRoute(family: Family, against: Against): Route {
  return (prompt, _n, meta) => {
    const t1 = unwrap(prompt, '文本甲') ?? '';
    const t2 = unwrap(prompt, '文本乙') ?? '';
    const honest = t1.includes(OWNER_MARK) ? 1 : 2;
    const pick = against(family, /^replay-(C00-P\d{2})-/u.exec(meta.taskId)?.[1] ?? '', prompt.includes(NEW_Q)) ? 3 - honest : honest;
    const quote = [...(pick === 1 ? t1 : t2)].slice(0, 12).join('');
    return fence({ answers: { q1: { pick, quote }, q2: { pick, quote } } });
  };
}

function ledger(root: string): void {
  const labels = [1, 2, 3, 4, 5, 6].map((k) => {
    const texts = [0, 1].map((j) => {
      const tid = `C00-T${String(2 * k - 1 + j).padStart(2, '0')}`;
      const body = j === 0 ? `${OWNER_MARK}，第${k}个邻里的循环泵在夜里换了节拍。` : `第${k}个邻里的走廊很安静，灯一盏一盏熄了。`;
      return { id: tid, path: `calibration/texts/${tid}.md`, sha256: put(root, `calibration/texts/${tid}.md`, body), authors: ['DeepSeek'] };
    });
    return { id: `C00-P0${k}`, source: 'round0', round: 'C00', seq: k, texts, owner_chosen: texts[0]?.id ?? '', answered_at: '2026-09-02T00:00:00Z', split: 'reserve', use: 'qualification', trials: {} };
  });
  put(root, LABELS_FILE, `${JSON.stringify({ schema: 'calib-labels/1', labels }, null, 2)}\n`);
}

function cycleWorld(maintainerRoute: Route, against: Against = () => false, fixture: FixtureOptions = DEFAULT_FIXTURE): CycleWorld {
  const w = fixtureWorld(mkdtempSync(join(tmpdir(), 'forge-cycle-')), fixture);
  const loaded = loadConfig(w.root, { requireLocal: true });
  if (!loaded.ok) throw new Error(loaded.error);
  ledger(w.root);
  const hex = 'a'.repeat(64);
  put(w.root, 'rounds/R01/start.json', JSON.stringify({ round: 'R01', seed: 'cycle-seed', branch: 'forge/r01', base_sha: 'base', issue: { number: 2, url: 'https://example.invalid/2' }, bundle_sha256: hex, doctor_sha256: hex, started_at: START, cell: null }));
  put(w.root, 'benchmark/evidence/R01.json', `${JSON.stringify({ round: 'R01', benchmark_version: 'v1', head_version: 'v1', inputs: {}, items: [{ id: EVIDENCE_ID, kind: 'reserve_count', visible: 0, reserve: 6 }], ceilings: [] }, null, 2)}\n`);
  const plain = fakeRouter({}, { id: 'W1', family: 'DeepSeek', model: FIXTURE_WRITER_MODEL });
  const maintainer = fakeRouter({ bench: maintainerRoute }, { id: 'maintainer', family: 'Anthropic', model: 'fixture-maintainer' });
  const judges = loaded.value.judges.map((j) => fakeRouter({ replay: replayRoute(j.family, against) }, { id: j.id, family: j.family, model: j.model }));
  const backends: RoundBackends = {
    writers: [{ slot: 'W1', backend: plain }], baseline: plain, decoy: plain, defect: plain, judges: judges.map((backend) => ({ backend, concurrency: 2 })), forecasters: [], maintainer, mergeEditor: plain, calibGateway: new Map(),
  };
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: START, seed: 'cycle' });
  const built = buildContext({
    root: w.root, repo: w.repo, roundId: 'R01', pipeline: 'round', paths: roundPaths(w.root, 'R01'), config: loaded.value,
    deps: { ports, backends: () => backends, env: {}, pid: 1, isAlive: () => true, log: () => undefined }, startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
  });
  if (!built.ok) throw new Error(built.error);
  return { ctx: built.value, root: w.root, repo: w.repo, sim: ownerSim(w.root, ports.clock), clock: ports.clock, maintainer, judges };
}

/** 11g → 11j in order, stopping at the first outcome that is not done / skip. */
async function cycle(x: CycleWorld): Promise<Record<string, StepOutcome>> {
  const out: Record<string, StepOutcome> = {};
  for (const step of [proposeStep, validateStep, replayStep, outcomeStep]) {
    const o = await step.run(x.ctx, null);
    out[step.id] = o;
    if (o.kind !== 'done' && o.kind !== 'skip') break;
  }
  return out;
}

function bench(x: CycleWorld, rel: string): string {
  return join(x.ctx.paths.bench, rel);
}

function fileSha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Owner files are byte-identical to what the owner (fixture + sim) last wrote. */
function assertOwnerFiles(x: CycleWorld, before: ReadonlyMap<string, string>): void {
  for (const [rel, sha] of before) assert.equal(fileSha(join(x.root, rel)), sha, `${rel} changed`);
  assert.ok(!existsSync(join(x.root, 'calibration/owner-answers.json')));
}

function ownerSnapshot(x: CycleWorld): Map<string, string> {
  return new Map([['owner-log.jsonl', fileSha(join(x.root, 'owner-log.jsonl'))]]);
}

function setQuestion(body: JsonRecord): void {
  const taste = body['taste'];
  if (!isRecord(taste) || !Array.isArray(taste['questions']) || !isRecord(taste['questions'][0])) throw new Error('head has no taste questions');
  taste['questions'][0]['text'] = NEW_Q;
}

/** Logs v2 = v1 + patch(v1) (cycle R00, before the round) and points the round's hand-written packet at `head`. */
function logV2(x: CycleWorld, patch: (v1: JsonRecord) => JsonRecord, outcome: 'activate' | 'pending_owner', activation: string, head: string): void {
  const v1: unknown = JSON.parse(readFileSync(join(x.root, 'benchmark/v1.json'), 'utf8'));
  const first: unknown = JSON.parse(readFileSync(join(x.root, 'benchmark/log.jsonl'), 'utf8').split('\n')[0] ?? '');
  assert.ok(isRecord(v1) && isRecord(first));
  const changes = patch(v1);
  const sha = put(x.root, 'benchmark/v2.json', `${JSON.stringify({ ...v1, version: 'v2', parent: 'v1', ...changes }, null, 2)}\n`);
  const line = { ...first, at: '2026-09-10T00:00:00.000Z', cycle: 'R00', outcome, version: 'v2', parent: 'v1', sha256: sha, path: 'benchmark/v2.json', activation, changed_keys: Object.keys(changes) };
  writeFileSync(join(x.root, 'benchmark/log.jsonl'), `${readFileSync(join(x.root, 'benchmark/log.jsonl'), 'utf8')}${JSON.stringify(line)}\n`);
  const packet = join(x.root, 'benchmark/evidence/R01.json');
  writeFileSync(packet, readFileSync(packet, 'utf8').replace('"head_version": "v1"', `"head_version": "${head}"`));
}

/** Pooled agreement equal old vs new, but Moonshot loses exactly 2 under the new version (s6 E7). */
const MOONSHOT_DROPS: Against = (family, label, isNew) =>
  (family === 'Moonshot' && isNew && (label === 'C00-P03' || label === 'C00-P04')) || (family === 'OpenAI' && !isNew && (label === 'C00-P05' || label === 'C00-P06'));

test('taste change → replay (Moonshot −2 on new) → rejected_by_replay: the candidate never leaves bench/, head unchanged', async () => {
  const x = cycleWorld(changeRoute(['taste'], setQuestion), MOONSHOT_DROPS);
  const owner = ownerSnapshot(x);
  const out = await cycle(x);
  const propose = out['11g-bench-propose'];
  assert.deepEqual(propose, { kind: 'done', inputs: ['benchmark/evidence/R01.json', 'benchmark/v1.json'], outputs: ['rounds/R01/bench/proposal.json', 'rounds/R01/bench/candidate.json'], external: [] });
  const proposal = readProposal(x.ctx.paths);
  assert.ok(proposal !== null && proposal.ok);
  assert.deepEqual([proposal.value.cycle, proposal.value.version, proposal.value.parent, proposal.value.parent_sha256], ['R01', 'v2', 'v1', fileSha(join(x.root, 'benchmark/v1.json'))]);
  assert.equal(proposal.value.evidence_packet_sha256, fileSha(join(x.root, 'benchmark/evidence/R01.json')));
  assert.deepEqual(proposal.value.calls, ['rounds/R01/calls/bench-propose-R01-a1.json']);
  assert.equal(proposal.value.model, 'fixture-maintainer');
  const validated = readValidate(x.ctx.paths);
  assert.ok(validated !== null && validated.ok);
  assert.equal(validated.value.verdict.ok, true, validated.value.verdict.errors.join('; '));
  assert.deepEqual(validated.value.verdict.changedKeys, ['taste']);
  assert.equal(validated.value.base_activation, 'replay');
  assert.equal(out['11i-bench-replay']?.kind, 'done');
  const outcome = out['11j-bench-outcome'];
  assert.deepEqual(outcome, { kind: 'done', inputs: ['proposal', 'validate', 'candidate', 'replay'].map((f) => `rounds/R01/bench/${f}.json`), outputs: ['rounds/R01/bench/outcome.json'], external: [] });
  const line = readOutcome(x.ctx.paths);
  assert.ok(line !== null && line.ok);
  assert.equal(line.value.outcome, 'rejected_by_replay');
  assert.equal(line.value.version, 'v2');
  assert.equal(line.value.path, 'rounds/R01/bench/candidate.json');
  assert.equal(line.value.sha256, fileSha(bench(x, CANDIDATE_FILE)));
  assert.equal(line.value.replay?.reason, 'family_drop');
  assert.deepEqual(line.value.evidence_ids, [EVIDENCE_ID]);
  const log = readBenchLog(x.root);
  assert.ok(log.ok);
  assert.deepEqual(log.value.map((e) => [e.cycle, e.outcome, e.version]), [['R00-init', 'activate', 'v1'], ['R01', 'rejected_by_replay', 'v2']]);
  assert.deepEqual(log.value[1], line.value, 'outcome.json is the logged line');
  assert.ok(!existsSync(join(x.root, 'benchmark/v2.json')));
  const head = activeBenchmark(x.ctx, 'head');
  assert.ok(head.ok && head.value.version === 'v1');
  assert.equal(callLog(x.maintainer).length, 1);
  assert.ok(x.judges.every((j) => callLog(j).every((c) => c.startsWith('replay-'))));
  assertOwnerFiles(x, owner);
});

test('decoy_recipe change → pending_owner hold: no replay; v2 written; freezes keep v1 until bench_approved, then use v2', async () => {
  const x = cycleWorld(changeRoute(['decoy_recipe'], (b) => { b['decoy_recipe'] = { details: 3, instructions: '把现任稿中最具体的三个细节换成泛泛的同类说法，长度、段落和格式保持不变。' }; }));
  const owner = ownerSnapshot(x);
  const out = await cycle(x);
  assert.deepEqual(out['11i-bench-replay'], { kind: 'skip', reason: 'no replay-class key' });
  const outcome = out['11j-bench-outcome'];
  assert.ok(outcome?.kind === 'done');
  assert.deepEqual(outcome.external, ['benchmark/v2.json']);
  const line = readOutcome(x.ctx.paths);
  assert.ok(line !== null && line.ok);
  assert.deepEqual([line.value.outcome, line.value.version, line.value.activation, line.value.path], ['pending_owner', 'v2', 'owner', 'benchmark/v2.json']);
  assert.equal(line.value.sha256, fileSha(join(x.root, 'benchmark/v2.json')));
  assert.equal(readFileSync(join(x.root, 'benchmark/v2.json'), 'utf8'), readFileSync(bench(x, CANDIDATE_FILE), 'utf8'));
  const v2: unknown = JSON.parse(readFileSync(join(x.root, 'benchmark/v2.json'), 'utf8'));
  assert.ok(isRecord(v2) && v2['parent'] === 'v1' && isRecord(v2['author']) && v2['author']['kind'] === 'maintainer');
  const later = new Date(Date.parse(START) + 3 * 86_400_000).toISOString();
  const held = activeBenchmark(x.ctx, 'effective', later);
  assert.ok(held.ok && held.value.version === 'v1', 'the next freeze keeps v1 while v2 waits for the owner');
  x.sim.approveBench('v2');
  x.clock.advance(60_000);
  const approved = activeBenchmark(x.ctx, 'effective');
  assert.ok(approved.ok);
  assert.deepEqual([approved.value.version, approved.value.via], ['v2', 'approved']);
  assert.equal(owner.size, 1);
});

/** A 6-character window of the fixture BOOK.md (a cliché candidate that occurs in canon). */
function canonPhrase(repo: string): string {
  const book = readFileSync(join(repo, 'world/current/BOOK.md'), 'utf8');
  const line = book.split('\n').find((l) => [...l.trim()].length >= 12 && !l.startsWith('#')) ?? '';
  return [...line.trim()].slice(2, 8).join('');
}

test('auto change (cliche_list) → activate behind the protocol gate; canon clichés dropped; a rerun after a kill after the append logs nothing new', async () => {
  let phrase = '';
  const x = cycleWorld(changeRoute(['cliche_list'], (b) => { b['cliche_list'] = ['时光在指缝间流走', '命运的齿轮开始转动', phrase]; }), () => false, { ...DEFAULT_FIXTURE, protocolApproved: false });
  phrase = canonPhrase(x.repo);
  const out = await cycle(x);
  assert.deepEqual(out['11i-bench-replay'], { kind: 'skip', reason: 'no replay-class key' });
  const waiting = out['11j-bench-outcome'];
  assert.ok(waiting?.kind === 'wait' && waiting.waitingFor === 'protocol_approval');
  assert.ok(!existsSync(join(x.root, 'benchmark/v2.json')) && !existsSync(bench(x, OUTCOME_FILE)));
  const before = readBenchLog(x.root);
  assert.ok(before.ok && before.value.length === 1, 'nothing logged while the gate waits');
  x.sim.approveProtocol();
  const done = await outcomeStep.run(x.ctx, null);
  assert.ok(done.kind === 'done' && done.external[0] === 'benchmark/v2.json');
  const line = readOutcome(x.ctx.paths);
  assert.ok(line !== null && line.ok);
  assert.deepEqual([line.value.outcome, line.value.activation, line.value.changed_keys], ['activate', 'auto', ['cliche_list']]);
  assert.deepEqual(line.value.dropped_cliches, [phrase]);
  const v2: unknown = JSON.parse(readFileSync(join(x.root, 'benchmark/v2.json'), 'utf8'));
  assert.ok(isRecord(v2));
  assert.deepEqual(v2['cliche_list'], ['时光在指缝间流走', '命运的齿轮开始转动']);
  // Kill after the append, before outcome.json and the marker: the rerun re-writes v2 (same bytes) and appends nothing.
  const logText = readFileSync(join(x.root, 'benchmark/log.jsonl'), 'utf8');
  const outcomeText = readFileSync(bench(x, OUTCOME_FILE), 'utf8');
  rmSync(bench(x, OUTCOME_FILE));
  x.clock.advance(3_600_000);
  const again = await outcomeStep.run(x.ctx, null);
  assert.deepEqual(again, done);
  assert.equal(readFileSync(join(x.root, 'benchmark/log.jsonl'), 'utf8'), logText);
  assert.equal(readFileSync(bench(x, OUTCOME_FILE), 'utf8'), outcomeText);
});

test('11g: the version is allocated once; a rerun (proposal present, or killed before it) makes no new call and keeps the id', async () => {
  const x = cycleWorld(changeRoute(['cliche_list'], (b) => { b['cliche_list'] = ['命运的齿轮开始转动']; }));
  const first = await proposeStep.run(x.ctx, null);
  const bytes = readFileSync(bench(x, PROPOSAL_FILE), 'utf8');
  assert.deepEqual(await proposeStep.run(x.ctx, null), first);
  assert.equal(readFileSync(bench(x, PROPOSAL_FILE), 'utf8'), bytes);
  rmSync(bench(x, PROPOSAL_FILE));
  rmSync(bench(x, CANDIDATE_FILE));
  assert.deepEqual(await proposeStep.run(x.ctx, null), first);
  const again = readProposal(x.ctx.paths);
  assert.ok(again !== null && again.ok && again.value.version === 'v2');
  assert.equal(callLog(x.maintainer).length, 1, 'the task record is reused');
});

test('void maintainer output (twice unparseable) → no_change_invalid: 11h / 11i skip, the log line has no version', async () => {
  const x = cycleWorld(() => '没有代码块的回答');
  const out = await cycle(x);
  assert.deepEqual(out['11h-bench-validate'], { kind: 'skip', reason: 'no candidate' });
  assert.deepEqual(out['11i-bench-replay'], { kind: 'skip', reason: 'no candidate' });
  assert.equal(callLog(x.maintainer).length, 2);
  const line = readOutcome(x.ctx.paths);
  assert.ok(line !== null && line.ok);
  assert.deepEqual([line.value.outcome, line.value.version, line.value.path, line.value.sha256], ['no_change_invalid', null, null, null]);
  assert.equal(line.value.errors.length, 1);
  assert.deepEqual(line.value.calls, ['rounds/R01/calls/bench-propose-R01-a1.json', 'rounds/R01/calls/bench-propose-R01-a2.json']);
  assert.ok(!existsSync(bench(x, CANDIDATE_FILE)));
});

test('no_change output → no_change; a change equal to the head → no_change with "change output equals head"', async () => {
  const kept = cycleWorld(() => fence({ kind: 'no_change', reasons: [{ text: '证据不足以改动', evidence_ids: [EVIDENCE_ID] }] }));
  await cycle(kept);
  const a = readOutcome(kept.ctx.paths);
  assert.ok(a !== null && a.ok);
  assert.deepEqual([a.value.outcome, a.value.version, a.value.evidence_ids], ['no_change', null, [EVIDENCE_ID]]);
  const same = cycleWorld(changeRoute(['taste'], () => undefined));
  const out = await cycle(same);
  assert.deepEqual(out['11i-bench-replay'], { kind: 'skip', reason: 'no change' });
  const b = readOutcome(same.ctx.paths);
  assert.ok(b !== null && b.ok);
  assert.deepEqual([b.value.outcome, b.value.version, b.value.path, b.value.errors], ['no_change', null, null, ['change output equals head']]);
  const log = readBenchLog(same.root);
  assert.ok(log.ok && log.value.length === 2);
  assert.equal(readValidate(same.ctx.paths)?.ok, true);
});

test('a protected key in the body → rejected_validate, logged with the validation errors and the round-local candidate', async () => {
  const x = cycleWorld(changeRoute(['cliche_list'], (b) => { b['cliche_list'] = ['命运的齿轮开始转动']; b['gate'] = { rules: [] }; }));
  const out = await cycle(x);
  assert.deepEqual(out['11i-bench-replay'], { kind: 'skip', reason: 'verdict not ok' });
  const line = readOutcome(x.ctx.paths);
  assert.ok(line !== null && line.ok);
  assert.deepEqual([line.value.outcome, line.value.version, line.value.path], ['rejected_validate', 'v2', 'rounds/R01/bench/candidate.json']);
  assert.ok(line.value.errors.includes('protected key gate'), line.value.errors.join('; '));
  assert.ok(!existsSync(join(x.root, 'benchmark/v2.json')));
});

test('taste change inside a rollback hold: the replay still runs (base class replay); a pass is pending_owner (hold upgrade)', async () => {
  const x = cycleWorld(changeRoute(['taste'], setQuestion));
  logV2(x, (v1) => ({ taste: { ...(isRecord(v1['taste']) ? v1['taste'] : {}), decisive: 'q2' } }), 'activate', 'replay', 'v1');
  x.sim.viewBenchDiff('v2');
  x.sim.rollback('v1', 'v2');
  const out = await cycle(x);
  const validated = readValidate(x.ctx.paths);
  assert.ok(validated !== null && validated.ok);
  assert.deepEqual(validated.value.holds, [{ round: 0, rolledBackKeys: ['taste'] }]);
  assert.equal(validated.value.base_activation, 'replay');
  assert.equal(validated.value.verdict.activation, 'owner');
  assert.equal(out['11i-bench-replay']?.kind, 'done');
  const line = readOutcome(x.ctx.paths);
  assert.ok(line !== null && line.ok);
  assert.deepEqual([line.value.outcome, line.value.version, line.value.parent, line.value.replay?.reason], ['pending_owner', 'v3', 'v1', 'ok']);
  assert.ok(existsSync(join(x.root, 'benchmark/v3.json')));
});

const EXTRA_ITEM = '每段至少一个可触摸的物件';
const V2_CLICHE = 'V2独有的套话';
const addExtra = changeRoute(['interface_checklist_extra'], (b) => { b['interface_checklist_extra'] = [EXTRA_ITEM]; });

for (const when of ['before 11h', 'between 11h and 11j']) {
  test(`owner rollback v2 → v1 ${when}: the auto child of v2 is rejected_validate, never an activate that restores v2`, async () => {
    const x = cycleWorld(addExtra);
    logV2(x, () => ({ cliche_list: ['时光在指缝间流走', V2_CLICHE] }), 'activate', 'auto', 'v2');
    x.sim.viewBenchDiff('v2');
    x.clock.advance(60_000);
    const rollback = (): void => {
      x.sim.rollback('v1', 'v2');
      x.clock.advance(60_000);
    };
    if (when === 'before 11h') rollback();
    assert.equal((await proposeStep.run(x.ctx, null)).kind, 'done');
    assert.equal((await validateStep.run(x.ctx, null)).kind, 'done');
    const validated = readValidate(x.ctx.paths);
    assert.ok(validated !== null && validated.ok);
    assert.equal(validated.value.verdict.ok, when !== 'before 11h', '11h never validates against a stale parent');
    if (when !== 'before 11h') rollback();
    assert.deepEqual(await replayStep.run(x.ctx, null), { kind: 'skip', reason: when === 'before 11h' ? 'verdict not ok' : 'no replay-class key' });
    const out = await outcomeStep.run(x.ctx, null);
    assert.ok(out.kind === 'done' && out.external.length === 0, JSON.stringify(out));
    const line = readOutcome(x.ctx.paths);
    assert.ok(line !== null && line.ok);
    assert.deepEqual([line.value.outcome, line.value.version, line.value.parent, line.value.errors], ['rejected_validate', 'v3', 'v2', ['parent v2 is no longer head (v1)']]);
    assert.ok(!existsSync(join(x.root, 'benchmark/v3.json')));
    const head = activeBenchmark(x.ctx, 'head');
    assert.ok(head.ok && head.value.version === 'v1');
  });
}

test('a rollback between 11h and 11j that holds the changed key: 11j re-reads the holds (pending_owner, not activate)', async () => {
  const x = cycleWorld(addExtra);
  logV2(x, () => ({ interface_checklist_extra: ['被退回的清单项'] }), 'pending_owner', 'owner', 'v1');
  assert.equal((await proposeStep.run(x.ctx, null)).kind, 'done');
  assert.equal((await validateStep.run(x.ctx, null)).kind, 'done');
  const validated = readValidate(x.ctx.paths);
  assert.ok(validated !== null && validated.ok);
  assert.deepEqual([validated.value.verdict.activation, validated.value.holds], ['auto', []]);
  x.clock.advance(60_000);
  x.sim.rollback('v1', 'v2');
  await replayStep.run(x.ctx, null);
  assert.equal((await outcomeStep.run(x.ctx, null)).kind, 'done');
  const line = readOutcome(x.ctx.paths);
  assert.ok(line !== null && line.ok);
  assert.deepEqual([line.value.outcome, line.value.version, line.value.parent, line.value.activation], ['pending_owner', 'v3', 'v1', 'owner']);
});
