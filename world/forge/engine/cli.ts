import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatewayBackend } from './adapters/gateway.ts';
import { judgeBackend } from './adapters/judges.ts';
import { runProcess } from './adapters/process.ts';
import type { Backend } from './adapters/types.ts';
import { parseCell, type Canon } from './brief.ts';
import { familyOf, loadConfig, type ForgeConfig, type WriterSlot } from './config.ts';
import { isRecord, readString } from './json.ts';
import { runRound } from './round.ts';
import { readJson, readLines, roundPaths, sha256 } from './store.ts';
import { parseBenchmark } from './taste.ts';
import { launchUi } from './ui-launch.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '..', '..');

function fail(message: string): never {
  process.stderr.write(`forge: ${message}\n`);
  process.exit(1);
}

function option(args: readonly string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

function config(): ForgeConfig {
  const cfg = loadConfig(ROOT, { requireLocal: true });
  if (!cfg.ok) fail(cfg.error);
  return cfg.value;
}

function writerBackend(cfg: ForgeConfig, slot: WriterSlot): Backend {
  const family = familyOf(slot.model, cfg.prefixes);
  if (family === null) fail(`no family for writer model ${slot.model}; add a prefix to families.json`);
  if (cfg.local === null) fail('local.json is required');
  return gatewayBackend(slot, family, cfg.local);
}

function loadCanon(): Canon {
  const book = readFileSync(join(REPO, 'world/current/BOOK.md'), 'utf8');
  const reference = readFileSync(join(REPO, 'world/current/reference/REFERENCE.md'), 'utf8');
  return { book, reference, bookSha256: sha256(book), referenceSha256: sha256(reference) };
}

async function doctor(): Promise<void> {
  const cfg = config();
  const local = cfg.local;
  if (local === null) fail('local.json is required');
  const prompt = '这是连通性测试。只回复 OK 两个字母，不要输出任何别的内容。';
  const role = '你是连通性测试助手，不使用任何工具。';
  const backends: Backend[] = [...cfg.judges, cfg.maintainer].map((j) => judgeBackend(j, local));
  const models = new Map<string, WriterSlot>();
  for (const s of [...cfg.slots, cfg.baseline]) if (!models.has(s.model)) models.set(s.model, { ...s, id: `writer:${s.model}`, maxTokens: 2000 });
  for (const slot of models.values()) backends.push(writerBackend(cfg, slot));
  process.stdout.write(`检查 ${backends.length} 个后端（评委以最高思考档位运行，可能要一两分钟）…\n`);
  const results = await Promise.all(backends.map(async (b) => ({ b, r: await b.call(prompt, { role, timeoutMs: 600_000 }) })));
  let allOk = true;
  for (const { b, r } of results) {
    const good = r.ok && /OK/iu.test(r.text);
    allOk &&= good;
    process.stdout.write(
      `${good ? '✔' : '✖'} ${b.id.padEnd(40)} ${b.family.padEnd(10)} ${b.model.padEnd(30)} served=${r.servedModel ?? '-'} version=${r.version ?? '-'} ${(r.ms / 1000).toFixed(1)}s${good ? '' : `  ${r.error ?? `unexpected reply: ${r.text.slice(0, 80)}`}`}\n`,
    );
  }
  const host = new URL(local.gatewayBaseUrl).hostname;
  const grep = await runProcess('git', ['-C', REPO, 'grep', '-l', '-F', host], { envSet: {}, envUnset: [], cwd: REPO, stdin: null, timeoutMs: 60_000 });
  const leaked = grep.stdout.trim();
  process.stdout.write(leaked === '' ? '✔ 网关主机名未出现在任何已跟踪文件中\n' : `✖ 网关主机名出现在已跟踪文件中：\n${leaked}\n`);
  if (!allOk || leaked !== '') process.exitCode = 1;
}

async function roundRun(args: readonly string[]): Promise<void> {
  const id = args[0];
  if (id === undefined) fail('usage: forge round run <ID> --cell cells/<cell>.json [--seed <seed>]');
  const cfg = config();
  const paths = roundPaths(ROOT, id);
  const existingBrief = readJson(join(paths.dir, 'brief.json'));
  const cellArg = option(args, '--cell');
  const storedCell = isRecord(existingBrief) ? existingBrief['cell'] : null;
  if (storedCell === null && cellArg === null) fail('a new round needs --cell cells/<cell>.json');
  const cell = parseCell(storedCell ?? readJson(resolve(ROOT, cellArg ?? '')));
  if (!cell.ok) fail(cell.error);
  const bench = parseBenchmark(readJson(join(ROOT, 'benchmark/v0.json')));
  if (!bench.ok) fail(bench.error);
  const local = cfg.local;
  if (local === null) fail('local.json is required');
  const seed = readString(existingBrief, 'seed') ?? option(args, '--seed') ?? randomBytes(8).toString('hex');
  const tallies = await runRound(
    {
      root: ROOT,
      cell: cell.value,
      canon: loadCanon(),
      bench: bench.value,
      seed,
      sessionPairs: 2,
      writers: cfg.slots.map((s) => writerBackend(cfg, s)),
      baselineWriter: writerBackend(cfg, cfg.baseline),
      judges: cfg.judges.map((j) => ({ backend: judgeBackend(j, local), concurrency: j.concurrency })),
      judgeTimeoutMs: cfg.judgeTimeoutMs,
      writerTimeoutMs: cfg.writerTimeoutMs,
      log: (m) => process.stdout.write(`${m}\n`),
    },
    id,
  );
  for (const t of tallies) {
    process.stdout.write(`${t.label}（${t.submission}）：${t.tally.totalWins}/${t.tally.needed} ${t.tally.trial ? '试验对' : t.tally.beatsChampion ? '胜擂' : '未胜擂'}；有效家族 ${t.tally.eligible.join('、')}\n`);
  }
}

function roundStatus(args: readonly string[]): void {
  const id = args[0];
  if (id === undefined) fail('usage: forge round status <ID>');
  const events = readLines(roundPaths(ROOT, id).progress);
  const last = new Map<string, string>();
  let errors = 0;
  let judged = 0;
  for (const e of events) {
    const step = readString(e, 'step') ?? '?';
    const status = readString(e, 'status') ?? '?';
    if (status === 'error') errors += 1;
    if (step === 'taste' && status === 'info') judged += 1;
    last.set(step, `${status} ${readString(e, 'detail') ?? ''}`);
  }
  for (const [step, s] of last) process.stdout.write(`${step.padEnd(10)} ${s}\n`);
  process.stdout.write(`已完成评委调用 ${judged}，错误事件 ${errors}\n`);
}

async function main(): Promise<void> {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  if (cmd === 'doctor') return doctor();
  if (cmd === 'round' && sub === 'run') return roundRun(rest);
  if (cmd === 'round' && sub === 'status') return roundStatus(rest);
  if (cmd === 'ui') return launchUi(ROOT, [sub, ...rest].filter((s): s is string => s !== undefined));
  fail('usage: forge doctor | forge round run <ID> --cell <file> | forge round status <ID> | forge ui');
}

await main();
