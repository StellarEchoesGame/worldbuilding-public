import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bookkeepingCommitStep, championStep, forecastPoolStep, pickChampion, taggingStep, unsealPublishStep, wikiListStep, wikiPages } from './bookkeeping.ts';
import { readChampions } from './champions.ts';
import { loadConfig } from './config.ts';
import { buildContext, type RoundBackends, type StepContext } from './context.ts';
import { buildFreeze } from './freeze.ts';
import { isRecord } from './json.ts';
import { readMirrorLog } from './mirror-log.ts';
import type { Decision, DecisionFact } from './owner-inputs.ts';
import { probeCommentBody } from './probe.ts';
import { runSteps, type StepDef } from './runner.ts';
import { seal } from './seal.ts';
import { agreementStep } from './steps/agreement.ts';
import { loadRowAliases, loadRows, type BriefJson } from './steps/brief.ts';
import { roundPaths, sha256 } from './store.ts';
import { loadSubmission } from './submission.ts';
import { unwrap } from './tasks/fenced.ts';
import { checkTags } from './thinmap.ts';
import { fakePorts, type FakePorts } from './testing/fakes.ts';
import { DEFAULT_FIXTURE, FIXTURE_AT, FIXTURE_WRITER_MODEL, fixtureWorld, type FixtureWorld } from './testing/fixture-world.ts';
import { callLog, fakeRouter, type FakeRouter } from './testing/scripted.ts';

// Step-level bookkeeping tests (11a–11l) over a fixture world; the pure helpers are in bookkeeping.test.ts.

const ISSUE = 12;
const START = '2026-10-01T00:00:00.000Z';
const SCENE = '温芮把借来的扳手挂回母舰第三邻里的工具墙。循环泵换了节拍，走廊里的灯带转成琥珀色。林澈把冷凝管的旧滤网装进编号袋。';
const Q1 = '温芮把借来的扳手挂回母舰第三邻里的工具墙';
const Q2 = '林澈把冷凝管的旧滤网装进编号袋';
const OUTSIDE = '母舰的储水罐漏了一夜';
const CANON_05 = { file: 'reference/05-ecology-and-everyday.md', quote: '温芮在远航号的第三邻里长大，她记得每一台循环泵的节拍。' };
const D8 = '0123abcd';

