import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Family } from './config.ts';
import {
  gatePool, mergeCommitMessage, mergeDecisionFrom, needsRegate, nextManifest, nextRevision, parseMergePointer, postMergeMechanical, postMergePack,
  postmergeTaskId, regateFacts, regateMechanical, regatePack, regateTaskId, revisionNotes, trialDonors, type RegateFact, type RegateLimits,
} from './merge.ts';
import type { DeltaFact, MergeDecision, MergeSource } from './mergecheck.ts';
import type { Decision } from './owner-inputs.ts';
import { loadProtocolBundle } from './rules.ts';
import type { BriefJson, FactRow } from './steps/brief.ts';
import { seededShuffle } from './store.ts';
import type { FamilyState } from './tasks/assign.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = loadProtocolBundle(ROOT);
if (!bundle.ok) throw new Error(bundle.error);
const PROTOCOL = bundle.value.protocol;

function fact(id: string, claim: string, quote: string, over: Partial<DeltaFact> = {}): DeltaFact {
  return { id, claim, status: '已选地方事实', rowId: 'SHIP', attachesTo: '05', extends: '', misuse: '误用', sourceQuote: quote, ...over };
}

const SOURCES: MergeSource[] = [
  { label: 'A', submission: '温芮核对配给簿。留饭签挂在铁钩上。', facts: [fact('A-01', '留饭签挂在铁钩上', '留饭签挂在铁钩上'), fact('A-02', '配给簿由温芮核对', '温芮核对配给簿')] },
  { label: 'C', submission: '循环泵换班时变慢。孩子们数着灯。', facts: [fact('A-01', '循环泵换班时变慢', '循环泵换班时变慢')] },
  { label: 'B', submission: '食堂的蒸笼冒着白汽。', facts: [fact('A-01', '蒸笼冒着白汽', '食堂的蒸笼冒着白汽')] },
  { label: 'BASE', submission: '基线。', facts: [] },
];

function decision(over: Partial<Decision>): Decision {
  return {
    round: 'R03', pick: 'A', pick_submission: 'W1', base: null, champion: 'no', facts: [], reason: '平', fav: 'A', publish: 'no', happened: false, supersedes: null,
    decided_at: '2026-10-01T00:00:00.000Z', file: 'rounds/R03/decision.json', ...over,
  };
}

const dfact = (label: string, id: string): Decision['facts'][number] => ({ label, submission: 'W1', id, claim: '' });

test('nextRevision: minor + 1 as an integer; anything but <int>.<int> is an error', () => {
  assert.deepEqual(nextRevision('8.1'), { ok: true, value: '8.2' });
  assert.deepEqual(nextRevision('8.9'), { ok: true, value: '8.10' });
  assert.deepEqual(nextRevision('10.19'), { ok: true, value: '10.20' });
  for (const bad of ['8', '8.', '.1', '8.1.2', 'v8.1', '08.1', '']) assert.equal(nextRevision(bad).ok, false, bad);
});

test('mergeDecisionFrom: base = base ?? pick, rows = [row], facts in card order (label, then delta order) numbered RNN-01…', () => {
  const d = mergeDecisionFrom(decision({ pick: 'B', base: 'A', facts: [dfact('C', 'A-01'), dfact('A', 'A-02'), dfact('A', 'A-01')] }), SOURCES, 'SHIP');
  assert.ok(d.ok, d.ok ? '' : d.error);
  assert.deepEqual(d.value, {
    round: 'R03', baseLabel: 'A', title: '', rows: ['SHIP'],
    registered: [{ rxx: 'R03-01', label: 'A', factId: 'A-01' }, { rxx: 'R03-02', label: 'A', factId: 'A-02' }, { rxx: 'R03-03', label: 'C', factId: 'A-01' }],
  });
  assert.equal(needsRegate(d.value), true);
  const single = mergeDecisionFrom(decision({ facts: [dfact('A', 'A-02')] }), SOURCES, 'SHIP');
  assert.ok(single.ok);
  assert.equal(single.value.baseLabel, 'A');
  assert.equal(needsRegate(single.value), false);
  assert.equal(mergeDecisionFrom(decision({ pick: 'none' }), SOURCES, 'SHIP').ok, false);
  assert.equal(mergeDecisionFrom(decision({ facts: [dfact('A', 'A-09')] }), SOURCES, 'SHIP').ok, false);
  assert.equal(mergeDecisionFrom(decision({ facts: [dfact('A', 'A-01'), dfact('A', 'A-01')] }), SOURCES, 'SHIP').ok, false);
  assert.equal(mergeDecisionFrom(decision({ pick: 'Z' }), SOURCES, 'SHIP').ok, false);
});

