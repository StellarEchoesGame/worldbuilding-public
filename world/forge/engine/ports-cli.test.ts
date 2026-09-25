import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProcessOptions, ProcessResult } from './adapters/process.ts';
import { cliDoctor, ghPort, gitPort, pythonAssembler, systemClock, systemEntropy } from './ports-cli.ts';
import type { RunProcess } from './ports-cli.ts';

interface Invocation {
  cmd: string;
  args: readonly string[];
  stdin: string | null;
  cwd: string;
}

type Reply = Partial<ProcessResult>;

/** A scripted runProcess: no real CLI is ever spawned. */
function fakeRun(reply: (inv: Invocation) => Reply): { run: RunProcess; log: Invocation[] } {
  const log: Invocation[] = [];
  const run = (cmd: string, args: readonly string[], opts: ProcessOptions): Promise<ProcessResult> => {
    const inv = { cmd, args: [...args], stdin: opts.stdin, cwd: opts.cwd };
    log.push(inv);
    return Promise.resolve({ code: 0, stdout: '', stderr: '', ms: 1, timedOut: false, ...reply(inv) });
  };
  return { run, log };
}

const comment = (id: number): Record<string, unknown> => ({
  id,
  html_url: `https://github.com/o/r/issues/5#issuecomment-${String(id)}`,
  created_at: '2026-09-25T12:00:00Z',
  body: `c${String(id)}`,
  author_association: 'OWNER',
});

test('ghPort.createComment posts the body on stdin and passes created_at through unchanged', async () => {
  const { run, log } = fakeRun(() => ({ stdout: JSON.stringify(comment(42)) }));
  const r = await ghPort('o/r', run).createComment(5, '<!-- forge:probe R01 x -->\nbody');
  assert.deepEqual(r, { ok: true, value: { id: 42, url: 'https://github.com/o/r/issues/5#issuecomment-42', createdAt: '2026-09-25T12:00:00Z', body: 'c42', authorAssociation: 'OWNER' } });
  assert.equal(log[0]?.cmd, 'gh');
  assert.deepEqual(log[0]?.args.slice(0, 3), ['api', '--method', 'POST']);
  assert.ok(log[0]?.args.includes('repos/o/r/issues/5/comments'));
  assert.deepEqual(log[0]?.args.slice(-2), ['--input', '-']);
  assert.deepEqual(JSON.parse(log[0]?.stdin ?? ''), { body: '<!-- forge:probe R01 x -->\nbody' });
});

test('ghPort.listComments pages until a short page', async () => {
  const { run, log } = fakeRun((inv) => {
    const page = inv.args.find((a) => a.includes('page='))?.endsWith('page=1') === true ? 1 : 2;
    const ids = page === 1 ? Array.from({ length: 100 }, (_, i) => i + 1) : [101];
    return { stdout: JSON.stringify(ids.map(comment)) };
  });
  const r = await ghPort('o/r', run).listComments(5);
  assert.ok(r.ok && r.value.length === 101 && r.value[100]?.id === 101);
  assert.ok(log[1]?.args.includes('repos/o/r/issues/5/comments?per_page=100&page=2'));
});

test('ghPort.findIssue matches the forge marker in issue bodies, skips pull requests and untrusted authors, takes the lowest number', async () => {
  const issues = [
    { number: 9, id: 900, html_url: 'u9', body: 'x <!-- forge:round R01 -->', author_association: 'OWNER' },
    { number: 4, id: 400, html_url: 'u4', body: '<!-- forge:round R01 -->', pull_request: {}, author_association: 'OWNER' },
    { number: 3, id: 300, html_url: 'u3', body: 'y <!-- forge:round R01 -->', author_association: 'MEMBER' },
    { number: 2, id: 200, html_url: 'u2', body: null, author_association: 'OWNER' },
    { number: 1, id: 100, html_url: 'u1', body: 'pre-created by anyone <!-- forge:round R01 -->', author_association: 'NONE' },
  ];
  const { run, log } = fakeRun(() => ({ stdout: JSON.stringify(issues) }));
  const gh = ghPort('o/r', run);
  assert.deepEqual(await gh.findIssue('round R01'), { ok: true, value: { number: 3, url: 'u3' } });
  assert.deepEqual(await gh.findIssue('round R02'), { ok: true, value: null });
  assert.ok(log[0]?.args.includes('repos/o/r/issues?state=all&per_page=100&page=1'));
});

