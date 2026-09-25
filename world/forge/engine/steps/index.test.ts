import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { FakeReply } from '../adapters/fake.ts';
import { freezeCommand, roundCommand, type ForgeRoots } from '../cli-round.ts';
import { loadConfig } from '../config.ts';
import type { EngineDeps, RoundBackends, RunHooks } from '../context.ts';
import { readArray, readString } from '../json.ts';
import { sha256Bytes } from '../marker.ts';
import { probeMarker } from '../probe.ts';
import { LOCK_FILE, readStatus, STEP_IDS, verifyChain } from '../runner.ts';
import { unwrap } from '../tasks/fenced.ts';
import { FORECAST_COUNT, FORECAST_SLOTS } from '../tasks/forecast.ts';
import { fakePorts, type FakePorts } from '../testing/fakes.ts';
import { DEFAULT_FIXTURE, FIXTURE_GATEWAY_HOST, FIXTURE_WRITER_MODEL, fixtureWorld, type FixtureWorld } from '../testing/fixture-world.ts';
import { ownerSim, type OwnerSim } from '../testing/owner-sim.ts';
import { callLog, fakeRouter, type FakeRouter } from '../testing/scripted.ts';
import { ROUND_STEPS } from './index.ts';

/*
 * Cross-module fixture round (PR-A): the real ROUND_STEPS 00-start … 05a-gate-mech through `forge round
 * start|run|status` and `forge freeze --check`, on fixtureWorld with fake ports and scripted backends. The owner
 * approves the protocol and picks the topic through owner-sim; the run is killed inside 04-write (a throwing
 * afterCall hook, the in-process crash path) and resumed by a new "process" with zero repeated paid calls.
 */

const START_ISO = '2026-10-01T00:00:00.000Z';
const ROUND = 'R01';
const PID_KILLED = 4101;
const PID_RESUME = 4102;
const KILL_AFTER = 'write-W2';

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

function writerReply(slot: string): FakeReply {
  return writerText(`温芮在第三邻里的工具墙前停下，${slot} 号配给簿上多了一行字。她把扳手挂回去，去听循环泵的节拍。`);
}

function forecastReply(id: string): FakeReply {
  const items = FORECAST_SLOTS.slice(0, FORECAST_COUNT).map((slot, i) => ({ slot, value: `预测${id}第${i}项` }));
  return `\`\`\`json\n${JSON.stringify({ forecasts: items })}\n\`\`\``;
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
}

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), 'forge-pipeline-'));
  const w = fixtureWorld(dir, { ...DEFAULT_FIXTURE, champions: 'none', protocolApproved: false });
  const config = loadConfig(w.root, { requireLocal: true });
  if (!config.ok) throw new Error(config.error);
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: START_ISO, seed: 'pipeline-seed' });
  const routers: FakeRouter[] = [];
  const add = (r: FakeRouter): FakeRouter => {
    routers.push(r);
    return r;
  };
  const judges = config.value.judges.map((j) => ({ backend: add(fakeRouter({ forecast: () => forecastReply(j.id) }, { id: j.id, family: j.family, model: j.model })), concurrency: j.concurrency }));
  const gateway = add(fakeRouter({ forecast: () => forecastReply('gw') }, { id: 'gateway-deepseek-fixture', family: 'DeepSeek', model: FIXTURE_WRITER_MODEL }));
  const writers = ['W1', 'W2', 'W3'].map((slot) => ({
    slot,
    // W3's adapter error carries the gateway host: it must reach no file unredacted.
    backend: add(fakeRouter({ write: () => (slot === 'W3' ? { error: `gateway request failed: connect ECONNREFUSED https://${FIXTURE_GATEWAY_HOST}/v1` } : writerReply(slot)) }, { id: slot, family: 'DeepSeek', model: FIXTURE_WRITER_MODEL })),
  }));
  const idle = (id: string): FakeRouter => add(fakeRouter({}, { id, family: 'Anthropic', model: `idle-${id}` }));
  const backends: RoundBackends = {
    writers,
    baseline: add(fakeRouter({ baseline: (prompt) => baselineReply(prompt) }, { id: 'BASE', family: 'DeepSeek', model: FIXTURE_WRITER_MODEL })),
    decoy: idle('decoy'),
    defect: idle('defect'),
    judges,
    forecasters: [...judges.map((j) => j.backend), gateway],
    maintainer: idle('maintainer'),
    mergeEditor: idle('merge_editor'),
    calibGateway: new Map(),
  };
  return { dir, w, at: { root: w.root, repo: w.repo }, ports, sim: ownerSim(w.root, ports.clock), backends, routers, logs: [] };
}

