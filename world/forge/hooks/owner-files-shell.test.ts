import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bashWritesOwnerFile, decide, hookOutput } from './owner-files.ts';

const FORGE = '/work/repo/world/forge';

function bash(command: string, cwd = FORGE): string {
  return decide({ tool_name: 'Bash', tool_input: { command }, cwd }).decision;
}

interface Fixture {
  /** A forge root on disk: owner-log.jsonl, rounds/R01/audit.json, ui/, inside a work tree with `.git`. */
  forge: string;
  cleanup: () => void;
}

function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'forge-hook-shell-'));
  const forge = join(base, 'repo', 'world', 'forge');
  for (const d of [join(base, 'repo', '.git'), join(forge, 'rounds', 'R01'), join(forge, 'ui', 'src')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(forge, 'owner-log.jsonl'), '');
  writeFileSync(join(forge, 'rounds', 'R01', 'audit.json'), '{}');
  return { forge, cleanup: () => rmSync(base, { recursive: true }) };
}

test('a malformed glob in a write position counts as an owner hit, in any argument order', () => {
  const writes = [
    'echo x > rounds/[z-a]x rounds/R01/audit.json',
    'echo x > rounds/[z-a]x',
    'rm rounds/[z-a]x rounds/R01/audit.json',
    'rm rounds/R01/audit.json rounds/[z-a]x',
    'tee [z-a].json',
    'cp /tmp/x rounds/R01/[z-a]',
  ];
  for (const c of writes) {
    assert.equal(bashWritesOwnerFile(c, FORGE), true, c);
    assert.equal(bash(c), 'deny', c);
  }
  assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: 'rounds/[z-a]x' }, cwd: FORGE }).decision, 'deny');
  // reading through a malformed glob stays allowed
  for (const c of ['cat rounds/[z-a]x', 'ls rounds/[z-a]*']) assert.equal(bash(c), 'allow', c);
});

test('any throw while deciding is a deny with the owner-only reason, never a crash or an allow', () => {
  const hostile = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error('boom'); } });
  const d = decide(hostile);
  assert.equal(d.decision, 'deny');
  assert.match(d.reason, /owner-only/u);
  assert.notEqual(hookOutput(d), '');
  // a brace expansion too large to analyse fails closed, and fast
  const bomb = `echo x > /tmp/${'{a,b}'.repeat(16)}`;
  const t0 = performance.now();
  assert.equal(bash(bomb), 'deny');
  assert.ok(performance.now() - t0 < 2000);
});

