import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCard, CARD_FLAG_TEXT, type CardFlag, type CardSubmission } from './card.ts';
import type { Family } from './config.ts';
import type { FamilySessions, SessionCall } from './pairs.ts';
import { loadSchema, validate } from './schema.ts';
import { buildRoundTally, type RoundTally, type SubmissionMeasures } from './tally.ts';
import type { Order } from './tasks/ids.ts';
import type { ColdRead } from './tasks/measures.ts';
import type { Claim, WriterOutput } from './writer-output.ts';

const FAMILIES: readonly Family[] = ['Anthropic', 'Moonshot', 'OpenAI', 'xAI'];

function call(order: Order, decisive: string | null): SessionCall {
  return { taskId: `taste-x-${order}`, order, status: decisive === null ? 'void' : 'ok', decisive, preferredDecoy: false };
}

/** One family's final sessions on a champion pair: true = both calls chose the submission. */
function fam(family: Family, sub: string, wins: readonly boolean[], dropped = false): FamilySessions {
  const sessions = wins.map((w): [SessionCall, SessionCall] => (dropped ? [call('fwd', null), call('rev', null)] : [call('fwd', w ? sub : 'BASE'), call('rev', w ? sub : 'BASE')]));
  return { family, shadow: false, sessions, reruns: dropped ? [1] : [], dropped: dropped ? 'void_after_rerun' : null };
}

function claim(id: string, text: string, ext: string, register: boolean): Claim {
  return { id, kind: 'author_fact', claim: text, status: '状态与路径实例', rowId: 'SHIP', attachesTo: '05', extends: ext, misuse: 'x', sourceQuote: text, register };
}

function output(nouns: string[], claims: Claim[]): WriterOutput {
  const shot = { 地点: '第三邻里工具墙', 主体人物与动作: '温芮挂回扳手' };
  const hook = { 玩家不来时会发生什么: '滤网当晚堵死', 玩法类型: '经营' };
  return { submission: '正文', delta: { newProperNouns: nouns, claims }, iface: { shots: [shot, { 地点: '走廊' }, {}], object: { 名称: '借用签' }, hook, raw: {} }, seeds: ['一', '二', '三'] };
}

function measures(iface: SubmissionMeasures['interface'], surprise: SubmissionMeasures['surprise']['status']): SubmissionMeasures {
  return { hook: 0.5, skin_swap: 'recognised', cold_reader: { status: 'ok', clarity: 3 }, interface: iface, surprise: { status: surprise, surprising: 1, eligible: 2 } };
}

const COLD: ColdRead = {
  where: { answer: '工具墙', quote: '工具墙' }, who: { name: '温芮', wants: '还清借用', cost: '误了换班', quote: '温芮' }, go: { answer: null, quote: null }, clarity: 2,
};

function tally(): RoundTally {
  return buildRoundTally({
    round: 'R01', benchmark: 'v1', champion: 'owner_pick', sessionPairs: 2, barFourFamilies: 7,
    labels: { W1: 'B', 'W2-r2': 'A', W3: 'C' },
    championPairs: [
      { pair: 'W1', submission: 'W1', sessions: FAMILIES.map((f) => fam(f, 'W1', [true, true])) },
      { pair: 'W2-r2', submission: 'W2-r2', sessions: FAMILIES.map((f, i) => fam(f, 'W2-r2', [true, true], i >= 2)) },
      { pair: 'W3', submission: 'W3', sessions: FAMILIES.map((f) => fam(f, 'W3', [false, true])) },
    ],
    auxPairs: [],
    gate: { W1: 'pass', 'W2-r2': 'split', W3: 'unverified' },
    measures: { W1: measures('pass', 'full'), 'W2-r2': measures('unjudged', 'reused'), W3: measures('fail', 'invalid') },
    voids: { calls: 0, void_tasks: 0, retried_tasks: 0, session_reruns: 0, dropped_families: 0 },
  });
}

function sub(submission: string, slot: string, label: string, outcome: CardSubmission['gate']['outcome'], opts: { defect?: boolean; cold?: ColdRead | null; resubmitted?: boolean; acceptorReused?: boolean } = {}): CardSubmission {
  return {
    submission, slot, label, resubmitted: opts.resubmitted ?? false, output: output(['霜港'], [claim('A-01', '霜港的借用签写在柜门内侧', 'F14 状态牌', true), claim('A-02', '菌毯卷好送回培养架', '「温芮把借来的扳手挂回工具墙。」', false)]),
    displaySha256: 'a'.repeat(64),
    gate: { outcome, counted: ['Anthropic', 'OpenAI'], defectUnverified: opts.defect ?? false, pathInstanceNotes: outcome === 'pass' ? [{ family: 'OpenAI', quote: '借用签写在柜门内侧', against: 'F14', reason: '路径实例' }] : [] },
    cold: opts.cold === undefined ? COLD : opts.cold,
    acceptorReused: opts.acceptorReused ?? false,
  };
}

function card(unseal: { status: 'valid' | 'invalid'; remote: 'verified' | 'unavailable' | 'mismatch' } = { status: 'valid', remote: 'verified' }) {
  return buildCard({
    round: 'R01', rowId: 'SHIP', benchmark: 'v1', champion: 'owner_pick', tally: tally(), unseal,
    submissions: [sub('W1', 'W1', 'B', 'pass'), sub('W3', 'W3', 'C', 'unverified', { defect: true, cold: null }), sub('W2-r2', 'W2', 'A', 'split', { resubmitted: true, acceptorReused: true })],
  });
}

