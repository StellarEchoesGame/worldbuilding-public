import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBenchLogOnce, BENCH_LOG, loadVersion, nextVersion, parseBenchLog, readBenchLog, writeVersion, type BenchLogEntry, type ReplaySummary } from './bench-log.ts';
import { roundFiles, type RoundFiles } from './context.ts';

const HEX = (c: string): string => c.repeat(64);
const sha = (text: string): string => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

function entry(over: Partial<BenchLogEntry> = {}): BenchLogEntry {
  return {
    at: '2026-10-01T00:00:00.000Z',
    cycle: 'R01',
    outcome: 'activate',
    version: 'v2',
    parent: 'v1',
    sha256: HEX('a'),
    path: 'benchmark/v2.json',
    activation: 'auto',
    changed_keys: ['cliche_list'],
    evidence_packet: 'benchmark/evidence/R01.json',
    evidence_packet_sha256: HEX('b'),
    evidence_ids: ['E-R01-AGR-Moonshot'],
    reasons: [{ text: '陈词清单补一条。', keys: ['cliche_list'], evidence_ids: ['E-R01-AGR-Moonshot'] }],
    errors: [],
    replay: null,
    dropped_cliches: [],
    protocol_bundle_sha256: HEX('c'),
    calls: ['rounds/R01/calls/bench-propose-R01-a1.json'],
    source: 'engine',
    ...over,
  };
}

function plain(value: unknown): unknown {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return parsed;
}

function world(): { root: string; files: RoundFiles } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-bench-log-'));
  const repo = join(dir, 'repo');
  const root = join(repo, 'world', 'forge');
  mkdirSync(join(root, 'benchmark'), { recursive: true });
  mkdirSync(join(repo, 'world', 'current'), { recursive: true });
  return { root, files: roundFiles(root, repo) };
}

const failedReplay: ReplaySummary = {
  labels: ['R01-audit-3', 'C00-P04'],
  families: ['Moonshot', 'OpenAI'],
  pooled: { old: 5, new: 3, n: 6 },
  per_family: { Moonshot: { old: 3, new: 1, n: 3, void: 0 }, OpenAI: { old: 2, new: 2, n: 3, void: 1 } },
  passed: false,
  reason: 'family_drop',
};

test('parseBenchLog accepts activate, pending, rejected and no_change lines', () => {
  const lines = [
    entry({ cycle: 'R00-init', version: 'v1', parent: null, path: 'benchmark/v1.json', outcome: 'pending_owner', activation: 'owner', evidence_packet: null, evidence_packet_sha256: null, evidence_ids: [], reasons: [] }),
    entry({ at: '2026-10-02T00:00:00.000Z', cycle: 'R00' }),
    entry({ at: '2026-10-02T00:00:00.000Z', cycle: 'R01', outcome: 'rejected_by_replay', version: 'v3', path: 'rounds/R01/bench/candidate.json', activation: 'replay', replay: failedReplay }),
    entry({ at: '2026-10-03T00:00:00Z', cycle: 'R02', outcome: 'no_change', version: null, sha256: null, path: null, activation: null }),
  ];
  const parsed = parseBenchLog(lines.map(plain));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  assert.deepEqual(parsed.value, lines);
});

