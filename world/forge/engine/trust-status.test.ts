import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAMILIES, type Family, type JudgeSpec } from './config.ts';
import { isRecord, readRecord } from './json.ts';
import type { ProtocolCalibration } from './protocol.ts';
import { loadSchema, validate } from './schema.ts';
import { DEFAULT_FIXTURE, fixtureWorld } from './testing/fixture-world.ts';
import {
  MIN_QUALIFIED_FAMILIES,
  parseTrustStatus,
  readCanaryFailed,
  readTrustStatus,
  trustPins,
  type FamilyTrust,
  type TrustStatus,
} from './trust-status.ts';

const SCHEMA_PATH = new URL('../schema/calib-status.schema.json', import.meta.url);

/** The protocol:calibration block as merged in P0. */
const CAL: ProtocolCalibration = {
  categories: ['canon_vs_rewrite', 'cross_model', 'stance', 'known'],
  pairsPerCategory: 6,
  retestPairs: 4,
  visibleRound0: 12,
  qualifyNonknownPct: 72,
  qualifyKnownMaxMiss: 1,
  requal: { nonknown: 9, nonknownMin: 8, known: 3, knownMin: 3 },
  gateDryrunMaxMiss: 1,
  intervalZ: 1.6448536269514722,
  agreement: { threshold: 0.6, flagN: 12, flagP: 0.8, suspendN: 24, suspendP: 0.95 },
  auditVisible: 2,
  replayMaxPairs: 16,
  replayMinPairs: 4,
};

function judge(id: string, family: Family): JudgeSpec {
  return { id, family, cli: 'codex', model: `${id}-model`, effort: 'max', concurrency: 3, acceptedServed: [] };
}

/** judges.json order. */
const JUDGES: readonly JudgeSpec[] = [judge('codex', 'OpenAI'), judge('claude', 'Anthropic'), judge('kimi', 'Moonshot'), judge('grok', 'xAI')];

function family(over: { qualified?: boolean; gate?: boolean; n?: number; k?: number; pBelow?: number; state?: FamilyTrust['agreement']['state'] } = {}): FamilyTrust {
  const qualified = over.qualified ?? true;
  const gate = over.gate ?? true;
  const n = over.n ?? 12;
  const k = over.k ?? 11;
  const state = over.state ?? 'ok';
  return {
    qualified,
    qualified_by: qualified ? 'C00' : null,
    requal_used: { calibration_fail: false, suspension: false },
    gate_judge: gate,
    gate_by: gate ? 'C00' : null,
    agreement: {
      epoch: 'C00',
      n,
      k,
      alpha: 1 + k,
      beta: 1 + n - k,
      mean: Math.round(((1 + k) / (2 + n)) * 10_000) / 10_000,
      ci90: [0.2, 0.9],
      p_below: over.pBelow ?? 0.01,
      state,
    },
    suspended_at: state === 'suspended' ? 'R03' : null,
  };
}

function status(families: Partial<Record<Family, FamilyTrust>>): TrustStatus {
  const out: Record<string, FamilyTrust> = {};
  for (const [f, t] of Object.entries(families)) if (t !== undefined) out[f] = t;
  return { schema: 'trust-status/1', updated_after: 'R02', labels_sha256: 'a'.repeat(64), families: out };
}

const ALL_OK = status({ OpenAI: family(), Anthropic: family(), Moonshot: family(), xAI: family() });

function plain(value: unknown): unknown {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return parsed;
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-trust-status-'));
  mkdirSync(join(root, 'calibration'), { recursive: true });
  mkdirSync(join(root, 'canary'), { recursive: true });
  return root;
}

test('calib-status schema lists every family with one identical per-family schema', () => {
  const raw: unknown = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  assert.ok(loadSchema(raw).ok);
  const props = readRecord(readRecord(readRecord(raw, 'properties'), 'families'), 'properties');
  assert.ok(props !== null);
  assert.deepEqual(Object.keys(props), [...FAMILIES]);
  const first = JSON.stringify(props['DeepSeek']);
  for (const f of FAMILIES) assert.equal(JSON.stringify(props[f]), first, f);
});

