import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isRecord, readArray, readNumber, readRecord, readString, stringArray } from './json.ts';
import { err, ok, type Result } from './result.ts';

export type Family = 'DeepSeek' | 'Anthropic' | 'OpenAI' | 'Moonshot' | 'xAI' | 'Alibaba' | 'Zhipu' | 'MiniMax';
export const FAMILIES: readonly Family[] = ['DeepSeek', 'Anthropic', 'OpenAI', 'Moonshot', 'xAI', 'Alibaba', 'Zhipu', 'MiniMax'];
export type CliKind = 'codex' | 'claude' | 'kimi' | 'grok';
export const CLI_KINDS: readonly CliKind[] = ['codex', 'claude', 'kimi', 'grok'];

export interface PrefixRule {
  prefix: string;
  family: Family;
}

export interface JudgeSpec {
  id: string;
  family: Family;
  cli: CliKind;
  model: string;
  effort: string;
  concurrency: number;
  acceptedServed: string[];
}

export interface WriterSlot {
  id: string;
  model: string;
  maxTokens: number;
  temperature: number;
}

export interface LocalConfig {
  gatewayBaseUrl: string;
  gatewayEnvFile: string;
  gatewayKeyVar: string;
  binaries: Record<CliKind, string>;
  codexAuth: string;
  kimiHome: string;
  privatePhrases: string[];
}

export interface ForgeConfig {
  root: string;
  judges: JudgeSpec[];
  maintainer: JudgeSpec;
  /** Writes the canon diff at merge time (PROTOCOL §7). */
  mergeEditor: JudgeSpec;
  judgeTimeoutMs: number;
  slots: WriterSlot[];
  baseline: WriterSlot;
  writerTimeoutMs: number;
  prefixes: PrefixRule[];
  local: LocalConfig | null;
}

export function isFamily(value: string): value is Family {
  return FAMILIES.some((f) => f === value);
}

export function isCliKind(value: string): value is CliKind {
  return CLI_KINDS.some((c) => c === value);
}

export function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

export function familyOf(model: string, prefixes: readonly PrefixRule[]): Family | null {
  let best: PrefixRule | null = null;
  for (const rule of prefixes) {
    if (model.startsWith(rule.prefix) && (best === null || rule.prefix.length > best.prefix.length)) best = rule;
  }
  return best === null ? null : best.family;
}

