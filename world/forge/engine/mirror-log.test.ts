import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { roundFiles, type RoundFiles } from './context.ts';
import { appendMirrorEntry, mirroredAt, parseMirrorEntry, postedBenchNotices, readMirrorLog, type MirrorEntry } from './mirror-log.ts';

const SHA = 'd'.repeat(64);

function world(): { root: string; files: RoundFiles } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-mirror-log-'));
  const repo = join(dir, 'repo');
  const root = join(repo, 'world', 'forge');
  mkdirSync(join(repo, 'world', 'current'), { recursive: true });
  mkdirSync(root, { recursive: true });
  return { root, files: roundFiles(root, repo) };
}

function entry(over: Partial<MirrorEntry> = {}): MirrorEntry {
  return {
    at: '2026-10-01T00:00:00.000Z', kind: 'probe', key: 'R01', source_sha256: SHA, status: 'posted',
    comment_id: 7, created_at: '2026-10-01T00:00:01.000Z', url: 'https://github.invalid/fake/issues/2#issuecomment-7', error: null,
    ...over,
  };
}

test('appendMirrorEntry appends JSON lines under rounds/RNN/mirror.jsonl; readMirrorLog reads them back', () => {
  const { root, files } = world();
  assert.deepEqual(readMirrorLog(root, 'R01'), { ok: true, value: [] });
  const failed = entry({ status: 'failed', comment_id: null, created_at: null, url: null, error: 'fake github: createComment failed' });
  appendMirrorEntry(files, 'R01', failed);
  appendMirrorEntry(files, 'R01', entry());
  const text = readFileSync(join(root, 'rounds', 'R01', 'mirror.jsonl'), 'utf8');
  assert.equal(text.split('\n').length, 3);
  assert.deepEqual(readMirrorLog(root, 'R01'), { ok: true, value: [failed, entry()] });
});

test('a torn last line is ignored and cut before the next append; a bad middle line is an error', () => {
  const { root, files } = world();
  appendMirrorEntry(files, 'R01', entry());
  const path = join(root, 'rounds', 'R01', 'mirror.jsonl');
  appendFileSync(path, '{"at":"2026-10-01T00:0');
  assert.equal(readMirrorLog(root, 'R01').ok, true);
  appendMirrorEntry(files, 'R01', entry({ comment_id: 8 }));
  const log = readMirrorLog(root, 'R01');
  assert.ok(log.ok);
  assert.deepEqual(log.value.map((e) => e.comment_id), [7, 8]);
  writeFileSync(path, `not json\n${JSON.stringify(entry())}\n`);
  const bad = readMirrorLog(root, 'R01');
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.match(bad.error, /^rounds\/R01\/mirror\.jsonl: line 1/u);
    assert.ok(!bad.error.includes(root));
  }
});

test('parseMirrorEntry rejects malformed entries, and appendMirrorEntry refuses them', () => {
  const { files } = world();
  const bad: unknown[] = [
    { ...entry(), kind: 'tweet' },
    { ...entry(), status: 'queued' },
    { ...entry(), source_sha256: 'abc' },
    { ...entry(), at: 'yesterday' },
    { ...entry(), comment_id: null },
    { ...entry(), key: '' },
    { ...entry(), error: 3 },
    'line',
  ];
  for (const b of bad) assert.equal(parseMirrorEntry(b).ok, false, JSON.stringify(b));
  assert.throws(() => appendMirrorEntry(files, 'R01', entry({ status: 'posted', url: null })), /posted entry/u);
  assert.throws(() => appendMirrorEntry(files, '../x', entry()), /round id/u);
});

test('mirroredAt returns the created_at of the latest posted entry for (kind, key)', () => {
  const { root, files } = world();
  assert.equal(mirroredAt(root, 'R01', 'probe', 'R01'), null);
  appendMirrorEntry(files, 'R01', entry({ status: 'failed', comment_id: null, created_at: null, url: null, error: 'x' }));
  assert.equal(mirroredAt(root, 'R01', 'probe', 'R01'), null);
  appendMirrorEntry(files, 'R01', entry());
  appendMirrorEntry(files, 'R01', entry({ kind: 'card', created_at: '2026-10-02T00:00:00.000Z' }));
  appendMirrorEntry(files, 'R01', entry({ created_at: '2026-10-03T00:00:00.000Z' }));
  assert.equal(mirroredAt(root, 'R01', 'probe', 'R01'), '2026-10-03T00:00:00.000Z');
  assert.equal(mirroredAt(root, 'R01', 'card', 'R01'), '2026-10-02T00:00:00.000Z');
  assert.equal(mirroredAt(root, 'R01', 'decision', SHA), null);
});

test('postedBenchNotices collects posted bench notices across rounds, earliest per version, sorted by time', () => {
  const { root, files } = world();
  assert.deepEqual(postedBenchNotices(root), []);
  const notice = (key: string, createdAt: string | null, status: MirrorEntry['status'] = 'posted'): MirrorEntry =>
    entry({ kind: 'bench_notice', key, status, created_at: createdAt, comment_id: createdAt === null ? null : 3, url: createdAt === null ? null : 'u', error: createdAt === null ? 'e' : null });
  appendMirrorEntry(files, 'R00', notice('v2', '2026-10-05T00:00:00.000Z'));
  appendMirrorEntry(files, 'R00', notice('v3', null, 'failed'));
  appendMirrorEntry(files, 'R01', notice('v3', '2026-10-04T00:00:00.000Z'));
  appendMirrorEntry(files, 'R01', notice('v2', '2026-10-06T00:00:00.000Z'));
  appendMirrorEntry(files, 'R01', entry());
  mkdirSync(join(root, 'rounds', 'notes'), { recursive: true });
  assert.deepEqual(postedBenchNotices(root), [
    { version: 'v3', createdAt: '2026-10-04T00:00:00.000Z' },
    { version: 'v2', createdAt: '2026-10-05T00:00:00.000Z' },
  ]);
});
