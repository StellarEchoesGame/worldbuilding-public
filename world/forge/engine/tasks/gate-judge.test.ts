import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FactRow, ForbiddenRow, RegressionRow } from '../steps/brief.ts';
import { quoteSpan, unwrap, wrapText } from './fenced.ts';
import { caughtDefect, classifyFinding, gateJudgeTask, gateOutcome, parseGateVerdict, type GatePack, type GateVerdict } from './gate-judge.ts';
import { ROLE_GATE } from './roles.ts';

const SUBJECT = '温芮把借来的扳手挂回工具墙。循环泵换了节拍。林澈说冷凝管今晚要换滤网。星门在舷窗外亮了一下。';
const FACTS: FactRow[] = [
  { id: 'F01', kind: 'fact', text: '没有星门，也没有超光速航行。', status: '共同事实', rows: ['ALL'] },
  { id: 'F14', kind: 'fact', text: '更名后的810人为指定接应实例。', status: '状态与路径实例', rows: ['ALL'] },
  { id: 'R00-01', kind: 'registered', text: '邻里共用工具柜不上锁。', status: '状态与路径实例', rows: ['SHIP'] },
];
const REGRESSION: RegressionRow[] = [{ id: 'G-001', case: 'P01', source: 'judge-a', quote: '砧港的维修棚彻夜亮灯。' }];
const FORBIDDEN: ForbiddenRow[] = [{ id: 'X01', text: '出现未登记的第三方势力' }];
const PACK: GatePack = { subjectKind: 'text', subject: SUBJECT, facts: FACTS, regression: REGRESSION, forbidden: FORBIDDEN, negatedFlags: ['没有星门的夜里很安静。'] };

