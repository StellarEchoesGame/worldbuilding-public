import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { waitForServer } from '../../../engine/ui-launch.ts';
import { sameDir } from '../../../engine/same-dir.ts';

/**
 * Test-only harness (imported only by *.test.ts): builds the UI once per source state and runs ui/dist/server/entry.mjs
 * against a temporary forge root. Never points at the real forge root. Imports nothing from engine/testing/ (lint).
 */

export interface Page {
  status: number;
  /** Location header of a redirect, else null. */
  location: string | null;
  text: string;
}

export interface RequestOptions {
  /** Cookie header; default `forge_token=<token>`; null sends none. */
  cookie?: string | null;
  /** Origin header of a POST; default `base`; null sends none. */
  origin?: string | null;
}

export interface UiServer {
  base: string;
  token: string;
  cookie: string;
  get(path: string, opts?: RequestOptions): Promise<Page>;
  /** application/x-www-form-urlencoded; array values repeat the key. Writes now() to the clock file first. */
  post(path: string, form: Readonly<Record<string, string | readonly string[]>>, opts?: RequestOptions): Promise<Page>;
  /** POST `body` with this Content-Type (null sends none); cookie, Origin and the clock file as `post`. */
  postRaw(path: string, body: string, contentType: string | null, opts?: RequestOptions): Promise<Page>;
  /** GET with an explicit Host header (node:http; fetch cannot set Host). */
  getWithHost(path: string, host: string): Promise<Page>;
  stop(): Promise<void>;
}

export interface StartOptions {
  /** FORGE_DATA_DIR (a temporary fixture forge root, `<tmp>/repo/world/forge`). */
  dataDir: string;
  /** Timestamp each POST stamps (FORGE_UI_CLOCK_FILE); tests pass the engine's fake clock. */
  now: () => string;
  /** Extra env for the server (e.g. HOST, CLAUDECODE); merged over a copy of process.env. */
  env?: Readonly<Record<string, string>>;
}

/** The forge root of this checkout (ui/src/test → ../../..). */
export const FORGE_ROOT = join(import.meta.dirname, '..', '..', '..');

const BUILD_SHA_FILE = join('ui', 'dist', '.forge-build.sha256');
const BUILD_LOCK = join('ui', '.forge-build.lock');
const LOCK_WAIT_MS = 300_000;
const LOCK_STALE_MS = 600_000;
const SKIP_DIRS: readonly string[] = ['node_modules', 'dist', '.astro'];

function filesOf(dir: string, keep: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.includes(name)) out.push(...filesOf(path, keep));
    } else if (keep(path)) out.push(path);
  }
  return out;
}

/** sha256 over ui/src/**, ui/astro.config.mjs, engine/**\/*.ts (tests excluded), package-lock.json, in path order. */
export function buildInputsSha256(forgeRoot: string): string {
  const notTest = (p: string): boolean => !p.endsWith('.test.ts');
  const files = [
    ...filesOf(join(forgeRoot, 'ui', 'src'), notTest),
    join(forgeRoot, 'ui', 'astro.config.mjs'),
    ...filesOf(join(forgeRoot, 'engine'), (p) => p.endsWith('.ts') && notTest(p)),
    join(forgeRoot, 'package-lock.json'),
  ].filter((p) => existsSync(p));
  const rels = files.map((p) => ({ p, rel: relative(forgeRoot, p).split(sep).join('/') })).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const hash = createHash('sha256');
  for (const { p, rel } of rels) {
    hash.update(`${rel}\n`);
    hash.update(createHash('sha256').update(readFileSync(p)).digest('hex'));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function builtSha(forgeRoot: string): string | null {
  const file = join(forgeRoot, BUILD_SHA_FILE);
  if (!existsSync(file) || !existsSync(join(forgeRoot, 'ui', 'dist', 'server', 'entry.mjs'))) return null;
  return readFileSync(file, 'utf8').trim();
}

/** Exclusive create of the build lock; a lock older than LOCK_STALE_MS is removed; waits up to LOCK_WAIT_MS. */
function acquireLock(path: string): void {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(path, 'wx'));
      return;
    } catch (e) {
      if (!(e instanceof Error) || !('code' in e) || e.code !== 'EEXIST') throw e;
    }
    try {
      if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) rmSync(path, { force: true });
    } catch {
      // the holder released it between the two calls
    }
    if (Date.now() > deadline) throw new Error(`ensureBuilt: ${path} held for more than ${LOCK_WAIT_MS / 1000} s`);
    sleepSync(200);
  }
}

