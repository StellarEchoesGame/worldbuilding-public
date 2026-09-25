import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { Assembler, Clock, Doctor, Entropy, GitHubComment, GitHubIssue, GitHubPort, GitPort, Ports } from '../ports.ts';
import { err, ok } from '../result.ts';
import type { Result } from '../result.ts';

/** Deterministic in-memory ports for tests: no network, no git binary, no real clock. */

/** One recorded port call (failed ones included), for assertions such as "no commit before the scan failed". */
export interface FakeCall<Op extends string> {
  op: Op;
  args: readonly string[];
  ok: boolean;
}

export interface FakeIssue extends GitHubIssue {
  title: string;
  body: string;
  labels: string[];
  parent: number | null;
}

export interface FakeComment extends GitHubComment {
  issue: number;
}

export interface FakeGitHub extends GitHubPort {
  issues(): readonly FakeIssue[];
  /** All comments, or those of one issue, in creation order. */
  comments(issue?: number): readonly FakeComment[];
  /** The next `times` calls of `op` fail with err('fake github: <op> failed'). */
  failNext(op: keyof GitHubPort, times: number): void;
  /** Adds a comment as if someone else posted it (foreign probe tests); `association` defaults to COLLABORATOR. */
  inject(issue: number, body: string, association?: string): FakeComment;
  /** Every port call in order: createIssue args [title, body, labels, parent], createComment [issue, body], … */
  calls(): readonly FakeCall<keyof GitHubPort>[];
}

export interface FakeCommit {
  branch: string;
  sha: string;
  message: string;
  /** Repository-relative paths committed. */
  paths: string[];
}

/**
 * Keeps a branch → tree map (repo-relative path → content); `checkout` rewrites the tracked files of the
 * temp working tree under repoDir; `commit` snapshots the given paths from disk into the current branch.
 */
export interface FakeGit extends GitPort {
  commits(branch: string): readonly FakeCommit[];
  /** Branch names in push order. */
  pushes(): readonly string[];
  /** Simulated PR merge: main's tree becomes the branch's tree. */
  mergeToMain(branch: string): void;
  /** Simulated squash merge (the project's PR convention): one new main commit with the branch's tree; the branch is not an ancestor of main. */
  squashToMain(branch: string): void;
  tree(branch: string): Readonly<Record<string, string>>;
  failNext(op: keyof GitPort, times: number): void;
  /** Every port call in order, with its string arguments. */
  calls(): readonly FakeCall<keyof GitPort>[];
}

export interface FakeClock extends Clock {
  advance(ms: number): void;
  /** Every sleep duration requested, in order (sleep advances the clock and resolves at once). */
  slept(): readonly number[];
}

export function fakeClock(startIso: string): FakeClock {
  let at = Date.parse(startIso);
  if (!Number.isFinite(at)) throw new Error(`fakeClock: not an ISO timestamp: ${startIso}`);
  const slept: number[] = [];
  const advance = (ms: number): void => {
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`fakeClock: cannot advance by ${String(ms)} ms`);
    at += ms;
  };
  return {
    now: () => new Date(at).toISOString(),
    sleep: (ms: number): Promise<void> => {
      slept.push(ms);
      advance(ms);
      return Promise.resolve();
    },
    advance,
    slept: () => [...slept],
  };
}

/** bytes(n) = a SHA-256 counter stream over `seed`; successive calls continue the stream. */
export function fakeEntropy(seed: string): Entropy {
  let counter = 0;
  let pool = Buffer.alloc(0);
  return {
    bytes(n: number): Buffer {
      while (pool.length < n) {
        const block = createHash('sha256').update(`${seed}\0${String(counter)}`).digest();
        counter += 1;
        pool = Buffer.concat([pool, block]);
      }
      const out = Buffer.from(pool.subarray(0, n));
      pool = pool.subarray(n);
      return out;
    },
  };
}

export function fakeDoctor(result: Result<string>): Doctor {
  return { run: () => Promise.resolve(result) };
}

/** Returns `result` for every revision (the TS reimplementation of the assembler is PR-D fake-assembler.ts). */
export function fakeAssemblerStub(result: Result<{ referenceBookSha256: string; characters: number }>): Assembler {
  return { assemble: () => Promise.resolve(result) };
}

