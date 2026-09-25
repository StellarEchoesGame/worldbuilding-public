import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BUNDLE_FILES, PROTOCOL_BLOCKS, parseProtocol, protocolBundleHash, type Protocol } from './protocol.ts';

type Block = [name: string, body: string];

const MERGE = {
  preamble09: '# 09 现场与人物\n\n本文件只追加。',
  pointer07: '现场登记见 §8。',
  heading8: '## 8. 现场登记',
  tableHeader8: '| 编号 | 行 | 事实 | 地位 | 挂靠 | 延伸自 | 误用 | 轮次 |\n|---|---|---|---|---|---|---|---|',
  maxJointsPer500: 3,
};

const FIXTURE_RXX = {
  rxx: 'R01-01',
  rowId: 'S1-冷湾',
  claim: '冷湾的补给窗口只在潮退后开放。',
  status: '已选地方事实',
  attachesTo: '04-冷湾',
  extends: 'F03',
  misuse: '把窗口写成全年开放',
  reversal: '补给窗口全年开放。',
};

function blocks(): Block[] {
  return [
    ['protected-keys', '["gate", "forbidden_words", "canon"]'],
    ['activation', '{"taste": "replay", "measures": "auto", "decoy_recipe": "owner"}'],
    ['bars', '{"beats_champion_four_families": 7, "session_pairs": 2, "hold_rounds": 3}'],
    ['limits', '{"max_chars": 2500, "max_new_proper_nouns": 3, "max_registered": 6, "max_without_extends": 3, "max_rule_ratio": 0.15}'],
    ['forbidden-words', '[{"term": "魔法", "protects": "F03"}, {"term": "外星神", "protects": "F07"}]'],
    ['negations', '["没有", "不", "并非"]'],
    ['negation-exceptions', '["不久", "不少"]'],
    ['defect-types', '[{"id": "D1", "text": "引文不存在"}, {"id": "D2", "text": "越权登记", "requires": "fact"}]'],
    ['connectives', '["同一天，", "后来，"]'],
    ['merge', JSON.stringify(MERGE, null, 2)],
    ['fixture-rxx', JSON.stringify(FIXTURE_RXX, null, 2)],
  ];
}

const EXPECTED: Protocol = {
  version: '1.0-test',
  protectedKeys: ['gate', 'forbidden_words', 'canon'],
  activation: { taste: 'replay', measures: 'auto', decoy_recipe: 'owner' },
  bars: { beatsChampionFourFamilies: 7, sessionPairs: 2, holdRounds: 3 },
  limits: { maxChars: 2500, maxNewProperNouns: 3, maxRegistered: 6, maxWithoutExtends: 3, maxRuleRatio: 0.15 },
  forbidden: [
    { term: '魔法', protects: 'F03' },
    { term: '外星神', protects: 'F07' },
  ],
  negations: ['没有', '不', '并非'],
  negationExceptions: ['不久', '不少'],
  defectTypes: [
    { id: 'D1', text: '引文不存在', requires: null },
    { id: 'D2', text: '越权登记', requires: 'fact' },
  ],
  connectives: ['同一天，', '后来，'],
  merge: MERGE,
  fixtureRxx: FIXTURE_RXX,
};

function render(list: readonly Block[], versionLine = 'Protocol version: 1.0-test'): string {
  const parts = ['# Forge protocol', '', versionLine, '', 'A plain JSON example that is not a protocol block:', '', '```json', '{"not": "protocol"}', '```', ''];
  parts.push('How a block looks (an example, not a block):', '', '````markdown', '```json protocol:bars', '{"hold_rounds": 99}', '```', '````', '');
  parts.push('~~~text', '```json protocol:limits', '~~~', '');
  for (const [name, body] of list) {
    parts.push(`## ${name}`, '', `\`\`\`json protocol:${name}`, body, '```', '');
  }
  return parts.join('\n');
}

function replaced(name: string, body: string): Block[] {
  return blocks().map(([n, b]): Block => (n === name ? [n, body] : [n, b]));
}

function errorOf(markdown: string): string {
  const r = parseProtocol(markdown);
  assert.equal(r.ok, false, 'expected a parse error');
  return r.ok ? '' : r.error;
}

test('PROTOCOL_BLOCKS lists every required block once', () => {
  assert.deepEqual([...PROTOCOL_BLOCKS], blocks().map(([n]) => n));
});

test('parseProtocol reads the version and every block, ignoring other fences', () => {
  const r = parseProtocol(render(blocks()));
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.deepEqual(r.value, EXPECTED);
});

test('parseProtocol accepts CRLF line endings', () => {
  const r = parseProtocol(render(blocks()).replace(/\n/gu, '\r\n'));
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.deepEqual(r.value, EXPECTED);
});

