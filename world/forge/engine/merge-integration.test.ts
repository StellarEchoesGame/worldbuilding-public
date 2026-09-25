import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonFiles, sourcesFromRound } from './inputs.ts';
import { mergecheck, type MergeInput, type MergeSource } from './mergecheck.ts';
import { loadProtocolBundle } from './rules.ts';
import { splitSentences, stripMarkdown } from './text.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '..', '..');
const REGISTER = 'reference/07-register-and-creation.md';
const SCENES = 'reference/09-scenes-and-people.md';
const ECOLOGY = 'reference/05-ecology-and-everyday.md';

function source(sources: readonly MergeSource[], label: string): MergeSource {
  const s = sources.find((x) => x.label === label);
  assert.ok(s !== undefined, label);
  return s;
}

function sentenceWith(src: MergeSource, quote: string): string {
  const s = splitSentences(stripMarkdown(src.submission)).find((x) => x.includes(quote));
  assert.ok(s !== undefined, quote);
  return s;
}

/** A first merge built from the committed protocol, the real 07 and the P01 prototype submissions. */
function simulatedMerge(): MergeInput {
  const bundle = loadProtocolBundle(ROOT);
  assert.ok(bundle.ok);
  const { merge, connectives } = bundle.value.protocol;
  const sources = sourcesFromRound(ROOT, 'P01');
  assert.ok(sources.ok, sources.ok ? '' : sources.error);
  const canon = canonFiles(REPO);
  const base = source(sources.value, 'C');
  const donor = source(sources.value, 'B');
  const own = base.facts.find((f) => f.id === 'A-02');
  const borrowed = donor.facts.find((f) => f.id === 'A-01');
  assert.ok(own !== undefined && borrowed !== undefined);
  const baseSentences = splitSentences(stripMarkdown(base.submission));
  const upTo = baseSentences.findIndex((s) => s.includes(own.sourceQuote));
  assert.ok(upTo >= 0);
  const joint = connectives[0];
  assert.ok(joint !== undefined);
  // Sentence 0 is the draft's own title line; 09 carries the title in its header instead.
  const body = [...baseSentences.slice(1, upTo + 1), `${joint}${sentenceWith(donor, borrowed.sourceQuote)}`].join('');
  const header = '## R01｜灰边邻里的留饭签\n\n地点：SHIP｜时间锚：任一常态日｜路径依赖：标准成功路径｜地位：状态与路径实例·示例｜本场登记事实：R01-01、R01-02';
  const row = (rxx: string, f: typeof own): string => `| ${rxx} | ${f.rowId} | ${f.claim} | ${f.status} | ${f.attachesTo} | ${f.extends} | ${f.misuse} | R01 |`;
  const before07 = canon[REGISTER] ?? '';
  const before05 = canon[ECOLOGY] ?? '';
  assert.ok(before07 !== '' && before05 !== '');
  return {
    constants: { ...merge, connectives },
    rowIds: ['SHIP', 'S1-冷湾'],
    decision: { round: 'R01', baseLabel: 'C', title: '灰边邻里的留饭签', rows: ['SHIP'], registered: [{ rxx: 'R01-01', label: 'C', factId: 'A-02' }, { rxx: 'R01-02', label: 'B', factId: 'A-01' }] },
    sources: sources.value,
    // Like the CLI: every canon Markdown file is passed, so any other change would be reported.
    before: { ...canon, [SCENES]: '' },
    after: {
      ...canon,
      [REGISTER]: `${before07}\n${merge.pointer07}\n\n${merge.heading8}\n\n${merge.tableHeader8}\n${row('R01-01', own)}\n${row('R01-02', borrowed)}\n`,
      [SCENES]: `${merge.preamble09}\n\n${header}\n\n${body}\n`,
      [ECOLOGY]: `${before05}\n现场：见09 §R01（R01-01、R01-02）\n`,
    },
  };
}

test('a first merge on the real 07 with the P01 submissions passes under the committed protocol', () => {
  const r = mergecheck(simulatedMerge());
  assert.deepEqual(r.violations, []);
  assert.equal(r.ok, true);
});

test('the same merge with one base sentence reworded fails', () => {
  const input = simulatedMerge();
  const scenes = input.after[SCENES] ?? '';
  input.after[SCENES] = scenes.replace('温芮', '温 芮');
  assert.equal(mergecheck(input).ok, false);
});

test('the same merge that also edits existing 07 text fails', () => {
  const input = simulatedMerge();
  input.after[REGISTER] = (input.after[REGISTER] ?? '').replace('## 7.', '## 7 .');
  assert.match(mergecheck(input).violations.join('\n'), /07: not append-only/u);
});

test('the same merge that also edits a book chapter or 08 fails', () => {
  for (const path of ['04-life-and-people.md', 'reference/08-cross-system-cases.md', 'BOOK.md']) {
    const input = simulatedMerge();
    input.after[path] = `${input.after[path] ?? ''}远航号穿过星门。\n`;
    assert.deepEqual(mergecheck(input).violations, [`unexpected change: ${path}`], path);
  }
});
