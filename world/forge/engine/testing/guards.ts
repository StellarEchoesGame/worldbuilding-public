import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { RunHooks } from '../context.ts';
import { sha256Bytes } from '../marker.ts';
import { charCount, sentenceKey, splitSentences } from '../text.ts';
import type { FakeGit } from './fakes.ts';
import { head } from './round-script.ts';
import type { FakeRouter } from './scripted.ts';

/*
 * Test-only guards of the end-to-end fixture round (plan "End-to-end fixture round", s6 §5): an in-process kill switch,
 * settling of in-flight fake calls, and the invariants checked after every forge() call (owner files, no gateway host,
 * no sealed forecast leak, marker bytes). Imported only by `*.test.ts` files.
 */

/** Thrown by killSwitch hooks: the in-process stand-in for SIGKILL (the runner treats it as a crash). */
export class SimulatedKill extends Error {}

export interface KillSpec {
  phase: 'before';
  /** Task ids counted (distinct) at beforeCall. */
  match: RegExp;
  /** 1-based: the nth distinct matching task id throws, and every later beforeCall / afterCall throws too. */
  nth: number;
}

export interface KillSwitch {
  hooks: RunHooks;
  /** `taskId#attempt` of every call that completed (afterCall), including in-flight calls that completed after the kill. */
  paidLog(): readonly string[];
  /** Task id that triggered the kill, else null. */
  killedAt(): string | null;
}

/**
 * RunHooks that throw SimulatedKill at the nth distinct task id matching `match` (beforeCall, so that call never
 * reaches its backend) and at every later beforeCall and afterCall: calls already in flight end with their call record
 * and `.out.txt` but without a task record. The afterCall logger runs first, so `paidLog` holds every paid call.
 */
export function killSwitch(spec: KillSpec): KillSwitch {
  const seen = new Set<string>();
  const paid: string[] = [];
  let killed: string | null = null;
  const hooks: RunHooks = {
    beforeCall: (taskId) => {
      if (killed !== null) throw new SimulatedKill(`killed at ${killed} (later call ${taskId})`);
      if (!spec.match.test(taskId)) return;
      seen.add(taskId);
      if (seen.size < spec.nth) return;
      killed = taskId;
      throw new SimulatedKill(`killed at ${taskId}`);
    },
    afterCall: (taskId, attempt) => {
      paid.push(`${taskId}#${attempt}`);
      if (killed !== null) throw new SimulatedKill(`killed at ${killed} (after ${taskId})`);
    },
  };
  return { hooks, paidLog: () => [...paid], killedAt: () => killed };
}

/** afterCall logger only (the resumed run of a kill scenario). */
export function paidLogger(): KillSwitch {
  const paid: string[] = [];
  return { hooks: { afterCall: (taskId, attempt) => void paid.push(`${taskId}#${attempt}`) }, paidLog: () => [...paid], killedAt: () => null };
}

/** Awaits every started fake call of every router, then one setImmediate tick. */
export async function settle(routers: readonly FakeRouter[]): Promise<void> {
  await Promise.all(routers.map((r) => r.settled()));
  await new Promise<void>((done) => setImmediate(done));
}

function escapeRe(ch: string): string {
  return /[.*+?^${}()|[\]\\]/u.test(ch) ? `\\${ch}` : ch;
}

/** Glob body → regex source: `**` any, `*` / `?` within one segment. */
function globRe(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob.charAt(i);
    if (ch === '*' && glob.charAt(i + 1) === '*') {
      out += '.*';
      i += 1;
    } else if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += escapeRe(ch);
  }
  return out;
}

interface Rule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

