import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonFiles } from '../inputs.ts';
import { mergeConstants, regateFacts } from '../merge.ts';
import { carriesQuote, sentencesCarrying, type DeltaFact, type MergeSource } from '../mergecheck.ts';
import { loadProtocolBundle } from '../rules.ts';
import { DEFAULT_FIXTURE, fixtureWorld } from '../testing/fixture-world.ts';
import {
  editorMaterial, fallbackPlan, mergeability, mergeEditorTask, mergeEditorTaskId, parseMergePlan, REGISTER_PATH, renderedViolations, renderMerge, SCENES_PATH,
  type MergePlan, type MergeSources, type PlanItem,
} from './merge-editor.ts';

const ECOLOGY = 'reference/05-ecology-and-everyday.md';
const TECH = 'reference/02-technology-and-infrastructure.md';
const BASE_TEXT = '# 留饭签\n\n温芮在第三邻里的公共桌边核对配给簿。邻里的留饭签挂在食堂门口的铁钩上。\n\n林澈说冷凝管今晚要换滤网。两个人一起把菌毯卷好，送回培养架。';
const DONOR_TEXT = '循环泵的节拍每到换班就慢下来。住户听见节拍变慢就去查看管路。孩子们在走廊里数着灯。';

function fact(id: string, over: Partial<DeltaFact>): DeltaFact {
  return { id, claim: '', status: '已选地方事实', rowId: 'SHIP', attachesTo: '05-ecology-and-everyday.md', extends: '', misuse: '写成别处的规矩', sourceQuote: '', ...over };
}

const A01 = fact('A-01', { claim: '邻里的留饭签挂在食堂门口的铁钩上', sourceQuote: '留饭签挂在食堂门口的铁钩上' });
const B01 = fact('A-01', { claim: '循环泵的节拍在换班时变慢', status: '状态与路径实例', attachesTo: '02-technology-and-infrastructure.md', extends: 'F03', sourceQuote: '循环泵的节拍每到换班就慢下来' });

const SOURCES: MergeSource[] = [
  { label: 'A', submission: BASE_TEXT, facts: [A01] },
  { label: 'B', submission: DONOR_TEXT, facts: [B01] },
  { label: 'BASE', submission: '温芮把借来的扳手挂回工具墙。', facts: [] },
];

function world(): { dir: string; before: Record<string, string>; src: (opts?: { donor?: boolean; happened?: boolean; before?: Record<string, string> }) => MergeSources } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-merge-editor-'));
  const w = fixtureWorld(dir, DEFAULT_FIXTURE);
  const bundle = loadProtocolBundle(w.root);
  assert.ok(bundle.ok);
  const before = { ...canonFiles(w.repo), [SCENES_PATH]: '' };
  const src = (opts: { donor?: boolean; happened?: boolean; before?: Record<string, string> } = {}): MergeSources => ({
    round: 'R01',
    decision: {
      round: 'R01', baseLabel: 'A', title: '', rows: ['SHIP'],
      registered: [{ rxx: 'R01-01', label: 'A', factId: 'A-01' }, ...(opts.donor === false ? [] : [{ rxx: 'R01-02', label: 'B', factId: 'A-01' }])],
    },
    happened: opts.happened ?? false,
    sources: SOURCES,
    rowIds: ['SHIP', 'S1-冷湾', 'P-温芮'],
    before: opts.before ?? before,
    cellTitle: '母舰 · 邻里常态日',
    constants: mergeConstants(bundle.value.protocol),
  });
  return { dir, before, src };
}

function plan(body: MergePlan['body'], over: Partial<MergePlan> = {}): MergePlan {
  return { title: '留饭签', time_anchor: '任一常态日', path: '标准成功路径', body, paragraph_breaks: [], ...over };
}

