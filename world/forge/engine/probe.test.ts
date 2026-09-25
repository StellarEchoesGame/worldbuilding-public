import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { FakeReply } from './adapters/fake.ts';
import { loadConfig, type ForgeConfig } from './config.ts';
import { buildContext, type ContextInput, type RoundBackends, type StepContext } from './context.ts';
import { buildFreeze, parseFreeze, type FreezeFlag } from './freeze.ts';
import { sha256Bytes } from './marker.ts';
import { readMirrorLog } from './mirror-log.ts';
import {
  buildSealed, clockSkewed, matchProbeComment, parseProbeRecord, parseSealedForecasts, probeCommentBody, probeFiles, probeMirror,
  PROBE_ATTEMPTS, PROBE_DELAYS_MS, readProbeFile, unseal, type ForecasterResult,
} from './probe.ts';
import { runSteps, stepsSha256, verifyChain, type RunReport, type StepDef, type StepId } from './runner.ts';
import { canonicalJson, verifySeal } from './seal.ts';
import type { BriefJson } from './steps/brief.ts';
import { forecasterPool, forecastStep } from './steps/forecast.ts';
import { probeMirrorStep } from './steps/probe-mirror.ts';
import { sealStep } from './steps/seal.ts';
import { writerTask } from './tasks/writing.ts';
import { parseBrief } from './steps/brief.ts';
import { roundPaths, sha256 } from './store.ts';
import type { GitHubComment } from './ports.ts';
import { IntegrityError } from './task.ts';
import { fakePorts, type FakePorts } from './testing/fakes.ts';
import { DEFAULT_FIXTURE, FIXTURE_AT, FIXTURE_GATEWAY_HOST, FIXTURE_WRITER_MODEL, fixtureWorld, type FixtureWorld } from './testing/fixture-world.ts';
import { callLog, fakeRouter, type FakeRouter } from './testing/scripted.ts';

const START_ISO = '2026-10-01T00:00:00.000Z';
const ROUND = 'R01';
const BRANCH = 'forge/r01';
const ISSUE = 12;
const SEED = 'e'.repeat(64);
const FLAGS: Record<string, FreezeFlag> = { OpenAI: 'suspended', Anthropic: 'ok', Moonshot: 'ok', xAI: 'flagged' };

interface Harness {
  w: FixtureWorld;
  config: ForgeConfig;
  ports: FakePorts;
  routers: Map<string, FakeRouter>;
  writer: FakeRouter;
  ctx: StepContext;
  logs: string[];
  brief: BriefJson;
  toyWrites: { n: number };
}

/** A distinctive, recognizable sealed value (never allowed outside .sealed/ and .runs/). */
function sealedValue(id: string, i: number): string {
  return `封存预测${id}号${i}件铝饭盒`;
}

function forecastReply(id: string): string {
  const slots = ['主角', '愿望', '代价', '物件', '习俗', '声音', '气味', '结局'];
  return `\`\`\`json\n${JSON.stringify({ forecasts: slots.map((slot, i) => ({ slot, value: sealedValue(id, i) })) })}\n\`\`\``;
}

