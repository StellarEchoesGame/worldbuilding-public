import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isRecord, readRecord, type JsonRecord } from './json.ts';
import { loadSchema, type Schema } from './schema.ts';
import {
  DEFAULT_ACTIVATION,
  DEFAULT_HOLD_ROUNDS,
  MAINTAINER_KEYS,
  META_KEYS,
  PROTECTED_KEYS,
  validateBenchmark,
  type Activation,
  type BenchContext,
  type RollbackEntry,
} from './bench-validate.ts';

function readJsonFile(rel: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
  return parsed;
}

function loadBenchSchema(): Schema {
  const r = loadSchema(readJsonFile('../schema/benchmark.schema.json'));
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const schema = loadBenchSchema();

function v0(): JsonRecord {
  const file = readJsonFile('../benchmark/v0.json');
  if (!isRecord(file)) throw new Error('benchmark/v0.json must be an object');
  return file;
}

function ctx(over: { currentRound?: number; rollbacks?: RollbackEntry[] } = {}): BenchContext {
  return {
    schema,
    activation: { ...DEFAULT_ACTIVATION },
    protectedKeys: [...PROTECTED_KEYS],
    currentRound: over.currentRound ?? 1,
    rollbacks: over.rollbacks ?? [],
    holdRounds: DEFAULT_HOLD_ROUNDS,
  };
}

/** A parent version with bar 7 and a child that points at it with no changes yet. */
function family(bar = 7): { parent: JsonRecord; child: JsonRecord } {
  const parent: JsonRecord = { ...v0(), version: 'v1', parent: null, bars: { beats_champion_four_families: bar } };
  const child: JsonRecord = { ...structuredClone(parent), version: 'v2', parent: 'v1', author: { kind: 'maintainer', model: 'm' }, reasons: [] };
  return { parent, child };
}

const EVIDENCE = ['E-R03-taste-1'];

function reason(keys: string[], evidence: string[] = EVIDENCE): JsonRecord {
  return { change: 'adjust', evidence_ids: evidence, expected_effect: 'better separation', keys };
}

test('constants match the documented maintainer, meta and protected keys', () => {
  assert.deepEqual(MAINTAINER_KEYS, ['taste', 'measures', 'cliche_list', 'interface_checklist_extra', 'decoy_recipe', 'baseline_rebuilds', 'bars']);
  assert.deepEqual(DEFAULT_ACTIVATION, {
    taste: 'replay',
    measures: 'auto',
    cliche_list: 'auto',
    interface_checklist_extra: 'auto',
    decoy_recipe: 'owner',
    baseline_rebuilds: 'owner',
    bars: 'auto',
  });
  assert.deepEqual(META_KEYS, ['version', 'parent', 'created_at', 'author', 'reasons']);
  assert.deepEqual(PROTECTED_KEYS, [
    'gate', 'forbidden_words', 'defect_list', 'facts', 'fact_status', 'regression', 'sealing', 'anonymization', 'session_pairs',
    'eligibility', 'void_rules', 'agreement', 'mergecheck', 'owner_rules', 'champions', 'writers', 'canon',
  ]);
  assert.equal(DEFAULT_HOLD_ROUNDS, 3);
});

test('the schema lists every top-level key and the reasons key enum equals the maintainer keys', () => {
  assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [...MAINTAINER_KEYS, ...META_KEYS].sort());
  const reasonItem = schema.properties?.['reasons']?.items;
  assert.ok(reasonItem?.required?.includes('keys'));
  assert.deepEqual(reasonItem?.properties?.['keys']?.items?.enum, [...MAINTAINER_KEYS]);
});

test('benchmark/v0.json is valid as a first version', () => {
  const verdict = validateBenchmark(v0(), null, ctx());
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.ok, true);
});

