import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergecheck, sceneHeaderRegex, type DeltaFact, type MergeConstants, type MergeDecision, type MergeInput, type MergeSource } from './mergecheck.ts';

const SCENES = 'reference/09-scenes-and-people.md';
const REGISTER = 'reference/07-register-and-creation.md';
const REF01 = 'reference/01-space-and-history.md';
const REF04 = 'reference/04-war-and-diplomacy.md';
const REF05 = 'reference/05-ecology-and-everyday.md';

const ROW_IDS = ['S0-外围接应区', 'S1-冷湾', 'SHIP'];
const PREAMBLE = '# 场景与人物\n\n本文件只追加，每场只取已冻结提交中的整句。';
const POINTER = '现场登记见[09](09-scenes-and-people.md)；每条只延伸既有事实。';
const HEADING = '## 8. 现场登记';
const TABLE_HEADER = '| ID | 行 | 事实 | 地位 | 挂靠 | 延伸自 | 误用 | 场景 |\n|---|---|---|---|---|---|---|---|';

const CONSTANTS: MergeConstants = {
  preamble09: PREAMBLE,
  pointer07: POINTER,
  heading8: HEADING,
  tableHeader8: TABLE_HEADER,
  connectives: ['同一天，', '稍后，'],
  maxJointsPer500: 3,
  notesPaths: ['reference/CHANGES.md'],
};

function fact(over: Partial<DeltaFact>): DeltaFact {
  return { id: 'X-01', claim: 'c', status: '已选地方事实', rowId: 'S1-冷湾', attachesTo: '04', extends: 'F07', misuse: 'm', sourceQuote: 'q', ...over };
}

const SOURCE_A: MergeSource = {
  label: 'A',
  submission: '# 冷湾的水壶\n\n温芮把旧水壶放回架上。灯亮了。**冷湾**的值班表贴在门边，字迹已经褪色。她数了三遍配额。',
  facts: [fact({ id: 'A-01', claim: '冷湾值班表贴在门边，按旧制每夜更新', status: '已选地方事实', attachesTo: '04-冷湾', extends: 'F07', misuse: '把值班表当成全舰制度', sourceQuote: '冷湾的值班表贴在门边' })],
};

const SOURCE_B: MergeSource = {
  label: 'B',
  submission: '管道在夜里响了两次。老周说那是冰栈交接的信号。没有人回答他。',
  facts: [
    fact({ id: 'B-01', claim: '冰栈交接时管道会响两次', status: '状态与路径实例', attachesTo: '05-冰栈', extends: 'F11', misuse: '把管道声当成警报', sourceQuote: '那是冰栈交接的信号' }),
    fact({ id: 'B-02', claim: '夜里管道会响', sourceQuote: '管道在夜里响了两次' }),
  ],
};

const DECISION_1: MergeDecision = {
  round: 'R01',
  baseLabel: 'A',
  title: '冷湾值班夜',
  rows: ['S1-冷湾'],
  registered: [
    { rxx: 'R01-01', label: 'A', factId: 'A-01' },
    { rxx: 'R01-02', label: 'B', factId: 'B-01' },
  ],
};

interface HeaderParts {
  round?: string;
  title?: string;
  row?: string;
  anchor?: string;
  facts?: string;
}

function header(over: HeaderParts = {}): string {
  return `## ${over.round ?? 'R01'}｜${over.title ?? '冷湾值班夜'}\n\n地点：${over.row ?? 'S1-冷湾'}｜时间锚：${over.anchor ?? 'D3'}｜路径依赖：与路径无关｜地位：已选地方事实·已发生事件｜本场登记事实：${over.facts ?? 'R01-01、R01-02'}`;
}

const BODY_1 = '温芮把旧水壶放回架上。**冷湾**的值班表贴在门边，字迹已经褪色。\n\n同一天，老周说那是冰栈交接的信号。她数了三遍配额。';

const REGISTER_BEFORE = '# 事实索引、词条与继续创作\n\n## 7. 一份地方内容的创作顺序\n\n1. 先读地图。\n';
const ROW_1 = '| R01-01 | S1-冷湾 | 冷湾值班表贴在门边，按旧制每夜更新 | 已选地方事实 | 04 | F07 | 全舰制度 | R01 |';
const ROW_2 = '| R01-02 | S1-冷湾 | 冰栈交接时管道会响两次 | 状态与路径实例 | 05 | F11 | 警报 | R01 |';
const REGISTER_AFTER_1 = `${REGISTER_BEFORE}\n${POINTER}\n\n${HEADING}\n\n${TABLE_HEADER}\n${ROW_1}\n${ROW_2}\n`;

