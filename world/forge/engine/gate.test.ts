import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FORBIDDEN, DEFAULT_NEGATION_EXCEPTIONS, DEFAULT_NEGATIONS, mechanicalGate, type GateCheck, type GateOptions, type GateResult } from './gate.ts';
import type { Claim, WriterOutput } from './writer-output.ts';

function claim(over: Partial<Claim>): Claim {
  return { id: 'A-01', kind: 'author_fact', claim: 'c', status: '状态与路径实例', rowId: 'SHIP', attachesTo: '04', extends: 'F07', misuse: 'm', sourceQuote: '温芮把旧水壶放回架上', register: true, ...over };
}

function output(over: Partial<WriterOutput>): WriterOutput {
  return {
    submission: '温芮把旧水壶放回架上。灯亮了。',
    delta: { newProperNouns: [], claims: [claim({})] },
    iface: { shots: [{}, {}, {}], object: { name: '壶' }, hook: { t: 1 }, raw: {} },
    seeds: [],
    ...over,
  };
}

const failed = (out: WriterOutput, baseline = false): string[] => mechanicalGate(out, { baseline }).checks.filter((c) => !c.ok).map((c) => c.name);

test('a clean submission passes', () => {
  assert.equal(mechanicalGate(output({}), { baseline: false }).pass, true);
});

test('length over 2500 characters fails', () => {
  assert.deepEqual(failed(output({ submission: `温芮把旧水壶放回架上。${'字'.repeat(2500)}` })), ['length']);
});

test('more than three new proper nouns fails', () => {
  // Each noun appears in two sentences so that only the count limit is at stake here.
  const submission = '温芮把旧水壶放回架上。a、b、c、d。a、b、c、d。';
  assert.deepEqual(failed(output({ submission, delta: { newProperNouns: ['a', 'b', 'c', 'd'], claims: [claim({})] } })), ['new_proper_nouns']);
});

test('more than six registered facts fails', () => {
  const claims = Array.from({ length: 7 }, (_, i) => claim({ id: `A-0${i}` }));
  assert.deepEqual(failed(output({ delta: { newProperNouns: [], claims } })), ['registered_facts']);
});

test('a source quote that is not in the submission fails', () => {
  assert.deepEqual(failed(output({ delta: { newProperNouns: [], claims: [claim({ sourceQuote: '不存在的句子' })] } })), ['source_quotes']);
});

test('more than three facts without extends fails', () => {
  const claims = Array.from({ length: 4 }, (_, i) => claim({ id: `A-0${i}`, extends: '' }));
  assert.deepEqual(failed(output({ delta: { newProperNouns: [], claims } })), ['facts_without_extends']);
});

test('rule-heavy narration fails', () => {
  assert.deepEqual(failed(output({ submission: '温芮把旧水壶放回架上。船员必须签到。' })), ['rule_sentences']);
});

test('interface card needs three shots, an object and a hook', () => {
  assert.deepEqual(failed(output({ iface: { shots: [{}], object: null, hook: { t: 1 }, raw: {} } })), ['interface']);
});

test('a baseline may not add author facts', () => {
  assert.deepEqual(failed(output({}), true), ['baseline_no_new_facts']);
});

const run = (out: WriterOutput, extra: Omit<GateOptions, 'baseline'> = {}): GateResult => mechanicalGate(out, { baseline: false, ...extra });
const checkOf = (r: GateResult, name: string): GateCheck | undefined => r.checks.find((c) => c.name === name);
const failedOf = (r: GateResult): string[] => r.checks.filter((c) => !c.ok).map((c) => c.name);
const peiji = [{ term: '配给', protects: 'F07' }];

test('existing checks keep their names and order; new checks follow the interface check, markup before the baseline check', () => {
  const r = run(output({}));
  const names = ['length', 'new_proper_nouns', 'registered_facts', 'source_quotes', 'facts_without_extends', 'rule_sentences', 'interface', 'forbidden_words', 'dangling_nouns', 'anchors', 'markup'];
  assert.deepEqual(r.checks.map((c) => c.name), names);
  assert.equal(r.checks.some((c) => 'flags' in c), false);
  assert.deepEqual(mechanicalGate(output({}), { baseline: true }).checks.map((c) => c.name), [...names, 'baseline_no_new_facts']);
});

test('defaults: no forbidden words, the documented negation markers', () => {
  assert.deepEqual(DEFAULT_FORBIDDEN, []);
  assert.deepEqual(DEFAULT_NEGATIONS, ['没有', '无', '不', '非', '并非', '不是', '未', '别', '禁止', '不能', '不会', '从未', '绝无']);
});

