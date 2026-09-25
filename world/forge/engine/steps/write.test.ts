import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Cell } from '../brief.ts';
import { loadConfig } from '../config.ts';
import { buildContext, type RoundBackends, type StepContext } from '../context.ts';
import { buildFreeze } from '../freeze.ts';
import { sha256Bytes, writeMarker } from '../marker.ts';
import type { StepId } from '../runner.ts';
import { roundPaths } from '../store.ts';
import { IntegrityError } from '../task.ts';
import { unwrap } from '../tasks/fenced.ts';
import { fakePorts } from '../testing/fakes.ts';
import { DEFAULT_FIXTURE, fixtureWorld, type FixtureWorld } from '../testing/fixture-world.ts';
import { callLog, fakeRouter, type FakeRouter, type Route } from '../testing/scripted.ts';
import { DEFAULT_STANCES, type BriefJson } from './brief.ts';
import { isConsequenceStance } from '../tasks/writing.ts';
import { checkStanceIds, metabolicSlot, roundNumber, skillFor, SKILL_METABOLIC, SKILL_NAMES, SKILL_SYSTEMIC, snapshotBody, stanceSchedule, writeStep } from './write.ts';

const SLOTS = ['W1', 'W2', 'W3'];
const STANCE_IDS = DEFAULT_STANCES.map((s) => s.id);

function cellOf(rowId: string, title: string): Cell {
  return { id: 'C', rowId, title, entity: title, time: 't', layers: ['物件'], settingNotes: [], protagonists: ['温芮'], forbidden: [], stances: [...DEFAULT_STANCES] };
}

function stepBrief(rowId = 'SHIP', title = '母舰 · 邻里常态日'): BriefJson {
  return {
    round: 'R01', kind: 'round', row_id: rowId, layer: '物件', topic_source: 'fixed',
    cell: { id: 'C', row_id: rowId, title, entity: title, time: '息壤停留期', layers: ['物件'], setting_notes: [], protagonists: ['温芮'], forbidden: [], stances: [...DEFAULT_STANCES] },
    canon: { revision: '8.1', book_sha256: 'b'.repeat(64), reference_sha256: 'c'.repeat(64) },
    canon_passages: [{ file: 'reference/05-ecology-and-everyday.md', text: '温芮把借来的扳手挂回工具墙。循环泵换了节拍。林澈说冷凝管今晚要换滤网。' }],
    facts: [], regression: [], regression_stale: [], forbidden: [], cliches: [], requirements: ['一个具名主角。'], interface_requirements: [], aliases: [],
    seed: 'seed-w', created_at: '2026-10-01T00:00:00.000Z',
  };
}

function writerText(body: string): string {
  return ['```submission', body, '```', '```delta', '{"new_proper_nouns":[],"claims":[]}', '```', '```interface', '{"shots":[{},{},{}],"object":{"n":1},"hook":{"h":1}}', '```', '种子：', '- 一'].join('\n');
}

interface H {
  dir: string;
  w: FixtureWorld;
  ctx: StepContext;
  writers: FakeRouter[];
}

function harness(write: Route = () => writerText('温芮把借来的扳手挂回工具墙。')): H {
  const dir = mkdtempSync(join(tmpdir(), 'forge-write-'));
  const w = fixtureWorld(dir, DEFAULT_FIXTURE);
  const config = loadConfig(w.root, { requireLocal: true });
  if (!config.ok) throw new Error(config.error);
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: '2026-10-01T00:00:00.000Z', seed: 'write-seed' });
  const router = (id: string): FakeRouter => fakeRouter({ write }, { id, family: 'DeepSeek', model: 'deepseek-fixture' });
  const writers = SLOTS.map(router);
  const other = router('other');
  const backends: RoundBackends = {
    writers: SLOTS.map((slot, i) => ({ slot, backend: writers[i] ?? other })),
    baseline: other, decoy: other, defect: other, judges: [], forecasters: [], maintainer: other, mergeEditor: other, calibGateway: new Map(),
  };
  const built = buildContext({
    root: w.root, repo: w.repo, roundId: 'R01', pipeline: 'round', paths: roundPaths(w.root, 'R01'), config: config.value,
    deps: { ports, backends: () => backends, env: {}, pid: 7, isAlive: () => true, log: () => undefined },
    startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
  });
  if (!built.ok) throw new Error(built.error);
  return { dir, w, ctx: built.value, writers };
}