const REF01_TEXT = '# 空间与历史\n\n航约428。\n';
const REF04_BEFORE = '# 生活与人\n\n## 冷湾\n\n冷湾的日常靠配额运转。\n\n## 远航号\n\n舰上日常。\n';
const REF04_AFTER = '# 生活与人\n\n## 冷湾\n\n冷湾的日常靠配额运转。\n\n现场：见09 §R01（R01-01、R01-02）\n\n## 远航号\n\n舰上日常。\n';

interface FirstPatch {
  headerText?: string;
  body?: string;
  after09?: string;
  after07?: string;
  after01?: string;
  after04?: string;
  decision?: MergeDecision;
}

function scene(headerText: string, body: string): string {
  return `${headerText}\n\n${body}\n`;
}

function firstMerge(patch: FirstPatch = {}): MergeInput {
  const after09 = patch.after09 ?? `${PREAMBLE}\n\n${scene(patch.headerText ?? header(), patch.body ?? BODY_1)}`;
  return {
    constants: CONSTANTS,
    rowIds: ROW_IDS,
    decision: patch.decision ?? DECISION_1,
    sources: [SOURCE_A, SOURCE_B],
    before: { [SCENES]: '', [REGISTER]: REGISTER_BEFORE, [REF01]: REF01_TEXT, [REF04]: REF04_BEFORE },
    after: { [SCENES]: after09, [REGISTER]: patch.after07 ?? REGISTER_AFTER_1, [REF01]: patch.after01 ?? REF01_TEXT, [REF04]: patch.after04 ?? REF04_AFTER },
  };
}

const SCENES_AFTER_1 = `${PREAMBLE}\n\n${scene(header(), BODY_1)}`;

const SOURCE_C: MergeSource = {
  label: 'C',
  submission: '远航号的走廊比平时安静。温芮在舱门前停了一下。她没有敲门。',
  facts: [fact({ id: 'C-01', claim: '远航号走廊在交接后变安静', status: '状态与路径实例', rowId: 'SHIP', attachesTo: '05', extends: 'R01-02', misuse: '当成停电', sourceQuote: '走廊比平时安静' })],
};

const DECISION_2: MergeDecision = { round: 'R02', baseLabel: 'C', title: '走廊', rows: ['SHIP'], registered: [{ rxx: 'R02-01', label: 'C', factId: 'C-01' }] };
const HEADER_2 = header({ round: 'R02', title: '走廊', row: 'SHIP', anchor: 'D3—D5中的任一常态日', facts: 'R02-01' });
const ROW_R02 = '| R02-01 | SHIP | 远航号走廊在交接后变安静 | 状态与路径实例 | 05 | R01-02 | 停电 | R02 |';
const REF05_BEFORE = '# 生态与日常\n\n舰上走廊。\n';
const REF05_AFTER = '# 生态与日常\n\n舰上走廊。\n\n现场：见09 §R02（R02-01）\n';

function secondMerge(patch: { after09?: string; after07?: string } = {}): MergeInput {
  return {
    constants: CONSTANTS,
    rowIds: ROW_IDS,
    decision: DECISION_2,
    sources: [SOURCE_C],
    before: { [SCENES]: SCENES_AFTER_1, [REGISTER]: REGISTER_AFTER_1, [REF05]: REF05_BEFORE },
    after: {
      [SCENES]: patch.after09 ?? `${SCENES_AFTER_1}\n${scene(HEADER_2, '远航号的走廊比平时安静。温芮在舱门前停了一下。')}`,
      [REGISTER]: patch.after07 ?? `${REGISTER_AFTER_1}${ROW_R02}\n`,
      [REF05]: REF05_AFTER,
    },
  };
}

function failsExactly(input: MergeInput, violation: string): void {
  assert.deepEqual(mergecheck(input), { ok: false, violations: [violation] });
}

function failsWith(input: MergeInput, pattern: RegExp): void {
  const result = mergecheck(input);
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 1, result.violations.join('\n'));
  assert.match(result.violations[0] ?? '', pattern);
}