test('a forbidden term in a sentence without negation fails', () => {
  const r = run(output({ submission: '温芮把旧水壶放回架上。配给站开门了。' }), { forbidden: peiji });
  assert.deepEqual(failedOf(r), ['forbidden_words']);
  assert.match(checkOf(r, 'forbidden_words')?.detail ?? '', /配给站开门了。/u);
});

test('a forbidden term hidden by Markdown emphasis is still found', () => {
  const r = run(output({ submission: '温芮把旧水壶放回架上。**配**给站开门了。' }), { forbidden: peiji });
  assert.deepEqual(failedOf(r), ['forbidden_words']);
});

test('a forbidden term in a negated sentence is flagged, not failed', () => {
  const r = run(output({ submission: '温芮把旧水壶放回架上。这里没有配给站。灯亮了。' }), { forbidden: peiji });
  assert.equal(r.pass, true);
  const c = checkOf(r, 'forbidden_words');
  assert.equal(c?.ok, true);
  assert.deepEqual(c?.flags, ['这里没有配给站。']);
  assert.match(c?.detail ?? '', /这里没有配给站。/u);
});

test('negation markers come from the options when given', () => {
  const r = run(output({ submission: '温芮把旧水壶放回架上。这里没有配给站。' }), { forbidden: peiji, negations: ['绝不'] });
  assert.deepEqual(failedOf(r), ['forbidden_words']);
  assert.equal(checkOf(r, 'forbidden_words')?.flags, undefined);
});

test('one sentence with two forbidden terms is reported once', () => {
  const forbidden = [...peiji, { term: '口粮', protects: 'F08' }];
  const r = run(output({ submission: '温芮把旧水壶放回架上。这里没有配给口粮。' }), { forbidden });
  assert.deepEqual(checkOf(r, 'forbidden_words')?.flags, ['这里没有配给口粮。']);
});

test('an empty forbidden term or negation marker matches nothing', () => {
  const r = run(output({ submission: '温芮把旧水壶放回架上。配给站开门了。' }), { forbidden: [{ term: '', protects: 'x' }, ...peiji], negations: [''] });
  assert.deepEqual(failedOf(r), ['forbidden_words']);
  assert.equal(checkOf(r, 'forbidden_words')?.flags, undefined);
});

test('a new proper noun that appears in only one sentence dangles', () => {
  const delta = { newProperNouns: ['水壶巷'], claims: [claim({})] };
  const once = run(output({ submission: '温芮把旧水壶放回架上。水壶巷的水壶巷很安静。', delta }));
  assert.deepEqual(failedOf(once), ['dangling_nouns']);
  assert.match(checkOf(once, 'dangling_nouns')?.detail ?? '', /水壶巷/u);
  const twice = run(output({ submission: '温芮把旧水壶放回架上。水壶巷很安静。她走出**水壶巷**。', delta }));
  assert.deepEqual(failedOf(twice), []);
});

test('an author fact must attach to canon files 01-08', () => {
  for (const good of ['04', '04-life-and-people', '01', '08-x']) {
    assert.deepEqual(failedOf(run(output({ delta: { newProperNouns: [], claims: [claim({ attachesTo: good })] } }))), [], good);
  }
  for (const bad of ['F07', '09', '4', '004', '', '04x', 'R01']) {
    const r = run(output({ delta: { newProperNouns: [], claims: [claim({ attachesTo: bad })] } }));
    assert.deepEqual(failedOf(r), ['anchors'], bad);
  }
});

test('anchors ignore character beliefs and rumors', () => {
  const claims = [claim({}), claim({ id: 'B-01', kind: 'character_belief', attachesTo: '' }), claim({ id: 'C-01', kind: 'rumor', attachesTo: 'x' })];
  assert.deepEqual(failedOf(run(output({ delta: { newProperNouns: [], claims } }))), []);
});

test('valid anchors come from the options, and a global pattern tests every fact independently', () => {
  const claims = [claim({ attachesTo: 'R01' }), claim({ id: 'A-02', attachesTo: 'R02' })];
  assert.deepEqual(failedOf(run(output({ delta: { newProperNouns: [], claims } }), { validAnchors: /^R\d{2}/gu })), []);
  const r = run(output({ delta: { newProperNouns: [], claims: [claim({})] } }), { validAnchors: /^R\d{2}$/u });
  assert.deepEqual(failedOf(r), ['anchors']);
  assert.match(checkOf(r, 'anchors')?.detail ?? '', /A-01/u);
});

