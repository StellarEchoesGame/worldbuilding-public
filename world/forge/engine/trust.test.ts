import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fakeBackend } from './adapters/fake.ts';
import { calibPaths, type CalibSetRecord, type SetKind } from './calib-build.ts';
import { calibTaskId, verdictPath, type CalibOrder, type VerdictRecord } from './calib-run.ts';
import { agreementState, posterior } from './calib-stats.ts';
import type { CalibReport, FamilyReport } from './calib-score.ts';
import { FAMILIES, loadConfig, type Family, type JudgeSpec } from './config.ts';
import { buildContext, type RoundBackends, type StepContext } from './context.ts';
import type { CalibAnswer } from './owner-inputs.ts';
import { tasteCallPath, type FamilySessions, type Order, type SessionCall } from './pairs.ts';
import type { ProtocolCalibration } from './protocol.ts';
import { isRecord, readRecord } from './json.ts';
import type { AuditSetFile } from './steps/owner-waits.ts';
import { roundPaths, sha256 } from './store.ts';
import { fakePorts } from './testing/fakes.ts';
import { DEFAULT_FIXTURE, fixtureWorld } from './testing/fixture-world.ts';
import { ownerSim, type OwnerSim } from './testing/owner-sim.ts';
import { parseTrustStatus, readTrustStatus, type TrustStatus } from './trust-status.ts';
import {
  buildLedger, calibTrial, computeStatus, LABELS_FILE, parseLabelLedger, readLabelLedger, rebuildTrust, reserveLabels, trialOf, updateTrust, visibleLabels,
  type CalibLabelSource, type Label, type LabelLedger, type RoundLabelSource,
} from './trust.ts';

const CAL: ProtocolCalibration = {
  categories: ['canon_vs_rewrite', 'cross_model', 'stance', 'known'], pairsPerCategory: 6, retestPairs: 4, visibleRound0: 12,
  qualifyNonknownPct: 72, qualifyKnownMaxMiss: 1, requal: { nonknown: 9, nonknownMin: 8, known: 3, knownMin: 3 }, gateDryrunMaxMiss: 1,
  intervalZ: 1.6448536269514722, agreement: { threshold: 0.6, flagN: 12, flagP: 0.8, suspendN: 24, suspendP: 0.95 }, auditVisible: 2, replayMaxPairs: 16, replayMinPairs: 4,
};
const ORDERS: readonly CalibOrder[] = ['ab', 'ba'];
const AT = '2026-10-01T00:00:00.000Z';
/** Distinct per-text bytes: a shared sha256 would make reserve labels collide with visible ones (reserveLabels). */
const HEX_DIGITS = '0123456789abcdef';
const HEX = (c: string): string => c.repeat(64);

function call(decisive: string | null, opts: { order?: 'fwd' | 'rev'; decoy?: boolean } = {}): SessionCall {
  const order = opts.order ?? 'fwd';
  return { taskId: `taste-W1-xAI-s0-${order}`, order, status: decisive === null ? 'void' : 'ok', decisive, preferredDecoy: opts.decoy ?? false };
}

/** One family's final sessions: each entry is [fwd decisive, rev decisive] (null = void call). */
function sessions(family: Family, picks: ReadonlyArray<[string | null, string | null]>, opts: { shadow?: boolean; dropped?: boolean } = {}): FamilySessions {
  const dropped = opts.dropped === true ? 'void_after_rerun' : null;
  return { family, shadow: opts.shadow ?? false, sessions: picks.map(([f, r]) => [call(f), call(r, { order: 'rev' })]), reruns: [], dropped };
}

function verdict(order: 'ab' | 'ba', decisive: string | null): VerdictRecord {
  const pair = calibRecord('C00', 'round0', 1).pairs[0];
  if (pair === undefined) throw new Error('fixture');
  return calibVerdict(pair, 'xAI', order, decisive);
}

test('trialOf: consistent sessions on the owner text agree; a split session is inconsistent; shadow sessions count; none → null', () => {
  assert.deepEqual(trialOf(sessions('xAI', [['W1', 'W1'], ['W1', 'W1']]), 'W1'), { sessions: 2, consistent: true, agree: true, void: 0 });
  assert.deepEqual(trialOf(sessions('xAI', [['BASE', 'BASE'], ['BASE', 'BASE']]), 'W1'), { sessions: 2, consistent: true, agree: false, void: 0 });
  assert.deepEqual(trialOf(sessions('xAI', [['W1', 'W1'], ['W1', 'BASE']]), 'W1'), { sessions: 2, consistent: false, agree: false, void: 0 });
  assert.deepEqual(trialOf(sessions('xAI', [['W1', 'W1'], ['BASE', 'BASE']]), 'W1'), { sessions: 2, consistent: true, agree: false, void: 0 }, 'sessions on different texts never agree');
  assert.equal(trialOf(sessions('xAI', []), 'W1'), null);
  const shadow = sessions('Moonshot', [['W1', 'W1'], ['W1', 'W1']], { shadow: true });
  assert.deepEqual(trialOf(shadow, 'W1'), { sessions: 2, consistent: true, agree: true, void: 0 }, 'shadow sessions of a flagged family count');
});

