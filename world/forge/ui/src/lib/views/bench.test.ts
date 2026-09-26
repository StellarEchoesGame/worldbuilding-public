import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendBenchLogOnce, writeVersion, type BenchLogEntry } from '../../../../engine/bench-log.ts';
import { roundFiles } from '../../../../engine/context.ts';
import { loadProtocolBundle } from '../../../../engine/rules.ts';
import { submitBenchApproval, submitBenchView, submitProtocolApproval, submitRollback } from '../owner.ts';
import { benchVersionPage, benchView, protocolView, versionDiff } from './bench.ts';

const FORGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const at = (hours: number): string => new Date(T0 + hours * 3_600_000).toISOString();

const V1 = { version: 'v1', cliche_list: ['仿佛'], taste: { decisive: 'Q1', questions: [{ id: 'Q1', text: '哪篇更想多待一小时？' }] } };
const V2 = { version: 'v2', cliche_list: ['仿佛', '宛如'], taste: { decisive: 'Q1', questions: [{ id: 'Q1', text: '哪篇更像住在那里的人写的？' }] } };

function line(over: Partial<BenchLogEntry>): BenchLogEntry {
  return {
    at: at(0), cycle: 'R00-init', outcome: 'activate', version: 'v1', parent: null, sha256: null, path: 'benchmark/v1.json', activation: 'auto',
    changed_keys: [], evidence_packet: null, evidence_packet_sha256: null, evidence_ids: [], reasons: [], errors: [], replay: null,
    dropped_cliches: [], protocol_bundle_sha256: 'c'.repeat(64), calls: [], source: 'engine', ...over,
  };
}

/** Temp forge root with the real protocol bundle, v1 (activate, R00-init) and v2 (pending_owner, R00, replay-checked). */
function fixture(): { root: string; sha1: string; sha2: string } {
  const repo = join(mkdtempSync(join(tmpdir(), 'forge-ui-bench-')), 'repo');
  const root = join(repo, 'world', 'forge');
  mkdirSync(join(root, 'benchmark'), { recursive: true });
  mkdirSync(join(repo, 'world', 'current'), { recursive: true });
  for (const f of ['PROTOCOL.md', 'families.json', 'judges.json']) copyFileSync(join(FORGE, f), join(root, f));
  const files = roundFiles(root, repo);
  const v1 = writeVersion(files, root, V1);
  const v2 = writeVersion(files, root, V2);
  assert.ok(v1.ok && v2.ok);
  appendBenchLogOnce(files, root, line({ sha256: v1.value.sha256 }));
  appendBenchLogOnce(files, root, line({
    at: at(2), cycle: 'R00', outcome: 'pending_owner', version: 'v2', parent: 'v1', sha256: v2.value.sha256, path: 'benchmark/v2.json', activation: 'owner',
    changed_keys: ['cliche_list', 'taste.questions'], evidence_ids: ['E-R00-AGR-Moonshot'],
    reasons: [{ text: '换掉决定性问题的措辞。', keys: ['taste.questions'], evidence_ids: ['E-R00-AGR-Moonshot'] }],
    replay: { labels: ['C00-P03'], families: ['Moonshot'], pooled: { old: 3, new: 4, n: 4 }, per_family: { Moonshot: { old: 3, new: 4, n: 4, void: 0 } }, passed: true, reason: 'ok' },
  }));
  return { root, sha1: v1.value.sha256, sha2: v2.value.sha256 };
}

test('versionDiff lists changed, added and removed leaves with JSON paths', () => {
  assert.deepEqual(versionDiff(V1, V1), []);
  assert.deepEqual(versionDiff(V1, V2), [
    { path: 'version', before: '"v1"', after: '"v2"' },
    { path: 'cliche_list[1]', before: null, after: '"宛如"' },
    { path: 'taste.questions[0].text', before: '"哪篇更想多待一小时？"', after: '"哪篇更像住在那里的人写的？"' },
  ]);
  assert.deepEqual(versionDiff({ a: { b: 1 }, 'x.y': [] }, { a: 2 }), [
    { path: 'a', before: '{"b":1}', after: '2' },
    { path: '["x.y"]', before: '[]', after: null },
  ]);
  assert.deepEqual(versionDiff(null, { a: [1], b: {} }), [
    { path: 'a[0]', before: null, after: '1' },
    { path: 'b', before: null, after: '{}' },
  ]);
});