test('limits come from the options when given, e.g. the protocol limits block', () => {
  const out = output({ submission: '温芮把旧水壶放回架上。' });
  const tight = { maxChars: 5, maxNewProperNouns: 3, maxRegistered: 6, maxWithoutExtends: 3, maxRuleRatio: 0.15 };
  const r = run(out, { limits: tight });
  assert.deepEqual(failedOf(r), ['length']);
  assert.match(checkOf(r, 'length')?.detail ?? '', /\/ 5 字/u);
  assert.deepEqual(failedOf(run(out)), []);
});

// Negation is decided per clause, and a negation character inside an ordinary word does not count.
const xingmen = [{ term: '星门', protects: 'F03' }];
const forbiddenOf = (submission: string, extra: Omit<GateOptions, 'baseline'> = {}): GateCheck | undefined =>
  checkOf(run(output({ submission: `温芮把旧水壶放回架上。${submission}` }), extra), 'forbidden_words');

test('default negation exceptions: the documented compounds that contain a negation character', () => {
  assert.ok(DEFAULT_NEGATION_EXCEPTIONS.length > 0);
  for (const e of DEFAULT_NEGATION_EXCEPTIONS) assert.ok(DEFAULT_NEGATIONS.some((m) => e.includes(m)), e);
  assert.equal(new Set(DEFAULT_NEGATION_EXCEPTIONS).size, DEFAULT_NEGATION_EXCEPTIONS.length);
});

test('不久 is not a negation: 不久，远航号穿过了星门。 fails', () => {
  const c = forbiddenOf('不久，远航号穿过了星门。', { forbidden: xingmen });
  assert.equal(c?.ok, false);
  assert.equal(c?.flags, undefined);
});

test('an exception compound in the same clause is not a negation: 远航号不久穿过了星门。 fails', () => {
  assert.equal(forbiddenOf('远航号不久穿过了星门。', { forbidden: xingmen })?.ok, false);
});

test('非常 is not a negation: 配给站今天非常忙。 fails for 配给', () => {
  const c = forbiddenOf('配给站今天非常忙。', { forbidden: peiji });
  assert.equal(c?.ok, false);
  assert.match(c?.detail ?? '', /未否定：配给（F07）：配给站今天非常忙。/u);
});

test('every default exception compound is not a negation on its own', () => {
  for (const e of DEFAULT_NEGATION_EXCEPTIONS) {
    assert.equal(forbiddenOf(`${e}配给站开门了。`, { forbidden: peiji })?.ok, false, e);
  }
});

test('a real negation in the clause of the term flags it: 远航号没有穿过星门。 is flagged', () => {
  const c = forbiddenOf('远航号没有穿过星门。', { forbidden: xingmen });
  assert.equal(c?.ok, true);
  assert.deepEqual(c?.flags, ['远航号没有穿过星门。']);
});

test('a negation after the term in the same clause flags it: 所谓星门并不存在。 is flagged', () => {
  const c = forbiddenOf('所谓星门并不存在。', { forbidden: xingmen });
  assert.equal(c?.ok, true);
  assert.deepEqual(c?.flags, ['所谓星门并不存在。']);
});

test('a negation in a different clause does not negate the term: 星门，他从未见过。 fails', () => {
  const c = forbiddenOf('星门，他从未见过。', { forbidden: xingmen });
  assert.equal(c?.ok, false);
  assert.equal(c?.flags, undefined);
});

test('clauses split at every listed separator, full-width and ASCII', () => {
  for (const sep of ['，', ',', '：', ':', '、']) {
    assert.equal(forbiddenOf(`星门${sep}他从未见过。`, { forbidden: xingmen })?.ok, false, sep);
  }
});

test('a real negation next to an exception compound in the same clause still negates', () => {
  const c = forbiddenOf('不久之后这里没有配给站。', { forbidden: peiji });
  assert.equal(c?.ok, true);
  assert.deepEqual(c?.flags, ['不久之后这里没有配给站。']);
});

test('one negated and one unnegated occurrence in the same sentence fails', () => {
  assert.equal(forbiddenOf('配给站没有开门，配给车来了。', { forbidden: peiji })?.ok, false);
});

test('negation exceptions come from the options when given, and a marker may sit anywhere inside an exception', () => {
  assert.deepEqual(forbiddenOf('配给站今天非常忙。', { forbidden: peiji, negationExceptions: [] })?.flags, ['配给站今天非常忙。']);
  // 莫非 ("could it be") carries 非 at offset 1.
  assert.deepEqual(forbiddenOf('莫非配给站关了？', { forbidden: peiji })?.flags, ['莫非配给站关了？']);
  assert.equal(forbiddenOf('莫非配给站关了？', { forbidden: peiji, negationExceptions: ['莫非'] })?.ok, false);
  // An exception that ends right at the start of the clause must not be matched against a negative offset.
  assert.deepEqual(forbiddenOf('非配给站。', { forbidden: peiji, negationExceptions: ['莫非'] })?.flags, ['非配给站。']);
});

