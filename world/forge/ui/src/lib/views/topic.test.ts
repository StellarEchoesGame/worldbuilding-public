import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { roundCommand } from '../../../../engine/cli-round.ts';
import { TOPIC_AUTO_DELAY_MS } from '../../../../engine/steps/topic.ts';
import { DEFAULT_GAME_NEED, LAYERS } from '../../../../engine/thinmap.ts';
import { deps, pickTopic, readObject, ROUND, world, type World } from '../../../../engine/testing/round-script.ts';
import { gameNeedRows, gameNeedState, heatmap, latestRound, topicRounds, topicView } from './topic.ts';

/*
 * 选题 view readers on the round-script fixture world (engine/testing/round-script.ts): `round start R01` without
 * --cell writes topic-offer.json and waits for the owner; owner-sim picks through submitTopic.
 */

const PID = 7101;

async function offered(): Promise<World> {
  const x = world();
  x.sim.approveProtocol();
  assert.equal(await roundCommand(['start', ROUND], deps(x, PID), x.at), 2, x.logs.join('\n'));
  return x;
}

function rowCount(x: World): number {
  const rows = readObject(join(x.w.root, 'map', 'rows.json'))['rows'];
  return Array.isArray(rows) ? rows.length : -1;
}

test('topicView: null for a bad id or a round without a directory', () => {
  const x = world();
  assert.equal(topicView(x.w.root, x.w.repo, 'R01'), null);
  assert.equal(topicView(x.w.root, x.w.repo, '../R01'), null);
});

test('topicView: the pending offer (top 3 with labels, auto time = offered_at + 24 h), no topic, the heat map agrees with the offer', async () => {
  const x = await offered();
  const view = topicView(x.w.root, x.w.repo, ROUND);
  assert.ok(view !== null);
  const file = readObject(join(x.w.root, 'rounds', ROUND, 'topic-offer.json'));
  assert.equal(view.offerError, null);
  assert.ok(view.offer !== null);
  assert.equal(view.offer.offeredAt, file['offered_at']);
  assert.equal(Date.parse(view.offer.autoAt) - Date.parse(view.offer.offeredAt), TOPIC_AUTO_DELAY_MS);
  assert.deepEqual(view.offer.top3.map((t) => ({ row_id: t.row_id, layer: t.layer, priority: t.priority })), file['top3']);
  for (const t of view.offer.top3) assert.ok(t.layerLabel !== '' && t.layerLabel !== t.layer, `label of ${t.layer}`);
  assert.equal(view.topic, null);
  assert.equal(view.topicProblem, null);
  assert.equal(view.wildRound, false);

  const map = view.heatmap;
  assert.deepEqual(map.errors, []);
  assert.equal(map.tagged, true, 'the fixture world has map/tags.json');
  assert.deepEqual(map.layers.map((l) => l.id), [...LAYERS]);
  assert.ok(map.rows.length >= rowCount(x));
  for (const r of map.rows) assert.deepEqual(r.cells.map((c) => c.layer), [...LAYERS]);
  const ranked = map.rows.flatMap((r) => r.cells.map((c) => ({ row_id: r.rowId, layer: c.layer, priority: c.priority })));
  const best = Math.max(...ranked.map((c) => c.priority));
  const top = view.offer.top3[0];
  assert.ok(top !== undefined);
  assert.equal(top.priority, best, 'the first offer is a highest-priority cell of the heat map');
  const ship = map.rows.find((r) => r.rowId === 'SHIP');
  assert.ok(ship !== undefined);
  assert.equal(ship.gameNeed, DEFAULT_GAME_NEED['SHIP']);
  assert.equal(ship.kind, 'ship');
  assert.equal(ship.primary, '远航号');
  assert.equal(typeof ship.connectivity, 'number');
});

test('topicView: after the owner picks, the chosen cell and source ui are shown and the offer stays', async () => {
  const x = await offered();
  pickTopic(x, join(x.w.root, 'rounds', ROUND));
  const view = topicView(x.w.root, x.w.repo, ROUND);
  assert.ok(view !== null && view.topic !== null && view.offer !== null);
  const first = view.offer.top3[0];
  assert.ok(first !== undefined);
  assert.equal(view.topic.row_id, first.row_id);
  assert.equal(view.topic.layer, first.layer);
  assert.equal(view.topic.source, 'ui');
  assert.equal(view.topic.cell, null);
  assert.equal(view.topicProblem, null);
  assert.deepEqual(topicRounds(x.w.root), [{ round: ROUND, offered: true, chosen: true }]);
});

