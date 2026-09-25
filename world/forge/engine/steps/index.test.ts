import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { FakeReply } from '../adapters/fake.ts';
import { freezeCommand, roundCommand, type ForgeRoots } from '../cli-round.ts';
import { loadConfig, type Family } from '../config.ts';
import type { EngineDeps, RoundBackends, RunHooks } from '../context.ts';
import { isRecord, readArray, readNumber, readRecord, readString } from '../json.ts';
import { sha256Bytes } from '../marker.ts';
import { probeMarker } from '../probe.ts';
import { LOCK_FILE, readStatus, STEP_IDS, verifyChain } from '../runner.ts';
import { loadSchema, validate } from '../schema.ts';
import { unwrap } from '../tasks/fenced.ts';
import { FORECAST_COUNT, FORECAST_SLOTS } from '../tasks/forecast.ts';
import { fakePorts, type FakePorts } from '../testing/fakes.ts';
import { DEFAULT_FIXTURE, FIXTURE_GATEWAY_HOST, FIXTURE_WRITER_MODEL, fixtureWorld, type FixtureWorld } from '../testing/fixture-world.ts';
import { ownerSim, type OwnerSim } from '../testing/owner-sim.ts';
import { callLog, fakeRouter, type FakeCallMeta, type FakeRouter, type Route } from '../testing/scripted.ts';
import { splitSentences } from '../text.ts';
import { ROUND_STEPS } from './index.ts';

/*
 * Cross-module fixture round (PR-A + PR-B): the real ROUND_STEPS 00-start … 09b-decision through `forge round
 * start|run|status` and `forge freeze --check`, on fixtureWorld with fake ports and backends scripted per role. The
 * owner approves the protocol, picks the topic, answers the audit and decides through owner-sim; the run is killed
 * inside 04-write and again inside 06b (throwing afterCall hooks, the in-process crash path) and each new "process"
 * resumes with zero repeated paid calls.
 */

const START_ISO = '2026-10-01T00:00:00.000Z';
const ROUND = 'R01';
const PID_KILLED = 4101;
const PID_RESUME = 4102;
const PID_TASTE_KILLED = 4103;
const PID_FINAL = 4104;
const KILL_AFTER = 'write-W2';
/** The 06b kill fires in the afterCall of this many-th taste call. */
const KILL_TASTE_AT = 5;

/** Every writer text carries it; the baseline (numbered canon sentences) never does: taste fakes prefer it. */
const WRITER_MARK = '配给簿上多了一行字';
/** W2's first version states it; honest gate judges flag it (a fact contradiction, not a mechanical word). */
const TRAP = '母星的回信当晚就到了';
/** The defect writer puts it into the copy's second sentence; honest judges flag it as well. */
const DEFECT_MARK = '星门';
/** The decoy writer's generic replacements; the taste fakes recognise the decoy by the first. */
const DECOY_GENERICS: readonly string[] = ['某样东西', '某个地方'];
/** This family prefers the decoy in every call of session s1 (and its rerun) of the W1 champion pair. */
const DECOY_LOVER: Family = 'Moonshot';
const NUMERAL: Readonly<Record<string, string>> = { W1: '一', W2: '二', W3: '三' };
/** A sealed forecast value (`预测<forecaster>第<i>项`): none may reach a tracked file, a GitHub body or a prompt before 07a. */
const SEALED_VALUE = /预测[^第\s]{1,40}第\d项/u;