test('buildCard: one entry per gate-passing submission in label order, with the card flags', () => {
  const c = card();
  assert.deepEqual(c.entries.map((e) => [e.label, e.submission, e.slot]), [['A', 'W2-r2', 'W2'], ['B', 'W1', 'W1'], ['C', 'W3', 'W3']]);
  const flags = Object.fromEntries(c.entries.map((e) => [e.submission, e.flags]));
  assert.deepEqual(flags, {
    'W2-r2': ['gate_split', 'trial', 'layer3_red', 'acceptor_reused', 'resubmitted'],
    W1: [],
    W3: ['gate_judges_short', 'defect_unverified', 'layer3_red'],
  });
  assert.deepEqual(c.flags, []);
  const text: Record<CardFlag, string> = CARD_FLAG_TEXT;
  assert.equal(text.gate_judges_short, '⚑事实门评委不足');
});

test('buildCard: a trial pair (|E| ≤ 2) is never mergeable; the wins line carries |E| and the bar', () => {
  const c = card();
  const by = (s: string) => c.entries.find((e) => e.submission === s);
  assert.deepEqual(by('W1')?.wins, { total: 8, needed: 7, e: 4, bar: '7/8', beats_champion: true, by_family: { Anthropic: 2, Moonshot: 2, OpenAI: 2, xAI: 2 } });
  assert.equal(by('W1')?.mergeable, true);
  assert.deepEqual(by('W2-r2')?.wins, { total: 4, needed: 4, e: 2, bar: 'trial', beats_champion: false, by_family: { Anthropic: 2, Moonshot: 2 } });
  assert.equal(by('W2-r2')?.mergeable, false);
  assert.deepEqual(by('W3')?.wins.bar, '7/8');
  assert.equal(by('W3')?.wins.beats_champion, false);
});

test('buildCard: protagonist from the cold reader, interface titles, path-instance notes and fact flags', () => {
  const c = card();
  const w1 = c.entries.find((e) => e.submission === 'W1');
  assert.deepEqual(w1?.protagonist, { name: '温芮', wants: '还清借用', cost: '误了换班', source: 'cold_reader' });
  assert.equal(c.entries.find((e) => e.submission === 'W3')?.protagonist, null);
  assert.deepEqual(w1?.interface, { status: 'pass', shots: ['第三邻里工具墙 · 温芮挂回扳手', '走廊', ''], object: '借用签', hook: '滤网当晚堵死', play_type: '经营' });
  assert.deepEqual(w1?.gate, { outcome: 'pass', counted: ['Anthropic', 'OpenAI'], path_instance_notes: [{ family: 'OpenAI', quote: '借用签写在柜门内侧', against: 'F14', reason: '路径实例' }] });
  assert.deepEqual(w1?.facts, [
    { id: 'A-01', claim: '霜港的借用签写在柜门内侧', kind: 'author_fact', register: true, flags: ['⚑新专名', '⚑贴近 F-ID'] },
    { id: 'A-02', claim: '菌毯卷好送回培养架', kind: 'author_fact', register: false, flags: [] },
  ]);
  assert.equal(w1?.text_sha256, 'a'.repeat(64));
  assert.deepEqual(w1?.measures, measures('pass', 'full'));
});

test('buildCard: round flags for an invalid unseal and an unavailable remote', () => {
  assert.deepEqual(card({ status: 'invalid', remote: 'unavailable' }).flags, ['surprise_invalid', 'probe_remote_unavailable']);
  assert.deepEqual(card({ status: 'valid', remote: 'unavailable' }).flags, ['probe_remote_unavailable']);
});

test('card.json validates against schema/card.schema.json', () => {
  const schema = loadSchema(JSON.parse(readFileSync(new URL('../schema/card.schema.json', import.meta.url), 'utf8')));
  if (!schema.ok) throw new Error(schema.error);
  for (const c of [card(), card({ status: 'invalid', remote: 'unavailable' })]) assert.deepEqual(validate(schema.value, JSON.parse(JSON.stringify(c))), []);
  assert.notDeepEqual(validate(schema.value, { ...card(), v: 2 }), []);
});

test('buildCard: ⚑推理链由判定家族复核 follows acceptor_reused, not the 3-family status; a submission missing from the tally is an integrity error', () => {
  const t = tally();
  const noAcceptor = buildCard({ round: 'R01', rowId: 'SHIP', benchmark: 'v1', champion: 'owner_pick', tally: t, unseal: { status: 'valid', remote: 'verified' }, submissions: [sub('W2-r2', 'W2', 'A', 'split')] });
  assert.equal(t.measures['W2-r2']?.surprise.status, 'reused');
  assert.ok(!(noAcceptor.entries[0]?.flags ?? []).includes('acceptor_reused'), 'status reused but no acceptor ran');
  assert.throws(() => buildCard({ round: 'R01', rowId: 'SHIP', benchmark: 'v1', champion: 'owner_pick', tally: t, unseal: { status: 'valid', remote: 'verified' }, submissions: [sub('W9', 'W9', 'D', 'pass')] }), /no measures for card submission W9/u);
});
