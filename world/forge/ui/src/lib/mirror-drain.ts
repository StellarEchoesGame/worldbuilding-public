import { spawn } from 'node:child_process';

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type Spawner = (cmd: string, args: readonly string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<SpawnResult>;

export const MIRROR_DRAIN_TIMEOUT_MS = 120_000;

/** Between SIGTERM at the timeout and SIGKILL for a child that ignores SIGTERM. */
const KILL_GRACE_MS = 2000;

const ROUND_ID = /^[A-Z]\d{2}$/u;
const DROPPED_ENV: readonly string[] = ['FORGE_UI_TOKEN', 'FORGE_DATA_DIR', 'FORGE_UI_CLOCK_FILE'];
/** Output kept per stream (the CLI prints one line per round). */
const OUTPUT_CAP = 64 * 1024;

/** `['engine/cli.ts', 'mirror', '--round', round]` (round must match /^[A-Z]\d{2}$/u, else throws). */
export function mirrorDrainArgs(round: string): string[] {
  if (!ROUND_ID.test(round)) throw new RangeError(`mirror drain: round id must look like R01, got ${JSON.stringify(round)}`);
  return ['engine/cli.ts', 'mirror', '--round', round];
}

/** process.env minus FORGE_UI_TOKEN, FORGE_DATA_DIR and FORGE_UI_CLOCK_FILE (the token never reaches a child). */
export function drainEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!DROPPED_ENV.includes(k)) out[k] = v;
  return out;
}

export type DrainResult = { ok: true; exitCode: number; summary: string } | { ok: false; error: string };

function lastLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).filter((l) => l !== '').at(-1) ?? '';
}

/**
 * Runs `node engine/cli.ts mirror --round RNN` (process.execPath) with cwd = forgeRoot via `spawner`; summary = the
 * last non-empty stdout line; exit 1 (engine lock held) / timeout / spawn error → ok false with a Chinese message.
 */
export async function drainMirror(input: { forgeRoot: string; round: string; spawner: Spawner; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<DrainResult> {
  let args: string[];
  try {
    args = mirrorDrainArgs(input.round);
  } catch {
    return { ok: false, error: `轮次编号 ${input.round} 无效。` };
  }
  let r: SpawnResult;
  try {
    r = await input.spawner(process.execPath, args, { cwd: input.forgeRoot, env: drainEnv(input.env), timeoutMs: input.timeoutMs });
  } catch (e) {
    return { ok: false, error: `无法启动 forge mirror：${e instanceof Error ? e.message : String(e)}` };
  }
  if (r.timedOut) return { ok: false, error: `forge mirror 超时（${Math.round(input.timeoutMs / 1000)} 秒），已发出停止信号（${KILL_GRACE_MS / 1000} 秒内仍未退出则强制结束）；稍后重试。` };
  const detail = lastLine(r.stdout) || lastLine(r.stderr);
  if (r.exitCode === 0) return { ok: true, exitCode: 0, summary: detail || '没有待补发的镜像。' };
  if (r.exitCode === 1 && /engine lock/u.test(`${r.stdout}\n${r.stderr}`)) {
    const lock = `${r.stdout}\n${r.stderr}`.split('\n').find((l) => /engine lock/u.test(l)) ?? '';
    return { ok: false, error: `引擎锁被占用，另一个 forge 进程正在运行（${lock.replace(/^forge:\s*/u, '').trim()}）；等它结束后再重试。` };
  }
  return { ok: false, error: `forge mirror 退出码 ${r.exitCode === null ? '（被信号终止）' : String(r.exitCode)}${detail === '' ? '' : `：${detail}`}` };
}

/** The part of a spawned child process the spawner uses (node:child_process in production, a fake in tests). */
export interface ChildLike {
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
}

/**
 * A Spawner over `spawnChild`: resolves on `close`, or at `timeoutMs` with timedOut true (SIGTERM sent; SIGKILL after
 * `graceMs` unless the child closes first). Both timers are unref'd: the child's own handle keeps the process alive.
 */
export function childSpawner(spawnChild: (cmd: string, args: readonly string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildLike, graceMs: number): Spawner {
  return (cmd, args, opts) =>
    new Promise<SpawnResult>((done, fail) => {
      const child = spawnChild(cmd, args, { cwd: opts.cwd, env: opts.env });
      let stdout = '';
      let stderr = '';
      let kill: ReturnType<typeof setTimeout> | null = null;
      child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < OUTPUT_CAP) stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < OUTPUT_CAP) stderr += chunk.toString('utf8'); });
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        kill = setTimeout(() => child.kill('SIGKILL'), graceMs);
        kill.unref();
        done({ exitCode: null, stdout, stderr, timedOut: true });
      }, opts.timeoutMs);
      timer.unref();
      const stop = (): void => {
        clearTimeout(timer);
        if (kill !== null) clearTimeout(kill);
      };
      child.on('error', (e) => {
        stop();
        fail(e);
      });
      child.on('close', (code) => {
        stop();
        done({ exitCode: code, stdout, stderr, timedOut: false });
      });
    });
}

/** Production spawner (node:child_process spawn, stdio pipes; SIGTERM at the timeout, SIGKILL KILL_GRACE_MS later). */
export const nodeSpawner: Spawner = childSpawner((cmd, args, opts) => spawn(cmd, [...args], { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] }), KILL_GRACE_MS);
