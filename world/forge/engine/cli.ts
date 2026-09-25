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
import { canarySummary, mergeCanaryResults, runCanary, type CanaryRun } from './canary.ts';
import { parsePrices, withPrices, type Prices } from './cost.ts';
import { canonFiles, factRowsFrom, parseRegister07 } from './inputs.ts';
import { prototypeRoundRefusal, runPrototypeRound } from './prototype.ts';
import { calibCommand } from './cli-calib.ts';
import { mergeCommand, mergecheckCommand, mirrorCommand, postMergeCommand } from './cli-merge.ts';
import { freezeCommand, productionDeps, roundCommand, type ForgeRoots } from './cli-round.ts';
import type { EngineDeps } from './context.ts';
import { benchContext, findBenchmark, loadProtocolBundle, parseRollbacks, roundRules, type ProtocolBundle } from './rules.ts';
import { readJson, readLines, roundPaths, sha256, writeJson, writeText } from './store.ts';
import { parseBenchmark } from './taste.ts';
import { checkTags, computeThinmap, DEFAULT_GAME_NEED, formatThinmap, parseAliases, parseGameNeed, parseRows, type Alias, type Row } from './thinmap.ts';
import { gitPort } from './ports-cli.ts';
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
  const results = await Promise.all(backends.map(async (b) => ({ b, r: await b.call(prompt, { role, timeoutMs: 600_000, taskId: `doctor-${b.id}`, attempt: 1 }) })));
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
  if (id === undefined) fail('usage: forge round run <P-ID> --cell cells/<cell>.json [--seed <seed>]');
  const refusal = prototypeRoundRefusal(ROOT, id);
  if (refusal !== null) fail(refusal);
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
  const tallies = await runPrototypeRound(
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
  if (id === undefined) fail('usage: forge round status <P-ID>');
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
  let run: CanaryRun;
  try {
    run = await runCanary(specs.map((j) => judge(j, local)), {
      dir: join(ROOT, '.sealed', 'canary'),
      protocolText: readText(join(ROOT, 'PROTOCOL.md')),
      privatePhrases: local.privatePhrases,
      timeoutMs: cfg.judgeTimeoutMs,
      log: (m) => process.stdout.write(`${m}\n`),
      onOutput: (id, r) => writeText(join(ROOT, '.runs', 'canary', `${id}.txt`), `${r.raw}\n\n=== text ===\n${r.text}\n`),
    });
  } catch (e) {
    fail(`canary could not run: ${e instanceof Error ? e.message : String(e)}`);
  }
  const resultsPath = join(ROOT, 'canary', 'results.json');
  const merged = mergeCanaryResults(readJson(resultsPath), run, new Date().toISOString());
  writeJson(resultsPath, merged);
  process.stdout.write(`${canarySummary(run, merged)}；原始输出在 .runs/canary/\n`);
  if (!run.pass) process.exitCode = 1;
}

const ROOTS: ForgeRoots = { root: ROOT, repo: REPO };

/** P01-style ids run on the prototype runner (P01 is frozen); R rounds run on the step machine. */
function isPrototypeRound(id: string | undefined): boolean {
  return id !== undefined && /^P\d{2}$/u.test(id);
}

async function engineCommand(run: (deps: EngineDeps) => Promise<number>): Promise<void> {
  const deps = productionDeps(ROOT, REPO);
  if (!deps.ok) fail(deps.error);
  process.exitCode = await run(deps.value);
}

async function main(): Promise<void> {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  const args = [sub, ...rest].filter((s): s is string => s !== undefined);
  if (cmd === 'doctor') return doctor();
  if (cmd === 'canary') return canary(args);
  if (cmd === 'round' && sub === 'run' && isPrototypeRound(rest[0])) return roundRun(rest);
  if (cmd === 'round' && sub === 'status' && isPrototypeRound(rest[0])) return roundStatus(rest);
  if (cmd === 'round') return engineCommand((deps) => roundCommand(args, deps, ROOTS));
  if (cmd === 'freeze' && args.includes('--post-merge')) return engineCommand((deps) => postMergeCommand(args, deps, ROOTS));
  if (cmd === 'freeze') return engineCommand((deps) => freezeCommand(args, deps, ROOTS));
  if (cmd === 'merge') return engineCommand((deps) => mergeCommand(args, deps, ROOTS));
  if (cmd === 'mirror') return engineCommand((deps) => mirrorCommand(args, deps, ROOTS));
  if (cmd === 'calib') return engineCommand((deps) => calibCommand(args, deps, ROOTS));
  if (cmd === 'protocol' && sub === 'hash') return protocolHash();
  if (cmd === 'bench' && sub === 'validate') return benchValidate(rest);
  if (cmd === 'thinmap') return thinmap(args);
  if (cmd === 'mergecheck') {
    process.exitCode = await mergecheckCommand(args, ROOTS, gitPort(REPO, runProcess), {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    });
    return;
  }
  if (cmd === 'ui') return launchUi(ROOT, args);
  fail(
    [
      'usage:',
      '  forge doctor',
      '  forge canary [--only <id,...>]',
      '  forge round start <RNN> [--cell <file>] [--seed <hex>] [--quota-budget-min <n>]',
      '  forge round run <RNN> [--until|--from|--redo-from <step>] [--quota-budget-min <n>]',
      '  forge round status <RNN> [--json] [--verify]',
      '  forge round run <P-ID> --cell <file> [--seed <seed>] [--benchmark <file>]   (prototype runner)',
      '  forge round status <P-ID>',
      '  forge freeze --check [RNN]',
      '  forge merge <RNN> [--quota-budget-min <n>]',
      '  forge freeze --post-merge [RNN] [--check]',
      '  forge mirror [--round <RNN>] [--dry-run]',
      '  forge calib build [--requal <Family> --reason calibration_fail|suspension | --gate <Family>] [--quota-budget-min <n>]',
      '  forge calib run [--set <id>] [--only <c2-gate-dryrun|c3-owner-answers|c4-judge>] [--quota-budget-min <n>]',
      '  forge calib score [--set <id>]',
      '  forge protocol hash',
      '  forge bench validate <candidate.json> [--parent <parent.json>] [--round <n>] [--rollbacks <file>]',
      '  forge thinmap [--top <n>] [--aliases <file>] [--tags <file>] [--game-need <file>]',
      '  forge mergecheck --decision <merge-decision.json> [--base <git-ref>]',
      '  forge ui',
    ].join('\n'),
  );
}

await main();