function mark(ctx: StepContext, step: StepId): void {
  writeMarker(ctx.files, join(ctx.paths.markers, `${step}.json`), {
    v: 1, round: ctx.roundId, step, completed_at: '2026-10-01T00:00:00.000Z', result: 'done', skipped: null,
    inputs: {}, outputs: {}, external: {}, local: {}, tasks: { ok: 0, void: 0, calls: 0 }, prev: null,
  });
}

function skillHashes(root: string): Record<string, string> {
  return Object.fromEntries(SKILL_NAMES.map((n) => [n, sha256Bytes(readFileSync(join(root, 'skills', `${n}.md`)))]));
}

/** brief.json + freeze.json (skills pinned) + 02c marker; `probe` adds probe.json, the 03c marker and probe_created_at. */
function prepare(h: H, probe: { file: boolean; marker: boolean; createdAt: boolean }, brief: BriefJson = stepBrief()): void {
  mkdirSync(h.ctx.paths.dir, { recursive: true });
  writeFileSync(h.ctx.paths.brief, `${JSON.stringify(brief, null, 2)}\n`);
  const freeze = buildFreeze({
    round: 'R01', files: { 'brief.json': 'x' }, benchmarkVersion: 'v1', eligibleFamilies: [], flags: {}, protocolBundleSha256: h.ctx.bundleSha256,
    probeCreatedAt: probe.createdAt ? '2026-10-01T00:05:00Z' : null, seed: 'seed-w', skills: skillHashes(h.w.root),
  });
  writeFileSync(h.ctx.paths.freeze, `${JSON.stringify(freeze, null, 2)}\n`);
  mark(h.ctx, '02c-freeze');
  if (probe.file) writeFileSync(join(h.ctx.paths.dir, 'probe.json'), '{"probe":"p"}\n');
  if (probe.marker) mark(h.ctx, '03c-probe-mirror');
}

function calls(h: H): string[] {
  return h.writers.flatMap(callLog);
}

test('stanceSchedule is a cyclic Latin square over rounds', () => {
  const rounds = [4, 5, 6, 7].map((r) => stanceSchedule(r, SLOTS, STANCE_IDS));
  for (const s of rounds) assert.equal(new Set(Object.values(s)).size, SLOTS.length, 'distinct stances within a round');
  for (const slot of SLOTS) assert.deepEqual(rounds.map((s) => s[slot]).sort(), [...STANCE_IDS].sort(), `${slot} writes each stance once in 4 rounds`);
  assert.deepEqual(stanceSchedule(1, SLOTS, STANCE_IDS), { W1: 'object-history', W2: 'outsider-first-visit', W3: 'counter-consequence' });
  assert.deepEqual(stanceSchedule(1, SLOTS, ['a', 'b', 'c']), { W1: 'b', W2: 'c', W3: 'a' });
  assert.throws(() => stanceSchedule(1, SLOTS, []), /no stances/u);
});

test('skillFor: consequence → systemic-worldbuilding; one seeded slot of a 母舰 cell → metabolic-cultures; scene-first → none', () => {
  const schedule = stanceSchedule(1, SLOTS, STANCE_IDS);
  const plan = { round: 'R01', schedule };
  const ship = cellOf('SHIP', '母舰 · 邻里常态日');
  const dock = cellOf('S1-冷湾', '冷湾 · 码头常态日');
  const chosen = new Set<string>();
  for (const seed of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']) {
    const skills = SLOTS.map((slot) => skillFor(schedule[slot] ?? '', ship, slot, seed, plan));
    assert.equal(skills[2], SKILL_SYSTEMIC);
    assert.equal(skills.filter((s) => s === SKILL_METABOLIC).length, 1, 'exactly one metabolic slot');
    assert.equal(skills.filter((s) => s === null).length, 1);
    const m = metabolicSlot(ship, seed, plan);
    assert.ok(m === 'W1' || m === 'W2');
    chosen.add(m);
    assert.deepEqual(SLOTS.map((slot) => skillFor(schedule[slot] ?? '', dock, slot, seed, plan)), [null, null, SKILL_SYSTEMIC]);
  }
  assert.equal(chosen.size, 2, 'the seed decides which scene-first slot gets the skill');
  const neighbourhood = cellOf('S3-公共生活接待', '栖衡 · 邻里集市');
  assert.notEqual(metabolicSlot(neighbourhood, 's1', plan), null);
});

test('roundNumber and snapshotBody', () => {
  assert.deepEqual(roundNumber('R07'), { ok: true, value: 7 });
  assert.equal(roundNumber('R7').ok, false);
  assert.equal(snapshotBody('<!--\nprovenance\n-->\n\n# Skill\n\nbody\n'), '# Skill\n\nbody');
  assert.equal(snapshotBody('# Skill\n'), '# Skill');
});

