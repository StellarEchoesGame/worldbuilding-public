import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLOCK_FILE_ENV, uiNow } from './clock.ts';

function withEnv(env: Readonly<Record<string, string | undefined>>, body: () => void): void {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const set = (vars: Readonly<Record<string, string | undefined>>): void => {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  set(env);
  try {
    body();
  } finally {
    set(saved);
  }
}

const near = (iso: string): boolean => Math.abs(Date.parse(iso) - Date.now()) < 60_000;

test('uiNow: fixture data with FORGE_UI_CLOCK_FILE stamps the file\'s timestamp; a bad file throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-clock-'));
  const file = join(dir, 'now.txt');
  writeFileSync(file, '2026-10-01T00:00:05.000Z\n');
  withEnv({ FORGE_DATA_DIR: join(dir, 'repo', 'world', 'forge'), [CLOCK_FILE_ENV]: file }, () => {
    assert.equal(uiNow(), '2026-10-01T00:00:05.000Z');
    writeFileSync(file, 'yesterday');
    assert.throws(() => uiNow(), /not an ISO timestamp/u);
  });
  withEnv({ FORGE_DATA_DIR: join(dir, 'repo', 'world', 'forge'), [CLOCK_FILE_ENV]: undefined }, () => assert.ok(near(uiNow()), 'no clock file → wall clock'));
  rmSync(dir, { recursive: true, force: true });
});

test('uiNow: real data always uses the wall clock, even with FORGE_UI_CLOCK_FILE set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-clock-'));
  const file = join(dir, 'now.txt');
  writeFileSync(file, '2001-01-01T00:00:00.000Z');
  withEnv({ FORGE_DATA_DIR: undefined, [CLOCK_FILE_ENV]: file }, () => assert.ok(near(uiNow())));
  rmSync(dir, { recursive: true, force: true });
});