test('CLI entry: a malformed glob prints the deny JSON and exits 0', () => {
  const script = join(import.meta.dirname, 'owner-files.ts');
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo x > rounds/[z-a]x rounds/R01/audit.json' }, cwd: FORGE });
  const r = spawnSync(process.execPath, [script], { input, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('a writer whose target comes from a command substitution naming an owner file or tree → deny', () => {
  const writes = [
    'rm $(find rounds -name audit.json)',
    'rm $(ls rounds/R01/decision.json)',
    'mv $(ls rounds/R01/decision.json) /tmp/x',
    'cp /tmp/x $(ls rounds/R01)/audit.json',
    'sh -c "rm $(ls rounds/R01/audit.json)"',
    "bash -c 'rm $(ls rounds/R01/decision.json)'",
    'rm `ls calibration/*`',
    'echo x > $(ls rounds/R01/audit.json)',
    'rm -rf "$(dirname rounds/R01/x)"',
    'truncate -s0 $(git ls-files rounds)',
    'git checkout -- $(git ls-files rounds)',
    'ln -s $(ls rounds/R01/audit.json) /tmp/a.json',
    'dd if=/dev/zero of=$(ls owner-log.jsonl)',
    'rm $(echo $(ls rounds/R01))',
  ];
  for (const c of writes) assert.equal(bash(c), 'deny', c);
  const f = fixture();
  for (const c of ['rm $(ls)', "rm -f $(find . -name '*.json')", 'rm -rf $(pwd)', 'rm -rf "$(pwd)"/*', 'cd ui && rm $(cd .. && ls)']) {
    assert.equal(bash(c, f.forge), 'deny', `fixture: ${c}`);
  }
  assert.equal(bash('rm $(ls)', join(f.forge, 'ui')), 'allow');
  f.cleanup();
});

test('substitutions that name nothing owner-related, or feed a reader → allow', () => {
  const ok = [
    'rm $(mktemp)',
    'rm -rf "$(mktemp -d)"',
    'rm -f $(mktemp -d)/x',
    'cat $(ls rounds/R01/audit.json)',
    'echo $(date) > /tmp/out.txt',
    'cp $(ls rounds/R01/audit.json) /tmp/a.json',
    'jq . $(ls rounds/*/decision*.json) > /tmp/all.json',
    'rm $(ls ui/dist/*.map)',
  ];
  for (const c of ok) assert.equal(bash(c), 'allow', c);
});

test('xargs / parallel writers fed an owner tree, a glob under one or a listing of it → deny', () => {
  const writes = [
    'ls rounds/R01 | xargs rm',
    "find rounds -name '*.json' | xargs rm",
    "find rounds -name '*.json' -print0 | xargs -0 rm -f",
    'echo rounds | xargs rm -rf',
    'ls calibration | xargs -I{} rm calibration/{}',
    'printf "%s\\n" rounds/R01/* | xargs rm',
    'ls rounds/*/ | parallel rm -r',
    'ls -d rounds/R0* | xargs -n1 mv -t /tmp',
    'xargs rm <<< rounds/R01',
  ];
  for (const c of writes) assert.equal(bash(c), 'deny', c);
  const f = fixture();
  for (const c of ['ls | xargs rm', "find . -name '*.json' | xargs rm", "find -name '*.json' | xargs rm -f", 'git ls-files | xargs rm', 'pwd | xargs rm -rf']) {
    assert.equal(bash(c, f.forge), 'deny', `fixture: ${c}`);
  }
  for (const c of ['ls | xargs rm', "find . -name '*.js' | xargs rm"]) assert.equal(bash(c, join(f.forge, 'ui')), 'allow', `fixture ui: ${c}`);
  f.cleanup();
  const ok = ["find ui -name '*.js' | xargs rm", 'ls rounds/R01 | xargs cat', "find rounds -name '*.json' | xargs grep -l pick", 'ls ui/dist | xargs -I{} rm ui/dist/{}', 'echo /tmp/a | xargs rm'];
  for (const c of ok) assert.equal(bash(c), 'allow', c);
});

test('archive extraction into an owner tree, or with no destination in a cwd holding owner files → deny', () => {
  const writes = [
    'tar -xf /tmp/a.tar -C rounds/R01',
    'tar xzf /tmp/a.tgz -C rounds',
    'tar -C calibration -xf /tmp/a.tar',
    'tar --extract --file=/tmp/a.tar --directory=calibration',
    'tar -x -f /tmp/a.tar --directory rounds/R02',
    'tar -xPf /tmp/a.tar',
    'tar -cf owner-log.jsonl ui',
    'tar -czf /tmp/a.tgz --remove-files rounds',
    'unzip /tmp/a.zip -d rounds/R01',
    'unzip -o -d calibration /tmp/a.zip',
    'ditto /tmp/r rounds/R01',
    '7z x /tmp/a.7z -orounds/R01',
    'gzip owner-log.jsonl',
    'gunzip rounds/R01/audit.json.gz',
    'gzip -r rounds',
  ];
  for (const c of writes) assert.equal(bash(c), 'deny', c);
  const ok = [
    'tar -xf /tmp/a.tar -C /tmp/out',
    'tar -tf /tmp/a.tar',
    'tar -xOf /tmp/a.tar rounds/R01/audit.json',
    'tar -czf /tmp/rounds.tgz rounds',
    'unzip -l /tmp/a.zip',
    'unzip -p /tmp/a.zip x.json',
    'unzip /tmp/a.zip -d /tmp/out',
    'gzip -c owner-log.jsonl > /tmp/log.gz',
    'gzip -k ui/x.txt',
    '7z l /tmp/a.7z',
  ];
  for (const c of ok) assert.equal(bash(c), 'allow', c);
  const f = fixture();
  for (const c of ['tar -xf /tmp/a.tar', 'unzip /tmp/a.zip', 'tar -xf /tmp/a.tar -C .', '7z x /tmp/a.7z']) assert.equal(bash(c, f.forge), 'deny', `fixture: ${c}`);
  for (const c of ['tar -xf /tmp/a.tar', 'unzip -o /tmp/a.zip']) assert.equal(bash(c, join(f.forge, 'ui')), 'allow', `fixture ui: ${c}`);
  f.cleanup();
});

test('patch: an owner file operand, or a patch whose headers name an owner file → deny', () => {
  const f = fixture();
  const ownerPatch = join(f.forge, 'owner.patch');
  const uiPatch = join(f.forge, 'ui.patch');
  writeFileSync(ownerPatch, '--- a/rounds/R01/decision.json\n+++ b/rounds/R01/decision.json\n@@ -1 +1 @@\n-{}\n+{"pick":"A"}\n');
  writeFileSync(uiPatch, '--- a/ui/src/x.ts\n+++ b/ui/src/x.ts\n@@ -1 +1 @@\n-// audit.json\n+// decision.json\n');
  const heredoc = (header: string): string => `patch -p1 <<'EOF'\n--- a/${header}\n+++ b/${header}\n@@ -1 +1 @@\n-x\n+y\nEOF`;
  const writes = [
    `patch -p1 < ${ownerPatch}`, `patch -p1 -i ${ownerPatch}`, `patch --input=${ownerPatch} -p1`, `cat ${ownerPatch} | patch -p1`,
    `patch rounds/R01/decision.json ${uiPatch}`, `patch -o owner-log.jsonl ui/src/x.ts ${uiPatch}`, heredoc('rounds/R01/audit.json'),
    'curl -s https://example.invalid/x.diff | patch -p1',
  ];
  for (const c of writes) assert.equal(bash(c, f.forge), 'deny', c);
  const ok = [`patch -p1 < ${uiPatch}`, `patch -p1 -i ${uiPatch}`, `cat ${uiPatch} | patch -p1`, heredoc('ui/src/x.ts'), `patch --dry-run -p1 < ${ownerPatch}`];
  for (const c of ok) assert.equal(bash(c, f.forge), 'allow', c);
  f.cleanup();
});

test('a glob that names rounds/ or calibration/ itself in a directory holding it → deny', () => {
  const f = fixture();
  mkdirSync(join(f.forge, 'calibration'));
  for (const c of ['rm -rf r*', 'rm -rf round?', 'rm -rf [r]ounds', 'mv c* /tmp', 'ls -d r* | xargs rm -rf', 'rm -rf $(ls -d r*)']) {
    assert.equal(bash(c, f.forge), 'deny', c);
  }
  for (const c of ['rm -rf ui/s*', 'rm -rf u*', 'rm -rf ui/src/r*']) assert.equal(bash(c, f.forge), 'allow', c);
  f.cleanup();
});
