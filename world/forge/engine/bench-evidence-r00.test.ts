import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fakeBackend } from './adapters/fake.ts';
import { buildEvidence, collectEvidence, UNVERIFIED_QUOTE_PREFIX } from './bench-evidence.ts';
import { appendBenchLogOnce, writeVersion, type BenchOutcome, type VersionRef } from './bench-log.ts';
import { CALIB_ORDERS, calibTaskId } from './calib-run.ts';
import { loadConfig, type Family } from './config.ts';
import { buildContext, type RoundBackends, type StepContext } from './context.ts';
import { isRecord, type JsonRecord } from './json.ts';
import { sha256Bytes } from './owner-inputs.ts';
import { roundPaths, sha256 } from './store.ts';
import { fakePorts, type FakePorts } from './testing/fakes.ts';
import { DEFAULT_FIXTURE, fixtureWorld } from './testing/fixture-world.ts';
import { ownerSim, type OwnerSim } from './testing/owner-sim.ts';
import type { Label, LabelText } from './trust.ts';

/*
 * collectEvidence on the bench-r00 pipeline (cycle R00): the C00 ledger, trust status, pin and visible C00 texts and
 * verdicts only (no freeze, tally or decision). Owner rollbacks and approvals come through owner-sim; reserve texts
 * and reserve verdicts exist on disk but are never read.
 */

const FAMILIES: readonly Family[] = ['Anthropic', 'Moonshot', 'OpenAI', 'xAI'];
const RESERVE_MARK = '预备文本';
const PID = 6201;

interface Harness {
  root: string;
  ports: FakePorts;
  sim: OwnerSim;
  ctx(): StepContext;
  reserveBodies: string[];
}

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

/** C00 texts, labels (P01–P02 visible, P03–P04 reserve; Moonshot against the owner on P02 and P04), verdicts and pin. */
function writeC00(root: string): string[] {
  const reserveBodies: string[] = [];
  const labels: Label[] = [];
  for (let i = 1; i <= 4; i += 1) {
    const reserve = i > 2;
    const texts: LabelText[] = [];
    for (const side of ['甲', '乙']) {
      const id = `C00-T${String(2 * i - (side === '甲' ? 1 : 0)).padStart(2, '0')}`;
      const body = reserve ? `${RESERVE_MARK}${id}：舱壁上的水珠${side}一颗颗滚落。` : `${id}：配给簿上多了一行字，${side}是昨夜补记的。`;
      if (reserve) reserveBodies.push(body);
      put(root, `calibration/texts/${id}.md`, body);
      texts.push({ id, path: `calibration/texts/${id}.md`, sha256: sha256(body), authors: ['OpenAI'] });
    }
    const [a, b] = texts;
    if (a === undefined || b === undefined) throw new Error('two texts');
    const pair = `C00-P${String(i).padStart(2, '0')}`;
    const trials: Label['trials'] = {};
    for (const f of FAMILIES) {
      const against = f === 'Moonshot' && i % 2 === 0;
      trials[f] = { sessions: 1, consistent: true, agree: !against, void: 0 };
      for (const order of CALIB_ORDERS) {
        const [t1, t2] = order === 'ab' ? [a.id, b.id] : [b.id, a.id];
        const picked = against ? b.id : a.id;
        const quote = against ? (f === 'Moonshot' && order === 'ab' ? '水珠都在骗人' : '昨夜补记') : '配给簿';
        put(root, `calibration/C00/verdicts/${f}/${pair}-${order}.json`, json({
          pair, family: f, judge: `judge-${f}`, order, text1: t1, text2: t2, status: 'ok', decisive: picked, picks: { q1: picked },
          quotes: { q1: reserve ? `${quote}${RESERVE_MARK}` : quote }, error: null, call: calibTaskId(pair, `judge-${f}`, order), benchmark_version: 'v1',
        }));
      }
    }
    labels.push({
      id: pair, source: 'round0', round: 'C00', seq: i, texts, owner_chosen: a.id, answered_at: '2026-09-02T00:00:00.000Z', split: reserve ? 'reserve' : 'visible',
      use: 'qualification', trials,
    });
  }
  put(root, 'calibration/labels.json', json({ schema: 'calib-labels/1', labels }));
  const bench = readFileSync(join(root, 'benchmark', 'v1.json'));
  put(root, 'calibration/C00/pin.json', json({
    set: 'C00', benchmark_version: 'v1', benchmark_sha256: sha256Bytes(bench), protocol_bundle_sha256: 'e'.repeat(64), pairs_sha256: 'f'.repeat(64),
    answers_sha256: '0'.repeat(64), judges: Object.fromEntries(FAMILIES.map((f) => [f, { id: `judge-${f}`, model: `${f.toLowerCase()}-fixture` }])),
  }));
  return reserveBodies;
}

