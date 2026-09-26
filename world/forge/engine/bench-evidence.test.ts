import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildEvidence, ceilingIds, CEILING_SHARE, EVIDENCE_DISAGREEMENTS_MAX, EVIDENCE_ID, EVIDENCE_QUOTE_MAX, EVIDENCE_TEXT_MAX, evidenceId, evidencePath,
  parseEvidencePacket, readEvidencePacket, saturation, UNVERIFIED_QUOTE_PREFIX, type EvidenceInputs, type EvidenceItem, type EvidencePacket, type EvidenceQuote,
} from './bench-evidence.ts';
import type { Family } from './config.ts';
import { sha256Bytes } from './owner-inputs.ts';
import type { FamilySessions, SessionCall } from './pairs.ts';
import { sha256 } from './store.ts';
import type { Label, LabelLedger, LabelText, Trial } from './trust.ts';
import type { AgreementState, FamilyTrust, TrustStatus } from './trust-status.ts';

/*
 * Pure buildEvidence on fixture ledgers, trust status and session sets built here (s3 §6 bench-evidence.test.ts):
 * every item kind, stable ASCII ids, byte-identical rebuilds, the 0.70 ceiling, reserve exclusion, quote marking and
 * the disagreement cap. collectEvidence and the packet reader are in bench-evidence-collect.test.ts.
 */

const FAMILIES: readonly Family[] = ['Anthropic', 'Moonshot', 'OpenAI', 'xAI'];
const RESERVE_MARK = '预备文本';
const AT = '2026-10-01T00:00:00.000Z';

/** A C00 text: body is unique per id, so a reserve text is recognisable in the serialised packet. */
function text(id: string, body: string): { ref: LabelText; body: string } {
  return { ref: { id, path: `calibration/texts/${id}.md`, sha256: sha256(body), authors: ['OpenAI'] }, body };
}

const AGREE: Trial = { sessions: 1, consistent: true, agree: true, void: 0 };
const OTHER: Trial = { sessions: 1, consistent: true, agree: false, void: 0 };
const MIXED: Trial = { sessions: 1, consistent: false, agree: false, void: 0 };

function trials(overrides: Partial<Record<Family, Trial>> = {}): Partial<Record<Family, Trial>> {
  const out: Partial<Record<Family, Trial>> = {};
  for (const f of FAMILIES) out[f] = overrides[f] ?? AGREE;
  return out;
}

interface Fixture {
  ledger: LabelLedger;
  texts: Record<string, string>;
  reserveBodies: string[];
}

/** C00: `visible` visible labels (P01 …) then 2 reserve labels; P02 has Moonshot against the owner and xAI inconsistent. */
function ledgerFixture(visible = 3): Fixture {
  const labels: Label[] = [];
  const texts: Record<string, string> = {};
  const reserveBodies: string[] = [];
  const total = visible + 2;
  for (let i = 1; i <= total; i += 1) {
    const reserve = i > visible;
    const n = String(i).padStart(2, '0');
    const a = text(`C00-T${String(2 * i - 1).padStart(2, '0')}`, reserve ? `${RESERVE_MARK}甲${n}：舱壁上的水珠一颗颗滚落。` : `第${n}篇甲：配给簿上多了一行字，是昨夜补记的。`);
    const b = text(`C00-T${String(2 * i).padStart(2, '0')}`, reserve ? `${RESERVE_MARK}乙${n}：泵声停了三秒又响起。` : `第${n}篇乙：泵声停了很久，没有人去看。`);
    if (reserve) reserveBodies.push(a.body, b.body);
    else {
      texts[a.ref.sha256] = a.body;
      texts[b.ref.sha256] = b.body;
    }
    const against = i === 2 || i > visible + 1 || (i > 3 && !reserve);
    labels.push({
      id: `C00-P${n}`, source: 'round0', round: 'C00', seq: i, texts: [a.ref, b.ref], owner_chosen: a.ref.id, answered_at: AT,
      split: reserve ? 'reserve' : 'visible', use: 'qualification',
      trials: trials(against ? { Moonshot: OTHER, ...(i === 2 ? { xAI: MIXED } : {}) } : {}),
    });
  }
  return { ledger: { schema: 'calib-labels/1', labels }, texts, reserveBodies };
}

