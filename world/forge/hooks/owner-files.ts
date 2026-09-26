/**
 * Claude Code PreToolUse hook (repo .claude/settings.json): denies agent writes to owner-only files. Reads the hook
 * input JSON from stdin: `tool_name`, `tool_input.file_path` (Edit, Write, MultiEdit), `tool_input.notebook_path`
 * (NotebookEdit), `tool_input.command` (Bash) and `cwd`. Deny → prints
 * `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":…}}`,
 * exit 0; allow → prints nothing, exit 0. Self-contained (no engine imports): it runs on every tool call.
 * Ambiguous Bash is over-denied rather than under-denied; unparseable input is allowed (the hook never blocks work
 * it cannot read), but an error while analysing a parsed call denies it (fail closed).
 */
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export interface HookDecision {
  decision: 'deny' | 'allow';
  reason: string;
}

/** Forge-root-relative owner-only globs; must equal engine/context.ts OWNER_ONLY (a test asserts it). */
export const OWNER_GLOBS: readonly string[] = ['owner-log.jsonl', 'rounds/*/audit.json', 'rounds/*/decision*.json', 'calibration/owner-answers.json'];

const OWNER_SEGMENTS: readonly (readonly string[])[] = OWNER_GLOBS.map((g) => g.split('/'));

/** Samples a glob in a command is tried against for the `decision*.json` owner segment. */
const DECISION_SAMPLES: readonly string[] = ['decision.json', 'decision-2.json', 'decision-10.json'];

/** File names in interpreter code (`python -c`, `node -e`, …) that point at an owner-only file. */
const OWNER_NAME_IN_CODE = /owner-log\.jsonl|owner-answers\.json|(?<![\w-])audit\.json|(?<![\w-])decision[\w.-]*\.json/iu;

/** Write calls in interpreter code. */
const WRITE_CALL_IN_CODE =
  /\bopen\s*\([^)]*,\s*(?:mode\s*=\s*)?['"][^'"]*[wax+]|writeFile|appendFile|createWriteStream|write_text|write_bytes|rmSync|unlinkSync|renameSync|truncateSync|copyFileSync|cpSync|\bos\.(?:remove|unlink|rename|replace|truncate)\b|\bshutil\.|\bFile\.(?:write|delete|rename)\b|\bFileUtils\./u;

const DENY_REASON =
  'owner-only file: owner-log.jsonl, rounds/*/audit.json, rounds/*/decision*.json and calibration/owner-answers.json are written only by the forge UI (npm run ui) on the owner\'s click. Agents may read them but never write, move or delete them.';

function hasGlob(segment: string): boolean {
  return /[*?[]/u.test(segment);
}

function globRegex(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] ?? '';
    if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end < 0) out += '\\[';
      else {
        const body = glob.slice(i + 1, end).replace(/^!/u, '^').replace(/\\/gu, '\\\\');
        out += `[${body}]`;
        i = end;
      }
    } else out += c.replace(/[.+^${}()|\\\]]/gu, '\\$&');
  }
  return new RegExp(`^${out}$`, 'u');
}

/** Does the glob `pattern` match `sample`? A pattern the shell accepts but a RegExp cannot express (`[z-a]`) counts as a match. */
function globTest(pattern: string, sample: string): boolean {
  let re: RegExp;
  try {
    re = globRegex(pattern);
  } catch {
    return true;
  }
  return re.test(sample);
}

/** Can the path segment `s` (literal, glob or `$VAR` in a directory position) name what the owner segment `g` names? */
function segmentMatches(s: string, g: string, last: boolean): boolean {
  if (!last && s.includes('$')) return true;
  if (!hasGlob(s)) return globTest(g, s);
  if (g === '*') return true;
  return hasGlob(g) ? DECISION_SAMPLES.some((x) => globTest(s, x)) : globTest(s, g);
}

/** Suffix match of one owner glob against normalised path segments (`**` spans any number of segments). */
function suffixMatches(segs: readonly string[], owner: readonly string[]): boolean {
  const star = segs.lastIndexOf('**');
  const tail = star >= 0 ? segs.slice(star + 1) : segs;
  if (star >= 0 && tail.length === 0) return true;
  if (tail.length < owner.length) {
    if (star < 0) return false;
    return tail.every((s, i) => segmentMatches(s, owner[owner.length - tail.length + i] ?? '', i === tail.length - 1));
  }
  const from = tail.length - owner.length;
  return owner.every((g, i) => segmentMatches(tail[from + i] ?? '', g, i === owner.length - 1));
}

/** Words a brace expansion may produce before the hook gives up (and denies, see `decide`). */
const BRACE_BUDGET = 1024;

/** Simple, non-nested `{a,b}` brace expansion (the shell expands before the command sees its arguments). */
function expandBraces(word: string, budget: { left: number } = { left: BRACE_BUDGET }): string[] {
  const m = /^(.*?)\{([^{}]*,[^{}]*)\}(.*)$/su.exec(word);
  if (m === null) return [word];
  const [, pre = '', body = '', post = ''] = m;
  const alts = body.split(',');
  budget.left -= alts.length;
  if (budget.left < 0) throw new Error('brace expansion too large to analyse');
  return alts.flatMap((alt) => expandBraces(`${pre}${alt}${post}`, budget));
}

function expandHome(word: string): string {
  const home = homedir();
  return word.replace(/^~(?=\/|$)/u, home).replace(/^\$\{?HOME\}?(?=\/|$)/u, home);
}

function segmentsOf(abs: string): string[] {
  return abs.normalize('NFC').toLowerCase().split('/').filter((s) => s !== '');
}