/** Pops one pending failure of `op`, if any. */
function takeFailure<Op extends string>(pending: Map<Op, number>, op: Op): boolean {
  const left = pending.get(op) ?? 0;
  if (left <= 0) return false;
  pending.set(op, left - 1);
  return true;
}

/**
 * createdAt = clock.now(); issue and comment ids increment from 1. A created issue never takes a number already
 * referenced as a parent or comment target (the epic issue of github.json exists without being created here).
 */
export function fakeGitHub(clock: Clock): FakeGitHub {
  const issues: FakeIssue[] = [];
  const comments: FakeComment[] = [];
  const referenced = new Set<number>();
  const pending = new Map<keyof GitHubPort, number>();
  const log: FakeCall<keyof GitHubPort>[] = [];
  const issueUrl = (n: number): string => `https://github.invalid/fake/issues/${String(n)}`;
  const record = <T>(op: keyof GitHubPort, args: readonly string[], run: () => T): Result<T> => {
    if (takeFailure(pending, op)) {
      log.push({ op, args, ok: false });
      return err(`fake github: ${op} failed`);
    }
    log.push({ op, args, ok: true });
    return ok(run());
  };
  const addComment = (issue: number, body: string, authorAssociation: string): FakeComment => {
    referenced.add(issue);
    const id = comments.length + 1;
    const c: FakeComment = { id, url: `${issueUrl(issue)}#issuecomment-${String(id)}`, createdAt: clock.now(), body, authorAssociation, issue };
    comments.push(c);
    return c;
  };
  const publicComment = (c: FakeComment): GitHubComment => ({ id: c.id, url: c.url, createdAt: c.createdAt, body: c.body, authorAssociation: c.authorAssociation });
  return {
    findIssue: (marker) =>
      Promise.resolve(
        record('findIssue', [marker], () => {
          const hit = issues.find((i) => i.body.includes(`<!-- forge:${marker} -->`));
          return hit === undefined ? null : { number: hit.number, url: hit.url };
        }),
      ),
    createIssue: (input) =>
      Promise.resolve(
        record('createIssue', [input.title, input.body, input.labels.join(','), String(input.parent)], () => {
          if (input.parent !== null) referenced.add(input.parent);
          const number = Math.max(0, ...referenced, ...issues.map((i) => i.number)) + 1;
          const issue: FakeIssue = { number, url: issueUrl(number), title: input.title, body: input.body, labels: [...input.labels], parent: input.parent };
          issues.push(issue);
          return { number, url: issue.url };
        }),
      ),
    listComments: (issue) =>
      Promise.resolve(
        record('listComments', [String(issue)], () => {
          referenced.add(issue);
          return comments.filter((c) => c.issue === issue).map(publicComment);
        }),
      ),
    createComment: (issue, body) => Promise.resolve(record('createComment', [String(issue), body], () => publicComment(addComment(issue, body, 'OWNER')))),
    issues: () => issues.map((i) => ({ ...i, labels: [...i.labels] })),
    comments: (issue) => comments.filter((c) => issue === undefined || c.issue === issue).map((c) => ({ ...c })),
    failNext: (op, times) => {
      pending.set(op, (pending.get(op) ?? 0) + times);
    },
    inject: (issue, body, association = 'COLLABORATOR') => ({ ...addComment(issue, body, association) }),
    calls: () => [...log],
  };
}

// ---- working-tree helpers: a small .gitignore matcher (enough for the repository's own ignore files) ----

interface IgnoreRule {
  /** Directory of the .gitignore file, repo-relative ('' = root). */
  base: string;
  negate: boolean;
  dirOnly: boolean;
  re: RegExp;
}

function escapeRe(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');
}