test('topicView: a topic.json the owner log does not cover is read-only with the problem shown', async () => {
  const x = await offered();
  const dir = join(x.w.root, 'rounds', ROUND);
  writeFileSync(join(dir, 'topic.json'), `${JSON.stringify({ round: ROUND, row_id: 'SHIP', layer: 'object', cell: null, source: 'ui', chosen_at: '2026-10-01T00:00:00.000Z' }, null, 2)}\n`);
  const view = topicView(x.w.root, x.w.repo, ROUND);
  assert.ok(view !== null && view.topic !== null);
  assert.equal(view.topic.row_id, 'SHIP');
  assert.ok(view.topicProblem !== null);
  writeFileSync(join(dir, 'topic.json'), '{"torn');
  const torn = topicView(x.w.root, x.w.repo, ROUND);
  assert.ok(torn !== null);
  assert.equal(torn.topic, null);
  assert.ok(torn.topicProblem !== null, 'a present but unreadable topic.json still locks the page');
});

test('topicView: an unreadable offer is reported, not thrown', async () => {
  const x = await offered();
  writeFileSync(join(x.w.root, 'rounds', ROUND, 'topic-offer.json'), '{"round":"R01"}');
  const view = topicView(x.w.root, x.w.repo, ROUND);
  assert.ok(view !== null);
  assert.equal(view.offer, null);
  assert.ok(view.offerError !== null);
});

test('topicView: wild rounds (R04, R08 …) and earlier rounds\' wild seeds, newest round first', () => {
  const x = world();
  for (const r of ['R02', 'R03', 'R04', 'R05']) mkdirSync(join(x.w.root, 'rounds', r), { recursive: true });
  writeFileSync(join(x.w.root, 'rounds', 'R02', 'wild-seeds.json'), JSON.stringify({ round: 'R02', seeds: { W1: ['a', 'b', 'c'] } }));
  writeFileSync(join(x.w.root, 'rounds', 'R03', 'wild-seeds.json'), JSON.stringify({ round: 'R03', seeds: { W2: ['d', 'e', 'f'], W1: ['g', 'h', 'i'] } }));
  writeFileSync(join(x.w.root, 'rounds', 'R05', 'wild-seeds.json'), JSON.stringify({ round: 'R05', seeds: { W1: ['later'] } }));
  const view = topicView(x.w.root, x.w.repo, 'R04');
  assert.ok(view !== null);
  assert.equal(view.wildRound, true);
  assert.deepEqual(view.wildSeeds, [
    { round: 'R03', submission: 'W1', seeds: ['g', 'h', 'i'] },
    { round: 'R03', submission: 'W2', seeds: ['d', 'e', 'f'] },
    { round: 'R02', submission: 'W1', seeds: ['a', 'b', 'c'] },
  ]);
  assert.equal(topicView(x.w.root, x.w.repo, 'R03')?.wildRound, false);
  const r00 = join(x.w.root, 'rounds', 'R00');
  mkdirSync(r00, { recursive: true });
  assert.equal(topicView(x.w.root, x.w.repo, 'R00')?.wildRound, false, 'round 0 is never wild');
});

test('gameNeedState: default weights while the file is absent; the file once written; an error for a bad file', () => {
  const x = world();
  const file = join(x.w.root, 'map', 'game-need.json');
  rmSync(file, { force: true });
  assert.deepEqual(gameNeedState(x.w.root), { exists: false, weights: { ...DEFAULT_GAME_NEED }, error: null });
  writeFileSync(file, JSON.stringify({ weights: { SHIP: 3 } }));
  assert.deepEqual(gameNeedState(x.w.root), { exists: true, weights: { SHIP: 3 }, error: null });
  writeFileSync(file, JSON.stringify({ weights: { SHIP: -1 } }));
  const bad = gameNeedState(x.w.root);
  assert.equal(bad.exists, true);
  assert.ok(bad.error !== null);
  assert.deepEqual(bad.weights, { ...DEFAULT_GAME_NEED });
});

test('heatmap: game need from the file orders the cells; a missing rows file is an error with an empty map', () => {
  const x = world();
  writeFileSync(join(x.w.root, 'map', 'game-need.json'), JSON.stringify({ weights: { 'CIV-回纹共同体': 9 } }));
  const map = heatmap(x.w.root, x.w.repo, null);
  const civ = map.rows.find((r) => r.rowId === 'CIV-回纹共同体');
  assert.equal(civ?.gameNeed, 9);
  assert.equal(map.rows.find((r) => r.rowId === 'SHIP')?.gameNeed, 1, 'rows not listed weigh 1');
  rmSync(join(x.w.root, 'map', 'rows.json'));
  const broken = heatmap(x.w.root, x.w.repo, null);
  assert.deepEqual(broken.rows, []);
  assert.equal(broken.errors.length, 1);
  assert.match(broken.errors[0] ?? '', /map\/rows\.json/u);
});

