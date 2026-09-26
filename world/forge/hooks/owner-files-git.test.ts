import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide } from './owner-files.ts';

const FORGE = '/work/repo/world/forge';

function bash(command: string, cwd = FORGE): string {
  return decide({ tool_name: 'Bash', tool_input: { command }, cwd }).decision;
}

interface Fixture {
  /** Work tree root (holds `.git`). */
  repo: string;
  /** `<repo>/world/forge`, holding owner files. */
  forge: string;
  /** A second work tree without owner files. */
  other: string;
  cleanup: () => void;
}

/** A work tree shaped like the repository (owner files under world/forge) and an unrelated one. */
function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'forge-hook-git-'));
  const repo = join(base, 'repo');
  const forge = join(repo, 'world', 'forge');
  const other = join(base, 'other');
  for (const d of [join(repo, '.git'), join(forge, 'rounds', 'R01'), join(forge, 'ui', 'src'), join(other, '.git'), join(other, 'src')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(forge, 'owner-log.jsonl'), '');
  writeFileSync(join(forge, 'rounds', 'R01', 'audit.json'), '{}');
  return { repo, forge, other, cleanup: () => rmSync(base, { recursive: true }) };
}

test('git stash / clean / reset --hard|--merge|--keep / switch|checkout -f over a work tree holding owner files → deny', () => {
  const f = fixture();
  const inForge = [
    'git stash', 'git stash -u', 'git stash --include-untracked', 'git stash -a', 'git stash --all', 'git stash -k',
    'git stash push', 'git stash push -u -m wip', 'git stash -m wip', 'git stash save wip', 'git stash pop', 'git stash apply stash@{0}',
    'git stash push -- rounds', 'git stash push -- ":/"', 'git stash push --pathspec-from-file=/tmp/list',
    'git clean -fd', 'git clean -fdx', 'git clean -f -e node_modules', 'git clean -f "*.json"', 'git clean -fX rounds/R01',
    'git reset --hard', 'git reset --hard HEAD~1', 'git reset --merge', 'git reset --keep HEAD',
    'git switch -f main', 'git switch --force main', 'git switch --discard-changes main',
    'git checkout -f main', 'git checkout --force main', 'git checkout -fb topic', 'git checkout -f',
    'git checkout -- "*.json"', 'git restore "rounds/R0*"',
    'sudo git reset --hard', 'flock /tmp/lock git stash', 'git --no-pager stash', 'git -c core.pager=cat reset --hard',
  ];
  for (const c of inForge) assert.equal(bash(c, f.forge), 'deny', c);
  for (const c of ['git stash', 'git stash -u', 'git reset --hard', 'git clean -fdx', 'git checkout -f main', 'cd world/forge && git clean -fd']) {
    assert.equal(bash(c, f.repo), 'deny', `repo root: ${c}`);
  }
  // stash, reset and a forced checkout act on the whole work tree, not only below the cwd
  for (const c of ['git stash', 'git stash -u', 'git reset --hard', 'git checkout -f main', 'git switch -f main', 'cd .. && git clean -fd']) {
    assert.equal(bash(c, join(f.forge, 'ui')), 'deny', `forge/ui: ${c}`);
  }
  for (const c of [`git -C ${f.forge} stash`, `git -C ${f.repo} reset --hard`, `git -C ${f.repo}/world -C forge clean -fd`, `git --work-tree=${f.repo} stash -u`, `git --work-tree ${f.repo} checkout -f main`]) {
    assert.equal(bash(c, '/'), 'deny', c);
  }
  f.cleanup();
});

test('read-only git and git writes that cannot reach owner files → allow', () => {
  const f = fixture();
  const inForge = [
    'git status', 'git status --short', 'git diff', 'git diff --stat HEAD~1', 'git log --oneline -5', 'git show HEAD',
    'git show HEAD:world/forge/owner-log.jsonl', 'git stash list', 'git stash show -p stash@{0}', 'git stash create',
    'git clean -n', 'git clean -nd', 'git clean --dry-run -x', 'git reset', 'git reset --soft HEAD~1', 'git reset HEAD -- ui/src/x.ts',
    'git checkout main', 'git switch main', 'git switch -c topic', 'git stash push -- ui/src/x.ts', 'git stash push -m wip -- ui',
    'git clean -fd ui/src', 'git checkout -- "ui/*.ts"', 'git -C ui clean -fdx', 'git fetch origin', 'git branch -f topic HEAD',
  ];
  for (const c of inForge) assert.equal(bash(c, f.forge), 'allow', c);
  // git clean starts at the cwd: below forge/ui it cannot reach an owner file
  for (const c of ['git clean -fdx', 'git clean -fd .', 'git stash push -- .']) assert.equal(bash(c, join(f.forge, 'ui')), 'allow', `forge/ui: ${c}`);
  for (const c of ['git stash -u', 'git stash pop', 'git reset --hard', 'git clean -fdx', 'git checkout -f main', 'git switch --discard-changes main']) {
    assert.equal(bash(c, f.other), 'allow', `other repo: ${c}`);
  }
  assert.equal(bash(`git -C ${f.other} reset --hard`, f.forge), 'allow');
  f.cleanup();
});

