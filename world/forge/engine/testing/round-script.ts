import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { FakeReply } from '../adapters/fake.ts';
import { gatewayId, type ForgeRoots } from '../cli-round.ts';
import { loadConfig, type Family } from '../config.ts';
import type { EngineDeps, RoundBackends, RunHooks } from '../context.ts';
import { isRecord, readArray, readRecord, readString } from '../json.ts';
import { loadSchema, validate } from '../schema.ts';
import { unwrap } from '../tasks/fenced.ts';
import { FORECAST_COUNT, FORECAST_SLOTS } from '../tasks/forecast.ts';
import { splitSentences } from '../text.ts';
import { fakeAssembler } from './fake-assembler.ts';
import { fakePorts, type FakePorts } from './fakes.ts';
import {
  DEFAULT_FIXTURE, FIXTURE_GATEWAY_HOST, FIXTURE_WRITER_MODEL, addCalibrationPassages, assembleFixtureReference, fixtureWorld, type FixtureOptions, type FixtureWorld,
} from './fixture-world.ts';
import { ownerSim, type OwnerSim } from './owner-sim.ts';
import { callLog, fakeRouter, type FakeCallMeta, type FakeRouter, type Route } from './scripted.ts';

/*
 * Scripted fixture round shared by the cross-module pipeline tests (steps/index.test.ts: 00-start … 09b through the
 * CLI; steps/merge-pipeline.test.ts: on through `forge merge` and 11a–11e). fixtureWorld with fake ports and one fake
 * router per backend, routed on the task-id kind: writers (optionally with one registerable fact each), baseline,
 * decoy, defect, forecasters, gate / taste / measure / surprise judges, merge gate judges, the tagger and reviewer,
 * and the merge editor. RoundScriptOptions add (for testing/e2e-script.ts) fixture options, calibration passages, extra
 * judge / maintainer / calibration-gateway routes; the default world is unchanged. Test-only: imported by
 * `*.test.ts` files (and e2e-script.ts).
 */

/** RoundScript world options: `claims` gives every writer one registerable fact (A-01, row SHIP, attached to 05). */
export interface RoundScriptOptions {
  claims: boolean;
  /** fixtureWorld options (default: DEFAULT_FIXTURE without champions, protocol unapproved). */
  fixture?: FixtureOptions;
  /** addCalibrationPassages before the fake ports read `main`, REFERENCE.md / hashes.json reassembled (a C00 build needs them). */
  calibPassages?: boolean;
  /** Extra judge routes (merged over the defaults), e.g. `calib` and `replay` (e2e-script.ts). */
  judgeRoutes?: (script: Script, family: Family) => Record<string, Route>;
  /** Maintainer routes (default: none, so every proposal is void → no_change_invalid). */
  maintainer?: Record<string, Route>;
  /** Calibration gateway backends of build.json models (`calibGateway` keyed by model). */
  calibGateway?: ReadonlyArray<{ model: string; family: Family; routes: Record<string, Route> }>;
}

export const START_ISO = '2026-10-01T00:00:00.000Z';
export const ROUND = 'R01';

/** Every writer text carries it; the baseline (numbered canon sentences) never does: taste fakes prefer it. */
export const WRITER_MARK = '配给簿上多了一行字';
/** W2's first version states it; honest gate judges flag it (a fact contradiction, not a mechanical word). */
export const TRAP = '母星的回信当晚就到了';
/** The defect writer puts it into the copy's second sentence; honest judges flag it as well. */
export const DEFECT_MARK = '星门';
/** The decoy writer's generic replacements; the taste fakes recognise the decoy by the first. */
export const DECOY_GENERICS: readonly string[] = ['某样东西', '某个地方'];
/** This family prefers the decoy in every call of session s1 (and its rerun) of the W1 champion pair. */
export const DECOY_LOVER: Family = 'Moonshot';
export const NUMERAL: Readonly<Record<string, string>> = { W1: '一', W2: '二', W3: '三' };
/** A sealed forecast value (`预测<forecaster>第<i>项`): none may reach a tracked file, a GitHub body or a prompt before 07a. */
export const SEALED_VALUE = /预测[^第\s]{1,40}第\d项/u;

