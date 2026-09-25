import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Result } from './result.ts';
import { loadSchema, validate } from './schema.ts';
import { readJson } from './store.ts';
import {
  DEFAULT_GAME_NEED,
  LAYERS,
  LAYER_LABELS,
  cellValue,
  checkTags,
  computeThinmap,
  formatThinmap,
  parseAliases,
  parseGameNeed,
  parseRows,
  type Cell,
  type RegisteredFact,
  type ThinmapInput,
} from './thinmap.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = join('tests', 'fixtures', 'thinmap');

function load(rel: string): unknown {
  return readJson(join(ROOT, rel));
}

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function schemaErrors(schemaFile: string, value: unknown): string[] {
  return validate(unwrap(loadSchema(load(join('schema', schemaFile)))), value);
}

const FIXED_ROWS = [
  'S0-外围接应区',
  'S1-冷湾',
  'S1-赤脊',
  'S1-帘影',
  'S2-生活维修接待',
  'S2-外部工业作业',
  'S3-公共生活接待',
  'S3-生态维护',
  'S4-培养群与冰栈交接',
  'S5-转运与远征准备场',
  'S6-自然调查',
  'S6-部署取样',
  'S7-环境调查',
  'S7-回纹地方节点',
  'I0-鹤灯测点甲',
  'I1-鹤灯测点乙',
  'SHIP',
  'CIV-绮珀诸庭',
  'CIV-阈庭联政',
  'CIV-回纹共同体',
];

// Verbatim excerpts of the current canon; the fixture quotes are exact substrings except the deliberately dropped ones.
const CANON: Record<string, string> = {
  '01-universe.md': '远航号离开晷川时，原定回港那天要穿的衣服还挂在许多人的门后。航路公署没有消失，保卫家园的舰队也仍在作战；失效的是这艘船能够按班期得到的接应、补给和安全保证。',
  '04-life-and-people.md': [
    '温芮38岁，协调普通维修，也喜欢改衣服。她的靛蓝外套袖口翻出灰银色里布，两边故意不对称。11岁的林澈说像穿反了，她说就是要他看出来；去工场时仍换合格作业服。这份漂亮没有生产收益。',
    '',
    '林澈记录汤勺碰杯沿、新鞋过门槛的声音，经常起重复标题，重听时认错。',
  ].join('\n'),
  'reference/01-space-and-history.md': [
    '**自然与建成环境：**长期开发的单恒星系。居住、培养和工业分散布置，外侧衡湾有居住船坞，铸流有精密维护链，苇环有培养与生物工艺；并非所有居民都生活在行星表面。不同设施能独立支持一段生活，但高规格制造和运输相互依赖。',
    '',
    '**形成原因：**早期勘测建立检修驻点，逐步引来工人、家属及独立经营者，才有今天的公署和常态班期。家园舰既服务外勤，也让一部分家庭以流动生活为职业选择。',
    '',
    '**当前差异：**某些地点被占，某些仍在守备控制下，还有失联地区；状态必须逐处附时间。资源并未自然枯竭。首发仅深入同一外围接应区的两种阶段，不将整个战区铺成自由探索场。',
    '',
    '**辨认标记：**维修履历沿用苇环日期链和砧港检定标记，两者可能并存；旧到港班期与新的临时转运表同时留在公告上。战争破坏了这些习惯的可靠性，却没有把其来处抹掉。',
    '',
    '**自然与建成环境：**息壤作业群在母舰先遣前没有文明；这项事实限定于首发的局部范围，不额外断言整个所在系的全部历史。首发范围为一颗外围巨行星的局部卫星与环带：冷湾是冰卫星作业盆地，赤脊是岩卫星的露头与破碎地带，帘影是可重复观察的环带区域。既有冰岩样品来自真实先遣，不是后来为母舰补写的矿物名单。',
    '',
    '**作用与限制：**水料、兼容前驱原料与自然观察使启动可行；开采、分离、检验和净补入依次成立。它没有原生可食农场、现成药品和为人类配好的生态。主要生活仍在母舰，留置测站与小缓存不等于独立城市。',
    '',
    '**重访变化：**旧取样点、磨损的工具、设备撤走后的锚定痕迹可以成为人的新历史。后来来的队伍有自己的权利与行为，但不能反向证明本船来之前已有文明。',
  ].join('\n'),
};