/** Does anything exist at `p`? A dangling symlink counts. */
function present(p: string): boolean {
  try {
    return lstatSync(p, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false;
  }
}

/** `abs` with its symlinks resolved (dangling ones and directory links on the way included); a missing tail is kept as written. */
function realTarget(abs: string, depth = 0): string {
  let cur = abs;
  const rest: string[] = [];
  while (!present(cur)) {
    const up = dirname(cur);
    if (up === cur) return abs;
    rest.unshift(basename(cur));
    cur = up;
  }
  try {
    return join(realpathSync(cur), ...rest);
  } catch {
    // `cur` is a dangling link (or a loop): follow its text by hand
  }
  if (depth > 8) return abs;
  try {
    return realTarget(join(resolve(dirname(cur), readlinkSync(cur)), ...rest), depth + 1);
  } catch {
    return abs;
  }
}

/**
 * True when `path` (absolute, or relative to `cwd`; ./, ../, case and NFC normalised) ends in an owner-only path, as
 * written or after resolving symlinks (a link to an owner file, or a path through a link to rounds/, is one).
 */
export function isOwnerPath(path: string, cwd: string): boolean {
  if (path === '') return false;
  return expandBraces(expandHome(path)).some((p) => {
    const abs = resolve(cwd, p);
    return [abs, realTarget(abs)].some((x) => {
      const segs = segmentsOf(x);
      return OWNER_SEGMENTS.some((owner) => suffixMatches(segs, owner));
    });
  });
}

/** Paths below a directory that mark it as holding owner files (a forge root, or a repo or world/ holding one). */
const OWNER_TREE_MARKERS: readonly string[] = ['owner-log.jsonl', 'rounds', 'calibration/owner-answers.json', 'forge/rounds', 'world/forge/rounds', 'world/forge/owner-log.jsonl'];

/** Absolute `abs` is a directory whose removal, replacement or revert can take owner files with it: rounds/, rounds/<R>/, calibration/, a forge root or a repo holding one. */
function treeHolds(abs: string): boolean {
  const segs = segmentsOf(abs);
  const lastSeg = segs.at(-1) ?? '';
  if (lastSeg === 'rounds' || lastSeg === 'calibration' || lastSeg === '**' || segs.at(-2) === 'rounds') return true;
  // a glob that names rounds/ or calibration/ where one exists (`rm -rf r*`)
  if (hasGlob(lastSeg) && ['rounds', 'calibration'].some((n) => globTest(lastSeg, n) && existsSync(join(dirname(abs), n)))) return true;
  return OWNER_TREE_MARKERS.some((rel) => existsSync(join(abs, rel)));
}

function holdsOwnerFiles(path: string, cwd: string): boolean {
  return expandBraces(expandHome(path)).some((p) => treeHolds(resolve(cwd, p)));
}

/** The work tree around `dir` holds owner files: `dir` or an ancestor up to the first one with `.git` (stash, reset and a forced checkout act on the whole work tree). */
function workTreeHolds(dir: string): boolean {
  for (let cur = dir; ; cur = dirname(cur)) {
    if (treeHolds(cur)) return true;
    if (existsSync(join(cur, '.git')) || dirname(cur) === cur) return false;
  }
}

/** A word; the delimiter word of a here-document carries the document's `body`. */
type Token = { t: 'word'; v: string; body?: string } | { t: 'op'; v: string };

interface Heredoc {
  tok: { v: string; body?: string };
  dash: boolean;
}

const OPERATORS: readonly string[] = ['&>>', '<<<', '<<-', '&&', '||', '|&', ';;', '>>', '>|', '>&', '&>', '<<', '<>', ';', '&', '|', '\n', '(', ')', '>', '<'];

/** Index just past the `)` closing a `$(` that starts at `open` (nesting and quotes respected), else the end. */
function closeParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '\\') i += 1;
    else if (c === "'") i = Math.max(i, src.indexOf("'", i + 1));
    else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

/**
 * A small POSIX-shell lexer: words (quotes and escapes removed), operators and redirections. Command substitutions
 * (`$(…)`, backticks) are pushed to `subs`, analysed as commands of their own and marked in their word (`subMark`); a here-document body is kept on
 * its delimiter word (`body`), not in the token stream.
 */
function lex(src: string, subs: string[]): Token[] {
  const out: Token[] = [];
  let word: string | null = null;
  let expectDelim = false;
  const heredocs: Heredoc[] = [];
  let dashNext = false;
  const endWord = (): void => {
    if (word === null) return;
    const tok: { t: 'word'; v: string; body?: string } = { t: 'word', v: word };
    if (expectDelim) {
      heredocs.push({ tok, dash: dashNext });
      expectDelim = false;
    }
    out.push(tok);
    word = null;
  };
  const substitution = (from: number, to: number): void => {
    word = `${word ?? ''}${subMark(subs.length)}`;
    subs.push(src.slice(from, to));
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i] ?? '';
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (c === '\\') { word = `${word ?? ''}${src[i + 1] ?? ''}`; i += 2; continue; }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end < 0 ? src.length : end;
      word = `${word ?? ''}${src.slice(i + 1, stop)}`;
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let text = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { text += src[j + 1] ?? ''; j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '(') { const end = closeParen(src, j + 1); text += subMark(subs.length); subs.push(src.slice(j + 2, end - 1)); j = end; continue; }
        if (src[j] === '`') { const end = src.indexOf('`', j + 1); const stop = end < 0 ? src.length : end; text += subMark(subs.length); subs.push(src.slice(j + 1, stop)); j = stop + 1; continue; }
        text += src[j] ?? '';
        j += 1;
      }
      word = `${word ?? ''}${text}`;
      i = j + 1;
      continue;
    }
    if (c === '$' && src[i + 1] === '(') { const end = closeParen(src, i + 1); substitution(i + 2, end - 1); i = end; continue; }
    if (c === '`') { const end = src.indexOf('`', i + 1); const stop = end < 0 ? src.length : end; substitution(i + 1, stop); i = stop + 1; continue; }
    if (c === '#' && word === null) { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (c === ' ' || c === '\t') { endWord(); i += 1; continue; }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op === undefined) { word = `${word ?? ''}${c}`; i += 1; continue; }
    // `2>` / `1>>`: the fd number belongs to the redirection, not to the words.
    if ((op.startsWith('>') || op.startsWith('<')) && word !== null && /^\d+$/u.test(word)) word = null;
    endWord();
    out.push({ t: 'op', v: op });
    i += op.length;
    if (op === '<<' || op === '<<-') { expectDelim = true; dashNext = op === '<<-'; }
    if (op === '\n' && heredocs.length > 0) i = readHeredocs(src, i, heredocs.splice(0));
  }
  endWord();
  return out;
}