test('trialOf: a void session counts and makes agree false (D4), also a decoy preference and a dropped family', () => {
  assert.deepEqual(trialOf(sessions('xAI', [['W1', 'W1'], [null, 'W1']]), 'W1'), { sessions: 2, consistent: false, agree: false, void: 1 });
  const decoy: FamilySessions = { ...sessions('xAI', []), sessions: [[call('W1'), call('W1', { order: 'rev', decoy: true })]] };
  assert.deepEqual(trialOf(decoy, 'W1'), { sessions: 1, consistent: false, agree: false, void: 1 });
  assert.deepEqual(trialOf(sessions('xAI', [['W1', 'W1'], [null, null]], { dropped: true }), 'W1'), { sessions: 2, consistent: false, agree: false, void: 1 });
});

test('calibTrial: one session-pair from the ab / ba verdicts; a void or missing order is a void non-agreement (D5); neither → null', () => {
  assert.deepEqual(calibTrial(verdict('ab', 'C00-T01'), verdict('ba', 'C00-T01'), 'C00-T01'), { sessions: 1, consistent: true, agree: true, void: 0 });
  assert.deepEqual(calibTrial(verdict('ab', 'C00-T01'), verdict('ba', 'C00-T01'), 'C00-T02'), { sessions: 1, consistent: true, agree: false, void: 0 });
  assert.deepEqual(calibTrial(verdict('ab', 'C00-T01'), verdict('ba', 'C00-T02'), 'C00-T01'), { sessions: 1, consistent: false, agree: false, void: 0 });
  assert.deepEqual(calibTrial(verdict('ab', null), verdict('ba', 'C00-T01'), 'C00-T01'), { sessions: 1, consistent: false, agree: false, void: 1 });
  assert.deepEqual(calibTrial(verdict('ab', 'C00-T01'), null, 'C00-T01'), { sessions: 1, consistent: false, agree: false, void: 1 });
  assert.equal(calibTrial(null, null, 'C00-T01'), null);
});

// ---- calibration set fixtures: pair i = (T{2i-1} by OpenAI, T{2i} by DeepSeek); slot n+1 retests pair 1 swapped ----

function calibRecord(set: string, kind: SetKind, n: number): CalibSetRecord {
  const texts: CalibSetRecord['texts'] = {};
  const pairs: CalibSetRecord['pairs'] = [];
  const display: CalibSetRecord['display'] = [];
  for (let i = 1; i <= n; i += 1) {
    const [a, b] = [`${set}-T${String(2 * i - 1).padStart(2, '0')}`, `${set}-T${String(2 * i).padStart(2, '0')}`];
    texts[a] = { path: `texts/${a}.md`, sha256: HEX(HEX_DIGITS[(2 * i - 2) % 16] ?? '0'), role: 'passage', model: null, author_family: 'OpenAI', stance: null, source: null, of: null, call: null };
    texts[b] = { path: `texts/${b}.md`, sha256: HEX(HEX_DIGITS[(2 * i - 1) % 16] ?? '1'), role: 'rewrite', model: 'deepseek-fixture-a', author_family: 'DeepSeek', stance: 'resident-day', source: null, of: null, call: `calibrewrite-${b}` };
    const split = kind === 'round0' ? (i % 2 === 1 ? 'visible' : 'reserve') : 'none';
    pairs.push({ id: `${set}-P${String(i).padStart(2, '0')}`, category: 'cross_model', a, b, known_better: null, authors: ['DeepSeek', 'OpenAI'], split });
    display.push({ slot: i, pair: `${set}-P${String(i).padStart(2, '0')}`, left: a, right: b, retest_of: null });
  }
  const first = display[0];
  if (first !== undefined) display.push({ slot: n + 1, pair: first.pair, left: first.right, right: first.left, retest_of: 1 });
  return { kind, family: kind === 'round0' ? null : 'xAI', reason: kind === 'requal' ? 'calibration_fail' : null, seed: HEX('5'), built_at: AT, size: display.length, texts, pairs, display, dryrun: [] };
}

/** The owner picks text a (left) on every original slot and the left side (text b) on the swapped retest, which never becomes the label. */
function calibAnswers(record: CalibSetRecord): CalibAnswer[] {
  return record.display.map((d) => {
    return { slot: d.slot, pair: d.pair, left: d.left, right: d.right, choice: 'left', chosen: d.left, answered_at: AT, ms: null };
  });
}