const REGISTERED: RegisteredFact[] = [
  { rxx: 'R01-01', rowId: 'SHIP', extends: 'F06' },
  { rxx: 'R01-02', rowId: 'SHIP', extends: 'F02' },
  { rxx: 'R02-01', rowId: 'S0-外围接应区', extends: 'R01-01' },
  { rxx: 'R02-02', rowId: 'S1-冷湾', extends: '资源并未自然枯竭。' },
  { rxx: 'R02-03', rowId: 'S7-环境调查', extends: '环境调查区与回纹持续经营的一处地方节点并列；' },
  { rxx: 'R02-04', rowId: 'P-温芮', extends: '11岁的林澈说像穿反了，她说就是要他看出来；' },
  { rxx: 'R02-05', rowId: 'SHIP', extends: '三者可能并存' },
  { rxx: 'R02-06', rowId: 'S0-外围接应区', extends: 'R09-09' },
  { rxx: 'R02-07', rowId: 'S0-外围接应区', extends: 'F99' },
  { rxx: 'R02-08', rowId: 'S0-外围接应区', extends: '' },
];

function fixtureInput(): ThinmapInput {
  return {
    rows: unwrap(parseRows(load('map/rows.json'))),
    aliases: unwrap(parseAliases(load(join(FIXTURES, 'aliases.json')))),
    tags: load(join(FIXTURES, 'tags.json')),
    canon: CANON,
    registered: REGISTERED,
    factRows: { F02: ['ALL'], F06: ['SHIP'] },
    gameNeed: unwrap(parseGameNeed(load(join(FIXTURES, 'game-need.json')))),
    mentions: { 'S1-帘影': 1 },
  };
}

function cellOf(cells: readonly Cell[], rowId: string, layer: string): Cell {
  const found = cells.find((c) => c.rowId === rowId && c.layer === layer);
  if (found === undefined) throw new Error(`no cell ${rowId} ${layer}`);
  return found;
}

function brief(c: Cell): string {
  return `${c.rowId} ${c.layer} ${c.priority}`;
}

test('layers keep the fixed order and Chinese labels', () => {
  assert.deepEqual(LAYERS, ['mechanism', 'sensory_scene', 'character_want', 'object', 'quest_hook', 'paintable_shot', 'play_interface']);
  assert.deepEqual(
    LAYERS.map((l) => LAYER_LABELS[l]),
    ['机制', '感官场景', '人物愿望', '物件', '任务钩子', '可画镜头', '玩法接口'],
  );
});

test('cellValue maps live quotes to 0-3 and caps at 2 while names dangle', () => {
  const cases: Array<[number, number, number]> = [
    [0, 0, 0],
    [1, 0, 1],
    [1, 5, 1],
    [2, 0, 2],
    [3, 0, 2],
    [3, 1, 2],
    [4, 0, 3],
    [4, 1, 2],
    [9, 0, 3],
    [9, 2, 2],
  ];
  for (const [live, dangling, want] of cases) assert.equal(cellValue(live, dangling), want, `${live}/${dangling}`);
});

test('map/rows.json validates and lists the 20 fixed rows in order', () => {
  const raw = load('map/rows.json');
  assert.deepEqual(schemaErrors('rows.schema.json', raw), []);
  const rows = unwrap(parseRows(raw));
  assert.equal(rows.length, 20);
  assert.equal(new Set(rows.map((r) => r.row_id)).size, 20);
  assert.deepEqual(rows.map((r) => r.row_id), FIXED_ROWS);
  assert.deepEqual(rows.slice(0, 16).map((r) => r.kind), Array.from({ length: 16 }, () => 'area'));
  const s1 = rows.find((r) => r.row_id === 'S1-冷湾');
  assert.equal(s1?.system, 'S1 息壤所在系');
  assert.deepEqual(rows.find((r) => r.row_id === 'S0-外围接应区')?.aliases, ['外围交接区', '晷川交接区']);
  assert.deepEqual(rows.find((r) => r.row_id === 'S7-回纹地方节点')?.aliases, ['回纹地方共同体', '当地作业队区域']);
  const ship = rows.find((r) => r.row_id === 'SHIP');
  assert.deepEqual([ship?.kind, ship?.primary, ship?.aliases], ['ship', '远航号', ['母舰', '家园舰', '归航号']]);
  const qp = rows.find((r) => r.row_id === 'CIV-绮珀诸庭');
  assert.deepEqual([qp?.kind, qp?.primary, qp?.aliases], ['civilization', '绮珀人', ['诸庭', '诸庭传统', '绮珀诸庭传统']]);
  assert.deepEqual(rows.find((r) => r.row_id === 'CIV-阈庭联政')?.aliases, ['阈庭']);
  assert.deepEqual(rows.find((r) => r.row_id === 'CIV-回纹共同体')?.aliases, ['回纹']);
});

