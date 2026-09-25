import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JudgeSpec, LocalConfig } from '../config.ts';
import { isRecord, readBoolean, readNumber, readRecord, readString } from '../json.ts';
import { runProcess } from './process.ts';
import { checkServed } from './served.ts';
import { failure, type Backend, type CallOptions, type CallResult, type Invocation } from './types.ts';

const CODEX_DISABLED_FEATURES = [
  'hooks', 'apps', 'plugins', 'memories', 'chronicle', 'multi_agent', 'shell_tool',
  'unified_exec', 'browser_use', 'computer_use', 'image_generation', 'goals',
];
const GROK_DISALLOWED = 'Agent,run_terminal_cmd,run_terminal_command,todo_write,enter_plan_mode,exit_plan_mode,ask_user_question,send_feedback';

export function codexInvocation(o: { binary: string; model: string; effort: string; codexHome: string; outFile: string }): Invocation {
  const args = [
    'exec', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '-s', 'read-only',
    '-m', o.model, '-c', `model_reasoning_effort=${o.effort}`, '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"',
  ];
  for (const f of CODEX_DISABLED_FEATURES) args.push('--disable', f);
  args.push('--color', 'never', '-o', o.outFile, '-');
  return { cmd: o.binary, args, envSet: { CODEX_HOME: o.codexHome, CMUX_CODEX_HOOKS_DISABLED: '1' }, envUnset: [] };
}

export function claudeInvocation(o: { binary: string; model: string; effort: string; role: string; prompt: string }): Invocation {
  return {
    cmd: o.binary,
    args: [
      '-p', o.prompt, '--model', o.model, '--effort', o.effort, '--tools', '', '--setting-sources', '',
      '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--max-turns', '1',
      '--system-prompt', o.role, '--output-format', 'json',
    ],
    envSet: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' },
    envUnset: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'],
  };
}

export function kimiInvocation(o: { binary: string; model: string; effort: string; agentFile: string; skillsDir: string; kimiHome: string; prompt: string }): Invocation {
  return {
    cmd: o.binary,
    args: ['-m', o.model, '--agent-file', o.agentFile, '--skills-dir', o.skillsDir, '--output-format', 'text', '-p', o.prompt],
    envSet: { KIMI_CODE_HOME: o.kimiHome, KIMI_MODEL_THINKING_EFFORT: o.effort },
    envUnset: [],
  };
}

export function grokInvocation(o: { binary: string; model: string; effort: string; promptFile: string }): Invocation {
  const envSet: Record<string, string> = { GROK_MEMORY: '0' };
  for (const src of ['CLAUDE', 'CURSOR']) {
    for (const kind of ['AGENTS', 'RULES', 'SKILLS', 'MCPS', 'HOOKS']) envSet[`GROK_${src}_${kind}_ENABLED`] = '0';
  }
  return {
    cmd: o.binary,
    args: [
      '--prompt-file', o.promptFile, '-m', o.model, '--reasoning-effort', o.effort, '--tools', 'none',
      '--disallowed-tools', GROK_DISALLOWED, '--no-subagents', '--disable-web-search', '--no-plan', '--max-turns', '1',
      '--output-format', 'json',
    ],
    envSet,
    envUnset: [],
  };
}

export interface ParsedOutput {
  text: string;
  servedModel: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  error: string | null;
}

/**
 * A CLI may list auxiliary models next to the one that answered. The accepted entry is the served model; without
 * one the first entry is kept, so the served-model check voids the call and the record shows what answered.
 */
function servedFrom(modelUsage: unknown, accepted: readonly string[]): string | null {
  if (!isRecord(modelUsage)) return null;
  const keys = Object.keys(modelUsage);
  return keys.find((k) => accepted.includes(k)) ?? keys[0] ?? null;
}

function parseJson(stdout: string): unknown {
  try {
    const v: unknown = JSON.parse(stdout);
    return v;
  } catch {
    return null;
  }
}

export function parseClaudeJson(stdout: string, accepted: readonly string[] = []): ParsedOutput {
  const v = parseJson(stdout);
  if (!isRecord(v)) return { text: '', servedModel: null, tokensIn: null, tokensOut: null, costUsd: null, error: 'claude output is not JSON' };
  const text = readString(v, 'result') ?? '';
  const usage = readRecord(v, 'usage');
  const isError = readBoolean(v, 'is_error') === true;
  return {
    text,
    servedModel: servedFrom(v['modelUsage'], accepted),
    tokensIn: readNumber(usage, 'input_tokens'),
    tokensOut: readNumber(usage, 'output_tokens'),
    costUsd: readNumber(v, 'total_cost_usd'),
    error: isError ? `claude reported an error: ${text.slice(0, 300)}` : text.trim() === '' ? 'empty output' : null,
  };
}

export function parseGrokJson(stdout: string, accepted: readonly string[] = []): ParsedOutput {
  const v = parseJson(stdout);
  if (!isRecord(v)) return { text: '', servedModel: null, tokensIn: null, tokensOut: null, costUsd: null, error: 'grok output is not JSON' };
  const text = readString(v, 'text') ?? '';
  const usage = readRecord(v, 'usage');
  return {
    text,
    servedModel: servedFrom(v['modelUsage'], accepted),
    tokensIn: readNumber(usage, 'input_tokens'),
    tokensOut: readNumber(usage, 'output_tokens'),
    costUsd: readNumber(v, 'total_cost_usd'),
    error: text.trim() === '' ? 'empty output' : null,
  };
}