test('the fixture-world trust status validates against the schema and parses', () => {
  const w = fixtureWorld(mkdtempSync(join(tmpdir(), 'forge-trust-fixture-')), DEFAULT_FIXTURE);
  const raw: unknown = JSON.parse(readFileSync(join(w.root, 'calibration', 'status.json'), 'utf8'));
  const schema = loadSchema(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));
  assert.ok(schema.ok);
  assert.deepEqual(validate(schema.value, raw), []);
  const read = readTrustStatus(w.root);
  assert.ok(read !== null && read.ok, read === null ? 'absent' : read.ok ? '' : read.error);
  assert.deepEqual(Object.keys(read.value.families).sort(), ['Anthropic', 'Moonshot', 'OpenAI', 'xAI']);
  const canary = readCanaryFailed(w.root);
  assert.ok(canary.ok);
  assert.equal(canary.value.size, 0);
  const none = fixtureWorld(mkdtempSync(join(tmpdir(), 'forge-trust-fixture-')), { ...DEFAULT_FIXTURE, trust: 'none' });
  assert.equal(readTrustStatus(none.root), null);
});

test('parseTrustStatus round-trips a status and validates it against the schema', () => {
  const s = status({ OpenAI: family(), xAI: family({ qualified: false, n: 12, k: 0, pBelow: 0.99 }), Moonshot: family({ state: 'suspended', n: 24, k: 9, pBelow: 0.97 }) });
  const parsed = parseTrustStatus(plain(s));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  assert.deepEqual(parsed.value, s);
});

test('parseTrustStatus rejects shapes and inconsistent numbers', () => {
  const ok = plain(ALL_OK);
  assert.ok(isRecord(ok));
  const withFamily = (f: string, t: unknown): unknown => plain({ ...ALL_OK, families: { ...ALL_OK.families, [f]: t } });
  const base = family();
  const bad: Array<[string, unknown]> = [
    ['schema version', { ...ok, schema: 'trust-status/2' }],
    ['extra key', { ...ok, note: 'x' }],
    ['labels hash', { ...ok, labels_sha256: 'xyz' }],
    ['unknown family', withFamily('Gemini', base)],
    ['k > n', withFamily('xAI', { ...base, agreement: { ...base.agreement, k: 13, alpha: 14, beta: 0 } })],
    ['alpha mismatch', withFamily('xAI', { ...base, agreement: { ...base.agreement, alpha: 11 } })],
    ['mean mismatch', withFamily('xAI', { ...base, agreement: { ...base.agreement, mean: 0.5 } })],
    ['ci90 unordered', withFamily('xAI', { ...base, agreement: { ...base.agreement, ci90: [0.9, 0.2] } })],
    ['ci90 length', withFamily('xAI', { ...base, agreement: { ...base.agreement, ci90: [0.2] } })],
    ['p_below > 1', withFamily('xAI', { ...base, agreement: { ...base.agreement, p_below: 1.2 } })],
    ['unknown state', withFamily('xAI', { ...base, agreement: { ...base.agreement, state: 'warned' } })],
    ['qualified without qualified_by', withFamily('xAI', { ...base, qualified_by: null })],
    ['gate judge without gate_by', withFamily('xAI', { ...base, gate_by: null })],
    ['suspended without suspended_at', withFamily('xAI', { ...base, agreement: { ...base.agreement, state: 'suspended' } })],
    ['missing requal_used key', withFamily('xAI', { ...base, requal_used: { calibration_fail: false } })],
    ['not an object', 'status'],
  ];
  for (const [name, value] of bad) assert.equal(parseTrustStatus(value).ok, false, name);
});

test('readTrustStatus: absent → null, bad JSON or shape → err', () => {
  const root = tempRoot();
  assert.equal(readTrustStatus(root), null);
  writeFileSync(join(root, 'calibration', 'status.json'), '{"schema":');
  assert.equal(readTrustStatus(root)?.ok, false);
  writeFileSync(join(root, 'calibration', 'status.json'), '{"schema":"trust-status/1"}\n');
  const bad = readTrustStatus(root);
  assert.ok(bad !== null && !bad.ok);
  assert.match(bad.error, /^calibration\/status\.json: /u);
  writeFileSync(join(root, 'calibration', 'status.json'), `${JSON.stringify(ALL_OK, null, 2)}\n`);
  assert.deepEqual(readTrustStatus(root), { ok: true, value: ALL_OK });
});