test('a valid first merge passes', () => {
  assert.deepEqual(mergecheck(firstMerge()), { ok: true, violations: [] });
});

test('a valid second merge passes without repeating the pointer', () => {
  assert.deepEqual(mergecheck(secondMerge()), { ok: true, violations: [] });
});

test('a second merge that repeats the 07 pointer fails', () => {
  const result = mergecheck(secondMerge({ after07: `${REGISTER_AFTER_1}\n${POINTER}\n\n${HEADING}\n\n${TABLE_HEADER}\n${ROW_R02}\n` }));
  assert.equal(result.ok, false);
  assert.ok(result.violations.every((v) => v.startsWith('07:')), result.violations.join('\n'));
});

test('a merge without registered facts passes with 无 and an unchanged 07', () => {
  const decision: MergeDecision = { ...DECISION_1, registered: [] };
  assert.deepEqual(mergecheck(firstMerge({ decision, headerText: header({ facts: '无' }), body: '温芮把旧水壶放回架上。灯亮了。', after07: REGISTER_BEFORE, after04: REF04_BEFORE })), { ok: true, violations: [] });
});

test('a cut sentence fails', () => {
  failsWith(firstMerge({ body: BODY_1.replace('温芮把旧水壶放回架上。', '把旧水壶放回架上。') }), /^09: sentence matches no source: 把旧水壶放回架上。$/u);
});

test('two base sentences in reversed order fail', () => {
  failsWith(firstMerge({ body: '冷湾的值班表贴在门边，字迹已经褪色。温芮把旧水壶放回架上。同一天，老周说那是冰栈交接的信号。她数了三遍配额。' }), /^09: base sentence out of order: 温芮把旧水壶放回架上。$/u);
});

test('a base sentence used twice fails', () => {
  failsWith(firstMerge({ body: `${BODY_1}温芮把旧水壶放回架上。` }), /^09: base sentence repeated: 温芮把旧水壶放回架上。$/u);
});

test('a joint that is not in the connective list fails', () => {
  failsWith(firstMerge({ body: BODY_1.replace('同一天，', '第二天，') }), /^09: sentence matches no source: 第二天，老周说那是冰栈交接的信号。$/u);
});

test('a donor sentence without a registered source quote fails', () => {
  failsWith(firstMerge({ body: `管道在夜里响了两次。${BODY_1}` }), /^09: sentence matches no source: 管道在夜里响了两次。$/u);
});

test('too many joints fail', () => {
  const body = '温芮把旧水壶放回架上。同一天，灯亮了。稍后，冷湾的值班表贴在门边，字迹已经褪色。同一天，老周说那是冰栈交接的信号。稍后，她数了三遍配额。';
  failsWith(firstMerge({ body }), /^09: too many joints: 4 > 3$/u);
});

test('a header with an unknown row id fails', () => {
  failsWith(firstMerge({ headerText: header({ row: 'S9-不存在' }) }), /^09: unknown 地点 S9-不存在$/u);
});

test('a header whose Rxx list differs from the decision fails', () => {
  failsWith(firstMerge({ headerText: header({ facts: 'R01-01' }) }), /^09: registered list R01-01 does not match decision R01-01、R01-02$/u);
});

test('a header whose round differs from the decision fails', () => {
  const result = mergecheck(firstMerge({ headerText: header({ round: 'R02' }) }));
  assert.equal(result.ok, false);
  assert.ok(result.violations.includes('09: heading round R02 does not match decision round R01'), result.violations.join('\n'));
});

test('a header whose title differs from the decision fails', () => {
  failsWith(firstMerge({ headerText: header({ title: '别的标题' }) }), /^09: title 别的标题 does not match decision title 冷湾值班夜$/u);
});

test('a malformed header fails', () => {
  failsWith(firstMerge({ headerText: header().replace('与路径无关', '看情况') }), /^09: scene header does not match the required format/u);
});

test('a new 09 without the exact preamble fails', () => {
  failsWith(firstMerge({ after09: scene(header(), BODY_1) }), /^09: a new 09 must open with the exact preamble/u);
});

test('a new 09 holding only the preamble fails', () => {
  failsWith(firstMerge({ after09: `${PREAMBLE}\n\n` }), /^09: no scene appended$/u);
});

