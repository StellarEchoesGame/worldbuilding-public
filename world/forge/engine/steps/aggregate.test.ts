import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fakeBackend } from '../adapters/fake.ts';
import { loadConfig, type Family } from '../config.ts';
import { buildContext, type RoundBackends, type StepContext } from '../context.ts';
import { buildFreeze } from '../freeze.ts';
import { readArray, readRecord, readString } from '../json.ts';
import { sha256Bytes, writeMarker } from '../marker.ts';
import { pairVerdicts, tasteCallPath, type PairEntry, type PairKind, type TasteCallFile } from '../pairs.ts';
import { loadSchema, validate } from '../schema.ts';
import { roundPaths, sha256 } from '../store.ts';
import { buildRoundTally, type RoundTally } from '../tally.ts';
import { IntegrityError } from '../task.ts';
import { tasteTaskId, type Order } from '../tasks/ids.ts';
import { fakePorts } from '../testing/fakes.ts';
import { DEFAULT_FIXTURE, FIXTURE_AT, fixtureWorld } from '../testing/fixture-world.ts';
import { aggregateStep } from './aggregate.ts';
import { DEFAULT_STANCES, type BriefJson } from './brief.ts';

const JUDGES: readonly Family[] = ['Anthropic', 'Moonshot', 'OpenAI', 'xAI'];
const ORDERS: readonly Order[] = ['fwd', 'rev'];

interface H {
  dir: string;
  ctx: StepContext;
}

function put(ctx: StepContext, rel: string, value: unknown): void {
  const path = join(ctx.paths.dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function stepBrief(): BriefJson {
  return {
    round: 'R01', kind: 'round', row_id: 'SHIP', layer: '物件', topic_source: 'fixed',
    cell: { id: 'C', row_id: 'SHIP', title: '母舰 · 邻里常态日', entity: '母舰', time: '息壤停留期', layers: ['物件'], setting_notes: [], protagonists: ['温芮'], forbidden: [], stances: [...DEFAULT_STANCES] },
    canon: { revision: '8.1', book_sha256: 'b'.repeat(64), reference_sha256: 'c'.repeat(64) },
    canon_passages: [{ file: 'reference/05-ecology-and-everyday.md', text: '温芮把借来的扳手挂回工具墙。' }],
    facts: [], regression: [], regression_stale: [], forbidden: [], cliches: [], requirements: [], interface_requirements: [], aliases: [],
    seed: 'seed-agg', created_at: '2026-10-01T00:00:00.000Z',
  };
}

function harness(): H {
  const dir = mkdtempSync(join(tmpdir(), 'forge-aggregate-'));
  const w = fixtureWorld(dir, DEFAULT_FIXTURE);
  const config = loadConfig(w.root, { requireLocal: true });
  if (!config.ok) throw new Error(config.error);
  const b = fakeBackend('x', 'DeepSeek', () => '');
  const backends: RoundBackends = { writers: [], baseline: b, decoy: b, defect: b, judges: [], forecasters: [], maintainer: b, mergeEditor: b, calibGateway: new Map() };
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: '2026-10-01T06:00:00.000Z', seed: 'agg-seed' });
  const built = buildContext({
    root: w.root, repo: w.repo, roundId: 'R01', pipeline: 'round', paths: roundPaths(w.root, 'R01'), config: config.value,
    deps: { ports, backends: () => backends, env: {}, pid: 7, isAlive: () => true, log: () => undefined },
    startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
  });
  if (!built.ok) throw new Error(built.error);
  const ctx = built.value;
  mkdirSync(ctx.paths.dir, { recursive: true });
  writeFileSync(ctx.paths.brief, `${JSON.stringify(stepBrief(), null, 2)}\n`);
  const benchSha = sha256Bytes(readFileSync(join(w.root, 'benchmark', 'v1.json')));
  const freeze = buildFreeze({
    round: 'R01', files: { 'brief.json': 'x' }, benchmarkVersion: 'v1', eligibleFamilies: [...JUDGES], flags: {}, protocolBundleSha256: ctx.bundleSha256,
    probeCreatedAt: '2026-10-01T00:05:00.000Z', seed: 'seed-agg', benchmarkResolution: { version: 'v1', sha256: benchSha, path: 'benchmark/v1.json', via: 'activate', since: FIXTURE_AT },
  });
  writeFileSync(ctx.paths.freeze, `${JSON.stringify(freeze, null, 2)}\n`);
  writeMarker(ctx.files, join(ctx.paths.markers, '02c-freeze.json'), {
    v: 1, round: 'R01', step: '02c-freeze', completed_at: '2026-10-01T00:00:00.000Z', result: 'done', skipped: null,
    inputs: {}, outputs: {}, external: {}, local: {}, tasks: { ok: 0, void: 0, calls: 0 }, prev: null,
  });
  return { dir, ctx };
}