/** Reads the here-document bodies that start at `from` (the line after the `<<` line) onto their delimiter words; returns the index after them. */
function readHeredocs(src: string, from: number, docs: readonly Heredoc[]): number {
  let i = from;
  for (const doc of docs) {
    const lines: string[] = [];
    for (;;) {
      if (i >= src.length) break;
      const nl = src.indexOf('\n', i);
      const raw = src.slice(i, nl < 0 ? src.length : nl);
      i = nl < 0 ? src.length : nl + 1;
      const line = doc.dash ? raw.replace(/^\t+/u, '') : raw;
      if (line === doc.tok.v) break;
      lines.push(line);
    }
    doc.tok.body = lines.join('\n');
  }
  return i;
}

const SEPARATORS: ReadonlySet<string> = new Set([';', ';;', '&&', '||', '|', '|&', '&', '\n', '(', ')']);
const WRITE_REDIRECTS: ReadonlySet<string> = new Set(['>', '>>', '>|', '>&', '&>', '&>>', '<>']);
const READ_REDIRECTS: ReadonlySet<string> = new Set(['<', '<<', '<<-', '<<<']);
const PIPES: ReadonlySet<string> = new Set(['|', '|&']);

interface Wrapper {
  /** Options whose value is the next word (`sudo -u roy`, `nice -n 10`). */
  valued: readonly string[];
  /** Operands between the options and the wrapped command (`timeout 5s`, `chrt 10`). */
  operands: number;
}

const KEYWORD: Wrapper = { valued: [], operands: 0 };
/** Words that precede the real command (`sudo rm …`, `env X=1 tee …`, `timeout 5 tee …`, `if cp …`). */
const WRAPPERS: ReadonlyMap<string, Wrapper> = new Map(Object.entries({
  sudo: { valued: ['-u', '-g', '-C', '-D', '-p', '-R', '-r', '-t', '-T', '-U', '--user', '--group', '--close-from', '--chdir', '--prompt', '--chroot', '--role', '--type', '--command-timeout', '--other-user'], operands: 0 },
  doas: { valued: ['-u', '-C'], operands: 0 },
  env: { valued: ['-u', '-C', '--unset', '--chdir'], operands: 0 },
  command: KEYWORD, builtin: KEYWORD, nohup: KEYWORD,
  exec: { valued: ['-a'], operands: 0 },
  time: { valued: ['-f', '-o', '--format', '--output'], operands: 0 },
  nice: { valued: ['-n', '--adjustment'], operands: 0 },
  timeout: { valued: ['-s', '-k', '--signal', '--kill-after'], operands: 1 },
  stdbuf: { valued: ['-i', '-o', '-e', '--input', '--output', '--error'], operands: 0 },
  ionice: { valued: ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata'], operands: 0 },
  caffeinate: { valued: ['-t', '-w'], operands: 0 },
  chrt: { valued: [], operands: 1 },
  xargs: { valued: ['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a', '--max-args', '--max-procs', '--max-lines', '--max-chars', '--delimiter', '--eof', '--arg-file'], operands: 0 },
  parallel: { valued: ['-j', '-n', '-N', '-I', '-a', '-d', '-S', '--jobs', '--max-args', '--arg-file', '--delimiter', '--sshlogin', '--joblog', '--results'], operands: 0 },
  then: KEYWORD, do: KEYWORD, else: KEYWORD, elif: KEYWORD, if: KEYWORD, while: KEYWORD, until: KEYWORD, '!': KEYWORD, '{': KEYWORD, '}': KEYWORD,
}));
/** Every non-option argument is a write target. */
const ALL_ARGS_WRITERS: ReadonlySet<string> = new Set(['tee', 'touch', 'truncate', 'rm', 'unlink', 'shred', 'sponge', 'chmod', 'chown']);
/** The last argument (or `-t <dir>`) receives the sources. */
const COPY_WRITERS: ReadonlySet<string> = new Set(['cp', 'ln', 'install', 'rsync', 'mv', 'ditto']);
const INTERPRETER_CODE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  python: ['-c'], python3: ['-c'], node: ['-e', '--eval', '-p', '--print'], bun: ['-e', '--eval'], perl: ['-e', '-E'], ruby: ['-e'], deno: ['eval'],
};
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
/** git subcommands whose path arguments are written, reverted or deleted. */
const GIT_WRITERS: ReadonlySet<string> = new Set(['checkout', 'restore', 'rm', 'mv', 'apply']);
/** git's global options that take the next word as their value (`git -C dir`, `git -c k=v`). */
const GIT_VALUED: readonly string[] = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix'];
/** `git stash` subcommands that leave the work tree alone. */
const STASH_READS: ReadonlySet<string> = new Set(['list', 'show', 'create', 'store']);
/** Verbs whose appearance anywhere in a command re-runs the writer checks from there (unknown wrappers: `flock l tee …`). */
const WRITER_VERBS: ReadonlySet<string> = new Set([...ALL_ARGS_WRITERS, ...COPY_WRITERS, 'sed', 'dd', 'git', 'link', 'tar']);

interface SimpleCommand {
  words: string[];
  /** Targets of >, >>, >|, &> … */
  writes: string[];
  /** Here-document bodies and here-strings fed to the command. */
  stdin: string[];
  /** Files redirected in with `<`. */
  inputs: string[];
  /** Commands joined by `|` share this number. */
  pipe: number;
}

function simpleCommands(tokens: readonly Token[]): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  let pipe = 0;
  let cur: SimpleCommand = { words: [], writes: [], stdin: [], inputs: [], pipe };
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === undefined) break;
    if (tok.t === 'op' && SEPARATORS.has(tok.v)) {
      out.push(cur);
      if (!PIPES.has(tok.v)) pipe += 1;
      cur = { words: [], writes: [], stdin: [], inputs: [], pipe };
    } else if (tok.t === 'op') {
      const next = tokens[i + 1];
      if (next !== undefined && next.t === 'word') {
        if (WRITE_REDIRECTS.has(tok.v)) cur.writes.push(next.v);
        else if (tok.v === '<<<') cur.stdin.push(next.v);
        else if (tok.v === '<') cur.inputs.push(next.v);
        else if (tok.v === '<<' || tok.v === '<<-') cur.stdin.push(next.body ?? '');
        else if (!READ_REDIRECTS.has(tok.v)) cur.words.push(next.v);
        i += 1;
      }
    } else cur.words.push(tok.v);
  }
  out.push(cur);
  return out.filter((c) => c.words.length > 0 || c.writes.length > 0);
}

