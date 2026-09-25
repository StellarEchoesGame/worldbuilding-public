import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeBackend } from './adapters/fake.ts';
import { assignLabels } from './anonymize.ts';
import type { Cell } from './brief.ts';
import type { Family } from './config.ts';
import { parseFreeze } from './freeze.ts';
import { LIMITS } from './gate.ts';
import { runRound, type RoundDeps } from './round.ts';
import { sha256 } from './store.ts';
import type { Benchmark } from './taste.ts';

const cell: Cell = {
  id: 'C1', rowId: 'SHIP', title: '测试', entity: '实体', time: '时间', layers: ['物件'], settingNotes: [], protagonists: ['温芮'], forbidden: [],
  stances: [{ id: 's1', text: '立场一' }, { id: 's2', text: '立场二' }, { id: 's3', text: '立场三' }],
};
const bench: Benchmark = { version: 'v0', decisive: 'q1', minQuoteChars: 8, role: '评委', instructions: 'JSON', questions: [{ id: 'q1', text: '哪篇？' }] };

function writerText(body: string, facts: boolean): string {
  const claims = facts ? `[{"id":"A-01","kind":"author_fact","claim":"c","status":"状态与路径实例","row_id":"SHIP","attaches_to":"04","extends":"F07","misuse":"m","source_quote":"${body.slice(0, 12)}","register":true}]` : '[]';
  return ['```submission', body, '```', '```delta', `{"new_proper_nouns":[],"claims":${claims}}`, '```', '```interface', '{"shots":[{},{},{}],"object":{"n":1},"hook":{"h":1}}', '```', '种子：', '- 一'].join('\n');
}

function section(prompt: string, n: 1 | 2): string {
  const start = prompt.indexOf(`【第 ${n} 篇】\n`) + `【第 ${n} 篇】\n`.length;
  return prompt.slice(start, prompt.indexOf(`\n【第 ${n} 篇完】`));
}

/** Judges prefer the text that mentions 水壶; they quote its first twelve characters. */
function judgeReply(prompt: string): string {
  const pick = section(prompt, 1).includes('水壶') ? 1 : 2;
  return JSON.stringify({ q1: { pick, quote: section(prompt, pick).slice(0, 12) } });
}

function deps(root: string): RoundDeps & { judgeCalls: () => number; judgePrompts: () => string[] } {
  const families: Family[] = ['OpenAI', 'Anthropic', 'Moonshot', 'xAI'];
  const judges = families.map((family, i) => ({ backend: fakeBackend(`j${i}`, family, judgeReply), concurrency: 2 }));
  return {
    root,
    cell,
    canon: { book: 'B', reference: 'R', bookSha256: 'b', referenceSha256: 'r' },
    bench,
    seed: 'seed-1',
    sessionPairs: 2,
    writers: [
      fakeBackend('W1', 'DeepSeek', () => writerText('温芮把旧水壶放回架上，炉子还热着，邻里的人陆续醒来。', true)),
      fakeBackend('W2', 'DeepSeek', () => writerText('林澈在走廊尽头停下，听见循环泵换了节拍，他数着步子回去。', true)),
      fakeBackend('W3', 'DeepSeek', () => '没有代码块的输出'),
    ],
    baselineWriter: fakeBackend('BASE', 'DeepSeek', () => writerText('陈颂打开储物格，把配给卡按日期排好，灯光一格一格亮起。', false)),
    judges,
    judgeTimeoutMs: 1000,
    writerTimeoutMs: 1000,
    rules: { limits: LIMITS, forbidden: [], negations: ['不'], negationExceptions: [], barFourFamilies: 7 },
    pins: { benchmarkText: '{"version":"v0"}', writersText: '{"slots":[]}', protocolBundleSha256: sha256('bundle-1') },
    log: () => undefined,
    judgeCalls: () => judges.reduce((n, j) => n + ('calls' in j.backend ? j.backend.calls.length : 0), 0),
    judgePrompts: () => judges.flatMap((j) => j.backend.calls),
  };
}