export function stripKimiBullet(stdout: string): string {
  return stdout.replace(/^\s*•\s?/u, '').trim();
}

const versionCache = new Map<string, Promise<string | null>>();

export function cliVersion(binary: string): Promise<string | null> {
  const cached = versionCache.get(binary);
  if (cached !== undefined) return cached;
  const p = runProcess(binary, ['--version'], { envSet: {}, envUnset: [], cwd: tmpdir(), stdin: null, timeoutMs: 60_000 }).then((r) => {
    const line = `${r.stdout}\n${r.stderr}`.split('\n').map((s) => s.trim()).find((s) => /\d+\.\d+/u.test(s));
    return line ?? null;
  });
  versionCache.set(binary, p);
  return p;
}

function linkIfExists(target: string, link: string): void {
  if (existsSync(target)) symlinkSync(target, link);
}

function tail(s: string, n: number): string {
  return s.length > n ? s.slice(-n) : s;
}

async function runJudge(spec: JudgeSpec, local: LocalConfig, prompt: string, opts: CallOptions): Promise<CallResult> {
  const binary = local.binaries[spec.cli];
  const version = await cliVersion(binary);
  const base = mkdtempSync(join(tmpdir(), 'forge-judge-'));
  const cwd = join(base, 'cwd');
  mkdirSync(cwd, { mode: 0o700 });
  try {
    let inv: Invocation;
    let stdin: string | null = null;
    const outFile = join(base, 'out.txt');
    if (spec.cli === 'codex') {
      const home = join(base, 'home');
      mkdirSync(home, { mode: 0o700 });
      linkIfExists(local.codexAuth, join(home, 'auth.json'));
      inv = codexInvocation({ binary, model: spec.model, effort: spec.effort, codexHome: home, outFile });
      stdin = `${opts.role}\n\n${prompt}`;
    } else if (spec.cli === 'claude') {
      inv = claudeInvocation({ binary, model: spec.model, effort: spec.effort, role: opts.role, prompt });
    } else if (spec.cli === 'kimi') {
      const home = join(base, 'kimi-home');
      mkdirSync(home, { mode: 0o700 });
      const config = join(local.kimiHome, 'config.toml');
      if (existsSync(config)) copyFileSync(config, join(home, 'config.toml'));
      for (const name of ['credentials', 'oauth', 'device_id']) linkIfExists(join(local.kimiHome, name), join(home, name));
      const skills = join(base, 'skills');
      mkdirSync(skills);
      const agentFile = join(base, 'judge.md');
      writeFileSync(agentFile, `---\nname: judge\ndescription: Blind judge without tools\ntools: []\nsubagents: []\n---\n${opts.role}\n`);
      inv = kimiInvocation({ binary, model: spec.model, effort: spec.effort, agentFile, skillsDir: skills, kimiHome: home, prompt });
    } else {
      const promptFile = join(base, 'prompt.txt');
      writeFileSync(promptFile, `${opts.role}\n\n${prompt}`);
      inv = grokInvocation({ binary, model: spec.model, effort: spec.effort, promptFile });
    }
    const r = await runProcess(inv.cmd, inv.args, { envSet: inv.envSet, envUnset: inv.envUnset, cwd, stdin, timeoutMs: opts.timeoutMs });
    const raw = `$ ${spec.cli} (exit ${String(r.code)}, ${r.ms} ms)\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${tail(r.stderr, 20_000)}`;
    if (r.timedOut) return failure(`timeout after ${opts.timeoutMs} ms`, r.ms, raw, version);
    if (r.code !== 0) return failure(`exit ${String(r.code)}: ${tail(r.stderr || r.stdout, 400)}`, r.ms, raw, version);
    let parsed: ParsedOutput;
    if (spec.cli === 'codex') {
      const text = existsSync(outFile) ? readFileSync(outFile, 'utf8').trim() : '';
      parsed = { text, servedModel: null, tokensIn: null, tokensOut: null, costUsd: null, error: text === '' ? 'empty output' : null };
    } else if (spec.cli === 'claude') {
      parsed = parseClaudeJson(r.stdout, spec.acceptedServed);
    } else if (spec.cli === 'kimi') {
      const text = stripKimiBullet(r.stdout);
      parsed = { text, servedModel: null, tokensIn: null, tokensOut: null, costUsd: null, error: text === '' ? 'empty output' : null };
    } else {
      parsed = parseGrokJson(r.stdout, spec.acceptedServed);
    }
    if (parsed.error !== null) return failure(parsed.error, r.ms, raw, version);
    return checkServed({
      ok: true,
      text: parsed.text,
      servedModel: parsed.servedModel,
      version,
      ms: r.ms,
      tokensIn: parsed.tokensIn,
      tokensOut: parsed.tokensOut,
      costUsd: parsed.costUsd,
      error: null,
      raw,
    }, spec.acceptedServed);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

export function judgeBackend(spec: JudgeSpec, local: LocalConfig): Backend {
  return {
    id: spec.id,
    family: spec.family,
    model: spec.model,
    call: (prompt, opts) => runJudge(spec, local, prompt, opts),
  };
}