function fence(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

function head(text: string): string {
  return [...text].slice(0, 12).join('');
}

function writerText(body: string): string {
  return ['```submission', body, '```', '```delta', '{"new_proper_nouns":[],"claims":[]}', '```', '```interface', '{"shots":[{},{},{}],"object":{"n":1},"hook":{"h":1}}', '```', '种子：', '- 一'].join('\n');
}

/** The first three numbered canon sentences of the baseline prompt, verbatim (the fake reads material only via unwrap). */
function baselineReply(prompt: string): FakeReply {
  const numbered = unwrap(prompt, '正典句');
  if (numbered === null) return { error: 'fake baseline: no 正典句 block in the prompt' };
  const sentences = numbered.split('\n').map((l) => l.replace(/^〔C\d{3}〕/u, '')).slice(0, 3);
  return writerText(sentences.join(''));
}

/** W2's first attempt holds the trap sentence; its blind resubmission `write-W2-r2` (same prompt) does not. */
function writerReply(slot: string, meta: FakeCallMeta): FakeReply {
  const trap = slot === 'W2' && meta.taskId === 'write-W2' ? `值班的老周说${TRAP}，大家可以放心地吃饭。` : '';
  return writerText(`温芮在第三邻里的工具墙前停下，${NUMERAL[slot] ?? slot}号${WRITER_MARK}。${trap}她把扳手挂回去，去听循环泵的节拍。`);
}

function forecastReply(id: string): FakeReply {
  const items = FORECAST_SLOTS.slice(0, FORECAST_COUNT).map((slot, i) => ({ slot, value: `预测${id}第${i}项` }));
  return fence({ forecasts: items });
}

/** Ids of `〔label〕` lines `D1｜…` / `W1.a｜…`. */
function idsOf(prompt: string, label: string): string[] {
  return (unwrap(prompt, label) ?? '').split('\n').map((l) => l.split('｜')[0] ?? '').filter((x) => x !== '');
}

/** Defect writer: swaps the first three characters of sentence 2 for the defect mark, against the first offered id. */
function defectReply(prompt: string): FakeReply {
  const original = ((unwrap(prompt, '正文') ?? '').split('\n')[1] ?? '').replace(/^〔S\d{3}〕/u, '');
  const against = idsOf(prompt, '条目')[0] ?? '';
  return fence({ sentence_no: 2, original, replacement: `${DEFECT_MARK}旁${[...original].slice(3).join('')}`, against });
}

/** A binding id of the pack: the first fact row that is not a path instance, else the first regression id. */
function bindingId(prompt: string): string {
  const row = (unwrap(prompt, '事实表') ?? '').split('\n').map((l) => l.split('｜')).find((c) => c.length >= 3 && c[1] !== '状态与路径实例');
  return row?.[0] ?? idsOf(prompt, '回归证据')[0] ?? '';
}

interface Script {
  /** The first family asked about a defect copy answers 无矛盾 on it (so it is voided and a reserve replaces it). */
  blind: Family | null;
  /** Taste questions of the pinned benchmark. */
  questions: readonly string[];
}

/** Honest gate judge: flags every sentence holding the trap or the defect mark; the blind family misses the copy. */
function gateRoute(script: Script, family: Family, copy: boolean): Route {
  return (prompt) => {
    if (copy && script.blind === null) script.blind = family;
    if (copy && script.blind === family) return fence({ contradiction: false, findings: [] });
    const against = bindingId(prompt);
    const hits = splitSentences(unwrap(prompt, '文本甲') ?? '').filter((s) => s.includes(TRAP) || s.includes(DEFECT_MARK));
    const findings = hits.map((quote) => ({ quote, against, reason: '与冻结事实矛盾' }));
    return fence({ contradiction: findings.length > 0, findings });
  };
}

/** The first four-character window of `sentence` that occurs exactly once in `text`. */
function uniqueWindow(text: string, sentence: string): string {
  const chars = [...sentence];
  for (let i = 0; i + 4 <= chars.length; i += 1) {
    const window = chars.slice(i, i + 4).join('');
    if (text.split(window).length === 2) return window;
  }
  return '';
}

/** Decoy writer: one unique four-character detail of each of the first two sentences becomes a generic phrase. */
function decoyReply(prompt: string): FakeReply {
  const text = unwrap(prompt, '文本甲') ?? '';
  const originals = splitSentences(text).slice(0, 2).map((s) => uniqueWindow(text, s));
  return fence({ replacements: originals.map((original, i) => ({ original, generic: DECOY_GENERICS[i] ?? '某处', kind: '其他' })) });
}

/** Taste judge: prefers the writer text on every question; avoids the decoy unless it is the decoy lover in W1 s1. */
function tasteRoute(script: Script, family: Family): Route {
  return (prompt, _n, meta) => {
    const t1 = unwrap(prompt, '文本甲') ?? '';
    const t2 = unwrap(prompt, '文本乙') ?? '';
    const pick = !t1.includes(WRITER_MARK) && t2.includes(WRITER_MARK) ? 2 : 1;
    const answers = Object.fromEntries(script.questions.map((q) => [q, { pick, quote: head(pick === 1 ? t1 : t2) }]));
    const t3 = unwrap(prompt, '文本丙');
    const t4 = unwrap(prompt, '文本丁');
    if (t3 === null || t4 === null) return fence({ answers });
    const decoyAt = t3.includes(DECOY_GENERICS[0] ?? '') ? 3 : 4;
    const lover = family === DECOY_LOVER && meta.taskId.startsWith(`taste-W1-${DECOY_LOVER}-s1`);
    const decoyPick = lover ? decoyAt : 7 - decoyAt;
    return fence({ answers, decoy: { pick: decoyPick, quote: head(decoyPick === 3 ? t3 : t4) } });
  };
}

function measureRoutes(): Record<string, Route> {
  return {
    recall: (prompt) => {
      const text = unwrap(prompt, '文本甲') ?? '';
      const sorted = (unwrap(prompt, '数列') ?? '').split('、').map(Number).sort((a, b) => a - b);
      return fence({ sorted, image: [...text].slice(3, 9).join(''), quote: head(text) });
    },
    skin: (prompt) => fence({ pick: '甲', quote: head(unwrap(prompt, '文本甲') ?? ''), reason: '邻里与配给簿' }),
    cold: (prompt) => {
      const quote = head(unwrap(prompt, '文本甲') ?? '');
      return fence({ where: { answer: '一艘船上的邻里', quote }, who: { name: '温芮', wants: '把工具还回去', cost: null, quote }, go: { answer: null, quote: null } });
    },
    producer: (prompt) => fence({ items: idsOf(prompt, '检查项').map((id) => ({ id, ok: true, missing: null })) }),
  };
}

function surpriseRoutes(): Record<string, Route> {
  return {
    match: (prompt) => fence({ matches: idsOf(prompt, '细节').map((detail) => ({ detail, forecast: null, relation: 'none' })) }),
    chain: (prompt) => {
      const offered = unwrap(prompt, '正典') ?? '';
      const file = /〔文件：([^〕]+)〕/u.exec(offered)?.[1] ?? '';
      const body = offered.split('\n').find((l) => l.trim() !== '' && !l.startsWith('〔文件：')) ?? '';
      return fence({ chains: idsOf(prompt, '细节').map((detail) => ({ detail, canon: { file, quote: head(body.trim()) }, steps: ['借用要登记，所以工具会被还回原处。'], lands_on: '扳手挂回工具墙' })) });
    },
    accept: (prompt) => fence({ verdicts: idsOf(prompt, '链').map((detail) => ({ detail, accept: true, reason: '登记推出归还' })) }),
  };
}

interface World {
  dir: string;
  w: FixtureWorld;
  at: ForgeRoots;
  ports: FakePorts;
  sim: OwnerSim;
  backends: RoundBackends;
  routers: FakeRouter[];
  logs: string[];
  script: Script;
}

function benchQuestions(root: string): string[] {
  const bench: unknown = JSON.parse(readFileSync(join(root, 'benchmark', 'v1.json'), 'utf8'));
  return (readArray(readRecord(bench, 'taste'), 'questions') ?? []).map((q) => readString(q, 'id') ?? '').filter((id) => id !== '');
}

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), 'forge-pipeline-'));
  const w = fixtureWorld(dir, { ...DEFAULT_FIXTURE, champions: 'none', protocolApproved: false });
  const config = loadConfig(w.root, { requireLocal: true });
  if (!config.ok) throw new Error(config.error);
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: START_ISO, seed: 'pipeline-seed' });
  const script: Script = { blind: null, questions: benchQuestions(w.root) };
  const routers: FakeRouter[] = [];
  const add = (r: FakeRouter): FakeRouter => {
    routers.push(r);
    return r;
  };
  const judges = config.value.judges.map((j) => ({
    backend: add(fakeRouter({
      forecast: () => forecastReply(j.id),
      gate: gateRoute(script, j.family, false),
      gatecopy: gateRoute(script, j.family, true),
      taste: tasteRoute(script, j.family),
      ...measureRoutes(),
      ...surpriseRoutes(),
    }, { id: j.id, family: j.family, model: j.model })),
    concurrency: j.concurrency,
  }));
  const gateway = add(fakeRouter({ forecast: () => forecastReply('gw') }, { id: 'gateway-deepseek-fixture', family: 'DeepSeek', model: FIXTURE_WRITER_MODEL }));
  const writers = ['W1', 'W2', 'W3'].map((slot) => ({
    slot,
    // W3's first attempt fails with an adapter error carrying the gateway host (it must reach no file unredacted); the retry answers.
    backend: add(fakeRouter({ write: (_p, _n, meta) => (slot === 'W3' && meta.attempt === 1 ? { error: `gateway request failed: connect ECONNREFUSED https://${FIXTURE_GATEWAY_HOST}/v1` } : writerReply(slot, meta)) }, { id: slot, family: 'DeepSeek', model: FIXTURE_WRITER_MODEL })),
  }));
  const idle = (id: string): FakeRouter => add(fakeRouter({}, { id, family: 'Anthropic', model: `idle-${id}` }));
  const backends: RoundBackends = {
    writers,
    baseline: add(fakeRouter({ baseline: (prompt) => baselineReply(prompt) }, { id: 'BASE', family: 'DeepSeek', model: FIXTURE_WRITER_MODEL })),
    // Gateway models (family DeepSeek, like the writers): no taste family is excluded as a decoy author.
    decoy: add(fakeRouter({ decoy: (prompt) => decoyReply(prompt) }, { id: 'decoy', family: 'DeepSeek', model: FIXTURE_WRITER_MODEL })),
    defect: add(fakeRouter({ defect: (prompt) => defectReply(prompt) }, { id: 'defect', family: 'DeepSeek', model: FIXTURE_WRITER_MODEL })),
    judges,
    forecasters: [...judges.map((j) => j.backend), gateway],
    maintainer: idle('maintainer'),
    mergeEditor: idle('merge_editor'),
    calibGateway: new Map(),
  };
  return { dir, w, at: { root: w.root, repo: w.repo }, ports, sim: ownerSim(w.root, ports.clock), backends, routers, logs: [], script };
}