const fence = (v: unknown): string => `\`\`\`json\n${JSON.stringify(v)}\n\`\`\``;
const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
const put = (path: string, text: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const readObj = (path: string): Record<string, unknown> => { const v: unknown = JSON.parse(readFileSync(path, 'utf8')); if (!isRecord(v)) throw new Error(path); return v; };
const scene = (quote: string): { file: string; quote: string } => ({ file: 'reference/09-scenes-and-people.md', quote });
const surprises = (h: H): unknown[] => readFileSync(join(h.w.root, 'regression/forecast-pool.jsonl'), 'utf8').trim().split('\n').map((l): unknown => { const v: unknown = JSON.parse(l); return isRecord(v) ? v['surprise'] : 'bad'; });
const MATCHERS = ['Anthropic', 'OpenAI'];
/** A sealed 07b matcher task record as task.ts writes it (parseTaskRecord accepts it). */
const matchRecord = (id: string, family: string, status: 'ok' | 'void'): Record<string, unknown> => ({
  id, backend: `J-${family}`, family, model: 'm', role_sha256: 'a'.repeat(64), prompt_sha256: 'b'.repeat(64), status, attempts: 1, error: status === 'void' ? 'timeout' : null,
  text: '', text_sha256: sha256(''), served_model: null, version: null, calls: [`${id}-a1`], finished_at: START,
});
const lines = (h: H): number => (existsSync(join(h.w.root, 'regression/forecast-pool.jsonl')) ? readFileSync(join(h.w.root, 'regression/forecast-pool.jsonl'), 'utf8').split('\n').filter((l) => l !== '').length : 0);

const writer = (text: string): string => ['```submission', text, '```', '```delta', '{"new_proper_nouns":[],"claims":[]}', '```', '```interface', '{"shots":[{},{},{}],"object":{"n":1},"hook":{"h":1}}', '```', '种子：', '- 一'].join('\n');

function brief(round: string, seed: string): BriefJson {
  return {
    round, kind: 'round', row_id: 'SHIP', layer: 'object', topic_source: 'fixed',
    cell: { id: 'E2E-R01', row_id: 'SHIP', title: '母舰 · 邻里常态日', entity: '远航号上的一个邻里', time: '任一常态日', layers: ['物件'], setting_notes: [], protagonists: ['温芮'], forbidden: [], stances: [{ id: 'd', text: '一天' }] },
    canon: { revision: '8.1', book_sha256: 'a'.repeat(64), reference_sha256: 'b'.repeat(64) },
    canon_passages: [], facts: [], regression: [], regression_stale: [], forbidden: [], cliches: [], requirements: [], interface_requirements: [], aliases: ['远航号'], seed, created_at: START,
  };
}

interface Opts {
  round?: string;
  /** Champion pairs of A (W1, DeepSeek) and B (W2, Moonshot). */
  aBeats?: boolean; bBeats?: boolean;
  base?: string | null; facts?: DecisionFact[];
  remote?: 'verified' | 'unavailable'; merged?: boolean;
  /** Reviewer verdict per offered (row, quote). */
  review?: (row: string, quote: string) => 'keep' | 'dispute';
  /** Status of both 07b matcher records of W1 (`.sealed/RNN/tasks/match-W1-<family>.json`). */
  matchStatus?: 'ok' | 'void';
}

interface H { w: FixtureWorld; ports: FakePorts; ctx: StepContext; routers: FakeRouter[]; decision: Decision; round: string }

const tagRoute = (): string => fence({ tags: [{ row_id: 'SHIP', layer: 'object', quotes: [Q1, Q2, OUTSIDE], dangling: [] }, { row_id: 'P-林澈', layer: '人物愿望', quotes: [Q2], dangling: ['编号袋'] }] });

function reviewRoute(review: (row: string, quote: string) => 'keep' | 'dispute'): (prompt: string) => string {
  return (prompt) => {
    const items = (unwrap(prompt, '标注') ?? '').split('\n').map((l) => l.split('｜'));
    return fence({ reviews: items.map(([id, row, , quote]) => ({ id, verdict: review(row ?? '', quote ?? ''), reason: '理由' })) });
  };
}

/** Fixture world with a round through 10f written by hand (engine files only), freeze marked by a toy 02c. */
async function harness(opts: Opts = {}): Promise<H> {
  const round = opts.round ?? 'R01';
  const branch = `forge/${round.toLowerCase()}`;
  const seed = 'c'.repeat(16);
  const w = fixtureWorld(mkdtempSync(join(tmpdir(), 'forge-bookkeeping-')), DEFAULT_FIXTURE);
  const loaded = loadConfig(w.root, { requireLocal: true });
  if (!loaded.ok) throw new Error(loaded.error);
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: START, seed: 'bk' });
  const baseSha = await ports.git.resolveRef('main');
  assert.ok(baseSha.ok && (await ports.git.createBranch(branch, 'main')).ok && (await ports.git.checkout(branch)).ok);
  const routes = { tag: tagRoute, tagreview: reviewRoute(opts.review ?? (() => 'keep')) };
  const routers: FakeRouter[] = [];
  const judges = loaded.value.judges.map((j) => {
    const r = fakeRouter(routes, { id: j.id, family: j.family, model: j.model });
    routers.push(r);
    return { backend: r, concurrency: j.concurrency };
  });
  const plain = fakeRouter({}, { id: 'W1', family: 'DeepSeek', model: FIXTURE_WRITER_MODEL });
  const backends: RoundBackends = { writers: [{ slot: 'W1', backend: plain }], baseline: plain, decoy: plain, defect: plain, judges, forecasters: [], maintainer: plain, mergeEditor: plain, calibGateway: new Map() };
  const built = buildContext({
    root: w.root, repo: w.repo, roundId: round, pipeline: 'round', paths: roundPaths(w.root, round), config: loaded.value,
    deps: { ports, backends: () => backends, env: {}, pid: 1001, isAlive: (p) => p === 1001, log: () => undefined }, startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
  });
  if (!built.ok) throw new Error(built.error);
  const paths = built.value.paths;
  const briefText = json(brief(round, seed));
  put(paths.start, json({ round, seed, branch, base_sha: baseSha.value, issue: { number: ISSUE, url: `https://github.invalid/i/${ISSUE}` }, bundle_sha256: built.value.bundleSha256, doctor_sha256: sha256('d'), started_at: START, cell: null }));
  put(paths.brief, briefText);
  const v1 = 'benchmark/v1.json';
  const toyFreeze: StepDef = {
    id: '02c-freeze',
    run: async (c) => {
      const record = buildFreeze({
        round, files: { 'brief.json': briefText }, benchmarkVersion: 'v1', eligibleFamilies: ['Anthropic', 'Moonshot', 'OpenAI', 'xAI'], flags: { Anthropic: 'ok', Moonshot: 'ok', OpenAI: 'ok', xAI: 'ok' },
        protocolBundleSha256: c.bundleSha256, probeCreatedAt: null, seed, gateFamilies: ['Anthropic', 'Moonshot', 'OpenAI', 'xAI'], trustStatusSha256: null, skills: {},
        benchmarkResolution: { version: 'v1', sha256: sha256(readFileSync(join(c.root, v1), 'utf8')), path: v1, via: 'activate', since: FIXTURE_AT },
      });
      return { kind: 'done', inputs: [], outputs: [c.files.writeJson(c.paths.freeze, record)], external: [] };
    },
  };
  const frozen = await runSteps(built.value, { pipeline: 'round', steps: [toyFreeze], until: null, from: null, redoFrom: null, pid: 1001, isAlive: (p) => p === 1001 });
  assert.equal(frozen.exitCode, 0, frozen.detail);
  // 03b seal + 03c probe comment + 07a unseal.json + 07b surprise.json
  const sealedValue = {
    round, row_id: 'SHIP', brief_sha256: sha256(briefText),
    forecasts: [
      { forecaster: 'fc-a', family: 'Anthropic', model: 'm-a', writer_model: false, items: [{ slot: '物件', value: '铝饭盒' }, { slot: '声音', value: '泵声' }] },
      { forecaster: 'gw-deepseek', family: 'DeepSeek', model: FIXTURE_WRITER_MODEL, writer_model: true, items: [{ slot: '气味', value: '菌毯味' }] },
    ],
  };
  const s = seal(sealedValue, Buffer.alloc(32, 7));
  put(join(paths.sealed, 'sealed.json'), s.canonical);
  put(join(paths.sealed, 'nonce.hex'), `${s.nonceHex}\n`);
  put(paths.probes, `${s.probe}\n`);
  const comment = ports.github.inject(ISSUE, probeCommentBody(round, s.probe, 'a'.repeat(40)), 'OWNER');
  put(join(paths.dir, 'probe.json'), json({ probe: s.probe, branch, commit: 'a'.repeat(40), issue: ISSUE, comment_id: comment.id, comment_url: comment.url, created_at: comment.createdAt, mirrored_at: comment.createdAt, attempts: 1 }));
  put(join(paths.dir, 'unseal.json'), json({ round, status: 'valid', reasons: [], remote: opts.remote ?? 'verified', forecasters: 2, checked_at: START }));
  const tasks = MATCHERS.map((f) => `match-W1-${f}`);
  const w1 = { submission: 'W1', status: 'match_only', details: [{ forecasts: ['P02'] }], tasks, roles: { matchers: MATCHERS, chain_writer: null, acceptor: null } };
  put(join(paths.dir, 'surprise.json'), json({ round, remote: 'verified', submissions: { W1: w1 } }));
  for (const [i, f] of MATCHERS.entries()) put(join(paths.sealedTasks, `${tasks[i] ?? ''}.json`), json(matchRecord(tasks[i] ?? '', f, opts.matchStatus ?? 'ok')));
  // 04 submissions, 08 labels + tally
  put(join(paths.submissions, 'W1.json'), JSON.stringify({ id: 'W1', kind: 'writer', model: FIXTURE_WRITER_MODEL, family: 'DeepSeek', stance: 'd', ok: true, error: null, text: writer('温芮把扳手挂回工具墙。灯带转成琥珀色。') }));
  put(join(paths.submissions, 'W2.json'), JSON.stringify({ id: 'W2', kind: 'writer', model: 'kimi-fixture', family: 'Moonshot', stance: 'd', ok: true, error: null, text: writer('林澈把旧滤网装进编号袋。循环泵换了节拍。') }));
  put(join(paths.dir, 'labels.json'), json({ A: 'W1', B: 'W2' }));
  const pair = (label: string, submission: string, beats: boolean): Record<string, unknown> => ({ pair: `${submission}-BASE`, label, submission, beats_champion: beats, trial: false });
  put(join(paths.dir, 'tally.json'), json({ v: 2, round, champion_pairs: [pair('A', 'W1', opts.aBeats ?? true), pair('B', 'W2', opts.bBeats ?? false)] }));
  const decision: Decision = {
    round, pick: 'A', pick_submission: 'W1', base: opts.base ?? null, champion: 'BASE', facts: opts.facts ?? [], reason: '平', fav: 'A', publish: 'yes', happened: false,
    supersedes: null, decided_at: START, file: `rounds/${round}/decision.json`,
  };
  // 10c–10f: the committed scene, merge.json, the tags and snapshot before tagging
  if (opts.merged ?? true) {
    put(join(paths.dir, 'merge.json'), json({ round, current: D8, decision_sha256: 'e'.repeat(64), status: 'merged_on_branch', revision: '8.2', reasons: [] }));
    put(join(paths.dir, 'merge', D8, 'edit.json'), json({ editor: 'llm', task: `merge-${D8}`, title: '工具墙', edit: { files: {}, scene: SCENE, rxx: [] } }));
    put(join(w.repo, 'world/current/reference/09-scenes-and-people.md'), `# 样本现场\n\n${SCENE}\n`);
  }
  put(join(w.root, 'map/tags.json'), json({ cells: { SHIP: { object: { quotes: [CANON_05], dangling: [] } } } }));
  put(join(w.root, 'map/snapshot-r0.json'), json({ revision: '8.1', cells: { SHIP: { object: 1 } } }));
  return { w, ports, ctx: { ...built.value, decision: () => decision }, routers, decision, round };
}

