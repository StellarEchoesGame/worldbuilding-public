import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTags, type Alias } from '../thinmap.ts';
import { unwrap } from './fenced.ts';
import { ROLE_TAG, ROLE_TAG_REVIEW } from './roles.ts';
import {
  applyTags, parseTagProposals, parseTagReviews, reviewTagTask, tagReviewTaskId, tagTask, tagTaskId, type TagProposal,
} from './tagging.ts';

const SCENE = '温芮把借来的扳手挂回第三邻里的工具墙。母舰的循环泵换了节拍，走廊里的灯带转成琥珀色。林澈说冷凝管今晚要换滤网。';
const FILE = 'reference/09-scenes-and-people.md';
const quote = (): { file: string; quote: string } => ({ file: FILE, quote: '母舰的循环泵换了节拍' });
const ROWS: Alias[] = [
  { row_id: 'SHIP', kind: 'ship', primary: '远航号', aliases: ['母舰'], first_quote: { file: 'map/rows.json', quote: '' } },
  { row_id: 'P-温芮', kind: 'character', primary: '温芮', aliases: [], first_quote: { file: 'reference/05.md', quote: '温芮' } },
];
const ROW_IDS = ['SHIP', 'S1-冷湾', 'P-温芮'];

function fence(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

test('task ids: tag-<RNN>-<family> and tagreview-<RNN>-<family>', () => {
  assert.equal(tagTaskId('R01', 'Moonshot'), 'tag-R01-Moonshot');
  assert.equal(tagReviewTaskId('R01', 'xAI'), 'tagreview-R01-xAI');
});

test('tagTask: Chinese prompt with the scene and rows wrapped, ROLE_TAG, fenced JSON output block, retry quotes the error', () => {
  const spec = tagTask(SCENE, ROWS, ['object', 'sensory_scene'], 'tag-R01-Moonshot', 'seed');
  assert.equal(spec.id, 'tag-R01-Moonshot');
  assert.equal(spec.role, ROLE_TAG);
  assert.equal(unwrap(spec.prompt, '现场'), SCENE);
  const rows = unwrap(spec.prompt, '行') ?? '';
  assert.match(rows, /SHIP｜远航号（又名：母舰）/u);
  assert.match(rows, /P-温芮｜温芮/u);
  assert.match(spec.prompt, /object｜物件/u);
  assert.match(spec.prompt, /sensory_scene｜感官场景/u);
  assert.ok(!spec.prompt.includes('character_want'), 'only the requested layers are offered');
  assert.match(spec.prompt, /```json/u);
  assert.match(spec.retryPrompt?.('tags: missing') ?? '', /tags: missing/u);
});

test('parseTagProposals: a quote not verbatim in the scene is dropped; duplicates merged; Chinese layer labels accepted', () => {
  const text = fence({
    tags: [
      { row_id: 'SHIP', layer: 'object', quotes: ['母舰的循环泵换了节拍', '母舰的储水罐漏了一夜'], dangling: ['冷凝管'] },
      { row_id: 'SHIP', layer: '物件', quotes: ['母舰的循环泵换了节拍', '走廊里的灯带转成琥珀色'], dangling: [] },
      { row_id: 'P-温芮', layer: 'object', quotes: ['温芮把借来的扳手挂回第三邻里的工具墙'], dangling: [] },
      { row_id: 'P-温芮', layer: 'sensory_scene', quotes: ['并不存在的句子'], dangling: [] },
    ],
  });
  const r = parseTagProposals(text, SCENE, ROWS, ['object', 'sensory_scene']);
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.deepEqual(r.value, [
    { row_id: 'SHIP', layer: 'object', quotes: ['母舰的循环泵换了节拍', '走廊里的灯带转成琥珀色'], dangling: ['冷凝管'] },
    { row_id: 'P-温芮', layer: 'object', quotes: ['温芮把借来的扳手挂回第三邻里的工具墙'], dangling: [] },
  ]);
});

test('parseTagProposals: short quotes (< 4 significant chars) are dropped; an empty tag list is valid', () => {
  const r = parseTagProposals(fence({ tags: [{ row_id: 'SHIP', layer: 'object', quotes: ['母舰'], dangling: [] }] }), SCENE, ROWS, ['object']);
  assert.ok(r.ok);
  assert.deepEqual(r.value, []);
  const empty = parseTagProposals(fence({ tags: [] }), SCENE, ROWS, ['object']);
  assert.deepEqual(empty, { ok: true, value: [] });
});

test('parseTagProposals: structural errors are ASCII and retryable (unknown row, layer not offered, no fence, bad arrays)', () => {
  const bad = (value: unknown): string => {
    const r = parseTagProposals(fence(value), SCENE, ROWS, ['object']);
    assert.ok(!r.ok);
    assert.match(r.error, /^[\x20-\x7e]+$/u);
    return r.error;
  };
  assert.match(bad({ tags: [{ row_id: 'S1-赤脊', layer: 'object', quotes: [], dangling: [] }] }), /tags\[0\]\.row_id/u);
  assert.match(bad({ tags: [{ row_id: 'SHIP', layer: 'mechanism', quotes: [], dangling: [] }] }), /tags\[0\]\.layer/u);
  assert.match(bad({ tags: [{ row_id: 'SHIP', layer: 'object', quotes: 'x', dangling: [] }] }), /tags\[0\]\.quotes/u);
  assert.match(bad({ tags: [{ row_id: 'SHIP', layer: 'object', quotes: [], dangling: [1] }] }), /tags\[0\]\.dangling/u);
  assert.match(bad({ nope: [] }), /tags/u);
  assert.equal(parseTagProposals('no fence', SCENE, ROWS, ['object']).ok, false);
});

const PROPOSALS: TagProposal[] = [
  { row_id: 'SHIP', layer: 'object', quotes: ['母舰的循环泵换了节拍', '走廊里的灯带转成琥珀色'], dangling: [] },
  { row_id: 'P-温芮', layer: 'object', quotes: ['温芮把借来的扳手挂回第三邻里的工具墙'], dangling: [] },
];

test('reviewTagTask: one numbered item per proposed quote (T1…), ROLE_TAG_REVIEW; quotes not in the scene are never offered', () => {
  const spec = reviewTagTask(SCENE, [...PROPOSALS, { row_id: 'SHIP', layer: 'quest_hook', quotes: ['不在现场里的句子'], dangling: [] }], 'tagreview-R01-xAI', 'seed');
  assert.equal(spec.role, ROLE_TAG_REVIEW);
  assert.equal(unwrap(spec.prompt, '现场'), SCENE);
  const items = (unwrap(spec.prompt, '标注') ?? '').split('\n');
  assert.deepEqual(items, ['T1｜SHIP｜物件｜母舰的循环泵换了节拍', 'T2｜SHIP｜物件｜走廊里的灯带转成琥珀色', 'T3｜P-温芮｜物件｜温芮把借来的扳手挂回第三邻里的工具墙']);
});

test('parseTagReviews: one verdict per item; keep / dispute with reason ≤ 80; missing or unknown ids are retryable errors', () => {
  const reviews = [
    { id: 'T1', verdict: 'keep', reason: '循环泵是母舰的设施' },
    { id: 'T2', verdict: 'dispute', reason: '灯带不是物件' },
    { id: 'T3', verdict: 'keep', reason: '扳手' },
  ];
  const r = parseTagReviews(fence({ reviews }), SCENE, PROPOSALS);
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.deepEqual(r.value, [
    { row_id: 'SHIP', layer: 'object', quote: '母舰的循环泵换了节拍', verdict: 'keep', reason: '循环泵是母舰的设施' },
    { row_id: 'SHIP', layer: 'object', quote: '走廊里的灯带转成琥珀色', verdict: 'dispute', reason: '灯带不是物件' },
    { row_id: 'P-温芮', layer: 'object', quote: '温芮把借来的扳手挂回第三邻里的工具墙', verdict: 'keep', reason: '扳手' },
  ]);
  const bad = (list: unknown[]): string => {
    const x = parseTagReviews(fence({ reviews: list }), SCENE, PROPOSALS);
    assert.ok(!x.ok);
    return x.error;
  };
  assert.match(bad(reviews.slice(0, 2)), /T3/u);
  assert.match(bad([...reviews, { id: 'T9', verdict: 'keep', reason: 'x' }]), /T9|unknown/u);
  assert.match(bad([...reviews, reviews[0]]), /twice/u);
  assert.match(bad([{ ...reviews[0], verdict: 'maybe' }, reviews[1], reviews[2]]), /verdict/u);
  assert.match(bad([{ ...reviews[0], reason: '长'.repeat(81) }, reviews[1], reviews[2]]), /reason/u);
});

test('applyTags: adds kept quotes as {file, quote}, deduped, keeps other keys and cells, result passes checkTags', () => {
  const before = { revision: '8.1', cells: { SHIP: { object: { quotes: [quote()], dangling: [] } }, 'S1-冷湾': { mechanism: { quotes: [], dangling: ['潮汐'] } } } };
  const r = applyTags(before, [
    { row_id: 'SHIP', layer: 'object', quote: '母舰的循环泵换了节拍' },
    { row_id: 'SHIP', layer: 'object', quote: '走廊里的灯带转成琥珀色' },
    { row_id: 'SHIP', layer: 'object', quote: '走廊里的灯带转成琥珀色' },
    { row_id: 'P-温芮', layer: 'sensory_scene', quote: '温芮把借来的扳手挂回第三邻里的工具墙' },
  ], FILE, ROW_IDS);
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.deepEqual(r.value, {
    revision: '8.1',
    cells: {
      SHIP: { object: { quotes: [quote(), { file: FILE, quote: '走廊里的灯带转成琥珀色' }], dangling: [] } },
      'S1-冷湾': { mechanism: { quotes: [], dangling: ['潮汐'] } },
      'P-温芮': { sensory_scene: { quotes: [{ file: FILE, quote: '温芮把借来的扳手挂回第三邻里的工具墙' }], dangling: [] } },
    },
  });
  assert.deepEqual(checkTags(r.value, ROW_IDS), []);
  assert.deepEqual(before.cells.SHIP.object.quotes, [quote()], 'the input is not mutated');
});

test('applyTags: invalid input tags or a kept row outside rowIds → err; absent tags (null) start from {cells: {}}', () => {
  assert.equal(applyTags({ cells: { NOPE: {} } }, [], FILE, ROW_IDS).ok, false);
  assert.equal(applyTags({ cells: {} }, [{ row_id: 'NOPE', layer: 'object', quote: '母舰的循环泵换了节拍' }], FILE, ROW_IDS).ok, false);
  const fresh = applyTags(null, [{ row_id: 'SHIP', layer: 'object', quote: '母舰的循环泵换了节拍' }], FILE, ROW_IDS);
  assert.deepEqual(fresh, { ok: true, value: { cells: { SHIP: { object: { quotes: [quote()], dangling: [] } } } } });
});