test('git path arguments resolve against -C / --work-tree, not the global options', () => {
  const writes = [
    `git -C ${FORGE} checkout -- owner-log.jsonl`,
    'git -C /work/repo restore world/forge/rounds/R01/audit.json',
    `git -C /work -C repo/world/forge rm --cached rounds/R01/decision.json`,
    `git -c core.autocrlf=false -C ${FORGE} mv owner-log.jsonl /tmp/old.jsonl`,
    `git --git-dir=/work/repo/.git -C ${FORGE} checkout HEAD -- calibration/owner-answers.json`,
  ];
  for (const c of writes) assert.equal(bash(c, '/'), 'deny', c);
  for (const c of [`git -C ${FORGE} checkout main`, `git -C ${FORGE} restore ui/src/x.ts`, `git -C ${FORGE} log -- owner-log.jsonl`]) {
    assert.equal(bash(c, '/'), 'allow', c);
  }
});

test('links whose source is an owner file or a tree holding one → deny', () => {
  const links = [
    'ln -s owner-log.jsonl /tmp/x',
    'ln -s "$PWD/rounds/R01/audit.json" /tmp/a.json',
    'ln rounds/R01/decision.json /tmp/d.json',
    'ln -sf ../forge/calibration/owner-answers.json ui/a.json',
    'ln -s rounds /tmp/r',
    'ln -s -t /tmp owner-log.jsonl',
    'ln -s owner-log.jsonl',
    'cp -s rounds/R01/audit.json /tmp/a.json',
    'cp --symbolic-link owner-log.jsonl /tmp/x',
    'cp -l owner-log.jsonl /tmp/x',
    'cp -al rounds /tmp/r',
    'cp --link rounds/R01/audit.json /tmp/a.json',
    'link owner-log.jsonl /tmp/x',
    'sudo ln -s owner-log.jsonl /tmp/x',
  ];
  for (const c of links) assert.equal(bash(c), 'deny', c);
  const f = fixture();
  // the link's text resolves against the link's directory: ui/src/../../.. is world/, which holds forge/
  for (const c of [`ln -s ${f.forge} /tmp/f`, 'ln -s ../../.. ui/src/up', `ln -s ${f.repo} ui/src/repo`]) assert.equal(bash(c, f.forge), 'deny', c);
  f.cleanup();
});

test('links and copies that cannot reach an owner file → allow', () => {
  const ok = [
    'ln -s /tmp/a /tmp/b',
    'ln -s ../engine/cli.ts /tmp/cli.ts',
    'cp calibration/owner-answers.json /tmp/answers.json',
    'cp -r rounds/R01 /tmp/r01',
    'cp -L rounds/R01/audit.json /tmp/a.json',
    'cp -S .bak /tmp/a writers.json',
    'link /tmp/a /tmp/b',
  ];
  for (const c of ok) assert.equal(bash(c), 'allow', c);
});

test('git apply: a patch file, here-document, < file or cat pipe whose headers name an owner file → deny', () => {
  const f = fixture();
  const ownerPatch = join(f.repo, 'owner.patch');
  const uiPatch = join(f.repo, 'ui.patch');
  writeFileSync(ownerPatch, 'diff --git a/world/forge/rounds/R01/decision.json b/world/forge/rounds/R01/decision.json\n--- a/world/forge/rounds/R01/decision.json\n+++ b/world/forge/rounds/R01/decision.json\n@@ -1 +1 @@\n-{}\n+{"pick":"A"}\n');
  writeFileSync(uiPatch, 'diff --git a/world/forge/ui/src/x.ts b/world/forge/ui/src/x.ts\n--- a/world/forge/ui/src/x.ts\n+++ b/world/forge/ui/src/x.ts\n@@ -1 +1 @@\n-// rounds/R01/audit.json\n+// owner-log.jsonl\n');
  const heredoc = (flags: string, path: string): string => `git apply ${flags}<<'DIFF'\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-x\n+y\nDIFF`;
  const writes = [
    `git apply ${ownerPatch}`, `git apply --index -p1 ${ownerPatch}`, `git -C ${f.repo} apply owner.patch`, `git apply < ${ownerPatch}`,
    `cat ${ownerPatch} | git apply`, `cat ${ownerPatch} | git apply -`, heredoc('- ', 'world/forge/rounds/R01/decision.json'), heredoc('', 'owner-log.jsonl'),
    heredoc('-R ', 'calibration/owner-answers.json'), 'git diff HEAD~1 | git apply -R',
  ];
  for (const c of writes) assert.equal(bash(c, f.repo), 'deny', c);
  const ok = [
    `git apply ${uiPatch}`, `git apply < ${uiPatch}`, `cat ${uiPatch} | git apply`, heredoc('- ', 'world/forge/ui/src/x.ts'),
    `git apply --check ${ownerPatch}`, `git apply --stat ${ownerPatch}`, `git apply /tmp/does-not-exist.patch`,
  ];
  for (const c of ok) assert.equal(bash(c, f.repo), 'allow', c);
  assert.equal(bash('git diff HEAD~1 | git apply -R', f.other), 'allow');
  f.cleanup();
});