test('topicRounds: rounds with an offer or a topic, newest first', async () => {
  const x = await offered();
  mkdirSync(join(x.w.root, 'rounds', 'R02'), { recursive: true });
  writeFileSync(join(x.w.root, 'rounds', 'R02', 'topic.json'), '{}');
  mkdirSync(join(x.w.root, 'rounds', 'R03'), { recursive: true });
  assert.deepEqual(topicRounds(x.w.root), [
    { round: 'R02', offered: false, chosen: true },
    { round: ROUND, offered: true, chosen: false },
  ]);
});

test('gameNeedRows and latestRound: the editor rows of map/rows.json; the newest R round', async () => {
  const x = await offered();
  const rows = gameNeedRows(x.w.root);
  assert.equal(rows.error, null);
  assert.equal(rows.rows.length, rowCount(x));
  assert.deepEqual(rows.rows.find((r) => r.rowId === 'SHIP'), { rowId: 'SHIP', primary: '远航号', system: '' });
  assert.equal(latestRound(x.w.root), ROUND);
  mkdirSync(join(x.w.root, 'rounds', 'P09'), { recursive: true });
  assert.equal(latestRound(x.w.root), ROUND, 'prototype rounds are not R rounds');
  rmSync(join(x.w.root, 'map', 'rows.json'));
  assert.equal(gameNeedRows(x.w.root).rows.length, 0);
  assert.ok(gameNeedRows(x.w.root).error !== null);
});

test('topicView: an unreadable owner log shows the topic problem forge-relative, never the root', { skip: process.getuid?.() === 0 ? 'root ignores file modes' : false }, async () => {
  const x = await offered();
  writeFileSync(join(x.w.root, 'rounds', ROUND, 'topic.json'), `${JSON.stringify({ round: ROUND, row_id: 'SHIP', layer: 'object', cell: null, source: 'ui', chosen_at: '2026-10-01T00:00:00.000Z' }, null, 2)}\n`);
  const log = join(x.w.root, 'owner-log.jsonl');
  chmodSync(log, 0o000);
  const view = topicView(x.w.root, x.w.repo, ROUND);
  chmodSync(log, 0o600);
  const problem = view?.topicProblem ?? '';
  assert.ok(problem.includes('<forge>') && !problem.includes(x.w.root), problem);
});

test('topicView: a malformed wild-seeds.json is reported, not silently dropped', () => {
  const x = world();
  for (const r of ['R01', 'R02', 'R03']) mkdirSync(join(x.w.root, 'rounds', r), { recursive: true });
  writeFileSync(join(x.w.root, 'rounds', 'R01', 'wild-seeds.json'), JSON.stringify({ round: 'R01', seeds: { W1: ['a', 'b', 'c'] } }));
  const good = topicView(x.w.root, x.w.repo, 'R03');
  assert.deepEqual([good?.wildSeeds.length, good?.wildSeedsError], [1, null]);
  writeFileSync(join(x.w.root, 'rounds', 'R02', 'wild-seeds.json'), JSON.stringify({ round: 'R02', seeds: { W2: 'not a list' } }));
  const bad = topicView(x.w.root, x.w.repo, 'R03');
  assert.deepEqual(bad?.wildSeeds.map((w) => w.round), ['R01'], 'the readable round still shows');
  assert.match(bad?.wildSeedsError ?? '', /rounds\/R02\/wild-seeds\.json 的格式不是预期的/u);
  writeFileSync(join(x.w.root, 'rounds', 'R02', 'wild-seeds.json'), '{"torn');
  assert.match(topicView(x.w.root, x.w.repo, 'R03')?.wildSeedsError ?? '', /R02/u);
});

test('heatmap and topicView: a data copy without a sibling canon (world/current) reports it instead of throwing', async () => {
  const x = await offered();
  const lonely = mkdtempSync(join(tmpdir(), 'forge-topic-nocanon-'));
  const map = heatmap(x.w.root, lonely, null);
  assert.deepEqual(map.rows, []);
  assert.equal(map.errors.length, 1);
  assert.match(map.errors[0] ?? '', /world\/current/u);
  assert.ok(!(map.errors[0] ?? '').includes(lonely));
  assert.deepEqual(topicView(x.w.root, lonely, ROUND)?.heatmap.errors, map.errors);
  rmSync(lonely, { recursive: true });
});