test('parseBenchLog rejects unknown outcomes, duplicate cycles, non-hex hashes and a backwards at', () => {
  const bad: Array<[string, unknown[]]> = [
    ['unknown outcome', [{ ...entry(), outcome: 'activated' }]],
    ['duplicate cycle', [entry({ version: 'v2' }), entry({ version: 'v3', path: 'benchmark/v3.json', at: '2026-10-02T00:00:00.000Z' })]],
    ['non-hex sha256', [entry({ sha256: 'A'.repeat(64) })]],
    ['short bundle hash', [entry({ protocol_bundle_sha256: 'abc' })]],
    ['at backwards', [entry({ cycle: 'R01' }), entry({ cycle: 'R02', version: 'v3', path: 'benchmark/v3.json', at: '2026-09-30T23:59:59.000Z' })]],
    ['reused version', [entry({ cycle: 'R01', outcome: 'rejected_validate' }), entry({ cycle: 'R02' })]],
    ['activate without path', [entry({ path: null })]],
    ['activate path of another version', [entry({ path: 'benchmark/v9.json' })]],
    ['pending with auto activation', [entry({ outcome: 'pending_owner', activation: 'auto' })]],
    ['activate with owner activation', [entry({ activation: 'owner' })]],
    ['rejected_by_replay without replay', [entry({ outcome: 'rejected_by_replay' })]],
    ['rejected_by_replay with a passed replay', [entry({ outcome: 'rejected_by_replay', replay: { ...failedReplay, passed: true, reason: 'ok' } })]],
    ['unknown per_family family', [entry({ replay: { ...failedReplay, per_family: { Gemini: { old: 1, new: 1, n: 1, void: 0 } } } })]],
    ['extra key', [{ ...entry(), note: 'x' }]],
    ['source ui', [{ ...entry(), source: 'ui' }]],
    ['path with ..', [entry({ outcome: 'rejected_validate', path: 'benchmark/../owner-log.json' })]],
    ['not an object', ['activate']],
  ];
  for (const [name, lines] of bad) assert.equal(parseBenchLog(lines.map(plain)).ok, false, name);
});

test('readBenchLog: missing file is empty, a torn tail is dropped, a bad middle line is an error', () => {
  const w = world();
  assert.deepEqual(readBenchLog(w.root), { ok: true, value: [] });
  const path = join(w.root, BENCH_LOG);
  writeFileSync(path, `${JSON.stringify(entry())}\n{"at":"2026-10-0`);
  const torn = readBenchLog(w.root);
  assert.ok(torn.ok);
  assert.equal(torn.value.length, 1);
  writeFileSync(path, `{"at":\n${JSON.stringify(entry())}\n`);
  const middle = readBenchLog(w.root);
  assert.ok(!middle.ok);
  assert.equal(middle.error, 'benchmark/log.jsonl: line 1 is not a JSON record', 'no absolute path in the error');
  writeFileSync(path, `${JSON.stringify({ ...entry(), outcome: 'weird' })}\n`);
  const bad = readBenchLog(w.root);
  assert.ok(!bad.ok);
  assert.match(bad.error, /^benchmark\/log\.jsonl line 1: /u);
});

test('appendBenchLogOnce appends once per cycle, in canonical key order, after cutting a torn tail', () => {
  const w = world();
  const path = join(w.root, BENCH_LOG);
  const first = entry({ cycle: 'R00-init', version: 'v1', parent: null, path: 'benchmark/v1.json', outcome: 'pending_owner', activation: 'owner' });
  assert.equal(appendBenchLogOnce(w.files, w.root, first), 'appended');
  writeFileSync(path, `${readFileSync(path, 'utf8')}{"at":"torn`);
  const { source, at, ...rest } = entry({ at: '2026-10-05T00:00:00.000Z' });
  const reordered: BenchLogEntry = { source, ...rest, at };
  assert.equal(appendBenchLogOnce(w.files, w.root, reordered), 'appended');
  assert.equal(appendBenchLogOnce(w.files, w.root, entry({ at: '2026-10-06T00:00:00.000Z', version: 'v7', path: 'benchmark/v7.json' })), 'present');
  const lines = readFileSync(path, 'utf8').split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[2], '');
  assert.equal(lines[1], JSON.stringify(plain(entry({ at: '2026-10-05T00:00:00.000Z' }))));
  const log = readBenchLog(w.root);
  assert.ok(log.ok);
  assert.deepEqual(log.value.map((e) => e.cycle), ['R00-init', 'R01']);
});

