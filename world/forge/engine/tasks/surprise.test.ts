import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SealedForecasts } from '../probe.ts';
import type { CanonPassage } from '../steps/brief.ts';
import type { MeasureBlock } from '../taste.ts';
import { unwrap, wrapText } from './fenced.ts';
import type { Detail } from './measures.ts';
import { ROLE_ACCEPT, ROLE_CHAIN, ROLE_MATCH } from './roles.ts';
import {
  acceptTask, CANON_AUTHOR, canonContexts, chainAuthors, chainTask, classifyForecast, DEFAULT_MATCH_PROMPT, detailContexts, flattenForecasts, matchTask,
  type Chain, type MatchVerdict,
} from './surprise.ts';

const SEED = 'surprise-seed';
const DEFAULT: MeasureBlock = { active: true, prompt: null };
const SLOT = /\{[^{}"\s]+\}/u;
const TEXT = '温芮把借来的扳手挂回工具墙。循环泵换了节拍。走廊里的灯带转成琥珀色。林澈说冷凝管今晚要换滤网。两个人把菌毯卷好。';
const DETAILS: Detail[] = [
  { id: 'D1', submission: 'W1', image: '琥珀色灯带', quote: '灯带转成琥珀色', families: ['Anthropic', 'Moonshot'] },
  { id: 'D2', submission: 'W1', image: '扳手', quote: '借来的扳手挂回工具墙', families: ['xAI'] },
];
const CANON: CanonPassage[] = [
  { file: 'reference/05-ecology-and-everyday.md', text: '邻里的工具挂在公共的工具墙上，借用的人要在配给簿上登记。\n\n循环泵的节拍决定邻里的作息。' },
  { file: 'reference/02-technology-and-infrastructure.md', text: '船上的照明按检修计划变换颜色。' },
  { file: 'reference/05-ecology-and-everyday.md', text: '菌毯每周翻晒一次。' },
];

function fenced(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

function errorOf<T>(r: { ok: true; value: T } | { ok: false; error: string }): string {
  assert.equal(r.ok, false, 'expected a rejection');
  return r.ok ? '' : r.error;
}

function valueOf<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
}

function sealed(): SealedForecasts {
  return {
    round: 'R01', row_id: 'SHIP', brief_sha256: 'a'.repeat(64),
    forecasts: [
      { forecaster: 'claude', family: 'Anthropic', model: 'opus', writer_model: false, items: [{ slot: '物件', value: '旧扳手' }, { slot: '声音', value: '泵的节拍' }] },
      { forecaster: 'gw-deepseek', family: 'DeepSeek', model: 'deepseek-fixture', writer_model: true, items: [{ slot: '场所细节', value: '琥珀色的灯' }] },
    ],
  };
}

test('flattenForecasts: opaque ids P01… in sealed order, provenance kept for the engine only', () => {
  const flat = flattenForecasts(sealed());
  assert.deepEqual(flat.map((f) => f.id), ['P01', 'P02', 'P03']);
  assert.deepEqual(flat[2], { id: 'P03', slot: '场所细节', value: '琥珀色的灯', forecaster: 'gw-deepseek', family: 'DeepSeek', model: 'deepseek-fixture', writerModel: true });
  assert.deepEqual(flattenForecasts({ ...sealed(), forecasts: [] }), []);
});

test('detailContexts: the quote sentence plus one sentence either side', () => {
  const ctx = detailContexts([...DETAILS, { id: 'D3', submission: 'W1', image: 'x', quote: '不在原文里的一句话', families: [] }], TEXT);
  assert.equal(ctx['D1'], '循环泵换了节拍。走廊里的灯带转成琥珀色。林澈说冷凝管今晚要换滤网。');
  assert.equal(ctx['D2'], '温芮把借来的扳手挂回工具墙。循环泵换了节拍。');
  assert.equal(ctx['D3'], '不在原文里的一句话');
});

test('matchTask: details and forecasts under opaque ids, default or maintainer paragraph; parser per rule', () => {
  const forecasts = flattenForecasts(sealed());
  const context = detailContexts(DETAILS, TEXT);
  const spec = matchTask(DETAILS, context, forecasts, DEFAULT, 'match-W1-Anthropic', SEED);
  assert.equal(spec.role, ROLE_MATCH);
  assert.doesNotMatch(spec.prompt, SLOT);
  assert.ok(spec.prompt.includes(DEFAULT_MATCH_PROMPT) && spec.prompt.includes('写作之前别人对这类现场做的预测'));
  assert.equal(unwrap(spec.prompt, '预测'), 'P01｜物件｜旧扳手\nP02｜声音｜泵的节拍\nP03｜场所细节｜琥珀色的灯');
  assert.ok(unwrap(spec.prompt, '细节')?.startsWith('D1｜琥珀色灯带｜上下文：循环泵换了节拍。'));
  for (const hidden of ['claude', 'gw-deepseek', 'deepseek-fixture', 'opus']) assert.ok(!spec.prompt.includes(hidden), `forecaster and model hidden: ${hidden}`);
  const custom = matchTask(DETAILS, context, forecasts, { active: true, prompt: '只算完全相同的。' }, 'match-W1-Anthropic', SEED);
  assert.ok(custom.prompt.includes('只算完全相同的。') && !custom.prompt.includes(DEFAULT_MATCH_PROMPT));
  const good = { matches: [{ detail: 'D2', forecast: 'P01', relation: 'more_general' }, { detail: 'D1', forecast: null, relation: 'none' }] };
  assert.deepEqual(valueOf(spec.parse(fenced(good))), { matches: [{ detail: 'D1', forecast: null, relation: 'none' }, { detail: 'D2', forecast: 'P01', relation: 'more_general' }] });
  const m = (over: Record<string, unknown>): unknown => ({ matches: [{ detail: 'D1', forecast: null, relation: 'none' }, { detail: 'D2', forecast: 'P03', relation: 'same', ...over }] });
  assert.match(errorOf(spec.parse(fenced({ matches: good.matches.slice(0, 1) }))), /offered id D1 is not answered/u);
  assert.match(errorOf(spec.parse(fenced({ matches: [...good.matches, good.matches[0]] }))), /answered twice/u);
  assert.match(errorOf(spec.parse(fenced(m({ detail: 'D9' })))), /detail: not one of the offered/u);
  assert.match(errorOf(spec.parse(fenced(m({ relation: 'similar' })))), /relation: not one of/u);
  assert.match(errorOf(spec.parse(fenced(m({ relation: 'none' })))), /relation none needs forecast null/u);
  assert.match(errorOf(spec.parse(fenced(m({ forecast: null })))), /forecast: not one of the offered forecast ids/u);
  assert.match(errorOf(spec.parse(fenced(m({ forecast: 'P99' })))), /forecast: not one of/u);
  assert.match(errorOf(spec.parse(fenced({ matches: [{ detail: 'D1', relation: 'none' }, { detail: 'D2', forecast: 'P01', relation: 'same' }] }))), /forecast: missing/u);
  assert.match(errorOf(spec.parse(JSON.stringify(good))), /fenced/u);
  assert.match(errorOf(spec.parse(`${fenced(good)}\n${fenced(good)}`)), /exactly one/u);
  assert.throws(() => matchTask([], context, forecasts, DEFAULT, 'match-W1-Anthropic', SEED), /at least one/u);
});

test('classifyForecast: open only when both matchers say none; disagreement or a void matcher → forecast', () => {
  const v = (d1: 'same' | 'none', d2: 'more_general' | 'none'): MatchVerdict => ({
    matches: [{ detail: 'D1', forecast: d1 === 'none' ? null : 'P01', relation: d1 }, { detail: 'D2', forecast: d2 === 'none' ? null : 'P02', relation: d2 }],
  });
  assert.deepEqual(classifyForecast(v('none', 'none'), v('none', 'none'), ['D1', 'D2']), { D1: 'open', D2: 'open' });
  assert.deepEqual(classifyForecast(v('same', 'none'), v('none', 'more_general'), ['D1', 'D2']), { D1: 'forecast', D2: 'forecast' });
  assert.deepEqual(classifyForecast(v('none', 'none'), null, ['D1', 'D2']), { D1: 'forecast', D2: 'forecast' });
  assert.deepEqual(classifyForecast(null, null, ['D1']), { D1: 'forecast' });
  assert.deepEqual(classifyForecast(v('none', 'none'), v('none', 'none'), ['D1', 'D3']), { D1: 'open', D3: 'forecast' }, 'an unanswered id is not open');
});

test('chainTask: canon files under 〔文件：…〕, open details; parser per rule (file, citation ≥ 8, steps ≤ 2 sentences, null pairs)', () => {
  const context = detailContexts(DETAILS, TEXT);
  const spec = chainTask(DETAILS, context, CANON, 'chain-W1-OpenAI', SEED);
  assert.equal(spec.role, ROLE_CHAIN);
  assert.doesNotMatch(spec.prompt, SLOT);
  assert.ok(spec.prompt.includes('先逐字引用一句正典原句') && spec.prompt.includes('不得引入正典没有的事实'));
  const offered = unwrap(spec.prompt, '正典') ?? '';
  assert.ok(offered.startsWith('〔文件：reference/05-ecology-and-everyday.md〕\n邻里的工具挂在公共的工具墙上'));
  assert.ok(offered.includes('菌毯每周翻晒一次。') && offered.includes('〔文件：reference/02-technology-and-infrastructure.md〕'));
  assert.equal(offered.split('〔文件：reference/05-ecology-and-everyday.md〕').length, 2, 'one block per file');
  const chain = (over: Record<string, unknown>): Record<string, unknown> => ({
    detail: 'D2', canon: { file: 'reference/05-ecology-and-everyday.md', quote: '邻里的工具挂在公共的工具墙上' }, steps: ['借来的工具要还回墙上。'], lands_on: '扳手挂回工具墙', ...over,
  });
  const drift = { detail: 'D1', canon: null, steps: [], lands_on: null };
  const set = valueOf(spec.parse(fenced({ chains: [chain({}), drift] })));
  assert.deepEqual(set.chains, [
    { detail: 'D1', canon: null, steps: [], lands_on: null },
    { detail: 'D2', canon: { file: 'reference/05-ecology-and-everyday.md', quote: '邻里的工具挂在公共的工具墙上' }, steps: ['借来的工具要还回墙上。'], lands_on: '扳手挂回工具墙' },
  ]);
  const reject = (over: Record<string, unknown>, re: RegExp): void => { assert.match(errorOf(spec.parse(fenced({ chains: [chain(over), drift] }))), re); };
  reject({ canon: { file: 'reference/09-other.md', quote: '邻里的工具挂在公共的工具墙上' } }, /canon\.file: not one of the offered/u);
  reject({ canon: { file: 'reference/02-technology-and-infrastructure.md', quote: '邻里的工具挂在公共的工具墙上' } }, /canon\.quote: not cited verbatim from that file/u);
  reject({ canon: { file: 'reference/05-ecology-and-everyday.md', quote: '公共的工具墙' } }, /at least 8/u);
  reject({ steps: ['一。', '二。', '三。'] }, /more than 2 steps/u);
  reject({ steps: ['长'.repeat(61)] }, /steps\[0\]: longer than 60/u);
  reject({ steps: ['借来的要还。还完要登记。'] }, /not exactly one sentence/u);
  reject({ lands_on: null }, /needs lands_on/u);
  reject({ lands_on: '长'.repeat(31) }, /lands_on: longer than 30/u);
  reject({ steps: 'x' }, /steps: missing or not an array/u);
  assert.match(errorOf(spec.parse(fenced({ chains: [chain({}), { ...drift, steps: ['凭空一句。'] }] }))), /canon null needs empty steps/u);
  assert.match(errorOf(spec.parse(fenced({ chains: [chain({})] }))), /offered id D1 is not answered/u);
  assert.match(errorOf(spec.parse(fenced({ chains: [chain({}), drift, { ...drift, detail: 'D7' }] }))), /detail: not one of the offered/u);
  const noCanonKey = { detail: 'D1', steps: [], lands_on: null };
  assert.match(errorOf(spec.parse(fenced({ chains: [chain({}), noCanonKey] }))), /canon: missing/u);
});

test('acceptTask offers only chains with a canon quote; parser per rule; chainAuthors names the canon author; canonContexts finds the paragraph', () => {
  const chains: Chain[] = [
    { detail: 'D1', canon: null, steps: [], lands_on: null },
    { detail: 'D2', canon: { file: 'reference/05-ecology-and-everyday.md', quote: '循环泵的节拍决定邻里的作息' }, steps: [], lands_on: '扳手挂回工具墙' },
  ];
  const contexts = canonContexts(chains, CANON);
  assert.deepEqual(contexts, { D2: '循环泵的节拍决定邻里的作息。' });
  const spec = acceptTask(chains, DETAILS, contexts, 'accept-W1-xAI', SEED);
  assert.equal(spec.role, ROLE_ACCEPT);
  assert.doesNotMatch(spec.prompt, SLOT);
  assert.ok(spec.prompt.includes('引文确实出自正典且意思没有被曲解'));
  assert.equal(unwrap(spec.prompt, '链'), 'D2｜引文：循环泵的节拍决定邻里的作息（reference/05-ecology-and-everyday.md）｜步骤：（无）｜落到：扳手挂回工具墙｜细节：扳手');
  assert.equal(unwrap(spec.prompt, '正典段落'), 'D2｜循环泵的节拍决定邻里的作息。');
  assert.deepEqual(valueOf(spec.parse(fenced({ verdicts: [{ detail: 'D2', accept: false, reason: '节拍推不出扳手' }] }))), { verdicts: [{ detail: 'D2', accept: false, reason: '节拍推不出扳手' }] });
  assert.match(errorOf(spec.parse(fenced({ verdicts: [] }))), /offered id D2 is not answered/u);
  assert.match(errorOf(spec.parse(fenced({ verdicts: [{ detail: 'D1', accept: true, reason: 'x' }] }))), /detail: not one of the offered/u, 'a drift chain is never offered');
  assert.match(errorOf(spec.parse(fenced({ verdicts: [{ detail: 'D2', accept: 'yes', reason: 'x' }] }))), /accept: missing or not a boolean/u);
  assert.match(errorOf(spec.parse(fenced({ verdicts: [{ detail: 'D2', accept: true, reason: '长'.repeat(61) }] }))), /reason: longer than 60/u);
  assert.throws(() => acceptTask(chains.slice(0, 1), DETAILS, contexts, 'accept-W1-xAI', SEED), /no chain carries a canon quote/u);
  assert.deepEqual(chainAuthors(chains), [CANON_AUTHOR]);
  assert.equal(CANON_AUTHOR, 'OpenAI');
  assert.deepEqual(chainAuthors(chains.slice(0, 1)), []);
});

test('every surprise builder throws when its material holds its own delimiter token', () => {
  const tag = (label: string, id: string): string => {
    const w = wrapText(label, 'x', SEED, `${id}:${label}`);
    if (!w.ok) throw new Error(w.error);
    return w.value.slice(w.value.indexOf('·') + 1, w.value.indexOf('〕'));
  };
  const forecasts = flattenForecasts(sealed());
  const poisonedDetail = (id: string): Detail[] => [{ ...DETAILS[0], id: 'D1', submission: 'W1', image: `灯·${tag('细节', id)}〕`, quote: '灯带转成琥珀色', families: ['Anthropic'] }];
  assert.throws(() => matchTask(poisonedDetail('match-W1-xAI'), {}, forecasts, DEFAULT, 'match-W1-xAI', SEED), /delimiter/u);
  assert.throws(() => chainTask(poisonedDetail('chain-W1-xAI'), {}, CANON, 'chain-W1-xAI', SEED), /delimiter/u);
  const chain: Chain = { detail: 'D2', canon: { file: CANON[0]?.file ?? '', quote: `工具墙·${tag('链', 'accept-W1-xAI')}〕` }, steps: [], lands_on: '扳手' };
  assert.throws(() => acceptTask([chain], DETAILS, {}, 'accept-W1-xAI', SEED), /delimiter/u);
});