export function fence(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

export function head(text: string): string {
  return [...text].slice(0, 12).join('');
}

/** A registerable author fact of a writer delta (merge pipelines: `RoundScriptOptions.claims`). */
export interface WriterClaim {
  id: string;
  kind: 'author_fact';
  claim: string;
  status: string;
  row_id: string;
  attaches_to: string;
  extends: string;
  misuse: string;
  source_quote: string;
  register: boolean;
}

export function writerText(body: string, claims: readonly WriterClaim[] = []): string {
  return ['```submission', body, '```', '```delta', JSON.stringify({ new_proper_nouns: [], claims }), '```', '```interface', '{"shots":[{},{},{}],"object":{"n":1},"hook":{"h":1}}', '```', '种子：', '- 一'].join('\n');
}

/** The first three numbered canon sentences of the baseline prompt, verbatim (the fake reads material only via unwrap). */
export function baselineReply(prompt: string): FakeReply {
  const numbered = unwrap(prompt, '正典句');
  if (numbered === null) return { error: 'fake baseline: no 正典句 block in the prompt' };
  const sentences = numbered.split('\n').map((l) => l.replace(/^〔C\d{3}〕/u, '')).slice(0, 3);
  return writerText(sentences.join(''));
}

/** `<n>号配给簿上多了一行字` of a slot: the source quote of its registerable fact. */
export function slotQuote(slot: string): string {
  return `${NUMERAL[slot] ?? slot}号${WRITER_MARK}`;
}

/** One registerable fact per writer (id A-01, row SHIP, attached to 05), quoting the slot's own sentence. */
export function slotClaim(slot: string): WriterClaim {
  return {
    id: 'A-01', kind: 'author_fact', claim: `${NUMERAL[slot] ?? slot}号配给簿记下每一次借用`, status: '已选地方事实', row_id: 'SHIP',
    attaches_to: '05-ecology-and-everyday.md', extends: '', misuse: '写成全舰通行的规矩', source_quote: slotQuote(slot), register: true,
  };
}

/** W2's first attempt holds the trap sentence; its blind resubmission `write-W2-r2` (same prompt) does not. */
export function writerReply(slot: string, meta: FakeCallMeta, claims = false): FakeReply {
  const trap = slot === 'W2' && meta.taskId === 'write-W2' ? `值班的老周说${TRAP}，大家可以放心地吃饭。` : '';
  return writerText(`温芮在第三邻里的工具墙前停下，${slotQuote(slot)}。${trap}她把扳手挂回去，去听循环泵的节拍。`, claims ? [slotClaim(slot)] : []);
}

export function forecastReply(id: string): FakeReply {
  const items = FORECAST_SLOTS.slice(0, FORECAST_COUNT).map((slot, i) => ({ slot, value: `预测${id}第${i}项` }));
  return fence({ forecasts: items });
}

/** Ids of `〔label〕` lines `D1｜…` / `W1.a｜…`. */
export function idsOf(prompt: string, label: string): string[] {
  return (unwrap(prompt, label) ?? '').split('\n').map((l) => l.split('｜')[0] ?? '').filter((x) => x !== '');
}

/** Defect writer: swaps the first three characters of sentence 2 for the defect mark, against the first offered id. */
export function defectReply(prompt: string): FakeReply {
  const original = ((unwrap(prompt, '正文') ?? '').split('\n')[1] ?? '').replace(/^〔S\d{3}〕/u, '');
  const against = idsOf(prompt, '条目')[0] ?? '';
  return fence({ sentence_no: 2, original, replacement: `${DEFECT_MARK}旁${[...original].slice(3).join('')}`, against });
}

/** A binding id of the pack: the first fact row that is not a path instance, else the first regression id. */
export function bindingId(prompt: string): string {
  const row = (unwrap(prompt, '事实表') ?? '').split('\n').map((l) => l.split('｜')).find((c) => c.length >= 3 && c[1] !== '状态与路径实例');
  return row?.[0] ?? idsOf(prompt, '回归证据')[0] ?? '';
}

export interface Script {
  /** The first family asked about a defect copy answers 无矛盾 on it (so it is voided and a reserve replaces it). */
  blind: Family | null;
  /** Taste questions of the pinned benchmark. */
  questions: readonly string[];
  /** Merge gate judges (10a `regate`, 10e `postmerge`) find a contradiction when this returns true. */
  mergeContradiction: (kind: string, family: Family) => boolean;
  /** The family that prefers the decoy in W1 s1 and its rerun (default DECOY_LOVER). */
  decoyLover?: Family;
}

/** Honest gate judge: flags every sentence holding the trap or the defect mark; the blind family misses the copy. */
export function gateRoute(script: Script, family: Family, copy: boolean): Route {
  return (prompt) => {
    if (copy && script.blind === null) script.blind = family;
    if (copy && script.blind === family) return fence({ contradiction: false, findings: [] });
    const against = bindingId(prompt);
    const hits = splitSentences(unwrap(prompt, '文本甲') ?? '').filter((s) => s.includes(TRAP) || s.includes(DEFECT_MARK));
    const findings = hits.map((quote) => ({ quote, against, reason: '与冻结事实矛盾' }));
    return fence({ contradiction: findings.length > 0, findings });
  };
}

/** The first four-character window of `sentence` that occurs exactly once in `text`. */
export function uniqueWindow(text: string, sentence: string): string {
  const chars = [...sentence];
  for (let i = 0; i + 4 <= chars.length; i += 1) {
    const window = chars.slice(i, i + 4).join('');
    if (text.split(window).length === 2) return window;
  }
  return '';
}

/**
 * Decoy writer: one unique four-character detail of each of the first n sentences becomes a generic phrase, n = the
 * recipe's detail count the prompt states (`恰好 n 条替换`, 2 when absent).
 */
export function decoyReply(prompt: string): FakeReply {
  const text = unwrap(prompt, '文本甲') ?? '';
  const n = Number(/恰好 (\d+) 条替换/u.exec(prompt)?.[1] ?? '2');
  const originals = splitSentences(text).slice(0, n).map((s) => uniqueWindow(text, s));
  return fence({ replacements: originals.map((original, i) => ({ original, generic: DECOY_GENERICS[i] ?? '某处', kind: '其他' })) });
}

/** Taste judge: prefers the writer text on every question; avoids the decoy unless it is the decoy lover in W1 s1. */
export function tasteRoute(script: Script, family: Family): Route {
  return (prompt, _n, meta) => {
    const t1 = unwrap(prompt, '文本甲') ?? '';
    const t2 = unwrap(prompt, '文本乙') ?? '';
    const pick = !t1.includes(WRITER_MARK) && t2.includes(WRITER_MARK) ? 2 : 1;
    const answers = Object.fromEntries(script.questions.map((q) => [q, { pick, quote: head(pick === 1 ? t1 : t2) }]));
    const t3 = unwrap(prompt, '文本丙');
    const t4 = unwrap(prompt, '文本丁');
    if (t3 === null || t4 === null) return fence({ answers });
    const decoyAt = t3.includes(DECOY_GENERICS[0] ?? '') ? 3 : 4;
    const loverFamily = script.decoyLover ?? DECOY_LOVER;
    const lover = family === loverFamily && meta.taskId.startsWith(`taste-W1-${loverFamily}-s1`);
    const decoyPick = lover ? decoyAt : 7 - decoyAt;
    return fence({ answers, decoy: { pick: decoyPick, quote: head(decoyPick === 3 ? t3 : t4) } });
  };
}

export function measureRoutes(): Record<string, Route> {
  return {
    recall: (prompt) => {
      const text = unwrap(prompt, '文本甲') ?? '';
      const sorted = (unwrap(prompt, '数列') ?? '').split('、').map(Number).sort((a, b) => a - b);
      return fence({ sorted, image: [...text].slice(3, 9).join(''), quote: head(text) });
    },
    skin: (prompt) => fence({ pick: '甲', quote: head(unwrap(prompt, '文本甲') ?? ''), reason: '邻里与配给簿' }),
    cold: (prompt) => {
      const quote = head(unwrap(prompt, '文本甲') ?? '');
      return fence({ where: { answer: '一艘船上的邻里', quote }, who: { name: '温芮', wants: '把工具还回去', cost: null, quote }, go: { answer: null, quote: null } });
    },
    producer: (prompt) => fence({ items: idsOf(prompt, '检查项').map((id) => ({ id, ok: true, missing: null })) }),
  };
}

export function surpriseRoutes(): Record<string, Route> {
  return {
    match: (prompt) => fence({ matches: idsOf(prompt, '细节').map((detail) => ({ detail, forecast: null, relation: 'none' })) }),
    chain: (prompt) => {
      const offered = unwrap(prompt, '正典') ?? '';
      const file = /〔文件：([^〕]+)〕/u.exec(offered)?.[1] ?? '';
      const body = offered.split('\n').find((l) => l.trim() !== '' && !l.startsWith('〔文件：')) ?? '';
      return fence({ chains: idsOf(prompt, '细节').map((detail) => ({ detail, canon: { file, quote: head(body.trim()) }, steps: ['借用要登记，所以工具会被还回原处。'], lands_on: '扳手挂回工具墙' })) });
    },
    accept: (prompt) => fence({ verdicts: idsOf(prompt, '链').map((detail) => ({ detail, accept: true, reason: '登记推出归还' })) }),
  };
}

/** A merge gate verdict on `〔文本甲〕`: a contradiction cites its first ≥ 8-character sentence against a binding id. */
export function mergeGateReply(prompt: string, contradiction: boolean): FakeReply {
  if (!contradiction) return fence({ contradiction: false, findings: [] });
  const subject = unwrap(prompt, '文本甲') ?? '';
  const quote = subject.split(/(?<=[。\n])/u).map((s) => s.trim()).find((s) => !s.startsWith('#') && [...s].length >= 8) ?? '';
  return fence({ contradiction: true, findings: [{ quote, against: bindingId(prompt), reason: '与冻结事实矛盾' }] });
}

/** The merge editor: every base sentence in order (`[i] …` lines of 〔底稿〕), then every offered donor Rxx. */
export function editorReply(prompt: string): FakeReply {
  const base = (unwrap(prompt, '底稿') ?? '').split('\n').flatMap((l) => /^\[(\d+)\] /u.exec(l)?.[1] ?? []).map(Number);
  const donors = (unwrap(prompt, '借入') ?? '').split('\n').flatMap((l) => /^(R\d{2}-\d{2})：/u.exec(l)?.[1] ?? []);
  const body = [...base.map((index) => ({ from: 'base', index, connective: null })), ...donors.map((rxx) => ({ from: 'donor', rxx, connective: null }))];
  return fence({ title: '配给簿', time_anchor: '任一常态日', path: '标准成功路径', body, paragraph_breaks: [] });
}

/**
 * 10a `regate` / 10e `postmerge` judges (script.mergeContradiction); 11d tagger: every offered row tagged `object` and
 * `quest_hook` with the first 8 characters of the scene's first prose line; reviewer: keeps every item.
 */
export function mergeRoutes(script: Script, family: Family): Record<string, Route> {
  return {
    regate: (prompt) => mergeGateReply(prompt, script.mergeContradiction('regate', family)),
    postmerge: (prompt) => mergeGateReply(prompt, script.mergeContradiction('postmerge', family)),
    tag: (prompt) => {
      const scene = unwrap(prompt, '现场') ?? '';
      const prose = scene.split('\n').find((l) => l.trim() !== '' && !l.startsWith('#') && !l.includes('｜')) ?? '';
      const quote = [...prose].slice(0, 8).join('');
      const rows = (unwrap(prompt, '行') ?? '').split('\n').map((l) => l.split('｜')[0] ?? '').filter((r) => r !== '');
      return fence({ tags: rows.flatMap((row_id) => ['object', 'quest_hook'].map((layer) => ({ row_id, layer, quotes: [quote], dangling: [] }))) });
    },
    tagreview: (prompt) => fence({ reviews: idsOf(prompt, '标注').map((id) => ({ id, verdict: 'keep', reason: '出自现场' })) }),
  };
}

export interface World {
  dir: string;
  w: FixtureWorld;
  at: ForgeRoots;
  ports: FakePorts;
  sim: OwnerSim;
  backends: RoundBackends;
  routers: FakeRouter[];
  logs: string[];
  script: Script;
}

/** Question ids of benchmark/v1.json ([] while v1 does not exist yet: an e2e world gets v1 from its round 0). */
export function benchQuestions(root: string): string[] {
  if (!existsSync(join(root, 'benchmark', 'v1.json'))) return [];
  const bench: unknown = JSON.parse(readFileSync(join(root, 'benchmark', 'v1.json'), 'utf8'));
  return (readArray(readRecord(bench, 'taste'), 'questions') ?? []).map((q) => readString(q, 'id') ?? '').filter((id) => id !== '');
}

export function world(opts: RoundScriptOptions = { claims: false }): World {
  const dir = mkdtempSync(join(tmpdir(), 'forge-pipeline-'));
  const w = fixtureWorld(dir, opts.fixture ?? { ...DEFAULT_FIXTURE, champions: 'none', protocolApproved: false });
  if (opts.calibPassages === true) {
    addCalibrationPassages(w);
    const assembled = assembleFixtureReference(join(w.repo, 'world', 'current'));
    const files: Array<[string, string]> = [['world/current/reference/REFERENCE.md', assembled.reference], ['world/current/reference/hashes.json', `${JSON.stringify(assembled.hashes, null, 2)}\n`]];
    for (const [rel, text] of files) {
      writeFileSync(join(w.repo, rel), text);
      w.main[rel] = text;
    }
  }
  const config = loadConfig(w.root, { requireLocal: true });
  if (!config.ok) throw new Error(config.error);
  // the TS assembler over the temp repo (10c); the stub of fakePorts writes nothing
  const ports: FakePorts = { ...fakePorts({ repoDir: w.repo, main: w.main, startIso: START_ISO, seed: 'pipeline-seed' }), assembler: fakeAssembler(w.repo) };
  const script: Script = { blind: null, questions: benchQuestions(w.root), mergeContradiction: () => false };
  const routers: FakeRouter[] = [];
  const add = (r: FakeRouter): FakeRouter => {
    routers.push(r);
    return r;
  };
  const judges = config.value.judges.map((j) => ({
    backend: add(fakeRouter({
      forecast: () => forecastReply(j.id),
      gate: gateRoute(script, j.family, false),
      gatecopy: gateRoute(script, j.family, true),
      taste: tasteRoute(script, j.family),
      ...measureRoutes(),
      ...surpriseRoutes(),
      ...mergeRoutes(script, j.family),
      ...(opts.judgeRoutes === undefined ? {} : opts.judgeRoutes(script, j.family)),
    }, { id: j.id, family: j.family, model: j.model })),
    concurrency: j.concurrency,
  }));
  const gateway = add(fakeRouter({ forecast: () => forecastReply('gw') }, { id: 'gateway-deepseek-fixture', family: 'DeepSeek', model: FIXTURE_WRITER_MODEL }));
  const writers = ['W1', 'W2', 'W3'].map((slot) => ({
    slot,
    // W3's first attempt fails with an adapter error carrying the gateway host (it must reach no file unredacted); the retry answers.
    backend: add(fakeRouter({ write: (_p, _n, meta) => (slot === 'W3' && meta.attempt === 1 ? { error: `gateway request failed: connect ECONNREFUSED https://${FIXTURE_GATEWAY_HOST}/v1` } : writerReply(slot, meta, opts.claims)) }, { id: slot, family: 'DeepSeek', model: FIXTURE_WRITER_MODEL })),
  }));
  const idle = (id: string): FakeRouter => add(fakeRouter({}, { id, family: 'Anthropic', model: `idle-${id}` }));
  const backends: RoundBackends = {
    writers,
    baseline: add(fakeRouter({ baseline: (prompt) => baselineReply(prompt) }, { id: 'BASE', family: 'DeepSeek', model: FIXTURE_WRITER_MODEL })),
    // Gateway models (family DeepSeek, like the writers): no taste family is excluded as a decoy author.
    decoy: add(fakeRouter({ decoy: (prompt) => decoyReply(prompt) }, { id: 'decoy', family: 'DeepSeek', model: FIXTURE_WRITER_MODEL })),
    defect: add(fakeRouter({ defect: (prompt) => defectReply(prompt) }, { id: 'defect', family: 'DeepSeek', model: FIXTURE_WRITER_MODEL })),
    judges,
    forecasters: [...judges.map((j) => j.backend), gateway],
    maintainer: opts.maintainer === undefined ? idle('maintainer') : add(fakeRouter(opts.maintainer, { id: 'maintainer', family: 'Anthropic', model: 'maintainer-fixture' })),
    mergeEditor: add(fakeRouter({ merge: (prompt) => editorReply(prompt) }, { id: 'merge_editor', family: 'Anthropic', model: 'editor-fixture' })),
    calibGateway: new Map((opts.calibGateway ?? []).map((g) => [g.model, add(fakeRouter(g.routes, { id: gatewayId(g.model), family: g.family, model: g.model }))])),
  };
  return { dir, w, at: { root: w.root, repo: w.repo }, ports, sim: ownerSim(w.root, ports.clock), backends, routers, logs: [], script };
}

/**
 * Every paid call starts one fake second later (beforeCall, then the caller's own beforeCall), so writer, defect and
 * decoy calls start strictly after the probe was mirrored, as on a real clock (07a's ordering check refuses a call
 * stamped at the mirror instant).
 */
export function deps(x: World, pid: number, hooks: RunHooks = {}): EngineDeps {
  const tick: RunHooks = {
    ...hooks,
    beforeCall: (taskId, attempt) => {
      x.ports.clock.advance(1000);
      hooks.beforeCall?.(taskId, attempt);
    },
  };
  return { ports: x.ports, backends: () => x.backends, hooks: tick, env: {}, pid, isAlive: (p) => p === pid, log: (line) => x.logs.push(line) };
}

/** Every paid call of every process, `taskId#attempt`. */
export function allCalls(x: World): string[] {
  return x.routers.flatMap((r) => callLog(r));
}

export function must<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

/** Forge-root-relative paths of every file under `dir` (recursive). */
export function filesUnder(root: string, dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(root, path));
    else out.push(relative(root, path).split(sep).join('/'));
  }
  return out;
}

export function readObject(path: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(raw)) throw new Error(`${path}: not a JSON object`);
  return raw;
}

/** Schema errors of `value` against schema/<name>.schema.json (an entry under `properties` when `entry` is set). */
export function schemaErrors(root: string, name: string, value: unknown, entry: string | null = null): string[] {
  const raw: unknown = JSON.parse(readFileSync(join(root, 'schema', `${name}.schema.json`), 'utf8'));
  const picked = entry === null ? raw : readRecord(readRecord(raw, 'properties'), entry);
  const schema = loadSchema(picked);
  if (!schema.ok) throw new Error(`${name}: ${schema.error}`);
  return validate(schema.value, value);
}

export function pickTopic(x: World, round: string): void {
  const offered = readArray(JSON.parse(readFileSync(join(round, 'topic-offer.json'), 'utf8')), 'top3')?.[0];
  const rowId = readString(offered, 'row_id');
  const layer = readString(offered, 'layer');
  if (rowId === null || layer === null) throw new Error('topic-offer.json: top3[0] needs row_id and layer');
  x.sim.pickTopic(ROUND, { row_id: rowId, layer });
}