function readJsonFile(root: string, name: string): Result<unknown> {
  const path = join(root, name);
  if (!existsSync(path)) return err(`${name} not found in ${root}`);
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return ok(parsed);
  } catch (e) {
    return err(`${name} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function parseJudge(value: unknown, where: string): Result<JudgeSpec> {
  const id = readString(value, 'id');
  const family = readString(value, 'family');
  const cli = readString(value, 'cli');
  const model = readString(value, 'model');
  const effort = readString(value, 'effort');
  const concurrency = readNumber(value, 'concurrency');
  const accepted = stringArray(isRecord(value) ? value['accepted_served'] : null);
  if (id === null || model === null || effort === null) return err(`${where}: id, model and effort are required strings`);
  if (family === null || !isFamily(family)) return err(`${where}: unknown family ${String(family)}`);
  if (cli === null || !isCliKind(cli)) return err(`${where}: unknown cli ${String(cli)}`);
  if (concurrency === null || concurrency < 1) return err(`${where}: concurrency must be ≥ 1`);
  if (accepted === null) return err(`${where}: accepted_served must be a string array`);
  return ok({ id, family, cli, model, effort, concurrency, acceptedServed: accepted });
}

function parseSlot(value: unknown, where: string): Result<WriterSlot> {
  const id = readString(value, 'id');
  const model = readString(value, 'model');
  const maxTokens = readNumber(value, 'max_tokens');
  const temperature = readNumber(value, 'temperature');
  if (id === null || model === null || maxTokens === null || temperature === null) {
    return err(`${where}: id, model, max_tokens and temperature are required`);
  }
  return ok({ id, model, maxTokens, temperature });
}

function parseLocal(value: unknown): Result<LocalConfig> {
  const gateway = readRecord(value, 'gateway');
  const binaries = readRecord(value, 'binaries');
  const baseUrl = readString(gateway, 'base_url');
  const envFile = readString(gateway, 'env_file');
  const keyVar = readString(gateway, 'key_var');
  const codexAuth = readString(value, 'codex_auth');
  const kimiHome = readString(value, 'kimi_home');
  const phrases = stringArray(isRecord(value) ? value['private_phrases'] : null);
  if (baseUrl === null || envFile === null || keyVar === null) return err('local.json: gateway.base_url, env_file and key_var are required');
  if (codexAuth === null || kimiHome === null || phrases === null) return err('local.json: codex_auth, kimi_home and private_phrases are required');
  const bin: Record<CliKind, string> = { codex: 'codex', claude: 'claude', kimi: 'kimi', grok: 'grok' };
  for (const kind of CLI_KINDS) {
    const v = readString(binaries, kind);
    if (v !== null) bin[kind] = expandHome(v);
  }
  return ok({
    gatewayBaseUrl: baseUrl.replace(/\/+$/u, ''),
    gatewayEnvFile: expandHome(envFile),
    gatewayKeyVar: keyVar,
    binaries: bin,
    codexAuth: expandHome(codexAuth),
    kimiHome: expandHome(kimiHome),
    privatePhrases: phrases,
  });
}

export function loadConfig(root: string, opts: { requireLocal: boolean }): Result<ForgeConfig> {
  const judgesRaw = readJsonFile(root, 'judges.json');
  if (!judgesRaw.ok) return judgesRaw;
  const writersRaw = readJsonFile(root, 'writers.json');
  if (!writersRaw.ok) return writersRaw;
  const familiesRaw = readJsonFile(root, 'families.json');
  if (!familiesRaw.ok) return familiesRaw;

  const judgeList = readArray(judgesRaw.value, 'judges');
  const judgeTimeoutMs = readNumber(judgesRaw.value, 'timeout_ms');
  if (judgeList === null || judgeTimeoutMs === null) return err('judges.json: judges[] and timeout_ms are required');
  const judges: JudgeSpec[] = [];
  for (const [i, j] of judgeList.entries()) {
    const parsed = parseJudge(j, `judges.json judges[${i}]`);
    if (!parsed.ok) return parsed;
    judges.push(parsed.value);
  }
  const maintainer = parseJudge(readRecord(judgesRaw.value, 'maintainer'), 'judges.json maintainer');
  if (!maintainer.ok) return maintainer;
  const mergeEditor = parseJudge(readRecord(judgesRaw.value, 'merge_editor'), 'judges.json merge_editor');
  if (!mergeEditor.ok) return mergeEditor;

  const slotList = readArray(writersRaw.value, 'slots');
  const writerTimeoutMs = readNumber(writersRaw.value, 'timeout_ms');
  if (slotList === null || writerTimeoutMs === null) return err('writers.json: slots[] and timeout_ms are required');
  const slots: WriterSlot[] = [];
  for (const [i, s] of slotList.entries()) {
    const parsed = parseSlot(s, `writers.json slots[${i}]`);
    if (!parsed.ok) return parsed;
    slots.push(parsed.value);
  }
  const baseline = parseSlot(readRecord(writersRaw.value, 'baseline'), 'writers.json baseline');
  if (!baseline.ok) return baseline;

  const prefixList = readArray(familiesRaw.value, 'prefixes');
  if (prefixList === null) return err('families.json: prefixes[] is required');
  const prefixes: PrefixRule[] = [];
  for (const p of prefixList) {
    const prefix = readString(p, 'prefix');
    const family = readString(p, 'family');
    if (prefix === null || family === null || !isFamily(family)) return err(`families.json: bad entry ${JSON.stringify(p)}`);
    prefixes.push({ prefix, family });
  }

  let local: LocalConfig | null = null;
  if (existsSync(join(root, 'local.json')) || opts.requireLocal) {
    const localRaw = readJsonFile(root, 'local.json');
    if (!localRaw.ok) return localRaw;
    const parsed = parseLocal(localRaw.value);
    if (!parsed.ok) return parsed;
    local = parsed.value;
  }

  return ok({
    root,
    judges,
    maintainer: maintainer.value,
    mergeEditor: mergeEditor.value,
    judgeTimeoutMs,
    slots,
    baseline: baseline.value,
    writerTimeoutMs,
    prefixes,
    local,
  });
}