test('terms, markers and exceptions compare by NFKC', () => {
  const aqu = [{ term: 'Ａ区', protects: 'F01' }];
  assert.equal(forbiddenOf('A区开门了。', { forbidden: aqu })?.ok, false);
  assert.deepEqual(forbiddenOf('A区没有开门。', { forbidden: aqu })?.flags, ['A区没有开门。']);
  assert.deepEqual(forbiddenOf('A区 NOT 开门。', { forbidden: aqu, negations: ['ＮＯＴ'] })?.flags, ['A区 NOT 开门。']);
  assert.equal(forbiddenOf('A区 NOTE 开门。', { forbidden: aqu, negations: ['ＮＯＴ'], negationExceptions: ['ＮＯＴＥ'] })?.ok, false);
});

// A forbidden term may not escape through a soft line break or an invisible format character.
const shenji = [{ term: '神迹', protects: 'F03' }];

test('a forbidden term split by a single newline inside a paragraph is found', () => {
  assert.equal(forbiddenOf('那是一次神\n迹。', { forbidden: shenji })?.ok, false);
  assert.deepEqual(forbiddenOf('这里没有配\n给站。', { forbidden: peiji })?.flags, ['这里没有配给站。']);
});

test('a paragraph break still separates sentences for the forbidden-word check', () => {
  assert.equal(forbiddenOf('那是一次神\n\n迹。', { forbidden: shenji })?.detail, '未出现禁用词');
});

test('a forbidden term containing an invisible format character is found', () => {
  for (const cf of ['​', '‌', '‍', '⁠', '­', '﻿']) {
    assert.equal(forbiddenOf(`那是一次神${cf}迹。`, { forbidden: shenji })?.ok, false, JSON.stringify(cf));
  }
});

// Link and image targets, titles and HTML are deleted by stripMarkdown, so text there would go unchecked.
test('markup that hides text fails the markup check and names the offending lines', () => {
  const cases = [
    '[那一夜](神迹)灯亮了。',
    '[灯亮了。](x "冷湾其实是一座监狱")',
    '![](远航号在三年前已经断电)',
    '![图]',
    '<span title="神迹">灯亮了。</span>',
    '<!-- 神迹 -->',
    '灯亮了。</b>',
  ];
  for (const line of cases) {
    const r = run(output({ submission: `温芮把旧水壶放回架上。\n${line}\n灯亮了。` }));
    assert.deepEqual(failedOf(r), ['markup'], line);
    const detail = checkOf(r, 'markup')?.detail ?? '';
    assert.match(detail, /第 2 行/u, line);
    assert.equal(detail.includes(line), true, line);
    assert.doesNotMatch(detail, /第 [13] 行/u, line);
  }
});

test('ordinary brackets, full-width marks and comparisons are not markup', () => {
  const r = run(output({ submission: '温芮把旧水壶放回架上。[注] 灯亮了！[二] 3 < 5，(括号)也行。' }));
  assert.deepEqual(failedOf(r), []);
  assert.equal(checkOf(r, 'markup')?.detail, '无链接、图片或 HTML 标记');
});

test('dangling nouns compare nouns and sentences by NFKC', () => {
  const full = { newProperNouns: ['Ａ区'], claims: [claim({})] };
  assert.deepEqual(failedOf(run(output({ submission: '温芮把旧水壶放回架上。A区很安静。她走出A区。', delta: full }))), []);
  const half = { newProperNouns: ['A区'], claims: [claim({})] };
  assert.deepEqual(failedOf(run(output({ submission: '温芮把旧水壶放回架上。Ａ区很安静。她走出Ａ区。', delta: half }))), []);
});

test('a CRLF soft line break joins like a newline and a CRLF blank line still separates paragraphs', () => {
  assert.equal(forbiddenOf('那是一次神\r\n迹。', { forbidden: shenji })?.ok, false);
  assert.equal(forbiddenOf('那是一次神\r迹。', { forbidden: shenji })?.ok, false);
  assert.equal(forbiddenOf('那是一次神\r\n\r\n迹。', { forbidden: shenji })?.detail, '未出现禁用词');
});

const forbiddenFor = (submission: string, term: string): GateCheck | undefined =>
  checkOf(run(output({ submission }), { forbidden: [{ term, protects: '测试' }] }), 'forbidden_words');