test('bench validate applies the engine parse rules: a taste.template breaking the slot rules is an error', () => {
  const candidate = v0();
  const taste = readRecord(candidate, 'taste');
  assert.ok(taste !== null);
  candidate['taste'] = { ...taste, template: '{TEXT_1}{TEXT_2}{QUESTIONS}' };
  const verdict = validateBenchmark(candidate, null, ctx());
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.includes('benchmark: taste.template: slot {DECOY_PAIR} must occur exactly once, found 0'), verdict.errors.join('\n'));
});

for (const key of PROTECTED_KEYS) {
  test(`protected key ${key} is rejected`, () => {
    const { parent, child } = family();
    child[key] = { anything: true };
    const verdict = validateBenchmark(child, parent, ctx());
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.includes(`protected key ${key}`), verdict.errors.join('\n'));
    assert.ok(!verdict.errors.some((e) => e.includes(`unexpected property ${key}`)), 'no duplicate schema message');
  });
}

test('an unknown non-protected top-level key is a schema error', () => {
  const { parent, child } = family();
  child['notes'] = 'x';
  const verdict = validateBenchmark(child, parent, ctx());
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.includes('$: unexpected property notes'));
});

test('a reason without keys fails the schema', () => {
  const { parent, child } = family();
  child['cliche_list'] = ['星辰大海'];
  child['reasons'] = [{ change: 'adjust', evidence_ids: EVIDENCE, expected_effect: 'x' }];
  const verdict = validateBenchmark(child, parent, ctx());
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.includes('$.reasons[0]: missing keys'), verdict.errors.join('\n'));
});

test('a reason key outside the maintainer keys fails the schema', () => {
  const { parent, child } = family();
  child['cliche_list'] = ['星辰大海'];
  child['reasons'] = [reason(['cliche_list', 'gate'])];
  const verdict = validateBenchmark(child, parent, ctx());
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => e.startsWith('$.reasons[0].keys[1]: not one of')), verdict.errors.join('\n'));
});

test('a non-object candidate is rejected', () => {
  const verdict = validateBenchmark([], null, ctx());
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.changedKeys, []);
  assert.equal(verdict.activation, null);
});

test('a loosened bar (8 → 7) is rejected even with evidence', () => {
  const { parent, child } = family(8);
  child['bars'] = { beats_champion_four_families: 7 };
  child['reasons'] = [reason(['bars'])];
  const verdict = validateBenchmark(child, parent, ctx());
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.includes('bars.beats_champion_four_families may not decrease (8 → 7)'), verdict.errors.join('\n'));
  assert.equal(verdict.activation, null);
});

test('a tightened bar (7 → 8) with evidence is accepted as auto', () => {
  const { parent, child } = family(7);
  child['bars'] = { beats_champion_four_families: 8 };
  child['reasons'] = [reason(['bars'])];
  const verdict = validateBenchmark(child, parent, ctx());
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.changedKeys, ['bars']);
  assert.equal(verdict.activation, 'auto');
  assert.equal(verdict.noChange, false);
});

test('a change without any reason is rejected', () => {
  const { parent, child } = family();
  child['cliche_list'] = ['星辰大海'];
  const verdict = validateBenchmark(child, parent, ctx());
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.includes('changed key cliche_list has no reason with evidence'), verdict.errors.join('\n'));
});

test('a reason that lists the key but cites no evidence is rejected', () => {
  const { parent, child } = family();
  child['cliche_list'] = ['星辰大海'];
  child['reasons'] = [reason(['cliche_list'], [])];
  const verdict = validateBenchmark(child, parent, ctx());
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.includes('changed key cliche_list has no reason with evidence'));
});

test('a reason citing evidence but not listing the changed key is rejected', () => {
  const { parent, child } = family();
  child['cliche_list'] = ['星辰大海'];
  child['interface_checklist_extra'] = ['能否画成一张图'];
  child['reasons'] = [reason(['interface_checklist_extra']), reason(['cliche_list'], [])];
  const verdict = validateBenchmark(child, parent, ctx());
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.errors, ['changed key cliche_list has no reason with evidence']);
  assert.deepEqual(verdict.changedKeys, ['cliche_list', 'interface_checklist_extra']);
});

