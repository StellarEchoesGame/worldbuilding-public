import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeBackend } from './adapters/fake.ts';
import type { Cell } from './brief.ts';
import type { Family } from './config.ts';
import { runRound, type RoundDeps } from './round.ts';
import type { Benchmark } from './taste.ts';

const cell: Cell = {
  id: 'C1', rowId: 'SHIP', title: '测试', entity: '实体', time: '时间', layers: ['物件'], settingNotes: [], protagonists: ['温芮'], forbidden: [],
  stances: [{ id: 's1', text: '立场一' }, { id: 's2', text: '立场二' }, { id: 's3', text: '立场三' }],
};
const bench: Benchmark = { version: 'v0', decisive: 'q1', role: '评委', instructions: 'JSON', questions: [{ id: 'q1', text: '哪篇？' }] };

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

function deps(root: string): RoundDeps & { judgeCalls: () => number } {
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
    log: () => undefined,
    judgeCalls: () => judges.reduce((n, j) => n + ('calls' in j.backend ? j.backend.calls.length : 0), 0),
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
