import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { runProcess } from './adapters/process.ts';
import type { ProcessResult } from './adapters/process.ts';
import { isRecord, readNumber, readString } from './json.ts';
import type { JsonRecord } from './json.ts';
import { isTrustedAuthor, type Assembler, type Clock, type Doctor, type Entropy, type GitHubComment, type GitHubIssue, type GitHubPort, type GitPort } from './ports.ts';
import { err, ok } from './result.ts';
import type { Result } from './result.ts';

/** Production ports on adapters/process.ts runProcess (`gh`, `git -C <repo>`, `python3`). */
export type RunProcess = typeof runProcess;

const GH_TIMEOUT_MS = 60_000;
const GH_PAGE = 100;
const GH_MAX_PAGES = 50;
const GH_ENV: Record<string, string> = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };
const GIT_TIMEOUT_MS = 60_000;
const GIT_PUSH_TIMEOUT_MS = 180_000;
const GIT_ENV: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
/** Inherited repository / pathspec overrides would point git elsewhere or change how paths match. */
const GIT_UNSET: readonly string[] = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_LITERAL_PATHSPECS',
  'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS',
  'GIT_ICASE_PATHSPECS',
];
const ASSEMBLER_TIMEOUT_MS = 120_000;
const DOCTOR_TIMEOUT_MS = 20 * 60_000;