test('candidate.parent must equal parent.version', () => {
  const { parent, child } = family();
  child['cliche_list'] = ['星辰大海'];
  child['reasons'] = [reason(['cliche_list'])];
  child['parent'] = 'v0';
  const verdict = validateBenchmark(child, parent, ctx());
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.includes('parent must be v1, got v0'), verdict.errors.join('\n'));
});

test('a parent without a version string cannot be linked', () => {
  const { parent, child } = family();
  delete parent['version'];
  child['cliche_list'] = ['星辰大海'];
  child['reasons'] = [reason(['cliche_list'])];
  const verdict = validateBenchmark(child, parent, ctx());
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.includes('parent has no version'), verdict.errors.join('\n'));
});

test('v1 without evidence is accepted as a root version and needs the owner', () => {
  const candidate: JsonRecord = { ...v0(), version: 'v1', parent: null, author: { kind: 'owner', model: null }, reasons: [] };
  const verdict = validateBenchmark(candidate, null, ctx());
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.changedKeys, [...MAINTAINER_KEYS]);
  assert.equal(verdict.activation, 'owner');
});

test('a candidate that names a parent cannot be validated without the parent benchmark', () => {
  const candidate: JsonRecord = { ...v0(), version: 'v2', parent: 'v1', author: { kind: 'maintainer', model: 'm' }, reasons: [] };
  const verdict = validateBenchmark(candidate, null, ctx());
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.errors, ['candidate names parent v1; the parent benchmark is required']);
  assert.equal(verdict.activation, null);
  const evidenced: JsonRecord = { ...candidate, reasons: [reason([...MAINTAINER_KEYS])] };
  assert.deepEqual(validateBenchmark(evidenced, null, ctx()).errors, ['candidate names parent v1; the parent benchmark is required']);
});

test('a root candidate given a parent benchmark must still link to it', () => {
  const { parent, child } = family();
  child['parent'] = null;
  child['cliche_list'] = ['星辰大海'];
  child['reasons'] = [reason(['cliche_list'])];
  const verdict = validateBenchmark(child, parent, ctx());
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.includes('parent must be v1, got null'), verdict.errors.join('\n'));
});

test('a taste change needs a replay', () => {
  const { parent, child } = family();
  const taste = readRecord(child, 'taste');
  assert.ok(taste);
  child['taste'] = { ...taste, min_quote_chars: 10 };
  child['reasons'] = [reason(['taste'])];
  const verdict = validateBenchmark(child, parent, ctx());
  assert.deepEqual(verdict.errors, []);
  assert.deepEqual(verdict.changedKeys, ['taste']);
  assert.equal(verdict.activation, 'replay');
});

test('a decoy_recipe change needs the owner, and the strongest class wins', () => {
  const { parent, child } = family();
  child['decoy_recipe'] = { details: 6, instructions: '换掉更多细节。' };
  child['cliche_list'] = ['星辰大海'];
  const taste = readRecord(child, 'taste');
  assert.ok(taste);
  child['taste'] = { ...taste, min_quote_chars: 10 };
  child['reasons'] = [reason(['decoy_recipe', 'cliche_list', 'taste'])];
  const verdict = validateBenchmark(child, parent, ctx());
  assert.deepEqual(verdict.errors, []);
  assert.deepEqual(verdict.changedKeys, ['taste', 'cliche_list', 'decoy_recipe']);
  assert.equal(verdict.activation, 'owner');
});

