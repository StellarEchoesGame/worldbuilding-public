import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { IntegrityError } from './calls.ts';
import type { Family } from './config.ts';
import {
  championSchedule, decoyPosition, effectiveFamilies, pairVerdicts, parsePairsFile, readPairsFile, rerunPlan, sessionVoid, tasteCallPath,
  type FamilySessions, type PairKind, type PairsFile, type SessionCall, type TasteCallFile,
} from './pairs.ts';
import { loadSchema, validate } from './schema.ts';
import { roundPaths, type RoundPaths } from './store.ts';
import { tasteTaskId, type Order } from './tasks/ids.ts';

const SEED = 'seed-pairs';

function call(status: 'ok' | 'void', preferredDecoy = false, order: Order = 'fwd'): SessionCall {
  return { taskId: 'taste-W1-xAI-s0-fwd', order, status, decisive: status === 'ok' ? 'W1' : null, preferredDecoy };
}

test('decoyPosition is seeded per pair, family, session, rerun and order', () => {
  const a = decoyPosition(SEED, 'W1', 'xAI', 0, false, 'fwd');
  assert.equal(a, decoyPosition(SEED, 'W1', 'xAI', 0, false, 'fwd'));
  const all = ['fwd', 'rev'].flatMap((o) => [0, 1].flatMap((k) => [false, true].map((r) => decoyPosition(SEED, 'W1', 'xAI', k, r, o === 'fwd' ? 'fwd' : 'rev'))));
  assert.ok(all.every((p) => p === 3 || p === 4));
  const spread = new Set(['W1', 'W2', 'W3', 'W4', 'W5', 'W6'].map((p) => decoyPosition(SEED, p, 'Anthropic', 0, false, 'rev')));
  assert.equal(spread.size, 2, 'both positions occur');
});

test('championSchedule: E × session pairs × (fwd, rev) sorted, then shadow families; ids follow tasks/ids.ts', () => {
  const plans = championSchedule(['xAI', 'Anthropic'], ['Moonshot'], SEED, 'W1', 2);
  assert.deepEqual(plans.map((p) => `${p.family}:${p.session}:${p.shadow}`), ['Anthropic:0:false', 'Anthropic:1:false', 'xAI:0:false', 'xAI:1:false', 'Moonshot:0:true', 'Moonshot:1:true']);
  const first = plans[0];
  assert.ok(first !== undefined);
  if (first === undefined) return;
  assert.deepEqual(first.fwd, { taskId: tasteTaskId('W1', 'Anthropic', 0, false, 'fwd'), order: 'fwd', decoyAt: decoyPosition(SEED, 'W1', 'Anthropic', 0, false, 'fwd') });
  assert.equal(first.rev.taskId, 'taste-W1-Anthropic-s0-rev');
  assert.equal(new Set(plans.flatMap((p) => [p.fwd.taskId, p.rev.taskId])).size, plans.length * 2, 'ids unique per round');
  assert.equal(championSchedule(['xAI'], [], SEED, 'W1', 3).length, 3, 'session count comes from the protocol');
  assert.throws(() => championSchedule(['xAI'], ['xAI'], SEED, 'W1', 2), /both in E and shadow/u);
  assert.throws(() => championSchedule(['xAI'], [], SEED, 'W1', 0), /positive integer/u);
});

test('rerunPlan: s<k>r ids, fresh decoy positions, one rerun only', () => {
  const [plan] = championSchedule(['Moonshot'], [], SEED, 'W2-r2', 2);
  assert.ok(plan !== undefined);
  if (plan === undefined) return;
  const again = rerunPlan(plan, SEED);
  assert.deepEqual([again.fwd.taskId, again.rev.taskId, again.rerun, again.session], ['taste-W2-r2-Moonshot-s0r-fwd', 'taste-W2-r2-Moonshot-s0r-rev', true, 0]);
  assert.equal(again.rev.decoyAt, decoyPosition(SEED, 'W2-r2', 'Moonshot', 0, true, 'rev'));
  assert.throws(() => rerunPlan(again, SEED), /one rerun per session-pair/u);
});

