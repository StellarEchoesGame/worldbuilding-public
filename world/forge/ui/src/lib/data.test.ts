import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { codeRoot, dataDir, gateMark, isRealData, readGate, redactRoot, repoDir, type GateCheckView } from './data.ts';

test('gate checks carry their flags, defaulting to none', () => {
  const g = readGate({
    pass: true,
    checks: [
      { name: 'length', ok: true, detail: '10 / 2500 字' },
      { name: 'forbidden_words', ok: true, detail: '否定句待复核：…', flags: ['这里没有配给站。', 3, '远航号没有穿过星门。'] },
      { name: 'markup', ok: false, detail: '含链接', flags: 'not a list' },
    ],
  });
  assert.equal(g.pass, true);
  assert.deepEqual(g.checks, [
    { name: 'length', ok: true, detail: '10 / 2500 字', flags: [] },
    { name: 'forbidden_words', ok: true, detail: '否定句待复核：…', flags: ['这里没有配给站。', '远航号没有穿过星门。'] },
    { name: 'markup', ok: false, detail: '含链接', flags: [] },
  ]);
});

test('a missing gate record reads as not passed with no checks', () => {
  assert.deepEqual(readGate(null), { pass: false, checks: [] });
});

test('a gate check shows ✔ when ok, ⚠ when ok with flags, ✖ when not ok', () => {
  const check = (ok: boolean, flags: string[]): GateCheckView => ({ name: 'forbidden_words', ok, detail: '', flags });
  assert.equal(gateMark(check(true, [])), '✔');
  assert.equal(gateMark(check(true, ['这里没有配给站。'])), '⚠');
  assert.equal(gateMark(check(false, [])), '✖');
  assert.equal(gateMark(check(false, ['这里没有配给站。'])), '✖');
});

test('codeRoot is the forge root; dataDir defaults to it (real data) and FORGE_DATA_DIR points elsewhere (fixture data)', () => {
  const saved = process.env['FORGE_DATA_DIR'];
  try {
    const root = codeRoot();
    assert.equal(root, resolve(import.meta.dirname, '..', '..', '..'));
    assert.ok(existsSync(join(root, 'engine', 'cli.ts')) && existsSync(join(root, 'ui', 'astro.config.mjs')));
    delete process.env['FORGE_DATA_DIR'];
    assert.deepEqual([dataDir(), repoDir(), isRealData()], [root, resolve(root, '..', '..'), true]);
    process.env['FORGE_DATA_DIR'] = '';
    assert.equal(isRealData(), true, 'an empty FORGE_DATA_DIR is unset');
    process.env['FORGE_DATA_DIR'] = '/tmp/fixture/repo/world/forge/';
    assert.deepEqual([dataDir(), repoDir(), isRealData()], ['/tmp/fixture/repo/world/forge', '/tmp/fixture/repo', false]);
  } finally {
    if (saved === undefined) delete process.env['FORGE_DATA_DIR'];
    else process.env['FORGE_DATA_DIR'] = saved;
  }
});

test('isRealData follows filesystem identity: a symlinked alias or a case variant of the forge root is real data', () => {
  const saved = process.env['FORGE_DATA_DIR'];
  const base = mkdtempSync(join(tmpdir(), 'forge-real-alias-'));
  try {
    symlinkSync(codeRoot(), join(base, 'alias'));
    process.env['FORGE_DATA_DIR'] = join(base, 'alias');
    assert.equal(isRealData(), true, 'a symlink to the real root');
    const variant = codeRoot().toUpperCase();
    process.env['FORGE_DATA_DIR'] = variant;
    if (existsSync(join(variant, 'engine', 'cli.ts'))) assert.equal(isRealData(), true, 'an upper-case alias on a case-insensitive volume');
    process.env['FORGE_DATA_DIR'] = base;
    assert.equal(isRealData(), false, 'a different directory is fixture data');
  } finally {
    rmSync(base, { recursive: true, force: true });
    if (saved === undefined) delete process.env['FORGE_DATA_DIR'];
    else process.env['FORGE_DATA_DIR'] = saved;
  }
});

test('redactRoot replaces every occurrence of the forge root with <forge>', () => {
  const root = '/Users/someone/repo/world/forge';
  assert.equal(redactRoot(`EACCES: permission denied, open '${root}/owner-log.jsonl'; again ${root}`, root), "EACCES: permission denied, open '<forge>/owner-log.jsonl'; again <forge>");
  assert.equal(redactRoot('rounds/R01/pairs.json is missing', root), 'rounds/R01/pairs.json is missing');
  assert.equal(redactRoot('nothing to hide', ''), 'nothing to hide', 'an empty root replaces nothing');
});