test('fixtures validate against their schemas and the tag checker', () => {
  assert.deepEqual(schemaErrors('aliases.schema.json', load(join(FIXTURES, 'aliases.json'))), []);
  assert.deepEqual(schemaErrors('tags.schema.json', load(join(FIXTURES, 'tags.json'))), []);
  assert.deepEqual(schemaErrors('game-need.schema.json', load(join(FIXTURES, 'game-need.json'))), []);
  const rowIds = [...FIXED_ROWS, 'P-温芮', 'P-林澈'];
  assert.deepEqual(checkTags(load(join(FIXTURES, 'tags.json')), rowIds), []);
  assert.deepEqual(schemaErrors('rows.schema.json', { rows: [{ row_id: 'P-温芮', kind: 'character', primary: '温芮', system: '', aliases: [] }] }).sort(), [
    '$.rows[0].kind: not one of area, ship, civilization',
    '$.rows[0].row_id: does not match ^(?:(?:S[0-7]|I[01])-.+|SHIP|CIV-.+)$',
  ]);
});

test('default game need doubles the ship, S0 and the three S1 rows', () => {
  assert.deepEqual(DEFAULT_GAME_NEED, { SHIP: 2, 'S0-外围接应区': 2, 'S1-冷湾': 2, 'S1-赤脊': 2, 'S1-帘影': 2 });
});

test('fixture run: rows are the fixed rows plus the fixture characters', () => {
  const r = computeThinmap(fixtureInput());
  assert.deepEqual(r.rows, [...FIXED_ROWS, 'P-温芮', 'P-林澈']);
  assert.equal(r.cells.length, 22 * LAYERS.length);
  assert.deepEqual(r.cells.slice(0, 7).map((c) => c.layer), [...LAYERS]);
});

test('fixture run: cell values, dropped quotes and dangling cap', () => {
  const { cells } = computeThinmap(fixtureInput());
  const full = cellOf(cells, 'S0-外围接应区', 'mechanism');
  assert.deepEqual([full.live, full.value, full.priority, full.dropped], [4, 3, 0, []]);
  const capped = cellOf(cells, 'S0-外围接应区', 'sensory_scene');
  assert.deepEqual([capped.live, capped.value, capped.priority, capped.dangling], [4, 2, 2, ['衡湾']]);
  const stale = cellOf(cells, 'S0-外围接应区', 'object');
  assert.deepEqual([stale.live, stale.value, stale.priority], [1, 1, 4]);
  assert.deepEqual(stale.dropped, [{ file: 'reference/01-space-and-history.md', quote: '维修履历沿用苇环日期链和砧港检定标记，三者可能并存' }]);
  const missingFile = cellOf(cells, 'S1-冷湾', 'quest_hook');
  assert.deepEqual([missingFile.live, missingFile.value, missingFile.dropped], [2, 2, [{ file: 'reference/99-missing.md', quote: '冷湾旧取样点' }]]);
  assert.deepEqual([cellOf(cells, 'S1-冷湾', 'mechanism').value, cellOf(cells, 'S1-冷湾', 'mechanism').priority], [2, 2]);
  const dup = cellOf(cells, 'S1-赤脊', 'mechanism');
  assert.deepEqual([dup.live, dup.value], [1, 1]);
  assert.deepEqual([cellOf(cells, 'SHIP', 'object').value, cellOf(cells, 'SHIP', 'object').priority], [1, 4]);
  const want = cellOf(cells, 'P-温芮', 'character_want');
  assert.deepEqual([want.live, want.value, want.priority], [2, 2, 3]);
  const empty = cellOf(cells, 'S1-帘影', 'object');
  assert.deepEqual([empty.live, empty.value, empty.priority, empty.dropped, empty.dangling], [0, 0, 12, [], []]);
  assert.deepEqual([cellOf(cells, 'P-林澈', 'mechanism').value, cellOf(cells, 'P-林澈', 'mechanism').priority], [0, 3]);
});