test('trialDonors: base or fact donor whose champion pair was trial, code-unit sorted', () => {
  const d: MergeDecision = { round: 'R03', baseLabel: 'B', title: '', rows: ['SHIP'], registered: [{ rxx: 'R03-01', label: 'C', factId: 'A-01' }, { rxx: 'R03-02', label: 'A', factId: 'A-01' }] };
  const tally = { champion_pairs: [{ label: 'A', trial: false }, { label: 'B', trial: true }, { label: 'C', trial: true }] };
  assert.deepEqual(trialDonors(tally, d), ['B', 'C']);
  assert.deepEqual(trialDonors({ champion_pairs: [{ label: 'A', trial: true }] }, { ...d, registered: [] }), []);
});

function rfact(rxx: string, claim: string, over: Partial<RegateFact> = {}): RegateFact {
  return { rxx, label: 'A', fact_id: 'A-01', claim, status: '已选地方事实', row_id: 'SHIP', extends: 'F03', source_sentences: [`${claim}。`], ...over };
}

const LIMITS: RegateLimits = { rowIds: ['SHIP'], statuses: ['共同事实', '已选地方事实', '状态与路径实例', '有边界的未知'], properNouns: [], fixtureClaim: PROTOCOL.fixtureRxx.claim };

test('regateFacts carries delta fields and the donor sentences holding the quote', () => {
  const d: MergeDecision = { round: 'R03', baseLabel: 'A', title: '', rows: ['SHIP'], registered: [{ rxx: 'R03-01', label: 'C', factId: 'A-01' }] };
  const r = regateFacts(d, SOURCES);
  assert.deepEqual(r, { ok: true, value: [{ rxx: 'R03-01', label: 'C', fact_id: 'A-01', claim: '循环泵换班时变慢', status: '已选地方事实', row_id: 'SHIP', extends: '', source_sentences: ['循环泵换班时变慢。'] }] });
  assert.equal(regateFacts({ ...d, registered: [{ rxx: 'R03-01', label: 'C', factId: 'X' }] }, SOURCES).ok, false);
  // A base quote may span sentences (mergecheck checks it in the scene): its quote stands in. A donor quote no sentence
  // carries by the donor rule (here an extra comma) lists nothing, as mergeability rejects it.
  const quotes: Record<string, string> = { A: '核对配给簿。留饭签挂在', C: '循环泵换班时，变慢' };
  const edited = SOURCES.map((x) => ({ ...x, facts: x.facts.map((f) => ({ ...f, sourceQuote: quotes[x.label] ?? f.sourceQuote })) }));
  const both = regateFacts({ ...d, registered: [{ rxx: 'R03-01', label: 'A', factId: 'A-01' }, { rxx: 'R03-02', label: 'C', factId: 'A-01' }] }, edited);
  assert.ok(both.ok);
  assert.deepEqual(both.value.map((f) => f.source_sentences), [['核对配给簿。留饭签挂在'], []]);
});