/**
 * `astro build --root ui` unless ui/dist/.forge-build.sha256 equals buildInputsSha256; serialised across test
 * processes by ui/.forge-build.lock (exclusive create, waiters poll ≤ 300 s, stale after 600 s).
 */
export function ensureBuilt(forgeRoot: string): void {
  const want = buildInputsSha256(forgeRoot);
  if (builtSha(forgeRoot) === want) return;
  const lock = join(forgeRoot, BUILD_LOCK);
  acquireLock(lock);
  try {
    if (builtSha(forgeRoot) === want) return;
    const astro = join(forgeRoot, 'node_modules', '.bin', 'astro');
    const r = spawnSync(astro, ['build', '--root', 'ui'], { cwd: forgeRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: LOCK_WAIT_MS });
    if (r.status !== 0) throw new Error(`astro build failed (${String(r.status)}):\n${`${r.stdout}\n${r.stderr}`.slice(-4000)}`);
    writeFileSync(join(forgeRoot, BUILD_SHA_FILE), `${want}\n`);
  } finally {
    rmSync(lock, { force: true });
  }
}

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((done, fail) => {
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => done());
  });
  const address = srv.address();
  await new Promise<void>((done) => srv.close(() => done()));
  if (address === null || typeof address === 'string') throw new Error('freePort: no TCP address');
  return address.port;
}

function encodeForm(form: Readonly<Record<string, string | readonly string[]>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    if (typeof value === 'string') params.append(key, value);
    else for (const v of value) params.append(key, v);
  }
  return params.toString();
}

async function toPage(res: Response): Promise<Page> {
  return { status: res.status, location: res.headers.get('location'), text: await res.text() };
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((done) => child.once('exit', () => done()));
}

const FORM = 'application/x-www-form-urlencoded';

/**
 * ensureBuilt, a free port (net listen 0), spawn entry.mjs (HOST 127.0.0.1, PORT, token), waitForServer. Refuses
 * the real forge root under any alias (sameDir: symlink, case variant, `..` path) before building anything.
 */