test('each missing block is reported by name', () => {
  for (const name of PROTOCOL_BLOCKS) {
    const e = errorOf(render(blocks().filter(([n]) => n !== name)));
    assert.match(e, new RegExp(`protocol:${name}: missing block`, 'u'));
    for (const other of PROTOCOL_BLOCKS) {
      if (other !== name) assert.doesNotMatch(e, new RegExp(`protocol:${other}:`, 'u'));
    }
  }
});

test('a missing version line is reported', () => {
  assert.match(errorOf(render(blocks(), 'Version 1.0')), /Protocol version/u);
  assert.match(errorOf(render(blocks(), 'Protocol version: ')), /Protocol version/u);
});

test('a duplicated block is reported with both line numbers', () => {
  const list = blocks();
  const negations = list.find(([n]) => n === 'negations');
  assert.ok(negations);
  const e = errorOf(render([...list, negations]));
  assert.match(e, /protocol:negations: duplicate block \(lines \d+, \d+\)/u);
});

test('invalid JSON is reported naming the block', () => {
  const e = errorOf(render(replaced('bars', '{"beats_champion_four_families": 7,')));
  assert.match(e, /protocol:bars: invalid JSON/u);
});

test('malformed block shapes are reported naming the block', () => {
  const cases: Array<[name: string, body: string, expected: RegExp]> = [
    ['protected-keys', '["gate", 3]', /protocol:protected-keys: block must be an array of strings/u],
    ['protected-keys', '["gate", " "]', /protocol:protected-keys: \[1\] must be a non-empty string/u],
    ['negations', '["不", "不"]', /protocol:negations: \[1\] duplicates "不"/u],
    ['connectives', '"同一天，"', /protocol:connectives: block must be an array of strings/u],
    ['activation', '{"taste": "sometimes"}', /protocol:activation: taste must be auto, replay or owner/u],
    ['activation', '["taste"]', /protocol:activation: block must be an object/u],
    ['bars', '{"beats_champion_four_families": 7, "session_pairs": 2, "hold_rounds": -1}', /protocol:bars: hold_rounds must be a non-negative integer/u],
    ['bars', '{"beats_champion_four_families": 7.5, "session_pairs": 2, "hold_rounds": 3}', /protocol:bars: beats_champion_four_families must be a non-negative integer/u],
    ['limits', '{"max_chars": 2500, "max_new_proper_nouns": 3, "max_registered": 6, "max_without_extends": 3}', /protocol:limits: missing key max_rule_ratio/u],
    ['limits', '{"max_chars": 2500, "max_new_proper_nouns": 3, "max_registered": 6, "max_without_extends": 3, "max_rule_ratio": 0.15, "max_char": 1}', /protocol:limits: unknown key max_char/u],
    ['limits', '{"max_chars": 2500, "max_new_proper_nouns": 3, "max_registered": 6, "max_without_extends": 3, "max_rule_ratio": 1.5}', /protocol:limits: max_rule_ratio must be a number between 0 and 1/u],
    ['forbidden-words', '[{"term": "", "protects": "F03"}]', /protocol:forbidden-words: \[0\]\.term must be a non-empty string/u],
    ['forbidden-words', '[{"term": "魔法", "protects": "F03"}, {"term": "魔法", "protects": "F04"}]', /protocol:forbidden-words: \[1\]\.term duplicates "魔法"/u],
    ['defect-types', '[{"id": "D1", "text": "a"}, {"id": "D1", "text": "b"}]', /protocol:defect-types: \[1\]\.id duplicates "D1"/u],
    ['defect-types', '[{"id": "D1", "text": "a", "requires": 3}]', /protocol:defect-types: \[0\]\.requires must be a non-empty string or null/u],
    ['merge', JSON.stringify({ ...MERGE, tableHeader8: '| a |' }), /protocol:merge: tableHeader8 must be two non-empty lines/u],
    ['merge', JSON.stringify({ ...MERGE, maxJointsPer500: '3' }), /protocol:merge: maxJointsPer500 must be a non-negative integer/u],
    ['fixture-rxx', JSON.stringify({ ...FIXTURE_RXX, rxx: 'R1-1' }), /protocol:fixture-rxx: rxx must match R<nn>-<nn>/u],
    ['fixture-rxx', JSON.stringify({ ...FIXTURE_RXX, reversal: '' }), /protocol:fixture-rxx: reversal must be a non-empty string/u],
  ];
  for (const [name, body, expected] of cases) {
    assert.match(errorOf(render(replaced(name, body))), expected, `${name}: ${body}`);
  }
});

