import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatewayBackend } from './adapters/gateway.ts';
import { judgeBackend } from './adapters/judges.ts';
import { runProcess } from './adapters/process.ts';
import type { Backend } from './adapters/types.ts';
import { parseCell, type Canon } from './brief.ts';
import { familyOf, loadConfig, type ForgeConfig, type JudgeSpec, type LocalConfig, type WriterSlot } from './config.ts';
import { isRecord, readString } from './json.ts';
import { validateBenchmark } from './bench-validate.ts';
import { mergeCanaryResults, runCanary } from './canary.ts';
import { parsePrices, withPrices, type Prices } from './cost.ts';
import { canonFiles, factRowsFrom, parseMergeDecision, parseRegister07, sourcesFromRound } from './inputs.ts';
import { mergecheck } from './mergecheck.ts';
import { runRound } from './round.ts';
import { benchContext, findBenchmark, loadProtocolBundle, parseRollbacks, roundRules, type ProtocolBundle } from './rules.ts';
import { readJson, readLines, roundPaths, sha256, writeJson, writeText } from './store.ts';
import { parseBenchmark } from './taste.ts';
import { checkTags, computeThinmap, DEFAULT_GAME_NEED, formatThinmap, parseAliases, parseGameNeed, parseRows, type Alias, type Row } from './thinmap.ts';
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