function fence(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

function finding(quote: string, against: string, reason = '与事实表矛盾'): Record<string, string> {
  return { quote, against, reason };
}

test('gateJudgeTask: role, wrapped subject, fact / regression / negation lines, output block, no slot, no retryPrompt', () => {
  const spec = gateJudgeTask(PACK, 'gate-W1-xAI-1', 'seed');
  assert.equal(spec.id, 'gate-W1-xAI-1');
  assert.equal(spec.role, ROLE_GATE);
  assert.equal(spec.retryPrompt, undefined);
  assert.equal(unwrap(spec.prompt, '文本甲'), SUBJECT);
  assert.match(spec.prompt, /只判断下面的文字是否与冻结事实表、回归证据矛盾或写出了禁用写法里的事物，不评价文笔/u);
  assert.match(spec.prompt, /【待查文本】/u);
  assert.equal(unwrap(spec.prompt, '事实表'), 'F01｜共同事实｜没有星门，也没有超光速航行。\nF14｜状态与路径实例｜更名后的810人为指定接应实例。\nR00-01｜状态与路径实例｜邻里共用工具柜不上锁。');
  assert.equal(unwrap(spec.prompt, '回归证据'), 'G-001｜P01｜砧港的维修棚彻夜亮灯。');
  assert.equal(unwrap(spec.prompt, '否定句'), '- 没有星门的夜里很安静。');
  assert.match(spec.prompt, /只输出一个 ```json 代码块/u);
  assert.doesNotMatch(spec.prompt, /\{[A-Z_]+\}/u);
  const empty = gateJudgeTask({ ...PACK, regression: [], forbidden: [], negatedFlags: [], subjectKind: 'fact_set' }, 'regate-d8-xAI', 'seed');
  assert.match(empty.prompt, /【待查事实集】/u);
  assert.equal(unwrap(empty.prompt, '回归证据'), '（无）');
  assert.equal(unwrap(empty.prompt, '禁用写法'), '（无）');
  assert.equal(unwrap(empty.prompt, '否定句'), '（无）');
});

test('gateJudgeTask: the real text and the copy give prompts identical in form; a subject holding its delimiter crashes', () => {
  const real = gateJudgeTask(PACK, 'gate-W1-xAI-1', 'seed').prompt;
  const copy = gateJudgeTask({ ...PACK, subject: SUBJECT.replace('循环泵换了节拍。', '循环泵停了。') }, 'gatecopy-W1-xAI-1', 'seed').prompt;
  const shape = (p: string): string => p.replace(/·[0-9a-f]{4}〕/gu, '·xxxx〕').replace(/〔文本甲·xxxx〕\n[\s\S]*?\n〔文本甲完·xxxx〕/u, 'SUBJECT');
  assert.equal(shape(real), shape(copy));
  const probe = wrapText('文本甲', 'x', 'seed', 'gate-W1-xAI-1:文本甲');
  assert.ok(probe.ok);
  const tag = probe.value.slice(probe.value.indexOf('·') + 1, probe.value.indexOf('〕'));
  assert.throws(() => gateJudgeTask({ ...PACK, subject: `${SUBJECT}·${tag}〕` }, 'gate-W1-xAI-1', 'seed'), /cannot wrap 文本甲/u);
});

test('parseGateVerdict accepts a clean verdict and classifies findings from the pack (path instance never makes yes)', () => {
  const clean = parseGateVerdict(fence({ contradiction: false, findings: [] }), PACK);
  assert.deepEqual(clean, { ok: true, value: { contradiction: false, findings: [], yes: false } });
  const binding = parseGateVerdict(fence({ contradiction: true, findings: [finding('星门在舷窗外亮了一下', 'F01')] }), PACK);
  assert.ok(binding.ok);
  assert.equal(binding.value.yes, true);
  assert.equal(binding.value.findings[0]?.class, 'binding');
  const path = parseGateVerdict(fence({ contradiction: true, findings: [finding('林澈说冷凝管今晚要换滤网', 'F14')] }), PACK);
  assert.ok(path.ok);
  assert.equal(path.value.yes, false, 'a path-instance finding alone is not a yes');
  assert.equal(path.value.findings[0]?.class, 'path_instance');
  const rxx = parseGateVerdict(fence({ contradiction: true, findings: [finding('温芮把借来的扳手挂回工具墙', 'R00-01')] }), PACK);
  assert.ok(rxx.ok);
  assert.equal(rxx.value.yes, true, 'an Rxx finding is binding even with status 状态与路径实例');
  const g = parseGateVerdict(`说明文字\n${fence({ contradiction: true, findings: [finding('循环泵换了节拍', 'G-001')] })}`, PACK);
  assert.ok(g.ok);
  assert.equal(g.value.yes, true);
  const eight = Array.from({ length: 8 }, () => finding('星门在舷窗外亮了一下', 'F01'));
  assert.ok(parseGateVerdict(fence({ contradiction: true, findings: eight }), PACK).ok);
  assert.ok(parseGateVerdict(fence({ contradiction: true, findings: [finding('星门在舷窗外亮了一下', 'F01', '理'.repeat(80))] }), PACK).ok);
});

test('a forbidden-move id (X01) is offered in the prompt and accepted as a binding against; unoffered it is rejected', () => {
  const spec = gateJudgeTask(PACK, 'gate-W1-xAI-1', 'seed');
  assert.equal(unwrap(spec.prompt, '禁用写法'), 'X01｜出现未登记的第三方势力');
  assert.match(spec.prompt, /只能用上面事实表、回归证据或禁用写法里的编号/u);
  const quote = '林澈说冷凝管今晚要换滤网';
  const x = parseGateVerdict(fence({ contradiction: true, findings: [finding(quote, 'X01')] }), PACK);
  assert.ok(x.ok);
  assert.deepEqual([x.value.yes, x.value.findings[0]?.class], [true, 'binding']);
  assert.equal(caughtDefect(x.value, SUBJECT, quoteSpan(quote, SUBJECT) ?? { start: 0, end: 0 }), true, 'a copy quoted against the X-id is caught');
  const none = parseGateVerdict(fence({ contradiction: true, findings: [finding(quote, 'X01')] }), { ...PACK, forbidden: [] });
  assert.ok(!none.ok);
  assert.match(none.error, /against: not an id of the fact table, the regression list or the forbidden moves/u);
});

test('parseGateVerdict rejects one fixture per validation rule with ASCII errors that never echo model text', () => {
  const ok1 = finding('星门在舷窗外亮了一下', 'F01');
  const cases: Array<[string, string, RegExp]> = [
    ['missing fence', JSON.stringify({ contradiction: false, findings: [] }), /exactly one fenced json block, found 0/u],
    ['two fences', `${fence({ contradiction: false, findings: [] })}\n${fence({ contradiction: false, findings: [] })}`, /found 2/u],
    ['contradiction not boolean', fence({ contradiction: 'yes', findings: [] }), /contradiction: missing or not a boolean/u],
    ['findings not array', fence({ contradiction: false, findings: null }), /findings: missing or not an array/u],
    ['true without findings', fence({ contradiction: true, findings: [] }), /contradiction must be true exactly when/u],
    ['false with findings', fence({ contradiction: false, findings: [ok1] }), /contradiction must be true exactly when/u],
    ['nine findings', fence({ contradiction: true, findings: Array.from({ length: 9 }, () => ok1) }), /more than 8/u],
    ['finding not object', fence({ contradiction: true, findings: ['星门'] }), /findings\[0\]: not an object/u],
    ['quote not cited', fence({ contradiction: true, findings: [finding('舷窗外飘着一艘飞船', 'F01')] }), /findings\[0\]\.quote: not a verbatim quote/u],
    ['quote too short', fence({ contradiction: true, findings: [finding('星门在', 'F01')] }), /findings\[0\]\.quote: not a verbatim quote/u],
    ['quote missing', fence({ contradiction: true, findings: [{ against: 'F01', reason: 'r' }] }), /findings\[0\]\.quote: missing/u],
    ['wrong id', fence({ contradiction: true, findings: [finding('星门在舷窗外亮了一下', 'F99')] }), /findings\[0\]\.against: not an id/u],
    ['reason over cap', fence({ contradiction: true, findings: [finding('星门在舷窗外亮了一下', 'F01', '理'.repeat(81))] }), /findings\[0\]\.reason: longer than 80/u],
    ['reason empty', fence({ contradiction: true, findings: [finding('星门在舷窗外亮了一下', 'F01', '  ')] }), /findings\[0\]\.reason: empty/u],
  ];
  for (const [name, text, pattern] of cases) {
    const r = parseGateVerdict(text, PACK);
    assert.equal(r.ok, false, name);
    if (r.ok) continue;
    assert.match(r.error, pattern, name);
    assert.match(r.error, /^[\x20-\x7e]*$/u, `${name}: ASCII only`);
  }
});

test('classifyFinding: only a kind-fact row with status 状态与路径实例 is path_instance', () => {
  assert.equal(classifyFinding({ against: 'F14' }, FACTS), 'path_instance');
  assert.equal(classifyFinding({ against: 'F01' }, FACTS), 'binding');
  assert.equal(classifyFinding({ against: 'R00-01' }, FACTS), 'binding');
  assert.equal(classifyFinding({ against: 'G-001' }, FACTS), 'binding');
});

const YES: GateVerdict = { contradiction: true, findings: [{ quote: '星门在舷窗外亮了一下', against: 'F01', reason: 'r', class: 'binding' }], yes: true };
const NO: GateVerdict = { contradiction: false, findings: [], yes: false };

test('gateOutcome: both yes → fail, one → split, none → pass, fewer than two valid → unverified', () => {
  assert.equal(gateOutcome([YES, YES]), 'fail');
  assert.equal(gateOutcome([YES, NO]), 'split');
  assert.equal(gateOutcome([NO, YES]), 'split');
  assert.equal(gateOutcome([NO, NO]), 'pass');
  assert.equal(gateOutcome([YES, null]), 'unverified');
  assert.equal(gateOutcome([null, null]), 'unverified');
  assert.equal(gateOutcome([]), 'unverified');
  assert.equal(gateOutcome([null, NO, YES, YES]), 'split', 'the first two valid verdicts decide');
});

test('caughtDefect: a binding finding overlapping the injected span by ≥ 4 normalized chars', () => {
  const copy = SUBJECT.replace('循环泵换了节拍。', '循环泵从来不停。');
  const span = quoteSpan('循环泵从来不停。', copy);
  assert.ok(span !== null);
  const verdict = (quote: string, against: string, cls: 'binding' | 'path_instance'): GateVerdict => ({
    contradiction: true, findings: [{ quote, against, reason: 'r', class: cls }], yes: cls === 'binding',
  });
  assert.equal(caughtDefect(verdict('循环泵从来不停', 'F01', 'binding'), copy, span), true);
  assert.equal(caughtDefect(verdict('扳手挂回工具墙。循环泵从来', 'F01', 'binding'), copy, span), true, 'partial overlap of 5 chars');
  assert.equal(caughtDefect(verdict('扳手挂回工具墙。循环泵', 'F01', 'binding'), copy, span), false, 'overlap of 3 chars');
  assert.equal(caughtDefect(verdict('星门在舷窗外亮了一下', 'F01', 'binding'), copy, span), false, 'a finding elsewhere');
  assert.equal(caughtDefect(verdict('循环泵从来不停', 'F14', 'path_instance'), copy, span), false, 'path instance never catches');
  assert.equal(caughtDefect(NO, copy, span), false);
  assert.equal(caughtDefect(null, copy, span), false);
});
