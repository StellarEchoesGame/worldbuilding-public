import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import type { LocalConfig } from './config.ts';
import type { GitHubPort, GitPort } from './ports.ts';
import { err } from './result.ts';
import type { Result } from './result.ts';

/** Deny rules for anything that becomes public (GitHub bodies, committed bytes, error strings in files). */
export interface PublicDeny {
  /** new URL(local.gatewayBaseUrl).hostname; null without local.json (tests, CI). */
  gatewayHost: string | null;
  /** local.json private_phrases. */
  privatePhrases: readonly string[];
  /** PUBLIC_CHECK_DENYLIST entries (comma-separated, matched case-insensitively as literals). */
  extra: readonly string[];
}

/** Copy of wiki/scripts/check-public.mjs `forbidden` (that script cannot be imported); a test pins the copy. */
export const WIKI_DENY: readonly RegExp[] = [
  /\/Users\//i,
  /127\.0\.0\.1/,
  /\.secret\//i,
  /feishu\.cn/i,
  /CLOUDFLARE_GLOBAL_API_KEY/,
  /X-Auth-Key/i,
  /sk-[A-Za-z0-9]{24,}/,
];

const SCAN_PREFIX = 'public-content scan: ';

function nonEmpty(values: readonly string[]): string[] {
  return values.map((v) => v.trim()).filter((v) => v !== '');
}

/** The gateway hostname; an unparsable base URL is denied as a whole (lower-cased) rather than not at all. */
function gatewayHostOf(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();
  if (trimmed === '') return null;
  try {
    const host = new URL(trimmed).hostname;
    if (host !== '') return host.toLowerCase();
  } catch {
    // not a URL: fall through and deny the configured text literally
  }
  return trimmed.toLowerCase();
}

export function publicDeny(local: LocalConfig | null, env: Record<string, string | undefined>): PublicDeny {
  return {
    gatewayHost: local === null ? null : gatewayHostOf(local.gatewayBaseUrl),
    privatePhrases: local === null ? [] : nonEmpty(local.privatePhrases),
    extra: nonEmpty((env['PUBLIC_CHECK_DENYLIST'] ?? '').split(',')),
  };
}

interface Rule {
  /** Hit description, e.g. `gateway host`, `wiki rule 3`. */
  name: string;
  /** Redaction tag: `[redacted:<tag>]`. */
  tag: string;
  /** Global pattern (String.search / replace ignore and reset lastIndex). */
  pattern: RegExp;
  /** What redactPublic replaces: `pattern`, or for path rules the whole path token it starts. */
  redact: RegExp;
}

/**
 * Path rules (WIKI_DENY indexes 0 = `/Users/`, 2 = `.secret/`) redact the whole path token (quotes, whitespace and
 * brackets end it): replacing only the prefix would leave the user name and the path in a string that no longer
 * hits any rule.
 */