test('readCanaryFailed keeps the latest result per judge id', () => {
  const root = tempRoot();
  assert.deepEqual(readCanaryFailed(root), { ok: true, value: new Set() });
  const entry = (id: string, pass: boolean, at: string): unknown => ({ id, family: 'OpenAI', model: 'm', pass, reasons: [], at, token_sha256: 'a', prompt_sha256: 'b' });
  const results = {
    pass: false,
    adapters: [entry('codex', false, '2026-09-25T10:00:00.000Z'), entry('grok', false, '2026-09-25T10:00:00.000Z'), entry('codex', true, '2026-09-25T09:00:00.000Z'), entry('kimi', true, '2026-09-25T10:00:00.000Z'), entry('kimi', false, '2026-09-24T10:00:00.000Z')],
  };
  writeFileSync(join(root, 'canary', 'results.json'), JSON.stringify(results));
  assert.deepEqual(readCanaryFailed(root), { ok: true, value: new Set(['codex', 'grok']) });
  writeFileSync(join(root, 'canary', 'results.json'), JSON.stringify({ pass: true, adapters: [{ id: 'codex' }] }));
  assert.equal(readCanaryFailed(root).ok, false);
  writeFileSync(join(root, 'canary', 'results.json'), JSON.stringify({ pass: true, adapters: [{ id: 'codex', pass: false }] }));
  assert.equal(readCanaryFailed(root).ok, false, 'an entry without at is rejected, not treated as the oldest');
  writeFileSync(join(root, 'canary', 'results.json'), '[');
  assert.equal(readCanaryFailed(root).ok, false);
});

const NO_CANARY: ReadonlySet<string> = new Set();

test('trustPins: P round without status → every judge family ok, eligible and gate (judges.json order)', () => {
  assert.deepEqual(trustPins(null, 'P02', JUDGES, NO_CANARY, CAL), {
    ok: true,
    value: {
      eligibleFamilies: ['OpenAI', 'Anthropic', 'Moonshot', 'xAI'],
      flags: { OpenAI: 'ok', Anthropic: 'ok', Moonshot: 'ok', xAI: 'ok' },
      gateFamilies: ['OpenAI', 'Anthropic', 'Moonshot', 'xAI'],
    },
  });
  const canary = trustPins(null, 'P02', JUDGES, new Set(['grok']), CAL);
  assert.ok(canary.ok);
  assert.deepEqual(canary.value.eligibleFamilies, ['OpenAI', 'Anthropic', 'Moonshot']);
  assert.deepEqual(canary.value.gateFamilies, ['OpenAI', 'Anthropic', 'Moonshot']);
});

test('trustPins: R round without status, or with fewer than 3 qualified unsuspended families → err', () => {
  const missing = trustPins(null, 'R01', JUDGES, NO_CANARY, CAL);
  assert.ok(!missing.ok);
  assert.match(missing.error, /calibration\/status\.json missing/u);
  const two = status({ OpenAI: family(), Anthropic: family(), Moonshot: family({ qualified: false }), xAI: family({ qualified: false }) });
  const refused = trustPins(two, 'R01', JUDGES, NO_CANARY, CAL);
  assert.ok(!refused.ok);
  assert.match(refused.error, /only 2 qualified unsuspended judge families \(OpenAI, Anthropic\); R rounds need 3/u);
  assert.equal(MIN_QUALIFIED_FAMILIES, 3);
  const suspended = status({ OpenAI: family(), Anthropic: family(), Moonshot: family({ state: 'suspended', n: 24, k: 8, pBelow: 0.99 }), xAI: family({ qualified: false }) });
  assert.equal(trustPins(suspended, 'R02', JUDGES, NO_CANARY, CAL).ok, false, 'a suspended family does not count');
  assert.equal(trustPins(two, 'P03', JUDGES, NO_CANARY, CAL).ok, true, 'P rounds have no minimum');
  assert.equal(trustPins(ALL_OK, 'C00', JUDGES, NO_CANARY, CAL).ok, false);
  assert.equal(trustPins(ALL_OK, 'R1', JUDGES, NO_CANARY, CAL).ok, false);
});