/** Is `o` an option of `wrapper` that takes the next word as its value (`-u`, or combined `-Eu`)? */
function takesValue(wrapper: Wrapper, o: string): boolean {
  return wrapper.valued.includes(o) || (/^-[a-zA-Z]{2,}$/u.test(o) && wrapper.valued.includes(`-${o.slice(-1)}`));
}

/** Drops `VAR=value` assignments and wrapper words (sudo, env, timeout, xargs, parallel, if, …) with their options and operands. */
function commandWords(input: readonly string[]): { words: string[]; xargs: boolean } {
  const words = [...input];
  let i = 0;
  let xargs = false;
  while (i < words.length) {
    const w = words[i] ?? '';
    if (/^[A-Za-z_]\w*=/u.test(w)) { i += 1; continue; }
    const wrapper = WRAPPERS.get(w);
    if (wrapper === undefined) break;
    if (w === 'xargs' || w === 'parallel') xargs = true;
    i += 1;
    while (i < words.length) {
      const o = words[i] ?? '';
      if (o === '--') { i += 1; break; }
      if (!o.startsWith('-') || o === '-') break;
      i += 1;
      // `env -S 'tee x'` splits its value into the command words.
      if (w === 'env' && (o === '-S' || o === '--split-string')) { words.splice(i, 1, ...(words[i] ?? '').split(/\s+/u).filter((x) => x !== '')); break; }
      if (takesValue(wrapper, o)) i += 1;
    }
    i = Math.min(words.length, i + wrapper.operands);
  }
  return { words: words.slice(i), xargs };
}

function nonOptions(args: readonly string[]): string[] {
  return args.filter((a) => !a.startsWith('-') || a === '-');
}

/** No script operand: the program reads its code from stdin (`python3`, `python3 -`, `bash -s`). */
function readsStdin(args: readonly string[]): boolean {
  const plain = nonOptions(args);
  return plain.length === 0 || plain[0] === '-';
}

function codeWritesOwner(code: string): boolean {
  return OWNER_NAME_IN_CODE.test(code) && WRITE_CALL_IN_CODE.test(code);
}

/** Destinations of cp / mv / ln / install / rsync: `-t dir`, else the last argument; a directory also gets each source's name. `destWord` is the destination as written. */
function copyTargets(args: readonly string[]): { dests: string[]; sources: string[]; destWord: string | null } {
  const t = args.findIndex((a) => a === '-t' || a === '--target-directory');
  const inline = args.find((a) => a.startsWith('--target-directory='));
  const plain = nonOptions(args.filter((_, i) => t < 0 || (i !== t && i !== t + 1)));
  const dir = inline !== undefined ? inline.slice('--target-directory='.length) : t >= 0 ? (args[t + 1] ?? null) : null;
  if (dir !== null) return { dests: plain.map((s) => join(dir, basename(s))).concat(dir), sources: plain, destWord: dir };
  const dest = plain.at(-1);
  if (dest === undefined || plain.length < 2) return { dests: [], sources: plain, destWord: null };
  const sources = plain.slice(0, -1);
  return { dests: [dest, ...sources.map((s) => join(dest, basename(s)))], sources, destWord: dest };
}

/** What the analysis of one command line knows: the cwd (it follows `cd`) and the text of its command substitutions. */
interface Scope {
  cwd: string;
  subs: readonly string[];
}

/** Placeholder for the n-th command substitution inside a word; the `$` keeps it a wildcard in directory positions. */
function subMark(n: number): string {
  return `$\u0001${n}\u0001`;
}

const SUB_MARKS = /\$\u0001(\d+)\u0001/gu;

/** `word` with its substitution placeholders turned back into `$(…)`, for `sh -c` / `eval` / interpreter text. */
function unmark(word: string, subs: readonly string[]): string {
  return word.replace(SUB_MARKS, (_m: string, n: string) => `$(${subs[Number(n)] ?? ''})`);
}

/** Does a word built from command substitutions take its path from a command that names an owner file or tree? */
function viaSub(word: string, scope: Scope): boolean {
  if (!word.includes('\u0001')) return false;
  return [...word.matchAll(SUB_MARKS)].some((m) => namesOwner(scope.subs[Number(m[1])] ?? '', scope.cwd));
}

/** `rounds` or `calibration` as a path component in command text. */
const OWNER_DIR_IN_TEXT = /(?<![\w.-])(?:rounds|calibration)(?![\w.-])/iu;
/** Commands that list the cwd when given no path (`fd`, `rg` and `grep -r` take a pattern first). */
const LISTERS: ReadonlySet<string> = new Set(['ls', 'find', 'fd', 'rg', 'grep', 'du', 'tree', 'pwd', 'dir']);
/** git subcommands whose output is paths of the work tree. */
const GIT_LISTERS: ReadonlySet<string> = new Set(['ls-files', 'ls-tree', 'diff', 'status', 'grep', 'show', 'log', 'whatchanged']);

/** The directory holding `.git` at or above `dir`, else `dir`. */
function gitTop(dir: string): string {
  for (let cur = dir; ; cur = dirname(cur)) {
    if (existsSync(join(cur, '.git'))) return cur;
    if (dirname(cur) === cur) return dir;
  }
}