test('fixture run: connectivity through R-IDs, F-IDs with ALL and canon sentences', () => {
  const { connectivity, rows } = computeThinmap(fixtureInput());
  const expected: Record<string, number> = {};
  for (const id of rows) expected[id] = 1;
  expected['SHIP'] = 1;
  expected['S0-外围接应区'] = 2;
  expected['CIV-回纹共同体'] = 2;
  expected['P-林澈'] = 2;
  assert.deepEqual(connectivity, expected);
});

test('connectivity ignores the fact\'s own row and dropped quotes', () => {
  const base = fixtureInput();
  const only = (registered: RegisteredFact[]): Record<string, number> => computeThinmap({ ...base, registered }).connectivity;
  assert.equal(only([{ rxx: 'R01-01', rowId: 'SHIP', extends: 'F06' }])['SHIP'], 0);
  assert.equal(only([{ rxx: 'R01-01', rowId: 'SHIP', extends: 'F02' }])['SHIP'], 0);
  const sentence = only([{ rxx: 'R01-01', rowId: 'S7-环境调查', extends: '环境调查区与回纹持续经营的一处地方节点并列；' }]);
  assert.deepEqual([sentence['S7-环境调查'], sentence['CIV-回纹共同体'], sentence['S7-回纹地方节点']], [0, 1, 0]);
  const viaQuote = only([{ rxx: 'R01-01', rowId: 'SHIP', extends: '资源并未自然枯竭。' }]);
  assert.equal(viaQuote['S0-外围接应区'], 1);
  const viaDropped = only([{ rxx: 'R01-01', rowId: 'SHIP', extends: '三者可能并存' }]);
  assert.equal(Object.values(viaDropped).reduce((a, b) => a + b, 0), 0);
  const viaCharacter = only([{ rxx: 'R01-01', rowId: 'SHIP', extends: '11岁的林澈说像穿反了，她说就是要他看出来；' }]);
  assert.equal(viaCharacter['P-林澈'], 1);
  const listed = computeThinmap({ ...base, registered: [{ rxx: 'R01-01', rowId: 'SHIP', extends: 'F03' }], factRows: { F03: ['S1-冷湾', 'S1-赤脊', 'S9-未知'] } }).connectivity;
  assert.deepEqual([listed['S1-冷湾'], listed['S1-赤脊'], listed['S1-帘影'], listed['S9-未知']], [1, 1, 0, undefined]);
});

test('canon-sentence connectivity credits names by longest match, so a longer name masks the names inside it', () => {
  const base = fixtureInput();
  const credited = (extendsText: string): string[] => {
    const c = computeThinmap({ ...base, registered: [{ rxx: 'R01-01', rowId: 'SHIP', extends: extendsText }] }).connectivity;
    return Object.entries(c).filter(([, n]) => n > 0).map(([id]) => id);
  };
  assert.deepEqual(credited('回纹地方共同体的人在当地作业。'), ['S7-回纹地方节点']);
  assert.deepEqual(credited('回纹的船停在环带外。'), ['CIV-回纹共同体']);
  // Each occurrence is masked separately: the bare name later in the sentence still counts.
  assert.deepEqual(credited('回纹地方共同体与回纹的船并列。'), ['S7-回纹地方节点', 'CIV-回纹共同体']);
  // Nested names of one row (环境调查区 ⊃ 环境调查) credit that row once.
  assert.deepEqual(credited('环境调查区今天关闭。'), ['S7-环境调查']);
  // A spelling carried by two rows is ambiguous, so the taken occurrence credits both.
  const rows = base.rows.map((r) => (r.row_id === 'S1-冷湾' || r.row_id === 'S1-赤脊' ? { ...r, aliases: [...r.aliases, '共用站'] } : r));
  const shared = computeThinmap({ ...base, rows, registered: [{ rxx: 'R01-01', rowId: 'SHIP', extends: '共用站的灯亮了。' }] }).connectivity;
  assert.deepEqual([shared['S1-冷湾'], shared['S1-赤脊'], shared['SHIP']], [1, 1, 0]);
});