const PATH_REDACT: Readonly<Record<number, RegExp>> = {
  0: /\/Users\/[^\s'"`<>()[\]{},;]*/giu,
  2: /\.secret\/[^\s'"`<>()[\]{},;]*/giu,
};

function literal(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu');
}

function rulesOf(deny: PublicDeny): Rule[] {
  const rules: Rule[] = [];
  const plain = (name: string, tag: string, pattern: RegExp): Rule => ({ name, tag, pattern, redact: pattern });
  if (deny.gatewayHost !== null && deny.gatewayHost.trim() !== '') {
    rules.push(plain('gateway host', 'gateway-host', literal(deny.gatewayHost.trim())));
  }
  nonEmpty(deny.privatePhrases).forEach((p, i) => {
    rules.push(plain(`private phrase ${String(i + 1)}`, `private-phrase-${String(i + 1)}`, literal(p)));
  });
  nonEmpty(deny.extra).forEach((p, i) => {
    rules.push(plain(`denylist entry ${String(i + 1)}`, `denylist-${String(i + 1)}`, literal(p)));
  });
  WIKI_DENY.forEach((re, i) => {
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
    const pattern = new RegExp(re.source, flags);
    rules.push({ name: `wiki rule ${String(i + 1)}`, tag: `wiki-rule-${String(i + 1)}`, pattern, redact: PATH_REDACT[i] ?? pattern });
  });
  return rules;
}

/** Hit descriptions name the rule (e.g. `gateway host`, `wiki rule 3`) and never echo the matched text. */
export function scanPublic(text: string, deny: PublicDeny): string[] {
  return rulesOf(deny)
    .filter((r) => text.search(r.pattern) !== -1)
    .map((r) => r.name);
}

/** Replaces every hit (gateway host → `[redacted:gateway-host]`, others `[redacted:<rule>]`; path rules take the whole path). */
export function redactPublic(text: string, deny: PublicDeny): string {
  const rules = rulesOf(deny);
  let out = text;
  for (let pass = 0; pass < 4; pass += 1) {
    if (rules.every((r) => out.search(r.pattern) === -1)) return out;
    for (const r of rules) out = out.replace(r.redact, () => `[redacted:${r.tag}]`);
  }
  // A replacement kept producing new hits (a deny phrase inside the tag text): drop the text altogether.
  return rules.every((r) => out.search(r.pattern) === -1) ? out : '[redacted]';
}

function redactError<T>(r: Result<T>, deny: PublicDeny): Result<T> {
  return r.ok ? r : err(redactPublic(r.error, deny));
}

/** createIssue / createComment bodies hitting a rule → err('public-content scan: <rule>') without a GitHub call. */
export function scannedGitHub(port: GitHubPort, deny: PublicDeny): GitHubPort {
  const blocked = (texts: readonly string[]): string | null => {
    const hits = scanPublic(texts.join('\n'), deny);
    return hits.length === 0 ? null : `${SCAN_PREFIX}${hits.join(', ')}`;
  };
  return {
    findIssue: async (marker) => redactError(await port.findIssue(marker), deny),
    createIssue: async (input) => {
      const hit = blocked([input.title, input.body, ...input.labels]);
      return hit !== null ? err(hit) : redactError(await port.createIssue(input), deny);
    },
    listComments: async (issue) => redactError(await port.listComments(issue), deny),
    createComment: async (issue, body) => {
      const hit = blocked([body]);
      return hit !== null ? err(hit) : redactError(await port.createComment(issue, body), deny);
    },
  };
}

function repoRel(repoDir: string, p: string): string {
  return (isAbsolute(p) ? relative(repoDir, p) : p).split(sep).join('/');
}

/** The text git would store for a committed path: file bytes, or a symlink's target; null = absent / directory. */
function committedText(abs: string): string | null {
  const kind = lstatSync(abs, { throwIfNoEntry: false });
  if (kind === undefined) return null;
  if (kind.isSymbolicLink()) return readlinkSync(abs, 'utf8');
  return kind.isFile() ? readFileSync(abs).toString('utf8') : null;
}

/**
 * The scan of one commit: the message, every given regular file, and — for directories and deleted paths — every
 * file git would take from them (`changedPaths('HEAD', …)`, so ignored files are not scanned). Null = clean.
 */
async function scanCommit(port: GitPort, repoDir: string, deny: PublicDeny, paths: readonly string[], message: string): Promise<string | null> {
  const messageHits = scanPublic(message, deny);
  if (messageHits.length > 0) return `${SCAN_PREFIX}${messageHits.join(', ')} in commit message`;
  const files = new Set<string>();
  const trees: string[] = [];
  for (const p of paths) {
    const rel = repoRel(repoDir, p);
    if (lstatSync(join(repoDir, rel), { throwIfNoEntry: false })?.isDirectory() === false) files.add(rel);
    else trees.push(rel);
  }
  if (trees.length > 0) {
    const changed = await port.changedPaths('HEAD', trees);
    if (!changed.ok) return `${SCAN_PREFIX}cannot list the committed files: ${redactPublic(changed.error, deny)}`;
    for (const f of changed.value) files.add(f);
  }
  const hits: string[] = [];
  for (const rel of [...files].sort()) {
    const text = committedText(join(repoDir, rel));
    const rules = text === null ? [] : scanPublic(text, deny);
    const shown = rel.startsWith('..') ? basename(rel) : rel;
    if (rules.length > 0) hits.push(`${rules.join(', ')} in ${redactPublic(shown, deny)}`);
  }
  if (hits.length === 0) return null;
  const more = hits.length > 5 ? `; +${String(hits.length - 5)} more` : '';
  return `${SCAN_PREFIX}${hits.slice(0, 5).join('; ')}${more}`;
}

/** commit(paths) reads the bytes of every path under repoDir; a hit → err('public-content scan: <rule>') before any git call. */
export function scannedGit(port: GitPort, repoDir: string, deny: PublicDeny): GitPort {
  const pass = async <T>(p: Promise<Result<T>>): Promise<Result<T>> => redactError(await p, deny);
  return {
    currentBranch: () => pass(port.currentBranch()),
    branchExists: (name) => pass(port.branchExists(name)),
    listBranches: (prefix) => pass(port.listBranches(prefix)),
    createBranch: (name, from) => pass(port.createBranch(name, from)),
    checkout: (name) => pass(port.checkout(name)),
    show: (ref, repoPath) => pass(port.show(ref, repoPath)),
    isClean: (repoPaths) => pass(port.isClean(repoPaths)),
    diff: (baseRef, repoPaths) => pass(port.diff(baseRef, repoPaths)),
    commit: async (paths, message) => {
      const blocked = await scanCommit(port, repoDir, deny, paths, message);
      return blocked !== null ? err(blocked) : pass(port.commit(paths, message));
    },
    push: (branch) => pass(port.push(branch)),
    changedPaths: (baseRef, repoPaths) => pass(port.changedPaths(baseRef, repoPaths)),
    untracked: (repoPaths) => pass(port.untracked(repoPaths)),
    resolveRef: (ref) => pass(port.resolveRef(ref)),
    isAncestor: (ref, of) => pass(port.isAncestor(ref, of)),
  };
}