function brief(): BriefJson {
  return {
    round: ROUND, kind: 'round', row_id: 'SHIP', layer: '日常', topic_source: 'fixed',
    cell: {
      id: 'ship-neighbourhood', row_id: 'SHIP', title: '第三邻里的夜班', entity: '远航号第三邻里', time: '跃迁后第三年',
      layers: ['日常'], setting_notes: ['循环泵的节拍决定作息'], protagonists: ['温芮', '林澈'], forbidden: ['不写星门'],
      stances: [{ id: 'daily', text: '住民的一天' }],
    },
    canon: { revision: '8.1', book_sha256: 'a'.repeat(64), reference_sha256: 'b'.repeat(64) },
    canon_passages: [{ file: 'reference/05-ecology-and-everyday.md', text: '温芮在远航号的第三邻里长大，她记得每一台循环泵的节拍。' }],
    facts: [{ id: 'F01', kind: 'fact', text: '没有星门。', status: '共同事实', rows: ['SHIP'] }],
    regression: [], regression_stale: [], forbidden: ['不写星门'], cliches: ['仿佛'],
    requirements: ['一个具名主角'], interface_requirements: ['一件可交互的物件'], aliases: ['远航号'],
    seed: SEED, created_at: START_ISO,
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function harness(opts: { env?: Record<string, string>; voidIds?: readonly string[]; briefText?: string } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'forge-probe-'));
  const w = fixtureWorld(dir, DEFAULT_FIXTURE);
  const loaded = loadConfig(w.root, { requireLocal: true });
  if (!loaded.ok) throw new Error(loaded.error);
  const config = loaded.value;
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: START_ISO, seed: 'probe-seed' });
  const baseSha = await ports.git.resolveRef('main');
  assert.ok(baseSha.ok);
  assert.ok((await ports.git.createBranch(BRANCH, 'main')).ok);
  assert.ok((await ports.git.checkout(BRANCH)).ok);
  const voidIds = opts.voidIds ?? [];
  const routers = new Map<string, FakeRouter>();
  const router = (id: string, family: FakeRouter['family'], model: string): FakeRouter => {
    const reply = (): FakeReply => (voidIds.includes(id) ? { error: 'fake forecaster down' } : forecastReply(id));
    const r = fakeRouter({ forecast: reply }, { id, family, model });
    routers.set(id, r);
    return r;
  };
  const judges = config.judges.map((j) => ({ backend: router(j.id, j.family, j.model), concurrency: j.concurrency }));
  const gateway = router('gw-deepseek', 'DeepSeek', FIXTURE_WRITER_MODEL);
  const writer = fakeRouter({}, { id: 'W1', family: 'DeepSeek', model: FIXTURE_WRITER_MODEL });
  const plain = (id: string): FakeRouter => fakeRouter({}, { id, family: 'DeepSeek', model: FIXTURE_WRITER_MODEL });
  const backends: RoundBackends = {
    writers: [{ slot: 'W1', backend: writer }], baseline: plain('BASE'), decoy: plain('decoy'), defect: plain('defect'), judges,
    forecasters: [...judges.map((j) => j.backend), gateway, gateway], maintainer: fakeRouter({}, { id: 'maintainer', family: 'Anthropic', model: 'fable' }),
    mergeEditor: fakeRouter({}, { id: 'merge_editor', family: 'Anthropic', model: 'opus' }), calibGateway: new Map(),
  };
  const logs: string[] = [];
  const input: ContextInput = {
    root: w.root, repo: w.repo, roundId: ROUND, pipeline: 'round', paths: roundPaths(w.root, ROUND), config,
    deps: { ports, backends: () => backends, env: opts.env ?? {}, pid: 1001, isAlive: (pid) => pid === 1001, log: (l) => logs.push(l) },
    startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
  };
  const built = buildContext(input);
  if (!built.ok) throw new Error(built.error);
  const ctx = built.value;
  const p = ctx.paths;
  mkdirSync(p.dir, { recursive: true });
  writeFileSync(p.start, json({
    round: ROUND, seed: SEED, branch: BRANCH, base_sha: baseSha.value, issue: { number: ISSUE, url: `https://github.invalid/fake/issues/${ISSUE}` },
    bundle_sha256: ctx.bundleSha256, doctor_sha256: sha256('doctor'), started_at: START_ISO, cell: 'cells/ship.json',
  }));
  writeFileSync(p.topic, json({ round: ROUND, row_id: 'SHIP', layer: '日常', cell: 'cells/ship.json', source: 'fixed', chosen_at: START_ISO }));
  writeFileSync(p.brief, opts.briefText ?? json(brief()));
  return { w, config, ports, routers, writer, ctx, logs, brief: brief(), toyWrites: { n: 0 } };
}

const PIPE: readonly StepId[] = ['02c-freeze', '03a-forecast', '03b-seal', '03c-probe-mirror', '04-write'];

/** Stands in for S1's 02c: writes freeze.json (probe_created_at null) and lists it, so 03c's amendment is chain-checked. */
const toyFreeze: StepDef = {
  id: '02c-freeze',
  run: async (ctx) => {
    const bench = readFileSync(join(ctx.root, 'benchmark', 'v1.json'));
    const record = buildFreeze({
      round: ROUND, files: { 'brief.json': readFileSync(ctx.paths.brief, 'utf8') }, benchmarkVersion: 'v1',
      eligibleFamilies: ['Anthropic', 'Moonshot'], flags: FLAGS, protocolBundleSha256: ctx.bundleSha256, probeCreatedAt: null, seed: SEED,
      stepsSha256: stepsSha256(PIPE),
      benchmarkResolution: { version: 'v1', sha256: sha256Bytes(bench), path: 'benchmark/v1.json', via: 'activate', since: FIXTURE_AT },
      gateFamilies: ['Anthropic', 'Moonshot'], trustStatusSha256: null, skills: {},
    });
    return { kind: 'done', inputs: [ctx.files.rel(ctx.paths.brief)], outputs: [ctx.files.writeJson(ctx.paths.freeze, record)], external: [] };
  },
};

/** Stands in for 04: counts how often the runner reached it (it must never run while 03c is blocked). */
function toyWrite(h: Harness): StepDef {
  return {
    id: '04-write',
    run: async () => {
      h.toyWrites.n += 1;
      return { kind: 'done', inputs: [], outputs: [], external: [] };
    },
  };
}

function run(h: Harness, opts: { pid?: number; until?: StepId; redoFrom?: StepId } = {}): Promise<RunReport> {
  const pid = opts.pid ?? 1001;
  const steps = [toyFreeze, forecastStep, sealStep, probeMirrorStep, toyWrite(h)];
  assert.deepEqual(steps.map((s) => s.id), PIPE);
  return runSteps(h.ctx, { pipeline: 'round', steps, until: opts.until ?? null, from: null, redoFrom: opts.redoFrom ?? null, pid, isAlive: (p) => p === pid });
}