function calibVerdict(p: CalibSetRecord['pairs'][number], family: Family, order: CalibOrder, decisive: string | null): VerdictRecord {
  return {
    pair: p.id, family, judge: family.toLowerCase(), order, text1: order === 'ab' ? p.a : p.b, text2: order === 'ab' ? p.b : p.a, status: decisive === null ? 'void' : 'ok',
    decisive, picks: {}, quotes: {}, error: null, call: calibTaskId(p.id, family.toLowerCase(), order), benchmark_version: 'v1',
  };
}

function calibVerdicts(record: CalibSetRecord, families: readonly Family[], pick: (pair: string) => 'a' | 'b'): VerdictRecord[] {
  return record.pairs.flatMap((p) => families.flatMap((f) => ORDERS.map((o) => calibVerdict(p, f, o, pick(p.id) === 'a' ? p.a : p.b))));
}

function calibSource(set: string, kind: SetKind, n: number, families: readonly Family[] = ['Anthropic', 'xAI']): CalibLabelSource {
  const record = calibRecord(set, kind, n);
  return { set, record, answers: calibAnswers(record), verdicts: calibVerdicts(record, families, () => 'a') };
}

// ---- round fixtures: audit pair j = submission W{j} (label A, B, …) vs BASE ----

interface AuditPairFixture {
  owner: 'W' | 'BASE';
  split: 'visible' | 'reserve';
  sessions: FamilySessions[];
}

function roundSource(round: string, pairs: readonly AuditPairFixture[]): RoundLabelSource {
  const labelOf = (j: number): string => String.fromCharCode(65 + j);
  const auditSet: AuditSetFile = {
    round, created_at: AT,
    pairs: pairs.map((p, j) => ({ id: `${round}-audit-${j + 1}`, left: labelOf(j), right: 'BASE', kind: 'champion', split: p.split, label: `${round}-audit-${j + 1}`, pair: `W${j + 1}` })),
  };
  const textOf: Record<string, string> = { BASE: 'BASE' };
  const texts: RoundLabelSource['texts'] = { BASE: { id: 'BASE', path: `rounds/${round}/champion.json`, sha256: HEX('c'), authors: ['OpenAI'] } };
  const sessions: RoundLabelSource['sessions'] = {};
  pairs.forEach((p, j) => {
    textOf[labelOf(j)] = `W${j + 1}`;
    // Distinct bytes per submission, disjoint from the C00 texts (digits 0–7): shared bytes would collide in reserveLabels.
    texts[`W${j + 1}`] = { id: `W${j + 1}`, path: `rounds/${round}/submissions/W${j + 1}.json`, sha256: HEX(HEX_DIGITS[(8 + j) % 16] ?? '8'), authors: ['DeepSeek'] };
    sessions[`W${j + 1}`] = p.sessions;
  });
  const answers = auditSet.pairs.map((a, j) => {
    const choice: 'left' | 'right' = pairs[j]?.owner === 'W' ? 'left' : 'right';
    return { pair: a.id, left: a.left, right: a.right, choice, chosen: choice === 'left' ? a.left : a.right };
  });
  return { round, auditSet, audit: { round, answers, answered_at: AT }, textOf, texts, sessions };
}

/** Two consistent session-pairs on `text`. */
function agreeing(family: Family, text: string, shadow = false): FamilySessions {
  return sessions(family, [[text, text], [text, text]], { shadow });
}