test('benchView lists versions newest first with their log facts and the pending version', () => {
  const { root, sha1, sha2 } = fixture();
  const none = benchView(root, at(3));
  assert.equal(none.logError, null);
  assert.equal(none.effective, null);
  assert.match(none.resolveError ?? '', /no active benchmark/u);
  assert.equal(none.head?.version, 'v1');
  assert.ok(submitBenchView(root, 'v1', sha1, at(1)).ok);
  const view = benchView(root, at(3));
  assert.deepEqual(view.versions.map((v) => v.version), ['v2', 'v1']);
  const [v2, v1] = view.versions;
  assert.ok(v1 !== undefined && v2 !== undefined);
  assert.equal(view.effective?.version, 'v1');
  assert.equal(view.resolveError, null);
  assert.deepEqual(view.pending, [{ version: 'v2', since: at(2) }]);
  assert.equal(v1.viewedAt, at(1));
  assert.equal(v1.fileSha256, sha1);
  assert.equal(v1.rollbackTarget, false);
  assert.deepEqual({ outcome: v2.outcome, parent: v2.parent, activation: v2.activation, cycle: v2.cycle, sha256: v2.sha256, fileSha256: v2.fileSha256 },
    { outcome: 'pending_owner', parent: 'v1', activation: 'owner', cycle: 'R00', sha256: sha2, fileSha256: sha2 });
  assert.equal(v2.pending, true);
  assert.equal(v2.rollbackTarget, false);
  assert.deepEqual(v2.evidenceIds, ['E-R00-AGR-Moonshot']);
  assert.equal(v2.reasons[0]?.text, '换掉决定性问题的措辞。');
  assert.equal(v2.replay?.passed, true);
  rmSync(join(root, '..', '..', '..'), { recursive: true });
});

test('an approved version becomes effective and the old one a rollback target', () => {
  const { root, sha1, sha2 } = fixture();
  assert.ok(submitBenchView(root, 'v1', sha1, at(1)).ok);
  assert.ok(submitBenchApproval(root, 'v2', sha2, at(4)).ok);
  const view = benchView(root, at(5));
  assert.equal(view.effective?.version, 'v2');
  assert.equal(view.effective?.via, 'approved');
  assert.deepEqual(view.pending, []);
  const [v2, v1] = view.versions;
  assert.equal(v2?.approvedAt, at(4));
  assert.equal(v2?.pending, false);
  assert.equal(v2?.rollbackTarget, false);
  assert.equal(v1?.rollbackTarget, true);
  assert.ok(submitRollback(root, { version: 'v1', from: 'v2', sha256: sha1 }, at(6)).ok);
  const back = benchView(root, at(7));
  assert.equal(back.effective?.version, 'v1');
  assert.equal(back.effective?.via, 'rollback');
  assert.deepEqual(back.versions.map((v) => v.rollbackTarget), [true, false]);
  rmSync(join(root, '..', '..', '..'), { recursive: true });
});

test('benchVersionPage renders the diff against the parent and the file text', () => {
  const { root } = fixture();
  const page = benchVersionPage(root, 'v2', at(3));
  assert.ok(page !== null);
  assert.equal(page.version.version, 'v2');
  assert.deepEqual(page.diff.map((d) => d.path), ['version', 'cliche_list[1]', 'taste.questions[0].text']);
  assert.equal(page.text, `${JSON.stringify(V2, null, 2)}\n`);
  const root1 = benchVersionPage(root, 'v1', at(3));
  assert.ok(root1 !== null && root1.diff.every((d) => d.before === null));
  assert.equal(benchVersionPage(root, 'v3', at(3)), null);
  assert.equal(benchVersionPage(root, '../v1', at(3)), null);
  rmSync(join(root, '..', '..', '..'), { recursive: true });
});

test('an edited version file shows its new hash and an unresolved benchmark instead of throwing', () => {
  const { root, sha1 } = fixture();
  assert.ok(submitBenchView(root, 'v1', sha1, at(1)).ok);
  writeFileSync(join(root, 'benchmark/v1.json'), '{"version":"v1"}\n');
  const view = benchView(root, at(3));
  assert.equal(view.effective, null);
  assert.match(view.resolveError ?? '', /edited/u);
  const v1 = view.versions.find((v) => v.version === 'v1');
  assert.equal(v1?.sha256, sha1);
  assert.notEqual(v1?.fileSha256, sha1);
  rmSync(join(root, 'benchmark/v1.json'));
  assert.equal(benchView(root, at(3)).versions.find((v) => v.version === 'v1')?.fileSha256, null);
  rmSync(join(root, '..', '..', '..'), { recursive: true });
});