function familyTrust(state: AgreementState): FamilyTrust {
  return {
    qualified: true, qualified_by: 'C00', requal_used: { calibration_fail: false, suspension: false }, gate_judge: true, gate_by: 'C00',
    agreement: { epoch: 'C00', n: 0, k: 0, alpha: 1, beta: 1, mean: 0.5, ci90: [0.05, 0.95], p_below: 0.3, state }, suspended_at: null,
  };
}

function trustStatus(): TrustStatus {
  const families: Record<string, FamilyTrust> = {};
  for (const f of FAMILIES) families[f] = familyTrust(f === 'Moonshot' ? 'flagged' : 'ok');
  return { schema: 'trust-status/1', updated_after: 'C00', labels_sha256: 'a'.repeat(64), families };
}

function call(taskId: string, decisive: string | null, preferredDecoy = false): SessionCall {
  return { taskId, order: taskId.endsWith('rev') ? 'rev' : 'fwd', status: decisive === null ? 'void' : 'ok', decisive, preferredDecoy };
}

function sessions(): Record<string, FamilySessions[]> {
  return {
    W2: [{ family: 'Anthropic', shadow: false, sessions: [[call('a-fwd', 'W2'), call('a-rev', 'BASE')]], reruns: [], dropped: null }],
    W1: [
      { family: 'Anthropic', shadow: false, sessions: [[call('a-fwd', 'W1'), call('a-rev', 'W1')], [call('b-fwd', 'W1'), call('b-rev', 'W1')]], reruns: [], dropped: null },
      { family: 'Moonshot', shadow: true, sessions: [[call('c-fwd', null), call('c-rev', 'W1')], [call('d-fwd', 'BASE', true), call('d-rev', 'BASE')], [call('e-fwd', 'BASE'), call('e-rev', 'BASE')]], reruns: [0], dropped: null },
    ],
  };
}

/** A round-R02 input with every item kind. */
function inputs(fx: Fixture = ledgerFixture(), quotes: Record<string, EvidenceQuote[]> = {}): EvidenceInputs {
  return {
    round: 'R02', benchmarkVersion: 'v2', head: { version: 'v3', sha256: 'b'.repeat(64), path: 'benchmark/v3.json' },
    ledger: fx.ledger, visibleTexts: fx.texts, status: trustStatus(), sessions: sessions(), quotes,
    saturation: {
      taste: [{ round: 'R01', n: 10, top: 7 }, { round: 'R02', n: 20, top: 14 }],
      hook: [{ round: 'R01', n: 10, top: 7 }, { round: 'R02', n: 100, top: 69 }],
      skin_swap: [{ round: 'R02', n: 3, top: 3 }], cold_reader: [], surprise: [{ round: 'R00', n: 0, top: 0 }, { round: 'R01', n: 4, top: 3 }],
    },
    reasons: [{ round: 'R01', reason: '平' }, { round: 'R02', reason: '假' }],
    defects: [{ family: 'OpenAI', injected: 1, caught: 1 }, { family: 'Anthropic', injected: 1, caught: 0 }],
    costs: [{ family: 'DeepSeek', calls: 4, usd: 0.25, p50_ms: 900, p90_ms: 1800 }],
    stagnation: [{ row_id: 'S1-冷湾', rounds_without_beat: 2, champion_kind: 'baseline' }, { row_id: 'SHIP', rounds_without_beat: 0, champion_kind: 'owner_pick' }],
    rollbacks: [{ at: AT, version: 'v1', from: 'v2', keys: ['decoy_recipe'] }],
    pending: [{ version: 'v3', since: AT }],
    files: {}, inputs: { 'rounds/R02/tally.json': 'c'.repeat(64), 'calibration/labels.json': 'd'.repeat(64) },
  };
}

function item(p: EvidencePacket, id: string): EvidenceItem {
  const found = p.items.find((i) => i.id === id);
  assert.ok(found !== undefined, `${id} missing: ${p.items.map((i) => i.id).join(' ')}`);
  return found;
}

const serialise = (p: EvidencePacket): string => `${JSON.stringify(p, null, 2)}\n`;

