import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

/** Environment variables that only exist inside an agent session (not in the owner's own terminal). */
export const AGENT_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID'];

export function agentMarkers(env: NodeJS.ProcessEnv): string[] {
  return AGENT_MARKERS.filter((k) => env[k] !== undefined);
}

export const UI_PORT = 4391;

export async function launchUi(root: string, args: readonly string[]): Promise<void> {
  const dataIndex = args.indexOf('--data');
  const dataDir = resolve(dataIndex >= 0 ? (args[dataIndex + 1] ?? root) : root);
  const markers = agentMarkers(process.env);
  if (dataDir === resolve(root) && markers.length > 0) {
    process.stderr.write(`forge ui: 检测到代理会话标记（${markers.join('、')}），拒绝对真实数据目录启动。请在你自己的终端里运行 npm run ui。\n`);
    process.exit(1);
  }
  const token = randomBytes(24).toString('hex');
  const astro = resolve(root, 'node_modules/.bin/astro');
  const child = spawn(astro, ['dev', '--root', 'ui', '--host', '127.0.0.1', '--port', String(UI_PORT)], {
    cwd: root,
    env: { ...process.env, FORGE_DATA_DIR: dataDir, FORGE_UI_TOKEN: token },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let opened = false;
  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    process.stdout.write(text.replaceAll(token, '<token>'));
    if (!opened && /127\.0\.0\.1:\d+/u.test(text)) {
      opened = true;
      const url = `http://127.0.0.1:${UI_PORT}/login?t=${token}`;
      if (args.includes('--no-open')) process.stdout.write('forge ui: 未自动打开浏览器（--no-open）。\n');
      else spawn('open', [url], { stdio: 'ignore' }).unref();
    }
  });
  await new Promise<void>((done) => child.on('close', () => done()));
}