const calls = (h: H): string[] => h.routers.flatMap(callLog).sort();

test('11a: verified seal copied to unsealed/ with 07a remote kept; 07a unavailable → GitHub recheck; a broken nonce publishes nothing', async () => {
  const h = await harness();
  const out = await unsealPublishStep.run(h.ctx, null);
  assert.equal(out.kind, 'done');
  const dir = h.ctx.paths.dir;
  assert.equal(readFileSync(join(dir, 'unsealed/sealed.json'), 'utf8'), readFileSync(join(h.ctx.paths.sealed, 'sealed.json'), 'utf8'));
  assert.equal(readFileSync(join(dir, 'unsealed/nonce.hex'), 'utf8'), readFileSync(join(h.ctx.paths.sealed, 'nonce.hex'), 'utf8'));
  assert.deepEqual(readObj(join(dir, 'unsealed/recheck.json')), { round: 'R01', seal: 'verified', remote: 'verified', published: true, checked_at: START });
  assert.ok(out.kind === 'done' && out.outputs.includes('rounds/R01/unsealed/recheck.json') && out.outputs.length === 3);
  assert.equal(h.ports.github.calls().filter((c) => c.op === 'listComments').length, 0, '07a verified: no recheck');
  const unsealBefore = readFileSync(join(dir, 'unseal.json'), 'utf8');

  const u = await harness({ remote: 'unavailable' });
  await unsealPublishStep.run(u.ctx, null);
  assert.equal(readObj(join(u.ctx.paths.dir, 'unsealed/recheck.json'))['remote'], 'verified');
  assert.equal(u.ports.github.calls().filter((c) => c.op === 'listComments').length, 1);
  u.ports.github.failNext('listComments', 1);
  await unsealPublishStep.run(u.ctx, null);
  assert.equal(readObj(join(u.ctx.paths.dir, 'unsealed/recheck.json'))['remote'], 'unavailable');

  const b = await harness();
  writeFileSync(join(b.ctx.paths.sealed, 'nonce.hex'), `${'0'.repeat(64)}\n`);
  await unsealPublishStep.run(b.ctx, null);
  assert.deepEqual(readObj(join(b.ctx.paths.dir, 'unsealed/recheck.json')), { round: 'R01', seal: 'mismatch', remote: 'verified', published: false, checked_at: START });
  assert.ok(!existsSync(join(b.ctx.paths.dir, 'unsealed/sealed.json')));
  assert.equal(readFileSync(join(dir, 'unseal.json'), 'utf8'), unsealBefore, "07a's unseal.json is never rewritten");
});

