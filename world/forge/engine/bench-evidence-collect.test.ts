import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evidenceStep } from './bench-cycle.ts';
import { buildEvidence, collectEvidence, parseEvidencePacket, type EvidenceInputs, type EvidencePacket } from './bench-evidence.ts';
import type { VersionRef } from './bench-log.ts';
import { roundCommand } from './cli-round.ts';
import { loadConfig } from './config.ts';
import { buildContext, type StepContext } from './context.ts';
import { isRecord, readArray, readBoolean, readRecord, readString, type JsonRecord } from './json.ts';
import { sha256Bytes } from './owner-inputs.ts';
import { parseAuditSet } from './steps/owner-waits.ts';
import { roundPaths } from './store.ts';
import { deps, must, pickTopic, ROUND, world, type World } from './testing/round-script.ts';
import { readLabelLedger } from './trust.ts';

/*
 * collectEvidence on the scripted fixture round of testing/round-script.ts (round pipeline, run to 11e-agreement with
 * pick none, so 10a–10f skip): every input is read from the files the real steps wrote and hashed into `inputs`.
 * The bench-r00 pipeline and owner rollbacks are in bench-evidence-r00.test.ts.
 */

const PID = 6101;

async function round(x: World, argv: readonly string[]): Promise<number> {
  return roundCommand(argv, deps(x, PID), x.at);
}

/** The scripted round with the audit answered and a pick-none decision, run through 11e-agreement. */
async function scriptedRound(): Promise<World> {
  const x = world();
  x.sim.approveProtocol();
  assert.equal(await round(x, ['start', ROUND]), 2, x.logs.join('\n'));
  pickTopic(x, join(x.w.root, 'rounds', ROUND));
  assert.equal(await round(x, ['run', ROUND]), 2, x.logs.join('\n'));
  x.sim.answerAudit(ROUND, () => 'left');
  assert.equal(await round(x, ['run', ROUND]), 2, x.logs.join('\n'));
  x.sim.decide(ROUND, { pick: 'none', reason: '平', fav: 'none', publish: 'no', facts: [] });
  assert.equal(await round(x, ['run', ROUND, '--until', '11e-agreement']), 0, x.logs.join('\n'));
  return x;
}

function roundContext(x: World): StepContext {
  const config = must(loadConfig(x.w.root, { requireLocal: true }));
  return must(buildContext({
    root: x.w.root, repo: x.w.repo, roundId: ROUND, pipeline: 'round', paths: roundPaths(x.w.root, ROUND), config, deps: deps(x, PID),
    startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
  }));
}

function v1Head(root: string): VersionRef {
  return { version: 'v1', sha256: sha256Bytes(readFileSync(join(root, 'benchmark', 'v1.json'))), path: 'benchmark/v1.json' };
}

const serialise = (p: EvidencePacket): string => `${JSON.stringify(p, null, 2)}\n`;

