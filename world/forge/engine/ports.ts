import type { Result } from './result.ts';

/**
 * External systems the round engine touches. Production implementations live in ports-cli.ts,
 * deterministic in-memory fakes in testing/fakes.ts. Every member returns a Result; none throws.
 */

export interface GitHubIssue {
  number: number;
  url: string;
}

export interface GitHubComment {
  id: number;
  url: string;
  /** GitHub's created_at, passed through unchanged (ISO 8601 UTC). */
  createdAt: string;
  body: string;
  /** GitHub's author_association (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, …); NONE when GitHub omits it. */
  authorAssociation: string;
}

/**
 * Author associations whose marked issues and probe comments the engine accepts. The repository is public:
 * anyone can open an issue or post a comment carrying a `<!-- forge:… -->` marker, so the others are ignored.
 */
export const TRUSTED_ASSOCIATIONS: readonly string[] = ['OWNER', 'MEMBER', 'COLLABORATOR'];

export function isTrustedAuthor(association: string): boolean {
  return TRUSTED_ASSOCIATIONS.includes(association);
}

export interface GitHubPort {
  /** The lowest-numbered issue by a trusted author (isTrustedAuthor) whose body contains `<!-- forge:<marker> -->`, or null. */
  findIssue(marker: string): Promise<Result<GitHubIssue | null>>;
  createIssue(input: { title: string; body: string; labels: string[]; parent: number | null }): Promise<Result<GitHubIssue>>;
  listComments(issue: number): Promise<Result<GitHubComment[]>>;
  createComment(issue: number, body: string): Promise<Result<GitHubComment>>;
}

export interface GitPort {
  currentBranch(): Promise<Result<string>>;
  branchExists(name: string): Promise<Result<boolean>>;
  /** Local branch names starting with `prefix` (e.g. `forge/calib-`), sorted by code unit. */
  listBranches(prefix: string): Promise<Result<string[]>>;
  createBranch(name: string, from: string): Promise<Result<void>>;
  checkout(name: string): Promise<Result<void>>;
  /** File content at `ref`; null when the path is absent at that ref. Paths are repository-relative. */
  show(ref: string, repoPath: string): Promise<Result<string | null>>;
  isClean(repoPaths: readonly string[]): Promise<Result<boolean>>;
  /** `git diff --no-ext-diff --no-renames -U3 <baseRef> -- paths`, untracked files included via intent-to-add. */
  diff(baseRef: string, repoPaths: readonly string[]): Promise<Result<string>>;
  /** Commit sha; null when nothing changed. */
  commit(paths: readonly string[], message: string): Promise<Result<string | null>>;
  push(branch: string): Promise<Result<void>>;
  /** Name-only diff against `baseRef`, untracked files included. */
  changedPaths(baseRef: string, repoPaths: readonly string[]): Promise<Result<string[]>>;
  untracked(repoPaths: readonly string[]): Promise<Result<string[]>>;
  resolveRef(ref: string): Promise<Result<string>>;
  isAncestor(ref: string, of: string): Promise<Result<boolean>>;
}

export interface Clock {
  /** ISO 8601 UTC with milliseconds. */
  now(): string;
  sleep(ms: number): Promise<void>;
}

/** Source of the round seed and the seal nonce. */
export interface Entropy {
  bytes(n: number): Buffer;
}

/** `forge doctor`: ok = every backend green; value = the report text. */
export interface Doctor {
  run(): Promise<Result<string>>;
}

/** assemble_reference.py (writes only REFERENCE.md and hashes.json). */
export interface Assembler {
  assemble(revision: string): Promise<Result<{ referenceBookSha256: string; characters: number }>>;
}

export interface Ports {
  github: GitHubPort;
  git: GitPort;
  clock: Clock;
  entropy: Entropy;
  doctor: Doctor;
  assembler: Assembler;
}