test('a cliche_list change inside the rollback hold needs the owner, after the hold it is auto', () => {
  const rollbacks: RollbackEntry[] = [{ round: 5, rolledBackKeys: ['cliche_list'] }];
  const { parent, child } = family();
  child['cliche_list'] = ['星辰大海'];
  child['reasons'] = [reason(['cliche_list'])];
  const inside = validateBenchmark(child, parent, ctx({ currentRound: 7, rollbacks }));
  assert.equal(inside.ok, true);
  assert.equal(inside.activation, 'owner');
  const after = validateBenchmark(child, parent, ctx({ currentRound: 8, rollbacks }));
  assert.equal(after.ok, true);
  assert.equal(after.activation, 'auto');
  const otherKey = validateBenchmark(child, parent, ctx({ currentRound: 6, rollbacks: [{ round: 5, rolledBackKeys: ['measures'] }] }));
  assert.equal(otherKey.activation, 'auto');
});

test('key order inside objects does not count as a change', () => {
  const { parent, child } = family();
  const recipe = readRecord(parent, 'decoy_recipe');
  assert.ok(recipe);
  child['decoy_recipe'] = { instructions: recipe['instructions'], details: recipe['details'] };
  const verdict = validateBenchmark(child, parent, ctx());
  assert.equal(verdict.noChange, true);
});

test('array order and an added optional key do count as changes', () => {
  const { parent, child } = family();
  parent['cliche_list'] = ['甲', '乙'];
  child['cliche_list'] = ['乙', '甲'];
  child['measures'] = { hook: { active: true } };
  child['reasons'] = [reason(['cliche_list', 'measures'])];
  const verdict = validateBenchmark(child, parent, ctx());
  assert.deepEqual(verdict.changedKeys, ['measures', 'cliche_list']);
  assert.equal(verdict.ok, true);
});

test('an identical candidate is a no-change verdict', () => {
  const { parent, child } = family();
  const bumped = validateBenchmark(child, parent, ctx());
  assert.deepEqual(bumped, { ok: true, errors: [], changedKeys: [], activation: null, noChange: true });
  const same = validateBenchmark(structuredClone(parent), parent, ctx());
  assert.deepEqual(same, { ok: true, errors: [], changedKeys: [], activation: null, noChange: true });
});

test('a no-change candidate with a schema error is still rejected', () => {
  const { parent, child } = family();
  child['gate'] = {};
  const verdict = validateBenchmark(child, parent, ctx());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.noChange, true);
  assert.deepEqual(verdict.errors, ['protected key gate']);
});

test('activation classes come from the context', () => {
  const { parent, child } = family();
  child['cliche_list'] = ['星辰大海'];
  child['reasons'] = [reason(['cliche_list'])];
  const custom: BenchContext = { ...ctx(), activation: { ...DEFAULT_ACTIVATION, cliche_list: 'replay' } };
  assert.equal(validateBenchmark(child, parent, custom).activation, 'replay');
});

test('every maintainer key is compared even when the activation map omits it, and then has no class', () => {
  const { parent, child } = family();
  child['measures'] = { hook: { active: true } };
  child['reasons'] = [reason(['measures'])];
  const activation: Record<string, Activation> = { ...DEFAULT_ACTIVATION };
  delete activation['measures'];
  const verdict = validateBenchmark(child, parent, { ...ctx(), activation });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.noChange, false);
  assert.deepEqual(verdict.changedKeys, ['measures']);
  assert.deepEqual(verdict.errors, ['no activation class for measures']);
  assert.equal(verdict.activation, null);
  const unchanged = validateBenchmark(structuredClone(parent), parent, { ...ctx(), activation: { taste: 'replay' } });
  assert.equal(unchanged.noChange, true);
  assert.deepEqual(unchanged.errors, []);
});

test('reasons are read defensively when the schema is looser than expected', () => {
  const loose: BenchContext = { ...ctx(), schema: { type: 'object' } };
  const { parent, child } = family();
  child['cliche_list'] = ['星辰大海'];
  child['reasons'] = [{ keys: 'cliche_list', evidence_ids: EVIDENCE }, 'junk'];
  const verdict = validateBenchmark(child, parent, loose);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.errors, ['changed key cliche_list has no reason with evidence']);
});