function ledgerOf(result: ReturnType<typeof buildLedger>): LabelLedger {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

test('buildLedger: C00 labels (seq = pair index, pairs.json split), Q labels split none, then audit labels in round order; gate sets add nothing', () => {
  const c00 = calibSource('C00', 'round0', 4);
  const q01 = calibSource('Q01', 'requal', 2, ['xAI']);
  const g01 = calibSource('G01', 'gate', 0);
  const r02 = roundSource('R02', [{ owner: 'BASE', split: 'reserve', sessions: [agreeing('xAI', 'BASE')] }]);
  const r01 = roundSource('R01', [
    { owner: 'W', split: 'visible', sessions: [agreeing('Anthropic', 'W1'), agreeing('Moonshot', 'BASE', true)] },
    { owner: 'BASE', split: 'reserve', sessions: [] },
  ]);
  const ledger = ledgerOf(buildLedger({ calib: [q01, g01, c00], rounds: [r02, r01] }, CAL));
  assert.equal(ledger.schema, 'calib-labels/1');
  assert.deepEqual(ledger.labels.map((l) => [l.id, l.source, l.round, l.seq, l.split, l.use]), [
    ['C00-P01', 'round0', 'C00', 1, 'visible', 'qualification'], ['C00-P02', 'round0', 'C00', 2, 'reserve', 'qualification'],
    ['C00-P03', 'round0', 'C00', 3, 'visible', 'qualification'], ['C00-P04', 'round0', 'C00', 4, 'reserve', 'qualification'],
    ['Q01-P01', 'requal', 'Q01', 1, 'none', 'requal'], ['Q01-P02', 'requal', 'Q01', 2, 'none', 'requal'],
    ['R01-audit-1', 'audit', 'R01', 1, 'visible', 'agreement'], ['R01-audit-2', 'audit', 'R01', 2, 'reserve', 'agreement'],
    ['R02-audit-1', 'audit', 'R02', 1, 'reserve', 'agreement'],
  ]);
  const p1 = ledger.labels[0];
  assert.deepEqual(p1?.texts, [
    { id: 'C00-T01', path: 'calibration/texts/C00-T01.md', sha256: HEX('0'), authors: ['OpenAI'] },
    { id: 'C00-T02', path: 'calibration/texts/C00-T02.md', sha256: HEX('1'), authors: ['DeepSeek'] },
  ]);
  assert.equal(p1?.owner_chosen, 'C00-T01', 'the first answer, not the swapped retest');
  assert.deepEqual(p1?.trials, { Anthropic: { sessions: 1, consistent: true, agree: true, void: 0 }, xAI: { sessions: 1, consistent: true, agree: true, void: 0 } });
  const a1 = ledger.labels[6];
  assert.equal(a1?.owner_chosen, 'W1', 'display label A resolved to the text id');
  assert.deepEqual(a1?.texts.map((t) => t.id), ['W1', 'BASE']);
  assert.deepEqual(Object.keys(a1?.trials ?? {}), ['Anthropic', 'Moonshot'], 'shadow sessions count');
  assert.equal(a1?.trials.Moonshot?.agree, false);
  assert.deepEqual(ledger.labels[7]?.trials, {}, 'a pair nobody judged still is a label');
});

test('buildLedger: an unanswered pair or audit pair is an error, not a silent gap', () => {
  const c00 = calibSource('C00', 'round0', 2);
  assert.equal(buildLedger({ calib: [{ ...c00, answers: c00.answers.filter((a) => a.pair !== 'C00-P02') }], rounds: [] }, CAL).ok, false);
  const r01 = roundSource('R01', [{ owner: 'W', split: 'visible', sessions: [] }]);
  assert.equal(buildLedger({ calib: [], rounds: [{ ...r01, audit: { ...r01.audit, answers: [] } }] }, CAL).ok, false);
  assert.equal(buildLedger({ calib: [], rounds: [{ ...r01, textOf: {} }] }, CAL).ok, false, 'a display id without a text');
  assert.equal(ledgerOf(buildLedger({ calib: [c00], rounds: [r01] }, CAL)).labels.length, 3);
});

test('visibleLabels / reserveLabels: reserve newest first by (round, seq), at most max, never visible or none', () => {
  const ledger = ledgerOf(buildLedger({
    calib: [calibSource('C00', 'round0', 4), calibSource('Q01', 'requal', 2, ['xAI'])],
    rounds: ['R01', 'R02'].map((r) => roundSource(r, [
      { owner: 'W', split: 'reserve', sessions: [] }, { owner: 'W', split: 'visible', sessions: [] }, { owner: 'BASE', split: 'reserve', sessions: [] },
    ])),
  }, CAL));
  assert.deepEqual(visibleLabels(ledger).map((l) => l.id), ['C00-P01', 'C00-P03', 'R01-audit-2', 'R02-audit-2']);
  const ids = (ls: readonly Label[]): string[] => ls.map((l) => l.id);
  assert.deepEqual(ids(reserveLabels(ledger, 16)), ['R02-audit-3', 'R02-audit-1', 'R01-audit-3', 'R01-audit-1', 'C00-P04', 'C00-P02']);
  assert.deepEqual(ids(reserveLabels(ledger, 3)), ['R02-audit-3', 'R02-audit-1', 'R01-audit-3']);
  assert.deepEqual(reserveLabels(ledger, 0), []);
});

test('parseLabelLedger: a built ledger round-trips through schema/calib-labels.schema.json (one trial schema per family); broken labels are refused', () => {
  const ledger = ledgerOf(buildLedger({ calib: [calibSource('C00', 'round0', 2)], rounds: [roundSource('R01', [{ owner: 'W', split: 'visible', sessions: [agreeing('xAI', 'W1')] }])] }, CAL));
  assert.deepEqual(parseLabelLedger(JSON.parse(JSON.stringify(ledger))), { ok: true, value: ledger });
  const edit = (f: (l: Label) => Label): unknown => JSON.parse(JSON.stringify({ ...ledger, labels: ledger.labels.map((l, i) => (i === 0 ? f(l) : l)) }));
  assert.equal(parseLabelLedger(edit((l) => ({ ...l, owner_chosen: 'C00-T99' }))).ok, false);
  assert.equal(parseLabelLedger(edit((l) => ({ ...l, split: 'none' }))).ok, false, 'round0 labels are visible or reserve');
  assert.equal(parseLabelLedger(edit((l) => ({ ...l, id: 'R01-audit-1' }))).ok, false, 'duplicate id');
  assert.equal(parseLabelLedger(edit((l) => ({ ...l, trials: { xAI: { sessions: 1, consistent: false, agree: true, void: 0 } } }))).ok, false);
  assert.equal(parseLabelLedger({ schema: 'calib-labels/1', labels: [{ id: 'C00-P01' }] }).ok, false);
  const raw: unknown = JSON.parse(readFileSync(new URL('../schema/calib-labels.schema.json', import.meta.url), 'utf8'));
  const items = readRecord(readRecord(readRecord(raw, 'properties'), 'labels'), 'items');
  const trials = readRecord(readRecord(readRecord(items, 'properties'), 'trials'), 'properties');
  assert.ok(isRecord(trials));
  assert.deepEqual(Object.keys(trials), [...FAMILIES]);
  const first = JSON.stringify(trials[FAMILIES[0] ?? '']);
  for (const f of FAMILIES) assert.equal(JSON.stringify(trials[f]), first, f);
});

// ---- computeStatus fixtures ----

function judge(id: string, family: Family): JudgeSpec {
  return { id, family, cli: 'codex', model: `${id}-model`, effort: 'max', concurrency: 3, acceptedServed: [] };
}

/** judges.json order. */
const JUDGES: readonly JudgeSpec[] = [judge('codex', 'OpenAI'), judge('claude', 'Anthropic'), judge('kimi', 'Moonshot'), judge('grok', 'xAI')];

function report(set: string, over: Partial<CalibReport> = {}): CalibReport {
  const kind: SetKind = set.startsWith('C') ? 'round0' : set.startsWith('Q') ? 'requal' : 'gate';
  return {
    set, kind, family: null, reason: null, valid: true, invalid_reason: null, pin_sha256: null, after_round: null, families: {}, qualified: [],
    canon_rounds_may_start: false, owner: null, writer_models: [], writer_recommendation: null, gate_dryrun: {}, ...over,
  };
}

const C00 = report('C00', {
  qualified: ['Anthropic', 'Moonshot', 'OpenAI'],
  gate_dryrun: { OpenAI: { caught: 4, of: 4, gate_judge: true }, Anthropic: { caught: 4, of: 4, gate_judge: true }, Moonshot: { caught: 3, of: 4, gate_judge: true }, xAI: { caught: 1, of: 4, gate_judge: false } },
});

/** `n` audit labels of `round` in which `family` agrees on the first `k` (seq from `from`). */
function auditRun(round: string, family: Family, n: number, k: number, from = 1): Label[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${round}-audit-${from + i}`, source: 'audit', round, seq: from + i, texts: [], owner_chosen: 'W1', answered_at: AT, split: 'reserve', use: 'agreement',
    trials: { [family]: { sessions: 2, consistent: true, agree: i < k, void: 0 } },
  }));
}

/** 24 audit trials over R01–R06 with 10 agreements (posterior(10, 24) → suspended). */
function badHistory(family: Family): Label[] {
  return ['R01', 'R02', 'R03', 'R04', 'R05', 'R06'].flatMap((r, i) => auditRun(r, family, 4, i < 2 ? 3 : i < 4 ? 2 : 0));
}

function statusOf(labels: readonly Label[], reports: readonly CalibReport[], prev: TrustStatus | null, after: string): TrustStatus {
  const status = computeStatus({ schema: 'calib-labels/1', labels: [...labels] }, reports, prev, JUDGES, CAL, after);
  const parsed = parseTrustStatus(JSON.parse(JSON.stringify(status)));
  if (!parsed.ok) throw new Error(`status does not parse: ${parsed.error}`);
  return status;
}

test('computeStatus: qualification from C00, gate judges from C00 then G sets, requal_used from Q reports; judges.json order', () => {
  const g01 = report('G01', { family: 'xAI', gate_dryrun: { xAI: { caught: 4, of: 4, gate_judge: true } } });
  const q01 = report('Q01', { family: 'xAI', reason: 'calibration_fail', after_round: 'R02' });
  const s = statusOf([], [C00, g01, q01], null, 'Q01');
  assert.deepEqual(Object.keys(s.families), ['OpenAI', 'Anthropic', 'Moonshot', 'xAI']);
  assert.equal(s.updated_after, 'Q01');
  assert.deepEqual([s.families.OpenAI?.qualified, s.families.OpenAI?.qualified_by, s.families.OpenAI?.gate_by], [true, 'C00', 'C00']);
  assert.deepEqual(s.families.xAI, {
    qualified: false, qualified_by: null, requal_used: { calibration_fail: true, suspension: false }, gate_judge: true, gate_by: 'G01',
    agreement: { epoch: 'C00', n: 0, k: 0, alpha: 1, beta: 1, mean: 0.5, ci90: [0.05, 0.95], p_below: 0.6, state: 'ok' }, suspended_at: null,
  });
  const invalid = statusOf([], [{ ...C00, valid: false, invalid_reason: 'answered before v1' }], null, 'C00');
  assert.deepEqual(Object.values(invalid.families).map((f) => [f.qualified, f.gate_judge]), [[false, false], [false, false], [false, false], [false, false]], 'an invalid report qualifies nobody');
});

test('computeStatus: suspension is sticky across a good round and cleared only by a later passed requal, which resets the epoch', () => {
  const bad = statusOf(badHistory('Anthropic'), [C00], null, 'R06');
  assert.deepEqual([bad.families.Anthropic?.agreement.state, bad.families.Anthropic?.suspended_at, bad.families.Anthropic?.agreement.n], ['suspended', 'R06', 24]);
  const good = [...badHistory('Anthropic'), ...auditRun('R07', 'Anthropic', 12, 12)];
  const memoryless = agreementState(posterior(22, 36, CAL.agreement.threshold), CAL.agreement);
  assert.equal(memoryless, 'ok', 'the posterior alone would clear it');
  const sticky = statusOf(good, [C00], bad, 'R07');
  assert.deepEqual([sticky.families.Anthropic?.agreement.state, sticky.families.Anthropic?.suspended_at, sticky.families.Anthropic?.agreement.n], ['suspended', 'R06', 36]);
  const older = report('Q01', { family: 'Anthropic', reason: 'suspension', after_round: 'R03', qualified: ['Anthropic'] });
  assert.equal(statusOf(good, [C00, older], sticky, 'R07').families.Anthropic?.agreement.state, 'suspended', 'a requal scored before the suspension does not clear it');
  const failed = report('Q02', { family: 'Anthropic', reason: 'suspension', after_round: 'R07' });
  assert.equal(statusOf(good, [C00, failed], sticky, 'Q02').families.Anthropic?.agreement.state, 'suspended', 'a failed requal keeps it');
  const passed = report('Q02', { family: 'Anthropic', reason: 'suspension', after_round: 'R07', qualified: ['Anthropic'] });
  const cleared = statusOf(good, [C00, passed], sticky, 'Q02');
  assert.deepEqual(cleared.families.Anthropic, {
    ...cleared.families.Anthropic, qualified: true, qualified_by: 'Q02', requal_used: { calibration_fail: false, suspension: true }, suspended_at: null,
  });
  assert.deepEqual([cleared.families.Anthropic?.agreement.epoch, cleared.families.Anthropic?.agreement.n, cleared.families.Anthropic?.agreement.state], ['R07', 0, 'ok']);
  const later = statusOf([...good, ...auditRun('R08', 'Anthropic', 4, 4)], [C00, passed], cleared, 'R08');
  assert.deepEqual([later.families.Anthropic?.agreement.n, later.families.Anthropic?.agreement.k, later.families.Anthropic?.agreement.state], [4, 4, 'ok'], 'only labels after the new epoch');
});

test('computeStatus: a suspension first recorded at a G-set rebuild is dated by its audit round and cleared by a passed requal with the same after_round', () => {
  const g01 = report('G01', { family: 'Anthropic', after_round: 'R06' });
  // G01 scored after R06 09a, before R06 11e: rebuildTrust(ctx, 'G01') is the first rebuild that sees the bad history
  const atG = statusOf(badHistory('Anthropic'), [C00, g01], null, 'G01');
  assert.deepEqual([atG.families.Anthropic?.agreement.state, atG.families.Anthropic?.suspended_at], ['suspended', 'R06'], 'dated by the newest counted audit round, never a set id');
  const at11e = statusOf(badHistory('Anthropic'), [C00, g01], atG, 'R06');
  assert.equal(at11e.families.Anthropic?.suspended_at, 'R06');
  const q01 = report('Q01', { family: 'Anthropic', reason: 'suspension', after_round: 'R06', qualified: ['Anthropic'] });
  const cleared = statusOf(badHistory('Anthropic'), [C00, g01, q01], at11e, 'Q01');
  assert.deepEqual([cleared.families.Anthropic?.agreement.state, cleared.families.Anthropic?.suspended_at, cleared.families.Anthropic?.agreement.n], ['ok', null, 0]);
  const was = at11e.families.Anthropic;
  if (was === undefined) throw new Error('fixture');
  const legacy = statusOf(badHistory('Anthropic'), [C00, g01, q01], { ...at11e, families: { ...at11e.families, Anthropic: { ...was, suspended_at: 'G01' } } }, 'Q01');
  assert.equal(legacy.families.Anthropic?.suspended_at, null, 'a set-dated suspension compares by that set\'s after_round');
});

test('computeStatus: an invalid requal report does not use up the family\'s requal for its reason', () => {
  const invalid = report('Q01', { family: 'xAI', reason: 'calibration_fail', valid: false, invalid_reason: 'owner-answers.json Q01 changed after c4-judge pinned it' });
  const s = statusOf([], [C00, invalid], null, 'Q01');
  assert.deepEqual([s.families.xAI?.requal_used, s.families.xAI?.qualified], [{ calibration_fail: false, suspension: false }, false]);
  const failed = report('Q02', { family: 'xAI', reason: 'calibration_fail' });
  assert.deepEqual(statusOf([], [C00, invalid, failed], null, 'Q02').families.xAI?.requal_used, { calibration_fail: true, suspension: false }, 'a valid failed requal uses it');
});

// ---- rebuildTrust on a temp forge root (C00 scored + R01 audited; owner files only through owner-sim) ----

function put(root: string, rel: string, value: unknown): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), `${JSON.stringify(value, null, 2)}\n`);
}

function world(): { dir: string; root: string; ctx: StepContext; sim: OwnerSim } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-trust-'));
  const w = fixtureWorld(dir, { ...DEFAULT_FIXTURE, trust: 'none' });
  const config = loadConfig(w.root, { requireLocal: true });
  if (!config.ok) throw new Error(config.error);
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: '2026-10-01T06:00:00.000Z', seed: 'trust' });
  const b = fakeBackend('x', 'DeepSeek', () => '');
  const backends: RoundBackends = { writers: [], baseline: b, decoy: b, defect: b, judges: [], forecasters: [], maintainer: b, mergeEditor: b, calibGateway: new Map() };
  const built = buildContext({
    root: w.root, repo: w.repo, roundId: 'R01', pipeline: 'round', paths: roundPaths(w.root, 'R01'), config: config.value,
    deps: { ports, backends: () => backends, env: {}, pid: 7, isAlive: () => true, log: () => undefined }, startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
  });
  if (!built.ok) throw new Error(built.error);
  return { dir, root: w.root, ctx: built.value, sim: ownerSim(w.root, ports.clock) };
}

function familyReport(qualified: boolean): FamilyReport {
  return { nonknown: { m: 2, agree: 2, need: 2, wilson90: [0.4, 1] }, known: { k: 0, correct: 0, need: 0 }, by_category: {}, order_consistency: { n: 2, consistent: 2 }, void_calls: 0, qualified };
}

/** C00 with 2 pairs judged by Anthropic and xAI (both qualified), R01 with one audit pair W1 (label A) vs BASE judged by Anthropic. */
function scoredWorld(root: string, sim: OwnerSim): void {
  const c00 = calibRecord('C00', 'round0', 2);
  put(root, 'calibration/pairs.json', { schema: 'calib-pairs/1', sets: { C00: c00 } });
  sim.answerCalibration('C00', () => 'left');
  for (const v of calibVerdicts(c00, ['Anthropic', 'xAI'], () => 'a')) put(root, relative(root, verdictPath(calibPaths(root, 'C00'), v.family, v.pair, v.order)), { ...v, picks: { q1: v.decisive } });
  const families = { OpenAI: familyReport(false), Anthropic: familyReport(true), Moonshot: familyReport(false), xAI: familyReport(true) };
  put(root, 'calibration/round0.json', report('C00', { families, qualified: ['Anthropic', 'xAI'], gate_dryrun: C00.gate_dryrun }));
  const text = (id: string, file: string, authors: Family[]): unknown => ({ id, kind: id === 'BASE' ? 'champion' : 'submission', file, sha256: HEX('e'), authors });
  put(root, 'rounds/R01/pairs.json', {
    round: 'R01', champion: 'BASE', texts: { W1: text('W1', 'rounds/R01/submissions/W1.json', ['DeepSeek']), BASE: text('BASE', 'rounds/R01/champion.json', ['OpenAI']) },
    pairs: [{ id: 'W1', kind: 'champion', left: 'W1', right: 'BASE', families: ['Anthropic'], shadow: [], effective: ['Anthropic'], dropped: [] }],
  });
  put(root, 'rounds/R01/labels.json', { A: 'W1' });
  put(root, 'rounds/R01/audit-set.json', { round: 'R01', pairs: [{ id: 'R01-audit-1', left: 'A', right: 'BASE', kind: 'champion', split: 'reserve', label: 'R01-audit-1', pair: 'W1' }], created_at: AT });
  for (const session of [0, 1]) {
    for (const order of ['fwd', 'rev'] satisfies Order[]) {
      const task = `taste-W1-Anthropic-s${session}-${order}`;
      put(root, relative(root, tasteCallPath(roundPaths(root, 'R01'), 'champion', 'W1', 'Anthropic', session, false, order)), {
        round: 'R01', pair: 'W1', kind: 'champion', family: 'Anthropic', shadow: false, session, rerun: false, order, task, text1: order === 'fwd' ? 'W1' : 'BASE',
        text2: order === 'fwd' ? 'BASE' : 'W1', status: 'ok', picks: { q1: 'W1' }, quotes: {}, decisive: 'W1', decoy_at: null, decoy_pick: null, preferred_decoy: false, error: null,
      });
    }
  }
  sim.answerAudit('R01', () => 'left');
}

function statusFrom(r: ReturnType<typeof rebuildTrust>): TrustStatus {
  if (!r.ok) throw new Error(r.error);
  if (r.value.kind === 'wait') throw new Error(`wait: ${r.value.detail}`);
  return r.value.status;
}

test('rebuildTrust: labels.json + status.json from C00 and R01; a rerun (and updateTrust) writes identical bytes; owner files untouched', () => {
  const { dir, root, ctx, sim } = world();
  scoredWorld(root, sim);
  const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
  const ownerBefore = [...sim.expected()].map(([rel]) => [rel, sha256(read(rel))]);
  const first = statusFrom(rebuildTrust(ctx, 'R01'));
  const bytes = [read(LABELS_FILE), read('calibration/status.json')];
  const ledger = readLabelLedger(root);
  assert.deepEqual(ledger?.ok ? ledger.value.labels.map((l) => [l.id, l.split, l.owner_chosen]) : ledger, [['C00-P01', 'visible', 'C00-T01'], ['C00-P02', 'reserve', 'C00-T03'], ['R01-audit-1', 'reserve', 'W1']]);
  assert.equal(first.labels_sha256, sha256(bytes[0] ?? ''));
  assert.deepEqual([first.families.Anthropic?.agreement.n, first.families.Anthropic?.agreement.k, first.families.xAI?.agreement.n], [1, 1, 0]);
  assert.deepEqual(readTrustStatus(root), { ok: true, value: first });
  assert.deepEqual(statusFrom(rebuildTrust(ctx, 'R01')), first);
  assert.deepEqual(statusFrom(updateTrust(ctx, 'R01')), first);
  assert.deepEqual([read(LABELS_FILE), read('calibration/status.json')], bytes);
  assert.deepEqual([...sim.expected()].map(([rel]) => [rel, sha256(read(rel))]), ownerBefore, 'owner files hash-unchanged');
  assert.deepEqual([...sim.expected()].map(([rel]) => rel).sort(), ['calibration/owner-answers.json', 'owner-log.jsonl', 'rounds/R01/audit.json']);
  rmSync(dir, { recursive: true });
});

test('rebuildTrust: calibration answers awaiting an owner-log repair are a WAIT (not an integrity error) and write nothing; invalid answers stay an error', () => {
  const { dir, root, ctx, sim } = world();
  scoredWorld(root, sim);
  // the UI wrote answers of an in-progress Q01 and crashed before logging them
  sim.tamper('calibration/owner-answers.json', (text) => {
    const value: unknown = JSON.parse(text);
    const sets = readRecord(value, 'sets');
    if (!isRecord(value) || sets === null) throw new Error('fixture');
    return `${JSON.stringify({ ...value, sets: { ...sets, Q01: sets['C00'] } }, null, 2)}\n`;
  });
  const r = rebuildTrust(ctx, 'R01');
  assert.ok(r.ok && r.value.kind === 'wait', JSON.stringify(r));
  if (r.ok && r.value.kind === 'wait') assert.deepEqual([r.value.waitingFor, r.value.detail], ['owner_log_repair', 'calibration/owner-answers.json has answers without an owner-log entry']);
  const at11e = updateTrust(ctx, 'R01');
  assert.ok(at11e.ok && at11e.value.kind === 'wait', 'step 11e waits the same way');
  assert.equal(readLabelLedger(root), null);
  assert.equal(readTrustStatus(root), null);
  rmSync(dir, { recursive: true });
  const other = world();
  scoredWorld(other.root, other.sim);
  other.sim.tamper('calibration/owner-answers.json', (text) => text.replace('"choice": "left"', '"choice": "right"'));
  const bad = rebuildTrust(other.ctx, 'R01');
  assert.equal(bad.ok, false, 'a hand edit of logged answers is an integrity problem');
  rmSync(other.dir, { recursive: true });
});