test('an appended scene glued to the previous line fails', () => {
  failsWith(secondMerge({ after09: `${SCENES_AFTER_1.slice(0, -1)}${scene(HEADER_2, '远航号的走廊比平时安静。')}` }), /^09: not append-only/u);
  const input = secondMerge();
  const unterminated: MergeInput = { ...input, before: { ...input.before, [SCENES]: SCENES_AFTER_1.slice(0, -1) }, after: { ...input.after, [SCENES]: `${SCENES_AFTER_1.slice(0, -1)}${scene(HEADER_2, '远航号的走廊比平时安静。')}` } };
  failsWith(unterminated, /^09: the scene header must start on a new line$/u);
});

test('a second scene in the appended part fails', () => {
  failsWith(firstMerge({ body: `${BODY_1}\n\n## R01｜又一场\n\n灯亮了。` }), /^09: the appended part must contain exactly one scene/u);
});

test('a 09 edit that is not append-only fails', () => {
  const changed = SCENES_AFTER_1.replace('她数了三遍配额。', '她数了两遍配额。');
  failsWith(secondMerge({ after09: `${changed}\n${scene(HEADER_2, '远航号的走廊比平时安静。')}` }), /^09: not append-only/u);
});

test('a 07 row whose 事实 differs from the claim fails', () => {
  const bad = ROW_1.replace('冷湾值班表贴在门边，按旧制每夜更新', '冷湾值班表每天更换');
  failsWith(firstMerge({ after07: REGISTER_AFTER_1.replace(ROW_1, bad) }), /^07: R01-01 事实 冷湾值班表每天更换 is not 冷湾值班表贴在门边，按旧制每夜更新$/u);
});

test('a 07 row whose 事实 is only part of the claim fails, so a cut cannot invert the fact', () => {
  const cut = ROW_1.replace('冷湾值班表贴在门边，按旧制每夜更新', '按旧制每夜更新');
  failsWith(firstMerge({ after07: REGISTER_AFTER_1.replace(ROW_1, cut) }), /^07: R01-01 事实 按旧制每夜更新 is not /u);
});

test('an extra 07 row fails', () => {
  const extra = '| R01-03 | S1-冷湾 | 冷湾 | 已选地方事实 | 04 | F07 | 制度 | R01 |';
  failsWith(firstMerge({ after07: `${REGISTER_AFTER_1}${extra}\n` }), /^07: extra row: \| R01-03/u);
});

test('a missing 07 row fails', () => {
  failsWith(firstMerge({ after07: REGISTER_AFTER_1.replace(`${ROW_2}\n`, '') }), /^07: missing row for R01-02$/u);
});

test('a 07 row with the wrong round column fails', () => {
  failsWith(firstMerge({ after07: REGISTER_AFTER_1.replace(ROW_2, ROW_2.replace('| R01 |', '| R02 |')) }), /^07: R01-02 round column R02 is not R01$/u);
});

test('a change to 07 before the end fails', () => {
  failsWith(firstMerge({ after07: REGISTER_AFTER_1.replace('先读地图', '先读图') }), /^07: not append-only/u);
});

test('a first merge without the 07 pointer block fails', () => {
  failsWith(firstMerge({ after07: `${REGISTER_BEFORE}${ROW_1}\n${ROW_2}\n` }), /^07: the first merge must add the pointer, §8 heading and table header$/u);
});

test('a changed line in 01 fails', () => {
  failsWith(firstMerge({ after01: REF01_TEXT.replace('航约428', '航约429') }), /^reference\/01-space-and-history\.md: line 3 removed or changed: "航约428。"$/u);
});

test('an added line in 04 that is not an index line fails', () => {
  failsWith(firstMerge({ after04: REF04_AFTER.replace('舰上日常。\n', '舰上日常。\n新增一句。\n') }), /^reference\/04-war-and-diplomacy\.md: added line is not an index line: 新增一句。$/u);
});

test('an index line naming an Rxx outside the decision fails', () => {
  failsWith(firstMerge({ after04: REF04_AFTER.replace('R01-01、R01-02', 'R01-01、R01-03') }), /^reference\/04-war-and-diplomacy\.md: R01-03 is not registered in this merge$/u);
});

test('an index line pointing at another scene fails', () => {
  failsWith(firstMerge({ after04: REF04_AFTER.replace('§R01', '§R02') }), /^reference\/04-war-and-diplomacy\.md: index line points to §R02, not §R01$/u);
});

const REF08 = 'reference/08-cross-system-cases.md';