/** Paths an (unwrapped) command names: its non-option words, plus the directory it lists when given no path (`ls`, `find -name x`, `git ls-files`, `pwd`). */
function namedPaths(words: readonly string[], cwd: string): string[] {
  const verb = basename(words[0] ?? '');
  const args = words.slice(1);
  if (verb === 'git') {
    const g = gitCall(args, cwd);
    if (g.sub === 'rev-parse' && g.rest.some((a) => a === '--show-toplevel' || a === '--show-cdup')) return [gitTop(g.top)];
    return g.sub !== undefined && GIT_LISTERS.has(g.sub) ? [g.cwd, ...nonOptions(g.rest)] : nonOptions(g.rest);
  }
  if (verb === 'find') {
    let i = 0;
    while (i < args.length && /^-(?:[HLP]|O\d*|D)$/u.test(args[i] ?? '')) i += args[i] === '-D' ? 2 : 1;
    const rest = args.slice(i);
    const expr = rest.findIndex((a) => /^[-(!]/u.test(a));
    const paths = rest.slice(0, expr < 0 ? rest.length : expr);
    return paths.length > 0 ? paths : ['.'];
  }
  const plain = nonOptions(args);
  const patternFirst = verb === 'fd' || verb === 'rg' || verb === 'grep';
  const walks = verb !== 'grep' || args.some((a) => /^-[a-zA-Z]*[rR]/u.test(a) || a.startsWith('--recursive') || a === '--dereference-recursive');
  const lists = LISTERS.has(verb) && walks && (patternFirst ? plain.slice(1) : plain).length === 0;
  return lists ? [...plain, '.'] : plain;
}

function pathsNameOwner(paths: readonly string[], cwd: string): boolean {
  return paths.some((p) => isOwnerPath(p, cwd) || holdsOwnerFiles(p, cwd));
}

/** The cwd after `cd <args>` (no argument or `-`: unchanged). */
function cdTarget(args: readonly string[], cwd: string): string {
  const to = nonOptions(args)[0];
  return to !== undefined && to !== '-' ? resolve(cwd, expandHome(to)) : cwd;
}

/**
 * Does shell text whose output becomes paths (a command substitution, or input piped into xargs) name an owner file,
 * `rounds` / `calibration`, or a directory holding owner files, directly or by listing one (`ls`, `find`, `pwd`)?
 */
function namesOwner(text: string, cwd: string, depth = 0): boolean {
  if (OWNER_NAME_IN_CODE.test(text) || OWNER_DIR_IN_TEXT.test(text)) return true;
  if (depth > 4) return true;
  const inner: string[] = [];
  let here = cwd;
  for (const c of simpleCommands(lex(text, inner))) {
    const { words } = commandWords(c.words);
    const verb = basename(words[0] ?? '');
    if (verb === 'cd' || verb === 'pushd') here = cdTarget(words.slice(1), here);
    else if (pathsNameOwner(namedPaths(words, here), here)) return true;
  }
  return inner.some((s) => namesOwner(s, here, depth + 1));
}

/** `ln` (symbolic or hard) and `cp -s|-l|--symbolic-link|--link`: a later write through the link reaches its source. */
function makesLink(verb: string, args: readonly string[]): boolean {
  if (verb === 'ln') return true;
  return verb === 'cp' && args.some((a) => a === '--link' || a.startsWith('--sym') || /^-[a-zA-Z]*[sl]/u.test(a));
}

/** Does a link source name an owner file or a tree holding one, as given or relative to the link's directory (symlink text resolves there)? */
function linkReaches(sources: readonly string[], dests: readonly string[], tree: (p: string) => boolean, cwd: string): boolean {
  const bases = dests.flatMap((d) => [d, dirname(d)]);
  return sources.some((s) => tree(s) || bases.some((b) => tree(resolve(cwd, b, expandHome(s)))));
}

interface GitCall {
  sub: string | undefined;
  rest: string[];
  /** Where relative paths resolve: the cwd after every `-C`. */
  cwd: string;
  /** The work tree: `--work-tree`, else `cwd`. */
  top: string;
}

/** Splits `git [global options] <sub> <rest…>`, following `-C` and `--work-tree`. */
function gitCall(args: readonly string[], cwd: string): GitCall {
  let dir = cwd;
  let work: string | null = null;
  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? '';
    if (!a.startsWith('-')) break;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    const valued = GIT_VALUED.includes(name);
    const value = eq > 0 ? a.slice(eq + 1) : valued ? (args[i + 1] ?? '') : '';
    i += valued && eq < 0 ? 2 : 1;
    if (name === '-C') dir = resolve(dir, expandHome(value));
    else if (name === '--work-tree') work = resolve(dir, expandHome(value));
  }
  return { sub: args[i], rest: args.slice(i + 1), cwd: dir, top: work ?? dir };
}

/** A git pathspec that can name an owner file: an owner path, a tree holding one, a glob below such a tree (git's `*` crosses `/`), or `:` magic (`:/` is the whole work tree). */
function pathspecHits(spec: string, git: GitCall): boolean {
  if (spec.startsWith(':')) return workTreeHolds(git.top);
  const segs = spec.split('/');
  const g = segs.findIndex(hasGlob);
  if (g >= 0 && holdsOwnerFiles(segs.slice(0, g).join('/'), git.cwd)) return true;
  return isOwnerPath(spec, git.cwd) || holdsOwnerFiles(spec, git.cwd);
}

/** `-f`, `--force`, `--discard-changes` or a short-option cluster holding `f` (`-fb`). */
function forced(args: readonly string[]): boolean {
  return args.some((a) => a === '--force' || a === '--discard-changes' || /^-[a-zA-Z]*f/u.test(a));
}

/** `git clean` removes untracked files below the cwd (or its pathspecs); a dry run removes nothing. */
function cleanWrites(rest: readonly string[], git: GitCall, hits: (spec: string) => boolean): boolean {
  if (rest.some((a) => a === '--dry-run' || /^-[a-zA-Z]*n/u.test(a))) return false;
  const specs: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i] ?? '';
    if (a === '--') { specs.push(...rest.slice(i + 1)); break; }
    if (a === '--exclude' || /^-[a-zA-Z]*e$/u.test(a)) i += 1;
    else if (!a.startsWith('-')) specs.push(a);
  }
  if (specs.length > 0) return specs.some(hits);
  return treeHolds(git.cwd) || (git.top !== git.cwd && treeHolds(git.top));
}

/** `git stash [push]` without a pathspec (and pop, apply, save, drop, …) acts on the whole work tree; list / show / create / store do not. */
function stashWrites(rest: readonly string[], git: GitCall, hits: (spec: string) => boolean): boolean {
  const first = rest[0];
  const sub = first === undefined || first.startsWith('-') ? 'push' : first;
  if (STASH_READS.has(sub)) return false;
  if (sub !== 'push') return workTreeHolds(git.top);
  const opts = sub === first ? rest.slice(1) : rest;
  const specs: string[] = [];
  for (let i = 0; i < opts.length; i += 1) {
    const a = opts[i] ?? '';
    if (a === '--') { specs.push(...opts.slice(i + 1)); break; }
    if (a.startsWith('--pathspec-from-file')) return workTreeHolds(git.top);
    if (a === '--message' || /^-[a-zA-Z]*m$/u.test(a)) i += 1;
    else if (!a.startsWith('-')) specs.push(a);
  }
  return specs.length === 0 ? workTreeHolds(git.top) : specs.some(hits);
}


