import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * RoundFiles (context.ts) is the engine's only filesystem writer; store.ts holds the raw I/O it wraps. Tests,
 * engine/testing/ and ui/ may write directly. Everything else that writes is listed in LEGACY with the exact
 * names it may import and why.
 */
const ENGINE = import.meta.dirname;
const UI_SRC = join(ENGINE, '..', 'ui', 'src');
const STORE = join(ENGINE, 'store.ts');
const TESTING = join(ENGINE, 'testing');
const FS_MODULES: ReadonlySet<string> = new Set(['node:fs', 'fs', 'node:fs/promises', 'fs/promises']);
const FS_WRITERS: ReadonlySet<string> = new Set([
  'writeFileSync', 'appendFileSync', 'renameSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'copyFileSync', 'cpSync', 'linkSync',
  'symlinkSync', 'truncateSync', 'ftruncateSync', 'mkdirSync', 'mkdtempSync', 'openSync', 'writeSync', 'writevSync', 'createWriteStream',
  'writeFile', 'appendFile', 'rename', 'rm', 'rmdir', 'unlink', 'copyFile', 'cp', 'link', 'symlink', 'truncate', 'mkdir', 'mkdtemp', 'open',
]);
const STORE_WRITERS: ReadonlySet<string> = new Set(['writeJson', 'writeText', 'appendLine', 'appendRecords', 'createExclusive', 'moveFileIfPresent', 'removeFile', 'progress']);
const EXEMPT: ReadonlySet<string> = new Set(['store.ts', 'context.ts']);

const LEGACY: Readonly<Record<string, { names: readonly string[]; reason: string }>> = {
  'adapters/judges.ts': { names: ['copyFileSync', 'mkdirSync', 'mkdtempSync', 'rmSync', 'symlinkSync', 'writeFileSync'], reason: 'isolated CLI judge homes and prompt files in a private temp dir outside the forge tree' },
  'canary.ts': { names: ['mkdirSync', 'writeFileSync'], reason: 'plants canary files in a caller-provided temp dir' },
  'ui-launch.ts': { names: ['mkdirSync', 'rmSync', 'writeFileSync'], reason: 'private UI login URL file under .runs/ (mode 0600)' },
  'cli.ts': { names: ['writeJson', 'writeText'], reason: 'forge canary results and transcripts (F1-02 command, not a round step)' },
  'prototype.ts': { names: ['progress', 'writeJson', 'writeText'], reason: 'prototype P-round runner (P01 is frozen)' },
  'calls.ts': { names: ['writeJson', 'writeText'], reason: 'recordCall for the prototype runner, which passes no RoundFiles' },
  'runner.ts': { names: ['createExclusive', 'moveFileIfPresent', 'removeFile'], reason: 'the engine lock .forge.lock (acquireEngineLock takes only the forge root)' },
};

interface Finding {
  name: string;
  module: string;
}

function isStore(spec: string, file: string): boolean {
  return spec.startsWith('.') && resolve(dirname(file), spec) === STORE;
}

function isTesting(spec: string, file: string): boolean {
  if (!spec.startsWith('.')) return false;
  const target = resolve(dirname(file), spec);
  return target === TESTING || target.startsWith(`${TESTING}${sep}`);
}

/** Named value imports of `{ a, type b, c as d }` → ['a', 'c']. */
function namedValues(clause: string): string[] {
  const braces = /\{([^}]*)\}/u.exec(clause);
  if (braces === null) return [];
  return (braces[1] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '' && !s.startsWith('type '))
    .map((s) => (s.split(/\s+as\s+/u)[0] ?? s).trim());
}

