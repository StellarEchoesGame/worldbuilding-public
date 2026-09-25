import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { checkFrozen, checkQuotes, extractRegression, normalizeNewlines, recheckRegression } from './evidence.ts';

const world = new URL('../../', import.meta.url);
const hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

test('normalizeNewlines turns CRLF and lone CR into LF and changes nothing else', () => {
  assert.equal(normalizeNewlines('a\r\nb\rc\n\td  \r\n'), 'a\nb\nc\n\td  \n');
});

test('a quote that occurs in its source passes', () => {
  const sources = { 'input/test.md': 'Known synthetic statement.' };
  assert.deepEqual(checkQuotes([{ source: 'input/test.md', quote: 'Known synthetic statement.' }], sources, 'judge-a/P01'), []);
});

test('WB-B1 vector: an invented quote is rejected', () => {
  const sources = { 'input/test.md': 'Known synthetic statement.' };
  assert.deepEqual(checkQuotes([{ source: 'input/test.md', quote: 'invented' }], sources, 'judge-a/P01'), ['judge-a/P01: quote not found in input/test.md']);
});

test('an empty evidence list is reported once', () => {
  assert.deepEqual(checkQuotes([], { a: 'x' }, 'judge-b/H1'), ['judge-b/H1: evidence missing']);
});

test('a source that is not a key is unknown, including inherited object keys', () => {
  const sources = { 'input/BOOK.md': '温芮把旧水壶放回架上。' };
  assert.deepEqual(checkQuotes([{ source: 'input/other.md', quote: '温芮' }], sources, 'w'), ['w: unknown source']);
  assert.deepEqual(checkQuotes([{ source: 'constructor', quote: 'function' }], sources, 'w'), ['w: unknown source']);
});

test('a quote with Markdown emphasis stripped does not match the emphasised source', () => {
  const sources = { s: '**温芮**把旧水壶放回架上。' };
  assert.deepEqual(checkQuotes([{ source: 's', quote: '温芮把旧水壶放回架上' }], sources, 'w'), ['w: quote not found in s']);
  assert.deepEqual(checkQuotes([{ source: 's', quote: '**温芮**把旧水壶' }], sources, 'w'), []);
});

test('a CJK variant character does not match', () => {
  const sources = { s: '軍港在冷湾以北。' };
  assert.deepEqual(checkQuotes([{ source: 's', quote: '军港在冷湾以北' }], sources, 'w'), ['w: quote not found in s']);
});

test('an empty quote is rejected even though it is a substring of everything', () => {
  assert.deepEqual(checkQuotes([{ source: 's', quote: '' }], { s: 'text' }, 'w'), ['w: quote not found in s']);
});

test('a CRLF source matches an LF quote that spans a line break', () => {
  const sources = { s: '第一行结束。\r\n第二行开始。\r\n' };
  assert.deepEqual(checkQuotes([{ source: 's', quote: '结束。\n第二行' }], sources, 'w'), []);
});

test('every failing item is reported in order', () => {
  const sources = { s: 'abc' };
  const items = [
    { source: 's', quote: 'x' },
    { source: 's', quote: 'b' },
    { source: 't', quote: 'a' },
  ];
  assert.deepEqual(checkQuotes(items, sources, 'w'), ['w: quote not found in s', 'w: unknown source']);
});

test('checkFrozen passes when every file hashes to the recorded value', () => {
  const files: Record<string, Buffer> = { 'input/test.md': Buffer.from('Known synthetic statement.') };
  const expected = { 'input/test.md': hex(Buffer.from('Known synthetic statement.')) };
  assert.deepEqual(checkFrozen(expected, (p) => files[p] ?? null), []);
});

test('WB-B1 vector: a file changed after the freeze is rejected', () => {
  const expected = { 'input/test.md': hex(Buffer.from('Known synthetic statement.')) };
  const read = (): Buffer => Buffer.from('Modified after freeze.');
  assert.deepEqual(checkFrozen(expected, read), ['frozen file changed: input/test.md']);
});

test('checkFrozen reports missing files and hashes raw bytes without newline normalisation', () => {
  const expected = { 'a.md': hex(Buffer.from('line\n')), 'b.md': hex(Buffer.from('x')) };
  const files: Record<string, Buffer> = { 'a.md': Buffer.from('line\r\n') };
  assert.deepEqual(checkFrozen(expected, (p) => files[p] ?? null), ['frozen file changed: a.md', 'frozen file missing: b.md']);
});