test('04-write refuses without probe.json, without the 03c marker or without probe_created_at, and calls nobody', async () => {
  const cases = [
    { file: false, marker: true, createdAt: true, want: /probe\.json is missing/u },
    { file: true, marker: false, createdAt: true, want: /03c-probe-mirror is not marked/u },
    { file: true, marker: true, createdAt: false, want: /no probe_created_at/u },
  ];
  for (const c of cases) {
    const h = harness();
    prepare(h, c);
    const out = await writeStep.run(h.ctx, null);
    assert.equal(out.kind, 'failed');
    if (out.kind === 'failed') assert.match(out.detail, c.want);
    assert.deepEqual(calls(h), []);
    rmSync(h.dir, { recursive: true });
  }
});

test('04-write runs every slot once with its stance and pinned skill; a void writer is recorded; a rerun calls nobody', async () => {
  const h = harness((_prompt, _n, meta) => (meta.taskId === 'write-W2' ? '没有代码块' : writerText(`温芮把借来的扳手挂回工具墙。${meta.taskId}`)));
  prepare(h, { file: true, marker: true, createdAt: true });
  const out = await writeStep.run(h.ctx, null);
  assert.equal(out.kind, 'done');
  if (out.kind !== 'done') return;
  assert.deepEqual(out.outputs, ['rounds/R01/submissions/W1.json', 'rounds/R01/submissions/W2.json', 'rounds/R01/submissions/W3.json']);
  assert.deepEqual(calls(h).sort(), ['write-W1#1', 'write-W2#1', 'write-W2#2', 'write-W3#1']);
  const schedule = stanceSchedule(1, SLOTS, STANCE_IDS);
  const metabolic = metabolicSlot(cellOf('SHIP', '母舰'), 'seed-w', { round: 'R01', schedule });
  const body = (name: string): string => snapshotBody(readFileSync(join(h.w.root, 'skills', `${name}.md`), 'utf8'));
  for (const [i, slot] of SLOTS.entries()) {
    const rec: unknown = JSON.parse(readFileSync(join(h.ctx.paths.submissions, `${slot}.json`), 'utf8'));
    const want = slot === 'W3' ? SKILL_SYSTEMIC : slot === metabolic ? SKILL_METABOLIC : null;
    assert.deepEqual(
      typeof rec === 'object' && rec !== null ? { stance: Reflect.get(rec, 'stance'), skill: Reflect.get(rec, 'skill'), ok: Reflect.get(rec, 'ok'), task: Reflect.get(rec, 'task') } : null,
      { stance: schedule[slot], skill: want, ok: slot !== 'W2', task: `write-${slot}` },
    );
    const prompt = h.writers[i]?.log()[0]?.prompt ?? '';
    assert.equal(unwrap(prompt, '技能'), want === null ? null : body(want));
    assert.ok(prompt.includes(DEFAULT_STANCES.find((s) => s.id === schedule[slot])?.text ?? '?'));
  }
  assert.ok(out.inputs.includes('rounds/R01/probe.json'));
  assert.ok(out.inputs.includes(`skills/${SKILL_SYSTEMIC}.md`));
  const again = await writeStep.run(h.ctx, null);
  assert.equal(again.kind, 'done');
  assert.equal(calls(h).length, 4, 'task records are reused');
  rmSync(h.dir, { recursive: true });
});

test('04-write: a skill snapshot edited after 02c is an integrity error before any call', async () => {
  const h = harness();
  prepare(h, { file: true, marker: true, createdAt: true });
  writeFileSync(join(h.w.root, 'skills', `${SKILL_SYSTEMIC}.md`), '# edited\n');
  await assert.rejects(writeStep.run(h.ctx, null), (e: unknown) => e instanceof IntegrityError && /pinned skill snapshot changed/u.test(e.message));
  assert.deepEqual(calls(h), []);
  rmSync(h.dir, { recursive: true });
});

test('stance ids are the four canonical ones: the consequence stance matches exactly, unknown cell stance ids are refused', () => {
  assert.equal(isConsequenceStance('counter-consequence'), true);
  assert.equal(isConsequenceStance('no-consequence-here'), false);
  assert.equal(isConsequenceStance('居民的一天'), false);
  const unknown = checkStanceIds(['resident-day', '反直觉后果']);
  assert.equal(unknown.ok, false);
  assert.match(unknown.ok ? '' : unknown.error, /反直觉后果/u);
  assert.equal(checkStanceIds(['resident-day', 'counter-consequence']).ok, true);
});
