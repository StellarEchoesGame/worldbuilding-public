import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeAssembler } from './fake-assembler.ts';
import { assembleFixtureReference, DEFAULT_FIXTURE, fixtureWorld, type FixtureWorld } from './fixture-world.ts';

function world(): { dir: string; w: FixtureWorld; current: string } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-fake-assembler-'));
  const w = fixtureWorld(dir, DEFAULT_FIXTURE);
  return { dir, w, current: join(w.repo, 'world', 'current') };
}

function read(current: string, rel: string): string {
  return readFileSync(join(current, rel), 'utf8');
}

test('fakeAssembler reproduces the fixture REFERENCE.md and hashes.json byte for byte', async () => {
  const { dir, w, current } = world();
  const a = fakeAssembler(w.repo);
  const r = await a.assemble('8.1');
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.equal(read(current, 'reference/REFERENCE.md'), w.main['world/current/reference/REFERENCE.md']);
  assert.equal(read(current, 'reference/hashes.json'), w.main['world/current/reference/hashes.json']);
  const expected = assembleFixtureReference(current);
  assert.equal(r.value.characters, [...expected.reference].length);
  assert.equal(r.value.referenceBookSha256, expected.hashes['reference_book_sha256']);
  assert.deepEqual(a.revisions(), ['8.1']);
  rmSync(dir, { recursive: true });
});

test('fakeAssembler follows the manifest: a new file and revision change both outputs', async () => {
  const { dir, w, current } = world();
  const manifest: unknown = JSON.parse(read(current, 'reference/manifest.json'));
  assert.ok(typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest));
  writeFileSync(join(current, 'reference/09-scenes-and-people.md'), '# 样本现场\n\n一段。\n');
  writeFileSync(join(current, 'reference/manifest.json'), `${JSON.stringify({ ...manifest, revision: '8.2', files: [...readManifestFiles(current), '09-scenes-and-people.md'] }, null, 2)}\n`);
  const r = await fakeAssembler(w.repo).assemble('8.2');
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.ok(read(current, 'reference/REFERENCE.md').endsWith('# 样本现场\n\n一段。\n'));
  const hashes: unknown = JSON.parse(read(current, 'reference/hashes.json'));
  assert.ok(typeof hashes === 'object' && hashes !== null && !Array.isArray(hashes));
  assert.equal(Reflect.get(hashes, 'reference_revision'), '8.2');
  assert.equal(Reflect.get(hashes, 'base_book_sha256'), JSON.parse(w.main['world/current/reference/hashes.json'] ?? '{}')['base_book_sha256']);
  rmSync(dir, { recursive: true });
});

function readManifestFiles(current: string): string[] {
  const raw: unknown = JSON.parse(read(current, 'reference/manifest.json'));
  const files: unknown = typeof raw === 'object' && raw !== null ? Reflect.get(raw, 'files') : null;
  return Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : [];
}

test('fakeAssembler refuses a revision the manifest does not declare and writes nothing', async () => {
  const { dir, w, current } = world();
  writeFileSync(join(current, 'reference/REFERENCE.md'), 'stale\n');
  const a = fakeAssembler(w.repo);
  const r = await a.assemble('8.2');
  assert.deepEqual(r, { ok: false, error: '--revision 8.2 does not match manifest revision 8.1' });
  assert.equal(read(current, 'reference/REFERENCE.md'), 'stale\n');
  assert.equal(read(current, 'reference/hashes.json'), w.main['world/current/reference/hashes.json']);
  assert.deepEqual(a.revisions(), ['8.2']);
  rmSync(dir, { recursive: true });
});

test('fakeAssembler refuses a manifest whose files are not unique source names', async () => {
  const { dir, w, current } = world();
  writeFileSync(join(current, 'reference/manifest.json'), `${JSON.stringify({ revision: '8.1', header: ['# x'], files: ['REFERENCE.md'] })}\n`);
  const r = await fakeAssembler(w.repo).assemble('8.1');
  assert.equal(r.ok, false);
  assert.equal(read(current, 'reference/REFERENCE.md'), w.main['world/current/reference/REFERENCE.md']);
  rmSync(dir, { recursive: true });
});

test('faults: altered base_book_sha256 and extra writes', async () => {
  const { dir, w, current } = world();
  const r = await fakeAssembler(w.repo, { alterBaseBookSha256: true, alsoWrite: { 'reference/checks.json': '{}\n' } }).assemble('8.1');
  assert.ok(r.ok);
  const hashes: unknown = JSON.parse(read(current, 'reference/hashes.json'));
  const base: unknown = JSON.parse(w.main['world/current/reference/hashes.json'] ?? '{}');
  assert.ok(typeof hashes === 'object' && hashes !== null && typeof base === 'object' && base !== null);
  assert.notEqual(Reflect.get(hashes, 'base_book_sha256'), Reflect.get(base, 'base_book_sha256'));
  assert.equal(Reflect.get(hashes, 'reference_book_sha256'), Reflect.get(base, 'reference_book_sha256'));
  assert.ok(existsSync(join(current, 'reference/checks.json')));
  rmSync(dir, { recursive: true });
});