test('trustPins: unqualified and flagged families leave E but stay gate judges; suspended and canary failures leave both', () => {
  const s = status({
    OpenAI: family(),
    Anthropic: family({ n: 12, k: 5, pBelow: 0.9023, state: 'flagged' }),
    Moonshot: family(),
    xAI: family({ qualified: false, n: 12, k: 0, pBelow: 0.99 }),
  });
  assert.deepEqual(trustPins(s, 'R01', JUDGES, NO_CANARY, CAL), {
    ok: true,
    value: {
      eligibleFamilies: ['OpenAI', 'Moonshot'],
      flags: { OpenAI: 'ok', Anthropic: 'flagged', Moonshot: 'ok', xAI: 'unqualified' },
      gateFamilies: ['OpenAI', 'Anthropic', 'Moonshot', 'xAI'],
    },
  });
  const suspended = status({ ...s.families, Moonshot: family({ state: 'suspended', n: 24, k: 9, pBelow: 0.97 }), xAI: family() });
  const pins = trustPins(suspended, 'R02', JUDGES, new Set(['codex']), CAL);
  assert.ok(pins.ok, pins.ok ? '' : pins.error);
  assert.deepEqual(pins.value.flags, { OpenAI: 'ok', Anthropic: 'flagged', Moonshot: 'suspended', xAI: 'ok' });
  assert.deepEqual(pins.value.eligibleFamilies, ['xAI']);
  assert.deepEqual(pins.value.gateFamilies, ['Anthropic', 'xAI']);
});

test('trustPins: suspended outranks unqualified; a judge family absent from the status is unqualified and no gate judge', () => {
  const s = status({ OpenAI: family(), Anthropic: family(), Moonshot: family(), xAI: family({ qualified: false, state: 'suspended', n: 24, k: 2, pBelow: 0.99 }) });
  const pins = trustPins(s, 'R01', [...JUDGES, judge('glm', 'Zhipu')], NO_CANARY, CAL);
  assert.ok(pins.ok);
  assert.equal(pins.value.flags['xAI'], 'suspended');
  assert.equal(pins.value.flags['Zhipu'], 'unqualified');
  assert.deepEqual(pins.value.gateFamilies, ['OpenAI', 'Anthropic', 'Moonshot']);
});

test('trustPins: flag and suspend lines come from protocol:calibration, suspension stays sticky', () => {
  const s = status({
    OpenAI: family(),
    Anthropic: family({ n: 12, k: 5, pBelow: 0.85, state: 'flagged' }),
    Moonshot: family({ n: 24, k: 10, pBelow: 0.9656 }),
    xAI: family({ n: 30, k: 25, pBelow: 0.01, state: 'suspended' }),
  });
  const strict = trustPins(s, 'P04', JUDGES, NO_CANARY, CAL);
  assert.ok(strict.ok);
  assert.deepEqual(strict.value.flags, { OpenAI: 'ok', Anthropic: 'flagged', Moonshot: 'suspended', xAI: 'suspended' });
  assert.equal(trustPins(s, 'R04', JUDGES, NO_CANARY, CAL).ok, false, 'two suspensions leave 2 qualified');
  const loose: ProtocolCalibration = { ...CAL, agreement: { ...CAL.agreement, flagP: 0.9, suspendP: 0.97 } };
  const relaxed = trustPins(s, 'P04', JUDGES, NO_CANARY, loose);
  assert.ok(relaxed.ok);
  assert.deepEqual(relaxed.value.flags, { OpenAI: 'ok', Anthropic: 'ok', Moonshot: 'flagged', xAI: 'suspended' });
  assert.deepEqual(relaxed.value.eligibleFamilies, ['OpenAI', 'Anthropic']);
  assert.equal(trustPins(s, 'R04', JUDGES, NO_CANARY, loose).ok, true, 'under the looser lines 3 qualified families remain');
});