function harness(): Harness {
  const w = fixtureWorld(mkdtempSync(join(tmpdir(), 'forge-bench-evidence-')), DEFAULT_FIXTURE);
  const config = loadConfig(w.root, { requireLocal: true });
  if (!config.ok) throw new Error(config.error);
  const ports = fakePorts({ repoDir: w.repo, main: w.main, startIso: '2026-10-01T00:00:00.000Z', seed: 'bench-evidence-seed' });
  const reply = (): string => '```json\n{}\n```';
  const judges = config.value.judges.map((j) => ({ backend: fakeBackend(j.id, j.family, reply), concurrency: j.concurrency }));
  const gateway = fakeBackend('gateway', 'DeepSeek', reply);
  const backends: RoundBackends = {
    writers: [{ slot: 'W1', backend: gateway }], baseline: gateway, decoy: gateway, defect: gateway, judges, forecasters: [],
    maintainer: fakeBackend('maintainer', 'Anthropic', reply), mergeEditor: fakeBackend('merge_editor', 'Anthropic', reply), calibGateway: new Map(),
  };
  const reserveBodies = writeC00(w.root);
  const ctx = (): StepContext => {
    const built = buildContext({
      root: w.root, repo: w.repo, roundId: 'R00', pipeline: 'bench-r00', paths: roundPaths(w.root, 'R00'), config: config.value,
      deps: { ports, backends: () => backends, env: {}, pid: PID, isAlive: (p) => p === PID, log: () => undefined }, startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
    });
    if (!built.ok) throw new Error(built.error);
    return built.value;
  };
  return { root: w.root, ports, sim: ownerSim(w.root, ports.clock), ctx, reserveBodies };
}

/** Writes benchmark/<version>.json (v1 with `edit` applied) and logs it with `outcome` at the fake clock. */
function logVersion(h: Harness, cycle: string, outcome: BenchOutcome, version: string, edit: JsonRecord): VersionRef {
  const v1: unknown = JSON.parse(readFileSync(join(h.root, 'benchmark', 'v1.json'), 'utf8'));
  if (!isRecord(v1)) throw new Error('v1 is not an object');
  const ctx = h.ctx();
  const written = writeVersion(ctx.files, h.root, { ...v1, ...edit, version, parent: 'v1' });
  if (!written.ok) throw new Error(written.error);
  h.ports.clock.advance(1000);
  appendBenchLogOnce(ctx.files, h.root, {
    at: h.ports.clock.now(), cycle, outcome, version, parent: 'v1', sha256: written.value.sha256, path: written.value.path, activation: 'owner',
    changed_keys: Object.keys(edit), evidence_packet: null, evidence_packet_sha256: null, evidence_ids: [], reasons: [], errors: [], replay: null,
    dropped_cliches: [], protocol_bundle_sha256: ctx.bundleSha256, calls: [], source: 'engine',
  });
  h.ports.clock.advance(1000);
  return written.value;
}

function head(root: string): VersionRef {
  return { version: 'v1', sha256: sha256Bytes(readFileSync(join(root, 'benchmark', 'v1.json'))), path: 'benchmark/v1.json' };
}

const DECOY_3 = { decoy_recipe: { details: 3, instructions: '把现任稿中最具体的三个细节换成泛泛的同类说法，长度、段落和格式保持不变。' } };