test('11b: one pool line per forecast item from the published seal; a second run skips (idempotent); no published seal → skip', async () => {
  const h = await harness();
  assert.equal((await forecastPoolStep.run(h.ctx, null)).kind, 'skip', 'before 11a nothing is published');
  await unsealPublishStep.run(h.ctx, null);
  const out = await forecastPoolStep.run(h.ctx, null);
  const records = MATCHERS.map((f) => `.sealed/R01/tasks/match-W1-${f}.json`);
  assert.deepEqual(out, { kind: 'done', inputs: ['rounds/R01/unsealed/sealed.json', 'rounds/R01/surprise.json', 'rounds/R01/brief.json', ...records], outputs: [], external: [] });
  const pool = readFileSync(join(h.w.root, 'regression/forecast-pool.jsonl'), 'utf8').trim().split('\n').map((l): unknown => JSON.parse(l));
  assert.deepEqual(pool.map((l) => (isRecord(l) ? [l['forecaster'], l['value'], l['surprise'], l['row_id']] : null)), [['fc-a', '铝饭盒', 'unmatched', 'SHIP'], ['fc-a', '泵声', 'forecast', 'SHIP'], ['gw-deepseek', '菌毯味', 'unmatched', 'SHIP']]);
  const again = await forecastPoolStep.run(h.ctx, null);
  assert.equal(again.kind, 'skip');
  assert.equal(lines(h), 3);
});

