import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { err, ok } from '../result.ts';
import type { Result } from '../result.ts';
import { fakeAssemblerStub, fakeClock, fakeDoctor, fakeEntropy, fakeGit, fakeGitHub, fakePorts } from './fakes.ts';

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'forge-fakes-'));
}

function put(repo: string, rel: string, text: string): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
}

function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const MAIN: Record<string, string> = {
  '.gitignore': 'node_modules/\n',
  'world/forge/.gitignore': 'local.json\n.runs/\n.sealed/\nrounds/*/mirror.jsonl\n',
  'world/current/BOOK.md': 'a\nb\nc\n',
  'world/forge/README.md': 'forge\n',
};

test('fakeClock: now is ISO UTC, advance and sleep move time, sleep is recorded and resolves at once', async () => {
  const clock = fakeClock('2026-10-01T00:00:00.000Z');
  assert.equal(clock.now(), '2026-10-01T00:00:00.000Z');
  clock.advance(1_500);
  assert.equal(clock.now(), '2026-10-01T00:00:01.500Z');
  await clock.sleep(5_000);
  await clock.sleep(30_000);
  assert.deepEqual(clock.slept(), [5_000, 30_000]);
  assert.equal(clock.now(), '2026-10-01T00:00:36.500Z');
  assert.throws(() => fakeClock('not a date'));
  assert.throws(() => clock.advance(-1));
});

test('fakeEntropy is a deterministic SHA-256 counter stream that never repeats across calls', () => {
  const a = fakeEntropy('seed');
  const b = fakeEntropy('seed');
  const first = a.bytes(8);
  const second = a.bytes(40);
  assert.equal(first.length, 8);
  assert.equal(second.length, 40);
  assert.deepEqual(b.bytes(48), Buffer.concat([first, second]));
  assert.notDeepEqual(fakeEntropy('other').bytes(8), first);
  assert.notDeepEqual(second.subarray(0, 8), first);
});

test('fakeDoctor and fakeAssemblerStub return their fixed results', async () => {
  assert.deepEqual(await fakeDoctor(err('red')).run(), err('red'));
  const assembled = ok({ referenceBookSha256: 'a'.repeat(64), characters: 3 });
  assert.deepEqual(await fakeAssemblerStub(assembled).assemble('8.2'), assembled);
});

test('fakeGitHub: ids from 1, createdAt from the clock, marker search, failNext, call log', async () => {
  const clock = fakeClock('2026-10-01T00:00:00.000Z');
  const gh = fakeGitHub(clock);
  const issue = value(await gh.createIssue({ title: 'R01', body: 'x\n<!-- forge:round R01 -->', labels: ['forge'], parent: null }));
  assert.equal(issue.number, 1);
  assert.deepEqual(value(await gh.findIssue('round R01')), issue);
  assert.equal(value(await gh.findIssue('round R02')), null);
  clock.advance(1_000);
  const c1 = value(await gh.createComment(1, 'hello'));
  assert.equal(c1.id, 1);
  assert.equal(c1.createdAt, '2026-10-01T00:00:01.000Z');
  gh.failNext('createComment', 2);
  assert.deepEqual(await gh.createComment(1, 'a'), err('fake github: createComment failed'));
  assert.deepEqual(await gh.createComment(1, 'b'), err('fake github: createComment failed'));
  const c2 = value(await gh.createComment(1, 'c'));
  assert.equal(c2.id, 2);
  const foreign = gh.inject(1, 'someone else');
  assert.equal(foreign.id, 3);
  assert.deepEqual(value(await gh.listComments(1)).map((c) => c.body), ['hello', 'c', 'someone else']);
  assert.deepEqual(gh.comments(1).map((c) => c.id), [1, 2, 3]);
  assert.deepEqual(gh.comments(2), []);
  const creates = gh.calls().filter((c) => c.op === 'createComment');
  assert.deepEqual(creates.map((c) => c.ok), [true, false, false, true]);
  assert.equal(creates[1]?.args[1], 'a');
});