function deps(x: World, pid: number, hooks: RunHooks = {}): EngineDeps {
  return { ports: x.ports, backends: () => x.backends, hooks, env: {}, pid, isAlive: (p) => p === pid, log: (line) => x.logs.push(line) };
}

/** Every paid call of both processes, `taskId#attempt`. */
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

test('ROUND_STEPS is the PR-A prefix of STEP_IDS (00-start … 05a-gate-mech)', () => {
  const ids = ROUND_STEPS.map((s) => s.id);
  assert.deepEqual(ids, STEP_IDS.slice(0, ids.length));
  assert.equal(ids[ids.length - 1], '05a-gate-mech');
});

test('a fixture round runs 00-start … 05a through the CLI, survives a kill inside 04-write and resumes with no repeated paid call', async () => {
  const x = world();
  const round = join(x.w.root, 'rounds', ROUND);
  const status = () => must(readStatus(x.w.root, ROUND));

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
  const offered = readArray(JSON.parse(readFileSync(join(round, 'topic-offer.json'), 'utf8')), 'top3')?.[0];
  const rowId = readString(offered, 'row_id');
  const layer = readString(offered, 'layer');
  assert.ok(rowId !== null && layer !== null);
  x.sim.pickTopic(ROUND, { row_id: rowId, layer });

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

  // A new process resumes: the dead lock is taken over, W2 is recovered from calls/ + .runs, nothing is called twice.
  assert.equal(await roundCommand(['run', ROUND], deps(x, PID_RESUME), x.at), 0, x.logs.join('\n'));
  const calls = allCalls(x);
  assert.equal(new Set(calls).size, calls.length, `a paid call was repeated: ${calls.join(', ')}`);
  assert.ok(beforeResume.includes(`${KILL_AFTER}#1`));
  const forecasters = x.backends.forecasters.map((b) => `forecast-${b.id}#1`);
  assert.deepEqual([...calls].sort(), ['baseline-BASE#1', ...forecasters, 'write-W1#1', 'write-W2#1', 'write-W3#1', 'write-W3#2'].sort());
  assert.equal(status().state, 'done');
  assert.deepEqual(status().done, ROUND_STEPS.map((s) => s.id));
  assert.equal(existsSync(join(x.w.root, LOCK_FILE)), false);
  assert.match(readFileSync(join(round, 'progress.jsonl'), 'utf8'), new RegExp(`lock taken over from pid ${PID_KILLED}`, 'u'));
  assert.deepEqual(verifyChain(x.w.root, `rounds/${ROUND}`, ROUND_STEPS.map((s) => s.id)), []);
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

  // W3's gateway error is void and redacted; the host appears in no engine-written file.
  const w3: unknown = JSON.parse(readFileSync(join(round, 'tasks', 'write-W3.json'), 'utf8'));
  assert.equal(readString(w3, 'status'), 'void');
  assert.match(readString(w3, 'error') ?? '', /\[redacted:gateway-host\]/u);
  const written = [...filesUnder(x.w.root, round), ...filesUnder(x.w.root, join(x.w.root, '.sealed'))];
  for (const rel of written) assert.equal(readFileSync(join(x.w.root, rel), 'utf8').includes(FIXTURE_GATEWAY_HOST), false, rel);

  // The engine wrote no owner-only file: owner-log.jsonl and topic.json are byte-identical to what owner-sim wrote.
  assert.ok(x.sim.expected().size >= 2);
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