test('sessionVoid: a void call or a decoy preference voids the session-pair', () => {
  assert.equal(sessionVoid(call('ok'), call('ok', false, 'rev')), false);
  assert.equal(sessionVoid(call('void'), call('ok', false, 'rev')), true);
  assert.equal(sessionVoid(call('ok'), call('void', false, 'rev')), true);
  assert.equal(sessionVoid(call('ok', true), call('ok', false, 'rev')), true);
  assert.equal(sessionVoid(call('ok'), call('ok', true, 'rev')), true);
});

test('effectiveFamilies drops shadow and dropped families', () => {
  const fs = (family: Family, shadow: boolean, dropped: boolean): FamilySessions => ({ family, shadow, sessions: [], reruns: [], dropped: dropped ? 'void_after_rerun' : null });
  assert.deepEqual(effectiveFamilies([fs('xAI', false, false), fs('Anthropic', false, false), fs('Moonshot', true, false), fs('OpenAI', false, true)]), ['Anthropic', 'xAI']);
});

interface CallSpec {
  family: Family;
  session: number;
  rerun?: boolean;
  shadow?: boolean;
  fwd?: 'ok' | 'void' | 'decoy';
  rev?: 'ok' | 'void' | 'decoy';
}

function callFile(paths: RoundPaths, kind: PairKind, pair: string, s: CallSpec, order: Order): TasteCallFile {
  const how = (order === 'fwd' ? s.fwd : s.rev) ?? 'ok';
  const status = how === 'void' ? 'void' : 'ok';
  const rerun = s.rerun ?? false;
  return {
    round: paths.id, pair, kind, family: s.family, shadow: s.shadow ?? false, session: s.session, rerun, order,
    task: tasteTaskId(pair, s.family, s.session, rerun, order), text1: order === 'fwd' ? 'W1' : 'BASE', text2: order === 'fwd' ? 'BASE' : 'W1',
    status, picks: status === 'ok' ? { q1: 'W1' } : {}, quotes: status === 'ok' ? { q1: '引文引文引文引文' } : {}, decisive: status === 'ok' ? 'W1' : null,
    decoy_at: kind === 'champion' ? 3 : null, decoy_pick: kind === 'champion' && status === 'ok' ? (how === 'decoy' ? 3 : 4) : null,
    preferred_decoy: how === 'decoy', error: status === 'void' ? 'void' : null,
  };
}