test('fakeGitHub: created issues never reuse a number already referenced as a parent or comment target', async () => {
  const gh = fakeGitHub(fakeClock('2026-10-01T00:00:00.000Z'));
  value(await gh.createComment(1, 'bench notice on the epic'));
  const sub = value(await gh.createIssue({ title: 'R01', body: '<!-- forge:round R01 -->', labels: [], parent: 1 }));
  assert.equal(sub.number, 2);
  assert.equal(gh.issues()[0]?.parent, 1);
  const fresh = fakeGitHub(fakeClock('2026-10-01T00:00:00.000Z'));
  assert.equal(value(await fresh.createIssue({ title: 't', body: 'b', labels: [], parent: 7 })).number, 8);
});

test('fakeGit: main is written into repoDir; branches, commits, show, resolveRef, isAncestor, mergeToMain', async () => {
  const repo = tempRepo();
  try {
    const git = fakeGit(repo, MAIN);
    assert.equal(readFileSync(join(repo, 'world/current/BOOK.md'), 'utf8'), 'a\nb\nc\n');
    assert.equal(value(await git.currentBranch()), 'main');
    assert.equal(value(await git.branchExists('forge/r01')), false);
    value(await git.createBranch('forge/r01', 'main'));
    assert.equal(value(await git.branchExists('forge/r01')), true);
    assert.equal((await git.createBranch('forge/r01', 'main')).ok, false);
    assert.equal((await git.createBranch('x', 'nope')).ok, false);
    value(await git.checkout('forge/r01'));
    put(repo, 'world/forge/rounds/R01/start.json', '{}\n');
    put(repo, 'world/forge/rounds/R01/mirror.jsonl', 'ignored\n');
    const sha = value(await git.commit(['world/forge/rounds/R01'], 'chore: start R01 (#2)'));
    assert.ok(sha !== null && /^[0-9a-f]{40}$/u.test(sha));
    assert.equal(value(await git.commit(['world/forge/rounds/R01'], 'again')), null);
    assert.deepEqual(git.commits('forge/r01'), [{ branch: 'forge/r01', sha, message: 'chore: start R01 (#2)', paths: ['world/forge/rounds/R01/start.json'] }]);
    assert.deepEqual(git.commits('main'), []);
    assert.equal(value(await git.show('HEAD', 'world/forge/rounds/R01/start.json')), '{}\n');
    assert.equal(value(await git.show('main', 'world/forge/rounds/R01/start.json')), null);
    assert.equal((await git.show('nope', 'x')).ok, false);
    assert.equal(value(await git.resolveRef('forge/r01')), sha);
    assert.equal(value(await git.resolveRef('HEAD')), sha);
    assert.equal(value(await git.isAncestor('main', 'forge/r01')), true);
    assert.equal(value(await git.isAncestor('forge/r01', 'main')), false);
    value(await git.push('forge/r01'));
    assert.deepEqual(git.pushes(), ['forge/r01']);
    assert.equal((await git.push('nope')).ok, false);
    git.mergeToMain('forge/r01');
    assert.equal(value(await git.isAncestor('forge/r01', 'main')), true);
    assert.equal(git.tree('main')['world/forge/rounds/R01/start.json'], '{}\n');
    assert.equal(git.tree('main')['world/forge/rounds/R01/mirror.jsonl'], undefined);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('fakeGit: checkout rewrites the tracked files of the working tree and refuses to overwrite local changes', async () => {
  const repo = tempRepo();
  try {
    const git = fakeGit(repo, MAIN);
    value(await git.createBranch('forge/r01', 'main'));
    value(await git.checkout('forge/r01'));
    put(repo, 'world/current/BOOK.md', 'a\nB\nc\n');
    put(repo, 'world/current/09.md', 'new\n');
    value(await git.commit(['world/current'], 'feat: canon'));
    value(await git.checkout('main'));
    assert.equal(readFileSync(join(repo, 'world/current/BOOK.md'), 'utf8'), 'a\nb\nc\n');
    assert.equal(existsSync(join(repo, 'world/current/09.md')), false);
    value(await git.checkout('forge/r01'));
    assert.equal(readFileSync(join(repo, 'world/current/09.md'), 'utf8'), 'new\n');
    put(repo, 'world/current/09.md', 'dirty\n');
    assert.equal(value(await git.isClean([])), false);
    assert.equal(value(await git.isClean(['world/forge'])), true);
    const refused = await git.checkout('main');
    assert.equal(refused.ok, false);
    assert.equal(value(await git.currentBranch()), 'forge/r01');
    assert.equal(readFileSync(join(repo, 'world/current/09.md'), 'utf8'), 'dirty\n');
    assert.equal((await git.checkout('nope')).ok, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('fakeGit: checkout carries over a local edit or deletion of a path both branches agree on (as git does)', async () => {
  const repo = tempRepo();
  try {
    const git = fakeGit(repo, MAIN);
    value(await git.createBranch('forge/r01', 'main'));
    rmSync(join(repo, 'world/forge/README.md'));
    put(repo, 'world/current/BOOK.md', 'local\n');
    value(await git.checkout('forge/r01'));
    assert.equal(existsSync(join(repo, 'world/forge/README.md')), false, 'the local deletion survives the checkout');
    assert.equal(readFileSync(join(repo, 'world/current/BOOK.md'), 'utf8'), 'local\n', 'the local edit survives the checkout');
    assert.equal(value(await git.isClean([])), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('fakeGit: squashToMain gives main the branch tree in one commit; the branch is not an ancestor of main', async () => {
  const repo = tempRepo();
  try {
    const git = fakeGit(repo, MAIN);
    value(await git.createBranch('forge/r01', 'main'));
    value(await git.checkout('forge/r01'));
    put(repo, 'world/forge/rounds/R01/start.json', '{}\n');
    value(await git.commit(['world/forge/rounds/R01'], 'feat: round'));
    value(await git.checkout('main'));
    git.squashToMain('forge/r01');
    assert.equal(value(await git.isAncestor('forge/r01', 'main')), false);
    assert.equal(value(await git.show('main', 'world/forge/rounds/R01/start.json')), '{}\n');
    assert.equal(readFileSync(join(repo, 'world/forge/rounds/R01/start.json'), 'utf8'), '{}\n', 'the checked-out main follows');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('fakeGit: untracked, isClean and changedPaths honour .gitignore; ignored explicit paths are refused', async () => {
  const repo = tempRepo();
  try {
    const git = fakeGit(repo, MAIN);
    assert.equal(value(await git.isClean([])), true);
    put(repo, 'world/forge/local.json', '{}\n');
    put(repo, 'world/forge/.runs/R01/x.out.txt', 'raw\n');
    put(repo, 'world/forge/node_modules/p/index.js', '');
    put(repo, 'world/forge/rounds/R01/mirror.jsonl', '{}\n');
    assert.equal(value(await git.isClean([])), true);
    assert.deepEqual(value(await git.untracked([])), []);
    put(repo, 'world/forge/rounds/R01/start.json', '{}\n');
    put(repo, 'world/current/BOOK.md', 'a\nb\nc\nd\n');
    assert.deepEqual(value(await git.untracked(['world/forge'])), ['world/forge/rounds/R01/start.json']);
    assert.deepEqual(value(await git.changedPaths('main', [])), ['world/current/BOOK.md', 'world/forge/rounds/R01/start.json']);
    assert.deepEqual(value(await git.changedPaths('main', ['world/current/'])), ['world/current/BOOK.md']);
    assert.equal(value(await git.isClean(['world/forge/rounds'])), false);
    const ignored = await git.commit(['world/forge/rounds/R01/mirror.jsonl'], 'x');
    assert.equal(ignored.ok, false);
    assert.equal((await git.commit(['world/forge/.runs'], 'x')).ok, false);
    assert.equal((await git.commit(['world/forge/nothing-here'], 'x')).ok, false);
    assert.equal(git.commits('main').length, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('fakeGit: diff is a unified diff with 3 lines of context, new and deleted files included', async () => {
  const repo = tempRepo();
  try {
    const lines = Array.from({ length: 12 }, (_, i) => `l${i + 1}`);
    const git = fakeGit(repo, { 'doc.md': `${lines.join('\n')}\n`, 'gone.md': 'x\n' });
    put(repo, 'doc.md', `${lines.map((l) => (l === 'l6' ? 'L6' : l)).join('\n')}\n`);
    put(repo, 'new.md', 'n1\nn2');
    rmSync(join(repo, 'gone.md'));
    const text = value(await git.diff('main', []));
    assert.equal(
      text,
      [
        'diff --git a/doc.md b/doc.md',
        '--- a/doc.md',
        '+++ b/doc.md',
        '@@ -3,7 +3,7 @@',
        ' l3',
        ' l4',
        ' l5',
        '-l6',
        '+L6',
        ' l7',
        ' l8',
        ' l9',
        'diff --git a/gone.md b/gone.md',
        'deleted file mode 100644',
        '--- a/gone.md',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-x',
        'diff --git a/new.md b/new.md',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new.md',
        '@@ -0,0 +1,2 @@',
        '+n1',
        '+n2',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    );
    assert.equal(value(await git.diff('main', ['doc.md'])).split('\n')[0], 'diff --git a/doc.md b/doc.md');
    assert.equal(value(await git.diff('HEAD', ['nothing'])), '');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('fakeGit: failNext fails the next calls of one operation without side effects', async () => {
  const repo = tempRepo();
  try {
    const git = fakeGit(repo, MAIN);
    put(repo, 'world/forge/a.txt', 'a\n');
    git.failNext('commit', 1);
    git.failNext('push', 2);
    assert.deepEqual(await git.commit(['world/forge/a.txt'], 'm'), err('fake git: commit failed'));
    assert.equal(git.commits('main').length, 0);
    assert.ok(value(await git.commit(['world/forge/a.txt'], 'm')) !== null);
    assert.deepEqual(await git.push('main'), err('fake git: push failed'));
    assert.deepEqual(await git.push('main'), err('fake git: push failed'));
    value(await git.push('main'));
    assert.deepEqual(git.pushes(), ['main']);
    assert.deepEqual(git.calls().map((c) => `${c.op}:${String(c.ok)}`), ['commit:false', 'commit:true', 'push:false', 'push:false', 'push:true']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('fakePorts wires every fake on one clock', async () => {
  const repo = tempRepo();
  try {
    const ports = fakePorts({ repoDir: repo, main: MAIN, startIso: '2026-10-01T00:00:00.000Z', seed: 's' });
    await ports.clock.sleep(10);
    assert.equal(value(await ports.github.createComment(1, 'x')).createdAt, '2026-10-01T00:00:00.010Z');
    assert.equal(value(await ports.git.currentBranch()), 'main');
    assert.equal((await ports.doctor.run()).ok, true);
    assert.equal((await ports.assembler.assemble('8.2')).ok, true);
    assert.deepEqual(ports.entropy.bytes(4), fakeEntropy('s').bytes(4));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('fakeGit .gitignore matcher: anchored, **/, negation, nested ignore files, directory-only patterns', async () => {
  const repo = tempRepo();
  try {
    const git = fakeGit(repo, {
      '.gitignore': '**/node_modules/\n/wiki/public/art/\n**/.env.*\n!**/.env.example\n*.log\nbuild/\n',
      'world/forge/.gitignore': 'ui/dist/\nlocal.json\n',
    });
    const files = [
      'a/node_modules/x.js',
      'wiki/public/art/p.png',
      'x/wiki/public/art/p.png',
      'svc/.env.local',
      'svc/.env.example',
      'deep/run.log',
      'build',
      'x/build/out.txt',
      'world/forge/ui/dist/i.html',
      'world/ui/dist/i.html',
      'world/forge/local.json',
      'local.json',
    ];
    for (const f of files) put(repo, f, 'x\n');
    assert.deepEqual(value(await git.untracked([])), ['build', 'local.json', 'svc/.env.example', 'world/ui/dist/i.html', 'x/wiki/public/art/p.png']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
