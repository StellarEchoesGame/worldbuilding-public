import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CalibSetRecord, SetKind } from './calib-build.ts';
import { calibTaskId, type CalibOrder, type VerdictRecord } from './calib-run.ts';
import type { CalibReport } from './calib-score.ts';
import { posterior, round4 } from './calib-stats.ts';
import type { Family, JudgeSpec } from './config.ts';
import type { CalibAnswer } from './owner-inputs.ts';
import type { ProtocolCalibration } from './protocol.ts';
import { parseTrustStatus, type TrustStatus } from './trust-status.ts';
import { buildLedger, computeStatus, type CalibLabelSource, type Label } from './trust.ts';

const CAL: ProtocolCalibration = {
  categories: ['canon_vs_rewrite', 'cross_model', 'stance', 'known'], pairsPerCategory: 6, retestPairs: 4, visibleRound0: 12,
  qualifyNonknownPct: 72, qualifyKnownMaxMiss: 1, requal: { nonknown: 9, nonknownMin: 8, known: 3, knownMin: 3 }, gateDryrunMaxMiss: 1,
  intervalZ: 1.6448536269514722, agreement: { threshold: 0.6, flagN: 12, flagP: 0.8, suspendN: 24, suspendP: 0.95 }, auditVisible: 2, replayMaxPairs: 16, replayMinPairs: 4,
};
const ORDERS: readonly CalibOrder[] = ['ab', 'ba'];
const AT = '2026-10-01T00:00:00.000Z';
const HEX = (c: string): string => c.repeat(64);

/** A scored C / Q set of `n` pairs (text a by OpenAI, b by DeepSeek); the owner and every family pick text a in both orders. */
function calibSource(set: string, kind: SetKind, n: number, families: readonly Family[]): CalibLabelSource {
  const texts: CalibSetRecord['texts'] = {};
  const pairs: CalibSetRecord['pairs'] = [];
  const display: CalibSetRecord['display'] = [];
  const text = (j: number): string => `${set}-T${String(j).padStart(2, '0')}`;
  for (let i = 1; i <= n; i += 1) {
    const [a, b, pair] = [text(2 * i - 1), text(2 * i), `${set}-P${String(i).padStart(2, '0')}`];
    texts[a] = { path: `texts/${a}.md`, sha256: HEX('a'), role: 'passage', model: null, author_family: 'OpenAI', stance: null, source: null, of: null, call: null };
    texts[b] = { path: `texts/${b}.md`, sha256: HEX('b'), role: 'rewrite', model: 'deepseek-fixture-a', author_family: 'DeepSeek', stance: 'resident-day', source: null, of: null, call: `calibrewrite-${b}` };
    const split = kind === 'round0' ? (i % 2 === 1 ? 'visible' : 'reserve') : 'none';
    pairs.push({ id: pair, category: 'cross_model', a, b, known_better: null, authors: ['DeepSeek', 'OpenAI'], split });
    display.push({ slot: i, pair, left: a, right: b, retest_of: null });
  }
  const record: CalibSetRecord = {
    kind, family: kind === 'round0' ? null : families[0] ?? null, reason: kind === 'requal' ? 'calibration_fail' : null, seed: HEX('5'), built_at: AT, size: n, texts, pairs, display, dryrun: [],
  };
  const answers = display.map((d): CalibAnswer => ({ slot: d.slot, pair: d.pair, left: d.left, right: d.right, choice: 'left', chosen: d.left, answered_at: AT, ms: null }));
  const verdicts = pairs.flatMap((p) => families.flatMap((f) => ORDERS.map((o): VerdictRecord => ({
    pair: p.id, family: f, judge: f.toLowerCase(), order: o, text1: o === 'ab' ? p.a : p.b, text2: o === 'ab' ? p.b : p.a, status: 'ok',
    decisive: p.a, picks: {}, quotes: {}, error: null, call: calibTaskId(p.id, f.toLowerCase(), o), benchmark_version: 'v1',
  }))));
  return { set, record, answers, verdicts };
}

function calibLabels(sources: readonly CalibLabelSource[]): Label[] {
  const built = buildLedger({ calib: [...sources], rounds: [] }, CAL);
  if (!built.ok) throw new Error(built.error);
  return built.value.labels;
}