test('collectEvidence (bench-r00): C00 ledger, status, pin, visible texts and verdicts only; owner rollback keys and pending versions', () => {
  const h = harness();
  // v2 pending, then the owner rolls back to v1 (superseding v2), then v3 pending (unapproved, unsuperseded).
  // one cycle each: appendBenchLogOnce skips a line whose cycle is already logged (v1 is R00-init)
  logVersion(h, 'R00', 'pending_owner', 'v2', DECOY_3);
  h.sim.rollback('v1', 'v2');
  logVersion(h, 'R01', 'pending_owner', 'v3', { cliche_list: ['仿佛'] });
  const r = collectEvidence(h.ctx(), head(h.root));
  assert.ok(r.ok, r.ok ? '' : r.error);
  const input = r.value;
  assert.deepEqual([input.round, input.benchmarkVersion], ['R00', 'v1']);
  assert.deepEqual([input.sessions, input.reasons, input.defects, input.costs, input.stagnation], [{}, [], [], [], []]);
  assert.deepEqual(Object.values(input.saturation).map((s) => s.length), [0, 0, 0, 0, 0]);
  const rollback = h.ctx().owner.rollbacks()[0];
  assert.ok(rollback !== undefined);
  assert.deepEqual(input.rollbacks, [{ at: rollback.at, version: 'v1', from: 'v2', keys: ['decoy_recipe'] }]);
  assert.deepEqual(input.pending.map((p) => p.version), ['v3'], 'v2 was superseded by the rollback');
  const read = Object.keys(input.inputs).sort();
  assert.deepEqual(read, [
    'benchmark/v1.json', 'benchmark/v2.json', 'calibration/C00/pin.json',
    ...FAMILIES.flatMap((f) => ['ab', 'ba'].map((o) => `calibration/C00/verdicts/${f}/C00-P01-${o}.json`)),
    ...FAMILIES.flatMap((f) => ['ab', 'ba'].map((o) => `calibration/C00/verdicts/${f}/C00-P02-${o}.json`)),
    'calibration/labels.json', 'calibration/status.json', ...['01', '02', '03', '04'].map((n) => `calibration/texts/C00-T${n}.md`),
  ].sort(), 'reserve texts (T05–T08) and reserve verdicts (P03, P04) are never read; the append-only logs are never hashed');
  for (const [rel, hash] of Object.entries(input.inputs)) assert.equal(hash, sha256Bytes(readFileSync(join(h.root, rel))), rel);

  const packet = buildEvidence(input);
  const text = `${JSON.stringify(packet, null, 2)}\n`;
  for (const body of h.reserveBodies) assert.equal(text.includes(body), false);
  for (const id of ['C00-P03', 'C00-P04', 'C00-T05', 'C00-T06', 'C00-T07', 'C00-T08', RESERVE_MARK]) assert.equal(text.includes(id), false, id);
  assert.ok(packet.items.some((i) => i.id === 'E-R00-PEND-v3'));
  assert.ok(packet.items.some((i) => i.id === 'E-R00-RB-1'));
  const agr = packet.items.find((i) => i.id === 'E-R00-AGR-Moonshot');
  assert.deepEqual(agr?.kind === 'agreement' ? [agr.n, agr.agree] : null, [4, 2], 'reserve labels count in AGR');
  const dis = packet.items.find((i) => i.id === 'E-R00-DIS-C00-P02');
  assert.ok(dis !== undefined && dis.kind === 'disagreement');
  const moonshot = dis.panel.find((p) => p.family === 'Moonshot');
  assert.deepEqual([moonshot?.choice, moonshot?.quotes], [1, [`${UNVERIFIED_QUOTE_PREFIX}水珠都在骗人`, '昨夜补记']]);
  assert.deepEqual(dis.panel.find((p) => p.family === 'OpenAI')?.quotes, ['配给簿']);
  assert.equal(`${JSON.stringify(buildEvidence(must(collectEvidence(h.ctx(), head(h.root)))), null, 2)}\n`, text, 'byte-identical rebuild');

  h.sim.approveBench('v3');
  assert.deepEqual(must(collectEvidence(h.ctx(), head(h.root))).pending, [], 'an approved pending version is no longer pending');
});

test('collectEvidence (bench-r00): a changed visible text, a missing pin or a missing ledger is an error naming the file; a changed reserve text is never read', () => {
  const h = harness();
  writeFileSync(join(h.root, 'calibration', 'texts', 'C00-T03.md'), '被改过的文本');
  const changed = collectEvidence(h.ctx(), head(h.root));
  assert.deepEqual(changed, { ok: false, error: 'label C00-P02: calibration/texts/C00-T03.md does not match the hash labels.json records for C00-T03' });
  const h2 = harness();
  writeFileSync(join(h2.root, 'calibration', 'texts', 'C00-T07.md'), '保留组的文本改了也不会被读到');
  assert.ok(collectEvidence(h2.ctx(), head(h2.root)).ok, 'a changed reserve text is never read');
  rmSync(join(h2.root, 'calibration', 'C00', 'pin.json'));
  assert.deepEqual(collectEvidence(h2.ctx(), head(h2.root)), { ok: false, error: 'calibration/C00/pin.json is missing' });
  rmSync(join(h2.root, 'calibration', 'labels.json'));
  assert.deepEqual(collectEvidence(h2.ctx(), head(h2.root)), { ok: false, error: 'calibration/labels.json is missing' });
});

function must<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