test('collectEvidence on a scripted round: freeze, tally, decision reason, champion-pair sessions, gate defects and call costs, all hashed', async () => {
  const x = await scriptedRound();
  const ctx = roundContext(x);
  const collected = collectEvidence(ctx, v1Head(x.w.root));
  assert.ok(collected.ok, collected.ok ? '' : collected.error);
  const input: EvidenceInputs = collected.value;
  assert.equal(input.round, ROUND);
  assert.equal(input.benchmarkVersion, ctx.freeze().benchmark_version);
  assert.deepEqual(input.reasons, [{ round: ROUND, reason: '平' }]);
  const pairs = readArray(JSON.parse(readFileSync(join(x.w.root, 'rounds', ROUND, 'pairs.json'), 'utf8')), 'pairs') ?? [];
  assert.deepEqual(Object.keys(input.sessions).sort(), pairs.map((p) => readString(p, 'id') ?? '').sort(), 'one session set per champion pair');
  assert.ok(pairs.length > 0);
  assert.equal(input.saturation.taste.length, 1);
  assert.equal(input.saturation.taste[0]?.round, ROUND);
  assert.ok(input.costs.some((c) => c.family === 'DeepSeek' && c.calls > 0), 'writer calls cost');
  assert.ok(input.defects.length > 0 && input.defects.every((d) => d.injected >= d.caught), 'the defect copy was judged');
  const brief: unknown = JSON.parse(readFileSync(join(x.w.root, 'rounds', ROUND, 'brief.json'), 'utf8'));
  const tally: unknown = JSON.parse(readFileSync(join(x.w.root, 'rounds', ROUND, 'tally.json'), 'utf8'));
  const beat = (readArray(tally, 'champion_pairs') ?? []).some((p) => readBoolean(p, 'beats_champion') === true);
  assert.deepEqual(input.stagnation.map((s) => [s.row_id, s.rounds_without_beat]), [[readString(brief, 'row_id'), beat ? 0 : 1]], 'the tally decides a beat, not the pick');
  const ledger = readLabelLedger(x.w.root);
  assert.ok(ledger !== null && ledger.ok);
  const visible = ledger.value.labels.filter((l) => l.split === 'visible');
  assert.ok(visible.some((l) => l.round === ROUND), 'the R01 audit labels are in the ledger');
  for (const l of visible) for (const t of l.texts) assert.equal(typeof input.visibleTexts[t.sha256], 'string', `${l.id} ${t.id}`);
  for (const rel of [
    `rounds/${ROUND}/freeze.json`, `rounds/${ROUND}/tally.json`, `rounds/${ROUND}/brief.json`, `rounds/${ROUND}/audit.json`, `rounds/${ROUND}/decision.json`,
    `rounds/${ROUND}/pairs.json`, 'calibration/labels.json', 'calibration/status.json',
  ]) assert.equal(input.inputs[rel], sha256Bytes(readFileSync(join(x.w.root, rel))), rel);
  for (const log of ['benchmark/log.jsonl', 'owner-log.jsonl']) assert.equal(input.inputs[log], undefined, `append-only ${log} is read, never hashed`);
  for (const dir of ['taste', 'calls', 'gate', 'submissions']) {
    assert.match(input.inputs[`rounds/${ROUND}/${dir}/*`] ?? '', /^[0-9a-f]{64}$/u, `${dir}: one aggregate key for the directory`);
  }
  const perFile = Object.keys(input.inputs).filter((p) => /^rounds\/[^/]+\/[^/]+\/./u.test(p) && !p.endsWith('/*'));
  assert.deepEqual(perFile, [], 'no per-file key below a round sub-directory (file names carry pair and submission ids)');

  const packet = buildEvidence(input);
  const text = serialise(packet);
  const again = collectEvidence(roundContext(x), v1Head(x.w.root));
  assert.ok(again.ok);
  assert.equal(serialise(buildEvidence(again.value)), text, 'a rebuild from unchanged files is byte-identical');
  const parsed = parseEvidencePacket(JSON.parse(text));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  assert.deepEqual(parsed.value, packet);
  for (const l of ledger.value.labels.filter((r) => r.split === 'reserve')) assert.equal(text.includes(l.id), false, `reserve label ${l.id}`);
  assert.ok(packet.items.some((i) => i.id === `E-${ROUND}-RC`));
  assert.ok(packet.items.some((i) => i.kind === 'order_consistency'));
});


