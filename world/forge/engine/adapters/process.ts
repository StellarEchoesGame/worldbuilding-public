import { spawn } from 'node:child_process';

export interface ProcessOptions {
  envSet: Record<string, string>;
  envUnset: string[];
  cwd: string;
  stdin: string | null;
  timeoutMs: number;
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
}

export function childEnv(envSet: Record<string, string>, envUnset: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of envUnset) delete env[key];
  return { ...env, ...envSet };
}

export function runProcess(cmd: string, args: readonly string[], opts: ProcessOptions): Promise<ProcessResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: childEnv(opts.envSet, opts.envUnset), stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null, extraErr: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(errOut).toString('utf8') + extraErr,
        ms: Date.now() - started,
        timedOut,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => errOut.push(d));
    child.on('error', (e) => finish(null, `\nspawn error: ${e.message}`));
    child.on('close', (code) => finish(code, ''));
    child.stdin.on('error', () => undefined);
    if (opts.stdin !== null) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}