function freezeProbeTime(h: Harness): string | null {
  const parsed = parseFreeze(JSON.parse(readFileSync(h.ctx.paths.freeze, 'utf8')));
  assert.ok(parsed.ok);
  return parsed.value.probe_created_at;
}

function readJsonFile(path: string): unknown {
  const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return v;
}

/** Every file under `dir` (recursive), skipping directories with the given names at any depth. */
function walk(dir: string, skip: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && skip.includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path, skip));
    else out.push(path);
  }
  return out;
}

const FORECASTERS = ['claude', 'grok', 'gw-deepseek', 'kimi'];

function allSealedValues(): string[] {
  return [...FORECASTERS, 'codex'].flatMap((id) => Array.from({ length: 8 }, (_, i) => sealedValue(id, i)));
}

test('buildSealed drops void forecasters and sorts by forecaster; probeCommentBody is English with hex and ids only', () => {
  const r = (forecaster: string, status: 'ok' | 'void'): ForecasterResult => ({
    forecaster, family: 'Moonshot', model: 'm', writerModel: forecaster === 'gw', status, items: status === 'ok' ? [{ slot: '物件', value: `${forecaster}的饭盒` }] : [],
  });
  const sealed = buildSealed(ROUND, 'SHIP', 'c'.repeat(64), [r('kimi', 'ok'), r('claude', 'void'), r('gw', 'ok')]);
  assert.deepEqual(sealed.forecasts.map((f) => [f.forecaster, f.writer_model]), [['gw', true], ['kimi', false]]);
  assert.ok(parseSealedForecasts(JSON.parse(canonicalJson(sealed))).ok);
  const body = probeCommentBody(ROUND, 'f'.repeat(64), 'a'.repeat(40));
  assert.ok(body.startsWith('<!-- forge:probe R01 -->\n'));
  assert.ok(body.includes('f'.repeat(64)) && body.includes('a'.repeat(40)));
  assert.match(body.replace('‖', '|').replace('·', '.'), /^[\x20-\x7e\n]+$/u);
});

test('matchProbeComment: same probe → reuse the earliest, any other probe comment → other, quotes elsewhere ignored', () => {
  const c = (id: number, body: string, authorAssociation = 'OWNER'): GitHubComment => ({ id, url: `u${id}`, createdAt: START_ISO, body, authorAssociation });
  const mine = probeCommentBody(ROUND, 'f'.repeat(64), 'a'.repeat(40));
  assert.deepEqual(matchProbeComment([], ROUND, 'f'.repeat(64)), { kind: 'none' });
  assert.deepEqual(matchProbeComment([c(1, `> ${mine}`), c(2, 'hi')], ROUND, 'f'.repeat(64)), { kind: 'none' });
  const same = matchProbeComment([c(1, mine), c(2, mine)], ROUND, 'f'.repeat(64));
  assert.equal(same.kind === 'same' ? same.comment.id : 0, 1);
  const other = matchProbeComment([c(1, mine), c(2, probeCommentBody(ROUND, 'e'.repeat(64), 'a'.repeat(40)))], ROUND, 'f'.repeat(64));
  assert.equal(other.kind, 'other');
  assert.equal(matchProbeComment([c(3, '<!-- forge:probe R01 -->\nno probe here')], ROUND, 'f'.repeat(64)).kind, 'other');
  assert.equal(matchProbeComment([c(1, probeCommentBody('R02', 'e'.repeat(64), 'a'.repeat(40)))], ROUND, 'f'.repeat(64)).kind, 'none');
  // The repository is public: a marked comment by an untrusted author is neither a conflict nor a reusable probe.
  const outsider = probeCommentBody(ROUND, 'e'.repeat(64), 'a'.repeat(40));
  assert.deepEqual(matchProbeComment([c(1, outsider, 'NONE'), c(2, mine, 'CONTRIBUTOR')], ROUND, 'f'.repeat(64)), { kind: 'none' });
  const trusted = matchProbeComment([c(1, mine, 'NONE'), c(2, mine, 'MEMBER')], ROUND, 'f'.repeat(64));
  assert.equal(trusted.kind === 'same' ? trusted.comment.id : 0, 2);
  // Earliest by created_at, whatever order the port lists them in.
  const later = { ...c(1, mine), createdAt: '2026-09-25T12:00:00.000Z' };
  const earlier = { ...c(2, mine), createdAt: '2026-09-25T11:00:00.000Z' };
  const first = matchProbeComment([later, earlier], ROUND, 'f'.repeat(64));
  assert.equal(first.kind === 'same' ? first.comment.id : 0, 2);
  // A comment carrying a probe this round superseded by --redo-from is neither foreign nor reusable.
  const old = probeCommentBody(ROUND, 'e'.repeat(64), 'a'.repeat(40));
  assert.deepEqual(matchProbeComment([c(1, old)], ROUND, 'f'.repeat(64), (probe) => probe === 'e'.repeat(64)), { kind: 'none' });
  const after = matchProbeComment([c(1, old), c(2, mine)], ROUND, 'f'.repeat(64), (probe) => probe === 'e'.repeat(64));
  assert.equal(after.kind === 'same' ? after.comment.id : 0, 2);
});

