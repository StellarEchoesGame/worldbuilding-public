import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BriefJson } from '../steps/brief.ts';
import { unwrap } from './fenced.ts';
import { FORECAST_COUNT, FORECAST_SLOTS, forecastTask, parseForecasts, type Forecast } from './forecast.ts';
import { ROLE_FORECAST } from './roles.ts';
import { writerTask } from './writing.ts';

function forecastBrief(): BriefJson {
  return {
    round: 'R01', kind: 'round', row_id: 'SHIP', layer: '日常', topic_source: 'fixed',
    cell: {
      id: 'ship-neighbourhood', row_id: 'SHIP', title: '第三邻里的夜班', entity: '远航号第三邻里', time: '跃迁后第三年',
      layers: ['日常'], setting_notes: ['循环泵的节拍决定作息'], protagonists: ['温芮', '林澈'], forbidden: ['不写星门'], stances: [],
    },
    canon: { revision: '8.1', book_sha256: 'a'.repeat(64), reference_sha256: 'b'.repeat(64) },
    canon_passages: [{ file: 'reference/05-ecology-and-everyday.md', text: '温芮在远航号的第三邻里长大，她记得每一台循环泵的节拍。' }],
    facts: [{ id: 'F01', kind: 'fact', text: '没有星门。', status: '共同事实', rows: ['SHIP'] }],
    regression: [], regression_stale: [], forbidden: ['不写星门'], cliches: ['仿佛'],
    requirements: ['一个具名主角'], interface_requirements: ['一件可交互的物件'], aliases: ['远航号'],
    seed: 'c'.repeat(64), created_at: '2026-10-01T00:00:00.000Z',
  };
}

const SLOTS_8: readonly string[] = ['主角', '愿望', '代价', '物件', '习俗', '声音', '气味', '结局'];

function forecastJson(prefix: string, items?: ReadonlyArray<{ slot: string; value: string }>): string {
  const list = items ?? SLOTS_8.map((slot, i) => ({ slot, value: `${prefix}的第${i + 1}个细节` }));
  return `\`\`\`json\n${JSON.stringify({ forecasts: list })}\n\`\`\``;
}

function items(n: number): Array<{ slot: string; value: string }> {
  return Array.from({ length: n }, (_, i) => ({ slot: '物件', value: `母亲留下的铝饭盒${i}` }));
}

test('the slot enum has 11 engine-owned slots and 8 forecasts are required', () => {
  assert.equal(FORECAST_SLOTS.length, 11);
  assert.equal(new Set(FORECAST_SLOTS).size, 11);
  assert.equal(FORECAST_COUNT, 8);
});

test('parseForecasts accepts exactly 8 distinct slot/value pairs and trims values', () => {
  const r = parseForecasts(forecastJson('甲', items(7).concat([{ slot: '结局', value: '  灯带全部熄灭  ' }])));
  assert.ok(r.ok);
  const last: Forecast | undefined = r.value[7];
  assert.deepEqual(last, { slot: '结局', value: '灯带全部熄灭' });
  assert.equal(r.value.length, 8);
});

test('parseForecasts rejects each validation rule with an ASCII error that never echoes model text', () => {
  const cases: Array<[string, string]> = [
    ['7 items', forecastJson('', items(7))],
    ['9 items', forecastJson('', items(9))],
    ['unknown slot', forecastJson('', items(7).concat([{ slot: '天气', value: '下着酸雨的傍晚' }]))],
    ['41 chars', forecastJson('', items(7).concat([{ slot: '物件', value: '长'.repeat(41) }]))],
    ['1 char', forecastJson('', items(7).concat([{ slot: '物件', value: '锅' }]))],
    ['duplicate after normalization', forecastJson('', items(7).concat([{ slot: '习俗', value: '母亲留下的铝饭盒 0！' }]))],
    ['punctuation only', forecastJson('', items(7).concat([{ slot: '习俗', value: '……！' }]))],
    ['missing fence', JSON.stringify({ forecasts: items(8) })],
    ['two fences', `${forecastJson('', items(8))}\n${forecastJson('', items(8))}`],
    ['not an array', '```json\n{"forecasts": "物件"}\n```'],
    ['item not an object', `\`\`\`json\n${JSON.stringify({ forecasts: [...items(7), '物件'] })}\n\`\`\``],
    ['value not a string', `\`\`\`json\n${JSON.stringify({ forecasts: [...items(7), { slot: '物件', value: 3 }] })}\n\`\`\``],
  ];
  for (const [name, text] of cases) {
    const r = parseForecasts(text);
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.match(r.error, /^[\x20-\x7e]+$/u, `${name}: ${r.error}`);
  }
});