/** Files larger than this are not read for inspection; the command is denied instead. */
const READ_LIMIT = 16 * 1024 * 1024;

/** A regular file's text for inspection: '' when nothing exists there, null when it cannot be read (a directory, FIFO, too large, no permission): deny. */
function readText(abs: string): string | null {
  if (!present(abs)) return '';
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > READ_LIMIT) return null;
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** Header lines of a unified, context or git diff: they name the files a patch writes. */
const PATCH_HEADER = /^(?:diff |--- |\+\+\+ |\*\*\* |Index: |rename (?:from|to) |copy (?:from|to) )/u;

/** Does patch text write an owner file (an owner file name on a header line)? Unreadable text (null) counts as yes. */
function patchNamesOwner(text: string | null): boolean {
  return text === null || text.split('\n').some((l) => PATCH_HEADER.test(l) && OWNER_NAME_IN_CODE.test(l));
}

/** Text a command reads on stdin: here-documents / here-strings, `<` files and `cat <files> |`; null when a pipe feeds text the hook cannot see. */
function stdinTexts(feed: Feed, cwd: string): (string | null)[] | null {
  const texts: (string | null)[] = [...feed.stdin, ...feed.inputs.map((f) => readText(resolve(cwd, expandHome(f))))];
  for (const input of feed.pipedCommands) {
    const { words } = commandWords(input);
    const files = nonOptions(words.slice(1));
    if (basename(words[0] ?? '') !== 'cat' || files.length === 0 || files.includes('-')) return null;
    texts.push(...files.map((f) => readText(resolve(cwd, expandHome(f)))));
  }
  return texts;
}

/** `git apply`: patch files, or a patch on stdin, whose headers name an owner file; a piped patch the hook cannot see is denied in a work tree holding owner files. */
function applyWrites(rest: readonly string[], git: GitCall, feed: Feed): boolean {
  const reportOnly = rest.some((a) => a === '--check' || a === '--stat' || a === '--numstat' || a === '--summary');
  if (reportOnly && !rest.includes('--apply')) return false;
  const files = nonOptions(rest).filter((f) => f !== '-');
  if (files.length > 0) return files.some((f) => patchNamesOwner(readText(resolve(git.cwd, expandHome(f)))));
  const texts = stdinTexts(feed, git.cwd);
  return texts === null ? workTreeHolds(git.top) : texts.some(patchNamesOwner);
}

/**
 * Does a git command write, revert, stash away or delete an owner file? Commands that act on a whole work tree
 * (stash, reset --hard|--merge|--keep, a forced checkout / switch) are denied when that work tree holds owner files.
 */
function gitWrites(args: readonly string[], scope: Scope, feed: Feed): boolean {
  const git = gitCall(args, scope.cwd);
  const { sub, rest } = git;
  const hits = (spec: string): boolean => pathspecHits(spec, git) || viaSub(spec, scope);
  if (sub === undefined) return false;
  if (GIT_WRITERS.has(sub) && rest.some((a) => !a.startsWith('-') && hits(a))) return true;
  if (sub === 'apply') return applyWrites(rest, git, feed);
  if (sub === 'checkout') return forced(rest) && !rest.includes('--') && workTreeHolds(git.top);
  if (sub === 'switch') return forced(rest) && workTreeHolds(git.top);
  if (sub === 'reset') return rest.some((a) => a === '--hard' || a === '--merge' || a === '--keep') && workTreeHolds(git.top);
  if (sub === 'clean') return cleanWrites(rest, git, hits);
  if (sub === 'stash') return stashWrites(rest, git, hits);
  return false;
}

/** Options of `patch` that take the next word as their value. */
const PATCH_VALUED: readonly string[] = ['-i', '-o', '-d', '-p', '-D', '-B', '-F', '-r', '-V', '-Y', '-z', '-g', '--input', '--output', '--directory', '--strip', '--ifdef', '--prefix', '--fuzz', '--reject-file', '--version-control', '--basename-prefix', '--suffix', '--get'];

/** `patch`: its file operand or `-o` / `-r` output is an owner file, or its patch (`-i`, second operand, stdin) names one in a header. */
function patchWrites(args: readonly string[], feed: Feed, scope: Scope): boolean {
  if (args.some((a) => a === '--dry-run' || a === '--check' || a === '-C')) return false;
  const operands: string[] = [];
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? '';
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const attached = /^-([iodr])(.+)$/u.exec(a);
    if (eq > 0) values.set(a.slice(0, eq), a.slice(eq + 1));
    else if (PATCH_VALUED.includes(a)) { values.set(a, args[i + 1] ?? ''); i += 1; }
    else if (attached !== null) values.set(`-${attached[1] ?? ''}`, attached[2] ?? '');
    else if (!a.startsWith('-') || a === '-') operands.push(a);
  }
  const here = resolve(scope.cwd, expandHome(values.get('-d') ?? values.get('--directory') ?? '.'));
  const outputs = [operands[0], values.get('-o'), values.get('--output'), values.get('-r'), values.get('--reject-file')];
  if (outputs.some((p) => p !== undefined && p !== '-' && (isOwnerPath(p, here) || viaSub(p, scope)))) return true;
  const input = values.get('-i') ?? values.get('--input') ?? operands[1];
  if (input !== undefined && input !== '-') return [here, scope.cwd].some((base) => patchNamesOwner(readText(resolve(base, expandHome(input)))));
  const texts = stdinTexts(feed, scope.cwd);
  return texts === null ? workTreeHolds(here) : texts.some(patchNamesOwner);
}

/** Values of an option: `-X v`, a short cluster ending in X (`-xzC v`), `--long v`, `--long=v`. */
function optionValues(args: readonly string[], short: string, long: string): string[] {
  return args.flatMap((a, i) => {
    if (a === long || (/^-[a-zA-Z]+$/u.test(a) && a.endsWith(short))) return [args[i + 1] ?? ''];
    return a.startsWith(`${long}=`) ? [a.slice(long.length + 1)] : [];
  });
}

