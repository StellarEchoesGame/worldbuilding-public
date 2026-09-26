import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loopbackOnly } from './loopback.ts';
import { sameDir } from './same-dir.ts';
import { err, ok, type Result } from './result.ts';

/** Environment variables that only exist inside an agent session (not in the owner's own terminal). */
export const AGENT_MARKERS: readonly string[] = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];

/** Name prefixes of agent-session variables (the epic's CODEX_*, KIMI_*, GROK_*). */
export const AGENT_MARKER_PREFIXES: readonly string[] = ['CODEX_', 'KIMI_', 'GROK_'];

/** Set agent markers of `env` (exact names plus prefixed names), sorted. */
export function agentMarkers(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((k) => env[k] !== undefined && (AGENT_MARKERS.includes(k) || AGENT_MARKER_PREFIXES.some((p) => k.startsWith(p))))
    .sort();
}

/** `--host <h>` / `--host=<h>` of `forge ui` (default 127.0.0.1); err unless loopback (the UI is never served off this machine). */
export function launchHost(args: readonly string[]): Result<string> {
  const i = args.findIndex((a) => a === '--host' || a.startsWith('--host='));
  if (i < 0) return ok('127.0.0.1');
  const flag = args[i] ?? '';
  const host = flag === '--host' ? args[i + 1] : flag.slice('--host='.length);
  if (host === undefined || host === '' || host.startsWith('--')) return err('forge ui: --host 需要一个主机名，例如 127.0.0.1。');
  if (!loopbackOnly(host)) return err(`forge ui: --host ${host} 不是本机地址；界面只允许绑定 127.0.0.1、localhost 或 ::1。`);
  return ok(host);
}

export const UI_PORT = 4391;

/** Polls until the URL answers with any HTTP status (401 counts as up) or the timeout passes. */
export async function waitForServer(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return false;
}

export async function launchUi(root: string, args: readonly string[]): Promise<void> {
  const host = launchHost(args);
  if (!host.ok) {
    process.stderr.write(`${host.error}\n`);
    process.exit(1);
  }
  const envHost = process.env['HOST'];
  if (envHost !== undefined && envHost !== '' && !loopbackOnly(envHost)) {
    process.stderr.write(`forge ui: 环境变量 HOST=${envHost} 不是本机地址，拒绝启动。\n`);
    process.exit(1);
  }
  const dataIndex = args.indexOf('--data');
  const dataDir = resolve(dataIndex >= 0 ? (args[dataIndex + 1] ?? root) : root);
  const markers = agentMarkers(process.env);
  if (sameDir(dataDir, root) && markers.length > 0) {
    process.stderr.write(`forge ui: 检测到代理会话标记（${markers.join('、')}），拒绝对真实数据目录启动。请在你自己的终端里运行 npm run ui。\n`);
    process.exit(1);
  }
  const token = randomBytes(24).toString('hex');
  const astro = resolve(root, 'node_modules/.bin/astro');
  process.stdout.write('forge ui: 构建界面…\n');
  const build = spawnSync(astro, ['build', '--root', 'ui'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  if (build.status !== 0) {
    process.stderr.write('forge ui: 构建失败。\n');
    process.exit(1);
  }
  const child = spawn(process.execPath, [resolve(root, 'ui/dist/server/entry.mjs')], {
    cwd: root,
    env: { ...process.env, FORGE_DATA_DIR: dataDir, FORGE_UI_TOKEN: token, HOST: host.value, PORT: String(UI_PORT) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child.stdout.on('data', (chunk: Buffer) => process.stdout.write(chunk.toString('utf8').replaceAll(token, '<token>')));
  const base = `http://${host.value.includes(':') ? `[${host.value}]` : host.value}:${UI_PORT}`;
  if (!(await waitForServer(`${base}/login`, 30_000))) {
    process.stderr.write('forge ui: 服务器 30 秒内没有就绪。\n');
    child.kill('SIGTERM');
    process.exit(1);
  }
  const url = `${base}/login?t=${token}`;
  const file = join(resolve(root, '.runs'), 'ui-login-url.txt');
  child.on('close', () => rmSync(file, { force: true }));
  if (args.includes('--no-open')) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${url}\n`, { mode: 0o600 });
    process.stdout.write(`forge ui: 没有自动打开浏览器；登录地址写在 ${file}（仅本人可读）。\n`);
  } else {
    spawn('open', [url], { stdio: 'ignore' }).unref();
    process.stdout.write(`forge ui: 已在浏览器中打开 ${base}/（按 Ctrl+C 停止）\n`);
  }
  await new Promise<void>((done) => child.on('close', () => done()));
}
