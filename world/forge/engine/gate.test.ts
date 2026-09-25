import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mechanicalGate } from './gate.ts';
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
  assert.deepEqual(failed(output({ delta: { newProperNouns: ['a', 'b', 'c', 'd'], claims: [claim({})] } })), ['new_proper_nouns']);
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
