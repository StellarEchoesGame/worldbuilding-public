import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadSchema, validate } from '../schema.ts';
import { IntegrityError } from '../task.ts';
import { DEFAULT_MEASURES, parseBenchmark, TASTE_TEMPLATE_MAX, type Benchmark } from '../taste.ts';
import { outputBlock, unwrap } from './fenced.ts';
import {
  DEFAULT_TASTE_TEMPLATE, parseTasteVerdict, PROMPT_SLOTS, renderTasteTemplate, TASTE_OUTPUT_OVERRIDE, TASTE_TEXT_LABELS, tasteTask, type TasteInput, type TasteSlots,
} from './taste-pair.ts';

const BENCH: Benchmark = {
  version: 'v1', decisive: 'q1', minQuoteChars: 8, role: '你是一位盲评评委。', instructions: '每题二选一并引原文。',
  questions: [{ id: 'q1', text: '更想待在哪一篇？' }, { id: 'q2', text: '更记得住哪个人？' }],
  template: null, measures: DEFAULT_MEASURES, decoyRecipe: { details: 2, instructions: '泛化细节' }, checklistExtra: [],
};
const T1 = '温芮把借来的扳手挂回工具墙，循环泵换了节拍。';
const T2 = '林澈在走廊尽头停下，听见冷凝管里有细细的水声。';
const CHAMP = '她在配给簿上补了一行字，又去听循环泵的节拍。';
const DECOY = '她在本子上补了一行字，又去听机器的节拍。';
const WITH_DECOY: TasteInput = { text1: T1, text2: T2, decoy: { text3: DECOY, text4: CHAMP, decoyAt: 3 } };
const NO_DECOY: TasteInput = { text1: T1, text2: T2, decoy: null };
const SLOTS: TasteSlots = { TEXT_1: 'A', TEXT_2: 'B', DECOY_PAIR: '', QUESTIONS: 'Q' };

function fenced(value: unknown): string {
  return ['```json', JSON.stringify(value), '```'].join('\n');
}

const ANSWERS = { q1: { pick: 1, quote: '温芮把借来的扳手挂回' }, q2: { pick: '2', quote: '听见冷凝管里有细细的水声' } };

test('renderTasteTemplate substitutes each slot once in one pass', () => {
  const r = renderTasteTemplate('甲{TEXT_1}乙{TEXT_2}问{QUESTIONS}诱{DECOY_PAIR}', { TEXT_1: '{TEXT_2}', TEXT_2: '$&', DECOY_PAIR: '', QUESTIONS: '{Q}' });
  assert.deepEqual(r, { ok: true, value: '甲{TEXT_2}乙$&问{Q}诱' });
  const d = renderTasteTemplate(DEFAULT_TASTE_TEMPLATE, SLOTS);
  assert.equal(d.ok, true);
  assert.deepEqual(PROMPT_SLOTS, ['TEXT_1', 'TEXT_2', 'DECOY_PAIR', 'QUESTIONS']);
});