function firstLine(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function failure(what: string, r: ProcessResult): string {
  if (r.timedOut) return `${what}: timed out after ${String(Math.round(r.ms / 1000))} s`;
  const line = firstLine(r.stderr);
  return `${what}: exit ${r.code === null ? 'none' : String(r.code)}${line === '' ? '' : `: ${line}`}`;
}

function succeeded(r: ProcessResult): boolean {
  return !r.timedOut && r.code === 0;
}

// ---- GitHub (gh api) ----

function parseIssue(v: unknown): (GitHubIssue & { id: number }) | null {
  const number = readNumber(v, 'number');
  const id = readNumber(v, 'id');
  const url = readString(v, 'html_url');
  if (number === null || id === null || url === null || !Number.isInteger(number) || !Number.isInteger(id)) return null;
  return { number, url, id };
}

/** created_at is GitHub's own timestamp, passed through unchanged. */
function parseComment(v: unknown): GitHubComment | null {
  const id = readNumber(v, 'id');
  const url = readString(v, 'html_url');
  const createdAt = readString(v, 'created_at');
  const body = isRecord(v) && v['body'] === null ? '' : readString(v, 'body');
  if (id === null || !Number.isInteger(id) || url === null || createdAt === null || body === null) return null;
  return { id, url, createdAt, body, authorAssociation: readString(v, 'author_association') ?? 'NONE' };
}

function validIssue(n: number): boolean {
  return Number.isInteger(n) && n > 0;
}

/**
 * `gh api` against `repo` (owner/name). findIssue scans every issue body (the search API lags behind new issues);
 * a failed sub-issue link is reported through `warn` and never fails createIssue.
 */
export function ghPort(repo: string, run: RunProcess, warn: (message: string) => void = () => undefined): GitHubPort {
  const validRepo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo);
  const api = async (method: 'GET' | 'POST', path: string, input: JsonRecord | null): Promise<Result<unknown>> => {
    if (!validRepo) return err(`gh: invalid repository "${repo}"`);
    const args = ['api', '--method', method, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', path];
    if (input !== null) args.push('--input', '-');
    const stdin = input === null ? null : JSON.stringify(input);
    const r = await run('gh', args, { envSet: GH_ENV, envUnset: [], cwd: tmpdir(), stdin, timeoutMs: GH_TIMEOUT_MS });
    const what = `gh api ${method} ${path}`;
    if (!succeeded(r)) return err(failure(what, r));
    try {
      const parsed: unknown = JSON.parse(r.stdout);
      return ok(parsed);
    } catch {
      return err(`${what}: output is not JSON`);
    }
  };
  const listAll = async (path: string): Promise<Result<unknown[]>> => {
    const out: unknown[] = [];
    for (let page = 1; page <= GH_MAX_PAGES; page += 1) {
      const r = await api('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=${String(GH_PAGE)}&page=${String(page)}`, null);
      if (!r.ok) return err(r.error);
      if (!Array.isArray(r.value)) return err(`gh api GET ${path}: expected a list`);
      const items: unknown[] = r.value;
      out.push(...items);
      if (items.length < GH_PAGE) return ok(out);
    }
    return err(`gh api GET ${path}: more than ${String(GH_PAGE * GH_MAX_PAGES)} items`);
  };
  return {
    findIssue: async (marker) => {
      const needle = `<!-- forge:${marker} -->`;
      const listed = await listAll(`repos/${repo}/issues?state=all`);
      if (!listed.ok) return err(listed.error);
      let best: GitHubIssue | null = null;
      for (const v of listed.value) {
        if (!isRecord(v) || v['pull_request'] !== undefined) continue;
        if (!(readString(v, 'body') ?? '').includes(needle)) continue;
        if (!isTrustedAuthor(readString(v, 'author_association') ?? 'NONE')) continue;
        const issue = parseIssue(v);
        if (issue === null) return err(`gh api GET repos/${repo}/issues: malformed issue`);
        if (best === null || issue.number < best.number) best = { number: issue.number, url: issue.url };
      }
      return ok(best);
    },
    createIssue: async (input) => {
      if (input.parent !== null && !validIssue(input.parent)) return err(`gh: invalid parent issue ${String(input.parent)}`);
      const created = await api('POST', `repos/${repo}/issues`, { title: input.title, body: input.body, labels: [...input.labels] });
      if (!created.ok) return err(created.error);
      const issue = parseIssue(created.value);
      if (issue === null) return err(`gh api POST repos/${repo}/issues: unexpected response`);
      if (input.parent !== null) {
        const link = await api('POST', `repos/${repo}/issues/${String(input.parent)}/sub_issues`, { sub_issue_id: issue.id });
        if (!link.ok) warn(`sub-issue link #${String(input.parent)} <- #${String(issue.number)} not made: ${link.error}`);
      }
      return ok({ number: issue.number, url: issue.url });
    },
    listComments: async (issue) => {
      if (!validIssue(issue)) return err(`gh: invalid issue ${String(issue)}`);
      const listed = await listAll(`repos/${repo}/issues/${String(issue)}/comments`);
      if (!listed.ok) return err(listed.error);
      const comments: GitHubComment[] = [];
      for (const v of listed.value) {
        const c = parseComment(v);
        if (c === null) return err(`gh api GET repos/${repo}/issues/${String(issue)}/comments: malformed comment`);
        comments.push(c);
      }
      return ok(comments);
    },
    createComment: async (issue, body) => {
      if (!validIssue(issue)) return err(`gh: invalid issue ${String(issue)}`);
      const path = `repos/${repo}/issues/${String(issue)}/comments`;
      const created = await api('POST', path, { body });
      if (!created.ok) return err(created.error);
      const c = parseComment(created.value);
      return c === null ? err(`gh api POST ${path}: unexpected response`) : ok(c);
    },
  };
}

// ---- git (git -C <repoDir>) ----

/** Refs and branch names come from the engine; one starting with '-' would be read as an option. */
function badName(name: string): boolean {
  return name === '' || name.startsWith('-') || name.includes('\0');
}

/**
 * `git -C <repoDir>` (repoDir = the repository top level). Paths are repository-relative and passed as
 * `:(top,literal)` pathspecs; an empty path list means the whole repository (commit: nothing to commit).
 */
export function gitPort(repoDir: string, run: RunProcess): GitPort {
  const git = (args: readonly string[], stdin: string | null = null, timeoutMs: number = GIT_TIMEOUT_MS): Promise<ProcessResult> =>
    run('git', ['-C', repoDir, ...args], { envSet: GIT_ENV, envUnset: [...GIT_UNSET], cwd: repoDir, stdin, timeoutMs });
  const rel = (p: string): string => {
    let r = (isAbsolute(p) ? relative(repoDir, p) : p).split(sep).join('/');
    while (r.startsWith('./')) r = r.slice(2);
    return r === '.' ? '' : r;
  };
  const spec = (p: string): string => (rel(p) === '' ? ':(top)' : `:(top,literal)${rel(p)}`);
  const specs = (paths: readonly string[]): string[] => (paths.length === 0 ? [] : ['--', ...paths.map(spec)]);
  const lines = (text: string): string[] => text.split('\0').filter((s) => s !== '');
  const refused = (what: string): Promise<Result<never>> => Promise.resolve(err(`git: refused name "${what}"`));
  const untrackedList = async (paths: readonly string[]): Promise<Result<string[]>> => {
    const r = await git(['ls-files', '-z', '--others', '--exclude-standard', '--full-name', ...specs(paths)]);
    return succeeded(r) ? ok(lines(r.stdout).sort()) : err(failure('git ls-files', r));
  };
  const commitSha = async (ref: string): Promise<Result<string>> => {
    if (badName(ref)) return refused(ref);
    const r = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return succeeded(r) ? ok(r.stdout.trim()) : err(`git: unknown ref ${ref}`);
  };
  const twoWay = async (what: string, args: readonly string[]): Promise<Result<boolean>> => {
    const r = await git(args);
    if (!r.timedOut && r.code === 0) return ok(true);
    return !r.timedOut && r.code === 1 ? ok(false) : err(failure(`git ${what}`, r));
  };
  return {
    currentBranch: async () => {
      const r = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
      if (succeeded(r)) return ok(r.stdout.trim());
      return !r.timedOut && r.code === 1 ? err('git: HEAD is detached') : err(failure('git symbolic-ref', r));
    },
    branchExists: (name) => (badName(name) ? refused(name) : twoWay('show-ref', ['show-ref', '--verify', '--quiet', `refs/heads/${name}`])),
    listBranches: async (prefix) => {
      const r = await git(['for-each-ref', '--format=%(refname)', 'refs/heads/']);
      if (!succeeded(r)) return err(failure('git for-each-ref', r));
      const names = r.stdout.split('\n').filter((l) => l.startsWith('refs/heads/')).map((l) => l.slice('refs/heads/'.length));
      return ok(names.filter((n) => n.startsWith(prefix)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    },
    createBranch: async (name, from) => {
      if (badName(name) || badName(from)) return refused(badName(name) ? name : from);
      const r = await git(['branch', '--no-track', name, from]);
      return succeeded(r) ? ok(undefined) : err(failure('git branch', r));
    },
    checkout: async (name) => {
      if (badName(name)) return refused(name);
      const r = await git(['switch', '--quiet', name]);
      return succeeded(r) ? ok(undefined) : err(failure('git switch', r));
    },
    show: async (ref, repoPath) => {
      const sha = await commitSha(ref);
      if (!sha.ok) return sha;
      const object = `${sha.value}:${rel(repoPath)}`;
      const kind = await git(['cat-file', '-t', object]);
      if (!succeeded(kind)) return ok(null);
      if (kind.stdout.trim() !== 'blob') return err(`git show ${ref}:${rel(repoPath)}: not a file`);
      const blob = await git(['cat-file', 'blob', object]);
      return succeeded(blob) ? ok(blob.stdout) : err(failure('git cat-file', blob));
    },
    isClean: async (repoPaths) => {
      const r = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', ...specs(repoPaths)]);
      return succeeded(r) ? ok(r.stdout === '') : err(failure('git status', r));
    },
    diff: async (baseRef, repoPaths) => {
      if (badName(baseRef)) return refused(baseRef);
      const fresh = await untrackedList(repoPaths);
      if (!fresh.ok) return fresh;
      const intent = fresh.value.length === 0 ? [] : ['--', ...fresh.value.map(spec)];
      if (intent.length > 0) {
        const add = await git(['add', '--intent-to-add', ...intent]);
        if (!succeeded(add)) return err(failure('git add --intent-to-add', add));
      }
      const d = await git(['diff', '--no-ext-diff', '--no-renames', '--no-color', '--no-textconv', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', '-U3', baseRef, ...specs(repoPaths)]);
      if (intent.length > 0) {
        const undo = await git(['reset', '--quiet', ...intent]);
        if (!succeeded(undo)) return err(failure('git reset (intent-to-add)', undo));
      }
      return succeeded(d) ? ok(d.stdout) : err(failure('git diff', d));
    },
    commit: async (paths, message) => {
      if (paths.length === 0) return ok(null);
      const add = await git(['add', '-A', ...specs(paths)]);
      if (!succeeded(add)) return err(failure('git add', add));
      const staged = await git(['diff', '--cached', '--quiet', '--no-ext-diff', ...specs(paths)]);
      if (!staged.timedOut && staged.code === 0) return ok(null);
      if (staged.timedOut || staged.code !== 1) return err(failure('git diff --cached', staged));
      const c = await git(['commit', '--quiet', '--cleanup=whitespace', '--file=-', '--only', ...specs(paths)], message);
      if (!succeeded(c)) return err(failure('git commit', c));
      const head = await git(['rev-parse', 'HEAD']);
      return succeeded(head) ? ok(head.stdout.trim()) : err(failure('git rev-parse', head));
    },
    push: async (branch) => {
      if (badName(branch)) return refused(branch);
      const r = await git(['push', '--porcelain', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], null, GIT_PUSH_TIMEOUT_MS);
      return succeeded(r) ? ok(undefined) : err(failure('git push', r));
    },
    changedPaths: async (baseRef, repoPaths) => {
      if (badName(baseRef)) return refused(baseRef);
      const d = await git(['diff', '--name-only', '-z', '--no-renames', '--no-relative', baseRef, ...specs(repoPaths)]);
      if (!succeeded(d)) return err(failure('git diff --name-only', d));
      const fresh = await untrackedList(repoPaths);
      if (!fresh.ok) return fresh;
      return ok([...new Set([...lines(d.stdout), ...fresh.value])].sort());
    },
    untracked: (repoPaths) => untrackedList(repoPaths),
    resolveRef: (ref) => commitSha(ref),
    isAncestor: (ref, of) => (badName(ref) || badName(of) ? refused(badName(ref) ? ref : of) : twoWay('merge-base', ['merge-base', '--is-ancestor', ref, of])),
  };
}

// ---- assembler, clock, entropy, doctor ----

/** `python3 world/current/reference/assemble_reference.py --revision=<rev>` in repoDir; its last stdout line is JSON. */
export function pythonAssembler(repoDir: string, run: RunProcess): Assembler {
  return {
    assemble: async (revision) => {
      const r = await run('python3', ['world/current/reference/assemble_reference.py', `--revision=${revision}`], {
        envSet: { PYTHONDONTWRITEBYTECODE: '1' },
        envUnset: [],
        cwd: repoDir,
        stdin: null,
        timeoutMs: ASSEMBLER_TIMEOUT_MS,
      });
      if (!succeeded(r)) return err(failure('assemble_reference.py', r));
      const last = r.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '').pop() ?? '';
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(last);
      } catch {
        return err('assemble_reference.py: last output line is not JSON');
      }
      const sha = readString(parsed, 'reference_book_sha256');
      const characters = readNumber(parsed, 'characters');
      if (sha === null || !/^[0-9a-f]{64}$/u.test(sha) || characters === null || !Number.isInteger(characters) || characters < 0) {
        return err('assemble_reference.py: expected {reference_book_sha256, characters}');
      }
      return ok({ referenceBookSha256: sha, characters });
    },
  };
}

export function systemClock(): Clock {
  return {
    now: () => new Date().toISOString(),
    sleep: async (ms) => {
      await setTimeout(ms);
    },
  };
}

export function systemEntropy(): Entropy {
  return { bytes: (n) => randomBytes(n) };
}

/**
 * Runs `node engine/cli.ts doctor` under `root`; ok iff it exits 0 (value = its report). A failure names the red
 * lines of the report (callers redact before anything reaches a file).
 */
export function cliDoctor(root: string, run: RunProcess = runProcess): Doctor {
  return {
    run: async () => {
      const r = await run(process.execPath, ['engine/cli.ts', 'doctor'], { envSet: {}, envUnset: [], cwd: root, stdin: null, timeoutMs: DOCTOR_TIMEOUT_MS });
      if (succeeded(r)) return ok(r.stdout);
      const red = r.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('✖'))
        .slice(0, 8);
      return err(`${failure('forge doctor', r)}${red.length === 0 ? '' : ` | ${red.join(' | ')}`}`);
    },
  };
}