/**
 * Every paid call starts one fake second later (beforeCall), so writer, defect and decoy calls start strictly after
 * the probe was mirrored, as on a real clock (07a's ordering check refuses a call stamped at the mirror instant).
 */
function deps(x: World, pid: number, hooks: RunHooks = {}): EngineDeps {
  const tick: RunHooks = { ...hooks, beforeCall: () => x.ports.clock.advance(1000) };
  return { ports: x.ports, backends: () => x.backends, hooks: tick, env: {}, pid, isAlive: (p) => p === pid, log: (line) => x.logs.push(line) };
}

/** Every paid call of every process, `taskId#attempt`. */
function allCalls(x: World): string[] {
  return x.routers.flatMap((r) => callLog(r));
}

function must<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

/** Forge-root-relative paths of every file under `dir` (recursive). */
function filesUnder(root: string, dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(root, path));
    else out.push(relative(root, path).split(sep).join('/'));
  }
  return out;
}

function readObject(path: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(raw)) throw new Error(`${path}: not a JSON object`);
  return raw;
}

/** Schema errors of `value` against schema/<name>.schema.json (an entry under `properties` when `entry` is set). */
function schemaErrors(root: string, name: string, value: unknown, entry: string | null = null): string[] {
  const raw: unknown = JSON.parse(readFileSync(join(root, 'schema', `${name}.schema.json`), 'utf8'));
  const picked = entry === null ? raw : readRecord(readRecord(raw, 'properties'), entry);
  const schema = loadSchema(picked);
  if (!schema.ok) throw new Error(`${name}: ${schema.error}`);
  return validate(schema.value, value);
}