function protocolBundle(): ProtocolBundle {
  const bundle = loadProtocolBundle(ROOT);
  if (!bundle.ok) fail(bundle.error);
  return bundle.value;
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    return fail(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function parseJsonText(text: string, path: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch (e) {
    return fail(`${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function prices(): Prices {
  const p = parsePrices(jsonFile(join(ROOT, 'prices.json')));
  if (!p.ok) fail(p.error);
  return p.value;
}

function judge(spec: JudgeSpec, local: LocalConfig): Backend {
  return withPrices(judgeBackend(spec, local), prices());
}

function writerBackend(cfg: ForgeConfig, slot: WriterSlot): Backend {
  const family = familyOf(slot.model, cfg.prefixes);
  if (family === null) fail(`no family for writer model ${slot.model}; add a prefix to families.json`);
  if (cfg.local === null) fail('local.json is required');
  return withPrices(gatewayBackend(slot, family, cfg.local), prices());
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
  const backends: Backend[] = [...cfg.judges, cfg.maintainer].map((j) => judge(j, local));
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
  const bundle = protocolBundle();
  const benchPath = resolve(ROOT, option(args, '--benchmark') ?? 'benchmark/v0.json');
  const benchText = readText(benchPath);
  const benchRaw = parseJsonText(benchText, benchPath);
  const bench = parseBenchmark(benchRaw);
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
      sessionPairs: bundle.protocol.bars.sessionPairs,
      writers: cfg.slots.map((s) => writerBackend(cfg, s)),
      baselineWriter: writerBackend(cfg, cfg.baseline),
      judges: cfg.judges.map((j) => ({ backend: judge(j, local), concurrency: j.concurrency })),
      judgeTimeoutMs: cfg.judgeTimeoutMs,
      writerTimeoutMs: cfg.writerTimeoutMs,
      rules: roundRules(bundle.protocol, benchRaw),
      pins: { benchmarkText: benchText, writersText: readText(join(ROOT, 'writers.json')), protocolBundleSha256: bundle.bundleSha256 },
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

function protocolHash(): void {
  const bundle = protocolBundle();
  process.stdout.write(`Protocol version: ${bundle.protocol.version}\nbundle sha256: ${bundle.bundleSha256}\n`);
}

function benchValidate(args: readonly string[]): void {
  const candidatePath = args[0];
  if (candidatePath === undefined) fail('usage: forge bench validate <candidate.json> [--parent <parent.json>] [--round <n>] [--rollbacks <file>]');
  const bundle = protocolBundle();
  const candidateFile = resolve(process.cwd(), candidatePath);
  const candidate = parseJsonText(readText(candidateFile), candidateFile);
  const parentArg = option(args, '--parent');
  const namedParent = readString(candidate, 'parent');
  let parent: unknown = null;
  if (parentArg !== null) {
    const parentFile = resolve(process.cwd(), parentArg);
    parent = parseJsonText(readText(parentFile), parentFile);
  } else if (namedParent !== null) {
    const found = findBenchmark(ROOT, namedParent);
    if (!found.ok) fail(`candidate names parent ${namedParent}: ${found.error}`);
    process.stderr.write(`parent ${namedParent}: ${found.value.path}\n`);
    parent = found.value.value;
  }
  const roundArg = option(args, '--round') ?? '0';
  const round = Number(roundArg);
  if (!Number.isInteger(round) || round < 0) fail(`--round must be a non-negative integer, got ${roundArg}`);
  const rollbacksArg = option(args, '--rollbacks');
  const rollbacks = rollbacksArg === null ? null : parseRollbacks(jsonFile(resolve(process.cwd(), rollbacksArg)));
  if (rollbacks !== null && !rollbacks.ok) fail(rollbacks.error);
  const ctx = benchContext(ROOT, bundle.protocol, round, rollbacks === null ? [] : rollbacks.value);
  if (!ctx.ok) fail(ctx.error);
  const v = validateBenchmark(candidate, parent, ctx.value);
  process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
  if (!v.ok) process.exitCode = 1;
}

function jsonFile(path: string): unknown {
  return parseJsonText(readText(path), path);
}

function mapRows(aliasesArg: string | null = null): { rows: Row[]; aliases: Alias[]; rowIds: string[] } {
  const rows = parseRows(jsonFile(join(ROOT, 'map/rows.json')));
  if (!rows.ok) fail(rows.error);
  const aliasesPath = aliasesArg === null ? join(ROOT, 'map/aliases.json') : resolve(process.cwd(), aliasesArg);
  if (aliasesArg !== null && !existsSync(aliasesPath)) fail(`no such file ${aliasesPath}`);
  const aliases = existsSync(aliasesPath) ? parseAliases(jsonFile(aliasesPath)) : null;
  if (aliases !== null && !aliases.ok) fail(aliases.error);
  const aliasList = aliases === null ? [] : aliases.value;
  const characters = aliasList.filter((a) => a.kind === 'character').map((a) => a.row_id);
  return { rows: rows.value, aliases: aliasList, rowIds: [...rows.value.map((r) => r.row_id), ...characters] };
}

function thinmap(args: readonly string[]): void {
  const { rows, aliases, rowIds } = mapRows(option(args, '--aliases'));
  const tagsArg = option(args, '--tags');
  const tagsPath = tagsArg === null ? join(ROOT, 'map/tags.json') : resolve(process.cwd(), tagsArg);
  if (tagsArg !== null && !existsSync(tagsPath)) fail(`no such file ${tagsPath}`);
  const tagged = existsSync(tagsPath);
  const tags = tagged ? jsonFile(tagsPath) : { cells: {} };
  for (const problem of checkTags(tags, rowIds)) process.stderr.write(`${tagsPath}: ${problem}\n`);
  const needArg = option(args, '--game-need');
  const needPath = needArg === null ? join(ROOT, 'map/game-need.json') : resolve(process.cwd(), needArg);
  if (needArg !== null && !existsSync(needPath)) fail(`no such file ${needPath}`);
  const need = existsSync(needPath) ? parseGameNeed(jsonFile(needPath)) : null;
  if (need !== null && !need.ok) fail(need.error);
  const factRows = factRowsFrom(jsonFile(join(ROOT, 'fact-status.json')));
  if (!factRows.ok) fail(factRows.error);
  const canon = canonFiles(REPO);
  const topArg = option(args, '--top') ?? '20';
  const top = Number(topArg);
  if (!Number.isInteger(top) || top < 1) fail(`--top must be a positive integer, got ${topArg}`);
  const result = computeThinmap({
    rows,
    aliases,
    tags,
    canon,
    registered: parseRegister07(canon['reference/07-register-and-creation.md'] ?? ''),
    factRows: factRows.value,
    gameNeed: need === null ? DEFAULT_GAME_NEED : need.value,
    mentions: {},
  });
  if (!tagged) process.stdout.write('注意：map/tags.json 尚未标注（F1-05），所有格值为 0，排序只反映游戏需求权重。\n');
  process.stdout.write(`${formatThinmap(result, top)}\n`);
}

function git(args: readonly string[]): string | null {
  try {
    return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** Files `assemble_reference.py` regenerates during a merge; checked by reproducing them, not by mergecheck. */
const ASSEMBLER_OUTPUTS: readonly string[] = ['reference/REFERENCE.md', 'reference/hashes.json', 'reference/manifest.json'];

function mergeCheck(args: readonly string[]): void {
  const decisionArg = option(args, '--decision');
  if (decisionArg === null) fail('usage: forge mergecheck --decision <merge-decision.json> [--base <git-ref>]');
  const decision = parseMergeDecision(jsonFile(resolve(process.cwd(), decisionArg)));
  if (!decision.ok) fail(decision.error);
  const base = option(args, '--base') ?? 'main';
  if (git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]) === null) fail(`unknown git ref ${base}`);
  const sources = sourcesFromRound(ROOT, decision.value.round);
  if (!sources.ok) fail(sources.error);
  const merge = protocolBundle().protocol;
  // Every canon Markdown file goes to mergecheck, which fails any change outside 09, 07 and 01–06.
  const after = canonFiles(REPO);
  const before: Record<string, string> = {};
  for (const key of new Set([...Object.keys(after), 'reference/09-scenes-and-people.md'])) {
    before[key] = git(['show', `${base}:world/current/${key}`]) ?? '';
  }
  // Paths mergecheck does not see (deleted files, subfolders, non-Markdown) may only be the assembler's outputs.
  const changedTracked = git(['diff', '--name-only', base, '--', 'world/current']);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', 'world/current']);
  if (changedTracked === null || untracked === null) fail('cannot list changed files under world/current');
  const outside = [...changedTracked.split('\n'), ...untracked.split('\n')]
    .filter((line) => line.startsWith('world/current/'))
    .map((line) => line.slice('world/current/'.length))
    .filter((key) => !(key in before) && !ASSEMBLER_OUTPUTS.includes(key));
  const result = mergecheck({
    constants: { ...merge.merge, connectives: merge.connectives },
    rowIds: mapRows().rowIds,
    decision: decision.value,
    sources: sources.value,
    before,
    after,
  });
  const violations = [...result.violations, ...[...new Set(outside)].sort().map((key) => `unexpected change: ${key}`)];
  const passed = result.ok && violations.length === 0;
  process.stdout.write(passed ? `mergecheck 通过（对照 ${base}）\n` : `mergecheck 未通过（对照 ${base}）：\n${violations.map((v) => `- ${v}`).join('\n')}\n`);
  if (!passed) process.exitCode = 1;
}

async function canary(args: readonly string[]): Promise<void> {
  const cfg = config();
  const local = cfg.local;
  if (local === null) fail('local.json is required');
  const only = option(args, '--only');
  const wanted = only === null ? null : only.split(',').map((s) => s.trim());
  const specs = [...cfg.judges, cfg.maintainer].filter((j) => wanted === null || wanted.includes(j.id));
  if (specs.length === 0) fail(`no adapter matches --only ${only ?? ''}`);
  if (local.privatePhrases.length === 0) process.stderr.write('注意：local.json 的 private_phrases 为空，只检查 canary 令牌。\n');
  process.stdout.write(`canary：${specs.map((j) => j.id).join('、')}（评委以最高思考档位运行，可能要几分钟）…\n`);
  const run = await runCanary(specs.map((j) => judge(j, local)), {
    dir: join(ROOT, '.sealed', 'canary'),
    protocolText: readText(join(ROOT, 'PROTOCOL.md')),
    privatePhrases: local.privatePhrases,
    timeoutMs: cfg.judgeTimeoutMs,
    log: (m) => process.stdout.write(`${m}\n`),
    onOutput: (id, r) => writeText(join(ROOT, '.runs', 'canary', `${id}.txt`), `${r.raw}\n\n=== text ===\n${r.text}\n`),
  });
  const resultsPath = join(ROOT, 'canary', 'results.json');
  writeJson(resultsPath, mergeCanaryResults(readJson(resultsPath), run, new Date().toISOString()));
  process.stdout.write(`${run.pass ? '全部通过' : '有适配器未通过'}，结果写入 canary/results.json；原始输出在 .runs/canary/\n`);
  if (!run.pass) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  if (cmd === 'doctor') return doctor();
  if (cmd === 'canary') return canary([sub, ...rest].filter((s): s is string => s !== undefined));
  if (cmd === 'round' && sub === 'run') return roundRun(rest);
  if (cmd === 'round' && sub === 'status') return roundStatus(rest);
  if (cmd === 'protocol' && sub === 'hash') return protocolHash();
  if (cmd === 'bench' && sub === 'validate') return benchValidate(rest);
  if (cmd === 'thinmap') return thinmap([sub, ...rest].filter((s): s is string => s !== undefined));
  if (cmd === 'mergecheck') return mergeCheck([sub, ...rest].filter((s): s is string => s !== undefined));
  if (cmd === 'ui') return launchUi(ROOT, [sub, ...rest].filter((s): s is string => s !== undefined));
  fail(
    [
      'usage:',
      '  forge doctor',
      '  forge canary [--only <id,...>]',
      '  forge round run <ID> --cell <file> [--seed <seed>] [--benchmark <file>]',
      '  forge round status <ID>',
      '  forge protocol hash',
      '  forge bench validate <candidate.json> [--parent <parent.json>] [--round <n>] [--rollbacks <file>]',
      '  forge thinmap [--top <n>] [--aliases <file>] [--tags <file>] [--game-need <file>]',
      '  forge mergecheck --decision <merge-decision.json> [--base <git-ref>]',
      '  forge ui',
    ].join('\n'),
  );
}

await main();
