import { test } from 'node:test';
import assert from 'node:assert/strict';
import { charCount, normalizeForQuote, quoteIn, ruleSentenceRatio, sentenceKey, splitSentences, stripMarkdown } from './text.ts';

test('stripMarkdown removes headings, emphasis, list and quote markers', () => {
  assert.equal(stripMarkdown('# 标题\n\n- **温芮**走进*舱室*。\n> 引文'), '标题\n\n温芮走进舱室。\n引文');
});

test('charCount counts code points after markdown stripping, like wc -m', () => {
  assert.equal(charCount('**你好**'), 2);
  assert.equal(charCount('𠀀a'), 2);
});

test('splitSentences splits on Chinese terminators and keeps closing quotes attached', () => {
  assert.deepEqual(splitSentences('她说：「走吧。」他没动！为什么？\n第二段；结尾…'), [
    '她说：「走吧。」',
    '他没动！',
    '为什么？',
    '第二段；',
    '结尾…',
  ]);
});

test('ruleSentenceRatio ignores dialogue and matches rule words', () => {
  assert.equal(ruleSentenceRatio('船员必须签到。灯亮了。「你不能走。」她笑了。'), 1 / 3);
  assert.equal(ruleSentenceRatio('须臾之间，灯亮了。'), 0);
  assert.equal(ruleSentenceRatio(''), 0);
});

test('normalizeForQuote folds width, whitespace and punctuation', () => {
  assert.equal(normalizeForQuote('ＡＢ， c！'), 'ABc');
});

test('quoteIn accepts punctuation-insensitive substrings and rejects short or absent quotes', () => {
  const text = '温芮把旧水壶放回架上，“明天再修。”';
  assert.equal(quoteIn('把旧水壶放回架上。明天再修', text), true);
  assert.equal(quoteIn('新水壶', text), false);
  assert.equal(quoteIn('水壶', text), false);
});

test('quoteIn enforces a caller-supplied minimum length', () => {
  const text = '温芮把旧水壶放回架上，“明天再修。”';
  assert.equal(quoteIn('旧水壶放回', text, 8), false);
  assert.equal(quoteIn('把旧水壶放回架上明天', text, 8), true);
});

test('splitSentences keeps the original text; sentenceKey compares sentences under NFKC', () => {
  assert.deepEqual(splitSentences('Ａ区的灯亮了…她停下。'), ['Ａ区的灯亮了…', '她停下。']);
  assert.equal(sentenceKey('Ａ区的灯亮了，她说：「走」！'), 'A区的灯亮了,她说:「走」!');
  assert.equal(sentenceKey('他说：走。'), sentenceKey('他说:走。'));
});

test('splitSentences gives each table cell its own sentence and skips separator rows', () => {
  assert.deepEqual(splitSentences('| 名称 | 说明 |\n|---|:---:|\n| 值班表 | 贴在门边。还有一行 |'), ['名称', '说明', '值班表', '贴在门边。', '还有一行']);
});