test('an activation key that is also protected is reported', () => {
  const e = errorOf(render(replaced('activation', '{"taste": "replay", "canon": "auto"}')));
  assert.match(e, /protocol:activation: canon is also a protected key/u);
});

test('an unknown block name is reported', () => {
  const e = errorOf(render([...blocks(), ['bar', '{}']]));
  assert.match(e, /protocol:bar: unknown block/u);
});

test('an unclosed block is reported', () => {
  const e = errorOf(`${render(blocks())}\n\`\`\`json protocol:bars\n{}\n`);
  assert.match(e, /protocol:bars: unclosed block \(line \d+\)/u);
});

test('every problem is reported in one error', () => {
  const list = replaced('merge', '{').filter(([n]) => n !== 'limits' && n !== 'negations');
  const e = errorOf(render(list, 'no version'));
  for (const expected of [/Protocol version/u, /protocol:limits: missing block/u, /protocol:negations: missing block/u, /protocol:merge: invalid JSON/u]) {
    assert.match(e, expected);
  }
});

function file(name: string, text: string): { name: string; bytes: Buffer } {
  return { name, bytes: Buffer.from(text, 'utf8') };
}

const BUNDLE = [file('PROTOCOL.md', 'Protocol version: 1.0\n'), file('families.json', '{"a":1}\n'), file('judges.json', '[]\n')];

test('BUNDLE_FILES names the protocol bundle in order', () => {
  assert.deepEqual([...BUNDLE_FILES], ['PROTOCOL.md', 'families.json', 'judges.json']);
});

test('protocolBundleHash frames each file as name, NUL, decimal length, NUL, bytes', () => {
  const h = createHash('sha256');
  for (const f of BUNDLE) {
    h.update(Buffer.concat([Buffer.from(f.name, 'utf8'), Buffer.from([0]), Buffer.from(String(f.bytes.length), 'utf8'), Buffer.from([0]), f.bytes]));
  }
  assert.equal(protocolBundleHash(BUNDLE), h.digest('hex'));
  assert.match(protocolBundleHash(BUNDLE), /^[0-9a-f]{64}$/u);
  assert.equal(protocolBundleHash([]), createHash('sha256').digest('hex'));
});

test('protocolBundleHash changes when any byte, name or the order changes', () => {
  const base = protocolBundleHash(BUNDLE);
  for (const [i, f] of BUNDLE.entries()) {
    for (let j = 0; j < f.bytes.length; j += 1) {
      const bytes = Buffer.from(f.bytes);
      bytes[j] = (bytes[j] ?? 0) ^ 1;
      const changed = BUNDLE.map((g, k) => (k === i ? { name: g.name, bytes } : g));
      assert.notEqual(protocolBundleHash(changed), base, `${f.name} byte ${j}`);
    }
    const renamed = BUNDLE.map((g, k) => (k === i ? { name: `${g.name}x`, bytes: g.bytes } : g));
    assert.notEqual(protocolBundleHash(renamed), base, `${f.name} renamed`);
  }
  assert.notEqual(protocolBundleHash([...BUNDLE].reverse()), base);
});

test('length framing separates inputs that collide under naive concatenation', () => {
  const a = [file('a', 'bc')];
  const b = [file('ab', 'c')];
  const c = [file('A', 'x\u0000B\u0000y')];
  const d = [file('A', 'x'), file('B', 'y')];
  const naive = (files: ReadonlyArray<{ name: string; bytes: Buffer }>): string => {
    const h = createHash('sha256');
    for (const f of files) h.update(Buffer.concat([Buffer.from(f.name, 'utf8'), Buffer.from([0]), f.bytes, Buffer.from([0])]));
    return h.digest('hex');
  };
  const concat = (files: ReadonlyArray<{ name: string; bytes: Buffer }>): string => {
    const h = createHash('sha256');
    for (const f of files) h.update(Buffer.concat([Buffer.from(f.name, 'utf8'), f.bytes]));
    return h.digest('hex');
  };
  assert.equal(concat(a), concat(b));
  assert.notEqual(protocolBundleHash(a), protocolBundleHash(b));
  assert.equal(naive(c), naive(d));
  assert.notEqual(protocolBundleHash(c), protocolBundleHash(d));
});

test('protocolBundleHash rejects a name containing NUL', () => {
  assert.throws(() => protocolBundleHash([file('a\u0000b', 'x')]), RangeError);
});

test('a negation exception that contains no negation marker is rejected', () => {
  const e = errorOf(render(replaced('negation-exceptions', '["不久", "今天"]')));
  assert.match(e, /protocol:negation-exceptions: "今天" contains no negation marker/u);
});