test('evidenceId: E-<round>-<CODE>[-<subject>] with _ → -; anything outside the ASCII pattern is a RangeError', () => {
  assert.equal(evidenceId('R03', 'AGR', 'Moonshot'), 'E-R03-AGR-Moonshot');
  assert.equal(evidenceId('R03', 'SAT', 'skin_swap'), 'E-R03-SAT-skin-swap');
  assert.equal(evidenceId('R00', 'DIS', 'C00-P07'), 'E-R00-DIS-C00-P07');
  assert.equal(evidenceId('R01', 'RES'), 'E-R01-RES');
  assert.throws(() => evidenceId('R01', 'STAG', 'S1-冷湾'), RangeError);
  assert.throws(() => evidenceId('R01', 'AGR', ''), RangeError);
  assert.throws(() => evidenceId('R01', 'R C'), RangeError);
  assert.equal(evidencePath('R04'), 'benchmark/evidence/R04.json');
  for (const id of ['E-R01-RES', 'E-R00-DIS-C00-P07']) assert.match(id, EVIDENCE_ID);
});

test('saturation: ceiling at top/n ≥ 0.70 in both of the last two rounds; 0.69 is not a ceiling; one round is never a ceiling', () => {
  assert.equal(CEILING_SHARE, 0.7);
  /** Points in consecutive rounds ending at R05. */
  const at = (points: Array<[number, number]>): boolean => {
    const s = saturation('R05', 'hook', points.map(([top, n], i) => ({ round: `R0${5 - points.length + 1 + i}`, n, top })));
    assert.equal(s.kind, 'saturation');
    return s.kind === 'saturation' && s.ceiling;
  };
  assert.equal(at([[7, 10], [14, 20]]), true);
  assert.equal(at([[7, 10], [69, 100]]), false);
  assert.equal(at([[69, 100], [7, 10]]), false);
  assert.equal(at([[1, 10], [7, 10], [21, 30]]), true, 'only the last two rounds count');
  assert.equal(at([[10, 10]]), false);
  assert.equal(at([]), false);
  assert.equal(at([[7, 10], [0, 0]]), false);
  const s = saturation('R05', 'skin_swap', [{ round: 'R03', n: 4, top: 1 }, { round: 'R04', n: 10, top: 7 }, { round: 'R05', n: 10, top: 8 }]);
  assert.deepEqual(s, { id: 'E-R05-SAT-skin-swap', kind: 'saturation', measure: 'skin_swap', rounds: [{ round: 'R04', n: 10, top: 7 }, { round: 'R05', n: 10, top: 8 }], ceiling: true });
});

test('saturation: only this round and the one before count; a retired measure or a gap of one round is never a ceiling', () => {
  const retired = saturation('R07', 'hook', [{ round: 'R01', n: 4, top: 4 }, { round: 'R02', n: 4, top: 3 }]);
  assert.deepEqual(retired, { id: 'E-R07-SAT-hook', kind: 'saturation', measure: 'hook', rounds: [], ceiling: false }, 'a measure that stopped running');
  const gap = saturation('R05', 'hook', [{ round: 'R03', n: 4, top: 4 }, { round: 'R05', n: 4, top: 4 }]);
  assert.deepEqual(gap, { id: 'E-R05-SAT-hook', kind: 'saturation', measure: 'hook', rounds: [{ round: 'R05', n: 4, top: 4 }], ceiling: false }, 'R03 and R05 are not consecutive');
  const stale = saturation('R05', 'hook', [{ round: 'R03', n: 4, top: 4 }, { round: 'R04', n: 4, top: 4 }]);
  assert.deepEqual(stale, { id: 'E-R05-SAT-hook', kind: 'saturation', measure: 'hook', rounds: [{ round: 'R04', n: 4, top: 4 }], ceiling: false }, 'not run this round');
});

