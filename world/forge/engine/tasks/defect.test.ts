import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseProtocol, type DefectType, type FixtureRxx } from '../protocol.ts';
import { DEFAULT_FORBIDDEN, type FactRow, type RegressionRow } from '../steps/brief.ts';
import { normalizeForQuote } from '../text.ts';
import { quoteSpan, unwrap, wrapText } from './fenced.ts';
import {
  applyDefect, D3_KEYWORDS, defectTargets, defectTask, fixtureRxxRow, parseDefectPlan, pickDefectSubmission, pickDefectType, targetIds,
  type DefectTargets,
} from './defect.ts';
import { ROLE_DEFECT } from './roles.ts';

const TYPES: DefectType[] = [
  { id: 'D1', text: '违背一条具名 F 编号的核心事实', requires: null },
  { id: 'D2', text: '违背一句回归证据', requires: null },
  { id: 'D3', text: '引入未登记的第三方势力，或早于先遣队的人工痕迹', requires: null },
  { id: 'D4', text: '反转一条已登记的 Rxx 事实', requires: 'rxx' },
];
const FIXTURE: FixtureRxx = {
  rxx: 'R00-01', rowId: 'SHIP', claim: '邻里共用工具柜不上锁', status: '状态与路径实例', attachesTo: '05', extends: 'x', misuse: 'y',
  reversal: '邻里的共用工具柜一向上锁，借东西得先找值班员申领钥匙。',
};
const F01: FactRow = { id: 'F01', kind: 'fact', text: '没有星门。', status: '共同事实', rows: ['ALL'] };
const F14: FactRow = { id: 'F14', kind: 'fact', text: '更名后的810人为指定接应实例。', status: '状态与路径实例', rows: ['ALL'] };
const R01: FactRow = { id: 'R01-02', kind: 'registered', text: '冷湾码头按潮汐排班。', status: '已选地方事实', rows: ['S1'] };
const G1: RegressionRow = { id: 'G-001', case: 'P01', source: 'judge-a', quote: '砧港的维修棚彻夜亮灯。' };
const TEXT = '温芮把借来的扳手挂回工具墙。循环泵换了节拍。林澈说冷凝管今晚要换滤网。';
const FACT_TARGETS: DefectTargets = { kind: 'facts', facts: [F01] };
const FORBIDDEN = ['决定任何失散者的结局', '出现未登记的第三方势力', '出现早于先遣队的人工痕迹'];