test('parseProbeRecord validates every field; clockSkewed flags more than 5 minutes', () => {
  const good = { probe: 'f'.repeat(64), branch: BRANCH, commit: 'a'.repeat(40), issue: ISSUE, comment_id: 3, comment_url: 'u', created_at: START_ISO, mirrored_at: START_ISO, attempts: 1 };
  assert.ok(parseProbeRecord(good).ok);
  for (const bad of [{ ...good, probe: 'F'.repeat(64) }, { ...good, commit: 'xyz' }, { ...good, issue: 0 }, { ...good, attempts: PROBE_ATTEMPTS + 1 }, { ...good, created_at: 'now' }, { ...good, branch: '' }]) {
    assert.equal(parseProbeRecord(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(clockSkewed({ created_at: START_ISO, mirrored_at: '2026-10-01T00:05:00.000Z' }), false);
  assert.equal(clockSkewed({ created_at: START_ISO, mirrored_at: '2026-10-01T00:05:00.001Z' }), true);
});

test('03a–03c: sealed forecasts, a canonical seal, one commit, one push, one comment; freeze.json amended; resume is clean', async () => {
  const h = await harness();
  const r = await run(h);
  assert.equal(r.exitCode, 0, r.detail);
  assert.deepEqual(h.routers.get('codex')?.log() ?? [], [], 'a suspended judge family does not forecast');
  for (const id of FORECASTERS) assert.deepEqual(callLog(h.routers.get(id) ?? h.writer), [`forecast-${id}#1`]);
  const f = probeFiles(h.ctx.paths);
  const sealedText = readFileSync(f.sealed, 'utf8');
  const nonceHex = readFileSync(f.nonce, 'utf8').trim();
  const probe = readProbeFile(h.ctx.paths);
  assert.ok(probe.ok);
  assert.equal(canonicalJson(readJsonFile(f.sealed)), sealedText);
  assert.ok(verifySeal(sealedText, nonceHex, probe.value));
  const sealed = parseSealedForecasts(readJsonFile(f.sealed));
  assert.ok(sealed.ok);
  assert.equal(sealed.value.brief_sha256, sha256Bytes(readFileSync(h.ctx.paths.brief)));
  assert.deepEqual(sealed.value.forecasts.map((x) => [x.forecaster, x.writer_model, x.items.length]), [['claude', false, 8], ['grok', false, 8], ['gw-deepseek', true, 8], ['kimi', false, 8]]);
  const meta = readJsonFile(f.meta);
  assert.deepEqual(meta, {
    round: ROUND, probe: probe.value,
    forecasters: sealed.value.forecasts.map((x) => ({ forecaster: x.forecaster, family: x.family, model: x.model, writer_model: x.writer_model, status: 'ok' })),
  });
  const record = parseProbeRecord(readJsonFile(f.probe));
  assert.ok(record.ok);
  const comments = h.ports.github.comments(ISSUE);
  assert.equal(comments.length, 1);
  assert.equal(comments[0]?.body, probeCommentBody(ROUND, probe.value, record.value.commit));
  assert.equal(record.value.created_at, comments[0]?.createdAt);
  assert.equal(freezeProbeTime(h), record.value.created_at);
  assert.equal(record.value.attempts, 1);
  const commits = h.ports.git.commits(BRANCH);
  assert.equal(commits.length, 1);
  assert.equal(commits[0]?.message, `chore: seal forecasts for ${ROUND} (#${ISSUE})`);
  assert.deepEqual(commits[0]?.paths, ['brief.json', 'freeze.json', 'probes.sha256', 'start.json', 'topic.json'].map((n) => `world/forge/rounds/${ROUND}/${n}`));
  assert.equal(record.value.commit, commits[0]?.sha);
  assert.deepEqual(h.ports.git.pushes(), [BRANCH]);
  const log = readMirrorLog(h.w.root, ROUND);
  assert.ok(log.ok);
  assert.deepEqual(log.value.map((e) => [e.kind, e.status, e.created_at]), [['probe', 'posted', record.value.created_at]]);
  const m03a = readJsonFile(join(h.ctx.paths.markers, '03a-forecast.json'));
  assert.deepEqual(m03a !== null && typeof m03a === 'object' && 'tasks' in m03a ? m03a.tasks : null, { ok: 4, void: 0, calls: 4 });
  const m03b = readFileSync(join(h.ctx.paths.markers, '03b-seal.json'), 'utf8');
  assert.ok(m03b.includes(`".sealed/${ROUND}/sealed.json": "${probe.value}"`), 'sealed.json listed under local with its salted hash (= the probe)');
  assert.equal(h.toyWrites.n, 1);
  const again = await run(h);
  assert.equal(again.exitCode, 0, again.detail);
  assert.deepEqual(verifyChain(h.w.root, h.ctx.paths.dir, PIPE), []);
  assert.equal(h.ports.github.comments().length, 1);
  assert.equal([...h.routers.values()].reduce((n, x) => n + x.log().length, 0), 4, 'no repeated forecaster call');
});

test('createComment failing PROBE_ATTEMPTS times → blocked (exit 4, probe_mirror:comment), no writer; heal + rerun → one comment, same probe', async () => {
  const h = await harness();
  h.ports.github.failNext('createComment', PROBE_ATTEMPTS);
  const r = await run(h);
  assert.equal(r.exitCode, 4);
  assert.equal(r.state, 'blocked');
  assert.equal(r.step, '03c-probe-mirror');
  assert.equal(r.detail, 'probe_mirror:comment');
  assert.deepEqual(h.ports.clock.slept(), [...PROBE_DELAYS_MS]);
  assert.equal(h.ports.github.calls().filter((c) => c.op === 'createComment').length, PROBE_ATTEMPTS);
  assert.equal(h.toyWrites.n, 0);
  assert.deepEqual(h.writer.log(), []);
  assert.equal(freezeProbeTime(h), null);
  assert.equal(existsSync(probeFiles(h.ctx.paths).probe), false);
  assert.equal(h.ports.github.comments().length, 0);
  const failed = readMirrorLog(h.w.root, ROUND);
  assert.ok(failed.ok);
  assert.deepEqual(failed.value.map((e) => e.status), ['failed']);
  const status = readJsonFile(h.ctx.paths.status);
  assert.deepEqual(status !== null && typeof status === 'object' && 'exit_code' in status ? status.exit_code : null, 4);
  const first = readProbeFile(h.ctx.paths);
  assert.ok(first.ok);

  const healed = await run(h);
  assert.equal(healed.exitCode, 0, healed.detail);
  const comments = h.ports.github.comments(ISSUE);
  assert.equal(comments.length, 1);
  assert.equal(freezeProbeTime(h), comments[0]?.createdAt);
  assert.deepEqual(readProbeFile(h.ctx.paths), first);
  assert.equal(h.ports.git.commits(BRANCH).length, 1, 'HEAD already carried the 03c set: no second commit');
  assert.deepEqual(h.ports.git.pushes(), [BRANCH, BRANCH]);
  assert.equal(h.toyWrites.n, 1);
});

test('push failing every try → blocked probe_mirror:push; a crash after the post → the rerun reuses the comment', async () => {
  const h = await harness();
  assert.equal((await run(h, { until: '03b-seal' })).exitCode, 0);
  h.ports.git.failNext('push', PROBE_ATTEMPTS);
  const blocked = await probeMirror(h.ctx);
  assert.deepEqual(blocked.status === 'blocked' ? blocked.stage : blocked.status, 'push');
  assert.equal(h.ports.github.calls().length, 0);

  const original = h.ports.github.createComment;
  h.ports.github.createComment = async (issue, body) => {
    await original(issue, body);
    throw new Error('killed after the post');
  };
  await assert.rejects(probeMirror(h.ctx), /killed after the post/u);
  h.ports.github.createComment = original;
  assert.equal(h.ports.github.comments().length, 1);
  assert.equal(existsSync(probeFiles(h.ctx.paths).probe), false);
  const reused = await probeMirror(h.ctx);
  assert.equal(reused.status, 'mirrored');
  assert.equal(h.ports.github.comments().length, 1);
  if (reused.status === 'mirrored') {
    assert.equal(reused.record.comment_id, h.ports.github.comments()[0]?.id);
    assert.equal(freezeProbeTime(h), reused.record.created_at);
  }
  const twice = await probeMirror(h.ctx);
  assert.deepEqual(twice, reused, 'an existing probe.json is reused without any network call');
  const log = readMirrorLog(h.w.root, ROUND);
  assert.ok(log.ok);
  assert.equal(log.value.filter((e) => e.status === 'posted').length, 1);
});

test('a foreign probe comment for the round → integrity (exit 3); nothing is posted and 04 never runs', async () => {
  const h = await harness();
  h.ports.github.inject(ISSUE, probeCommentBody(ROUND, 'f'.repeat(64), 'a'.repeat(40)));
  const r = await run(h);
  assert.equal(r.exitCode, 3);
  assert.equal(r.state, 'integrity');
  assert.match(r.detail, /^probe_mirror:conflict: /u);
  assert.equal(h.ports.github.comments().length, 1);
  assert.equal(h.toyWrites.n, 0);
  assert.equal(freezeProbeTime(h), null);
  // Anyone can comment on the public repository: an outsider's marked comment is ignored, the engine posts its own.
  const open = await harness();
  open.ports.github.inject(ISSUE, probeCommentBody(ROUND, 'f'.repeat(64), 'a'.repeat(40)), 'NONE');
  const r2 = await run(open);
  assert.equal(r2.exitCode, 0, r2.detail);
  assert.equal(open.ports.github.comments(ISSUE).length, 2);
  assert.notEqual(freezeProbeTime(open), null);
});

test('public-content scan: a denylisted body, or committed bytes holding the gateway host, block before any GitHub call', async () => {
  const deny = await harness({ env: { PUBLIC_CHECK_DENYLIST: 'forge:probe' } });
  const r1 = await run(deny);
  assert.equal(r1.exitCode, 4);
  assert.equal(r1.detail, 'probe_mirror:scan');
  assert.deepEqual(deny.ports.github.calls(), []);
  assert.equal(deny.ports.git.calls().some((c) => c.op === 'commit' || c.op === 'push'), false);
  const rejected = readMirrorLog(deny.w.root, ROUND);
  assert.ok(rejected.ok);
  assert.deepEqual(rejected.value.map((e) => e.status), ['rejected_scan']);

  const hostBrief = json({ ...brief(), cliches: [`${FIXTURE_GATEWAY_HOST} 仿佛`] });
  const host = await harness({ briefText: hostBrief });
  const r2 = await run(host);
  assert.equal(r2.exitCode, 4);
  assert.equal(r2.detail, 'probe_mirror:scan');
  assert.deepEqual(host.ports.github.calls(), []);
  assert.deepEqual(host.ports.git.commits(BRANCH), []);
  assert.deepEqual(host.ports.git.pushes(), []);
  for (const file of [host.ctx.paths.status, host.ctx.paths.progress]) assert.ok(!readFileSync(file, 'utf8').includes(FIXTURE_GATEWAY_HOST), file);
});

test('no sealed forecast value reaches a tracked file, the round branch, a GitHub body or a writer prompt', async () => {
  const h = await harness();
  assert.equal((await run(h)).exitCode, 0);
  const values = allSealedValues();
  const sealedText = readFileSync(probeFiles(h.ctx.paths).sealed, 'utf8');
  assert.ok(values.filter((v) => !v.includes('codex')).every((v) => sealedText.includes(v)), 'the seal holds every answered value');
  const leaks: string[] = [];
  for (const file of walk(h.w.repo, ['.sealed', '.runs'])) {
    const text = readFileSync(file, 'utf8');
    for (const v of values) if (text.includes(v)) leaks.push(`${relative(h.w.repo, file)}: ${v}`);
  }
  for (const [path, text] of Object.entries(h.ports.git.tree(BRANCH))) for (const v of values) if (text.includes(v)) leaks.push(`branch ${path}`);
  for (const c of h.ports.github.comments()) for (const v of values) if (c.body.includes(v)) leaks.push(`comment ${c.id}`);
  const parsed = parseBrief(readJsonFile(h.ctx.paths.brief));
  assert.ok(parsed.ok);
  for (const stance of ['resident-day', 'object-history', 'outsider-first-visit', 'counter-consequence']) {
    const prompt = writerTask(parsed.value, 'W1', stance, null).prompt;
    for (const v of values) if (prompt.includes(v)) leaks.push(`writer prompt ${stance}`);
  }
  assert.deepEqual(leaks, []);
  assert.ok(statSync(join(h.w.root, '.sealed', ROUND, 'tasks')).isDirectory());
  assert.equal(existsSync(join(h.ctx.paths.dir, 'tasks')), false, 'sealed tasks never write under rounds/');
  assert.equal(existsSync(join(h.ctx.paths.dir, 'calls')), false);
});

test('03b never reseals: a rerun reuses the nonce and records; a published probe refuses a reseal', async () => {
  const h = await harness();
  assert.equal((await run(h, { until: '03b-seal' })).exitCode, 0);
  const f = probeFiles(h.ctx.paths);
  const before = [f.sealed, f.nonce, f.probes, f.meta].map((p) => readFileSync(p, 'utf8'));
  const calls = [...h.routers.values()].reduce((n, x) => n + x.log().length, 0);
  const again = await sealStep.run(h.ctx, null);
  assert.equal(again.kind, 'done');
  assert.deepEqual([f.sealed, f.nonce, f.probes, f.meta].map((p) => readFileSync(p, 'utf8')), before);
  assert.equal([...h.routers.values()].reduce((n, x) => n + x.log().length, 0), calls);
  writeFileSync(f.probe, '{}\n');
  await assert.rejects(sealStep.run(h.ctx, null), IntegrityError);
});

test('03b reseals after a --redo-from before 03c while probe.json is absent (fresh nonce); an unexplained other probe is integrity', async () => {
  const h = await harness();
  assert.equal((await run(h, { until: '03b-seal' })).exitCode, 0);
  const f = probeFiles(h.ctx.paths);
  const [oldProbe, oldNonce] = [f.probes, f.nonce].map((p) => readFileSync(p, 'utf8'));
  // The operator fixes the brief (e.g. after a scan-blocked 03c) and redoes from 02c: 03a re-forecasts, 03b reseals.
  writeFileSync(h.ctx.paths.brief, json({ ...brief(), requirements: ['一个具名主角', '一件旧物'] }));
  const redo = await run(h, { until: '03b-seal', redoFrom: '02c-freeze' });
  assert.equal(redo.exitCode, 0, redo.detail);
  assert.notEqual(readFileSync(f.probes, 'utf8'), oldProbe);
  assert.notEqual(readFileSync(f.nonce, 'utf8'), oldNonce, 'a reseal draws a fresh nonce');
  assert.ok(verifySeal(readFileSync(f.sealed, 'utf8'), readFileSync(f.nonce, 'utf8').trim(), readFileSync(f.probes, 'utf8').trim()));
  // Without a redo that superseded it, a probes.sha256 holding another probe is never resealed.
  rmSync(join(h.ctx.paths.markers, '03b-seal.json'));
  writeFileSync(f.probes, `${'1'.repeat(64)}\n`);
  await assert.rejects(sealStep.run(h.ctx, null), IntegrityError);
});

test('a probe comment posted before a crash is superseded by a --redo-from reseal: 03c posts the new probe instead of exit 3', async () => {
  const h = await harness();
  assert.equal((await run(h, { until: '03b-seal' })).exitCode, 0);
  const f = probeFiles(h.ctx.paths);
  const oldProbe = readFileSync(f.probes, 'utf8').trim();
  // The previous 03c attempt reached createComment and died before probe.json; the operator then redoes from 02c.
  h.ports.github.inject(ISSUE, probeCommentBody(ROUND, oldProbe, 'a'.repeat(40)));
  writeFileSync(h.ctx.paths.brief, json({ ...brief(), requirements: ['一个具名主角', '一件旧物'] }));
  const r = await run(h, { redoFrom: '02c-freeze' });
  assert.equal(r.exitCode, 0, r.detail);
  const newProbe = readFileSync(f.probes, 'utf8').trim();
  assert.notEqual(newProbe, oldProbe);
  const bodies = h.ports.github.comments().map((c) => c.body);
  assert.equal(bodies.length, 2, 'the superseded comment stays; the new probe is posted once');
  assert.ok(bodies[1]?.includes(newProbe));
  assert.equal(JSON.parse(readFileSync(f.probe, 'utf8')).probe, newProbe);
  // An unrelated other probe (never sealed by this round) is still foreign.
  h.ports.github.inject(ISSUE, probeCommentBody(ROUND, 'f'.repeat(64), 'a'.repeat(40)));
  const unseal = await import('./probe.ts');
  const remote = await unseal.unseal(h.ctx);
  assert.ok(remote.reasons.some((x) => /^remote: /u.test(x)), remote.reasons.join('; '));
});

test('void forecasters are tolerated: sealed without them, listed as void in probes-meta.json; all void seals an empty list', async () => {
  const h = await harness({ voidIds: ['kimi'] });
  assert.equal((await run(h)).exitCode, 0);
  const f = probeFiles(h.ctx.paths);
  const sealed = parseSealedForecasts(readJsonFile(f.sealed));
  assert.ok(sealed.ok);
  assert.deepEqual(sealed.value.forecasts.map((x) => x.forecaster), ['claude', 'grok', 'gw-deepseek']);
  const meta = readFileSync(f.meta, 'utf8');
  assert.match(meta, /"forecaster": "kimi"[^}]*"status": "void"/u);
  assert.deepEqual(callLog(h.routers.get('kimi') ?? h.writer), ['forecast-kimi#1', 'forecast-kimi#2']);
  assert.ok(readFileSync(join(h.ctx.paths.markers, '03a-forecast.json'), 'utf8').includes('"void": 1'));

  const none = await harness({ voidIds: FORECASTERS });
  assert.equal((await run(none)).exitCode, 0);
  const empty = parseSealedForecasts(readJsonFile(probeFiles(none.ctx.paths).sealed));
  assert.ok(empty.ok);
  assert.deepEqual(empty.value.forecasts, []);
});

test('forecasterPool: judges minus suspended families, gateway forecasters deduplicated, writerDefault by writer model', async () => {
  const h = await harness();
  assert.equal((await run(h, { until: '02c-freeze' })).exitCode, 0);
  assert.deepEqual(forecasterPool(h.ctx).map((p) => [p.forecaster.backendId, p.forecaster.writerDefault]), [['claude', false], ['grok', false], ['gw-deepseek', true], ['kimi', false]]);
});

test('unseal: valid after 03c; tampered seal / nonce / non-canonical bytes / early writer call / foreign comment → invalid; GitHub down → unavailable', async () => {
  const h = await harness();
  assert.equal((await run(h)).exitCode, 0);
  const f = probeFiles(h.ctx.paths);
  const sealedText = readFileSync(f.sealed, 'utf8');
  const nonceText = readFileSync(f.nonce, 'utf8');
  const record = parseProbeRecord(readJsonFile(f.probe));
  assert.ok(record.ok);
  const valid = await unseal(h.ctx);
  assert.deepEqual([valid.status, valid.remote, valid.reasons], ['valid', 'verified', []]);
  assert.deepEqual(valid.forecasts, parseSealedForecasts(readJsonFile(f.sealed)).ok ? JSON.parse(sealedText) : null);

  const expectInvalid = async (what: string, reason: RegExp): Promise<void> => {
    const r = await unseal(h.ctx);
    assert.equal(r.status, 'invalid', what);
    assert.equal(r.forecasts, null, what);
    assert.ok(r.reasons.some((x) => reason.test(x)), `${what}: ${r.reasons.join(' | ')}`);
    for (const v of allSealedValues()) assert.ok(!r.reasons.join('\n').includes(v), `${what}: reasons never quote forecasts`);
  };
  writeFileSync(f.sealed, sealedText.replace(sealedValue('kimi', 3), '被改过的预测'));
  await expectInvalid('tampered sealed.json', /^seal: /u);
  writeFileSync(f.sealed, `${JSON.stringify(JSON.parse(sealedText), null, 1)}\n`);
  await expectInvalid('non-canonical sealed.json', /^canonical: /u);
  writeFileSync(f.sealed, sealedText);
  writeFileSync(f.nonce, `${'0'.repeat(64)}\n`);
  await expectInvalid('tampered nonce', /^seal: /u);
  writeFileSync(f.nonce, nonceText);
  assert.equal((await unseal(h.ctx)).status, 'valid');

  const early = new Date(Date.parse(record.value.mirrored_at) - 1000).toISOString();
  const call = (label: string, startedAt: string): void => {
    mkdirSync(h.ctx.paths.calls, { recursive: true });
    writeFileSync(join(h.ctx.paths.calls, `${label}.json`), json({ label, started_at: startedAt, at: startedAt }));
  };
  call('baseline-BASE-a1', early);
  assert.equal((await unseal(h.ctx)).status, 'valid', 'the baseline is written before the probe by design');
  call('write-W1-a1', record.value.mirrored_at);
  await expectInvalid('writer call not after mirrored_at', /^ordering: call write-W1-a1 /u);
  call('write-W1-a1', new Date(Date.parse(record.value.mirrored_at) + 1000).toISOString());
  call('decoy-DECOY-a1', early);
  await expectInvalid('decoy call before mirrored_at', /^ordering: call decoy-DECOY-a1 /u);
  call('decoy-DECOY-a1', new Date(Date.parse(record.value.mirrored_at) + 2000).toISOString());
  assert.equal((await unseal(h.ctx)).status, 'valid');

  h.ports.github.failNext('listComments', 1);
  const down = await unseal(h.ctx);
  assert.deepEqual([down.status, down.remote], ['valid', 'unavailable']);
  h.ports.github.inject(ISSUE, probeCommentBody(ROUND, 'f'.repeat(64), record.value.commit));
  await expectInvalid('foreign probe comment', /^remote: /u);
  assert.equal((await unseal(h.ctx)).remote, 'mismatch');
});

test('unseal on missing files reports every problem as ASCII reasons and never throws', async () => {
  const h = await harness();
  assert.equal((await run(h, { until: '02c-freeze' })).exitCode, 0);
  const r = await unseal(h.ctx);
  assert.equal(r.status, 'invalid');
  assert.equal(r.forecasts, null);
  for (const re of [/^files: rounds\/R01\/probes\.sha256 is missing/u, /^files: \.sealed\/R01\/sealed\.json is missing/u, /^files: \.sealed\/R01\/nonce\.hex/u, /^probe_record: /u]) {
    assert.ok(r.reasons.some((x) => re.test(x)), `${re.source}: ${r.reasons.join(' | ')}`);
  }
  for (const x of r.reasons) assert.match(x.replace('‖', '|'), /^[\x20-\x7e]+$/u);
});

test('commit failing every try → probe_mirror:commit; comment-stage tries are counted in probe.json.attempts', async () => {
  const h = await harness();
  assert.equal((await run(h, { until: '03b-seal' })).exitCode, 0);
  h.ports.git.failNext('commit', PROBE_ATTEMPTS);
  const blocked = await probeMirror(h.ctx);
  assert.deepEqual(blocked.status === 'blocked' ? blocked.stage : blocked.status, 'commit');
  assert.deepEqual(h.ports.git.pushes(), []);
  assert.deepEqual(h.ports.github.calls(), []);
  h.ports.github.failNext('listComments', PROBE_ATTEMPTS - 1);
  const slept = h.ports.clock.slept().length;
  const mirrored = await probeMirror(h.ctx);
  assert.equal(mirrored.status === 'mirrored' ? mirrored.record.attempts : 0, PROBE_ATTEMPTS);
  assert.deepEqual(h.ports.clock.slept().slice(slept), [...PROBE_DELAYS_MS]);
  assert.equal(h.ports.github.comments().length, 1);
});