const judgeA = {
  judge_id: 'judge-a',
  cases: [
    { id: 'P01', evidence: [{ source: 's', section: 'x', quote: 'one' }, { source: 's', section: 'y', quote: 'two' }] },
    { id: 'P02', evidence: [{ source: 's', section: 'x', quote: 'one' }, { source: 't', section: 'x', quote: 'one' }] },
    { id: 'P03', evidence: [{ source: 's', section: 'x', quote: 'ignored' }] },
  ],
};
const judgeB = {
  judge_id: 'judge-b',
  cases: [
    { id: 'P02', evidence: [{ source: 's', section: 'z', quote: 'two' }, { source: 's', section: 'z', quote: 'three' }] },
    { id: 'P01', evidence: [{ source: 's', section: 'z', quote: 'four' }] },
  ],
};

test('extractRegression unions evidence of the chosen cases, deduplicated on source and quote, in judge, case, evidence order', () => {
  const items = extractRegression([{ name: 'judge-a', data: judgeA }, { name: 'judge-b', data: judgeB }], ['P01', 'P02', 'P99']);
  assert.deepEqual(items, [
    { case: 'P01', source: 's', quote: 'one' },
    { case: 'P01', source: 's', quote: 'two' },
    { case: 'P02', source: 't', quote: 'one' },
    { case: 'P01', source: 's', quote: 'four' },
    { case: 'P02', source: 's', quote: 'three' },
  ]);
});

test('extractRegression tolerates judge data without a cases array', () => {
  assert.deepEqual(extractRegression([{ name: 'broken', data: { cases: 'none' } }, { name: 'null', data: null }], ['P01']), []);
});

test('recheckRegression counts live quotes and lists stale ones', () => {
  const items = [
    { case: 'P01', source: 's', quote: 'alpha' },
    { case: 'P02', source: 's', quote: 'gamma' },
    { case: 'P03', source: 'gone', quote: 'alpha' },
    { case: 'P04', source: 's', quote: 'beta\ngam' },
  ];
  assert.deepEqual(recheckRegression(items, { s: 'alpha beta\r\ngamma' }), {
    live: 3,
    stale: [{ case: 'P03', source: 'gone', quote: 'alpha' }],
  });
  assert.deepEqual(recheckRegression(items, { s: 'alpha' }), {
    live: 1,
    stale: [
      { case: 'P02', source: 's', quote: 'gamma' },
      { case: 'P03', source: 'gone', quote: 'alpha' },
      { case: 'P04', source: 's', quote: 'beta\ngam' },
    ],
  });
});

const REGRESSION_CASES = ['P01', 'P02', 'P03', 'P13', 'P14', 'N01', 'N08'];

function currentPath(source: string): URL {
  if (!source.startsWith('input/')) throw new Error(`unexpected evidence source ${source}`);
  return new URL(`current/${source.slice('input/'.length)}`, world);
}

test('WB-B1 regression evidence for the seven cases is live against world/current', () => {
  const judges = ['judge-a', 'judge-b'].map((name) => {
    const data: unknown = JSON.parse(readFileSync(new URL(`benchmarks/WB-B1/runs/initial/${name}.json`, world), 'utf8'));
    return { name, data };
  });
  const items = extractRegression(judges, REGRESSION_CASES);
  const keys = new Set(items.map((i) => `${i.source}\u0000${i.quote}`));
  assert.equal(keys.size, items.length);
  assert.equal(items.length, 46);
  assert.ok(items.every((i) => REGRESSION_CASES.includes(i.case)));
  const sources: Record<string, string> = {};
  for (const item of items) {
    const path = currentPath(item.source);
    assert.ok(existsSync(path), `missing ${path.pathname}`);
    sources[item.source] = readFileSync(path, 'utf8');
  }
  assert.ok('input/BOOK.md' in sources);
  assert.ok(Object.keys(sources).some((s) => s.startsWith('input/reference/')));
  const result = recheckRegression(items, sources);
  assert.deepEqual(result.stale, []);
  assert.equal(result.live, items.length);
});
