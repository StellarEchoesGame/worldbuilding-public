import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WRITER_ROLE } from '../brief.ts';
import { DEFAULT_STANCES, type BriefJson } from '../steps/brief.ts';
import { unwrap } from './fenced.ts';
import { ROLE_BASELINE } from './roles.ts';
import { BASELINE_MAX_CHARS, BASELINE_TASK_ID, baselineTask, canonSentences, checkBaseline, isConsequenceStance, writerTask } from './writing.ts';

const PASSAGE_A = '温芮把借来的扳手挂回工具墙。循环泵换了节拍。林澈说冷凝管今晚要换滤网。';
const PASSAGE_B = '配给簿上多了一行字。循环泵换了节拍。';

function brief(): BriefJson {
  return {
    round: 'R01',
    kind: 'round',
    row_id: 'SHIP',
    layer: '物件',
    topic_source: 'fixed',
    cell: {
      id: 'C1', row_id: 'SHIP', title: '母舰 · 邻里常态日', entity: '远航号上的一个邻里', time: '息壤停留期', layers: ['物件', '任务钩子'],
      setting_notes: ['写一个普通的一天'], protagonists: ['温芮', '林澈'], forbidden: ['出现未登记的第三方势力'],
      stances: [{ id: 'resident-day', text: '居民的一天：跟着主角过完这一天。' }, { id: 'counter-consequence', text: '反直觉后果：写出一个意外后果。' }],
    },
    canon: { revision: '8.1', book_sha256: 'b'.repeat(64), reference_sha256: 'r'.repeat(64) },
    canon_passages: [{ file: 'reference/05-ecology-and-everyday.md', text: PASSAGE_A }, { file: 'reference/04-war-and-diplomacy.md', text: PASSAGE_B }],
    facts: [{ id: 'F07', kind: 'fact', text: 'D4 之后舰上共 864 人。', status: '共同事实', rows: ['SHIP'] }],
    regression: [],
    regression_stale: [],
    forbidden: ['出现未登记的第三方势力'],
    cliches: ['仿佛'],
    requirements: ['一个具名主角，写出他/她此刻想要什么、为此付出什么代价。'],
    interface_requirements: ['钩子至少两个选项且含拒绝。'],
    aliases: ['远航号', '母舰'],
    seed: 'seed-writing',
    created_at: '2026-10-01T00:00:00.000Z',
  };
}

function writerText(body: string, claims = '[]', nouns = '[]'): string {
  return ['```submission', body, '```', '```delta', `{"new_proper_nouns":${nouns},"claims":${claims}}`, '```', '```interface', '{"shots":[{},{},{}],"object":{"n":1},"hook":{"h":1}}', '```', '种子：', '- 一'].join('\n');
}

const BELIEF = '[{"id":"A-01","kind":"character_belief","claim":"林澈认为滤网该换了","source_quote":"林澈说冷凝管今晚要换滤网"}]';
const FACT = '[{"id":"A-01","kind":"author_fact","claim":"c","status":"共同事实","row_id":"SHIP","attaches_to":"04","extends":"F07","misuse":"m","source_quote":"循环泵换了节拍","register":true}]';

test('writerTask: id, role, stance, canon and fact table in the prompt; the slot never changes the prompt', () => {
  const b = brief();
  const w1 = writerTask(b, 'W1', 'resident-day', null);
  const re = writerTask(b, 'W1-r2', 'resident-day', null);
  assert.equal(w1.id, 'write-W1');
  assert.equal(re.id, 'write-W1-r2');
  assert.equal(w1.role, WRITER_ROLE);
  assert.equal(re.prompt, w1.prompt);
  assert.match(w1.prompt, /居民的一天：跟着主角过完这一天。/u);
  assert.match(w1.prompt, /F07（共同事实）：D4 之后舰上共 864 人。/u);
  assert.match(w1.prompt, /- 仿佛/u);
  assert.match(w1.prompt, /可选主角：温芮 \/ 林澈/u);
  assert.equal(unwrap(w1.prompt, '正典'), `【reference/05-ecology-and-everyday.md】\n${PASSAGE_A}\n\n【reference/04-war-and-diplomacy.md】\n${PASSAGE_B}`);
  assert.equal(unwrap(w1.prompt, '技能'), null);
  assert.equal(/[{｛][A-Z_]+[}｝]/u.test(w1.prompt), false, 'no unreplaced {SLOT}');
  assert.equal(/benchmark|champion|decoy|forecast/iu.test(w1.prompt), false);
});