test('ghPort.createIssue links the sub-issue by database id; a failed link warns and still succeeds', async () => {
  const { run, log } = fakeRun((inv) =>
    inv.args.some((a) => a.endsWith('/sub_issues')) ? { code: 1, stderr: 'HTTP 404: Not Found\n' } : { stdout: JSON.stringify({ number: 7, id: 7007, html_url: 'u7' }) },
  );
  const warnings: string[] = [];
  const r = await ghPort('o/r', run, (m) => warnings.push(m)).createIssue({ title: 'R01', body: 'b', labels: ['forge'], parent: 1 });
  assert.deepEqual(r, { ok: true, value: { number: 7, url: 'u7' } });
  assert.deepEqual(JSON.parse(log[0]?.stdin ?? ''), { title: 'R01', body: 'b', labels: ['forge'] });
  assert.ok(log[1]?.args.includes('repos/o/r/issues/1/sub_issues'));
  assert.deepEqual(JSON.parse(log[1]?.stdin ?? ''), { sub_issue_id: 7007 });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]?.includes('HTTP 404'));
  const noParent = fakeRun(() => ({ stdout: JSON.stringify({ number: 8, id: 8008, html_url: 'u8' }) }));
  await ghPort('o/r', noParent.run).createIssue({ title: 't', body: 'b', labels: [], parent: null });
  assert.equal(noParent.log.length, 1);
});

test('ghPort errors: exit code with the first stderr line, bad JSON, bad repo, bad issue number', async () => {
  const failing = fakeRun(() => ({ code: 1, stderr: '\nHTTP 422: Validation Failed\nmore' }));
  assert.deepEqual(await ghPort('o/r', failing.run).createComment(5, 'b'), {
    ok: false,
    error: 'gh api POST repos/o/r/issues/5/comments: exit 1: HTTP 422: Validation Failed',
  });
  const garbage = fakeRun(() => ({ stdout: 'not json' }));
  assert.equal((await ghPort('o/r', garbage.run).listComments(5)).ok, false);
  const none = fakeRun(() => ({}));
  assert.equal((await ghPort('not a repo', none.run).listComments(5)).ok, false);
  assert.equal((await ghPort('o/r', none.run).createComment(0, 'b')).ok, false);
  assert.equal(none.log.length, 0);
});

const sub = (inv: Invocation): string => inv.args[2] ?? '';

test('gitPort.commit: add -A, staged check, commit --only with the message on stdin, then the HEAD sha', async () => {
  const { run, log } = fakeRun((inv) => {
    if (sub(inv) === 'diff') return { code: 1 };
    if (sub(inv) === 'rev-parse') return { stdout: 'abc123\n' };
    return {};
  });
  const git = gitPort('/repo', run);
  assert.deepEqual(await git.commit(['world/forge/rounds/R01', '/repo/world/forge/x.json'], 'chore: R01 (#2)'), { ok: true, value: 'abc123' });
  const specs = ['--', ':(top,literal)world/forge/rounds/R01', ':(top,literal)world/forge/x.json'];
  assert.deepEqual(log[0]?.args, ['-C', '/repo', 'add', '-A', ...specs]);
  assert.deepEqual(log[1]?.args, ['-C', '/repo', 'diff', '--cached', '--quiet', '--no-ext-diff', ...specs]);
  assert.deepEqual(log[2]?.args, ['-C', '/repo', 'commit', '--quiet', '--cleanup=whitespace', '--file=-', '--only', ...specs]);
  assert.equal(log[2]?.stdin, 'chore: R01 (#2)');
  const nothing = fakeRun(() => ({}));
  assert.deepEqual(await gitPort('/repo', nothing.run).commit(['a'], 'm'), { ok: true, value: null });
  assert.equal(nothing.log.length, 2);
  const empty = fakeRun(() => ({}));
  assert.deepEqual(await gitPort('/repo', empty.run).commit([], 'm'), { ok: true, value: null });
  assert.equal(empty.log.length, 0);
});

test('gitPort.show: unknown ref → error, absent path → null, blob → content', async () => {
  const { run } = fakeRun((inv) => {
    if (sub(inv) === 'rev-parse') return inv.args.includes('nope^{commit}') ? { code: 1 } : { stdout: 'f00\n' };
    if (inv.args.includes('-t')) return inv.args.includes('f00:missing.md') ? { code: 128 } : { stdout: 'blob\n' };
    return { stdout: '内容\n' };
  });
  const git = gitPort('/repo', run);
  assert.deepEqual(await git.show('nope', 'a.md'), { ok: false, error: 'git: unknown ref nope' });
  assert.deepEqual(await git.show('main', 'missing.md'), { ok: true, value: null });
  assert.deepEqual(await git.show('main', 'a.md'), { ok: true, value: '内容\n' });
});