/** `tar`: extraction into an owner tree (`-C`, `--directory`, else the cwd) or with `-P`; an archive written onto an owner file; `--remove-files` over one. */
function tarWrites(args: readonly string[], owner: (p: string) => boolean, tree: (p: string) => boolean): boolean {
  const first = args[0] ?? '';
  const oldStyle = /^[a-zA-Z]+$/u.test(first);
  const clusters = args.filter((a) => /^-[a-zA-Z]+$/u.test(a)).concat(oldStyle ? [first] : []);
  const has = (letter: string): boolean => clusters.some((c) => c.includes(letter));
  const long = (...names: readonly string[]): boolean => args.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));
  if (has('x') || long('--extract', '--get')) {
    if (has('O') || long('--to-stdout', '--to-command')) return false;
    if (has('P') || long('--absolute-names')) return true;
    const dirs = optionValues(args, 'C', '--directory');
    return (dirs.length > 0 ? dirs : ['.']).some(tree);
  }
  if (!(has('c') || has('r') || has('u') || has('A') || long('--create', '--append', '--update', '--catenate', '--concatenate'))) return false;
  const archives = optionValues(args, 'f', '--file').concat(oldStyle && first.includes('f') ? [args[1] ?? ''] : []);
  return archives.some(owner) || (long('--remove-files') && nonOptions(args).some(tree));
}

/** `unzip` extracts into `-d <dir>`, else the cwd; list, test and stdout modes write nothing. */
function unzipWrites(args: readonly string[], tree: (p: string) => boolean): boolean {
  if (args.some((a) => /^-[a-zA-Z]*[clptvzZ]/u.test(a))) return false;
  const dirs = args.flatMap((a, i) => (/^-[a-zA-Z]*d$/u.test(a) ? [args[i + 1] ?? ''] : []));
  return (dirs.length > 0 ? dirs : ['.']).some(tree);
}

/** Compressors replace (or, decompressing, write next to) each file operand. */
const COMPRESSORS: ReadonlySet<string> = new Set(['gzip', 'gunzip', 'bzip2', 'bunzip2', 'xz', 'unxz', 'lzma', 'unlzma', 'zstd', 'unzstd', 'compress', 'uncompress']);

function compressorWrites(args: readonly string[], owner: (p: string) => boolean, tree: (p: string) => boolean): boolean {
  if (args.some((a) => a === '--stdout' || a === '--to-stdout' || a === '--list' || a === '--test' || /^-[a-zA-Z0-9]*[clt]/u.test(a))) return false;
  const recursive = args.some((a) => /^-[a-zA-Z0-9]*r/u.test(a) || a === '--recursive');
  return nonOptions(args).some((a) => (recursive ? tree : owner)(a) || owner(a.replace(/\.(?:gz|bz2|xz|lzma|zst|Z|tgz)$/u, '')));
}

/** `7z x|e` extracts into `-o<dir>`, else the cwd. */
function sevenZipWrites(args: readonly string[], tree: (p: string) => boolean): boolean {
  if (args[0] !== 'x' && args[0] !== 'e') return false;
  const dirs = args.filter((a) => a.startsWith('-o')).map((a) => a.slice(2));
  return (dirs.length > 0 ? dirs : ['.']).some(tree);
}

/** What a command reads on stdin: here-documents / here-strings, `<` files, and the rest of its pipeline. */
interface Feed {
  stdin: readonly string[];
  /** Files redirected in with `<`. */
  inputs: readonly string[];
  /** The other commands of its pipeline (their words) … */
  pipedCommands: readonly (readonly string[])[];
  /** … and their text, substitutions restored. */
  piped: string;
}

/** Does what is fed into xargs / parallel name an owner file, `rounds` / `calibration`, or a tree holding owner files (also by listing the cwd: `ls |`, `find . |`)? */
function feedNamesOwner(feed: Feed, scope: Scope): boolean {
  const files = feed.inputs.map((f) => readText(resolve(scope.cwd, expandHome(f))));
  if (files.includes(null)) return true;
  const text = [feed.piped, ...feed.stdin, ...files].join('\n');
  if (OWNER_NAME_IN_CODE.test(text) || OWNER_DIR_IN_TEXT.test(text)) return true;
  if (pathsNameOwner(text.split(/\s+/u).filter((w) => w !== '' && !w.startsWith('-')), scope.cwd)) return true;
  return feed.pipedCommands.some((input) => {
    const { words } = commandWords(input);
    return pathsNameOwner(namedPaths(words, scope.cwd), scope.cwd) || words.some((w) => viaSub(w, scope));
  });
}

/** Does one simple command write, move or delete an owner file? `scope.cwd` follows `cd` for the commands after it. */
function commandWrites(cmd: SimpleCommand, feed: Feed, scope: Scope, depth: number): boolean {
  if (cmd.writes.some((p) => isOwnerPath(p, scope.cwd) || viaSub(p, scope))) return true;
  const { words, xargs } = commandWords(cmd.words);
  if (verbWrites(words, feed, scope, depth)) return true;
  // `… | xargs rm`: the paths come from stdin; deny when what is fed names an owner file or tree.
  if (xargs && feedNamesOwner(feed, scope) && verbWrites([...words, 'owner-log.jsonl'], feed, { ...scope }, depth)) return true;
  // Unknown wrappers (`flock l tee …`) and wrapper options this table misses: re-check from every writer verb.
  return words.some((w, k) => k > 0 && WRITER_VERBS.has(basename(w)) && verbWrites(words.slice(k), feed, { ...scope }, depth));
}