test('11b: both sealed matcher records void → surprise null (no comparison happened); a listed matcher record missing → integrity', async () => {
  const v = await harness({ matchStatus: 'void' });
  await unsealPublishStep.run(v.ctx, null);
  assert.equal((await forecastPoolStep.run(v.ctx, null)).kind, 'done');
  assert.deepEqual(surprises(v), [null, null, null]);
  const m = await harness();
  await unsealPublishStep.run(m.ctx, null);
  rmSync(join(m.ctx.paths.sealedTasks, 'match-W1-OpenAI.json'));
  await assert.rejects(forecastPoolStep.run(m.ctx, null), /match-W1-OpenAI.*missing/u);
  assert.equal(lines(m), 0);
});

test('11c: champion unchanged unless the pick beat it — also when base ≠ pick with donors that beat it; the pick text, never the merged scene', async () => {
  const donor: DecisionFact = { label: 'B', submission: 'W2', id: 'F1', claim: '旧滤网装进编号袋' };
  const before = readFileSync(join((await harness()).w.root, 'champions.json'), 'utf8');
  for (const opts of [{ aBeats: false }, { aBeats: false, bBeats: true, base: 'B', facts: [donor] }]) {
    const h = await harness(opts);
    const out = await championStep.run(h.ctx, null);
    assert.equal(out.kind, 'skip');
    assert.equal(readFileSync(join(h.w.root, 'champions.json'), 'utf8'), before);
  }
  const trial = await harness();
  writeFileSync(join(trial.ctx.paths.dir, 'tally.json'), json({ champion_pairs: [{ label: 'A', submission: 'W1', beats_champion: true, trial: true }] }));
  assert.equal((await championStep.run(trial.ctx, null)).kind, 'skip', 'a trial pair never replaces a champion');

  const h = await harness({ aBeats: true, base: 'B', facts: [donor] });
  const out = await championStep.run(h.ctx, null);
  assert.deepEqual(out, { kind: 'done', inputs: ['rounds/R01/tally.json', 'rounds/R01/submissions/W1.json'], outputs: [], external: ['champions.json'] });
  const table = readChampions(h.w.root);
  assert.ok(table.ok);
  const ship = table.value['SHIP'];
  assert.deepEqual(ship && [ship.kind, ship.round, ship.submission, ship.authors, ship.text, ship.previous.map((p) => p.round)], ['owner_pick', 'R01', 'W1', ['DeepSeek'], '温芮把扳手挂回工具墙。灯带转成琥珀色。', ['P00']]);
  assert.equal((await championStep.run(h.ctx, null)).kind, 'done', 'rerun: present, unchanged');
  assert.deepEqual(readChampions(h.w.root), table);
  const sub = loadSubmission(h.ctx.paths, 'W1');
  assert.ok(sub !== null);
  assert.equal(pickChampion({ round: 'R01', rowId: 'SHIP', decision: { ...h.decision, pick: 'none' }, tally: { champion_pairs: [] }, submission: sub, family: 'DeepSeek', at: START }), null);
});