test('appendBenchLogOnce refuses an invalid entry and leaves the log unchanged', () => {
  const w = world();
  assert.equal(appendBenchLogOnce(w.files, w.root, entry({ at: '2026-10-05T00:00:00.000Z' })), 'appended');
  const before = readFileSync(join(w.root, BENCH_LOG), 'utf8');
  assert.throws(() => appendBenchLogOnce(w.files, w.root, entry({ cycle: 'R02', version: 'v3', path: 'benchmark/v3.json' })), /earlier than the previous line/u);
  assert.throws(() => appendBenchLogOnce(w.files, w.root, entry({ cycle: 'R02', at: '2026-10-06T00:00:00.000Z' })), /burned/u);
  assert.throws(() => appendBenchLogOnce(w.files, w.root, entry({ cycle: 'R02', at: '2026-10-06T00:00:00.000Z', version: 'v3', path: 'benchmark/v2.json' })), /path must be/u);
  assert.equal(readFileSync(join(w.root, BENCH_LOG), 'utf8'), before);
});

test('nextVersion burns rejected numbers and counts version files without a log line', () => {
  const w = world();
  writeFileSync(join(w.root, 'benchmark', 'v0.json'), '{}\n');
  assert.equal(nextVersion(w.root, []), 'v1');
  writeFileSync(join(w.root, 'benchmark', 'v1.json'), '{}\n');
  const rejected = entry({ cycle: 'R01', outcome: 'rejected_validate', version: 'v2', path: 'rounds/R01/bench/candidate.json' });
  assert.equal(nextVersion(w.root, [rejected]), 'v3');
  writeFileSync(join(w.root, 'benchmark', 'v5.json'), '{}\n');
  writeFileSync(join(w.root, 'benchmark', 'v0.1-prototype.json'), '{}\n');
  assert.equal(nextVersion(w.root, [rejected]), 'v6');
  assert.equal(nextVersion(join(w.root, 'nowhere'), []), 'v1');
});

test('writeVersion writes pretty JSON once and refuses different bytes under an existing version', () => {
  const w = world();
  const candidate = { version: 'v2', parent: 'v1', reasons: [], cliche_list: ['时光在指缝间流走'] };
  const text = `${JSON.stringify(candidate, null, 2)}\n`;
  const first = writeVersion(w.files, w.root, candidate);
  assert.deepEqual(first, { ok: true, value: { version: 'v2', sha256: sha(text), path: 'benchmark/v2.json' } });
  assert.equal(readFileSync(join(w.root, 'benchmark', 'v2.json'), 'utf8'), text);
  assert.deepEqual(writeVersion(w.files, w.root, { ...candidate }), first);
  const other = writeVersion(w.files, w.root, { ...candidate, cliche_list: [] });
  assert.ok(!other.ok);
  assert.match(other.error, /different bytes/u);
  assert.equal(readFileSync(join(w.root, 'benchmark', 'v2.json'), 'utf8'), text);
  assert.equal(writeVersion(w.files, w.root, { version: 'v0.1-prototype' }).ok, false);
  assert.equal(writeVersion(w.files, w.root, { version: '../v3' }).ok, false);
  assert.equal(writeVersion(w.files, w.root, {}).ok, false);
});

test('loadVersion re-hashes the file and checks its version field', () => {
  const w = world();
  const written = writeVersion(w.files, w.root, { version: 'v4', parent: 'v3' });
  assert.ok(written.ok);
  const loaded = loadVersion(w.root, written.value);
  assert.deepEqual(loaded, { ok: true, value: { version: 'v4', parent: 'v3' } });
  assert.equal(loadVersion(w.root, { ...written.value, sha256: HEX('0') }).ok, false);
  assert.equal(loadVersion(w.root, { ...written.value, path: 'benchmark/v3.json' }).ok, false);
  assert.equal(loadVersion(w.root, { version: 'v5', sha256: HEX('0'), path: 'benchmark/v5.json' }).ok, false);
  writeFileSync(join(w.root, 'benchmark', 'v4.json'), '{"version":"v4","parent":"v2"}\n');
  const edited = loadVersion(w.root, written.value);
  assert.ok(!edited.ok);
  assert.match(edited.error, /does not match its logged sha256/u);
  const liar = '{"version":"v3"}\n';
  writeFileSync(join(w.root, 'benchmark', 'v4.json'), liar);
  assert.equal(loadVersion(w.root, { version: 'v4', sha256: sha(liar), path: 'benchmark/v4.json' }).ok, false);
});