function pickTopic(x: World, round: string): void {
  const offered = readArray(JSON.parse(readFileSync(join(round, 'topic-offer.json'), 'utf8')), 'top3')?.[0];
  const rowId = readString(offered, 'row_id');
  const layer = readString(offered, 'layer');
  assert.ok(rowId !== null && layer !== null);
  x.sim.pickTopic(ROUND, { row_id: rowId, layer });
}

test('ROUND_STEPS is a prefix of STEP_IDS ending at 09b-decision (PR-A 00-start … 05a, PR-B 05b … 09b)', () => {
  const ids = ROUND_STEPS.map((s) => s.id);
  assert.deepEqual(ids, STEP_IDS.slice(0, ids.length));
  assert.equal(ids[ids.indexOf('05a-gate-mech') + 1], '05b-defect');
  assert.equal(ids[ids.length - 1], '09b-decision');
});

test('a fixture round runs 00-start … 09b-decision through the CLI: kills inside 04-write and 06b resume with no repeated paid call; owner waits at 09a and 09b', async () => {
  const x = world();
  const round = join(x.w.root, 'rounds', ROUND);
  const status = () => must(readStatus(x.w.root, ROUND));
  const ids = ROUND_STEPS.map((s) => s.id);
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

  // owner-sim decides → 09b done: the build's pipeline ends there (exit 0, state done).
  const labels = readObject(join(round, 'labels.json'));
  const pick = Object.keys(labels).sort()[0] ?? '';
  assert.notEqual(pick, '');
  x.sim.decide(ROUND, { pick, reason: '平', fav: pick, publish: 'no', facts: [] });
  assert.equal(await roundCommand(['run', ROUND], deps(x, PID_FINAL), x.at), 0, x.logs.join('\n'));
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

  // Git and GitHub: PR-B steps commit nothing and post nothing (merge and mirrors come later).
  assert.equal(x.ports.git.commits('forge/r01').length, 1);
  assert.equal(x.ports.github.comments().length, 1);

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