function writeCalls(paths: RoundPaths, kind: PairKind, pair: string, specs: readonly CallSpec[]): void {
  for (const s of specs) {
    for (const order of ['fwd', 'rev'] satisfies Order[]) {
      const f = callFile(paths, kind, pair, s, order);
      const path = tasteCallPath(paths, kind, pair, f.family, f.session, f.rerun, f.order);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(f, null, 2)}\n`);
    }
  }
}

test('pairVerdicts: a rerun replaces its session; still void → void_after_rerun; shadow kept apart; aux pairs never rerun', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-pairs-'));
  const paths = roundPaths(root, 'R01');
  writeCalls(paths, 'champion', 'W1', [
    { family: 'Anthropic', session: 0 }, { family: 'Anthropic', session: 1, fwd: 'void' }, { family: 'Anthropic', session: 1, rerun: true },
    { family: 'xAI', session: 0 }, { family: 'xAI', session: 1, rev: 'decoy' }, { family: 'xAI', session: 1, rerun: true, fwd: 'decoy' },
    { family: 'Moonshot', session: 0, shadow: true }, { family: 'Moonshot', session: 1, shadow: true },
  ]);
  const fs = pairVerdicts(root, 'R01', 'W1');
  assert.deepEqual(fs.map((f) => [f.family, f.shadow, f.sessions.length, f.reruns, f.dropped]), [
    ['Anthropic', false, 2, [1], null],
    ['Moonshot', true, 2, [], null],
    ['xAI', false, 2, [1], 'void_after_rerun'],
  ]);
  const anthropic = fs[0];
  assert.deepEqual(anthropic?.sessions[1]?.map((c) => c.taskId), ['taste-W1-Anthropic-s1r-fwd', 'taste-W1-Anthropic-s1r-rev']);
  assert.deepEqual(effectiveFamilies(fs), ['Anthropic']);
  writeCalls(paths, 'sub_sub', 'W1.W2', [{ family: 'OpenAI', session: 0, rev: 'void' }]);
  const aux = pairVerdicts(root, 'R01', 'W1.W2');
  assert.deepEqual(aux.map((f) => [f.family, f.sessions.length, f.sessions[0]?.[1]?.status, f.reruns, f.dropped]), [['OpenAI', 1, 'void', [], null]]);
  assert.deepEqual(pairVerdicts(root, 'R01', 'W3'), [], 'no directory → no sessions');
  rmSync(root, { recursive: true });
});

test('pairVerdicts refuses an incomplete or tampered set with IntegrityError', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-pairs-'));
  const paths = roundPaths(root, 'R01');
  writeCalls(paths, 'champion', 'W1', [{ family: 'OpenAI', session: 0 }, { family: 'OpenAI', session: 1 }]);
  rmSync(tasteCallPath(paths, 'champion', 'W1', 'OpenAI', 1, false, 'rev'));
  assert.throws(() => pairVerdicts(root, 'R01', 'W1'), (e: unknown) => e instanceof IntegrityError && /OpenAI s1: both the fwd and the rev/u.test(e.message));
  writeCalls(paths, 'champion', 'W1', [{ family: 'OpenAI', session: 1 }]);
  const path = tasteCallPath(paths, 'champion', 'W1', 'OpenAI', 0, false, 'fwd');
  writeFileSync(path, readFileSync(path, 'utf8').replace('"status": "ok"', '"status": "maybe"'));
  assert.throws(() => pairVerdicts(root, 'R01', 'W1'), (e: unknown) => e instanceof IntegrityError && /OpenAI-s0-fwd\.json: kind, family, order or status/u.test(e.message));
  writeCalls(paths, 'champion', 'W1', [{ family: 'OpenAI', session: 0 }]);
  writeFileSync(tasteCallPath(paths, 'champion', 'W1', 'xAI', 0, false, 'fwd'), readFileSync(path, 'utf8'));
  assert.throws(() => pairVerdicts(root, 'R01', 'W1'), /does not match the file name/u);
  rmSync(root, { recursive: true });
});

test('readPairsFile / parsePairsFile: the schema shape plus TextRefs; schema/pairs.schema.json accepts it', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-pairs-'));
  const paths = roundPaths(root, 'R01');
  const file: PairsFile = {
    round: 'R01', champion: 'BASE',
    texts: {
      W1: { id: 'W1', kind: 'submission', file: 'rounds/R01/submissions/W1.json', sha256: 'a'.repeat(64), authors: ['DeepSeek'] },
      BASE: { id: 'BASE', kind: 'champion', file: 'rounds/R01/champion.json', sha256: 'b'.repeat(64), authors: ['DeepSeek'] },
    },
    pairs: [{ id: 'W1', kind: 'champion', left: 'W1', right: 'BASE', families: ['Anthropic', 'xAI'], shadow: [], effective: ['Anthropic'], dropped: ['xAI'] }],
  };
  assert.equal(readPairsFile(paths, 'champion').ok, false, 'missing file → err');
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(join(paths.dir, 'pairs.json'), JSON.stringify(file));
  assert.deepEqual(readPairsFile(paths, 'champion'), { ok: true, value: file });
  const schema = loadSchema(JSON.parse(readFileSync(new URL('../schema/pairs.schema.json', import.meta.url), 'utf8')));
  assert.ok(schema.ok);
  if (schema.ok) assert.deepEqual(validate(schema.value, file), []);
  const bad = (patch: Record<string, unknown>): boolean => parsePairsFile({ ...file, ...patch }).ok;
  assert.equal(bad({ texts: { ...file.texts, W1: { ...file.texts['W1'], id: 'W2' } } }), false, 'id must equal its key');
  assert.equal(bad({ texts: { BASE: file.texts['BASE'] } }), false, 'pairs must name texts');
  assert.equal(bad({ pairs: [{ ...file.pairs[0], families: ['Nobody'] }] }), false, 'unknown family');
  rmSync(root, { recursive: true });
});
