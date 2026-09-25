import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../store.ts';
import { IntegrityError } from '../task.ts';
import { applyDecoy, decoyTask, parseDecoyPlan, type DecoyPlan } from './decoy.ts';
import { unwrap } from './fenced.ts';
import { ROLE_DECOY } from './roles.ts';

const CHAMPION = '温芮把借来的扳手挂回第三邻里的工具墙，墙上的编号牌仿佛还带着上一班的体温。她在配给簿上补了一行字，又去听循环泵的节拍。林澈从走廊另一头过来，说冷凝管今晚要换滤网。';
const RECIPE = { details: 2, instructions: '把最具体的细节换成泛泛的同类说法。' };

type Rep = { original: string; generic: string; kind: string };

function reply(reps: readonly Rep[]): string {
  return ['```json', JSON.stringify({ replacements: reps }), '```'].join('\n');
}

const G0: Rep = { original: '借来的扳手', generic: '工具', kind: '物件' };
const G1: Rep = { original: '循环泵', generic: '机器', kind: '物件' };
const GOOD: Rep[] = [G0, G1];

function parse(text: string): ReturnType<typeof parseDecoyPlan> {
  return parseDecoyPlan(text, CHAMPION, RECIPE);
}

function rejects(text: string, pattern: RegExp): void {
  const r = parse(text);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, pattern);
    assert.match(r.error, /^[\x20-\x7e]*$/u, 'errors are ASCII and never echo model text');
  }
}

test('parseDecoyPlan accepts an exact, verbatim, non-overlapping map within ±5 % length', () => {
  const r = parse(`说明文字\n${reply(GOOD)}`);
  assert.deepEqual(r, { ok: true, value: { replacements: GOOD } });
});

test('parseDecoyPlan rejects each broken rule with an ASCII error', () => {
  rejects(reply([G0]), /exactly 2 entries, got 1/u);
  rejects(reply([...GOOD, { original: '冷凝管', generic: '管子', kind: '物件' }]), /exactly 2 entries, got 3/u);
  rejects(reply([G0, { original: '不存在的词', generic: '东西', kind: '物件' }]), /replacements\[1\]\.original: must occur exactly once/u);
  rejects(reply([{ original: '的', generic: '之', kind: '其他' }, G1]), /shorter than 2|must occur exactly once/u);
  rejects(reply([{ original: '一班', generic: '一轮', kind: '其他' }, { original: '上一班的体温', generic: '温度', kind: '感官' }]), /overlaps another original/u);
  rejects(reply([{ original: '借来的扳手', generic: '借来的扳手之类', kind: '物件' }, G1]), /generic: must differ from and not contain/u);
  rejects(reply([{ original: '借来的扳手', generic: '工具\n箱', kind: '物件' }, G1]), /generic: no newline or Markdown/u);
  rejects(reply([{ original: '借来的扳手', generic: '**工具**', kind: '物件' }, G1]), /generic: no newline or Markdown/u);
  rejects(reply([{ original: '借来的扳手', generic: '工具', kind: '武器' }, G1]), /kind: not one of the six kinds/u);
  rejects(reply([{ original: '借来的扳手', generic: '“工具”', kind: '物件' }, G1]), /must stay plain display text/u);
  rejects(reply([{ original: '温芮把借来的扳手挂回第三邻里的工具墙，墙上的编号牌仿佛还带着上一班的体温', generic: '她', kind: '动作' }, G1]), /original: longer than 30 chars/u);
  rejects(reply([{ original: '借来的扳手', generic: '一件借来的、沉甸甸的、带着机油味的工具', kind: '物件' }, G1]), /within 5% of the original/u);
  rejects(reply([{ original: '借来的扳手', generic: '', kind: '物件' }, G1]), /generic: empty/u);
  rejects(JSON.stringify({ replacements: GOOD }), /exactly one fenced json block, found 0/u);
  rejects(`${reply(GOOD)}\n${reply(GOOD)}`, /exactly one fenced json block, found 2/u);
  rejects(['```json', '{"replacements": {}}', '```'].join('\n'), /replacements: missing or not an array/u);
});

test('parseDecoyPlan refuses an original that occurs twice', () => {
  const text = `${CHAMPION}循环泵又响了。`;
  const r = parseDecoyPlan(reply(GOOD), text, RECIPE);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /replacements\[1\]\.original: must occur exactly once/u);
});

test('applyDecoy replaces every original once and records the champion hash and recipe version', () => {
  const plan: DecoyPlan = { replacements: GOOD.map((r) => ({ original: r.original, generic: r.generic, kind: '物件' })) };
  const r = applyDecoy(CHAMPION, plan, 'v1');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.text, CHAMPION.replace('借来的扳手', '工具').replace('循环泵', '机器'));
  assert.equal(r.value.championSha256, sha256(CHAMPION));
  assert.equal(r.value.recipeVersion, 'v1');
  assert.deepEqual(r.value.replacements, plan.replacements);
  const stale = applyDecoy('另一篇文字，没有这些细节。', plan, 'v1');
  assert.equal(stale.ok, false);
});

test('decoyTask: Chinese prompt with the wrapped champion, the recipe line and the output block; retry quotes the error', () => {
  const spec = decoyTask(CHAMPION, RECIPE, 'decoy-DECOY', 'seed-d');
  assert.equal(spec.id, 'decoy-DECOY');
  assert.equal(spec.role, ROLE_DECOY);
  assert.equal(unwrap(spec.prompt, '文本甲'), CHAMPION);
  assert.match(spec.prompt, /按以下配方把其中最具体的 2 处细节换成泛泛的同类说法：把最具体的细节换成泛泛的同类说法。只给出替换表，不要重写全文。/u);
  assert.match(spec.prompt, /只输出一个 ```json 代码块/u);
  assert.equal(/\{[A-Z_0-9]+\}/u.test(spec.prompt), false, 'no unreplaced slot');
  assert.deepEqual(spec.parse(reply(GOOD)), { ok: true, value: { replacements: GOOD } });
  const retry = spec.retryPrompt?.('replacements: expected exactly 2 entries, got 1') ?? '';
  assert.ok(retry.startsWith(spec.prompt));
  assert.match(retry, /错误：replacements: expected exactly 2 entries, got 1/u);
  assert.throws(
    () => decoyTask(`${CHAMPION}${spec.prompt.slice(spec.prompt.indexOf('·'), spec.prompt.indexOf('〕') + 1)}`, RECIPE, 'decoy-DECOY', 'seed-d'),
    (e: unknown) => e instanceof IntegrityError && /decoy: cannot wrap 文本甲/u.test(e.message),
    'a champion holding its delimiter is an integrity failure (exit 3), not a crash',
  );
});