test('soft-break joining stops at block boundaries: list items and a heading stay separate sentences', () => {
  assert.equal(forbiddenFor('温芮把旧水壶放回架上。\n\n- 舱里没有灯\n- 远航号在跃迁中开火', '跃迁中开火')?.ok, false);
  assert.equal(forbiddenFor('# 没有退路\n远航号在跃迁中转向。\n\n温芮把旧水壶放回架上。', '跃迁中转向')?.ok, false);
  assert.equal(forbiddenFor('## 远方的群星\n门外有人在等。\n\n温芮把旧水壶放回架上。', '星门')?.ok, true);
  assert.equal(forbiddenFor('温芮把旧水壶放回架上。\n\n- 头顶是群星\n- 门外有人在等', '星门')?.ok, true);
  assert.equal(forbiddenFor('温芮把旧水壶放回架上，头顶是群星\n---\n门外有人在等。', '星门')?.ok, true);
});

test('a soft break with whitespace around it, or an indented continuation, still joins', () => {
  assert.equal(forbiddenFor('温芮把旧水壶放回架上。那是一次神 \n迹。', '神迹')?.ok, false);
  assert.equal(forbiddenFor('温芮把旧水壶放回架上。那是一次神\n  迹。', '神迹')?.ok, false);
  assert.equal(forbiddenFor('温芮把旧水壶放回架上。\n\n- 那是一次神\n  迹。', '神迹')?.ok, false);
  assert.equal(forbiddenFor('温芮把旧水壶放回架上。\n\n> 那是一次神\n> 迹。', '神迹')?.ok, false);
  assert.equal(forbiddenFor('温芮把旧水壶放回架上。\n\n> 那是一次神\n迹。', '神迹')?.ok, false);
});

test('invisible characters outside \\p{Cf}, line separators and controls do not hide a term', () => {
  for (const x of ['͏', '️', '︀', 'ㅤ', ' ', '\u0085', '\u0007']) {
    assert.equal(forbiddenFor(`温芮把旧水壶放回架上。那是一次神${x}迹。`, '神迹')?.ok, false, JSON.stringify(x));
  }
});

test('HTML character references count as markup', () => {
  const r = run(output({ submission: '温芮把旧水壶放回架上。那是一次神&#36857;。&zwj;还有&amp;' }));
  assert.equal(checkOf(r, 'markup')?.ok, false);
  assert.equal(checkOf(run(output({ submission: '温芮把旧水壶放回架上。A&B 两组都在。' })), 'markup')?.ok, true);
});

test('common compounds with a negation character are exceptions by default', () => {
  for (const s of ['远航号特别穿过了星门。', '两艘船分别穿过星门。', '他们在星门前告别。', '星门和航道的区别很大。', '南非有星门。', '远航号不得不穿过星门。']) {
    assert.equal(forbiddenFor(`温芮把旧水壶放回架上。${s}`, '星门')?.ok, false, s);
  }
});

test('a forbidden term split by whitespace, a hyphen or a middle dot is still found', () => {
  for (const s of ['跨星-即时通信可用。', '跨星　即时通信可用。', '跨星 即时通信可用。', '跨星·即时通信可用。', '跨星‐即时通信可用。']) {
    assert.equal(forbiddenFor(`温芮把旧水壶放回架上。${s}`, '跨星即时')?.ok, false, s);
  }
});

test('a visible comma or dash between two words does not form a forbidden term', () => {
  assert.equal(forbiddenFor('温芮睡了一觉，醒来时炉子已经凉了。', '觉醒')?.ok, true);
  assert.equal(forbiddenFor('远处有星，门开着。', '星门')?.ok, true);
  assert.equal(forbiddenFor('远处有星、门和灯。', '星门')?.ok, true);
  assert.equal(forbiddenFor('远处有星——门开着。', '星门')?.ok, true);
});

test('a split term is negated only by a marker in its own clause', () => {
  const negated = forbiddenFor('温芮把旧水壶放回架上。没有跨星-即时通信这回事。', '跨星即时');
  assert.equal(negated?.ok, true);
  assert.equal(negated?.flags?.length, 1);
  assert.equal(forbiddenFor('没有星门，跨星-即时通信可用。', '跨星即时')?.ok, false);
});

test('affirmative 无 compounds are exceptions: 无处不在, 无不, 无可', () => {
  for (const s of ['星门无处不在。', '人们无不谈起星门。', '星门无可替代。']) {
    assert.equal(forbiddenFor(`温芮把旧水壶放回架上。${s}`, '星门')?.ok, false, s);
  }
});