test('regateMechanical: ≤ 6 facts, ≤ 3 without extends, unique claims, row / status, no | or newline, ≤ 3 nouns, never the fixture claim', () => {
  assert.deepEqual(regateMechanical([rfact('R03-01', '甲'), rfact('R03-02', '乙')], LIMITS), []);
  const seven = Array.from({ length: 7 }, (_, i) => rfact(`R03-0${i + 1}`, `事实${i}`));
  assert.deepEqual(regateMechanical(seven, LIMITS), ['too many facts: 7 > 6']);
  const bare = ['甲', '乙', '丙', '丁'].map((c, i) => rfact(`R03-0${i + 1}`, c, { extends: ' ' }));
  assert.deepEqual(regateMechanical(bare, LIMITS), ['too many facts without extends: 4 > 3']);
  assert.deepEqual(regateMechanical([rfact('R03-01', '甲'), rfact('R03-02', '甲。')], LIMITS), ['R03-02: claim repeats R03-01']);
  assert.deepEqual(regateMechanical([rfact('R03-01', '甲', { row_id: 'NOPE', status: '传闻' })], LIMITS), ['R03-01: unknown row_id', 'R03-01: status is not one of the 07 §1 statuses']);
  assert.deepEqual(regateMechanical([rfact('R03-01', '甲|乙'), rfact('R03-02', '丙', { extends: 'F0\n3' })], LIMITS), ['R03-01: claim contains | or a line break', 'R03-02: extends contains | or a line break']);
  assert.deepEqual(regateMechanical([rfact('R03-01', '甲')], { ...LIMITS, properNouns: ['一', '二', '三', '四'] }), ['too many new proper nouns: 4 > 3']);
  assert.deepEqual(regateMechanical([rfact('R03-01', PROTOCOL.fixtureRxx.claim)], LIMITS), ['R03-01: repeats the fixture fact']);
});

const F01: FactRow = { id: 'F01', kind: 'fact', text: '没有星门。', status: '共同事实', rows: ['ALL'] };
const R01: FactRow = { id: 'R01-01', kind: 'registered', text: '工具柜不上锁', status: '状态与路径实例', rows: ['SHIP'] };

function brief(): BriefJson {
  return {
    round: 'R03', kind: 'round', row_id: 'SHIP', layer: '物件', topic_source: 'fixed',
    cell: { id: 'C', row_id: 'SHIP', title: '母舰', entity: '母舰', time: '常态日', layers: [], setting_notes: [], protagonists: [], forbidden: ['出现未登记的第三方势力'], stances: [] },
    canon: { revision: '8.1', book_sha256: 'b'.repeat(64), reference_sha256: 'c'.repeat(64) }, canon_passages: [], facts: [F01, R01],
    regression: [{ id: 'G-001', case: 'P01', source: 's', quote: '砧港的维修棚。' }], regression_stale: [], forbidden: ['出现未登记的第三方势力'], cliches: [],
    requirements: [], interface_requirements: [], aliases: [], seed: 's', created_at: '2026-10-01T00:00:00.000Z',
  };
}

test('regatePack is a fact_set pack against the frozen table; postMergePack a text pack without this round\'s Rxx', () => {
  const p = regatePack([rfact('R03-01', '甲')], brief());
  assert.equal(p.subjectKind, 'fact_set');
  assert.equal(p.subject, 'R03-01｜已选地方事实｜SHIP｜甲\n出处：甲。');
  assert.deepEqual(p.facts.map((f) => f.id), ['F01', 'R01-01']);
  assert.deepEqual(p.forbidden, [{ id: 'X01', text: '出现未登记的第三方势力' }]);
  assert.deepEqual(p.regression.map((r) => r.id), ['G-001']);
  const q = postMergePack('## R03｜题\n\n正文。', brief(), ['R01-01']);
  assert.equal(q.subjectKind, 'text');
  assert.deepEqual(q.facts.map((f) => f.id), ['F01']);
});

test('postMergeMechanical: forbidden words, rule-sentence ratio and missing source quotes (header lines not counted)', () => {
  const header = '## R03｜题\n\n地点：SHIP｜时间锚：任一常态日｜路径依赖：标准成功路径｜地位：状态与路径实例·示例｜本场登记事实：无\n\n';
  assert.deepEqual(postMergeMechanical(`${header}温芮核对配给簿。留饭签挂在铁钩上。\n`, PROTOCOL, ['留饭签挂在铁钩上']), []);
  const term = PROTOCOL.forbidden[0]?.term ?? '';
  assert.notEqual(term, '');
  const bad = postMergeMechanical(`${header}温芮看见了${term}。借东西必须登记。住户不得外借。\n`, PROTOCOL, ['留饭签挂在铁钩上']);
  assert.equal(bad.length, 3, bad.join('\n'));
  assert.match(bad[0] ?? '', /^rule_sentences: 规则句占比 66\.7%$/u);
  assert.match(bad[1] ?? '', /^forbidden_words: 未否定：/u);
  assert.equal(bad[2], 'source quote not in scene: 留饭签挂在铁钩上');
});