test('reserve audit pairs: no pair id reaches the serialised packet; one changed call file moves only the taste aggregate', async () => {
  const x = await scriptedRound();
  const set = parseAuditSet(JSON.parse(readFileSync(join(x.w.root, 'rounds', ROUND, 'audit-set.json'), 'utf8')));
  assert.ok(set !== null);
  const reserve = set.pairs.filter((p) => p.split === 'reserve');
  const champion = reserve.find((p) => p.kind === 'champion');
  assert.ok(champion !== undefined, 'the fixture draws a reserve champion pair (its call files are read for ORD / VOID)');
  const first = collectEvidence(roundContext(x), v1Head(x.w.root));
  assert.ok(first.ok, first.ok ? '' : first.error);
  const packet = buildEvidence(first.value);
  // A champion pair id is its submission's id, which a visible label may show: that text id is the one allowed occurrence.
  let text = serialise(packet);
  for (const item of packet.items) {
    if (item.kind !== 'disagreement') continue;
    for (const t of item.texts) text = text.replaceAll(`"text_id": ${JSON.stringify(t.text_id)}`, '"text_id": ""');
  }
  for (const p of reserve) assert.equal(text.includes(p.pair), false, `reserve pair ${p.pair} (${p.label})`);
  for (const p of reserve) assert.equal(Object.keys(packet.inputs).some((k) => k.includes(p.pair)), false, `input key naming ${p.pair}`);

  const dir = join(x.w.root, 'rounds', ROUND, 'taste', champion.pair);
  const name = readdirSync(dir).filter((n) => n.endsWith('.json')).sort()[0];
  assert.ok(name !== undefined);
  writeFileSync(join(dir, name), `${readFileSync(join(dir, name), 'utf8')}\n`);
  const second = collectEvidence(roundContext(x), v1Head(x.w.root));
  assert.ok(second.ok, second.ok ? '' : second.error);
  const key = `rounds/${ROUND}/taste/*`;
  assert.notEqual(second.value.inputs[key], first.value.inputs[key], 'the aggregate covers the reserve pair\'s call file');
  assert.deepEqual({ ...second.value.inputs, [key]: '' }, { ...first.value.inputs, [key]: '' }, 'every other input is unchanged');
  assert.deepEqual(buildEvidence(second.value).items, packet.items, 'same verdicts, same items');
});

test('11f rerun after an unrelated owner action: the packet is rebuilt byte-identical (the append-only logs are not hashed)', async () => {
  const x = await scriptedRound();
  const first = await evidenceStep.run(roundContext(x), null);
  assert.equal(first.kind, 'done');
  const listed = first.kind === 'done' ? first.inputs : [];
  assert.ok(listed.some((p) => p.startsWith(`rounds/${ROUND}/gate/`)), 'the 11f marker lists the files it read, not the folded packet keys');
  assert.ok(listed.every((p) => !p.endsWith('/*')), 'no aggregate key is a marker input');
  const text = readFileSync(join(x.w.root, 'benchmark', 'evidence', `${ROUND}.json`), 'utf8');
  x.sim.viewBenchDiff('v1');
  const again = await evidenceStep.run(roundContext(x), null);
  assert.equal(again.kind, 'done', 'an owner-log append between the packet write and the marker is not an integrity error');
  assert.equal(readFileSync(join(x.w.root, 'benchmark', 'evidence', `${ROUND}.json`), 'utf8'), text);
});

test('collectEvidence: a malformed tally.json (a field missing or renamed) is an error naming the file, never a silent zero', async () => {
  const x = await scriptedRound();
  const rel = `rounds/${ROUND}/tally.json`;
  const path = join(x.w.root, rel);
  const original = readFileSync(path, 'utf8');
  const edited = (edit: (tally: JsonRecord) => void): string => {
    const tally: unknown = JSON.parse(original);
    assert.ok(isRecord(tally));
    edit(tally);
    writeFileSync(path, `${JSON.stringify(tally, null, 2)}\n`);
    const r = collectEvidence(roundContext(x), v1Head(x.w.root));
    assert.equal(r.ok, false, 'a malformed tally must not yield a packet');
    return r.ok ? '' : r.error;
  };
  assert.match(edited((t) => { delete t['session_pairs']; }), /rounds\/R\d\d\/tally\.json/u);
  const renamed = edited((t) => {
    const measures = readRecord(t, 'measures');
    const first = measures === null ? undefined : Object.values(measures).find(isRecord);
    const surprise = readRecord(first, 'surprise');
    assert.ok(surprise !== null, 'the scripted round has per-text measures');
    surprise['eligible_count'] = surprise['eligible'];
    delete surprise['eligible'];
  });
  assert.match(renamed, /rounds\/R\d\d\/tally\.json/u);
  writeFileSync(path, original);
  assert.ok(collectEvidence(roundContext(x), v1Head(x.w.root)).ok, 'the untouched tally reads again');
});
