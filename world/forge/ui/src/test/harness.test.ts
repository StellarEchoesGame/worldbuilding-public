import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { buildInputsSha256, FORGE_ROOT, formFields, inputNamesWithValue, inputValues, redirectError, startServer } from './server.ts';

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

test('buildInputsSha256 changes with UI and engine sources, not with tests, dist or node_modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-harness-'));
  put(root, 'ui/src/pages/index.astro', 'a');
  put(root, 'ui/astro.config.mjs', 'b');
  put(root, 'engine/x.ts', 'c');
  put(root, 'package-lock.json', '{}');
  const first = buildInputsSha256(root);
  for (const rel of ['ui/src/lib/x.test.ts', 'engine/x.test.ts', 'ui/dist/server/entry.mjs', 'ui/src/node_modules/y.ts', 'engine/notes.md']) put(root, rel, 'ignored');
  assert.equal(buildInputsSha256(root), first);
  put(root, 'engine/x.ts', 'c2');
  const second = buildInputsSha256(root);
  assert.notEqual(second, first);
  put(root, 'ui/src/lib/new.ts', 'd');
  assert.notEqual(buildInputsSha256(root), second);
  rmSync(root, { recursive: true, force: true });
});

test('HTML helpers read inputs in any attribute order, scoped per form action', () => {
  const html = [
    '<form method="post" action="/a"><input type="hidden" name="version" value="v2" /><input value="ab&amp;c" name="sha256" type="hidden"></form>',
    '<form action="/b"><input type="radio" name="P1" value="left" /><input type="radio" name="P1" value="right" /><input name="P2" value="left" type="radio" /></form>',
  ].join('');
  assert.deepEqual(formFields(html, '/a'), [{ version: 'v2', sha256: 'ab&c' }]);
  assert.deepEqual(formFields(html, '/b'), [{}], 'radios are not hidden fields');
  assert.deepEqual(inputValues(html, 'sha256'), ['ab&c']);
  assert.deepEqual(inputNamesWithValue(html, 'left'), ['P1', 'P2']);
  assert.equal(redirectError('/x?error=%E6%97%A0'), '无');
  assert.equal(redirectError('/x'), null);
});

test('startServer refuses the real forge root under an alias (a symlink, a trailing separator), before building', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-harness-'));
  const alias = join(dir, 'forge-alias');
  symlinkSync(FORGE_ROOT, alias, 'dir');
  try {
    for (const dataDir of [FORGE_ROOT, alias, `${FORGE_ROOT}${sep}`]) {
      // should the refusal ever miss, the started server is stopped again and the assertion still fails
      await assert.rejects(async () => {
        const s = await startServer({ dataDir, now: () => '2026-10-01T00:00:00.000Z' });
        await s.stop();
      }, /refusing the real forge root/u, dataDir);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