test('writerTask: an unknown cell stance falls back to the default stance text; the skill snapshot is inlined verbatim', () => {
  const skill = { name: 'systemic-worldbuilding', text: '# Systemic Worldbuilding\n\nTrace the traffic jam.' };
  const spec = writerTask(brief(), 'W2', 'object-history', skill);
  assert.match(spec.prompt, new RegExp(DEFAULT_STANCES[1]?.text ?? 'x', 'u'));
  assert.match(spec.prompt, /构思方法（技能快照：systemic-worldbuilding）/u);
  assert.equal(unwrap(spec.prompt, '技能'), skill.text);
  assert.notEqual(spec.prompt, writerTask(brief(), 'W2', 'object-history', null).prompt);
});

test('writerTask: parse is parseWriterOutput; retryPrompt quotes the error after the first prompt', () => {
  const spec = writerTask(brief(), 'W1', 'resident-day', null);
  const good = spec.parse(writerText('温芮把借来的扳手挂回工具墙。', FACT));
  assert.equal(good.ok, true);
  const bad = spec.parse('没有代码块');
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  const retry = spec.retryPrompt?.(bad.error) ?? '';
  assert.ok(retry.startsWith(spec.prompt));
  assert.ok(retry.includes(`错误：${bad.error}`));
});

test('canonSentences splits the passages with the shared splitter and drops duplicates', () => {
  assert.deepEqual(canonSentences(brief()), ['温芮把借来的扳手挂回工具墙。', '循环泵换了节拍。', '林澈说冷凝管今晚要换滤网。', '配给簿上多了一行字。']);
});

const JOINTS = ['同一天，', '与此同时，'];

test('baselineTask: numbered sentences, id, role; accepts reordered verbatim sentences with one connective', () => {
  const b = brief();
  const sentences = canonSentences(b);
  const spec = baselineTask(b, sentences, JOINTS);
  assert.equal(spec.id, BASELINE_TASK_ID);
  assert.equal(spec.role, ROLE_BASELINE);
  assert.equal(unwrap(spec.prompt, '正典句'), sentences.map((s, i) => `〔C${String(i + 1).padStart(3, '0')}〕${s}`).join('\n'));
  assert.match(spec.prompt, /可用连接词：同一天， 与此同时，/u);
  const body = '循环泵换了节拍。与此同时，温芮把借来的扳手挂回工具墙。\n\n林澈说冷凝管今晚要换滤网。';
  const r = spec.parse(writerText(body, BELIEF));
  assert.equal(r.ok, true);
});

test('baselineTask rejects rewritten sentences by position without echoing the text', () => {
  const spec = baselineTask(brief(), canonSentences(brief()), JOINTS);
  const r = spec.parse(writerText('循环泵换了节拍。温芮把扳手挂回了墙上。同一天，与此同时，配给簿上多了一行字。'));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error, '2 of 3 sentences are not verbatim numbered canon sentences (sentence 2, 3)');
  assert.equal(/[^\x20-\x7e]/u.test(r.error), false, 'ASCII only');
  assert.ok((spec.retryPrompt?.(r.error) ?? '').includes(r.error));
});

test('baselineTask rejects author facts, rumors, new proper nouns, an over-long text and an unparsable reply', () => {
  const sentences = canonSentences(brief());
  const spec = baselineTask(brief(), sentences, JOINTS);
  const fact = spec.parse(writerText('循环泵换了节拍。', FACT));
  assert.deepEqual(fact, { ok: false, error: 'delta claims must all be character_belief; 1 claim(s) are author_fact or rumor' });
  const noun = spec.parse(writerText('循环泵换了节拍。', '[]', '["回声泵"]'));
  assert.deepEqual(noun, { ok: false, error: 'new_proper_nouns must be empty, got 1' });
  const long = '循环泵换了节拍。'.repeat(Math.ceil(BASELINE_MAX_CHARS / 8) + 1);
  const tooLong = spec.parse(writerText(long));
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.match(tooLong.error, /^submission has \d+ characters, over 2500$/u);
  assert.equal(spec.parse('```json\n{}\n```').ok, false);
});

test('checkBaseline: a canon sentence that itself starts with a connective matches directly; empty text fails', () => {
  const out = { submission: '同一天，循环泵换了节拍。', delta: { newProperNouns: [], claims: [] }, iface: { shots: [], object: null, hook: null, raw: {} }, seeds: [] };
  assert.equal(checkBaseline(out, ['同一天，循环泵换了节拍。'], JOINTS).ok, true);
  assert.equal(checkBaseline(out, ['循环泵换了节拍。'], JOINTS).ok, true);
  assert.equal(checkBaseline(out, ['循环泵换了节拍。'], []).ok, false);
  assert.deepEqual(checkBaseline({ ...out, submission: '——' }, ['循环泵换了节拍。'], JOINTS), { ok: false, error: 'submission has no sentence' });
});

test('isConsequenceStance marks only the consequence stance', () => {
  assert.deepEqual(DEFAULT_STANCES.map((s) => isConsequenceStance(s.id)), [false, false, false, true]);
});