/** Writer imports of one source file (static imports, re-exports, namespace / default imports, dynamic imports). */
function writerImports(source: string, file: string): Finding[] {
  const out: Finding[] = [];
  const statement = /^[ \t]*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*['"]([^'"]+)['"]/gmu;
  for (const m of source.matchAll(statement)) {
    const typeOnly = m[2] !== undefined;
    const clause = m[3] ?? '';
    const spec = m[4] ?? '';
    const fs = FS_MODULES.has(spec);
    const store = isStore(spec, file);
    if (typeOnly || (!fs && !store)) continue;
    if (/^\*/u.test(clause) || (m[1] === 'import' && /^[A-Za-z_$][\w$]*\s*(,|$)/u.test(clause))) out.push({ name: '*', module: spec });
    for (const name of namedValues(clause)) if ((fs && FS_WRITERS.has(name)) || (store && STORE_WRITERS.has(name))) out.push({ name, module: spec });
  }
  for (const m of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
    const spec = m[1] ?? '';
    if (FS_MODULES.has(spec) || isStore(spec, file)) out.push({ name: 'import()', module: spec });
  }
  return out;
}

function testingImports(source: string, file: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/^[ \t]*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/gmu)) if (isTesting(m[1] ?? '', file)) out.push(m[1] ?? '');
  for (const m of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu)) if (isTesting(m[1] ?? '', file)) out.push(m[1] ?? '');
  return out;
}

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory() && e.name !== 'node_modules') out.push(...tsFiles(p));
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(p);
  }
  return out.sort();
}

function rel(file: string): string {
  return relative(ENGINE, file).split(sep).join('/');
}

test('the lint sees multi-line, aliased, namespace, default, re-exported and dynamic writer imports, not type-only ones', () => {
  const file = join(ENGINE, 'steps', 'example.ts');
  const source = [
    "import {",
    "  existsSync,",
    "  writeFileSync as put,",
    "  type Stats,",
    "} from 'node:fs';",
    "import type { writeJson } from '../store.ts';",
    "import { sha256, writeJson } from '../store.ts';",
    "import * as fsp from 'node:fs/promises';",
    "import fs from 'fs';",
    "export { appendRecords } from '../store.ts';",
    "export * from '../store.ts';",
    "const later = await import('node:fs');",
    " * import { renameSync } from 'node:fs';   (inside a doc comment: ignored)",
    "import { readJson } from './store.ts';",
  ].join('\n');
  assert.deepEqual(writerImports(source, file), [
    { name: 'writeFileSync', module: 'node:fs' },
    { name: 'writeJson', module: '../store.ts' },
    { name: '*', module: 'node:fs/promises' },
    { name: '*', module: 'fs' },
    { name: 'appendRecords', module: '../store.ts' },
    { name: '*', module: '../store.ts' },
    { name: 'import()', module: 'node:fs' },
  ]);
  assert.deepEqual(testingImports("import { fakeClock } from '../testing/fakes.ts';\nimport { x } from '../testing.ts';", file), ['../testing/fakes.ts']);
});

test('only RoundFiles (context.ts) and store.ts write files; legacy writers import only their listed names', () => {
  const problems: string[] = [];
  let legacyHits = 0;
  for (const file of tsFiles(ENGINE)) {
    const r = rel(file);
    if (r.endsWith('.test.ts') || r.startsWith('testing/') || EXEMPT.has(r)) continue;
    const allowed = LEGACY[r]?.names ?? [];
    for (const f of writerImports(readFileSync(file, 'utf8'), file)) {
      if (allowed.includes(f.name)) legacyHits += 1;
      else problems.push(`${r}: imports ${f.name} from ${f.module} — write through ctx.files (RoundFiles) instead`);
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(legacyHits > 0, 'the scan found no writer import at all (is it reading the engine sources?)');
  assert.ok(writerImports(readFileSync(join(ENGINE, 'context.ts'), 'utf8'), join(ENGINE, 'context.ts')).length > 0);
  for (const r of Object.keys(LEGACY)) assert.ok(existsSync(join(ENGINE, r)), `LEGACY lists a missing module ${r}`);
});

test('no engine or UI module outside tests imports engine/testing/', () => {
  const problems: string[] = [];
  for (const file of [...tsFiles(ENGINE), ...tsFiles(UI_SRC)]) {
    const r = relative(join(ENGINE, '..'), file).split(sep).join('/');
    if (r.endsWith('.test.ts') || r.startsWith('engine/testing/')) continue;
    for (const spec of testingImports(readFileSync(file, 'utf8'), file)) problems.push(`${r}: imports ${spec}`);
  }
  assert.deepEqual(problems, []);
});