function withFiles(input: MergeInput, before: Record<string, string>, after: Record<string, string>): MergeInput {
  return { ...input, before: { ...input.before, ...before }, after: { ...input.after, ...after } };
}

test('an unchanged path outside 01-07 and 09 passes', () => {
  assert.deepEqual(mergecheck(withFiles(firstMerge(), { [REF08]: 'a\n', 'BOOK.md': 'b\n' }, { [REF08]: 'a\n', 'BOOK.md': 'b\n' })), { ok: true, violations: [] });
});

test('a changed path outside 01-07 and 09 fails', () => {
  failsExactly(withFiles(firstMerge(), { [REF08]: 'a\n' }, { [REF08]: 'b\n' }), `unexpected change: ${REF08}`);
});

test('a revision-notes path listed in notesPaths may change; an unlisted notes file may not', () => {
  const notes = 'reference/CHANGES.md';
  assert.deepEqual(mergecheck(withFiles(firstMerge(), { [notes]: '# 8.1\n' }, { [notes]: '# 8.1\n\n## 8.2 样本现场 R01\n' })), { ok: true, violations: [] });
  failsExactly(withFiles(firstMerge(), { 'reference/README.md': 'a\n' }, { 'reference/README.md': 'b\n' }), 'unexpected change: reference/README.md');
});

test('a path outside 01-07 and 09 that is added or removed fails', () => {
  failsExactly(withFiles(firstMerge(), {}, { 'reference/10-new.md': '新增。\n' }), 'unexpected change: reference/10-new.md');
  failsExactly(withFiles(firstMerge(), { 'BOOK.md': '书。\n' }, {}), 'unexpected change: BOOK.md');
});

test('a path outside 01-07 and 09 that is empty on one side and absent on the other passes', () => {
  assert.deepEqual(mergecheck(withFiles(firstMerge(), { [REF08]: '' }, {})), { ok: true, violations: [] });
});

test('a registered fact that no source provides fails', () => {
  const decision: MergeDecision = { ...DECISION_1, registered: [{ rxx: 'R01-01', label: 'A', factId: 'A-01' }, { rxx: 'R01-02', label: 'B', factId: 'B-09' }] };
  const result = mergecheck(firstMerge({ decision }));
  assert.equal(result.ok, false);
  assert.ok(result.violations.includes('decision: R01-02 refers to unknown fact B/B-09'), result.violations.join('\n'));
});

test('sceneHeaderRegex accepts the documented header forms', () => {
  const re = sceneHeaderRegex(ROW_IDS);
  assert.match(header(), re);
  assert.match(header({ anchor: 'D3—D5中的任一常态日' }), re);
  assert.match(header({ anchor: '任一常态日', facts: '无' }), re);
  assert.match(header({ row: 'SHIP', title: '字'.repeat(24) }), re);
  const status = header().replace('已选地方事实·已发生事件', '状态与路径实例·示例').replace('与路径无关', '标准成功路径');
  assert.match(status, re);
});

test('sceneHeaderRegex rejects malformed headers', () => {
  const re = sceneHeaderRegex(ROW_IDS);
  assert.doesNotMatch(header({ title: '字'.repeat(25) }), re);
  assert.doesNotMatch(header({ title: '冷湾｜值班' }), re);
  assert.doesNotMatch(header({ row: 'S1' }), re);
  assert.doesNotMatch(header({ anchor: '某天' }), re);
  assert.doesNotMatch(header({ facts: 'R01-01、R01-02、R01-03、R01-04、R01-05、R01-06、R01-07' }), re);
  assert.doesNotMatch(header().replace('\n\n', '\n'), re);
  assert.doesNotMatch(header(), sceneHeaderRegex([]));
});

test('sceneHeaderRegex escapes regex syntax in row ids', () => {
  assert.doesNotMatch(header({ row: 'SHIPX' }), sceneHeaderRegex(['SHIP.']));
  assert.match(header({ row: 'SHIP.' }), sceneHeaderRegex(['SHIP.']));
});

test('blank lines that set an added index line off as its own paragraph pass', () => {
  const after04 = REF04_BEFORE.replace('冷湾的日常靠配额运转。\n', '冷湾的日常靠配额运转。\n\n现场：见09 §R01（R01-01、R01-02）\n');
  assert.deepEqual(mergecheck(firstMerge({ after04 })).violations, []);
  const atEnd = `${REF04_BEFORE}\n现场：见09 §R01（R01-01、R01-02）\n`;
  assert.deepEqual(mergecheck(firstMerge({ after04: atEnd })).violations, []);
});