interface CallSpec {
  pair: string;
  kind: PairKind;
  family: Family;
  session: number;
  rerun: boolean;
  order: Order;
  text1: string;
  text2: string;
  decisive: string | null;
  shadow?: boolean;
  preferredDecoy?: boolean;
}

function tasteCall(ctx: StepContext, c: CallSpec): void {
  const champion = c.kind === 'champion';
  const file: TasteCallFile = {
    round: 'R01', pair: c.pair, kind: c.kind, family: c.family, shadow: c.shadow ?? false, session: c.session, rerun: c.rerun, order: c.order,
    task: tasteTaskId(c.pair, c.family, c.session, c.rerun, c.order), text1: c.text1, text2: c.text2,
    status: c.decisive === null ? 'void' : 'ok', picks: c.decisive === null ? {} : { q1: c.decisive }, quotes: {}, decisive: c.decisive,
    decoy_at: champion ? 3 : null, decoy_pick: champion && c.decisive !== null ? (c.preferredDecoy === true ? 3 : 4) : null,
    preferred_decoy: c.preferredDecoy ?? false, error: c.decisive === null ? 'void after retry' : null,
  };
  const path = tasteCallPath(ctx.paths, c.kind, c.pair, c.family, c.session, c.rerun, c.order);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

/** Champion-pair sessions of one family: 'w' = both calls chose the submission, 'l' = both chose BASE, 'd' = decoy preferred. */
function champion(ctx: StepContext, sub: string, family: Family, sessions: string, opts: { shadow?: boolean; rerun?: Record<number, string> } = {}): void {
  const one = (session: number, rerun: boolean, code: string): void => {
    for (const order of ORDERS) {
      const [text1, text2] = order === 'fwd' ? [sub, 'BASE'] : ['BASE', sub];
      tasteCall(ctx, { pair: sub, kind: 'champion', family, session, rerun, order, text1, text2, decisive: code === 'l' ? 'BASE' : sub, shadow: opts.shadow ?? false, preferredDecoy: code === 'd' });
    }
  };
  [...sessions].forEach((code, k) => one(k, false, code));
  for (const [k, code] of Object.entries(opts.rerun ?? {})) one(Number(k), true, code);
}

/** One aux call pair (s0 fwd + rev) of one family: the decisive text of each order (null = void). */
function aux(ctx: StepContext, pair: string, kind: 'sub_sub' | 'anchor', left: string, right: string, family: Family, fwd: string | null, rev: string | null): void {
  tasteCall(ctx, { pair, kind, family, session: 0, rerun: false, order: 'fwd', text1: left, text2: right, decisive: fwd });
  tasteCall(ctx, { pair, kind, family, session: 0, rerun: false, order: 'rev', text1: right, text2: left, decisive: rev });
}

function entry(id: string, kind: PairKind, left: string, right: string, families: readonly Family[], extra: Partial<PairEntry> = {}): PairEntry {
  return { id, kind, left, right, families: [...families], shadow: [], effective: [...families], dropped: [], ...extra };
}

function pairsFile(ctx: StepContext, rel: string, pairs: readonly PairEntry[]): void {
  const ids = [...new Set(pairs.flatMap((p) => [p.left, p.right]))];
  const kindOf = (id: string): string => (id === 'BASE' ? 'champion' : id.startsWith('AN') ? 'anchor' : 'submission');
  const texts = Object.fromEntries(ids.map((id) => [id, { id, kind: kindOf(id), file: `rounds/R01/submissions/${id}.json`, sha256: 'a'.repeat(64), authors: [] }]));
  put(ctx, rel, { round: 'R01', champion: 'BASE', texts, pairs });
}

function writerText(body: string, seeds: readonly string[]): string {
  const iface = { shots: [{ 地点: '工具墙', 主体人物与动作: '温芮挂回扳手' }, {}, {}], object: { 名称: '借用签' }, hook: { 玩家不来时会发生什么: '滤网堵死', 玩法类型: '经营' } };
  const delta = { new_proper_nouns: [], claims: [] };
  return ['```submission', body, '```', '```delta', JSON.stringify(delta), '```', '```interface', JSON.stringify(iface), '```', '野生种子：', ...seeds.map((s) => `- ${s}`)].join('\n');
}

function submission(ctx: StepContext, id: string): void {
  put(ctx, `submissions/${id}.json`, { id, kind: 'writer', model: 'm', family: 'DeepSeek', stance: 's', ok: true, error: null, text: writerText(`${id} 的正文。温芮把借来的扳手挂回工具墙。`, [`${id} 种子一`, `${id} 种子二`, `${id} 种子三`]) });
}

function gateFile(ctx: StepContext, id: string, outcome: string, defectUnverified = false): void {
  const notes = outcome === 'pass' ? [{ family: 'OpenAI', quote: '借来的扳手挂回工具墙', against: 'F14', reason: '路径实例' }] : [];
  put(ctx, `gate/${id}.json`, {
    round: 'R01', submission: id, resubmission: id.endsWith('-r2'), outcome, judges: [], counted: ['Anthropic', 'OpenAI'],
    defect_unverified: defectUnverified, path_instance_notes: notes, negated_flags: [],
  });
}

function measures(ctx: StepContext, id: string, o: { hook?: number | null; skin?: string; recognised?: boolean; cold?: string; producer?: string } = {}): void {
  put(ctx, `measures/recall/${id}.json`, { round: 'R01', submission: id, calls: [], details: [], hook: o.hook === undefined ? 0.5 : o.hook });
  const skin = o.skin ?? 'ok';
  put(ctx, `measures/skin-swap/${id}.json`, { round: 'R01', submission: id, status: skin, family: null, task: null, lineup: [], answer: null, verdict: skin === 'ok' ? { pick: '甲', quote: 'q', reason: 'r', recognised: o.recognised ?? true } : null });
  const cold = o.cold ?? 'ok';
  const read = { where: { answer: '工具墙', quote: '工具墙' }, who: { name: '温芮', wants: '还清借用', cost: '误了换班', quote: '温芮' }, go: { answer: null, quote: null }, clarity: 2 };
  put(ctx, `measures/cold-reader/${id}.json`, { round: 'R01', submission: id, status: cold, family: null, task: null, read: cold === 'ok' ? read : null });
  put(ctx, `measures/producer/${id}.json`, { round: 'R01', submission: id, status: o.producer ?? 'pass', mechanical: [], calls: [], items: [] });
}

function taskRecord(ctx: StepContext, id: string, status: 'ok' | 'void', attempts: 1 | 2): void {
  put(ctx, `tasks/${id}.json`, {
    id, backend: 'judge-x', family: 'xAI', model: 'm', role_sha256: 'a'.repeat(64), prompt_sha256: 'b'.repeat(64), status, attempts,
    error: status === 'void' ? 'bad fence' : null, text: '', text_sha256: 'c'.repeat(64), served_model: null, version: null,
    calls: attempts === 1 ? [`${id}-a1`] : [`${id}-a1`, `${id}-a2`], finished_at: '2026-10-01T01:00:00.000Z',
  });
}

/**
 * R01 after 07b: W1 (4 families, xAI 1 of 2 → 7/8 + a losing shadow family), W2-r2 (the resubmission of W2; xAI
 * prefers the decoy in s1 and its rerun → dropped, |E| = 3, 6/6), W3 (2 families → trial); aux pairs W1.W3, W1.AN1.
 */
function fullRound(ctx: StepContext, opts: { surprise?: boolean; auxPairs?: boolean } = {}): void {
  const mech = (status: string): unknown => ({ status, pass: status === 'pass', checks: [], error: null });
  put(ctx, 'gate/mechanical.json', { round: 'R01', submissions: { W1: mech('pass'), W2: mech('fail'), W3: mech('pass') } });
  put(ctx, 'gate/llm.json', {
    round: 'R01', defect_submission: 'W1', defect_status: 'ok', voided_families: [], unverified: ['W3'],
    submissions: { W1: { outcome: 'pass', defect_unverified: false }, W3: { outcome: 'unverified', defect_unverified: false } },
  });
  put(ctx, 'gate/resubmit.json', {
    round: 'R01', passing: ['W1', 'W2-r2', 'W3'], voided_families: [],
    entries: [{ slot: 'W2', submission: 'W2-r2', reason: 'mechanical_fail', writer: 'ok', mechanical: 'pass', checks: [], outcome: 'split' }],
  });
  for (const id of ['W1', 'W2-r2', 'W3']) submission(ctx, id);
  const championText = '上一轮 owner 选中的现场。';
  put(ctx, 'champion.json', {
    row_id: 'SHIP', kind: 'owner_pick', round: 'P00', submission: 'W1', family: 'DeepSeek', authors: ['DeepSeek'], text: championText,
    text_sha256: sha256(championText), set_at: '2026-09-01T00:00:00.000Z', previous: [],
  });
  gateFile(ctx, 'W1', 'pass');
  gateFile(ctx, 'W2-r2', 'split');
  gateFile(ctx, 'W3', 'unverified', true);
  pairsFile(ctx, 'pairs.json', [
    entry('W1', 'champion', 'W1', 'BASE', JUDGES, { shadow: ['DeepSeek'] }),
    entry('W2-r2', 'champion', 'W2-r2', 'BASE', JUDGES, { effective: ['Anthropic', 'Moonshot', 'OpenAI'], dropped: ['xAI'] }),
    entry('W3', 'champion', 'W3', 'BASE', ['Anthropic', 'Moonshot']),
  ]);
  for (const f of JUDGES) champion(ctx, 'W1', f, f === 'xAI' ? 'wl' : 'ww');
  champion(ctx, 'W1', 'DeepSeek', 'll', { shadow: true, rerun: { 0: 'l' } });
  for (const f of JUDGES) champion(ctx, 'W2-r2', f, f === 'xAI' ? 'wd' : 'ww', f === 'xAI' ? { rerun: { 1: 'd' } } : {});
  champion(ctx, 'W3', 'Anthropic', 'ww');
  champion(ctx, 'W3', 'Moonshot', 'wl');
  if (opts.auxPairs !== false) {
    pairsFile(ctx, 'taste/aux/pairs.json', [entry('W1.W3', 'sub_sub', 'W1', 'W3', ['Anthropic', 'OpenAI']), entry('W1.AN1', 'anchor', 'W1', 'AN1', ['Moonshot', 'xAI'])]);
    aux(ctx, 'W1.W3', 'sub_sub', 'W1', 'W3', 'Anthropic', 'W1', 'W1');
    aux(ctx, 'W1.W3', 'sub_sub', 'W1', 'W3', 'OpenAI', 'W1', null);
    aux(ctx, 'W1.AN1', 'anchor', 'W1', 'AN1', 'Moonshot', 'AN1', 'AN1');
    aux(ctx, 'W1.AN1', 'anchor', 'W1', 'AN1', 'xAI', 'W1', 'AN1');
  }
  measures(ctx, 'W1');
  measures(ctx, 'W2-r2', { producer: 'unjudged', recognised: false });
  measures(ctx, 'W3', { skin: 'void', cold: 'void', producer: 'fail', hook: null });
  const valid = opts.surprise !== false;
  put(ctx, 'unseal.json', { round: 'R01', status: valid ? 'valid' : 'invalid', reasons: valid ? [] : ['nonce'], remote: valid ? 'verified' : 'unavailable', forecasters: valid ? 5 : 0, checked_at: '2026-10-01T02:00:00.000Z' });
  if (valid) {
    const report = (status: string, surprising: number, eligible: number): unknown => ({ submission: 'x', status, surprising, eligible, drift: 0, unresolved: 0, forecast: 0, details: [], chains: [], acceptor_reused: status === 'reused', roles: { matchers: [], chain_writer: null, acceptor: null }, tasks: [] });
    put(ctx, 'surprise.json', { round: 'R01', remote: 'verified', submissions: { W1: report('full', 1, 3), 'W2-r2': report('reused', 0, 2), W3: report('match_only', 0, 1) } });
  }
  taskRecord(ctx, 'recall-W1-xAI', 'void', 2);
  taskRecord(ctx, 'recall-W1-OpenAI', 'ok', 2);
  taskRecord(ctx, 'recall-W1-Moonshot', 'ok', 1);
  put(ctx, 'calls/recall-W1-xAI-a1.json', { backend: 'judge-x', tokens_in: 10, tokens_out: 5, cost_usd: 0.25 });
  put(ctx, 'calls/recall-W1-xAI-a2.json', { backend: 'judge-x', tokens_in: 10, tokens_out: 5, cost_usd: 0.25 });
  put(ctx, 'calls/recall-W1-xAI-a1-q1.json', { backend: 'judge-x', quota: true });
}

function readOut(ctx: StepContext, name: string): unknown {
  const v: unknown = JSON.parse(readFileSync(join(ctx.paths.dir, name), 'utf8'));
  return v;
}

function schemaErrors(name: string, value: unknown): string[] {
  const schema = loadSchema(JSON.parse(readFileSync(new URL(`../../schema/${name}.schema.json`, import.meta.url), 'utf8')));
  if (!schema.ok) throw new Error(schema.error);
  return validate(schema.value, value);
}

function pick(v: unknown, keys: readonly string[]): Record<string, unknown> {
  const rec = readRecord({ v }, 'v');
  return Object.fromEntries(keys.map((k) => [k, rec === null ? undefined : rec[k]]));
}

function byKey(list: unknown, key: string, value: string): unknown {
  return (Array.isArray(list) ? list : []).find((p) => readString(p, key) === value) ?? null;
}

const PAIR_KEYS = ['e', 'shadow', 'dropped', 'wins_by_family', 'total_wins', 'needed', 'bar', 'beats_champion', 'trial'];

test('08 writes labels, tally v2, cost, card and wild seeds from every 05–07 output', async () => {
  const h = harness();
  fullRound(h.ctx);
  const out = await aggregateStep.run(h.ctx, null);
  if (out.kind !== 'done') throw new Error(`expected done, got ${out.kind}`);
  assert.deepEqual(out.outputs, ['labels.json', 'tally.json', 'cost.json', 'card.json', 'wild-seeds.json'].map((n) => `rounds/R01/${n}`));
  assert.deepEqual(out.external, []);
  const wanted = ['brief.json', 'champion.json', 'pairs.json', 'taste/aux/pairs.json', 'gate/W2-r2.json', 'gate/resubmit.json', 'gate/llm.json', 'submissions/W3.json', 'measures/producer/W3.json', 'unseal.json', 'surprise.json', 'taste/W2-r2/xAI-s1r-rev.json', 'taste/aux/W1.AN1/xAI-s0-fwd.json'];
  for (const rel of wanted) assert.ok(out.inputs.includes(`rounds/R01/${rel}`), rel);
  assert.deepEqual(out.inputs, [...out.inputs].sort(), 'inputs code-unit sorted');
  assert.ok(!out.inputs.some((r) => r.includes('/tasks/') || r.includes('/calls/') || r.endsWith('labels.json')));

  const labels = readRecord({ l: readOut(h.ctx, 'labels.json') }, 'l') ?? {};
  assert.deepEqual(Object.keys(labels), ['A', 'B', 'C']);
  assert.deepEqual(Object.values(labels).sort(), ['W1', 'W2-r2', 'W3']);

  const tally = readOut(h.ctx, 'tally.json');
  assert.deepEqual(schemaErrors('tally', tally), []);
  assert.deepEqual(pick(tally, ['v', 'round', 'benchmark', 'champion', 'session_pairs']), { v: 2, round: 'R01', benchmark: 'v1', champion: 'owner_pick', session_pairs: 2 });
  const pairs = readArray(tally, 'champion_pairs');
  assert.deepEqual(pick(byKey(pairs, 'submission', 'W1'), PAIR_KEYS), {
    e: ['Anthropic', 'Moonshot', 'OpenAI', 'xAI'], shadow: ['DeepSeek'], dropped: [], wins_by_family: { Anthropic: 2, Moonshot: 2, OpenAI: 2, xAI: 1 },
    total_wins: 7, needed: 7, bar: '7/8', beats_champion: true, trial: false,
  });
  assert.deepEqual(pick(byKey(pairs, 'submission', 'W1'), ['signs', 'p_value']), { signs: { plus: 3, minus: 0, tie: 1 }, p_value: 9 / 256 });
  assert.deepEqual(pick(byKey(pairs, 'submission', 'W2-r2'), PAIR_KEYS), {
    e: ['Anthropic', 'Moonshot', 'OpenAI'], shadow: [], dropped: ['xAI'], wins_by_family: { Anthropic: 2, Moonshot: 2, OpenAI: 2 },
    total_wins: 6, needed: 6, bar: '6/6', beats_champion: true, trial: false,
  });
  assert.deepEqual(pick(byKey(pairs, 'submission', 'W3'), PAIR_KEYS), {
    e: ['Anthropic', 'Moonshot'], shadow: [], dropped: [], wins_by_family: { Anthropic: 2, Moonshot: 1 }, total_wins: 3, needed: 4, bar: 'trial', beats_champion: false, trial: true,
  });
  assert.deepEqual(readArray(tally, 'aux_pairs'), [
    { pair: 'W1.AN1', kind: 'anchor', left: 'W1', right: 'AN1', wins_left: 1, wins_right: 3, families: ['Moonshot', 'xAI'], void_calls: 0 },
    { pair: 'W1.W3', kind: 'sub_sub', left: 'W1', right: 'W3', wins_left: 3, wins_right: 0, families: ['Anthropic', 'OpenAI'], void_calls: 1 },
  ]);
  const ordering = readRecord(tally, 'ordering') ?? {};
  assert.deepEqual(Object.keys(ordering), ['AN1', 'W1', 'W2-r2', 'W3']);
  const score = (id: string): number => Number(ordering[id]);
  assert.ok(score('AN1') > score('W1') && score('W1') > score('W3'), 'Bradley–Terry orders by aux calls');
  assert.equal(score('W2-r2'), 1, 'a submission without aux calls is not ranked');
  assert.deepEqual(readRecord(tally, 'gate'), { W1: 'pass', 'W2-r2': 'split', W3: 'unverified' });
  assert.deepEqual(readRecord(tally, 'measures'), {
    W1: { hook: 0.5, skin_swap: 'recognised', cold_reader: { status: 'ok', clarity: 2 }, interface: 'pass', surprise: { status: 'full', surprising: 1, eligible: 3 } },
    'W2-r2': { hook: 0.5, skin_swap: 'not_recognised', cold_reader: { status: 'ok', clarity: 2 }, interface: 'unjudged', surprise: { status: 'reused', surprising: 0, eligible: 2 } },
    W3: { hook: null, skin_swap: 'void', cold_reader: { status: 'void', clarity: null }, interface: 'fail', surprise: { status: 'match_only', surprising: 0, eligible: 1 } },
  });
  assert.deepEqual(readRecord(tally, 'voids'), { calls: 2, void_tasks: 1, retried_tasks: 2, session_reruns: 1, dropped_families: 1 });
  assert.deepEqual(pick(readOut(h.ctx, 'cost.json'), ['total_usd', 'unpriced_calls']), { total_usd: 0.5, unpriced_calls: 0 });
  rmSync(h.dir, { recursive: true });
});

test('08: a pair with |E| ≤ 2 marks the submission trial on card.json; writers\' wild seeds land in wild-seeds.json', async () => {
  const h = harness();
  fullRound(h.ctx);
  await aggregateStep.run(h.ctx, null);
  const card = readOut(h.ctx, 'card.json');
  assert.deepEqual(schemaErrors('card', card), []);
  const labels = readRecord({ l: readOut(h.ctx, 'labels.json') }, 'l') ?? {};
  const entries = readArray(card, 'entries') ?? [];
  assert.deepEqual(entries.map((e) => readString(e, 'label')), ['A', 'B', 'C']);
  assert.deepEqual(entries.map((e) => labels[readString(e, 'label') ?? ''] === readString(e, 'submission')), [true, true, true]);
  assert.deepEqual(pick(card, ['v', 'round', 'row_id', 'benchmark', 'champion', 'flags']), { v: 1, round: 'R01', row_id: 'SHIP', benchmark: 'v1', champion: 'owner_pick', flags: [] });
  const w3 = byKey(entries, 'submission', 'W3');
  assert.deepEqual(pick(w3, ['flags', 'mergeable', 'protagonist']), { flags: ['gate_judges_short', 'defect_unverified', 'trial', 'layer3_red'], mergeable: false, protagonist: null });
  assert.deepEqual(pick(readRecord(w3, 'wins'), ['e', 'bar', 'beats_champion']), { e: 2, bar: 'trial', beats_champion: false });
  const w2 = byKey(entries, 'submission', 'W2-r2');
  assert.deepEqual(pick(w2, ['slot', 'resubmitted', 'flags', 'mergeable']), { slot: 'W2', resubmitted: true, flags: ['gate_split', 'layer3_red', 'acceptor_reused', 'resubmitted'], mergeable: true });
  assert.deepEqual(pick(readRecord(w2, 'wins'), ['total', 'needed', 'e', 'bar', 'beats_champion']), { total: 6, needed: 6, e: 3, bar: '6/6', beats_champion: true });
  const w1 = byKey(entries, 'submission', 'W1');
  assert.deepEqual(pick(w1, ['flags', 'mergeable', 'protagonist']), { flags: [], mergeable: true, protagonist: { name: '温芮', wants: '还清借用', cost: '误了换班', source: 'cold_reader' } });
  assert.deepEqual(readArray(readRecord(w1, 'gate'), 'path_instance_notes'), [{ family: 'OpenAI', quote: '借来的扳手挂回工具墙', against: 'F14', reason: '路径实例' }]);
  assert.deepEqual(readOut(h.ctx, 'wild-seeds.json'), {
    round: 'R01',
    seeds: { W1: ['W1 种子一', 'W1 种子二', 'W1 种子三'], 'W2-r2': ['W2-r2 种子一', 'W2-r2 种子二', 'W2-r2 种子三'], W3: ['W3 种子一', 'W3 种子二', 'W3 种子三'] },
  });
  rmSync(h.dir, { recursive: true });
});

test('08 rerun (crash before the marker) rewrites byte-identical outputs; labels never move', async () => {
  const h = harness();
  fullRound(h.ctx);
  await aggregateStep.run(h.ctx, null);
  const names = ['labels.json', 'tally.json', 'cost.json', 'card.json', 'wild-seeds.json'];
  const before = names.map((n) => readFileSync(join(h.ctx.paths.dir, n), 'utf8'));
  await aggregateStep.run(h.ctx, null);
  assert.deepEqual(names.map((n) => readFileSync(join(h.ctx.paths.dir, n), 'utf8')), before);
  rmSync(h.dir, { recursive: true });
});

test('08 counts the sealed call and task records (forecasters, matchers) in cost.json and the void counts', async () => {
  const h = harness();
  fullRound(h.ctx);
  const sealed = (rel: string, value: unknown): void => {
    const path = join(h.ctx.paths.sealed, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  };
  sealed('calls/match-W1-xAI-a1.json', { backend: 'judge-x', tokens_in: 20, tokens_out: 4, cost_usd: 0.125 });
  sealed('calls/forecast-gw-a1.json', { backend: 'gw', tokens_in: 7, tokens_out: 3, cost_usd: null });
  sealed('tasks/match-W1-xAI.json', {
    id: 'match-W1-xAI', backend: 'judge-x', family: 'xAI', model: 'm', role_sha256: 'a'.repeat(64), prompt_sha256: 'b'.repeat(64), status: 'void', attempts: 2,
    error: 'bad fence', text: '', text_sha256: 'c'.repeat(64), served_model: null, version: null, calls: ['match-W1-xAI-a1', 'match-W1-xAI-a2'], finished_at: '2026-10-01T01:00:00.000Z',
  });
  const out = await aggregateStep.run(h.ctx, null);
  if (out.kind !== 'done') throw new Error(`expected done, got ${out.kind}`);
  const cost = readOut(h.ctx, 'cost.json');
  assert.deepEqual(pick(cost, ['total_usd', 'unpriced_calls']), { total_usd: 0.625, unpriced_calls: 1 });
  assert.deepEqual(Object.keys(readRecord(cost, 'by_backend') ?? {}), ['gw', 'judge-x']);
  assert.deepEqual(readRecord(readRecord(cost, 'by_backend'), 'judge-x'), { attempts: 3, tokens_in: 40, tokens_out: 14, cost_usd: 0.625, unpriced_calls: 0 });
  assert.deepEqual(readRecord(readOut(h.ctx, 'tally.json'), 'voids'), { calls: 4, void_tasks: 2, retried_tasks: 3, session_reruns: 1, dropped_families: 1 });
  assert.ok(!out.inputs.some((r) => r.startsWith('.sealed/')), 'sealed records are counted, never listed');
  rmSync(h.dir, { recursive: true });
});

test('08 with an invalid unseal (07b skipped) and no aux pairs (06c skipped)', async () => {
  const h = harness();
  fullRound(h.ctx, { surprise: false, auxPairs: false });
  const out = await aggregateStep.run(h.ctx, null);
  if (out.kind !== 'done') throw new Error(`expected done, got ${out.kind}`);
  assert.ok(!out.inputs.some((r) => r.endsWith('surprise.json') || r.includes('taste/aux/')));
  const tally = readOut(h.ctx, 'tally.json');
  assert.deepEqual(readArray(tally, 'aux_pairs'), []);
  assert.deepEqual(readRecord(tally, 'ordering'), { W1: 1, 'W2-r2': 1, W3: 1 });
  for (const sub of ['W1', 'W2-r2', 'W3']) assert.deepEqual(readRecord(readRecord(readRecord(tally, 'measures'), sub), 'surprise'), { status: 'invalid', surprising: 0, eligible: 0 });
  assert.deepEqual(readArray(readOut(h.ctx, 'card.json'), 'flags'), ['surprise_invalid', 'probe_remote_unavailable']);
  rmSync(h.dir, { recursive: true });
});

test('08 never reads a surprise.json left by an earlier run once unseal.json turned invalid (07b skipped on redo)', async () => {
  const h = harness();
  fullRound(h.ctx);
  put(h.ctx, 'unseal.json', { round: 'R01', status: 'invalid', reasons: ['seal: mismatch'], remote: 'verified', forecasters: 0, checked_at: '2026-10-01T03:00:00.000Z' });
  const out = await aggregateStep.run(h.ctx, null);
  if (out.kind !== 'done') throw new Error(`expected done, got ${out.kind}`);
  assert.ok(!out.inputs.includes('rounds/R01/surprise.json'));
  const tally = readOut(h.ctx, 'tally.json');
  for (const sub of ['W1', 'W2-r2', 'W3']) assert.deepEqual(readRecord(readRecord(readRecord(tally, 'measures'), sub), 'surprise'), { status: 'invalid', surprising: 0, eligible: 0 });
  const entries = readArray(readOut(h.ctx, 'card.json'), 'entries') ?? [];
  assert.ok(entries.every((e) => !(readArray(e, 'flags') ?? []).includes('acceptor_reused')));
  rmSync(h.dir, { recursive: true });
});

test('08: a missing or malformed earlier output is an integrity error (exit 3), nothing written', async () => {
  const cases: Array<{ name: string; spoil: (ctx: StepContext) => void; want: RegExp }> = [
    { name: 'missing producer file', spoil: (ctx) => rmSync(join(ctx.paths.measures, 'producer', 'W3.json')), want: /measures\/producer\/W3\.json is missing/u },
    { name: 'malformed gate file', spoil: (ctx) => put(ctx, 'gate/W1.json', { outcome: 'maybe' }), want: /gate\/W1\.json: expected outcome/u },
    { name: 'unreadable pairs.json', spoil: (ctx) => writeFileSync(join(ctx.paths.dir, 'pairs.json'), '{'), want: /pairs\.json/u },
    { name: 'ok skin-swap without a verdict', spoil: (ctx) => put(ctx, 'measures/skin-swap/W1.json', { status: 'ok', verdict: null }), want: /verdict\.recognised/u },
    { name: 'malformed task record', spoil: (ctx) => put(ctx, 'tasks/recall-W1-xAI.json', { id: 'recall-W1-xAI' }), want: /tasks\/recall-W1-xAI\.json/u },
    { name: 'valid unseal without surprise.json', spoil: (ctx) => rmSync(join(ctx.paths.dir, 'surprise.json')), want: /surprise\.json is missing/u },
    {
      name: 'surprise.json without a passing submission', want: /surprise\.json: no report for gate-passing submission W3/u,
      spoil: (ctx) => {
        const file = readRecord({ v: JSON.parse(readFileSync(join(ctx.paths.dir, 'surprise.json'), 'utf8')) }, 'v') ?? {};
        const subs = { ...readRecord(file, 'submissions') };
        delete subs['W3'];
        put(ctx, 'surprise.json', { ...file, submissions: subs });
      },
    },
  ];
  for (const c of cases) {
    const h = harness();
    fullRound(h.ctx);
    c.spoil(h.ctx);
    await assert.rejects(aggregateStep.run(h.ctx, null), (e: unknown) => e instanceof IntegrityError && c.want.test(e.message), c.name);
    assert.equal(existsSync(join(h.ctx.paths.dir, 'tally.json')), false, `${c.name}: nothing written`);
    rmSync(h.dir, { recursive: true });
  }
});

test('buildRoundTally: bars only tighten (8/8), shadow families never count even when they win, ids sort by code unit', () => {
  const h = harness();
  fullRound(h.ctx);
  champion(h.ctx, 'W3', 'OpenAI', 'ww', { shadow: true });
  const tallyOf = (bar: 7 | 8): RoundTally => buildRoundTally({
    round: 'R01', benchmark: 'v1', champion: 'owner_pick', sessionPairs: 2, barFourFamilies: bar, labels: { W3: 'C', W1: 'A' },
    championPairs: ['W3', 'W1'].map((id) => ({ pair: id, submission: id, sessions: pairVerdicts(h.ctx.root, 'R01', id) })),
    auxPairs: [], gate: { W3: 'pass', W1: 'pass' }, measures: {}, voids: { calls: 0, void_tasks: 0, retried_tasks: 0, session_reruns: 0, dropped_families: 0 },
  });
  const eight = tallyOf(8);
  assert.deepEqual(eight.champion_pairs.map((p) => [p.submission, p.bar, p.needed, p.total_wins, p.beats_champion]), [['W1', '8/8', 8, 7, false], ['W3', 'trial', 4, 3, false]]);
  assert.equal(tallyOf(7).champion_pairs[0]?.beats_champion, true);
  const w3 = eight.champion_pairs[1];
  assert.deepEqual([w3?.e, w3?.shadow, w3?.trial], [['Anthropic', 'Moonshot'], ['OpenAI'], true]);
  assert.deepEqual(Object.keys(eight.gate), ['W1', 'W3']);
  rmSync(h.dir, { recursive: true });
});