function fenced(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

const GOOD: MergePlan['body'] = [
  { from: 'base', index: 1, connective: null },
  { from: 'base', index: 2, connective: null },
  { from: 'donor', rxx: 'R01-02', connective: '同一天，' },
  { from: 'base', index: 3, connective: null },
];

test('editorMaterial numbers the base sentences (title line included) and lists donor sentences per Rxx', () => {
  const { dir, src } = world();
  const m = editorMaterial(src());
  assert.deepEqual(m.base, ['留饭签', '温芮在第三邻里的公共桌边核对配给簿。', '邻里的留饭签挂在食堂门口的铁钩上。', '林澈说冷凝管今晚要换滤网。', '两个人一起把菌毯卷好，送回培养架。']);
  assert.deepEqual(m.donors, { 'R01-02': ['循环泵的节拍每到换班就慢下来。'] });
  assert.deepEqual(m.timeAnchors, ['任一常态日']);
  assert.equal(mergeEditorTaskId('0123abcd'), 'merge-0123abcd');
  rmSync(dir, { recursive: true });
});

test('renderMerge on a first merge: 09 opening + header, 07 rows from delta fields, one index line per 01–06 file, mergecheck clean', () => {
  const { dir, before, src } = world();
  const s = src();
  const p = plan(GOOD, { paragraph_breaks: [1] });
  const edit = renderMerge(p, s);
  const header = '## R01｜留饭签\n\n地点：SHIP｜时间锚：任一常态日｜路径依赖：标准成功路径｜地位：状态与路径实例·示例｜本场登记事实：R01-01、R01-02';
  const body = '温芮在第三邻里的公共桌边核对配给簿。邻里的留饭签挂在食堂门口的铁钩上。\n\n同一天，循环泵的节拍每到换班就慢下来。林澈说冷凝管今晚要换滤网。';
  assert.equal(edit.scene, `${header}\n\n${body}\n`);
  assert.equal(edit.files[SCENES_PATH], `${s.constants.preamble09}\n\n${edit.scene}`);
  const rows = [
    '| R01-01 | SHIP | 邻里的留饭签挂在食堂门口的铁钩上 | 已选地方事实 | 05-ecology-and-everyday.md | 无 | 写成别处的规矩 | R01 |',
    '| R01-02 | SHIP | 循环泵的节拍在换班时变慢 | 状态与路径实例 | 02-technology-and-infrastructure.md | F03 | 写成别处的规矩 | R01 |',
  ];
  const c = s.constants;
  assert.equal(edit.files[REGISTER_PATH], `${before[REGISTER_PATH]}\n${c.pointer07}\n\n${c.heading8}\n\n${c.tableHeader8}\n${rows.join('\n')}\n`);
  assert.equal(edit.files[ECOLOGY], `${before[ECOLOGY]}\n现场：见09 §R01（R01-01）\n`);
  assert.equal(edit.files[TECH], `${before[TECH]}\n现场：见09 §R01（R01-02）\n`);
  assert.deepEqual(Object.keys(edit.files).sort(), [TECH, ECOLOGY, REGISTER_PATH, SCENES_PATH].sort());
  assert.deepEqual(edit.rxx, ['R01-01', 'R01-02']);
  assert.deepEqual(renderedViolations(p, edit, s), []);
  rmSync(dir, { recursive: true });
});

test('happened → 地位 已选地方事实·已发生事件; no registered fact → 无, 07 and 01–06 untouched', () => {
  const { dir, src } = world();
  const s = { ...src({ happened: true }) };
  s.decision = { ...s.decision, registered: [] };
  const p = plan([{ from: 'base', index: 1, connective: null }]);
  const edit = renderMerge(p, s);
  assert.match(edit.scene, /｜地位：已选地方事实·已发生事件｜本场登记事实：无\n/u);
  assert.deepEqual(Object.keys(edit.files), [SCENES_PATH]);
  assert.deepEqual(renderedViolations(p, edit, s), []);
  rmSync(dir, { recursive: true });
});

test('a second merge appends to an existing 09 and 07 §8 without a new opening', () => {
  const { dir, before, src } = world();
  const first = renderMerge(plan(GOOD), src());
  const s2 = src({ before: { ...before, ...first.files } });
  s2.round = 'R02';
  s2.decision = { round: 'R02', baseLabel: 'A', title: '', rows: ['SHIP'], registered: [{ rxx: 'R02-01', label: 'A', factId: 'A-01' }] };
  const p = plan([{ from: 'base', index: 2, connective: null }]);
  const edit = renderMerge(p, s2);
  const was09 = first.files[SCENES_PATH] ?? '';
  assert.equal(edit.files[SCENES_PATH], `${was09}\n${edit.scene}`);
  assert.equal(edit.files[REGISTER_PATH], `${first.files[REGISTER_PATH] ?? ''}| R02-01 | SHIP | 邻里的留饭签挂在食堂门口的铁钩上 | 已选地方事实 | 05-ecology-and-everyday.md | 无 | 写成别处的规矩 | R02 |\n`);
  assert.deepEqual(renderedViolations(p, edit, s2), []);
  rmSync(dir, { recursive: true });
});

test('fallbackPlan drops the title line, keeps base order, appends donors after a break, and passes mergecheck', () => {
  const { dir, src } = world();
  const s = src();
  const p = fallbackPlan(s);
  assert.deepEqual(p, {
    title: '母舰 · 邻里常态日', time_anchor: '任一常态日', path: '标准成功路径',
    body: [...[1, 2, 3, 4].map((index): PlanItem => ({ from: 'base', index, connective: null })), { from: 'donor', rxx: 'R01-02', connective: null }],
    paragraph_breaks: [1, 3],
  });
  assert.deepEqual(fallbackPlan(s), p, 'deterministic');
  assert.deepEqual(renderedViolations(p, renderMerge(p, s), s), []);
  const long = { ...s, cellTitle: '一二三四五六七八九十｜一二三四五六七八九十一二三四五六七八九十' };
  assert.equal([...fallbackPlan(long).title].length, 24);
  assert.ok(!fallbackPlan(long).title.includes('｜'));
  rmSync(dir, { recursive: true });
});

test('parseMergePlan: exactly one block, bounded fields, ASCII errors that never echo model text', () => {
  const { dir, src } = world();
  const m = editorMaterial(src());
  const ok = { title: '留饭签', time_anchor: 'D3—D5中的任一常态日', path: '与路径无关', body: [{ from: 'base', index: 1, connective: null }], paragraph_breaks: [0] };
  const parsed = parseMergePlan(fenced(ok), m);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, { ...ok, body: [{ from: 'base', index: 1, connective: null }] });
  const cases: Array<[unknown, RegExp]> = [
    [{ ...ok, title: '一二三四五六七八九十一二三四五六七八九十一二三四五' }, /^title:/u],
    [{ ...ok, title: '甲｜乙' }, /^title:/u],
    [{ ...ok, time_anchor: '某天' }, /^time_anchor:/u],
    [{ ...ok, path: '任意' }, /^path:/u],
    [{ ...ok, body: [] }, /^body:/u],
    [{ ...ok, body: [{ from: 'base', index: 9, connective: null }] }, /^body\[0\]\.index:/u],
    [{ ...ok, body: [{ from: 'donor', rxx: '注入的文字', connective: null }] }, /^body\[0\]\.rxx:/u],
    [{ ...ok, body: [{ from: 'base', index: 1, connective: '很长很长很长很长很长很长很长的连接' }] }, /^body\[0\]\.connective:/u],
    [{ ...ok, paragraph_breaks: [3] }, /^paragraph_breaks\[0\]:/u],
  ];
  for (const [value, pattern] of cases) {
    const r = parseMergePlan(fenced(value), m);
    assert.ok(!r.ok, JSON.stringify(value));
    assert.match(r.error, pattern);
    assert.match(r.error, /^[\x20-\x7e]*$/u, 'ASCII only');
  }
  assert.ok(!parseMergePlan(`${fenced(ok)}\n${fenced(ok)}`, m).ok);
  rmSync(dir, { recursive: true });
});