test('buildEvidence: every item kind with fixture inputs; ids match the pattern, items sorted by id, ceilings = the ceiling saturation ids', () => {
  const p = buildEvidence(inputs());
  assert.deepEqual([p.round, p.benchmark_version, p.head_version], ['R02', 'v2', 'v3']);
  assert.deepEqual(new Set(p.items.map((i) => i.kind)), new Set([
    'agreement', 'order_consistency', 'void_decoy', 'family_matrix', 'saturation', 'reason_codes', 'disagreement', 'stagnation', 'defect_catch', 'cost',
    'rollback', 'pending', 'reserve_count',
  ]));
  const ids = p.items.map((i) => i.id);
  for (const id of ids) assert.match(id, EVIDENCE_ID);
  assert.deepEqual(ids, [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(p.ceilings, ['E-R02-SAT-taste']);
  assert.deepEqual(ceilingIds(p), p.ceilings);
  for (const m of ['taste', 'hook', 'skin-swap', 'cold-reader', 'surprise']) item(p, `E-R02-SAT-${m}`);
  assert.deepEqual(item(p, 'E-R02-RC'), { id: 'E-R02-RC', kind: 'reason_codes', counts: { 假: 1, 平: 1 }, rounds: 2 });
  assert.deepEqual(item(p, 'E-R02-RB-1'), { id: 'E-R02-RB-1', kind: 'rollback', at: AT, version: 'v1', from: 'v2', keys: ['decoy_recipe'] });
  assert.deepEqual(item(p, 'E-R02-PEND-v3'), { id: 'E-R02-PEND-v3', kind: 'pending', version: 'v3', since: AT, activation: 'owner' });
  assert.deepEqual(item(p, 'E-R02-DEF-Anthropic'), { id: 'E-R02-DEF-Anthropic', kind: 'defect_catch', family: 'Anthropic', injected: 1, caught: 0 });
  assert.deepEqual(item(p, 'E-R02-COST-DeepSeek'), { id: 'E-R02-COST-DeepSeek', kind: 'cost', family: 'DeepSeek', calls: 4, usd: 0.25, p50_ms: 900, p90_ms: 1800 });
  assert.deepEqual(p.inputs, { 'calibration/labels.json': 'd'.repeat(64), 'rounds/R02/tally.json': 'c'.repeat(64) }, 'inputs keys sorted');
});

test('buildEvidence: ORD / VOID count this round\'s session-pairs per family (shadow included); void sessions (a void call or a decoy pick) are left out of ORD', () => {
  const p = buildEvidence(inputs());
  assert.deepEqual(item(p, 'E-R02-ORD-Anthropic'), { id: 'E-R02-ORD-Anthropic', kind: 'order_consistency', family: 'Anthropic', calls: 3, consistent: 2 });
  assert.deepEqual(item(p, 'E-R02-ORD-Moonshot'), { id: 'E-R02-ORD-Moonshot', kind: 'order_consistency', family: 'Moonshot', calls: 1, consistent: 1 });
  assert.deepEqual(item(p, 'E-R02-VOID-Moonshot'), { id: 'E-R02-VOID-Moonshot', kind: 'void_decoy', family: 'Moonshot', session_pairs: 3, void: 2, decoy_fail: 1 });
  assert.deepEqual(item(p, 'E-R02-VOID-Anthropic'), { id: 'E-R02-VOID-Anthropic', kind: 'void_decoy', family: 'Anthropic', session_pairs: 3, void: 0, decoy_fail: 0 });
  assert.equal(p.items.some((i) => i.id === 'E-R02-ORD-OpenAI'), false, 'a family without sessions has no ORD item');
});

test('buildEvidence: AGR / IFA / RES count visible and reserve labels; state from the trust status', () => {
  const p = buildEvidence(inputs());
  // Moonshot: against the owner on P02 (visible) and P05 (reserve) of 5 blind labels.
  const m = item(p, 'E-R02-AGR-Moonshot');
  assert.equal(m.kind, 'agreement');
  if (m.kind !== 'agreement') return;
  assert.deepEqual([m.n, m.agree, m.state], [5, 3, 'flagged']);
  assert.equal(m.mean, Math.round((4 / 7) * 1e4) / 1e4);
  assert.ok(m.ci90[0] < m.mean && m.mean < m.ci90[1]);
  const x = item(p, 'E-R02-AGR-xAI');
  assert.deepEqual(x.kind === 'agreement' ? [x.n, x.agree, x.state] : null, [5, 4, 'ok']);
  assert.deepEqual(item(p, 'E-R02-RES'), { id: 'E-R02-RES', kind: 'reserve_count', visible: 3, reserve: 2 });
  const ifa = item(p, 'E-R02-IFA');
  assert.equal(ifa.kind, 'family_matrix');
  if (ifa.kind !== 'family_matrix') return;
  assert.deepEqual(ifa.families, ['Anthropic', 'Moonshot', 'OpenAI', 'xAI']);
  assert.deepEqual(ifa.n, [[5, 5, 5, 5], [5, 5, 5, 5], [5, 5, 5, 5], [5, 5, 5, 5]]);
  assert.deepEqual(ifa.agree[0], [5, 3, 5, 4], 'Anthropic vs Moonshot differs on P02 and P05; vs xAI on P02 (inconsistent)');
  assert.deepEqual(ifa.agree[3], [4, 3, 4, 4], 'an inconsistent choice matches nobody, itself included');
});

test('buildEvidence: reserve texts, reserve text hashes and reserve label ids never occur in the serialised packet', () => {
  const fx = ledgerFixture();
  const text = serialise(buildEvidence(inputs(fx)));
  const reserve = fx.ledger.labels.filter((l) => l.split === 'reserve');
  assert.equal(reserve.length, 2);
  for (const l of reserve) {
    assert.equal(text.includes(l.id), false, l.id);
    for (const t of l.texts) {
      assert.equal(text.includes(t.sha256), false, `${l.id} text sha`);
      assert.equal(text.includes(t.id), false, `${l.id} text id`);
    }
  }
  for (const body of fx.reserveBodies) assert.equal(text.includes(body), false);
  assert.equal(text.includes(RESERVE_MARK), false);
});

test('buildEvidence: disagreements show visible labels only, with the owner index and each family\'s order-consistent choice', () => {
  const p = buildEvidence(inputs());
  const dis = p.items.filter((i) => i.kind === 'disagreement');
  assert.deepEqual(dis.map((i) => i.id), ['E-R02-DIS-C00-P02']);
  const d = dis[0];
  assert.ok(d !== undefined && d.kind === 'disagreement');
  assert.equal(d.owner, 0);
  assert.deepEqual(d.texts.map((t) => t.text_id), ['C00-T03', 'C00-T04']);
  assert.equal(d.texts[0].text, '第02篇甲：配给簿上多了一行字，是昨夜补记的。');
  assert.deepEqual(d.panel.map((v) => [v.family, v.choice]), [['Anthropic', 0], ['Moonshot', 1], ['OpenAI', 0], ['xAI', 'inconsistent']]);
});

test('buildEvidence: a judge quote that is no verbatim substring of the shown texts is kept but prefixed ［未逐字命中］; quotes ≤ 200, texts ≤ 2,500', () => {
  const fx = ledgerFixture();
  const p2 = fx.ledger.labels[1];
  assert.ok(p2 !== undefined);
  const quotes: Record<string, EvidenceQuote[]> = {
    'C00-P02': [
      { family: 'Moonshot', source: 'C00-T04', quote: '泵声停了很久' },
      { family: 'Moonshot', source: 'C00-T04', quote: '泵声停了很久' },
      { family: 'xAI', source: 'C00-T03', quote: '舱门被风吹开了' },
      { family: 'OpenAI', source: 'C00-T09', quote: '配给簿' },
      { family: 'Anthropic', source: 'C00-T03', quote: '长'.repeat(300) },
    ],
  };
  const long = `${'字'.repeat(3000)}`;
  const t = p2.texts[1];
  assert.ok(t !== undefined);
  const texts = { ...fx.texts, [t.sha256]: long };
  const p = buildEvidence(inputs({ ...fx, texts }, quotes));
  const d = p.items.find((i) => i.id === 'E-R02-DIS-C00-P02');
  assert.ok(d !== undefined && d.kind === 'disagreement');
  const q = (f: Family): string[] => d.panel.find((v) => v.family === f)?.quotes ?? [];
  assert.deepEqual(q('Moonshot'), [`${UNVERIFIED_QUOTE_PREFIX}泵声停了很久`], 'the text was replaced, so the quote no longer matches; duplicates collapse');
  assert.deepEqual(q('xAI'), [`${UNVERIFIED_QUOTE_PREFIX}舱门被风吹开了`]);
  assert.deepEqual(q('OpenAI'), [`${UNVERIFIED_QUOTE_PREFIX}配给簿`], 'a quote naming a text outside the pair is unverified');
  assert.equal([...(q('Anthropic')[0] ?? '')].length, EVIDENCE_QUOTE_MAX);
  assert.equal([...d.texts[1].text].length, EVIDENCE_TEXT_MAX);
  const verbatim = buildEvidence(inputs(fx, { 'C00-P02': [{ family: 'Moonshot', source: 'C00-T04', quote: '泵声停了很久' }] }));
  const v = verbatim.items.find((i) => i.id === 'E-R02-DIS-C00-P02');
  assert.deepEqual(v?.kind === 'disagreement' ? v.panel.find((x) => x.family === 'Moonshot')?.quotes : null, ['泵声停了很久']);
});

test('buildEvidence: at most 12 disagreement items, newest first by (round, seq)', () => {
  const fx = ledgerFixture(15);
  const p = buildEvidence(inputs(fx));
  const dis = p.items.filter((i) => i.kind === 'disagreement').map((i) => i.id);
  assert.equal(EVIDENCE_DISAGREEMENTS_MAX, 12);
  assert.equal(dis.length, 12);
  assert.equal(dis.includes('E-R02-DIS-C00-P02'), false, 'the oldest of 13 disagreements is dropped');
  assert.ok(dis.includes('E-R02-DIS-C00-P15') && dis.includes('E-R02-DIS-C00-P04'));
});

test('buildEvidence: a Chinese row id becomes STAG-<first 8 hex of sha256(row_id)>; flagged at 2 rounds without a beat', () => {
  const p = buildEvidence(inputs());
  const id = `E-R02-STAG-${sha256('S1-冷湾').slice(0, 8)}`;
  assert.deepEqual(item(p, id), { id, kind: 'stagnation', row_id: 'S1-冷湾', rounds_without_beat: 2, champion_kind: 'baseline', flagged: true });
  const ship = item(p, `E-R02-STAG-${sha256('SHIP').slice(0, 8)}`);
  assert.equal(ship.kind === 'stagnation' && ship.flagged, false);
});

test('buildEvidence is pure and byte-identical on rebuild, also when record keys and array inputs arrive in another order', () => {
  const a = inputs();
  const first = serialise(buildEvidence(a));
  assert.equal(serialise(buildEvidence(a)), first);
  const reversed: Record<string, FamilySessions[]> = {};
  for (const [k, v] of Object.entries(a.sessions).reverse()) reversed[k] = [...v].reverse();
  const families: Record<string, FamilyTrust> = {};
  for (const [k, v] of Object.entries(a.status.families).reverse()) families[k] = v;
  const shuffled: EvidenceInputs = {
    ...a, sessions: reversed, status: { ...a.status, families },
    ledger: { schema: 'calib-labels/1', labels: [...a.ledger.labels].reverse() },
    defects: [...a.defects].reverse(), costs: [...a.costs].reverse(), stagnation: [...a.stagnation].reverse(),
    reasons: [...a.reasons].reverse(), pending: [...a.pending].reverse(),
    inputs: Object.fromEntries(Object.entries(a.inputs).reverse()),
  };
  assert.equal(serialise(buildEvidence(shuffled)), first);
  assert.equal(a.ledger.labels[0]?.id, 'C00-P01', 'inputs are not mutated');
});

test('buildEvidence on an R00-shaped input (C00 ledger + status only): AGR, IFA, RES, five empty SAT items and the disagreements', () => {
  const r00: EvidenceInputs = {
    ...inputs(), round: 'R00', benchmarkVersion: 'v1', sessions: {}, reasons: [], defects: [], costs: [], stagnation: [], rollbacks: [], pending: [],
    saturation: { taste: [], hook: [], skin_swap: [], cold_reader: [], surprise: [] },
  };
  const p = buildEvidence(r00);
  assert.deepEqual(p.items.map((i) => i.id), [
    'E-R00-AGR-Anthropic', 'E-R00-AGR-Moonshot', 'E-R00-AGR-OpenAI', 'E-R00-AGR-xAI', 'E-R00-DIS-C00-P02', 'E-R00-IFA', 'E-R00-RES',
    'E-R00-SAT-cold-reader', 'E-R00-SAT-hook', 'E-R00-SAT-skin-swap', 'E-R00-SAT-surprise', 'E-R00-SAT-taste',
  ]);
  assert.deepEqual(p.ceilings, []);
});

test('parseEvidencePacket: a built packet round-trips; wrong ids, order, ceilings, caps or hashes are refused', () => {
  const packet = buildEvidence(inputs(ledgerFixture(), { 'C00-P02': [{ family: 'xAI', source: 'C00-T03', quote: '配给簿' }] }));
  const raw = (): Record<string, unknown> => JSON.parse(serialise(packet));
  assert.deepEqual(parseEvidencePacket(raw()), { ok: true, value: packet });
  const edit = (f: (v: Record<string, unknown>, items: Array<Record<string, unknown>>) => void): string => {
    const v = raw();
    const items: Array<Record<string, unknown>> = Array.isArray(v['items']) ? v['items'] : [];
    f(v, items);
    const r = parseEvidencePacket(v);
    assert.equal(r.ok, false);
    return r.ok ? '' : r.error;
  };
  const at = (items: Array<Record<string, unknown>>, id: string): Record<string, unknown> => items.find((i) => i['id'] === id) ?? {};
  assert.match(edit((_, items) => items.reverse()), /code-unit order/u);
  assert.match(edit((_, items) => { at(items, 'E-R02-AGR-xAI')['family'] = 'OpenAI'; }), /should be E-R02-AGR-OpenAI/u);
  assert.match(edit((v) => { v['ceilings'] = []; }), /ceilings must be exactly \[E-R02-SAT-taste\]/u);
  assert.match(edit((_, items) => { at(items, 'E-R02-SAT-taste')['ceiling'] = false; }), /saturation/u);
  assert.match(edit((_, items) => {
    at(items, 'E-R02-SAT-taste')['rounds'] = [{ round: 'R00', n: 10, top: 7 }, { round: 'R01', n: 10, top: 7 }];
  }), /saturation/u, 'points outside this round and the one before');
  assert.match(edit((_, items) => { at(items, 'E-R02-RES')['extra'] = 1; }), /unexpected property extra/u);
  assert.match(edit((_, items) => { at(items, 'E-R02-STAG-' + sha256('SHIP').slice(0, 8))['flagged'] = true; }), /stagnation/u);
  assert.match(edit((v) => { v['inputs'] = { 'rounds/R02/tally.json': 'not-a-hash' }; }), /expected a SHA-256/u);
  assert.match(edit((_, items) => {
    const d = at(items, 'E-R02-DIS-C00-P02');
    d['texts'] = [{ text_id: 'C00-T03', text: '字'.repeat(EVIDENCE_TEXT_MAX + 1) }, { text_id: 'C00-T04', text: 'x' }];
  }), /longer than 2500/u);
  assert.match(edit((_, items) => { at(items, 'E-R02-RB-1')['id'] = 'E-R02-RB-0'; }), /RB-<n>/u);
  assert.match(edit((v) => { v['round'] = 'R03'; }), /should be E-R03-/u);
});

test('readEvidencePacket: null when absent; the packet and the SHA-256 of its bytes; another round\'s packet or bad JSON is an error', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-evidence-read-'));
  assert.equal(readEvidencePacket(root, 'R02'), null);
  const packet = buildEvidence(inputs());
  mkdirSync(join(root, 'benchmark', 'evidence'), { recursive: true });
  const bytes = serialise(packet);
  writeFileSync(join(root, evidencePath('R02')), bytes);
  assert.deepEqual(readEvidencePacket(root, 'R02'), { ok: true, value: { packet, sha256: sha256Bytes(Buffer.from(bytes)) } });
  writeFileSync(join(root, evidencePath('R03')), bytes);
  assert.deepEqual(readEvidencePacket(root, 'R03'), { ok: false, error: 'benchmark/evidence/R03.json holds the packet of R02' });
  writeFileSync(join(root, evidencePath('R04')), '{');
  const bad = readEvidencePacket(root, 'R04');
  assert.ok(bad !== null && !bad.ok && bad.error.startsWith('benchmark/evidence/R04.json is not valid JSON'));
});
