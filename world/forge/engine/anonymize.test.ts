import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anonymizeText, assignLabels } from './anonymize.ts';

const FIXTURES: Array<{ name: string; input: string; expected: string }> = [
  { name: 'drops a leading heading', input: '# 冷湾交接\n\n温芮走进舱室。', expected: '温芮走进舱室。' },
  {
    name: 'drops the heading after leading blank lines, only once',
    input: '\n\n  ## 标题\n\n## 第二节\n\n正文。',
    expected: '第二节\n\n正文。',
  },
  {
    name: 'keeps a later heading as plain text when the first line is prose',
    input: '正文。\n# 小节\n更多。',
    expected: '正文。\n小节\n更多。',
  },
  { name: 'does not treat #word as a heading', input: '#标签 开头。', expected: '#标签 开头。' },
  {
    name: 'strips markdown emphasis, lists, quotes and links',
    input: '**温芮**走进*舱室*。\n- 第一项\n> 引文\n[灯](http://x)亮了。',
    expected: '温芮走进舱室。\n第一项\n引文\n灯亮了。',
  },
  {
    name: 'converts curly quotes to corner brackets, nested included',
    input: '他说：“走吧。”她答：‘好。’\n“外面‘里面’外面”',
    expected: '他说：「走吧。」她答：『好。』\n「外面『里面』外面」',
  },
  {
    name: 'converts ASCII and ideographic-full-stop ellipses',
    input: '等等...真的。。。还有......结束',
    expected: '等等……真的……还有……结束',
  },
  { name: 'trims trailing whitespace on every line', input: '甲  \n乙\t\n丙　', expected: '甲\n乙\n丙' },
  { name: 'collapses 3+ newlines to 2', input: '甲\n\n\n\n乙\n \n\t\n丙', expected: '甲\n\n乙\n\n丙' },
  { name: 'trims the whole text', input: '\n\n  正文。  \n\n\n', expected: '正文。' },
  { name: 'handles CRLF line endings', input: '# 题\r\n\r\n甲。\r\n乙。\r\n', expected: '甲。\n乙。' },
  { name: 'returns empty text for a heading-only document', input: '# 只有标题\n', expected: '' },
  { name: 'returns empty text for empty input', input: '', expected: '' },
];

for (const fixture of FIXTURES) {
  test(`anonymizeText ${fixture.name}`, () => {
    assert.equal(anonymizeText(fixture.input), fixture.expected);
  });
}

const PATHOLOGICAL = [
  '    # 深缩进标题\n正文。',
  '# 标题\n# # 双井号\n- - 双列表\n> > 双引用\n',
  '[[内](a)](b) 链接',
  '“跨段\n\n“第二段。”',
  '....。。。。...',
  '# 折角廊\n\n> # 维修组通告\n> 今晚停水。\n\n温芮醒了。',
  '# T\n# # U\n正文',
  '# T\n#\n正文',
  '> #\n正文',
];

test('anonymizeText drops only the raw leading heading, not a line that becomes a heading after stripping', () => {
  assert.equal(anonymizeText('# 折角廊\n\n> # 维修组通告\n> 今晚停水。\n\n温芮醒了。'), '维修组通告\n今晚停水。\n\n温芮醒了。');
  assert.equal(anonymizeText('# T\n# # U\n正文'), 'U\n正文');
  assert.equal(anonymizeText('    # x\ny'), 'x\ny');
  assert.equal(anonymizeText('> # 旧约第一条\n\n她数了三遍配额。'), '旧约第一条\n\n她数了三遍配额。');
});

test('anonymizeText removes empty heading markers so the output never starts with a heading line', () => {
  assert.equal(anonymizeText('# T\n#\n正文'), '正文');
  assert.equal(anonymizeText('> ##\n正文'), '正文');
});

test('anonymizeText is idempotent on every fixture and on pathological input', () => {
  for (const input of [...FIXTURES.map((f) => f.input), ...PATHOLOGICAL]) {
    const once = anonymizeText(input);
    assert.equal(anonymizeText(once), once, JSON.stringify(input));
  }
});

test('anonymizeText leaves no curly quotes, ASCII ellipses or markdown heading behind', () => {
  for (const input of PATHOLOGICAL) {
    const out = anonymizeText(input);
    assert.doesNotMatch(out, /[“”‘’]|\.\.\.|。。。/u, JSON.stringify(input));
    assert.doesNotMatch(out.split('\n')[0] ?? '', /^\s{0,3}#{1,6}(?:\s|$)/u, JSON.stringify(input));
  }
});

test('assignLabels is stable for a fixed seed', () => {
  assert.deepEqual(assignLabels(['claude', 'gpt', 'grok', 'kimi'], 'R01-seed'), {
    claude: 'A',
    grok: 'B',
    gpt: 'C',
    kimi: 'D',
  });
  assert.deepEqual(assignLabels(['claude', 'gpt', 'grok', 'kimi'], 'R02-seed'), {
    kimi: 'A',
    grok: 'B',
    claude: 'C',
    gpt: 'D',
  });
});

test('assignLabels gives the same mapping for any permutation of the ids', () => {
  const base = assignLabels(['claude', 'gpt', 'grok', 'kimi'], 'R01-seed');
  assert.deepEqual(assignLabels(['kimi', 'grok', 'gpt', 'claude'], 'R01-seed'), base);
  assert.deepEqual(assignLabels(['gpt', 'kimi', 'claude', 'grok'], 'R01-seed'), base);
});

test('assignLabels continues with X6, X7 beyond F', () => {
  const labels = assignLabels(['a8', 'a7', 'a6', 'a5', 'a4', 'a3', 'a2', 'a1'], 'R01-seed');
  assert.deepEqual(labels, { a1: 'A', a6: 'B', a3: 'C', a8: 'D', a2: 'E', a5: 'F', a4: 'X6', a7: 'X7' });
});

test('assignLabels handles empty input and rejects duplicate ids', () => {
  assert.deepEqual(assignLabels([], 'seed'), {});
  assert.throws(() => assignLabels(['a', 'b', 'a'], 'seed'), RangeError);
});

test('assignLabels stores unusual ids such as __proto__ as own keys', () => {
  const labels = assignLabels(['__proto__', 'x'], 'seed');
  assert.deepEqual(Object.keys(labels).sort(), ['__proto__', 'x']);
  assert.deepEqual(Object.values(labels).sort(), ['A', 'B']);
});