test('11d: tagger quote outside the scene dropped, disputed quote only in tagging.json, all_targets_above when 2 object quotes join a 1-valued cell', async () => {
  const h = await harness({ facts: [{ label: 'B', submission: 'W2', id: 'F1', claim: 'c' }], review: (row) => (row === 'SHIP' ? 'keep' : 'dispute') });
  const out = await taggingStep.run(h.ctx, null);
  assert.deepEqual(out, {
    kind: 'done', inputs: ['rounds/R01/merge.json', `rounds/R01/merge/${D8}/edit.json`, 'rounds/R01/brief.json', 'map/snapshot-r0.json'],
    outputs: ['rounds/R01/tagging.json', 'rounds/R01/thinmap-delta.json'], external: ['map/tags.json'],
  });
  const tagging = readObj(join(h.ctx.paths.dir, 'tagging.json'));
  assert.deepEqual(tagging['touched'], ['P-林澈', 'P-温芮', 'SHIP']);
  const tagger = tagging['tagger'];
  const reviewer = tagging['reviewer'];
  assert.ok(isRecord(tagger) && isRecord(reviewer) && tagger['status'] === 'ok' && reviewer['status'] === 'ok');
  const families = [tagger['family'], reviewer['family']];
  assert.ok(families[0] !== families[1] && !families.includes('Moonshot') && !families.includes('DeepSeek'), 'two distinct families, neither a source author');
  assert.deepEqual(calls(h), [`tag-R01-${String(tagger['family'])}#1`, `tagreview-R01-${String(reviewer['family'])}#1`].sort());
  assert.ok(!JSON.stringify(tagging['proposals']).includes(OUTSIDE), 'the quote outside the scene is dropped by the parser');
  assert.deepEqual(tagging['disputed'], [{ row_id: 'P-林澈', layer: 'character_want', quote: Q2, verdict: 'dispute', reason: '理由' }]);
  const tags = readFileSync(join(h.w.root, 'map/tags.json'), 'utf8');
  assert.deepEqual(readObj(join(h.w.root, 'map/tags.json')), { cells: { SHIP: { object: { quotes: [CANON_05, scene(Q1), scene(Q2)], dangling: [] } } } }, 'the disputed P-林澈 quote stays out');
  const delta = readObj(join(h.ctx.paths.dir, 'thinmap-delta.json'));
  const rows: unknown = delta['rows'];
  assert.ok(Array.isArray(rows));
  assert.deepEqual(rows.filter((r) => isRecord(r) && r['target'] === true), [{ row_id: 'SHIP', layer: 'object', r0: 1, now: 2, target: true, above_r0: true }]);
  assert.equal(rows.length, 21, '3 touched rows × 7 layers');
  assert.equal(delta['snapshot'], 'present');
  assert.equal(delta['all_targets_above'], true);
  await taggingStep.run(h.ctx, null);
  assert.equal(readFileSync(join(h.w.root, 'map/tags.json'), 'utf8'), tags, 'rerun: stored task records, deduped tags');
});

test('11d: every quote disputed → the cell stays at 1, all_targets_above false (reported, not a gate); no merge.json → skip', async () => {
  const h = await harness({ review: () => 'dispute' });
  assert.equal((await taggingStep.run(h.ctx, null)).kind, 'done');
  assert.equal(readObj(join(h.ctx.paths.dir, 'thinmap-delta.json'))['all_targets_above'], false);
  assert.deepEqual(readObj(join(h.ctx.paths.dir, 'tagging.json'))['kept'], []);
  assert.deepEqual(readObj(join(h.w.root, 'map/tags.json')), { cells: { SHIP: { object: { quotes: [CANON_05], dangling: [] } } } });
  const none = await harness({ merged: false });
  assert.deepEqual(await taggingStep.run(none.ctx, null), { kind: 'skip', reason: 'no merge.json (nothing merged this round)' });
  assert.deepEqual(calls(none), []);
});

