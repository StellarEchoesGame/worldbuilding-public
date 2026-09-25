import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOWED_AMENDMENTS, hashListed, isDone, markerText, readMarker, sealedSha256, sha256Bytes, verifyMarker, writeMarker, type Marker } from './marker.ts';
import { loadSchema, validate } from './schema.ts';
import { toyContext, toyFiles, toyWorld } from './testing/kill-child.ts';

const SCHEMA = new URL('../schema/marker.schema.json', import.meta.url);
const H = (s: string): string => sha256Bytes(Buffer.from(s, 'utf8'));

function marker(over: Partial<Marker> = {}): Marker {
  return {
    v: 1,
    round: 'R01',
    step: '02a-brief',
    completed_at: '2026-10-01T00:00:00.000Z',
    result: 'done',
    skipped: null,
    inputs: {},
    outputs: {},
    external: {},
    local: {},
    tasks: { ok: 0, void: 0, calls: 0 },
    prev: null,
    ...over,
  };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'forge-marker-'));
}

test('writeMarker writes canonical bytes (sorted keys) and returns their SHA-256; readMarker round-trips', () => {
  const root = tmp();
  const path = join(root, 'rounds/R01/markers/02a-brief.json');
  const m = marker({ outputs: { 'rounds/R01/z.json': H('z'), 'rounds/R01/a.json': H('a') }, prev: H('p') });
  const sha = writeMarker(toyFiles(root), path, m);
  const bytes = readFileSync(path);
  assert.equal(sha, sha256Bytes(bytes));
  assert.equal(bytes.toString('utf8'), markerText(m));
  assert.ok(bytes.toString('utf8').indexOf('a.json') < bytes.toString('utf8').indexOf('z.json'));
  const back = readMarker(path);
  assert.ok(back !== null && back.ok);
  assert.deepEqual(back.value, m);
  const schema = loadSchema(JSON.parse(readFileSync(SCHEMA, 'utf8')));
  assert.ok(schema.ok, schema.ok ? '' : schema.error);
  assert.deepEqual(validate(schema.value, JSON.parse(bytes.toString('utf8'))), []);
  rmSync(root, { recursive: true });
});

test('readMarker: absent → null; malformed → err', () => {
  const root = tmp();
  assert.equal(readMarker(join(root, 'none.json')), null);
  const bad = (value: unknown): string => {
    writeFileSync(join(root, 'm.json'), JSON.stringify(value));
    const r = readMarker(join(root, 'm.json'));
    assert.ok(r !== null && !r.ok);
    return r.error;
  };
  assert.match(bad({ ...marker(), step: '99-nope' }), /marker\.step/u);
  assert.match(bad({ ...marker(), outputs: { 'a.json': 'xyz' } }), /SHA-256/u);
  assert.match(bad({ ...marker(), extra: 1 }), /unexpected key extra/u);
  assert.match(bad({ ...marker(), tasks: { ok: -1, void: 0, calls: 0 } }), /non-negative/u);
  assert.match(bad({ ...marker(), outputs: { '/abs/a.json': H('a') } }), /forge-root-relative/u);
  writeFileSync(join(root, 'm.json'), '{');
  const torn = readMarker(join(root, 'm.json'));
  assert.ok(torn !== null && !torn.ok);
  rmSync(root, { recursive: true });
});

test('verifyMarker: tampered or missing outputs, latest listing wins, local only where present, external never', () => {
  const root = tmp();
  mkdirSync(join(root, 'rounds/R01'), { recursive: true });
  writeFileSync(join(root, 'rounds/R01/a.json'), 'A');
  writeFileSync(join(root, 'rounds/R01/freeze.json'), 'F2');
  const m = marker({
    inputs: { 'rounds/R01/freeze.json': H('F1') },
    outputs: { 'rounds/R01/a.json': H('A'), 'rounds/R01/gone.json': H('G') },
    external: { 'champions.json': H('whatever') },
    local: { '.runs/R01/x.out.txt': H('X') },
  });
  assert.deepEqual(verifyMarker(root, m, new Map()), ['rounds/R01/freeze.json: content does not match its marker hash', 'rounds/R01/gone.json: listed in a marker but missing']);
  assert.deepEqual(verifyMarker(root, m, new Map([['rounds/R01/freeze.json', H('F2')]])), ['rounds/R01/gone.json: listed in a marker but missing']);
  writeFileSync(join(root, 'rounds/R01/a.json'), 'A tampered');
  assert.ok(verifyMarker(root, m, new Map()).includes('rounds/R01/a.json: content does not match its marker hash'));
  mkdirSync(join(root, '.runs/R01'), { recursive: true });
  writeFileSync(join(root, '.runs/R01/x.out.txt'), 'Y');
  assert.ok(verifyMarker(root, m, new Map()).includes('.runs/R01/x.out.txt: content does not match its marker hash'));
  rmSync(root, { recursive: true });
});

test('sealed files hash as SHA-256(nonce ‖ bytes); nonce.hex plainly; a sealed file without nonce is an error', () => {
  const root = tmp();
  mkdirSync(join(root, '.sealed/R01'), { recursive: true });
  writeFileSync(join(root, '.sealed/R01/sealed.json'), '{"a":1}');
  const noNonce = hashListed(root, '.sealed/R01/sealed.json');
  assert.ok(noNonce !== null && !noNonce.ok);
  const nonceHex = 'ab'.repeat(32);
  writeFileSync(join(root, '.sealed/R01/nonce.hex'), `${nonceHex}\n`);
  const salted = hashListed(root, '.sealed/R01/sealed.json');
  assert.ok(salted !== null && salted.ok);
  assert.equal(salted.value, sealedSha256(Buffer.from(nonceHex, 'hex'), Buffer.from('{"a":1}')));
  assert.notEqual(salted.value, H('{"a":1}'));
  const nonce = hashListed(root, '.sealed/R01/nonce.hex');
  assert.ok(nonce !== null && nonce.ok);
  assert.equal(nonce.value, H(`${nonceHex}\n`));
  assert.equal(hashListed(root, '.sealed/R01/absent.json'), null);
  rmSync(root, { recursive: true });
});

test('ALLOWED_AMENDMENTS: only 03c-probe-mirror may re-list freeze.json', () => {
  assert.deepEqual(Object.keys(ALLOWED_AMENDMENTS), ['03c-probe-mirror']);
  assert.deepEqual(ALLOWED_AMENDMENTS['03c-probe-mirror'], ['freeze.json']);
});

test('isDone is true only for a final (done / skip) marker', () => {
  const world = toyWorld(tmp());
  const ctx = toyContext(world);
  const path = (id: string): string => join(ctx.paths.markers, `${id}.json`);
  assert.equal(isDone(ctx, '02a-brief'), false);
  writeMarker(ctx.files, path('02a-brief'), marker({ result: 'waiting' }));
  assert.equal(isDone(ctx, '02a-brief'), false);
  writeMarker(ctx.files, path('02a-brief'), marker({ result: 'skip', skipped: 'nothing to do' }));
  assert.equal(isDone(ctx, '02a-brief'), true);
  writeMarker(ctx.files, path('03c-probe-mirror'), marker({ step: '03c-probe-mirror' }));
  assert.equal(isDone(ctx, '03c-probe-mirror'), true);
  rmSync(world.dir, { recursive: true });
});