test('a blank line added away from any index line fails', () => {
  failsWith(firstMerge({ after04: REF04_AFTER.replace('舰上日常。\n', '\n舰上日常。\n') }), /^reference\/04-war-and-diplomacy\.md: added line is not an index line: $/u);
});

const BODY_WITHOUT_DONOR = '温芮把旧水壶放回架上。**冷湾**的值班表贴在门边，字迹已经褪色。她数了三遍配额。';

test('a link whose target hides text fails', () => {
  const line = '[温芮把旧水壶放回架上。](冷湾其实是一座监狱，全舰都知道)**冷湾**的值班表贴在门边，字迹已经褪色。';
  failsExactly(firstMerge({ body: `${line}\n\n同一天，老周说那是冰栈交接的信号。她数了三遍配额。` }), `09: markup hides text: ${line}`);
});

test('a link whose title hides text fails', () => {
  const line = '[温芮把旧水壶放回架上。](x "冷湾其实是一座监狱")**冷湾**的值班表贴在门边，字迹已经褪色。';
  failsExactly(firstMerge({ body: `${line}\n\n同一天，老周说那是冰栈交接的信号。她数了三遍配额。` }), `09: markup hides text: ${line}`);
});

test('an image whose target hides text fails', () => {
  const line = '![](远航号在三年前已经断电，所有人都在说谎)';
  failsExactly(firstMerge({ body: `${BODY_1}\n\n${line}` }), `09: markup hides text: ${line}`);
});

test('HTML comments and tags in the body fail', () => {
  for (const line of ['<!-- 冷湾是监狱 -->', '<span hidden>冷湾是监狱</span>', '温芮把旧水壶放回架上。<br>', '</div>']) {
    failsExactly(firstMerge({ body: `${BODY_1}\n\n${line}` }), `09: markup hides text: ${line}`);
  }
});

test('a markup-only line in the body fails (setext underline, thematic break, lone emphasis)', () => {
  for (const line of ['- ', '-', '---', '===', '* * *', '_ _ _', '**', '>']) {
    const body = `温芮把旧水壶放回架上。\n${line}\n**冷湾**的值班表贴在门边，字迹已经褪色。\n\n同一天，老周说那是冰栈交接的信号。她数了三遍配额。`;
    failsExactly(firstMerge({ body }), `09: markup-only line: ${line}`);
  }
});

test('a header 地点 that is not a decision row fails', () => {
  failsExactly(firstMerge({ headerText: header({ row: 'SHIP' }) }), '09: 地点 SHIP is not a decision row');
});

test('a registered fact whose source quote is not in the scene fails', () => {
  failsExactly(firstMerge({ body: BODY_WITHOUT_DONOR }), '09: R01-02 source quote not in scene');
});

test('a registered source quote carrying Markdown is found in the stripped scene', () => {
  const marked: MergeSource = { ...SOURCE_A, facts: [{ ...SOURCE_A.facts[0] ?? fact({}), id: 'A-01', sourceQuote: '**冷湾**的值班表贴在门边' }] };
  const input = firstMerge();
  assert.deepEqual(mergecheck({ ...input, sources: [marked, SOURCE_B] }), { ok: true, violations: [] });
});

test('a base sentence repeated through the donor path still fails', () => {
  const donor: MergeSource = {
    label: 'B',
    submission: `${SOURCE_B.submission}冷湾的值班表贴在门边，字迹已经褪色。`,
    facts: [...SOURCE_B.facts, fact({ id: 'B-03', claim: '冷湾值班表字迹褪色', sourceQuote: '值班表贴在门边，字迹' })],
  };
  const decision: MergeDecision = { ...DECISION_1, registered: [...DECISION_1.registered, { rxx: 'R01-03', label: 'B', factId: 'B-03' }] };
  const row3 = '| R01-03 | S1-冷湾 | 冷湾值班表字迹褪色 | 已选地方事实 | 04 | F07 | m | R01 |';
  const input = firstMerge({
    decision,
    headerText: header({ facts: 'R01-01、R01-02、R01-03' }),
    body: `${BODY_1}冷湾的值班表贴在门边，字迹已经褪色。`,
    after07: `${REGISTER_AFTER_1}${row3}\n`,
    after04: REF04_AFTER.replace('R01-01、R01-02', 'R01-01、R01-02、R01-03'),
  });
  failsExactly({ ...input, sources: [SOURCE_A, donor] }, '09: base sentence repeated: 冷湾的值班表贴在门边，字迹已经褪色。');
});