test('mergeEditorTask: a plan that reorders base refs fails parse with the mergecheck error, the retry prompt quotes it, the second plan passes', () => {
  const { dir, src } = world();
  const s = src();
  const spec = mergeEditorTask(s, 'merge-0123abcd', 'seed-1');
  assert.equal(spec.id, 'merge-0123abcd');
  assert.match(spec.prompt, /只能挑选、排序下列句子/u);
  assert.match(spec.prompt, /这些底稿句子必须保留：\[2\]/u);
  const reordered = { title: '留饭签', time_anchor: '任一常态日', path: '标准成功路径', paragraph_breaks: [], body: [{ from: 'base', index: 2, connective: null }, { from: 'base', index: 1, connective: null }, { from: 'donor', rxx: 'R01-02', connective: null }] };
  const first = spec.parse(fenced(reordered));
  assert.ok(!first.ok);
  assert.match(first.error, /^mergecheck: .*09: base sentence out of order/u);
  const retry = spec.retryPrompt?.(first.error) ?? '';
  assert.ok(retry.startsWith(spec.prompt));
  assert.ok(retry.includes(first.error));
  const second = spec.parse(fenced({ ...reordered, body: GOOD }));
  assert.ok(second.ok, second.ok ? '' : second.error);
  assert.deepEqual(second.value.edit, renderMerge(second.value.plan, s));
  const unlisted = spec.parse(fenced({ ...reordered, body: [{ from: 'base', index: 2, connective: '然后呢，' }, { from: 'donor', rxx: 'R01-02', connective: null }] }));
  assert.deepEqual(unlisted, { ok: false, error: 'body[0].connective: not one of the listed connectives' });
  const missingDonor = spec.parse(fenced({ ...reordered, body: [{ from: 'base', index: 2, connective: null }] }));
  assert.ok(!missingDonor.ok);
  assert.match(missingDonor.error, /R01-02 source quote not in scene/u);
  rmSync(dir, { recursive: true });
});