test('11d: no map/snapshot-r0.json → thinmap-delta snapshot missing, r0 null, all_targets_above false (never a zero baseline)', async () => {
  const h = await harness({ review: (row) => (row === 'SHIP' ? 'keep' : 'dispute') });
  rmSync(join(h.w.root, 'map/snapshot-r0.json'));
  const out = await taggingStep.run(h.ctx, null);
  assert.ok(out.kind === 'done' && !out.inputs.includes('map/snapshot-r0.json'));
  const { rows, ...delta } = readObj(join(h.ctx.paths.dir, 'thinmap-delta.json'));
  assert.deepEqual(delta, { round: 'R01', snapshot: 'missing', all_targets_above: false }, 'the object cell rose to 2, yet nothing is above an absent baseline');
  assert.ok(Array.isArray(rows) && rows.length === 21);
  assert.deepEqual(rows.filter((r) => isRecord(r) && r['target'] === true), [{ row_id: 'SHIP', layer: 'object', r0: null, now: 2, target: true, above_r0: false }]);
  assert.ok(rows.every((r) => isRecord(r) && r['r0'] === null && r['above_r0'] === false));
  writeFileSync(join(h.w.root, 'map/snapshot-r0.json'), '{ not json');
  await assert.rejects(taggingStep.run(h.ctx, null), /snapshot-r0\.json/u, 'a malformed snapshot stays an integrity error');
});

test('11d: no map/tags.json → created with only the kept quotes, and forge thinmap accepts it', async () => {
  const h = await harness({ review: (row) => (row === 'SHIP' ? 'keep' : 'dispute') });
  rmSync(join(h.w.root, 'map/tags.json'));
  assert.equal((await taggingStep.run(h.ctx, null)).kind, 'done');
  const tags = readObj(join(h.w.root, 'map/tags.json'));
  assert.deepEqual(tags, { cells: { SHIP: { object: { quotes: [scene(Q1), scene(Q2)], dangling: [] } } } });
  const [rows, aliases] = [loadRows(h.w.root), loadRowAliases(h.w.root)];
  assert.ok(rows.ok && aliases.ok);
  const rowIds = [...rows.value.map((r) => r.row_id), ...aliases.value.filter((a) => a.kind === 'character').map((a) => a.row_id)];
  assert.deepEqual(checkTags(tags, rowIds), []);
});

test('11k: wiki list only on R03 / R06 — pages (and i18n twins) naming a touched row or an Rxx; pages never rewritten', async () => {
  const r1 = await harness();
  assert.equal((await wikiListStep.run(r1.ctx, null)).kind, 'skip');
  const h = await harness({ round: 'R03' });
  const page = (rel: string, text: string): void => put(join(h.w.repo, rel), text);
  page('wiki/src/content/docs/world/ark.md', '# 方舟\n\n远航号的邻里。\n');
  page('wiki/src/content/docs/world/places.md', '# 地点\n\n赤脊与冷湾。\n');
  page('wiki/src/content/docs/en/world/ark.md', '# Ark\n\nSee R03-01.\n');
  page('wiki/src/content/docs/guide/intro.md', '远航号\n');
  writeFileSync(join(h.ctx.paths.dir, 'merge', D8, 'edit.json'), json({ editor: 'llm', task: 't', title: 't', edit: { files: {}, scene: SCENE, rxx: ['R03-01'] } }));
  await taggingStep.run(h.ctx, null);
  const before = readFileSync(join(h.w.repo, 'wiki/src/content/docs/world/ark.md'), 'utf8');
  const out = await wikiListStep.run(h.ctx, null);
  assert.deepEqual(out, { kind: 'done', inputs: [], outputs: ['rounds/R03/wiki-pages.json'], external: [] });
  const file = readObj(join(h.ctx.paths.dir, 'wiki-pages.json'));
  assert.deepEqual(file, {
    round: 'R03', rounds: ['R03'], publish: { R03: 'yes' },
    pages: [
      { path: 'wiki/src/content/docs/world/ark.md', terms: ['远航号'], rounds: ['R03'] },
      { path: 'wiki/src/content/docs/en/world/ark.md', terms: ['R03-01'], rounds: ['R03'] },
    ],
  });
  assert.equal(readFileSync(join(h.w.repo, 'wiki/src/content/docs/world/ark.md'), 'utf8'), before);
  assert.deepEqual(wikiPages(h.w.repo, [{ round: 'R06', terms: ['冷湾', ''] }]), [{ path: 'wiki/src/content/docs/world/places.md', terms: ['冷湾'], rounds: ['R06'] }]);
});