test('gatePool: gate-eligible minus voided minus authors, seeded by key; task ids carry d8', () => {
  const st = (family: Family, gate: boolean, flag: FamilyState['flag'] = 'ok'): FamilyState => ({ family, tasteQualified: true, gateQualified: gate, flag });
  const states = [st('Anthropic', true), st('Moonshot', true), st('OpenAI', true), st('xAI', true, 'suspended'), st('DeepSeek', false)];
  const pool = gatePool(states, ['Moonshot'], ['OpenAI'], 'seed', 'regate:0123abcd');
  assert.deepEqual(pool, ['Anthropic']);
  const wide = gatePool(states.slice(0, 3), [], [], 'seed', 'regate:0123abcd');
  assert.deepEqual(wide, seededShuffle(['Anthropic', 'Moonshot', 'OpenAI'], 'seed', 'regate:0123abcd'));
  assert.equal(regateTaskId('0123abcd', 'xAI', 1), 'regate-0123abcd-xAI-1');
  assert.equal(postmergeTaskId('0123abcd', 'OpenAI', 3), 'postmerge-0123abcd-OpenAI-3');
  assert.throws(() => regateTaskId('0123abcd', 'xAI', 0));
});

test('nextManifest: revision + header line 0, 09 and the manifest header appended only on the first merge', () => {
  const base = `${JSON.stringify({ revision: '8.1', header: ['# 群星回响 · 世界设定参考集 8.1', '', '说明'], files: ['01-a.md', '07-register-and-creation.md'] }, null, 2)}\n`;
  const first = nextManifest(base, '8.2', PROTOCOL.merge);
  assert.ok(first.ok);
  assert.deepEqual(JSON.parse(first.value), {
    revision: '8.2', header: ['# 群星回响 · 世界设定参考集 8.2', '', '说明', ...PROTOCOL.merge.manifestHeader], files: ['01-a.md', '07-register-and-creation.md', '09-scenes-and-people.md'],
  });
  const second = nextManifest(first.value, '8.3', PROTOCOL.merge);
  assert.ok(second.ok);
  assert.deepEqual(JSON.parse(second.value).files, ['01-a.md', '07-register-and-creation.md', '09-scenes-and-people.md']);
  assert.equal(JSON.parse(second.value).header.length, 3 + PROTOCOL.merge.manifestHeader.length);
  assert.equal(nextManifest('{"revision":"8.1","files":[]}', '8.2', PROTOCOL.merge).ok, false);
});

test('revisionNotes appends a two-line entry to CHANGES.md and REVISION.md; merge pointer and commit message', () => {
  const notes = revisionNotes({ 'reference/CHANGES.md': '# 变更\n\n- 8.1\n', 'REVISION.md': '# 修订' }, '8.2', 'R01', ['R01-01', 'R01-02']);
  assert.deepEqual(notes, {
    'reference/CHANGES.md': '# 变更\n\n- 8.1\n\n## 8.2 样本现场 R01\n本场登记事实：R01-01、R01-02\n',
    'REVISION.md': '# 修订\n\n## 8.2 样本现场 R01\n本场登记事实：R01-01、R01-02\n',
  });
  assert.equal(revisionNotes({}, '8.2', 'R01', [])['REVISION.md'], '## 8.2 样本现场 R01\n本场登记事实：无\n');
  assert.equal(mergeCommitMessage('R01', '8.2', 12), 'feat: add sample scene R01, reference 8.2 (#12)');
  const sha = `0123abcd${'e'.repeat(56)}`;
  const pointer = { round: 'R01', current: '0123abcd', decision_sha256: sha, status: 'merged_on_branch', revision: '8.2', reasons: ['postmerge_split'] };
  assert.deepEqual(parseMergePointer(pointer), { ok: true, value: pointer });
  assert.equal(parseMergePointer({ ...pointer, current: 'ffffffff' }).ok, false);
  assert.equal(parseMergePointer({ ...pointer, status: 'no_merge' }).ok, false);
});