function fence(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

function type(id: string): DefectType {
  const t = TYPES.find((x) => x.id === id);
  if (t === undefined) throw new Error(id);
  return t;
}

test('fixtureRxxRow: fixture-rxx as a registered row keeping its path-instance status', () => {
  assert.deepEqual(fixtureRxxRow(FIXTURE), { id: 'R00-01', kind: 'registered', text: '邻里共用工具柜不上锁', status: '状态与路径实例', rows: ['SHIP'] });
  assert.throws(() => fixtureRxxRow({ ...FIXTURE, status: '传闻' }), /four fact statuses/u);
});

test('defectTargets: D1 never offers a 状态与路径实例 F-ID (F14); D2 regression; D3 the third-party / pre-advance forbidden moves by X-id; D4 brief Rxx (+ fixture-rxx in a drill)', () => {
  const brief = { facts: [F01, F14, R01], regression: [G1], forbidden: FORBIDDEN };
  assert.deepEqual(targetIds(defectTargets(type('D1'), brief, null)), ['F01']);
  assert.deepEqual(defectTargets(type('D2'), brief, null), { kind: 'regression', regression: [G1] });
  assert.deepEqual(defectTargets(type('D3'), brief, null), { kind: 'forbidden', rows: [{ id: 'X02', text: '出现未登记的第三方势力' }, { id: 'X03', text: '出现早于先遣队的人工痕迹' }] });
  assert.deepEqual(targetIds(defectTargets(type('D3'), { ...brief, forbidden: ['决定任何失散者的结局'] }, null)), [], 'D3 needs a forbidden move naming a third party or pre-advance-party traces');
  assert.deepEqual(targetIds(defectTargets(type('D4'), brief, null)), ['R01-02']);
  assert.deepEqual(targetIds(defectTargets(type('D4'), brief, FIXTURE)), ['R01-02', 'R00-01']);
  assert.deepEqual(targetIds(defectTargets(type('D4'), { facts: [F01], regression: [], forbidden: [] }, FIXTURE)), ['R00-01']);
  assert.deepEqual(targetIds(defectTargets({ id: 'D9', text: 't', requires: null }, brief, null)), [], 'unknown types offer nothing');
  assert.deepEqual(targetIds(defectTargets({ id: 'D5', text: 't', requires: 'canon' }, brief, null)), []);
});

test('D3_KEYWORDS stay pinned to the protocol D3 text and pick exactly the two default forbidden moves D3 names', () => {
  const protocol = parseProtocol(readFileSync(new URL('../../PROTOCOL.md', import.meta.url), 'utf8'));
  assert.ok(protocol.ok);
  const d3 = protocol.value.defectTypes.find((t) => t.id === 'D3');
  assert.ok(d3 !== undefined);
  for (const k of D3_KEYWORDS) assert.ok(d3.text.includes(k), `PROTOCOL D3 text no longer mentions ${k}`);
  const offered = defectTargets(d3, { facts: [], regression: [], forbidden: [...DEFAULT_FORBIDDEN] }, null);
  assert.deepEqual(offered, { kind: 'forbidden', rows: [{ id: 'X01', text: '出现早于先遣队的人工痕迹' }, { id: 'X02', text: '出现未登记的第三方势力' }] });
});

test('pickDefectType: seeded, D4 only with a registered fact or in a drill, independent of list order; null when none', () => {
  const noRxx = { facts: [F01] };
  const seen = new Set<string>();
  for (let i = 0; i < 40; i += 1) {
    const t = pickDefectType(TYPES, noRxx, `s${i}`, 'R01', false);
    assert.ok(t !== null);
    assert.notEqual(t.id, 'D4');
    seen.add(t.id);
    assert.equal(pickDefectType([...TYPES].reverse(), noRxx, `s${i}`, 'R01', false)?.id, t.id);
  }
  assert.deepEqual([...seen].sort(), ['D1', 'D2', 'D3']);
  const withRxx = new Set<string>();
  const drill = new Set<string>();
  for (let i = 0; i < 40; i += 1) {
    withRxx.add(pickDefectType(TYPES, { facts: [F01, R01] }, `s${i}`, 'R01', false)?.id ?? '');
    drill.add(pickDefectType(TYPES, noRxx, `s${i}`, 'R00', true)?.id ?? '');
  }
  assert.ok(withRxx.has('D4'));
  assert.ok(drill.has('D4'));
  assert.equal(pickDefectType([type('D4')], noRxx, 's', 'R01', false), null);
  assert.equal(pickDefectType([], noRxx, 's', 'R01', false), null);
});

test('pickDefectSubmission: one seeded id over the sorted set; null when nothing is gate-bound', () => {
  const picks = new Set<string>();
  for (let i = 0; i < 30; i += 1) {
    const p = pickDefectSubmission(['W3', 'W1', 'W2'], `s${i}`, 'R01');
    assert.equal(p, pickDefectSubmission(['W1', 'W2', 'W3'], `s${i}`, 'R01'));
    picks.add(p ?? '');
  }
  assert.deepEqual([...picks].sort(), ['W1', 'W2', 'W3']);
  assert.equal(pickDefectSubmission([], 's', 'R01'), null);
});

test('defectTask: role, numbered sentences, type text and targets wrapped, key line, no slot, retryPrompt quotes the error', () => {
  const spec = defectTask(TEXT, type('D1'), { kind: 'facts', facts: [F01] }, 'defect-W2', 'seed');
  assert.equal(spec.id, 'defect-W2');
  assert.equal(spec.role, ROLE_DEFECT);
  assert.equal(unwrap(spec.prompt, '正文'), '〔S001〕温芮把借来的扳手挂回工具墙。\n〔S002〕循环泵换了节拍。\n〔S003〕林澈说冷凝管今晚要换滤网。');
  assert.equal(unwrap(spec.prompt, '条目'), 'F01｜共同事实｜没有星门。');
  assert.match(spec.prompt, /缺陷类型：违背一条具名 F 编号的核心事实/u);
  assert.match(spec.prompt, /只改写正文中的一句，使它与所选条目明确矛盾/u);
  assert.match(spec.prompt, /只输出一个 ```json 代码块/u);
  assert.doesNotMatch(spec.prompt, /\{[A-Z_]+\}/u);
  const d3 = defectTask(TEXT, type('D3'), defectTargets(type('D3'), { facts: [], regression: [], forbidden: FORBIDDEN }, null), 'defect-W2', 's');
  assert.equal(unwrap(d3.prompt, '条目'), 'X02｜出现未登记的第三方势力\nX03｜出现早于先遣队的人工痕迹');
  assert.match(d3.prompt, /against 写所选条目的编号/u);
  assert.equal(unwrap(defectTask(TEXT, type('D2'), { kind: 'regression', regression: [G1] }, 'defect-W2', 's').prompt, '条目'), 'G-001｜P01｜砧港的维修棚彻夜亮灯。');
  const retry = spec.retryPrompt;
  assert.ok(retry !== undefined);
  assert.match(retry('against: not one of the offered ids'), /错误：against: not one of the offered ids/u);
  const probe = wrapText('正文', 'x', 'seed', 'defect-W2:正文');
  assert.ok(probe.ok);
  const tag = probe.value.slice(probe.value.indexOf('·') + 1, probe.value.indexOf('〕'));
  assert.throws(() => defectTask(`${TEXT}·${tag}〕`, type('D1'), FACT_TARGETS, 'defect-W2', 'seed'), /cannot wrap 正文/u);
});

test('parseDefectPlan accepts a valid swap (the plan carries the verbatim sentence) and applyDefect records the injected span', () => {
  const plan = parseDefectPlan(fence({ sentence_no: 2, original: '循环泵换了节拍。', replacement: '星门外的循环泵换了节拍。', against: 'F01' }), TEXT, FACT_TARGETS);
  assert.deepEqual(plan, { ok: true, value: { sentenceNo: 2, original: '循环泵换了节拍。', replacement: '星门外的循环泵换了节拍。', against: 'F01' } });
  if (!plan.ok) return;
  const d = applyDefect(TEXT, plan.value, { submission: 'W2', type: 'D1' });
  assert.equal(d.copy, '温芮把借来的扳手挂回工具墙。星门外的循环泵换了节拍。林澈说冷凝管今晚要换滤网。');
  assert.equal(d.injected, '星门外的循环泵换了节拍。');
  assert.deepEqual(d.injectedSpan, quoteSpan(d.injected, d.copy));
  assert.equal(normalizeForQuote(d.copy).slice(d.injectedSpan.start, d.injectedSpan.end), '星门外的循环泵换了节拍');
  assert.deepEqual({ submission: d.submission, type: d.type, against: d.against }, { submission: 'W2', type: 'D1', against: 'F01' });
  const fullWidth = parseDefectPlan(fence({ sentence_no: 1, original: ' 温芮把借来的扳手挂回工具墙。 ', replacement: '温芮把借来的扳手挂回星门边的工具墙。', against: 'F01' }), TEXT, FACT_TARGETS);
  assert.ok(fullWidth.ok, 'original is compared trimmed');
  assert.throws(() => applyDefect(TEXT, { sentenceNo: 3, original: '循环泵换了节拍。', replacement: 'x', against: 'F01' }, { submission: 'W2', type: 'D1' }), /does not match/u);
});

test('parseDefectPlan rejects one fixture per validation rule with ASCII errors', () => {
  const good = { sentence_no: 2, original: '循环泵换了节拍。', replacement: '星门外的循环泵换了节拍。', against: 'F01' };
  const twice = '循环泵换了节拍。温芮笑了。循环泵换了节拍。';
  const cases: Array<[string, string, string, RegExp]> = [
    ['missing fence', JSON.stringify(good), TEXT, /exactly one fenced json block, found 0/u],
    ['two fences', `${fence(good)}\n${fence(good)}`, TEXT, /found 2/u],
    ['sentence_no not integer', fence({ ...good, sentence_no: '2' }), TEXT, /sentence_no: missing or not an integer/u],
    ['sentence_no out of range', fence({ ...good, sentence_no: 4 }), TEXT, /sentence_no: out of range 1\.\.3/u],
    ['original mismatch', fence({ ...good, original: '林澈说冷凝管今晚要换滤网。' }), TEXT, /original: not the verbatim sentence/u],
    ['original missing', fence({ sentence_no: 2, replacement: 'x', against: 'F01' }), TEXT, /original: missing/u],
    ['original twice', fence({ ...good, sentence_no: 1 }), twice, /occurs more than once/u],
    ['two sentences', fence({ ...good, replacement: '星门亮了。循环泵停了。' }), TEXT, /exactly one sentence/u],
    ['line break', fence({ ...good, replacement: '星门亮了\n循环泵停了' }), TEXT, /line break or a reserved bracket/u],
    ['bracket', fence({ ...good, replacement: '〔星门〕亮了。' }), TEXT, /line break or a reserved bracket/u],
    ['same as original', fence({ ...good, replacement: '循环泵，换了节拍！' }), TEXT, /equals the original sentence/u],
    ['too short', fence({ ...good, replacement: '门亮。' }), TEXT, /fewer than 4 significant chars/u],
    ['too long', fence({ ...good, replacement: '星门外那台老旧的循环泵换了节拍。' }), TEXT, /longer than 1\.5 times/u],
    ['glued to next sentence', fence({ ...good, replacement: '星门外的循环泵换了节拍' }), TEXT, /does not stay one sentence/u],
    ['wrong id', fence({ ...good, against: 'F14' }), TEXT, /against: not one of the offered ids/u],
    ['against missing', fence({ sentence_no: 2, original: good.original, replacement: good.replacement }), TEXT, /against: missing/u],
    ['curly quotes', fence({ ...good, replacement: '林澈说“星门今晚开”。' }), TEXT, /must stay plain display text/u],
    ['ellipsis', fence({ ...good, replacement: '星门外循环泵...换拍。' }), TEXT, /must stay plain display text/u],
    ['markup', fence({ ...good, replacement: '**星门**循环泵换拍。' }), TEXT, /must stay plain display text/u],
  ];
  for (const [name, text, sub, pattern] of cases) {
    const r = parseDefectPlan(text, sub, FACT_TARGETS);
    assert.equal(r.ok, false, name);
    if (r.ok) continue;
    assert.match(r.error, pattern, name);
    assert.match(r.error, /^[\x20-\x7e]*$/u, `${name}: ASCII only`);
  }
});