test('renderTasteTemplate rejects a missing, repeated or unknown slot, a fence and an over-long template', () => {
  const bad: Array<[string, RegExp]> = [
    ['{TEXT_1}{TEXT_2}{QUESTIONS}', /slot \{DECOY_PAIR\} must occur exactly once, found 0/u],
    ['{TEXT_1}{TEXT_1}{TEXT_2}{QUESTIONS}{DECOY_PAIR}', /slot \{TEXT_1\} must occur exactly once, found 2/u],
    ['{TEXT_1}{TEXT_2}{QUESTIONS}{DECOY_PAIR}{TEXT_3}', /unknown slot \{TEXT_3\}/u],
    ['{TEXT_1}{TEXT_2}{QUESTIONS}{DECOY_PAIR}{decisive}', /unknown slot \{decisive\}/u],
    ['{TEXT_1}{TEXT_2}{QUESTIONS}{DECOY_PAIR}{问题编号}', /unknown slot \{问题编号\}/u],
    ['{TEXT_1}{TEXT_2}{QUESTIONS}{DECOY_PAIR} {问题', /stray \{ or \}/u],
    ['{DECOY_PAIR}{TEXT_1}{TEXT_2}{QUESTIONS}', /\{DECOY_PAIR\} must come after \{TEXT_1\} and \{TEXT_2\}/u],
    ['{TEXT_1}{DECOY_PAIR}{TEXT_2}{QUESTIONS}', /\{DECOY_PAIR\} must come after/u],
    ['{TEXT_1}{TEXT_2}{QUESTIONS}{DECOY_PAIR}\n```json\n{}\n```', /must not hold a ``` fence/u],
    [`{TEXT_1}{TEXT_2}{QUESTIONS}{DECOY_PAIR}${'字'.repeat(TASTE_TEMPLATE_MAX)}`, /longer than 2000 chars/u],
  ];
  for (const [template, pattern] of bad) {
    const r = renderTasteTemplate(template, SLOTS);
    assert.equal(r.ok, false, template.slice(0, 40));
    if (!r.ok) assert.match(r.error, pattern);
  }
});

test('tasteTask: Chinese prompt, wrapped anonymized texts, decoy pair only when given, engine output block last', () => {
  const spec = tasteTask(BENCH, { ...WITH_DECOY, text1: `# 标题\n${T1.replace('扳手', '“扳手”')}` }, 'seed-t', 'taste-W1-xAI-s0-fwd');
  assert.equal(spec.id, 'taste-W1-xAI-s0-fwd');
  assert.equal(spec.role, BENCH.role);
  assert.equal(spec.retryPrompt, undefined, 'judges retry identically');
  assert.match(spec.prompt, /^下面是两篇匿名现场/u);
  assert.match(spec.prompt, /另有一组对照：第 3 篇与第 4 篇。只回答问题 q1/u);
  assert.equal(/\{[A-Z][A-Z0-9_]*\}/u.test(spec.prompt), false, 'no unreplaced slot');
  const [l1, l2, l3, l4] = TASTE_TEXT_LABELS;
  assert.equal(unwrap(spec.prompt, l1), T1.replace('扳手', '「扳手」'), 'heading dropped, curly quotes typeset');
  assert.deepEqual([unwrap(spec.prompt, l2), unwrap(spec.prompt, l3), unwrap(spec.prompt, l4)], [T2, DECOY, CHAMP]);
  assert.match(spec.prompt, /- q1：更想待在哪一篇？\n- q2：更记得住哪个人？/u);
  assert.ok(spec.prompt.includes(`${BENCH.instructions}\n\n${TASTE_OUTPUT_OVERRIDE}\n只输出一个 \`\`\`json 代码块`), 'the engine output rule overrides any in the instructions');
  assert.ok(spec.prompt.endsWith(outputBlock({ answers: { q1: { pick: '1 或 2', quote: '所选那篇中的逐字原文' }, q2: { pick: '1 或 2', quote: '所选那篇中的逐字原文' } }, decoy: { pick: '3 或 4', quote: '所选那篇中的逐字原文' } })));
  const plain = tasteTask(BENCH, NO_DECOY, 'seed-t', 'calib-C00-kimi-P03-ab');
  assert.equal(plain.prompt.includes('另有一组对照'), false, 'decoy: null renders an empty {DECOY_PAIR}');
  assert.equal(unwrap(plain.prompt, l3), null);
  assert.equal(plain.prompt.includes('"decoy"'), false);
});

test('tasteTask uses the benchmark template when set and refuses an invalid one', () => {
  const custom = tasteTask({ ...BENCH, template: '请读：{TEXT_1}\n再读：{TEXT_2}\n{DECOY_PAIR}\n回答：{QUESTIONS}' }, NO_DECOY, 's', 'taste-W1-xAI-s0-rev');
  assert.match(custom.prompt, /^请读：〔文本甲·/u);
  assert.match(custom.prompt, /回答：- q1/u);
  assert.throws(() => tasteTask({ ...BENCH, template: '{TEXT_1}{TEXT_2}' }, NO_DECOY, 's', 'taste-x'), (e: unknown) => e instanceof IntegrityError && /taste: benchmark v1 template: slot/u.test(e.message));
});

test('parseTasteVerdict accepts every question with cited quotes and computes preferredDecoy', () => {
  const kept = parseTasteVerdict(fenced({ answers: ANSWERS, decoy: { pick: 4, quote: '又去听循环泵的节拍' } }), BENCH, WITH_DECOY);
  assert.deepEqual(kept, {
    ok: true,
    value: { picks: { q1: 1, q2: 2 }, quotes: { q1: '温芮把借来的扳手挂回', q2: '听见冷凝管里有细细的水声' }, decoyPick: 4, decoyQuote: '又去听循环泵的节拍', preferredDecoy: false },
  });
  const fooled = parseTasteVerdict(fenced({ answers: ANSWERS, decoy: { pick: '3', quote: '又去听机器的节拍' } }), BENCH, WITH_DECOY);
  assert.equal(fooled.ok && fooled.value.preferredDecoy, true);
  const plain = parseTasteVerdict(fenced({ answers: ANSWERS, decoy: null }), BENCH, NO_DECOY);
  assert.deepEqual(plain.ok ? [plain.value.decoyPick, plain.value.decoyQuote, plain.value.preferredDecoy] : null, [null, null, false]);
});

test('parseTasteVerdict rejects each broken rule with an ASCII error', () => {
  const decoyOk = { pick: 4, quote: '又去听循环泵的节拍' };
  const cases: Array<[string, TasteInput, RegExp]> = [
    [fenced({ answers: { q1: ANSWERS.q1 }, decoy: decoyOk }), WITH_DECOY, /answers\.q2: missing answer/u],
    [fenced({ answers: { ...ANSWERS, q1: { pick: 3, quote: '温芮把借来的扳手挂回' } }, decoy: decoyOk }), WITH_DECOY, /answers\.q1\.pick: must be 1 or 2/u],
    [fenced({ answers: { ...ANSWERS, q1: { pick: '1.5', quote: '温芮把借来的扳手挂回' } }, decoy: decoyOk }), WITH_DECOY, /answers\.q1\.pick: must be 1 or 2/u],
    [fenced({ answers: { ...ANSWERS, q1: { pick: 2, quote: '温芮把借来的扳手挂回' } }, decoy: decoyOk }), WITH_DECOY, /answers\.q1\.quote: not a verbatim passage of text 2/u],
    [fenced({ answers: { ...ANSWERS, q1: { pick: 1, quote: '温芮把扳手' } }, decoy: decoyOk }), WITH_DECOY, /answers\.q1\.quote: not a verbatim passage of text 1 with at least 8/u],
    [fenced({ answers: { ...ANSWERS, q1: { pick: 1, quote: '温'.repeat(201) } }, decoy: decoyOk }), WITH_DECOY, /answers\.q1\.quote: longer than 200 chars/u],
    [fenced({ answers: { ...ANSWERS, q1: { pick: 1 } }, decoy: decoyOk }), WITH_DECOY, /answers\.q1\.quote: missing or not a string/u],
    [fenced({ answers: ANSWERS }), WITH_DECOY, /decoy: missing answer for the decoy pair/u],
    [fenced({ answers: ANSWERS, decoy: decoyOk }), NO_DECOY, /decoy: this call has no decoy pair/u],
    [fenced({ answers: ANSWERS, decoy: { pick: 2, quote: '又去听循环泵的节拍' } }), WITH_DECOY, /decoy\.pick: must be 3 or 4/u],
    [fenced({ answers: ANSWERS, decoy: { pick: 3, quote: '又去听循环泵的节拍' } }), WITH_DECOY, /decoy\.quote: not a verbatim passage of text 3/u],
    [fenced({ answers: [] }), WITH_DECOY, /answers: missing or not an object/u],
    [JSON.stringify({ answers: ANSWERS, decoy: decoyOk }), WITH_DECOY, /exactly one fenced json block, found 0/u],
    [`${fenced({ answers: ANSWERS, decoy: decoyOk })}\n${fenced({})}`, WITH_DECOY, /exactly one fenced json block, found 2/u],
  ];
  for (const [text, input, pattern] of cases) {
    const r = parseTasteVerdict(text, BENCH, input);
    assert.equal(r.ok, false, String(pattern));
    if (!r.ok) {
      assert.match(r.error, pattern);
      assert.match(r.error, /^[\x20-\x7e]*$/u, 'ASCII, never model text');
    }
  }
});

test('the taste task parse checks quotes against the anonymized texts judges saw', () => {
  const spec = tasteTask(BENCH, { text1: `# 题\n${T1.replace('扳手', '“扳手”')}`, text2: T2, decoy: null }, 's', 'taste-W1.W2-xAI-s0-fwd');
  const r = spec.parse(fenced({ answers: { q1: { pick: 1, quote: '借来的「扳手」挂回工具墙' }, q2: { pick: 2, quote: '听见冷凝管里有细细的水声' } } }));
  assert.equal(r.ok, true);
});

test('schema/benchmark.schema.json accepts an optional taste.template up to 2,000 chars; parseBenchmark agrees', () => {
  const schema = loadSchema(JSON.parse(readFileSync(new URL('../../schema/benchmark.schema.json', import.meta.url), 'utf8')));
  assert.ok(schema.ok);
  if (!schema.ok) return;
  const v0: unknown = JSON.parse(readFileSync(new URL('../../benchmark/v0.json', import.meta.url), 'utf8'));
  const withTemplate = (template: unknown): Record<string, unknown> => {
    const base = typeof v0 === 'object' && v0 !== null ? { ...v0 } : {};
    const taste = 'taste' in base && typeof base.taste === 'object' && base.taste !== null ? base.taste : {};
    return { ...base, taste: { ...taste, template } };
  };
  assert.deepEqual(validate(schema.value, v0), []);
  assert.deepEqual(validate(schema.value, withTemplate(DEFAULT_TASTE_TEMPLATE)), []);
  assert.deepEqual(validate(schema.value, withTemplate(null)), []);
  assert.notDeepEqual(validate(schema.value, withTemplate('字'.repeat(TASTE_TEMPLATE_MAX + 1))), []);
  const parsed = parseBenchmark(withTemplate(DEFAULT_TASTE_TEMPLATE));
  assert.equal(parsed.ok && parsed.value.template, DEFAULT_TASTE_TEMPLATE);
  assert.equal(parseBenchmark(withTemplate('字'.repeat(TASTE_TEMPLATE_MAX + 1))).ok, false);
  const slotRules: Array<[string, RegExp]> = [
    ['{TEXT_1}{TEXT_2}{QUESTIONS}', /taste\.template: slot \{DECOY_PAIR\} must occur exactly once, found 0/u],
    ['{DECOY_PAIR}{TEXT_1}{TEXT_2}{QUESTIONS}', /taste\.template: slot \{DECOY_PAIR\} must come after/u],
    ['{TEXT_1}{TEXT_2}{DECOY_PAIR}{QUESTIONS}```', /taste\.template: must not hold a ``` fence/u],
  ];
  for (const [template, pattern] of slotRules) {
    const r = parseBenchmark(withTemplate(template));
    assert.ok(!r.ok, 'a template breaking the slot rules is rejected at parse time, before the version can be adopted');
    assert.match(r.error, pattern);
  }
  const legacy = parseBenchmark(v0);
  assert.equal(legacy.ok && legacy.value.template, null);
});

test('tasteTask throws when a text holds its own delimiter token (injection guard)', () => {
  const spec = tasteTask(BENCH, WITH_DECOY, 'seed-t', 'taste-W1-xAI-s0-fwd');
  const open = spec.prompt.indexOf('〔文本乙·');
  const token = spec.prompt.slice(spec.prompt.indexOf('·', open), spec.prompt.indexOf('〕', open) + 1);
  assert.match(token, /^·.+〕$/u);
  assert.throws(() => tasteTask(BENCH, { ...WITH_DECOY, text2: `${T2}${token}` }, 'seed-t', 'taste-W1-xAI-s0-fwd'), (e: unknown) => e instanceof IntegrityError && /taste: cannot wrap 文本乙/u.test(e.message));
  assert.doesNotThrow(() => tasteTask(BENCH, { ...WITH_DECOY, text2: `${T2}${token}` }, 'seed-t', 'taste-W1-xAI-s0-rev'), 'the token is per task id');
});