test('crash in 11e → rerun skips 11a–11d: pool line count, tags and task calls unchanged, 11e completes', async () => {
  const h = await harness();
  const killed: StepDef = { id: '11e-agreement', run: async () => { throw new Error('killed in 11e'); } };
  const steps = [unsealPublishStep, forecastPoolStep, championStep, taggingStep];
  await assert.rejects(runSteps(h.ctx, { pipeline: 'round', steps: [...steps, killed], until: null, from: null, redoFrom: null, pid: 1001, isAlive: (p) => p === 1001 }), /killed in 11e/u);
  const pool = lines(h);
  const tags = readFileSync(join(h.w.root, 'map/tags.json'), 'utf8');
  const before = calls(h);
  assert.equal(pool, 3);
  const report = await runSteps(h.ctx, { pipeline: 'round', steps: [...steps, agreementStep], until: null, from: null, redoFrom: null, pid: 1002, isAlive: (p) => p === 1002 });
  assert.equal(report.exitCode, 0, report.detail);
  assert.equal(lines(h), pool);
  assert.equal(readFileSync(join(h.w.root, 'map/tags.json'), 'utf8'), tags);
  assert.deepEqual(calls(h), before);
  for (const id of ['11a-unseal-publish', '11b-forecast-pool', '11c-champion', '11d-tagging', '11e-agreement']) assert.ok(existsSync(join(h.ctx.paths.markers, `${id}.json`)), id);
});

test('11l: commits bookkeeping paths with chore: bookkeeping for RNN (#issue), pushes; push failure → blocked; the drain never changes the outcome', async () => {
  const h = await harness();
  await unsealPublishStep.run(h.ctx, null);
  await forecastPoolStep.run(h.ctx, null);
  assert.deepEqual(await bookkeepingCommitStep.run(h.ctx, null), { kind: 'done', inputs: [], outputs: [], external: [] });
  const commit = h.ports.git.commits('forge/r01').at(-1);
  assert.equal(commit?.message, 'chore: bookkeeping for R01 (#12)');
  const paths = commit?.paths ?? [];
  assert.ok(paths.includes('world/forge/rounds/R01/unsealed/sealed.json') && paths.includes('world/forge/regression/forecast-pool.jsonl') && paths.includes('world/forge/map/tags.json'));
  assert.ok(paths.every((p) => p.startsWith('world/forge/') && !p.includes('.sealed/')), 'forge files only, never the sealed dir');
  assert.deepEqual(h.ports.git.pushes(), ['forge/r01']);
  writeFileSync(join(h.w.root, 'champions.json'), `${readFileSync(join(h.w.root, 'champions.json'), 'utf8')}\n`);
  h.ports.git.failNext('push', 1);
  const blocked = await bookkeepingCommitStep.run(h.ctx, null);
  assert.equal(blocked.kind, 'blocked');
  assert.ok(blocked.kind === 'blocked' && blocked.detail.startsWith('git push forge/r01'));
  h.ports.git.failNext('commit', 1);
  const noCommit = await bookkeepingCommitStep.run(h.ctx, null);
  assert.ok(noCommit.kind === 'blocked' && noCommit.detail.startsWith('git commit: '), 'commit failure → blocked');
});

test('11l: a failing mirror drain (GitHub list error, unreadable mirror.jsonl) still ends done', async () => {
  const h = await harness();
  const logPath = join(h.w.root, 'benchmark/log.jsonl');
  // a bench_notice of this cycle is a pending mirror, so the drain has to list the issue comments
  const notice = { ...readObj(logPath), at: START, cycle: 'R01', outcome: 'pending_owner', version: 'v2', parent: 'v1', sha256: 'c'.repeat(64), path: 'benchmark/v2.json', activation: 'owner', changed_keys: ['cliches'], evidence_ids: ['E-R01-card-A'] };
  writeFileSync(logPath, `${readFileSync(logPath, 'utf8')}${JSON.stringify(notice)}\n`);
  h.ports.github.failNext('listComments', 1);
  const done = { kind: 'done', inputs: [], outputs: [], external: [] };
  assert.deepEqual(await bookkeepingCommitStep.run(h.ctx, null), done);
  const log = readMirrorLog(h.w.root, 'R01');
  assert.ok(log.ok && log.value.length === 1 && log.value[0]?.kind === 'bench_notice' && log.value[0].status === 'failed', 'the drain inside 11l did fail');
  writeFileSync(join(h.ctx.paths.dir, 'mirror.jsonl'), '{"bad":1}\n{"bad":2}\n');
  assert.deepEqual(await bookkeepingCommitStep.run(h.ctx, null), done, 'an unreadable mirror log stops the drain, not the step');
  assert.equal(h.ports.github.calls().filter((c) => c.op === 'createComment').length, 0);
});