function globBody(glob: string): string {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob.charAt(i);
    const atSegmentStart = i === 0 || glob.charAt(i - 1) === '/';
    if (ch === '*' && glob.charAt(i + 1) === '*' && atSegmentStart && (i + 2 === glob.length || glob.charAt(i + 2) === '/')) {
      out += i + 2 === glob.length ? '.*' : '(?:.*/)?';
      i += 3;
    } else if (ch === '*') {
      out += '[^/]*';
      i += glob.charAt(i + 1) === '*' ? 2 : 1;
    } else if (ch === '?') {
      out += '[^/]';
      i += 1;
    } else if (ch === '[' && glob.indexOf(']', i + 2) !== -1) {
      const close = glob.indexOf(']', i + 2);
      const cls = glob.slice(i + 1, close).replace(/\\/gu, '\\\\');
      out += `[${cls.startsWith('!') ? `^${cls.slice(1)}` : cls}]`;
      i = close + 1;
    } else if (ch === '\\' && i + 1 < glob.length) {
      out += escapeRe(glob.charAt(i + 1));
      i += 2;
    } else {
      out += escapeRe(ch);
      i += 1;
    }
  }
  return out;
}

function parseIgnore(base: string, text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split('\n')) {
    let line = raw.replace(/\r$/u, '').replace(/(?<!\\) +$/u, '');
    if (line === '' || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate || line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    if (line === '') continue;
    const anchored = line.includes('/');
    const body = globBody(line.startsWith('/') ? line.slice(1) : line);
    rules.push({ base, negate, dirOnly, re: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`) });
  }
  return rules;
}

/** (rel, isDir) → ignored by the on-disk .gitignore files of rel's ancestors (a path under an ignored directory is ignored). */
type IgnoreCheck = (rel: string, isDir: boolean) => boolean;

function ignoreChecker(repoDir: string): IgnoreCheck {
  const cache = new Map<string, IgnoreRule[]>();
  const rulesOf = (dir: string): IgnoreRule[] => {
    const hit = cache.get(dir);
    if (hit !== undefined) return hit;
    const text = readDisk(repoDir, dir === '' ? '.gitignore' : `${dir}/.gitignore`);
    const rules = text === null ? [] : parseIgnore(dir, text);
    cache.set(dir, rules);
    return rules;
  };
  const entryIgnored = (rel: string, isDir: boolean): boolean => {
    const parts = rel.split('/');
    let ignored = false;
    for (let k = 0; k < parts.length; k += 1) {
      const base = parts.slice(0, k).join('/');
      const sub = parts.slice(k).join('/');
      for (const r of rulesOf(base)) if ((!r.dirOnly || isDir) && r.re.test(sub)) ignored = !r.negate;
    }
    return ignored;
  };
  return (rel, isDir) => {
    const parts = rel.split('/');
    for (let k = 1; k < parts.length; k += 1) if (entryIgnored(parts.slice(0, k).join('/'), true)) return true;
    return entryIgnored(rel, isDir);
  };
}

function readDisk(repoDir: string, rel: string): string | null {
  const stat = lstatSync(join(repoDir, rel), { throwIfNoEntry: false });
  return stat !== undefined && stat.isFile() ? readFileSync(join(repoDir, rel), 'utf8') : null;
}

function isDiskDir(repoDir: string, rel: string): boolean {
  return lstatSync(join(repoDir, rel), { throwIfNoEntry: false })?.isDirectory() === true;
}

/** Every non-ignored file under repoDir (repo-relative, '/'-separated, sorted), `.git` skipped. */
function walkFiles(repoDir: string, ignored: IgnoreCheck): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const e of readdirSync(dir === '' ? repoDir : join(repoDir, dir), { withFileTypes: true })) {
      const rel = dir === '' ? e.name : `${dir}/${e.name}`;
      if (e.name === '.git') continue;
      if (e.isDirectory()) {
        if (!ignored(rel, true)) visit(rel);
      } else if (e.isFile() && !ignored(rel, false)) out.push(rel);
    }
  };
  if (existsSync(repoDir)) visit('');
  return out.sort();
}

// ---- a unified diff close to `git diff -U3` (LCS over lines; no index lines) ----

interface DiffOp {
  kind: ' ' | '-' | '+';
  /** The line including its '\n'; the last line of a file without a final newline has none. */
  line: string;
}

function splitLines(text: string | null): string[] {
  if (text === null || text === '') return [];
  const parts = text.split('\n');
  const tail = parts.pop() ?? '';
  const lines = parts.map((p) => `${p}\n`);
  if (tail !== '') lines.push(tail);
  return lines;
}

function editScript(a: readonly string[], b: readonly string[]): DiffOp[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const mid: DiffOp[] = [];
  const n = am.length;
  const m = bm.length;
  const w = m + 1;
  const lcs = n * m > 4_000_000 ? null : new Uint32Array((n + 1) * w);
  if (lcs !== null) {
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[i * w + j] = am[i] === bm[j] ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1 : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0);
      }
    }
  }
  let i = 0;
  let j = 0;
  while (lcs !== null && i < n && j < m) {
    const x = am[i] ?? '';
    const y = bm[j] ?? '';
    if (x === y) {
      mid.push({ kind: ' ', line: x });
      i += 1;
      j += 1;
    } else if ((lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0)) {
      mid.push({ kind: '-', line: x });
      i += 1;
    } else {
      mid.push({ kind: '+', line: y });
      j += 1;
    }
  }
  for (; i < n; i += 1) mid.push({ kind: '-', line: am[i] ?? '' });
  for (; j < m; j += 1) mid.push({ kind: '+', line: bm[j] ?? '' });
  const same = (lines: readonly string[]): DiffOp[] => lines.map((line) => ({ kind: ' ', line }));
  return [...same(a.slice(0, pre)), ...mid, ...same(a.slice(a.length - suf))];
}

function hunkRange(start: number, len: number): string {
  if (len === 0) return `${String(start - 1)},0`;
  return len === 1 ? String(start) : `${String(start)},${String(len)}`;
}

function hunks(ops: readonly DiffOp[], context: number): string[] {
  const groups: Array<{ start: number; end: number }> = [];
  ops.forEach((op, k) => {
    if (op.kind === ' ') return;
    const start = Math.max(0, k - context);
    const end = Math.min(ops.length, k + context + 1);
    const last = groups[groups.length - 1];
    if (last !== undefined && start <= last.end) last.end = end;
    else groups.push({ start, end });
  });
  const out: string[] = [];
  for (const g of groups) {
    const before = ops.slice(0, g.start);
    const inside = ops.slice(g.start, g.end);
    const count = (list: readonly DiffOp[], skip: DiffOp['kind']): number => list.filter((o) => o.kind !== skip).length;
    out.push(`@@ -${hunkRange(count(before, '+') + 1, count(inside, '+'))} +${hunkRange(count(before, '-') + 1, count(inside, '-'))} @@`);
    for (const o of inside) {
      out.push(`${o.kind}${o.line.endsWith('\n') ? o.line.slice(0, -1) : o.line}`);
      if (!o.line.endsWith('\n')) out.push('\\ No newline at end of file');
    }
  }
  return out;
}

function fileDiff(path: string, a: string | null, b: string | null): string {
  if (a === b) return '';
  const lines = [`diff --git a/${path} b/${path}`];
  if (a === null) lines.push('new file mode 100644');
  if (b === null) lines.push('deleted file mode 100644');
  const body = hunks(editScript(splitLines(a), splitLines(b)), 3);
  if (body.length > 0) lines.push(a === null ? '--- /dev/null' : `--- a/${path}`, b === null ? '+++ /dev/null' : `+++ b/${path}`, ...body);
  return `${lines.join('\n')}\n`;
}

// ---- fake git: commit graph in memory, working tree on disk ----

interface CommitNode {
  parents: readonly string[];
  tree: Readonly<Record<string, string>>;
}

function toRel(repoDir: string, p: string): string {
  let rel = (isAbsolute(p) ? relative(repoDir, p) : p).split(sep).join('/');
  while (rel.startsWith('./')) rel = rel.slice(2);
  while (rel.endsWith('/')) rel = rel.slice(0, -1);
  return rel === '.' ? '' : rel;
}

/** No scopes = the whole repository; a scope matches itself and everything below it. */
function inScope(rel: string, scopes: readonly string[]): boolean {
  return scopes.length === 0 || scopes.some((s) => s === '' || rel === s || rel.startsWith(`${s}/`));
}

function pruneEmptyDirs(repoDir: string, relDir: string): void {
  let dir = relDir;
  while (dir !== '.' && dir !== '' && isDiskDir(repoDir, dir) && readdirSync(join(repoDir, dir)).length === 0) {
    rmdirSync(join(repoDir, dir));
    dir = dirname(dir);
  }
}

/** Moves the working tree from tree `from` to tree `to` (tracked files only; untracked files stay). */
/**
 * Moves the working tree from tree `from` to tree `to`, touching only paths whose content differs between them
 * (as git does: a local edit or deletion of a path both trees agree on is carried over).
 */
function applyTree(repoDir: string, from: Readonly<Record<string, string>>, to: Readonly<Record<string, string>>): void {
  for (const p of Object.keys(from)) {
    if (Object.hasOwn(to, p)) continue;
    rmSync(join(repoDir, p), { force: true });
    pruneEmptyDirs(repoDir, dirname(p));
  }
  for (const [p, content] of Object.entries(to)) {
    if (from[p] === content || readDisk(repoDir, p) === content) continue;
    mkdirSync(dirname(join(repoDir, p)), { recursive: true });
    writeFileSync(join(repoDir, p), content);
  }
}

/** `main` = repo-relative path → content of the main branch (also written into repoDir). */
export function fakeGit(repoDir: string, main: Record<string, string>): FakeGit {
  const nodes = new Map<string, CommitNode>();
  const heads = new Map<string, string>();
  const history: FakeCommit[] = [];
  const pushed: string[] = [];
  const log: FakeCall<keyof GitPort>[] = [];
  const pending = new Map<keyof GitPort, number>();
  let head = 'main';
  let serial = 0;
  const addNode = (parents: readonly string[], tree: Readonly<Record<string, string>>, message: string): string => {
    serial += 1;
    const entries = Object.entries(tree).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const sha = createHash('sha1').update(JSON.stringify([serial, parents, message, entries])).digest('hex');
    nodes.set(sha, { parents: [...parents], tree: { ...tree } });
    return sha;
  };
  const resolve = (ref: string): string | null => {
    if (ref === 'HEAD') return heads.get(head) ?? null;
    const byName = heads.get(ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref);
    if (byName !== undefined) return byName;
    if (nodes.has(ref)) return ref;
    const hits = /^[0-9a-f]{4,39}$/u.test(ref) ? [...nodes.keys()].filter((s) => s.startsWith(ref)) : [];
    return hits.length === 1 ? (hits[0] ?? null) : null;
  };
  const treeAt = (ref: string): Readonly<Record<string, string>> | null => {
    const sha = resolve(ref);
    return sha === null ? null : (nodes.get(sha)?.tree ?? null);
  };
  const current = (): Readonly<Record<string, string>> => treeAt('HEAD') ?? {};
  const scopesOf = (paths: readonly string[]): string[] => paths.map((p) => toRel(repoDir, p));
  const untrackedIn = (scopes: readonly string[]): string[] => {
    const tracked = current();
    return walkFiles(repoDir, ignoreChecker(repoDir)).filter((f) => !Object.hasOwn(tracked, f) && inScope(f, scopes));
  };
  /** What git sees in the working tree: tracked files always, untracked ones unless ignored. */
  const worktree = (p: string, tracked: Readonly<Record<string, string>>, ignored: IgnoreCheck): string | null =>
    Object.hasOwn(tracked, p) || !ignored(p, false) ? readDisk(repoDir, p) : null;
  const changedAgainst = (base: Readonly<Record<string, string>>, scopes: readonly string[]): string[] => {
    const tracked = current();
    const ignored = ignoreChecker(repoDir);
    const candidates = new Set([...Object.keys(base), ...Object.keys(tracked), ...untrackedIn(scopes)]);
    return [...candidates].filter((p) => inScope(p, scopes) && worktree(p, tracked, ignored) !== (base[p] ?? null)).sort();
  };
  const call = <T>(op: keyof GitPort, args: readonly string[], body: () => Result<T>): Promise<Result<T>> => {
    if (takeFailure(pending, op)) {
      log.push({ op, args, ok: false });
      return Promise.resolve(err(`fake git: ${op} failed`));
    }
    const r = body();
    log.push({ op, args, ok: r.ok });
    return Promise.resolve(r);
  };
  applyTree(repoDir, {}, main);
  heads.set('main', addNode([], main, 'initial'));
  const commitPaths = (paths: readonly string[], message: string): Result<string | null> => {
    if (paths.length === 0) return ok(null);
    const tracked = current();
    const ignored = ignoreChecker(repoDir);
    const include = new Set<string>();
    for (const rel of scopesOf(paths)) {
      const trackedUnder = Object.keys(tracked).filter((t) => inScope(t, [rel]));
      if (readDisk(repoDir, rel) !== null) {
        if (!Object.hasOwn(tracked, rel) && ignored(rel, false)) return err(`fake git: commit: path is ignored: ${rel}`);
        include.add(rel);
      } else if (rel === '' || isDiskDir(repoDir, rel)) {
        if (rel !== '' && trackedUnder.length === 0 && ignored(rel, true)) return err(`fake git: commit: path is ignored: ${rel}`);
        for (const f of walkFiles(repoDir, ignored)) if (inScope(f, [rel])) include.add(f);
        for (const t of trackedUnder) include.add(t);
      } else if (trackedUnder.length > 0) {
        for (const t of trackedUnder) include.add(t);
      } else {
        return err(`fake git: commit: pathspec '${rel}' did not match any files`);
      }
    }
    const next: Record<string, string> = { ...tracked };
    const changed: string[] = [];
    for (const f of include) {
      const disk = readDisk(repoDir, f);
      if (disk === (tracked[f] ?? null)) continue;
      changed.push(f);
      if (disk === null) delete next[f];
      else next[f] = disk;
    }
    if (changed.length === 0) return ok(null);
    const parent = heads.get(head);
    const sha = addNode(parent === undefined ? [] : [parent], next, message);
    heads.set(head, sha);
    history.push({ branch: head, sha, message, paths: changed.sort() });
    return ok(sha);
  };
  const checkoutBranch = (name: string): Result<void> => {
    const target = heads.get(name);
    if (target === undefined) return err(`fake git: unknown branch ${name}`);
    const from = current();
    const to = nodes.get(target)?.tree ?? {};
    const ignored = ignoreChecker(repoDir);
    const conflicts: string[] = [];
    for (const p of new Set([...Object.keys(from), ...Object.keys(to)])) {
      const old = from[p] ?? null;
      const next = to[p] ?? null;
      if (old === next) continue;
      const disk = readDisk(repoDir, p);
      if (disk === next) continue;
      if (old !== null ? disk !== old : disk !== null && !ignored(p, false)) conflicts.push(p);
    }
    if (conflicts.length > 0) return err(`fake git: checkout would overwrite local changes: ${conflicts.sort().join(', ')}`);
    applyTree(repoDir, from, to);
    head = name;
    return ok(undefined);
  };
  const isAncestorOf = (ref: string, of: string): Result<boolean> => {
    const a = resolve(ref);
    const b = resolve(of);
    if (a === null || b === null) return err(`fake git: unknown ref ${a === null ? ref : of}`);
    const seen = new Set<string>();
    const queue = [b];
    for (let sha = queue.shift(); sha !== undefined; sha = queue.shift()) {
      if (sha === a) return ok(true);
      if (seen.has(sha)) continue;
      seen.add(sha);
      queue.push(...(nodes.get(sha)?.parents ?? []));
    }
    return ok(false);
  };
  const treeOr = <T>(ref: string, use: (tree: Readonly<Record<string, string>>) => Result<T>): Result<T> => {
    const tree = treeAt(ref);
    return tree === null ? err(`fake git: unknown ref ${ref}`) : use(tree);
  };
  return {
    currentBranch: () => call('currentBranch', [], () => ok(head)),
    branchExists: (name) => call('branchExists', [name], () => ok(heads.has(name))),
    listBranches: (prefix) => call('listBranches', [prefix], () => ok([...heads.keys()].filter((n) => n.startsWith(prefix)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))),
    createBranch: (name, from) =>
      call('createBranch', [name, from], () => {
        if (heads.has(name)) return err(`fake git: branch exists: ${name}`);
        const sha = resolve(from);
        if (sha === null) return err(`fake git: unknown ref ${from}`);
        heads.set(name, sha);
        return ok(undefined);
      }),
    checkout: (name) => call('checkout', [name], () => checkoutBranch(name)),
    show: (ref, repoPath) => call('show', [ref, repoPath], () => treeOr(ref, (tree) => ok(tree[toRel(repoDir, repoPath)] ?? null))),
    isClean: (repoPaths) =>
      call('isClean', [...repoPaths], () => {
        const scopes = scopesOf(repoPaths);
        const tracked = current();
        for (const [p, content] of Object.entries(tracked)) if (inScope(p, scopes) && readDisk(repoDir, p) !== content) return ok(false);
        return ok(untrackedIn(scopes).length === 0);
      }),
    diff: (baseRef, repoPaths) =>
      call('diff', [baseRef, ...repoPaths], () =>
        treeOr(baseRef, (base) => {
          const tracked = current();
          const ignored = ignoreChecker(repoDir);
          const files = changedAgainst(base, scopesOf(repoPaths));
          return ok(files.map((f) => fileDiff(f, base[f] ?? null, worktree(f, tracked, ignored))).join(''));
        }),
      ),
    commit: (paths, message) => call('commit', [message, ...paths], () => commitPaths(paths, message)),
    push: (branch) =>
      call('push', [branch], () => {
        if (!heads.has(branch)) return err(`fake git: unknown branch ${branch}`);
        pushed.push(branch);
        return ok(undefined);
      }),
    changedPaths: (baseRef, repoPaths) => call('changedPaths', [baseRef, ...repoPaths], () => treeOr(baseRef, (base) => ok(changedAgainst(base, scopesOf(repoPaths))))),
    untracked: (repoPaths) => call('untracked', [...repoPaths], () => ok(untrackedIn(scopesOf(repoPaths)))),
    resolveRef: (ref) =>
      call('resolveRef', [ref], () => {
        const sha = resolve(ref);
        return sha === null ? err(`fake git: unknown ref ${ref}`) : ok(sha);
      }),
    isAncestor: (ref, of) => call('isAncestor', [ref, of], () => isAncestorOf(ref, of)),
    commits: (branch) => history.filter((c) => c.branch === branch).map((c) => ({ ...c, paths: [...c.paths] })),
    pushes: () => [...pushed],
    mergeToMain: (branch) => {
      const b = heads.get(branch);
      const m = heads.get('main');
      if (b === undefined || m === undefined) throw new Error(`fakeGit.mergeToMain: unknown branch ${branch}`);
      const before = nodes.get(m)?.tree ?? {};
      const after = nodes.get(b)?.tree ?? {};
      heads.set('main', addNode([m, b], after, `Merge ${branch}`));
      if (head === 'main') applyTree(repoDir, before, after);
    },
    squashToMain: (branch) => {
      const b = heads.get(branch);
      const m = heads.get('main');
      if (b === undefined || m === undefined) throw new Error(`fakeGit.squashToMain: unknown branch ${branch}`);
      const before = nodes.get(m)?.tree ?? {};
      const after = nodes.get(b)?.tree ?? {};
      heads.set('main', addNode([m], after, `Squash ${branch}`));
      if (head === 'main') applyTree(repoDir, before, after);
    },
    tree: (branch) => {
      const sha = heads.get(branch);
      if (sha === undefined) throw new Error(`fakeGit.tree: unknown branch ${branch}`);
      return { ...(nodes.get(sha)?.tree ?? {}) };
    },
    failNext: (op, times) => {
      pending.set(op, (pending.get(op) ?? 0) + times);
    },
    calls: () => [...log],
  };
}

export interface FakePorts extends Ports {
  github: FakeGitHub;
  git: FakeGit;
  clock: FakeClock;
}

/** fakeGitHub + fakeGit + fakeClock + fakeEntropy + fakeDoctor(ok) + fakeAssemblerStub(ok). */
export function fakePorts(input: { repoDir: string; main: Record<string, string>; startIso: string; seed: string }): FakePorts {
  const clock = fakeClock(input.startIso);
  return {
    github: fakeGitHub(clock),
    git: fakeGit(input.repoDir, input.main),
    clock,
    entropy: fakeEntropy(input.seed),
    doctor: fakeDoctor(ok('doctor: every backend green (fake)')),
    assembler: fakeAssemblerStub(ok({ referenceBookSha256: createHash('sha256').update('').digest('hex'), characters: 0 })),
  };
}