test('renderMerge ends the paragraph after a sentence without a terminator (base or donor), so mergecheck sees the source sentences', () => {
  const { dir, src } = world();
  const s = src();
  const A = { label: 'A', submission: '温芮在第三邻里的公共桌边核对配给簿\n邻里的留饭签挂在食堂门口的铁钩上。', facts: [A01] };
  const B = { label: 'B', submission: '孩子们在走廊里数着灯。循环泵的节拍每到换班就慢下来', facts: [B01] };
  const t = { ...s, sources: [A, B, SOURCES[2] ?? A] };
  const p = fallbackPlan(t);
  const edit = renderMerge(p, t);
  assert.ok(edit.scene.endsWith('\n\n温芮在第三邻里的公共桌边核对配给簿\n\n邻里的留饭签挂在食堂门口的铁钩上。\n\n循环泵的节拍每到换班就慢下来\n'), edit.scene);
  assert.deepEqual(renderedViolations(p, edit, t), []);
  assert.deepEqual(mergeability(t, '舰上没有第二个太阳'), []);
  rmSync(dir, { recursive: true });
});

test('mergeability: malformed 07 cells, short quotes, a donor quote no sentence carries, the fixture claim; [] when clean', () => {
  const { dir, src } = world();
  const s = src();
  assert.deepEqual(mergeability(s, '舰上没有第二个太阳'), []);
  const withFacts = (a: Partial<DeltaFact>, b: Partial<DeltaFact>): MergeSources => ({
    ...s, sources: [{ label: 'A', submission: BASE_TEXT, facts: [{ ...A01, ...a }] }, { label: 'B', submission: DONOR_TEXT, facts: [{ ...B01, ...b }] }],
  });
  assert.deepEqual(mergeability(withFacts({ misuse: '写成|规矩', attachesTo: '05\n生态' }, { extends: 'F0|3' }), ''), [
    'R01-01: attaches_to contains | or a line break', 'R01-01: misuse contains | or a line break', 'R01-02: extends contains | or a line break',
  ]);
  assert.deepEqual(mergeability(withFacts({ sourceQuote: '铁钩。' }, { sourceQuote: '就慢下来。住户听见节拍' }), ''), [
    'R01-01: source quote is too short', 'R01-02: no donor sentence carries the whole source quote',
  ]);
  assert.deepEqual(mergeability(s, '循环泵的节拍每到换班'), ['R01-02: repeats the fixture fact']);
  const noTitle = { ...s, cellTitle: '', decision: { ...s.decision, rows: [] } };
  assert.ok(mergeability(noTitle, '').every((v) => v.startsWith('fallback plan: 09:')), 'the backstop reports what the fallback plan fails');
  assert.ok(mergeability(noTitle, '').length > 0);
  rmSync(dir, { recursive: true });
});

test('one donor rule: mergeability, regateFacts and mergecheck agree on quotes that differ from a donor sentence only by folded characters', () => {
  const { dir, src } = world();
  const s = src();
  const sentence = '循环泵的节拍每到换班就慢下来。';
  const placed = fallbackPlan(s);
  const edit = renderMerge(placed, s);
  assert.ok(edit.scene.includes(sentence));
  const cases: Array<{ quote: string; carried: boolean; why: string }> = [
    { quote: '循环泵的节拍每到换班就慢下来｡', carried: true, why: 'halfwidth full stop: NFKC folds it in both keys' },
    { quote: '循环泵的节拍，每到换班就慢下来', carried: false, why: 'an extra comma: only normalizeForQuote folds it' },
    { quote: '[节拍](http://x)', carried: false, why: 'the stripped key is too short to identify a donor sentence' },
    { quote: '舱门在夜里自己打开', carried: false, why: 'in no sentence' },
  ];
  for (const c of cases) {
    const t: MergeSources = { ...s, sources: SOURCES.map((x) => (x.label === 'B' ? { ...x, facts: [{ ...B01, sourceQuote: c.quote }] } : x)) };
    assert.equal(carriesQuote(sentence, c.quote), c.carried, c.why);
    assert.deepEqual(sentencesCarrying(DONOR_TEXT, c.quote), c.carried ? [sentence] : [], c.why);
    const regate = regateFacts(t.decision, t.sources);
    assert.ok(regate.ok);
    assert.deepEqual(regate.value.find((f) => f.rxx === 'R01-02')?.source_sentences, c.carried ? [sentence] : [], c.why);
    assert.equal(mergeability(t, '').includes('R01-02: no donor sentence carries the whole source quote'), !c.carried, c.why);
    assert.deepEqual(editorMaterial(t).donors['R01-02'], c.carried ? [sentence] : [], c.why);
    // mergecheck itself (the shipped gate) on a scene that holds the donor sentence verbatim.
    assert.equal(renderedViolations(placed, edit, t).includes(`09: sentence matches no source: ${sentence}`), !c.carried, c.why);
  }
  rmSync(dir, { recursive: true });
});