test('a broken bench log is reported, not thrown', () => {
  const { root } = fixture();
  appendFileSync(join(root, 'benchmark/log.jsonl'), 'not json\n{"at":"x"}\n');
  const view = benchView(root, at(3));
  assert.notEqual(view.logError, null);
  assert.deepEqual(view.versions, []);
  rmSync(join(root, '..', '..', '..'), { recursive: true });
});

test('protocolView shows the bundle hash, file hashes and the approval state', () => {
  const { root } = fixture();
  const bundle = loadProtocolBundle(root);
  assert.ok(bundle.ok);
  const before = protocolView(root);
  assert.equal(before.bundleSha256, bundle.value.bundleSha256);
  assert.equal(before.error, null);
  assert.equal(before.approvedAt, null);
  assert.equal(before.lastApprovedSha256, null);
  assert.deepEqual(before.files.map((f) => f.name), ['PROTOCOL.md', 'families.json', 'judges.json']);
  assert.ok(before.files.every((f) => f.sha256 !== null && /^[0-9a-f]{64}$/u.test(f.sha256)));
  assert.ok(submitProtocolApproval(root, bundle.value.bundleSha256, at(1)).ok);
  const after = protocolView(root);
  assert.equal(after.approvedAt, at(1));
  assert.equal(after.lastApprovedSha256, bundle.value.bundleSha256);
  appendFileSync(join(root, 'families.json'), '\n');
  const changed = protocolView(root);
  assert.equal(changed.approvedAt, null);
  assert.equal(changed.lastApprovedSha256, bundle.value.bundleSha256);
  assert.notEqual(changed.bundleSha256, bundle.value.bundleSha256);
  rmSync(join(root, 'judges.json'));
  const broken = protocolView(root);
  assert.equal(broken.bundleSha256, null);
  assert.match(broken.error ?? '', /judges\.json/u);
  assert.equal(broken.files.find((f) => f.name === 'judges.json')?.sha256, null);
  rmSync(join(root, '..', '..', '..'), { recursive: true });
});

test('protocolView: an unreadable bundle file is named forge-relative; the absolute root never reaches the page', () => {
  const { root } = fixture();
  rmSync(join(root, 'judges.json'));
  const error = protocolView(root).error ?? '';
  assert.match(error, /judges\.json/u);
  assert.ok(!error.includes(root) && !error.includes(tmpdir()), error);
  assert.equal(benchView(root, at(1)).protocol.error, error);
  rmSync(join(root, '..', '..', '..'), { recursive: true });
});

test('an activate version that never took effect is not a rollback target, and submitRollback refuses it', () => {
  const { root, sha1 } = fixture();
  const files = roundFiles(root, join(root, '..', '..'));
  const v3 = writeVersion(files, root, { ...V2, version: 'v3' });
  assert.ok(v3.ok);
  appendBenchLogOnce(files, root, line({ at: at(3), cycle: 'R01', version: 'v3', parent: 'v1', sha256: v3.value.sha256, path: 'benchmark/v3.json' }));
  assert.ok(submitBenchView(root, 'v1', sha1, at(1)).ok);
  const before = benchView(root, at(4));
  assert.equal(before.effective?.version, 'v1');
  assert.equal(before.head?.version, 'v3');
  assert.equal(before.versions.find((v) => v.version === 'v3')?.rollbackTarget, false);
  const refused = submitRollback(root, { version: 'v3', from: 'v1', sha256: v3.value.sha256 }, at(4));
  assert.ok(!refused.ok && refused.status === 409 && /曾经生效或已批准/u.test(refused.error));
  assert.ok(submitBenchView(root, 'v3', v3.value.sha256, at(5)).ok);
  const after = benchView(root, at(6));
  assert.equal(after.effective?.version, 'v3');
  assert.equal(after.versions.find((v) => v.version === 'v3')?.rollbackTarget, false);
  assert.equal(after.versions.find((v) => v.version === 'v1')?.rollbackTarget, true);
  assert.ok(submitRollback(root, { version: 'v1', from: 'v3', sha256: sha1 }, at(7)).ok);
  const back = benchView(root, at(8));
  assert.equal(back.effective?.version, 'v1');
  assert.equal(back.versions.find((v) => v.version === 'v3')?.rollbackTarget, true);
  rmSync(join(root, '..', '..', '..'), { recursive: true });
});