/** Pure matcher of a `.gitignore` text (blank / # lines, `!`, `dir/`, `*`, `**`, leading `/`); true = ignored. */
export function gitignoreMatcher(text: string): (rel: string) => boolean {
  const rules: Rule[] = [];
  for (const raw of text.split('\n')) {
    let line = raw.replace(/\r$/u, '').trimEnd();
    if (line === '' || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes('/');
    const body = globRe(line.startsWith('/') ? line.slice(1) : line);
    rules.push({ re: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`, 'u'), negate, dirOnly });
  }
  const hit = (path: string, isDir: boolean): boolean => {
    let ignored = false;
    for (const r of rules) if ((!r.dirOnly || isDir) && r.re.test(path)) ignored = !r.negate;
    return ignored;
  };
  return (rel) => {
    const parts = rel.split('/');
    for (let k = 1; k < parts.length; k += 1) if (hit(parts.slice(0, k).join('/'), true)) return true;
    return hit(rel, false);
  };
}

function toSlash(path: string): string {
  return path.split(sep).join('/');
}

/** Repo-relative files under `repo` that git would track (the forge .gitignore applied under the forge root). */
export function trackedFiles(repo: string, root: string): string[] {
  const gitignore = join(root, '.gitignore');
  const ignored = gitignoreMatcher(existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '');
  const forge = toSlash(relative(repo, root));
  const skip = (rel: string, isDir: boolean): boolean => {
    if (rel !== forge && !rel.startsWith(`${forge}/`)) return false;
    const inner = rel.slice(forge.length + 1);
    return inner !== '' && ignored(isDir ? `${inner}/x` : inner);
  };
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const e of readdirSync(join(repo, dir), { withFileTypes: true })) {
      const rel = dir === '' ? e.name : `${dir}/${e.name}`;
      if (e.name === '.git') continue;
      if (e.isDirectory()) {
        if (!skip(rel, true)) visit(rel);
      } else if (!skip(rel, false)) out.push(rel);
    }
  };
  visit('');
  return out.sort();
}

/** Owner-only files under the forge root (context.ts OWNER_ONLY: owner-log, round audits / decisions, calibration answers). */
function ownerFiles(root: string): string[] {
  const out: string[] = [];
  if (existsSync(join(root, 'owner-log.jsonl'))) out.push('owner-log.jsonl');
  if (existsSync(join(root, 'calibration', 'owner-answers.json'))) out.push('calibration/owner-answers.json');
  const rounds = join(root, 'rounds');
  if (existsSync(rounds)) {
    for (const r of readdirSync(rounds, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
      for (const f of readdirSync(join(rounds, r)).sort()) if (f === 'audit.json' || /^decision.*\.json$/u.test(f)) out.push(`rounds/${r}/${f}`);
    }
  }
  return out;
}

/** Every OWNER_ONLY path under `root` is absent and never expected, or hashes to `expected` (owner-sim expected()). */
export function assertOwnerFiles(root: string, expected: ReadonlyMap<string, string>): void {
  const found = ownerFiles(root);
  for (const rel of found) {
    const want = expected.get(rel);
    if (want === undefined) throw new Error(`owner file ${rel} exists but owner-sim never wrote it`);
    const got = sha256Bytes(readFileSync(join(root, rel)));
    if (got !== want) throw new Error(`owner file ${rel} changed after owner-sim wrote it`);
  }
  for (const rel of expected.keys()) if (!found.includes(rel)) throw new Error(`owner file ${rel} written by owner-sim is missing`);
}

/** Branches the fake knows: main, every pushed branch and every created branch. */
function branchesOf(git: FakeGit): string[] {
  const created = git.calls().filter((c) => c.op === 'createBranch').map((c) => c.args[0] ?? '');
  return [...new Set(['main', ...git.pushes(), ...created])].filter((b) => b !== '');
}

/** `host` occurs in no tracked file and in no fake commit tree. */
export function assertNoHost(repo: string, root: string, git: FakeGit, host: string): void {
  for (const rel of trackedFiles(repo, root)) {
    if (readFileSync(join(repo, rel)).includes(host)) throw new Error(`gateway host in tracked file ${rel}`);
  }
  for (const branch of branchesOf(git)) {
    for (const [rel, text] of Object.entries(git.tree(branch))) if (text.includes(host)) throw new Error(`gateway host in ${branch}:${rel}`);
  }
}

/** Where sealed forecast values may appear once the round is unsealed: the published seal and the forecast pool. */
const UNSEALED_HOMES = /^world\/forge\/(?:rounds\/R\d{2}\/unsealed\/sealed\.json|regression\/forecast-pool\.jsonl)$/u;

/** No `token` match in tracked files or `writerPrompts`; once `unsealed`, only in a round's `unsealed/sealed.json` (and the pool). */
export function assertNoForecastLeak(repo: string, root: string, writerPrompts: readonly string[], token: RegExp, unsealed: boolean): void {
  for (const [i, prompt] of writerPrompts.entries()) if (token.test(prompt)) throw new Error(`sealed forecast value in writer prompt ${i + 1}`);
  for (const rel of trackedFiles(repo, root)) {
    if (!token.test(readFileSync(join(repo, rel), 'utf8'))) continue;
    if (unsealed && UNSEALED_HOMES.test(rel)) continue;
    throw new Error(`sealed forecast value in tracked file ${rel}${unsealed ? '' : ' before 11a'}`);
  }
}

/** One reserve text as the label ledger names it: text id, label id and the file's full text. */
export interface ReserveText {
  id: string;
  label: string;
  text: string;
}

/** Shortest sentence (charCount) that counts as a quote of its reserve text. */
export const LEAK_SENTENCE_MIN = 8;

/** `needle` and its JSON-string body (the evidence packet sits in a prompt as JSON.stringify output). */
function needleForms(needle: string): string[] {
  const escaped = JSON.stringify(needle).slice(1, -1);
  return escaped === needle ? [needle] : [needle, escaped];
}

/** `id` occurs in `text` without an ASCII letter or digit on either side (C00-T07 is not C00-T070; E-R01-DIS-C00-P05 holds C00-P05). */
function hasId(text: string, id: string): boolean {
  for (let at = text.indexOf(id); at !== -1; at = text.indexOf(id, at + 1)) {
    if (!/[A-Za-z0-9]/u.test(text.charAt(at - 1)) && !/[A-Za-z0-9]/u.test(text.charAt(at + id.length))) return true;
  }
  return false;
}

/**
 * Reserve material in a prompt (E7: the maintainer never sees a reserve label): each label id, and per text its id,
 * its 12-character head (what the fake judges quote, round-script `head`) and every sentence of ≥ LEAK_SENTENCE_MIN
 * characters (splitSentences), raw or JSON-escaped, compared as is and under NFKC. `shown` = texts the prompt may
 * legitimately carry (visible label texts): a reserve text equal to one of them only checks its label id, and a
 * head or sentence that a shown text also holds is not attributable. One line per leak in input order; [] = clean.
 */
export function reserveLeaks(prompt: string, reserve: readonly ReserveText[], shown: readonly string[]): string[] {
  const promptKey = sentenceKey(prompt);
  const shownBodies = new Set(shown.map((s) => s.trim()));
  const shownKeys = shown.map(sentenceKey);
  const inPrompt = (needle: string): boolean => needleForms(needle).some((f) => prompt.includes(f) || promptKey.includes(sentenceKey(f)));
  const inShown = (needle: string): boolean => shownKeys.some((s) => s.includes(sentenceKey(needle)));
  const out = new Set<string>();
  for (const r of reserve) {
    if (hasId(prompt, r.label)) out.add(`${r.label}: label id`);
    const body = r.text.trim();
    if (shownBodies.has(body)) continue;
    if (hasId(prompt, r.id)) out.add(`${r.id}: text id`);
    const first = head(body);
    const needles: Array<[string, string]> = [['head', first]];
    for (const s of splitSentences(body)) if (s !== first && charCount(s) >= LEAK_SENTENCE_MIN) needles.push(['sentence', s]);
    for (const [kind, needle] of needles) if (inPrompt(needle) && !inShown(needle)) out.add(`${r.id}: ${kind} 「${needle}」`);
  }
  return [...out];
}

/** Step id → bytes (UTF-8) of `rounds/<round>/markers/<step>.json` (stale markers excluded). */
export function markerBytes(root: string, round: string): Map<string, string> {
  const dir = join(root, 'rounds', round, 'markers');
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.json')) out.set(e.name.slice(0, -'.json'.length), readFileSync(join(dir, e.name), 'utf8'));
  }
  return out;
}

/** No non-test module under `engineDir` imports `testing/` (test files and testing/ itself excluded). */
export function assertNoTestingImports(engineDir: string): void {
  const offenders: string[] = [];
  const visit = (dir: string): void => {
    for (const e of readdirSync(join(engineDir, dir), { withFileTypes: true })) {
      const rel = dir === '' ? e.name : `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (rel !== 'testing' && e.name !== 'node_modules') visit(rel);
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
        const text = readFileSync(join(engineDir, rel), 'utf8');
        if (/(?:from|import)\s*\(?\s*['"][^'"]*\btesting\//u.test(text)) offenders.push(rel);
      }
    }
  };
  visit('');
  if (offenders.length > 0) throw new Error(`non-test modules import engine/testing/: ${offenders.join(', ')}`);
}
