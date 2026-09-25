import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FakeReply } from '../adapters/fake.ts';
import { loadConfig, type Family } from '../config.ts';
import { buildContext, type RoundBackends, type StepContext } from '../context.ts';
import { buildFreeze } from '../freeze.ts';
import { isRecord, stringArray } from '../json.ts';
import { sha256Bytes, writeMarker } from '../marker.ts';
import type { Assembler } from '../ports.ts';
import { err, ok, type Result } from '../result.ts';
import { runSteps, type RunReport, type StepDef, type StepId } from '../runner.ts';
import type { BriefJson } from '../steps/brief.ts';
import { applyStep, mergeCommitStep, mergeEditStep, postMergeFreezeStep, postMergeGateStep, regateStep } from '../steps/merge.ts';
import { decisionStep } from '../steps/owner-waits.ts';
import { roundPaths } from '../store.ts';
import { unwrap } from '../tasks/fenced.ts';
import type { DecisionInput } from '../../ui/src/lib/owner.ts';
import { fakePorts, type FakePorts } from './fakes.ts';
import { assembleFixtureReference, DEFAULT_FIXTURE, FIXTURE_AT, fixtureWorld, type FixtureWorld } from './fixture-world.ts';
import { ownerSim, type OwnerSim } from './owner-sim.ts';
import { fakeRouter, type FakeRouter, type Route } from './scripted.ts';

/**
 * TS reimplementation of world/current/reference/assemble_reference.py for temp repos (PR-D group D1): reads
 * `reference/manifest.json`, refuses a revision it does not declare, writes only REFERENCE.md and hashes.json
 * (same bytes as fixture-world.ts assembleFixtureReference). Faults simulate a misbehaving assembler.
 *
 * The fixture canon joins the manifest files with one blank line; the Python tool on the real canon demotes
 * headings and separates files with `---`. Only the fixture layout is reproduced here (the fixture's committed
 * REFERENCE.md was made by assembleFixtureReference), with the Python tool's manifest checks and refusal.
 */

export interface FakeAssemblerFaults {
  /** hashes.json base_book_sha256 written as a wrong value (10c must restore and fail). */
  alterBaseBookSha256: boolean;
  /** Extra world/current-relative files written besides the two outputs (10c's changedPaths check). */
  alsoWrite: Readonly<Record<string, string>>;
}

export const NO_ASSEMBLER_FAULTS: FakeAssemblerFaults = { alterBaseBookSha256: false, alsoWrite: {} };

export interface FakeAssembler extends Assembler {
  /** Revisions passed to assemble(), in call order. */
  revisions(): string[];
}

/** base_book_sha256 written under the `alterBaseBookSha256` fault. */
const ALTERED_BOOK_SHA256 = createHash('sha256').update('fake assembler: altered base book').digest('hex');

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The Python tool's manifest checks: non-empty revision, header lines, unique source `.md` names in reference/. */
function manifestRevision(currentDir: string): Result<string> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(currentDir, 'reference', 'manifest.json'), 'utf8'));
  } catch (e) {
    return err(`manifest.json: ${message(e)}`);
  }
  if (!isRecord(raw)) return err('manifest.json: not an object');
  const revision = raw['revision'];
  if (typeof revision !== 'string' || revision === '') return err("manifest.json: 'revision' must be a non-empty string");
  if (stringArray(raw['header']) === null) return err("manifest.json: 'header' must be a list of lines");
  const files = stringArray(raw['files']);
  const valid = (name: string): boolean => name !== '' && !name.includes('/') && name.endsWith('.md') && name !== 'REFERENCE.md';
  if (files === null || files.length === 0 || new Set(files).size !== files.length || !files.every(valid)) {
    return err("manifest.json: 'files' must list unique source .md names in this directory");
  }
  return ok(revision);
}