export async function startServer(opts: StartOptions): Promise<UiServer> {
  if (sameDir(opts.dataDir, FORGE_ROOT)) throw new Error('startServer: refusing the real forge root');
  ensureBuilt(FORGE_ROOT);
  const port = await freePort();
  const token = randomBytes(24).toString('hex');
  const clockDir = mkdtempSync(join(tmpdir(), 'forge-ui-clock-'));
  const clockFile = join(clockDir, 'now.txt');
  writeFileSync(clockFile, opts.now());
  const child = spawn(process.execPath, [join(FORGE_ROOT, 'ui', 'dist', 'server', 'entry.mjs')], {
    cwd: FORGE_ROOT,
    env: { ...process.env, FORGE_DATA_DIR: opts.dataDir, FORGE_UI_TOKEN: token, FORGE_UI_CLOCK_FILE: clockFile, HOST: '127.0.0.1', PORT: String(port), ...opts.env },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const stop = async (): Promise<void> => {
    child.kill('SIGTERM');
    await exited(child);
    rmSync(clockDir, { recursive: true, force: true });
  };
  if (!(await waitForServer(`${base}/login`, 30_000))) {
    await stop();
    throw new Error(`startServer: ${base} did not answer within 30 s`);
  }
  const cookie = `forge_token=${token}`;
  /** `post` null: a GET; else a POST with this Content-Type (null: none) and the Origin of `o` (default `base`). */
  const headers = (o: RequestOptions | undefined, post: { contentType: string | null } | null): Record<string, string> => {
    const h: Record<string, string> = {};
    const c = o?.cookie === undefined ? cookie : o.cookie;
    if (c !== null) h['cookie'] = c;
    if (post !== null) {
      if (post.contentType !== null) h['content-type'] = post.contentType;
      const origin = o?.origin === undefined ? base : o.origin;
      if (origin !== null) h['origin'] = origin;
    }
    return h;
  };
  // The body goes as bytes: fetch adds no Content-Type of its own (a string body would get text/plain).
  const send = async (path: string, body: string, contentType: string | null, o: RequestOptions | undefined): Promise<Page> => {
    writeFileSync(clockFile, opts.now());
    return toPage(await fetch(`${base}${path}`, { method: 'POST', redirect: 'manual', headers: headers(o, { contentType }), body: new TextEncoder().encode(body) }));
  };
  return {
    base,
    token,
    cookie,
    get: async (path, o) => toPage(await fetch(`${base}${path}`, { redirect: 'manual', headers: headers(o, null) })),
    post: (path, form, o) => send(path, encodeForm(form), FORM, o),
    postRaw: (path, body, contentType, o) => send(path, body, contentType, o),
    getWithHost: (path, host) =>
      new Promise((done, fail) => {
        const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host, cookie } }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const loc = res.headers.location;
            done({ status: res.statusCode ?? 0, location: loc ?? null, text: Buffer.concat(chunks).toString('utf8') });
          });
        });
        req.on('error', fail);
        req.end();
      }),
    stop,
  };
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`, 'u').exec(tag);
  return m === null ? null : (m[1] ?? '').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

/** `value` of every `<input name="<name>">` (any attribute order) in document order. */
export function inputValues(html: string, name: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<input\b[^>]*>/gu)) {
    const tag = m[0];
    const value = attr(tag, 'value');
    if (attr(tag, 'name') === name && value !== null) out.push(value);
  }
  return out;
}

/** `action` of every `<form>` in document order. */
export function formActions(html: string): string[] {
  return [...html.matchAll(/<form\b[^>]*>/gu)].map((m) => attr(m[0], 'action') ?? '');
}

/** The `?error=` of a redirect location, decoded (null when the redirect carries none). */
export function redirectError(location: string | null): string | null {
  if (location === null) return null;
  return new URL(location, 'http://x.invalid').searchParams.get('error');
}

/** Hidden / text `name → value` fields of each `<form action="<action>">` (document order), up to its `</form>`. */
export function formFields(html: string, action: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  for (const m of html.matchAll(/<form\b[^>]*>/gu)) {
    if (attr(m[0], 'action') !== action) continue;
    const start = (m.index ?? 0) + m[0].length;
    const end = html.indexOf('</form>', start);
    const body = html.slice(start, end < 0 ? undefined : end);
    const fields: Record<string, string> = {};
    for (const t of body.matchAll(/<input\b[^>]*>/gu)) {
      const type = attr(t[0], 'type') ?? 'text';
      const name = attr(t[0], 'name');
      if (name !== null && (type === 'hidden' || type === 'text')) fields[name] = attr(t[0], 'value') ?? '';
    }
    out.push(fields);
  }
  return out;
}

/** Distinct `name`s of the `<input>`s whose value is `value` (e.g. the audit pairs' "left" radios), document order. */
export function inputNamesWithValue(html: string, value: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<input\b[^>]*>/gu)) {
    const name = attr(m[0], 'name');
    if (name !== null && attr(m[0], 'value') === value && !out.includes(name)) out.push(name);
  }
  return out;
}