/** `n` audit labels of `round` in which `family` agrees on the first `k` (seq from `from`). */
function auditRun(round: string, family: Family, n: number, k: number, from = 1): Label[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${round}-audit-${from + i}`, source: 'audit', round, seq: from + i, texts: [], owner_chosen: 'W1', answered_at: AT, split: 'reserve', use: 'agreement',
    trials: { [family]: { sessions: 2, consistent: true, agree: i < k, void: 0 } },
  }));
}

function report(set: string, kind: SetKind, over: Partial<CalibReport> = {}): CalibReport {
  return {
    set, kind, family: null, reason: null, valid: true, invalid_reason: null, pin_sha256: null, after_round: null, families: {}, qualified: [],
    canon_rounds_may_start: false, owner: null, writer_models: [], writer_recommendation: null, gate_dryrun: {}, ...over,
  };
}

const C00 = report('C00', 'round0', { qualified: ['Anthropic', 'Moonshot', 'OpenAI'] });

function judge(id: string, family: Family): JudgeSpec {
  return { id, family, cli: 'codex', model: `${id}-model`, effort: 'max', concurrency: 3, acceptedServed: [] };
}

/** judges.json order. */
const JUDGES: readonly JudgeSpec[] = [judge('codex', 'OpenAI'), judge('claude', 'Anthropic'), judge('kimi', 'Moonshot'), judge('grok', 'xAI')];

function statusOf(labels: readonly Label[], reports: readonly CalibReport[], after: string): TrustStatus {
  const status = computeStatus({ schema: 'calib-labels/1', labels: [...labels] }, reports, null, JUDGES, CAL, after);
  const parsed = parseTrustStatus(JSON.parse(JSON.stringify(status)));
  if (!parsed.ok) throw new Error(`status does not parse: ${parsed.error}`);
  return status;
}

test('computeStatus: the posterior counts audit labels only (never C00 / Q labels), per qualified family after its epoch', () => {
  const calib = calibLabels([calibSource('C00', 'round0', 4, ['Anthropic', 'xAI']), calibSource('Q01', 'requal', 2, ['Anthropic', 'xAI'])]);
  const requal = calib.filter((l) => l.source === 'requal').map((l) => [l.id, l.split, l.use, l.trials.Anthropic?.agree]);
  assert.deepEqual(requal, [['Q01-P01', 'none', 'requal', true], ['Q01-P02', 'none', 'requal', true]], 'Q labels: split none, agreed on by a qualified family');
  const audit = [...auditRun('R01', 'Anthropic', 6, 3), ...auditRun('R02', 'Anthropic', 6, 2), ...auditRun('R02', 'xAI', 6, 0, 7)];
  const s = statusOf([...calib, ...audit], [C00], 'R02');
  const p = posterior(5, 12, CAL.agreement.threshold);
  assert.deepEqual(s.families.Anthropic?.agreement, {
    epoch: 'C00', n: 12, k: 5, alpha: 6, beta: 8, mean: round4(p.mean), ci90: [round4(p.ci90.lo), round4(p.ci90.hi)], p_below: round4(p.pBelow), state: 'flagged',
  });
  assert.deepEqual(s.families.Anthropic?.agreement, statusOf(audit, [C00], 'R02').families.Anthropic?.agreement, 'the 4 C00 and 2 Q agreements change nothing');
  assert.equal(s.families.xAI?.agreement.n, 0, 'an unqualified family has no posterior');
  assert.equal(s.families.Moonshot?.agreement.n, 0);
});

test('computeStatus: a family qualified by a requal scored before any audit (epoch = that Q set) never counts the set\'s own labels', () => {
  const q01 = calibLabels([calibSource('Q01', 'requal', 3, ['xAI'])]);
  assert.deepEqual(q01.map((l) => [l.split, l.trials.xAI?.agree]), [['none', true], ['none', true], ['none', true]]);
  const passed = report('Q01', 'requal', { family: 'xAI', reason: 'calibration_fail', qualified: ['xAI'] });
  const s = statusOf([...q01, ...auditRun('R01', 'xAI', 4, 1)], [C00, passed], 'R01');
  const x = s.families.xAI;
  assert.deepEqual([x?.qualified_by, x?.agreement.epoch, x?.agreement.n, x?.agreement.k], ['Q01', 'Q01', 4, 1]);
});