function verbWrites(words: readonly string[], feed: Feed, scope: Scope, depth: number): boolean {
  const plainOwner = (p: string): boolean => isOwnerPath(p, scope.cwd);
  const plainTree = (p: string): boolean => plainOwner(p) || holdsOwnerFiles(p, scope.cwd);
  const owner = (p: string): boolean => plainOwner(p) || viaSub(p, scope);
  const tree = (p: string): boolean => owner(p) || holdsOwnerFiles(p, scope.cwd);
  const verb = basename(words[0] ?? '');
  const args = words.slice(1);
  if (verb === 'cd' || verb === 'pushd') {
    scope.cwd = cdTarget(args, scope.cwd);
    return false;
  }
  if (ALL_ARGS_WRITERS.has(verb)) return nonOptions(args).some(verb === 'rm' || verb === 'unlink' ? tree : owner);
  if (COPY_WRITERS.has(verb)) {
    const { dests, sources, destWord } = copyTargets(args);
    const recursive = verb === 'rsync' || verb === 'ditto' || args.some((a) => /^-[a-zA-Z]*[rRa]/u.test(a) || a === '--recursive' || a === '--archive');
    // joined `dest/<source name>` candidates are matched as written: a substitution there stands for a basename
    if (dests.some(recursive ? plainTree : plainOwner) || (destWord !== null && viaSub(destWord, scope)) || (verb === 'mv' && sources.some(tree))) return true;
    return makesLink(verb, args) && linkReaches(sources, dests, tree, scope.cwd);
  }
  if (verb === 'link') return nonOptions(args).some(tree);
  if (verb === 'sed' && args.some((a) => /^-[^-]*i/u.test(a) || a.startsWith('--in-place'))) return args.some(owner);
  if (verb === 'perl' && args.some((a) => /^-[^-e]*i/u.test(a))) return args.some(owner);
  if (verb === 'dd') return args.some((a) => a.startsWith('of=') && owner(a.slice(3)));
  if (verb === 'git') return gitWrites(args, scope, feed);
  if (verb === 'patch') return patchWrites(args, feed, scope);
  if (verb === 'tar' || verb === 'bsdtar' || verb === 'gtar') return tarWrites(args, owner, tree);
  if (verb === 'unzip') return unzipWrites(args, tree);
  if (/^7z[a-z]?$/u.test(verb)) return sevenZipWrites(args, tree);
  if (COMPRESSORS.has(verb)) return compressorWrites(args, owner, tree);
  if (verb === 'find' && args.some((a) => a === '-delete' || a.startsWith('-exec') || a === '-ok' || a === '-fprint')) {
    return args.some((a) => tree(a) || OWNER_NAME_IN_CODE.test(a));
  }
  const interpreter = verb.replace(/\d+(?:\.\d+)*$/u, '');
  const codeFlags = INTERPRETER_CODE_FLAGS[interpreter];
  if (codeFlags !== undefined) {
    // combined short flags count too: `perl -pie '…'`, `python3 -Sc '…'`
    const isCodeFlag = (a: string): boolean => codeFlags.includes(a) || (/^-[a-zA-Z]+$/u.test(a) && codeFlags.some((f) => f.length === 2 && a.endsWith(f.slice(1))));
    if (args.some((a, i) => isCodeFlag(a) && codeWritesOwner(unmark(args[i + 1] ?? '', scope.subs)))) return true;
    if (feed.stdin.some(codeWritesOwner)) return true;
    // `echo "…" | python3`: code from a pipe is over-denied when the pipeline names an owner file.
    return !args.some(isCodeFlag) && readsStdin(args) && OWNER_NAME_IN_CODE.test(feed.piped);
  }
  if (SHELLS.has(verb)) {
    const c = args.findIndex((a) => /^-[a-z]*c[a-z]*$/u.test(a));
    if (c >= 0) return writesOwner(unmark(args[c + 1] ?? '', scope.subs), scope.cwd, depth + 1);
    if (feed.stdin.some((body) => writesOwner(body, scope.cwd, depth + 1))) return true;
    return (readsStdin(args) || args.includes('-s')) && OWNER_NAME_IN_CODE.test(feed.piped);
  }
  if (verb === 'eval') return writesOwner(args.map((a) => unmark(a, scope.subs)).join(' '), scope.cwd, depth + 1);
  return false;
}

function writesOwner(command: string, cwd: string, depth: number): boolean {
  if (depth > 4) return true;
  const subs: string[] = [];
  const commands = simpleCommands(lex(command, subs));
  const scope: Scope = { cwd, subs };
  const feedOf = (c: SimpleCommand): Feed => {
    const others = commands.filter((o) => o !== c && o.pipe === c.pipe);
    const piped = others.flatMap((o) => [...o.words, ...o.writes, ...o.stdin]).map((w) => unmark(w, subs)).join('\n');
    return { stdin: c.stdin, inputs: c.inputs, pipedCommands: others.map((o) => o.words), piped };
  };
  if (commands.some((c) => commandWrites(c, feedOf(c), scope, depth))) return true;
  return subs.some((s) => writesOwner(s, scope.cwd, depth + 1));
}

/** True when a shell command names an owner-only file together with a writing construct (>, >>, tee, sed -i, cp, mv, rm, …). */
export function bashWritesOwnerFile(command: string, cwd: string = process.cwd()): boolean {
  return writesOwner(command.normalize('NFC'), cwd, 0);
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

const ALLOW: HookDecision = { decision: 'allow', reason: '' };

/** The hook's decision; any error while deciding denies (fail closed), it never crashes or allows. */
export function decide(input: unknown): HookDecision {
  try {
    return decideOrThrow(input);
  } catch (err) {
    return { decision: 'deny', reason: `${DENY_REASON} (the hook could not analyse this call: ${err instanceof Error ? err.message : String(err)})` };
  }
}

function decideOrThrow(input: unknown): HookDecision {
  const tool = field(input, 'tool_name');
  const toolInput = field(input, 'tool_input');
  const cwdField = field(input, 'cwd');
  const cwd = typeof cwdField === 'string' && cwdField !== '' ? cwdField : process.cwd();
  if (typeof tool !== 'string') return ALLOW;
  const deny = (target: string): HookDecision => ({ decision: 'deny', reason: `${DENY_REASON} (${tool}: ${target})` });
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const path = field(toolInput, tool === 'NotebookEdit' ? 'notebook_path' : 'file_path');
    return typeof path === 'string' && isOwnerPath(path, cwd) ? deny(path) : ALLOW;
  }
  if (tool === 'Bash') {
    const command = field(toolInput, 'command');
    return typeof command === 'string' && bashWritesOwnerFile(command, cwd) ? deny(command.length > 200 ? `${command.slice(0, 200)}…` : command) : ALLOW;
  }
  return ALLOW;
}

/** stdout text for a decision: the deny JSON line, or '' on allow. */
export function hookOutput(d: HookDecision): string {
  if (d.decision === 'allow') return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason } });
}

if (import.meta.main) {
  let input: unknown = null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(0, 'utf8'));
    input = parsed;
  } catch {
    input = null;
  }
  const out = hookOutput(decide(input));
  if (out !== '') process.stdout.write(`${out}\n`);
  process.exitCode = 0;
}