function writeUnder(currentDir: string, rel: string, text: string): void {
  const path = join(currentDir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export function fakeAssembler(repoDir: string, faults: FakeAssemblerFaults = NO_ASSEMBLER_FAULTS): FakeAssembler {
  const calls: string[] = [];
  const currentDir = join(repoDir, 'world', 'current');
  return {
    assemble: (revision) => {
      calls.push(revision);
      const declared = manifestRevision(currentDir);
      if (!declared.ok) return Promise.resolve(err(declared.error));
      if (declared.value !== revision) return Promise.resolve(err(`--revision ${revision} does not match manifest revision ${declared.value}`));
      let assembled: ReturnType<typeof assembleFixtureReference>;
      try {
        assembled = assembleFixtureReference(currentDir);
      } catch (e) {
        return Promise.resolve(err(`assembler: ${message(e)}`));
      }
      const hashes = faults.alterBaseBookSha256 ? { ...assembled.hashes, base_book_sha256: ALTERED_BOOK_SHA256 } : assembled.hashes;
      writeUnder(currentDir, 'reference/REFERENCE.md', assembled.reference);
      writeUnder(currentDir, 'reference/hashes.json', `${JSON.stringify(hashes, null, 2)}\n`);
      for (const [rel, text] of Object.entries(faults.alsoWrite)) writeUnder(currentDir, rel, text);
      const referenceBookSha256 = createHash('sha256').update(assembled.reference, 'utf8').digest('hex');
      return Promise.resolve(ok({ referenceBookSha256, characters: [...assembled.reference].length }));
    },
    revisions: () => [...calls],
  };
}

// ---- merge round harness (steps 09b–10f on a fixture world; tests of engine/merge*.ts and steps/merge*.ts) ----

export const MERGE_ROUND = 'R01';
export const MERGE_BRANCH = 'forge/r01';
export const MERGE_ISSUE = 7;
export const MERGE_JUDGES: readonly Family[] = ['Anthropic', 'Moonshot', 'OpenAI', 'xAI'];
/** 09b–10f, the steps the harness runs (09b pins the decision the merge steps read). */
export const MERGE_STEPS: readonly StepDef[] = [decisionStep, regateStep, mergeEditStep, applyStep, postMergeFreezeStep, postMergeGateStep, mergeCommitStep];

interface HarnessClaim {
  id: string;
  claim: string;
  status: string;
  row_id: string;
  attaches_to: string;
  extends: string;
  misuse: string;
  source_quote: string;
}

function claim(id: string, text: string, quote: string, attachesTo: string, extra: Partial<HarnessClaim> = {}): HarnessClaim {
  return { id, claim: text, status: '已选地方事实', row_id: 'SHIP', attaches_to: attachesTo, extends: 'F03', misuse: '写成全舰通行的规矩', source_quote: quote, ...extra };
}

/** Labelled candidates: A = W1 (base, title line), B = W2 and C = W3 (donors). */
export const MERGE_TEXTS: Readonly<Record<string, { id: string; text: string; claims: HarnessClaim[] }>> = {
  A: {
    id: 'W1',
    text: '# 留饭签\n\n温芮在第三邻里的公共桌边核对配给簿。邻里的留饭签挂在食堂门口的铁钩上。\n\n林澈说冷凝管今晚要换滤网。两个人一起把菌毯卷好，送回培养架。',
    claims: [
      claim('A-01', '邻里的留饭签挂在食堂门口的铁钩上', '留饭签挂在食堂门口的铁钩上', '05-ecology-and-everyday.md', { extends: '' }),
      claim('A-02', '冷凝管的滤网由夜班维修工更换', '冷凝管今晚要换滤网', '02-technology-and-infrastructure.md'),
    ],
  },
  B: {
    id: 'W2',
    text: '循环泵的节拍每到换班就慢下来。住户听见节拍变慢就去查看管路。孩子们在走廊里数着灯。',
    claims: [claim('A-01', '循环泵的节拍在换班时变慢', '循环泵的节拍每到换班就慢下来', '05-ecology-and-everyday.md', { status: '状态与路径实例' })],
  },
  C: {
    id: 'W3',
    text: '食堂的蒸笼冒着白汽。值班员把铝饭盒按门牌排在长桌尽头。',
    claims: [claim('A-01', '铝饭盒按门牌排在长桌尽头', '值班员把铝饭盒按门牌排在长桌尽头', '03-government-and-economy.md')],
  },
};

function writerText(text: string, claims: readonly HarnessClaim[]): string {
  const delta = { new_proper_nouns: [], claims: claims.map((c) => ({ ...c, kind: 'author_fact', register: true })) };
  const iface = { shots: [{}, {}, {}], object: { n: 1 }, hook: { h: 1 } };
  return ['```submission', text, '```', '```delta', JSON.stringify(delta), '```', '```interface', JSON.stringify(iface), '```'].join('\n');
}

function mergeBrief(): BriefJson {
  const forbidden = ['出现未登记的第三方势力'];
  return {
    round: MERGE_ROUND, kind: 'round', row_id: 'SHIP', layer: '物件', topic_source: 'fixed',
    cell: { id: 'E2E-R01', row_id: 'SHIP', title: '母舰 · 邻里常态日', entity: '远航号（母舰）上的一个邻里', time: '任一常态日', layers: ['物件'], setting_notes: [], protagonists: ['温芮'], forbidden, stances: [] },
    canon: { revision: '8.1', book_sha256: 'b'.repeat(64), reference_sha256: 'c'.repeat(64) },
    canon_passages: [{ file: 'reference/05-ecology-and-everyday.md', text: '温芮在远航号的第三邻里长大。' }],
    facts: [{ id: 'F01', kind: 'fact', text: '没有星门，也没有即时跨星通信。', status: '共同事实', rows: ['ALL'] }],
    regression: [], regression_stale: [], forbidden, cliches: [], requirements: [], interface_requirements: [], aliases: ['远航号', '母舰'],
    seed: 'merge-seed', created_at: FIXTURE_AT,
  };
}

/** A judge reply: `yes` cites the first ≥ 6-character sentence of the subject against F01; `void` is an empty reply. */
export type MergeVerdict = 'no' | 'yes' | 'void';

export function judgeReply(verdict: MergeVerdict, prompt: string): FakeReply {
  if (verdict === 'void') return '';
  const subject = unwrap(prompt, '文本甲') ?? '';
  const quote = subject.split(/(?<=[。\n])/u).map((s) => s.trim()).find((s) => !s.startsWith('#') && [...s].length >= 8) ?? '';
  const findings = verdict === 'yes' ? [{ quote, against: 'F01', reason: '与冻结事实矛盾' }] : [];
  return `\`\`\`json\n${JSON.stringify({ contradiction: findings.length > 0, findings })}\n\`\`\``;
}

/** A valid editor plan from the prompt: every base sentence but [0] (the title), then each donor Rxx. */
export function goodEditorReply(prompt: string, title = '留饭签'): string {
  const base = (unwrap(prompt, '底稿') ?? '').split('\n').filter((l) => l !== '');
  const donors = (unwrap(prompt, '借入') ?? '').split('\n').flatMap((l) => /^(R\d{2}-\d{2})：/u.exec(l)?.[1] ?? []);
  const body = [...base.slice(1).map((_, i) => ({ from: 'base', index: i + 1, connective: null })), ...donors.map((rxx) => ({ from: 'donor', rxx, connective: null }))];
  return `\`\`\`json\n${JSON.stringify({ title, time_anchor: '任一常态日', path: '标准成功路径', body, paragraph_breaks: [] })}\n\`\`\``;
}

export interface MergeHarnessOptions {
  /** Labels whose champion pair in tally.json is `trial`. */
  trial?: readonly string[];
  faults?: FakeAssemblerFaults;
  /** Wraps the fake assembler (crash simulations). */
  assembler?: (inner: FakeAssembler) => Assembler;
}

/** Mutable scripts the fake backends consult on every call. */
export interface MergeScripts {
  /** Per judge call: kind is `regate` or `postmerge` (task id prefix). */
  judge: (family: Family, kind: string, taskId: string) => MergeVerdict;
  editor: Route;
}

export interface MergeHarness {
  dir: string;
  world: FixtureWorld;
  ctx: StepContext;
  ports: FakePorts;
  assembler: FakeAssembler;
  sim: OwnerSim;
  judges: ReadonlyMap<Family, FakeRouter>;
  editor: FakeRouter;
  scripts: MergeScripts;
  decide(input: DecisionInput): void;
  redecide(input: DecisionInput): void;
  run(until?: StepId): Promise<RunReport>;
  /** Repo-relative path → content of every world/current file on disk. */
  canon(): Record<string, string>;
  /** main's world/current files (repo-relative). */
  mainCanon(): Record<string, string>;
}

/**
 * Fixture world at 09b for R01 on branch forge/r01: start.json (base_sha = main), brief, freeze (4 gate families) +
 * 02c marker, labels A/B/C, W1–W3 with registered author facts, tally.json (trial labels), an audit.json stub, a
 * fake assembler over the temp repo, judge routers (`regate`, `postmerge`) and an editor router (`merge`).
 */
export async function mergeHarness(opts: MergeHarnessOptions = {}): Promise<MergeHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'forge-merge-'));
  const world = fixtureWorld(dir, DEFAULT_FIXTURE);
  const config = loadConfig(world.root, { requireLocal: true });
  if (!config.ok) throw new Error(config.error);
  const base = fakePorts({ repoDir: world.repo, main: world.main, startIso: '2026-10-02T00:00:00.000Z', seed: 'merge' });
  const assembler = fakeAssembler(world.repo, opts.faults ?? NO_ASSEMBLER_FAULTS);
  const ports: FakePorts = { ...base, assembler: opts.assembler === undefined ? assembler : opts.assembler(assembler) };
  const created = await ports.git.createBranch(MERGE_BRANCH, 'main');
  const checkedOut = await ports.git.checkout(MERGE_BRANCH);
  const baseSha = await ports.git.resolveRef('main');
  if (!created.ok || !checkedOut.ok || !baseSha.ok) throw new Error('mergeHarness: cannot prepare the round branch');
  const scripts: MergeScripts = { judge: () => 'no', editor: (prompt) => goodEditorReply(prompt) };
  const judges = new Map<Family, FakeRouter>();
  for (const family of MERGE_JUDGES) {
    const route = (kind: string): Route => (prompt, _call, meta) => judgeReply(scripts.judge(family, kind, meta.taskId), prompt);
    judges.set(family, fakeRouter({ regate: route('regate'), postmerge: route('postmerge') }, { id: `judge-${family}`, family, model: `${family}-fixture` }));
  }
  const editor = fakeRouter({ merge: (prompt, call, meta) => scripts.editor(prompt, call, meta) }, { id: 'merge-editor', family: 'Anthropic', model: 'editor-fixture' });
  const idle = fakeRouter({}, { id: 'idle', family: 'DeepSeek', model: 'idle' });
  const backends: RoundBackends = {
    writers: [], baseline: idle, decoy: idle, defect: idle, judges: [...judges.values()].map((backend) => ({ backend, concurrency: 2 })),
    forecasters: [], maintainer: idle, mergeEditor: editor, calibGateway: new Map(),
  };
  const built = buildContext({
    root: world.root, repo: world.repo, roundId: MERGE_ROUND, pipeline: 'round', paths: roundPaths(world.root, MERGE_ROUND), config: config.value,
    deps: { ports, backends: () => backends, env: {}, pid: 7, isAlive: () => true, log: () => undefined },
    startOptions: { cell: null, seed: null }, quotaBudgetMs: null,
  });
  if (!built.ok) throw new Error(built.error);
  const ctx = built.value;
  writeRound(ctx, baseSha.value, opts.trial ?? []);
  const sim = ownerSim(world.root, ports.clock);
  sim.writeUnlogged(`rounds/${MERGE_ROUND}/audit.json`, { round: MERGE_ROUND, answers: {} });
  const canonOf = (tree: Readonly<Record<string, string>>): Record<string, string> =>
    Object.fromEntries(Object.entries(tree).filter(([p]) => p.startsWith('world/current/')).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return {
    dir, world, ctx, ports, assembler, sim, judges, editor, scripts,
    decide: (input) => sim.decide(MERGE_ROUND, input),
    redecide: (input) => sim.redecide(MERGE_ROUND, input),
    run: (until) => runSteps(ctx, { pipeline: 'round', steps: MERGE_STEPS, until: until ?? null, from: null, redoFrom: null, pid: 7, isAlive: () => true }),
    canon: () => diskCanon(world.repo),
    mainCanon: () => canonOf(world.main),
  };
}