test('one source fact registered under two Rxx fails', () => {
  const decision: MergeDecision = { ...DECISION_1, registered: [{ rxx: 'R01-01', label: 'A', factId: 'A-01' }, { rxx: 'R01-02', label: 'A', factId: 'A-01' }] };
  const after07 = REGISTER_AFTER_1.replace(ROW_2, ROW_1.replace('R01-01', 'R01-02'));
  failsExactly(firstMerge({ decision, after07, body: BODY_WITHOUT_DONOR }), 'decision: A/A-01 is registered twice');
});

function withDonorQuote(input: MergeInput, sourceQuote: string): MergeInput {
  const donor: MergeSource = { ...SOURCE_B, facts: SOURCE_B.facts.map((f) => (f.id === 'B-01' ? { ...f, sourceQuote } : f)) };
  return { ...input, sources: [SOURCE_A, donor] };
}

test('a registered source quote shorter than four significant characters fails', () => {
  failsExactly(withDonorQuote(firstMerge({ body: BODY_WITHOUT_DONOR }), '。'), 'decision: R01-02 source quote is too short');
  // Three significant characters, and a quote whose punctuation does not count; both occur in the scene.
  failsExactly(withDonorQuote(firstMerge({ body: BODY_WITHOUT_DONOR }), '温芮把'), 'decision: R01-02 source quote is too short');
  failsExactly(withDonorQuote(firstMerge({ body: BODY_WITHOUT_DONOR }), '架上。'), 'decision: R01-02 source quote is too short');
});

test('a too-short source quote does not admit donor sentences', () => {
  const input = withDonorQuote(firstMerge({ body: `${BODY_1}没有人回答他。` }), '。');
  assert.deepEqual(mergecheck(input), {
    ok: false,
    violations: ['decision: R01-02 source quote is too short', '09: sentence matches no source: 同一天，老周说那是冰栈交接的信号。', '09: sentence matches no source: 没有人回答他。'],
  });
});

test('a four-character source quote is long enough for the donor path', () => {
  assert.deepEqual(mergecheck(withDonorQuote(firstMerge(), '冰栈交接')), { ok: true, violations: [] });
});

test('a 07 row whose 行 is only part of the row id fails', () => {
  failsExactly(firstMerge({ after07: REGISTER_AFTER_1.replace(ROW_1, ROW_1.replace('| S1-冷湾 |', '| S1 |')) }), '07: R01-01 行 S1 is not S1-冷湾');
});

test('a 07 row whose 地位 is only part of the status fails', () => {
  failsExactly(firstMerge({ after07: REGISTER_AFTER_1.replace(ROW_1, ROW_1.replace('| 已选地方事实 |', '| 已选 |')) }), '07: R01-01 地位 已选 is not 已选地方事实');
});

test('a body with half-width punctuation where the base has full-width passes', () => {
  const base: MergeSource = { ...SOURCE_A, submission: SOURCE_A.submission.replace('灯亮了。', '她说：灯亮了。') };
  const body = '温芮把旧水壶放回架上。她说:灯亮了。**冷湾**的值班表贴在门边,字迹已经褪色。\n\n同一天,老周说那是冰栈交接的信号。她数了三遍配额。';
  const input = firstMerge({ body });
  assert.deepEqual(mergecheck({ ...input, sources: [base, SOURCE_B] }), { ok: true, violations: [] });
});

test('a donor sentence and source quote compare across width variants', () => {
  const donor: MergeSource = {
    ...SOURCE_B,
    submission: '管道在夜里响了两次。老周说：那是冰栈交接的信号。没有人回答他。',
    facts: SOURCE_B.facts.map((f) => (f.id === 'B-01' ? { ...f, sourceQuote: '说：那是冰栈交接的信号' } : f)),
  };
  const body = '温芮把旧水壶放回架上。**冷湾**的值班表贴在门边，字迹已经褪色。\n\n同一天,老周说:那是冰栈交接的信号。她数了三遍配额。';
  const input = firstMerge({ body });
  assert.deepEqual(mergecheck({ ...input, sources: [SOURCE_A, donor] }), { ok: true, violations: [] });
});

