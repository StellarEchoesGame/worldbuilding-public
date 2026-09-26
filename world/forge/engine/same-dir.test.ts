import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sameDir } from './same-dir.ts';

test('sameDir matches filesystem identity: the path itself, a trailing slash, a symlinked alias and (on a case-insensitive volume) a case variant', () => {
  const base = mkdtempSync(join(tmpdir(), 'forge-same-dir-'));
  try {
    const root = join(base, 'Forge');
    const other = join(base, 'other');
    mkdirSync(root);
    mkdirSync(other);
    symlinkSync(root, join(base, 'alias'));
    assert.equal(sameDir(root, root), true);
    assert.equal(sameDir(`${root}/`, root), true);
    assert.equal(sameDir(join(root, 'engine', '..'), root), true, 'lexically equal paths match even when a component is missing');
    assert.equal(sameDir(join(base, 'alias'), root), true, 'a symlink to the root is the root');
    assert.equal(sameDir(other, root), false);
    assert.equal(sameDir(join(base, 'missing'), root), false);
    assert.equal(sameDir(join(root, 'missing'), join(other, 'missing')), false);
    const upper = join(base, 'FORGE');
    if (existsSync(upper)) assert.equal(sameDir(upper, root), true, 'a case variant on a case-insensitive volume is the root');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