/** Every file under world/current on disk, repo-relative, sorted. */
export function diskCanon(repo: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(repo, rel)).sort()) {
      const child = `${rel}/${name}`;
      if (statSync(join(repo, child)).isDirectory()) walk(child);
      else out[child] = readFileSync(join(repo, child), 'utf8');
    }
  };
  walk('world/current');
  return out;
}

function putJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** The round files a merge reads (written by hand: the steps before 09b are not the subject). */
function writeRound(ctx: StepContext, baseSha: string, trial: readonly string[]): void {
  const p = ctx.paths;
  putJson(p.start, {
    round: MERGE_ROUND, seed: 'merge-seed', branch: MERGE_BRANCH, base_sha: baseSha, issue: { number: MERGE_ISSUE, url: `https://github.com/fixture/forge/issues/${MERGE_ISSUE}` },
    bundle_sha256: ctx.bundleSha256, doctor_sha256: 'd'.repeat(64), started_at: '2026-10-01T00:00:00.000Z', cell: 'cells/E2E-R01.json',
  });
  putJson(p.brief, mergeBrief());
  const benchSha = sha256Bytes(readFileSync(join(ctx.root, 'benchmark', 'v1.json')));
  const read = (rel: string): string => readFileSync(join(ctx.root, rel), 'utf8');
  const freeze = buildFreeze({
    round: MERGE_ROUND, files: { 'brief.json': readFileSync(p.brief, 'utf8'), 'fact-status.json': read('fact-status.json'), regression: read('regression/wb-b1.json') },
    benchmarkVersion: 'v1', eligibleFamilies: [...MERGE_JUDGES], flags: {}, protocolBundleSha256: ctx.bundleSha256, probeCreatedAt: '2026-10-01T00:05:00.000Z',
    seed: 'merge-seed', benchmarkResolution: { version: 'v1', sha256: benchSha, path: 'benchmark/v1.json', via: 'activate', since: FIXTURE_AT }, gateFamilies: [...MERGE_JUDGES],
  });
  putJson(p.freeze, freeze);
  writeMarker(ctx.files, join(p.markers, '02c-freeze.json'), {
    v: 1, round: MERGE_ROUND, step: '02c-freeze', completed_at: '2026-10-01T00:00:00.000Z', result: 'done', skipped: null,
    inputs: {}, outputs: {}, external: {}, local: {}, tasks: { ok: 0, void: 0, calls: 0 }, prev: null,
  });
  const labels: Record<string, string> = {};
  for (const [label, sub] of Object.entries(MERGE_TEXTS)) {
    labels[label] = sub.id;
    putJson(join(p.submissions, `${sub.id}.json`), { id: sub.id, kind: 'writer', model: 'deepseek-fixture', family: 'DeepSeek', stance: 'resident-day', ok: true, error: null, text: writerText(sub.text, sub.claims) });
  }
  putJson(join(p.submissions, 'BASE.json'), { id: 'BASE', kind: 'baseline', model: 'deepseek-fixture', family: 'DeepSeek', stance: null, ok: true, error: null, text: writerText('温芮把借来的扳手挂回工具墙。', []) });
  putJson(join(p.dir, 'labels.json'), labels);
  const pairs = Object.entries(labels).map(([label, submission]) => ({ pair: submission, submission, label, trial: trial.includes(label) }));
  putJson(join(p.dir, 'tally.json'), { v: 2, round: MERGE_ROUND, champion_pairs: pairs });
}

/** Parsed JSON of a forge-root-relative file (test assertions). */
export function readRoundJson(h: MergeHarness, rel: string): unknown {
  const raw: unknown = JSON.parse(readFileSync(join(h.world.root, rel), 'utf8'));
  return raw;
}

/** A string list field of a JSON record, [] when absent. */
export function listOf(value: unknown, key: string): string[] {
  return (isRecord(value) ? stringArray(value[key]) : null) ?? [];
}