test('ranking: priority desc, then row order, then layer order', () => {
  const { ranking } = computeThinmap(fixtureInput());
  assert.deepEqual(ranking.slice(0, 18).map(brief), [
    ...LAYERS.map((l) => `S1-帘影 ${l} 12`),
    'P-温芮 mechanism 9',
    'P-温芮 sensory_scene 9',
    'P-温芮 object 9',
    'P-温芮 quest_hook 9',
    'P-温芮 paintable_shot 9',
    'P-温芮 play_interface 9',
    'S0-外围接应区 character_want 6',
    'S0-外围接应区 quest_hook 6',
    'S0-外围接应区 paintable_shot 6',
    'S0-外围接应区 play_interface 6',
    'S1-冷湾 sensory_scene 6',
  ]);
  const threes = ranking.filter((c) => c.priority === 3).map((c) => `${c.rowId} ${c.layer}`);
  assert.equal(threes[0], 'S2-生活维修接待 mechanism');
  const want = threes.indexOf('P-温芮 character_want');
  assert.equal(threes[want - 1], 'CIV-回纹共同体 play_interface');
  assert.equal(threes[want + 1], 'P-林澈 mechanism');
  assert.equal(brief(ranking[ranking.length - 1] ?? cellOf(ranking, 'none', 'none')), 'S0-外围接应区 mechanism 0');
});

test('formatThinmap prints the row count and the top cells', () => {
  const r = computeThinmap(fixtureInput());
  assert.equal(formatThinmap(r, 2), 'rows=22\nS1-帘影 mechanism 0 12\nS1-帘影 sensory_scene 0 12');
  assert.equal(formatThinmap(r, 0), 'rows=22');
});

test('empty quotes are dropped, unknown tag rows ignored, missing tags count as zero', () => {
  const base = fixtureInput();
  const tags = {
    cells: {
      'P-林澈': { object: { quotes: [{ file: '04-life-and-people.md', quote: '' }], dangling: [] } },
      'S9-未知': { mechanism: { quotes: [{ file: '04-life-and-people.md', quote: '林澈' }], dangling: [] } },
    },
  };
  const r = computeThinmap({ ...base, tags });
  const c = cellOf(r.cells, 'P-林澈', 'object');
  assert.deepEqual([c.live, c.value, c.dropped], [0, 0, [{ file: '04-life-and-people.md', quote: '' }]]);
  assert.equal(r.cells.some((x) => x.rowId === 'S9-未知'), false);
  const none = computeThinmap({ ...base, tags: null });
  assert.equal(none.cells.every((x) => x.live === 0 && x.value === 0), true);
});

test('checkTags reports unknown rows and layers and malformed cells', () => {
  const errors = checkTags(
    {
      cells: {
        'S9-未知': {},
        SHIP: {
          smell: { quotes: [], dangling: [] },
          object: { quotes: [{ file: 'a.md' }], dangling: 'x' },
          mechanism: { dangling: [] },
        },
      },
    },
    FIXED_ROWS,
  );
  assert.deepEqual(errors, [
    'cells.S9-未知: unknown row',
    'cells.SHIP.smell: unknown layer',
    'cells.SHIP.object.quotes[0]: needs non-empty file and quote',
    'cells.SHIP.object.dangling: must be a string array',
    'cells.SHIP.mechanism.quotes: must be an array',
  ]);
  assert.deepEqual(checkTags([], FIXED_ROWS), ['tags: expected { "cells": { row_id: { layer: cell } } }']);
});

test('parsers reject malformed rows, aliases and weights', () => {
  const row = { row_id: 'SHIP', kind: 'ship', primary: '远航号', system: '', aliases: [] };
  const dupRows = parseRows({ rows: [row, row] });
  assert.equal(dupRows.ok, false);
  if (!dupRows.ok) assert.match(dupRows.error, /duplicate row_id SHIP/);
  assert.equal(parseRows({ rows: [{ ...row, kind: 'character' }] }).ok, false);
  const quote = { file: '04-life-and-people.md', quote: '温芮' };
  const notPrefixed = parseAliases({ entries: [{ row_id: '温芮', kind: 'character', primary: '温芮', aliases: [], first_quote: quote }] });
  assert.equal(notPrefixed.ok, false);
  if (!notPrefixed.ok) assert.match(notPrefixed.error, /P-/);
  assert.equal(parseAliases({ entries: [{ row_id: 'P-温芮', kind: 'area', primary: '温芮', aliases: [], first_quote: quote }] }).ok, false);
  assert.equal(parseAliases({ entries: [{ row_id: 'P-温芮', kind: 'character', primary: '温芮', aliases: [] }] }).ok, false);
  assert.equal(parseGameNeed({ weights: { SHIP: -1 } }).ok, false);
  assert.equal(parseGameNeed({ weights: { SHIP: '2' } }).ok, false);
  assert.deepEqual(unwrap(parseGameNeed({ weights: { SHIP: 1.5 } })), { SHIP: 1.5 });
});