test('a fake round writes, gates, judges, tallies and prepares the audit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-round-'));
  const d = deps(root);
  const tallies = await runRound(d, 'P01');
  const dir = join(root, 'rounds', 'P01');
  for (const f of ['brief.json', 'gate.json', 'labels.json', 'tally.json', 'audit-set.json', 'progress.jsonl', 'submissions/W3.json']) assert.ok(existsSync(join(dir, f)), f);
  assert.equal(tallies.length, 2);
  const w1 = tallies.find((t) => t.submission === 'W1');
  const w2 = tallies.find((t) => t.submission === 'W2');
  assert.equal(w1?.tally.beatsChampion, true);
  assert.equal(w1?.tally.totalWins, 8);
  assert.equal(w2?.tally.beatsChampion, false);
  assert.equal(d.judgeCalls(), 2 * 4 * 2 * 2);
  const w3: unknown = JSON.parse(readFileSync(join(dir, 'submissions/W3.json'), 'utf8'));
  assert.match(JSON.stringify(w3), /missing ```submission block/);
  rmSync(root, { recursive: true });
});

test('a rerun resumes: only the deleted taste call is repeated', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-round-'));
  await runRound(deps(root), 'P01');
  rmSync(join(root, 'rounds', 'P01', 'taste', 'W1', 'j2-s1-rev.json'));
  const again = deps(root);
  await runRound(again, 'P01');
  assert.equal(again.judgeCalls(), 1);
  rmSync(root, { recursive: true });
});

test('a rerun retries recorded voids but not recorded successes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-round-'));
  const first = deps(root);
  const flaky = first.judges[3];
  assert.ok(flaky !== undefined);
  flaky.backend = fakeBackend('j3', 'xAI', () => ({ error: 'rate limited' }));
  const tallies = await runRound(first, 'P01');
  assert.deepEqual(tallies.find((t) => t.submission === 'W1')?.tally.dropped, ['xAI']);
  const again = deps(root);
  const rerun = await runRound(again, 'P01');
  assert.equal(again.judgeCalls(), 2 * 2 * 2);
  assert.deepEqual(rerun.find((t) => t.submission === 'W1')?.tally.dropped, []);
  rmSync(root, { recursive: true });
});

test('a new round pins its inputs by content hash in freeze.json', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-round-'));
  await runRound(deps(root), 'P01');
  const dir = join(root, 'rounds', 'P01');
  const freeze = parseFreeze(JSON.parse(readFileSync(join(dir, 'freeze.json'), 'utf8')));
  assert.ok(freeze.ok);
  assert.equal(freeze.value.sha256['benchmark'], sha256('{"version":"v0"}'));
  assert.equal(freeze.value.sha256['writers.json'], sha256('{"slots":[]}'));
  assert.equal(freeze.value.sha256['BOOK.md'], sha256('B'));
  assert.equal(freeze.value.sha256['REFERENCE.md'], sha256('R'));
  assert.equal(freeze.value.sha256['brief.json'], sha256(readFileSync(join(dir, 'brief.json'), 'utf8')));
  assert.equal(freeze.value.protocol_bundle_sha256, sha256('bundle-1'));
  assert.equal(freeze.value.benchmark_version, 'v0');
  assert.deepEqual(freeze.value.eligible_families, ['Anthropic', 'Moonshot', 'OpenAI', 'xAI']);
  rmSync(root, { recursive: true });
});

test('a rerun refuses to resume when a pinned input changed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-round-'));
  await runRound(deps(root), 'P01');
  rmSync(join(root, 'rounds', 'P01', 'taste', 'W1', 'j2-s1-rev.json'));
  const again = deps(root);
  again.pins = { ...again.pins, benchmarkText: '{"version":"v0","edited":true}' };
  await assert.rejects(runRound(again, 'P01'), /frozen file changed: benchmark/u);
  assert.equal(again.judgeCalls(), 0);
  rmSync(root, { recursive: true });
});

test('a rerun refuses to resume when the protocol bundle changed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-round-'));
  await runRound(deps(root), 'P01');
  const again = deps(root);
  again.pins = { ...again.pins, protocolBundleSha256: sha256('bundle-2') };
  await assert.rejects(runRound(again, 'P01'), (e: unknown) => e instanceof Error && e.message.split('protocol bundle changed').length === 2);
  rmSync(root, { recursive: true });
});

test('a legacy round without freeze.json resumes unpinned and says so', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-round-'));
  await runRound(deps(root), 'P01');
  const dir = join(root, 'rounds', 'P01');
  rmSync(join(dir, 'freeze.json'));
  const again = deps(root);
  const messages: string[] = [];
  again.log = (m) => messages.push(m);
  await runRound(again, 'P01');
  assert.equal(existsSync(join(dir, 'freeze.json')), false);
  assert.ok(messages.some((m) => m.includes('freeze.json')));
  rmSync(root, { recursive: true });
});

test('protocol forbidden words fail a candidate before judging', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-round-'));
  const d = deps(root);
  d.rules = { ...d.rules, forbidden: [{ term: '水壶', protects: '测试' }] };
  const tallies = await runRound(d, 'P01');
  assert.deepEqual(tallies.map((t) => t.submission), ['W2']);
  const gate: unknown = JSON.parse(readFileSync(join(root, 'rounds', 'P01', 'gate.json'), 'utf8'));
  assert.match(JSON.stringify(gate), /forbidden_words/u);
  rmSync(root, { recursive: true });
});

test('labels come from assignLabels and an existing labels file for the same candidates is kept', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-round-'));
  await runRound(deps(root), 'P01');
  const file = join(root, 'rounds', 'P01', 'labels.json');
  const assigned = assignLabels(['W1', 'W2'], 'seed-1');
  const expected = Object.fromEntries(Object.entries(assigned).map(([id, label]) => [label, id]));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), expected);
  const swapped = Object.fromEntries(Object.entries(expected).map(([label, id]) => [label, id === 'W1' ? 'W2' : 'W1']));
  writeFileSync(file, JSON.stringify(swapped));
  const rerun = await runRound(deps(root), 'P01');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), swapped);
  assert.deepEqual(Object.fromEntries(rerun.map((t) => [t.label, t.submission])), swapped);
  rmSync(root, { recursive: true });
});

test('judges see anonymized text: curly quotes become corner quotes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-round-'));
  const d = deps(root);
  d.writers = [fakeBackend('W1', 'DeepSeek', () => writerText('温芮说：“把旧水壶放回架上。”炉子还热着，邻里的人陆续醒来。', true))];
  await runRound(d, 'P01');
  const prompts = d.judgePrompts();
  assert.ok(prompts.length > 0);
  assert.ok(prompts.every((p) => p.includes('「把旧水壶放回架上。」') && !p.includes('“')));
  rmSync(root, { recursive: true });
});

test('the four-family bar from the rules reaches the tally', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-round-'));
  const d = deps(root);
  d.rules = { ...d.rules, barFourFamilies: 8 };
  const tallies = await runRound(d, 'P01');
  assert.equal(tallies.find((t) => t.submission === 'W1')?.tally.needed, 8);
  rmSync(root, { recursive: true });
});

test('negation exceptions from the rules decide whether a forbidden term is negated', async () => {
  // The only 水壶 sits in a clause whose sole 不 is part of 不久.
  const text = writerText('不久温芮把旧水壶放回架上，炉子还热着。她又擦了一遍桌子。', true);
  const run = async (exceptions: string[]): Promise<string[]> => {
    const root = mkdtempSync(join(tmpdir(), 'forge-round-'));
    const d = deps(root);
    d.writers = [fakeBackend('W1', 'DeepSeek', () => text), d.writers[1] ?? fakeBackend('W2', 'DeepSeek', () => text)];
    d.rules = { ...d.rules, forbidden: [{ term: '水壶', protects: '测试' }], negationExceptions: exceptions };
    const tallies = await runRound(d, 'P01');
    rmSync(root, { recursive: true });
    return tallies.map((t) => t.submission).sort();
  };
  assert.deepEqual(await run([]), ['W1', 'W2'], 'without the exception 不久 negates, so the sentence is only flagged');
  assert.deepEqual(await run(['不久']), ['W2'], 'with the exception the term is not negated and W1 fails the gate');
});

test('a rerun refuses to resume when the judge families differ from the frozen ones', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-round-'));
  await runRound(deps(root), 'P01');
  const again = deps(root);
  again.judges = again.judges.filter((j) => j.backend.family !== 'xAI');
  await assert.rejects(runRound(again, 'P01'), /eligible families changed: Anthropic、Moonshot、OpenAI、xAI → Anthropic、Moonshot、OpenAI/u);
  assert.equal(again.judgeCalls(), 0);
  rmSync(root, { recursive: true });
});

test('a round writes cost.json summing every call record per backend', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-round-'));
  const d = deps(root);
  await runRound(d, 'P01');
  const cost: unknown = JSON.parse(readFileSync(join(root, 'rounds', 'P01', 'cost.json'), 'utf8'));
  assert.ok(typeof cost === 'object' && cost !== null && 'by_backend' in cost);
  const calls = readdirSync(join(root, 'rounds', 'P01', 'calls')).length;
  const summed = Object.values(JSON.parse(readFileSync(join(root, 'rounds', 'P01', 'cost.json'), 'utf8')).by_backend).reduce((n: number, b) => n + (typeof b === 'object' && b !== null && 'attempts' in b && typeof b.attempts === 'number' ? b.attempts : 0), 0);
  assert.equal(summed, calls);
  rmSync(root, { recursive: true });
});