test('forecastTask: id, role, Chinese prompt with the brief wrapped and no output format of the writers', () => {
  const brief = forecastBrief();
  const spec = forecastTask(brief, { backendId: 'kimi', model: 'kimi-k3', writerDefault: false });
  assert.equal(spec.id, 'forecast-kimi');
  assert.equal(spec.role, ROLE_FORECAST);
  assert.equal(spec.retryPrompt, undefined);
  assert.match(spec.prompt, /预测按这份简报写出的现场里最可能出现的 8 个具体细节/u);
  assert.match(spec.prompt, /主角｜愿望｜代价｜物件｜习俗｜声音｜气味｜触感｜场所细节｜冲突｜结局/u);
  assert.ok(spec.prompt.trimEnd().endsWith('```'));
  assert.doesNotMatch(spec.prompt, /\{[A-Z_]+\}/u);
  assert.doesNotMatch(spec.prompt, /```submission|```delta|```interface|# 写法立场/u);
  const material = unwrap(spec.prompt, '简报');
  assert.ok(material !== null);
  for (const needle of ['第三邻里的夜班', '温芮在远航号的第三邻里长大', 'F01', '不写星门', '仿佛', '一个具名主角', '温芮 / 林澈']) {
    assert.ok(material.includes(needle), needle);
  }
  assert.ok(spec.parse(forecastJson('乙')).ok);
});

test('the forecast brief is the writers\' brief: every section of it appears verbatim in a writer prompt', () => {
  const base = forecastBrief();
  const noNames: BriefJson = { ...base, cell: { ...base.cell, protagonists: [], layers: ['物件', '任务钩子'] }, cliches: [], interface_requirements: [] };
  for (const brief of [base, noNames]) {
    const material = unwrap(forecastTask(brief, { backendId: 'kimi', model: 'kimi-k3', writerDefault: false }).prompt, '简报');
    assert.ok(material !== null);
    const writer = writerTask(brief, 'W1', 'daily', null).prompt;
    for (const section of material.split('\n\n# ')) assert.ok(writer.includes(section.replace(/^(?!# )/u, '# ')), section.slice(0, 40));
  }
  const material = unwrap(forecastTask(noNames, { backendId: 'kimi', model: 'kimi-k3', writerDefault: false }).prompt, '简报') ?? '';
  assert.ok(material.includes('可选主角：正典中已有的具名人物'));
  assert.ok(material.includes('本次要补厚的层：物件、任务钩子'));
  assert.equal(material.includes('# 避免的陈词'), false, 'an empty cliché list is omitted, as for writers');
});

test('forecastTask prompts are identical across forecasters and deterministic', () => {
  const brief = forecastBrief();
  const a = forecastTask(brief, { backendId: 'kimi', model: 'kimi-k3', writerDefault: false });
  const b = forecastTask(brief, { backendId: 'gw-deepseek', model: 'deepseek-fixture', writerDefault: true });
  assert.equal(a.prompt, b.prompt);
  assert.equal(b.id, 'forecast-gw-deepseek');
  assert.equal(forecastTask(brief, { backendId: 'kimi', model: 'kimi-k3', writerDefault: false }).prompt, a.prompt);
});

test('forecastTask refuses a backend id that is not a task id', () => {
  assert.throws(() => forecastTask(forecastBrief(), { backendId: 'bad id', model: 'm', writerDefault: false }), /task id/u);
});