test('gitPort.diff marks untracked files intent-to-add for the diff and unstages them afterwards', async () => {
  const { run, log } = fakeRun((inv) => (sub(inv) === 'ls-files' ? { stdout: 'world/current/new.md\0' } : sub(inv) === 'diff' ? { stdout: 'DIFF' } : {}));
  assert.deepEqual(await gitPort('/repo', run).diff('abc', ['world/current']), { ok: true, value: 'DIFF' });
  assert.deepEqual(log.map(sub), ['ls-files', 'add', 'diff', 'reset']);
  assert.deepEqual(log[1]?.args.slice(3), ['--intent-to-add', '--', ':(top,literal)world/current/new.md']);
  assert.ok(['--no-ext-diff', '--no-renames', '-U3', 'abc'].every((a) => log[2]?.args.includes(a)));
  assert.deepEqual(log[3]?.args.slice(3), ['--quiet', '--', ':(top,literal)world/current/new.md']);
});

test('gitPort: changedPaths unions diff and untracked names; exit codes map to booleans; option-like names refused', async () => {
  const { run, log } = fakeRun((inv) => {
    if (sub(inv) === 'diff') return { stdout: 'b.md\0a.md\0' };
    if (sub(inv) === 'ls-files') return { stdout: 'c.md\0a.md\0' };
    if (sub(inv) === 'show-ref') return { code: 1 };
    if (sub(inv) === 'merge-base') return { code: inv.args.includes('x') ? 1 : 0 };
    if (sub(inv) === 'symbolic-ref') return { stdout: 'forge/r01\n' };
    if (sub(inv) === 'for-each-ref') return { stdout: 'refs/heads/main\nrefs/heads/forge/calib-q02\nrefs/heads/forge/r01\nrefs/heads/forge/calib-g01\n' };
    return { code: 128 };
  });
  const git = gitPort('/repo', run);
  assert.deepEqual(await git.listBranches('forge/calib-'), { ok: true, value: ['forge/calib-g01', 'forge/calib-q02'] });
  assert.deepEqual(await git.changedPaths('main', []), { ok: true, value: ['a.md', 'b.md', 'c.md'] });
  assert.deepEqual(await git.branchExists('forge/r01'), { ok: true, value: false });
  assert.deepEqual(await git.isAncestor('forge/r01', 'main'), { ok: true, value: true });
  assert.deepEqual(await git.isAncestor('x', 'main'), { ok: true, value: false });
  assert.deepEqual(await git.currentBranch(), { ok: true, value: 'forge/r01' });
  assert.equal((await git.resolveRef('main')).ok, false);
  const before = log.length;
  assert.equal((await git.checkout('--orphan')).ok, false);
  assert.equal((await git.push('-f')).ok, false);
  assert.equal(log.length, before);
});

test('pythonAssembler parses the one-line JSON summary; other output is an error', async () => {
  const sha = 'a'.repeat(64);
  const good = fakeRun(() => ({ stdout: `${JSON.stringify({ reference_book_sha256: sha, characters: 12 })}\n` }));
  assert.deepEqual(await pythonAssembler('/repo', good.run).assemble('8.2'), { ok: true, value: { referenceBookSha256: sha, characters: 12 } });
  assert.deepEqual(good.log[0]?.args, ['world/current/reference/assemble_reference.py', '--revision=8.2']);
  assert.equal(good.log[0]?.cwd, '/repo');
  assert.equal((await pythonAssembler('/repo', fakeRun(() => ({ stdout: '{"characters":1}' })).run).assemble('8.2')).ok, false);
  const refused = fakeRun(() => ({ code: 1, stderr: '--revision 8.3 does not match manifest revision 8.2\n' }));
  assert.deepEqual(await pythonAssembler('/repo', refused.run).assemble('8.3'), {
    ok: false,
    error: 'assemble_reference.py: exit 1: --revision 8.3 does not match manifest revision 8.2',
  });
});

test('cliDoctor: exit 0 → the report; otherwise the red lines', async () => {
  const green = fakeRun(() => ({ stdout: '✔ a\n' }));
  assert.deepEqual(await cliDoctor('/forge', green.run).run(), { ok: true, value: '✔ a\n' });
  assert.deepEqual(green.log[0]?.args, ['engine/cli.ts', 'doctor']);
  assert.equal(green.log[0]?.cwd, '/forge');
  const red = fakeRun(() => ({ code: 1, stdout: '✔ a\n✖ b  timeout\n' }));
  assert.deepEqual(await cliDoctor('/forge', red.run).run(), { ok: false, error: 'forge doctor: exit 1 | ✖ b  timeout' });
});

test('systemClock and systemEntropy', async () => {
  assert.match(systemClock().now(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  await systemClock().sleep(1);
  assert.equal(systemEntropy().bytes(16).length, 16);
});