test('violations name the original body sentence, not its comparison key', () => {
  failsExactly(firstMerge({ body: `${BODY_1}她说:灯灭了。` }), '09: sentence matches no source: 她说:灯灭了。');
});

test('a registered source quote may span sentences of the scene', () => {
  const spanning: MergeSource = { ...SOURCE_A, facts: [{ ...(SOURCE_A.facts[0] ?? fact({})), sourceQuote: '灯亮了。冷湾的值班表' }] };
  const body = '温芮把旧水壶放回架上。灯亮了。**冷湾**的值班表贴在门边，字迹已经褪色。\n\n同一天，老周说那是冰栈交接的信号。她数了三遍配额。';
  const input = { ...firstMerge({ body }), sources: [spanning, SOURCE_B] };
  assert.deepEqual(mergecheck(input).violations, []);
});

test('a new file under the 01-06 names is an unexpected change, not an index', () => {
  const input = firstMerge();
  input.after['reference/06-new-file.md'] = '现场：见09 §R01（R01-01）\n';
  assert.deepEqual(mergecheck(input).violations, ['unexpected change: reference/06-new-file.md']);
});

test('list, quote, fence and table markup in the scene body fails: the body must be plain paragraphs', () => {
  for (const line of ['```温芮把旧水壶放回架上。', '~~~', '1024. 温芮把旧水壶放回架上。', '- 温芮把旧水壶放回架上。', '> 温芮把旧水壶放回架上。', '|-|', '| 温芮把旧水壶放回架上。 |']) {
    const body = `${line}\n**冷湾**的值班表贴在门边，字迹已经褪色。\n\n同一天，老周说那是冰栈交接的信号。她数了三遍配额。`;
    const v = mergecheck(firstMerge({ body })).violations;
    assert.ok(v.some((x) => x.startsWith('09: body must be plain paragraphs: ')), `${line}: ${v.join(' | ')}`);
  }
});

test('a base sentence behind a connective cannot come back through a donor that carries the same text', () => {
  const donor: MergeSource = { ...SOURCE_B, submission: `${SOURCE_B.submission}同一天，温芮把旧水壶放回架上。`, facts: [...SOURCE_B.facts, fact({ id: 'B-03', sourceQuote: '温芮把旧水壶放' })] };
  const decision: MergeDecision = { ...DECISION_1, registered: [...DECISION_1.registered, { rxx: 'R01-03', label: 'B', factId: 'B-03' }] };
  const input = { ...firstMerge({ decision, body: `${BODY_1}同一天，温芮把旧水壶放回架上。` }), sources: [SOURCE_A, donor] };
  assert.ok(mergecheck(input).violations.some((v) => v.startsWith('09: base sentence repeated: ')));
});

test('a donor sentence may be used only once', () => {
  const body = `${BODY_1}\n\n同一天，老周说那是冰栈交接的信号。`;
  assert.ok(mergecheck(firstMerge({ body })).violations.some((v) => v.startsWith('09: donor sentence repeated: ')));
});

test('a registered fact without extends is written as 无 in the 延伸自 cell', () => {
  const noExtends: MergeSource = { ...SOURCE_A, facts: [{ ...(SOURCE_A.facts[0] ?? fact({})), extends: '' }] };
  const row = ROW_1.replace('| F07 |', '| 无 |');
  const input = { ...firstMerge({ after07: REGISTER_AFTER_1.replace(ROW_1, row) }), sources: [noExtends, SOURCE_B] };
  assert.deepEqual(mergecheck(input).violations, []);
  const wrong = { ...firstMerge(), sources: [noExtends, SOURCE_B] };
  assert.ok(mergecheck(wrong).violations.some((v) => v.includes('延伸自')));
});

test('an index line glued to the paragraph above it fails, because Markdown would merge it into that paragraph', () => {
  const glued = REF04_BEFORE.replace('冷湾的日常靠配额运转。\n', '冷湾的日常靠配额运转。\n现场：见09 §R01（R01-01、R01-02）\n');
  failsWith(firstMerge({ after04: glued }), /^reference\/04-war-and-diplomacy\.md: index line must start its own paragraph: 现场：见09 §R01（R01-01、R01-02）$/u);
});
