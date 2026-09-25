import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Family } from '../config.ts';
import { isRecord, readArray, readString, stringArray } from '../json.ts';
import { loadProtocolBundle } from '../rules.ts';
import { fakeClock } from './fakes.ts';
import { ownerSim } from './owner-sim.ts';

export const FIXTURE_GATEWAY_HOST = 'fixture-gateway.invalid';
/** Timestamp of every fixture-made record (bench log, owner entries, champion, trust); test clocks start later. */
export const FIXTURE_AT = '2026-09-01T00:00:00.000Z';
/** Writer and baseline model of the fixture `writers.json` (family DeepSeek). */
export const FIXTURE_WRITER_MODEL = 'deepseek-fixture';
/** Reference files 01–08 of the fixture canon (revision 8.1), in manifest order. */
export const FIXTURE_REFERENCE_FILES: readonly string[] = [
  '01-space-and-history.md',
  '02-technology-and-infrastructure.md',
  '03-government-and-economy.md',
  '04-war-and-diplomacy.md',
  '05-ecology-and-everyday.md',
  '06-culture-and-contact.md',
  '07-register-and-creation.md',
  '08-cross-system-cases.md',
];
/** SHIP champion text for `champions: 'ship_owner_pick'` (one cliché mark, 仿佛). */
export const FIXTURE_CHAMPION_TEXT =
  '温芮把借来的扳手挂回第三邻里的工具墙，墙上的编号牌仿佛还带着上一班的体温。她在配给簿上补了一行字，又去听循环泵的节拍。林澈从走廊另一头过来，说冷凝管今晚要换滤网。两个人一起把菌毯卷好，送回培养架。';

export interface FixtureOptions {
  /** benchmark/log.jsonl + v1.json: none, v1 `pending_owner`, or v1 `activate` (with a matching bench_diff_viewed). */
  benchmark: 'none' | 'pending' | 'active';
  /** champions.json: empty, or SHIP = owner_pick (family DeepSeek, text CHAMPION). */
  champions: 'none' | 'ship_owner_pick';
  /** calibration/status.json: absent, or these families qualified (the rest of the judges unqualified). */
  trust: 'none' | { qualified: readonly Family[] };
  /** Write owner-log protocol_approved for the real bundle (through owner-sim). */
  protocolApproved: boolean;
}

export const DEFAULT_FIXTURE: FixtureOptions = {
  benchmark: 'active',
  champions: 'ship_owner_pick',
  trust: { qualified: ['Anthropic', 'Moonshot', 'OpenAI', 'xAI'] },
  protocolApproved: true,
};

export interface FixtureWorld {
  /** `<dir>/repo` (fixture canon under world/current/). */
  repo: string;
  /** `<dir>/repo/world/forge` (= ctx.root). */
  root: string;
  /** Repo-relative path → content of `main` (feed to fakeGit): every file written here except git-ignored ones. */
  main: Record<string, string>;
  /** `cells/<id>.json` (forge-root-relative) of the fixed fixture cells. */
  cells: readonly string[];
  gatewayHost: string;
}

/** The real forge root (engine/testing/../..): source of the bundle, schema, skills, map rows and fact statuses. */
const REAL_ROOT = join(import.meta.dirname, '..', '..');

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const PEOPLE: readonly string[] = ['值班员', '住户', '维修工', '接应员', '老船工', '厨房的帮工'];
const ACTS: readonly string[] = [
  '每天清晨先核对一遍水循环的读数',
  '把借来的工具按编号挂回墙上',
  '用手写的记录卡交接夜班',
  '在门口的状态牌上改写设备的可用程度',
  '把多出来的口粮分装进公用的储物格',
  '趁换班的空当修补通风口的滤网',
  '按灯带的颜色判断哪条走廊正在检修',
  '把孩子们的旧外套改成擦拭镜面的软布',
  '在配给簿上记下每一次借用和归还',
  '听见循环泵换了节拍就去查看管路',
  '把晾干的菌毯卷起来送回培养架',
  '在公告板上贴出下一周的轮值表',
];

/** Eleven distinct sentences about one place (≈ 300 characters: one 250–600 character calibration block). */
function paragraph(place: string, offset: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < 11; i += 1) {
    const person = PEOPLE[(i + offset) % PEOPLE.length] ?? '住户';
    const act = ACTS[(i + offset) % ACTS.length] ?? '';
    out.push(`在${place}，${person}${act}。`);
  }
  return out;
}

interface ProseFile {
  name: string;
  title: string;
  sections: ReadonlyArray<{ heading: string; place: string }>;
  extra: readonly string[];
}

/** 04 carries the S1-冷湾 / S1-赤脊 rows, 05 the SHIP row, both characters and the protocol:fixture-rxx extends sentence. */
function proseFiles(rxxExtends: string): ProseFile[] {
  return [
    { name: '01-space-and-history.md', title: '空间与历史', sections: [{ heading: '航网', place: '航网档案馆的阅览室' }, { heading: '晷川', place: '晷川交接区的旧观测站' }], extra: [] },
    { name: '02-technology-and-infrastructure.md', title: '科技与设施', sections: [{ heading: '维修', place: '砧港的维修棚' }, { heading: '循环', place: '循环舱的泵房' }], extra: [] },
    { name: '03-government-and-economy.md', title: '治理与经济', sections: [{ heading: '配给', place: '栖衡节点的配给处' }, { heading: '接应', place: '息壤外层的接应站' }], extra: [] },
    { name: '04-war-and-diplomacy.md', title: '战争与外交', sections: [{ heading: '冷湾', place: '冷湾的旧码头' }, { heading: '赤脊', place: '赤脊的风蚀台地' }], extra: [] },
    {
      name: '05-ecology-and-everyday.md',
      title: '生态与日常',
      sections: [{ heading: '邻里', place: '远航号的第三邻里' }, { heading: '循环舱', place: '母舰的循环舱' }],
      extra: [
        '温芮在远航号的第三邻里长大，她记得每一台循环泵的节拍。',
        '林澈是母舰循环舱的夜班维修工，他总在交班前把滤网擦干净。',
        rxxExtends,
      ],
    },
    { name: '06-culture-and-contact.md', title: '文化与接触', sections: [{ heading: '集市', place: '回纹地方节点的集市' }, { heading: '灯塔', place: '帘影的旧灯塔' }], extra: [] },
    { name: '08-cross-system-cases.md', title: '交叉演算', sections: [{ heading: '冰栈', place: '逐霜节点的冰栈' }, { heading: '转运', place: '协作节点的转运场' }], extra: [] },
  ];
}

function renderProse(file: ProseFile, fileIndex: number): string {
  const parts = [`# ${file.title}`, '', `本篇是夹具正典，只用于测试。`, ''];
  file.sections.forEach((s, i) => {
    parts.push(`## ${i + 1}. ${s.heading}`, '', paragraph(s.place, fileIndex * 2 + i).join(''), '');
  });
  if (file.extra.length > 0) parts.push(`## ${file.sections.length + 1}. 人物与规矩`, '', file.extra.join(''), '');
  return parts.join('\n');
}

const STATUS_TABLE: readonly string[] = [
  '| 地位 | 含义 | 可以怎样修改 |',
  '|---|---|---|',
  '| 共同事实 | 同版本所有地方和主线遵守，包括历史上的固定事件 | 正式修订必须检查全部关联条目；不能在一条支线里悄悄换掉 |',
  '| 已选地方事实 | 本版选定的某地环境、历史及自然答案 | 制作前可有署名修订；一旦形成该世界证据，访问顺序不能改写它 |',
  '| 状态与路径实例 | 在指定时刻、选择或标准成功路径下成立 | 随实际事件改变；不同分支不能同时共享互斥结果 |',
  '| 有边界的未知 | 作者未定、角色未知或真正开放三者之一 | 先辨明类别；准备使用决定性线索时，作者必须知道自己承诺了什么 |',
];

/** 07 with §1 (the four statuses) and §2 (one row per fact-status.json entry, column 事实与地位 = its `fact`). */
function render07(facts: ReadonlyArray<{ id: string; fact: string }>): string {
  const rows = facts.map((f) => `| ${f.id} | ${f.fact} | [空间历史](01-space-and-history.md) | 把夹具事实写反 |`);
  return [
    '# 事实索引、词条与继续创作',
    '',
    '本索引是夹具正典的事实表，只用于测试。',
    '',
    '## 1. 本版事实的四种地位',
    '',
    ...STATUS_TABLE,
    '',
    '## 2. 核心事实表',
    '',
    '| ID | 事实与地位 | 关联条目 | 容易造成的错误 |',
    '|---|---|---|---|',
    ...rows,
    '',
    '## 3. 继续创作',
    '',
    '新事实先登记，再进入正典。',
    '',
  ].join('\n');
}

const MANIFEST_HEADER: readonly string[] = ['# 群星回响 · 世界设定参考集 8.1', '', '夹具正典 · 只用于测试'];

/**
 * REFERENCE.md and hashes.json for `<repo>/world/current` as the fixture assembles them: header lines, then every
 * manifest file in order, separated by one blank line. PR-D's fake assembler should produce the same bytes.
 */
export function assembleFixtureReference(currentDir: string): { reference: string; hashes: Record<string, unknown> } {
  const manifest: unknown = JSON.parse(readFileSync(join(currentDir, 'reference', 'manifest.json'), 'utf8'));
  const header = readStrings(manifest, 'header');
  const files = readStrings(manifest, 'files');
  const revision = readStr(manifest, 'revision');
  const documents: Record<string, string> = {};
  const bodies: string[] = [];
  for (const name of files) {
    const text = readFileSync(join(currentDir, 'reference', name), 'utf8');
    documents[name] = sha256(text);
    bodies.push(text.endsWith('\n') ? text : `${text}\n`);
  }
  const reference = `${header.join('\n')}\n\n${bodies.join('\n')}`;
  const book = readFileSync(join(currentDir, 'BOOK.md'), 'utf8');
  return {
    reference,
    hashes: { base_book_sha256: sha256(book), reference_revision: revision, documents, reference_book_sha256: sha256(reference) },
  };
}

function readStr(value: unknown, key: string): string {
  const v = readString(value, key);
  if (v === null) throw new Error(`fixture: ${key} must be a string`);
  return v;
}

function readStrings(value: unknown, key: string): string[] {
  const v = stringArray(isRecord(value) ? value[key] : null);
  if (v === null) throw new Error(`fixture: ${key} must be a string array`);
  return v;
}

const STANCES: ReadonlyArray<{ id: string; text: string }> = [
  { id: 'resident-day', text: '居民的一天：跟着主角过完这一天里最普通、也最要紧的几个时刻。' },
  { id: 'object-history', text: '物件的来历：从一件物件写起，让它的来历和用法把人和地方带出来。' },
  { id: 'outsider-first-visit', text: '外来者初访：透过一位新接应者第一次走进这里的眼睛来写。' },
  { id: 'counter-consequence', text: '反直觉后果：从一条既有规则出发，写出它在这里带来的一个意外后果。' },
];

function cell(id: string, rowId: string, title: string, entity: string): Record<string, unknown> {
  return {
    id,
    row_id: rowId,
    title,
    entity,
    time: '息壤停留期中的任一常态日',
    layers: ['物件', '任务钩子'],
    setting_notes: ['写一个普通的一天，不要照搬既有概念图的布局'],
    protagonists: ['温芮', '林澈'],
    forbidden: ['决定任何失散者的结局', '出现未登记的第三方势力'],
    stances: STANCES,
  };
}

const CELLS: ReadonlyArray<{ id: string; rowId: string; title: string; entity: string }> = [
  { id: 'E2E-R01', rowId: 'SHIP', title: '母舰 · 邻里常态日', entity: '远航号（母舰）上的一个邻里' },
  { id: 'E2E-R02', rowId: 'S1-冷湾', title: '冷湾 · 码头常态日', entity: '冷湾的旧码头' },
  { id: 'E2E-R03', rowId: 'S1-赤脊', title: '赤脊 · 台地常态日', entity: '赤脊的风蚀台地' },
];

function firstSentence(text: string, needle: string): string {
  const hit = text.split('。').find((s) => s.includes(needle));
  if (hit === undefined) throw new Error(`fixture: no canon sentence mentions ${needle}`);
  return `${hit.replace(/^[\s\S]*\n/u, '')}。`;
}

function aliases(ref04: string, ref05: string): Record<string, unknown> {
  const q = (file: string, text: string, needle: string): { file: string; quote: string } => ({ file: `reference/${file}`, quote: firstSentence(text, needle) });
  return {
    entries: [
      { row_id: 'SHIP', kind: 'ship', primary: '远航号', aliases: ['母舰', '家园舰', '归航号'], first_quote: q('05-ecology-and-everyday.md', ref05, '远航号') },
      { row_id: 'S1-冷湾', kind: 'area', primary: '冷湾', aliases: [], first_quote: q('04-war-and-diplomacy.md', ref04, '冷湾') },
      { row_id: 'S1-赤脊', kind: 'area', primary: '赤脊', aliases: [], first_quote: q('04-war-and-diplomacy.md', ref04, '赤脊') },
      { row_id: 'P-温芮', kind: 'character', primary: '温芮', aliases: [], first_quote: q('05-ecology-and-everyday.md', ref05, '温芮') },
      { row_id: 'P-林澈', kind: 'character', primary: '林澈', aliases: [], first_quote: q('05-ecology-and-everyday.md', ref05, '林澈') },
    ],
  };
}

function champions(opts: FixtureOptions): Record<string, unknown> {
  if (opts.champions === 'none') return {};
  return {
    SHIP: {
      row_id: 'SHIP',
      kind: 'owner_pick',
      round: 'P00',
      submission: 'W1',
      family: 'DeepSeek',
      authors: ['DeepSeek'],
      text: FIXTURE_CHAMPION_TEXT,
      text_sha256: sha256(FIXTURE_CHAMPION_TEXT),
      set_at: FIXTURE_AT,
      previous: [],
    },
  };
}

function writers(): Record<string, unknown> {
  const slot = (id: string, temperature: number): Record<string, unknown> => ({ id, model: FIXTURE_WRITER_MODEL, max_tokens: 32000, temperature });
  return { timeout_ms: 60000, slots: [slot('W1', 1), slot('W2', 1), slot('W3', 1)], baseline: slot('BASE', 0.7) };
}

/** git-ignored: the gateway host exists only here, as at runtime. */
function local(): Record<string, unknown> {
  return {
    gateway: { base_url: `https://${FIXTURE_GATEWAY_HOST}`, env_file: 'fixture-gateway.env', key_var: 'FIXTURE_GATEWAY_KEY' },
    binaries: { codex: 'codex', claude: 'claude', kimi: 'kimi', grok: 'grok' },
    codex_auth: 'fixture-codex-auth.json',
    kimi_home: 'fixture-kimi-home',
    private_phrases: [],
  };
}

function calibrationBuild(): Record<string, unknown> {
  return {
    primary_model: 'deepseek-fixture-a',
    contrast_models: ['qwen/fixture-b'],
    degrade_model: 'deepseek-fixture-a',
    passage_files: FIXTURE_REFERENCE_FILES.filter((f) => !f.startsWith('07-')).map((f) => `reference/${f}`),
    passage_chars: [250, 600],
    length_tolerance_pct: 15,
    max_passages_per_file: 5,
  };
}

interface JudgeRef {
  id: string;
  family: string;
  model: string;
}

function judgesOf(judgesJson: string): JudgeRef[] {
  const raw: unknown = JSON.parse(judgesJson);
  return (readArray(raw, 'judges') ?? []).map((j) => ({ id: readStr(j, 'id'), family: readStr(j, 'family'), model: readStr(j, 'model') }));
}

/** Every judge adapter passed its latest canary run. */
function canary(judges: readonly JudgeRef[]): Record<string, unknown> {
  const adapters = judges
    .map((j) => ({
      ...j,
      served_model: j.model,
      version: 'fixture',
      ms: 1,
      pass: true,
      reasons: [],
      at: FIXTURE_AT,
      token_sha256: sha256('fixture-canary-token'),
      prompt_sha256: sha256('fixture-canary-prompt'),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { pass: true, adapters };
}

/** benchmark v1: the prototype v0 body under the maintainer lineage (bars 7, two questions, decoy recipe 2 details). */
function benchmarkV1(v0: unknown): Record<string, unknown> {
  if (!isRecord(v0)) throw new Error('fixture: benchmark/v0.json is not an object');
  return {
    ...v0,
    version: 'v1',
    parent: null,
    created_at: FIXTURE_AT,
    author: { kind: 'maintainer', model: 'fixture-maintainer' },
    reasons: [],
    cliche_list: ['时光在指缝间流走'],
    decoy_recipe: { details: 2, instructions: '把现任稿中最具体的两个细节换成泛泛的同类说法，长度、段落和格式保持不变。' },
    bars: { beats_champion_four_families: 7 },
  };
}

function benchLogEntry(outcome: 'activate' | 'pending_owner', v1Sha: string, bundleSha: string): Record<string, unknown> {
  return {
    at: FIXTURE_AT,
    cycle: 'R00-init',
    outcome,
    version: 'v1',
    parent: null,
    sha256: v1Sha,
    path: 'benchmark/v1.json',
    activation: outcome === 'activate' ? 'auto' : 'owner',
    changed_keys: [],
    evidence_packet: null,
    evidence_packet_sha256: null,
    evidence_ids: [],
    reasons: [],
    errors: [],
    replay: null,
    dropped_cliches: [],
    protocol_bundle_sha256: bundleSha,
    calls: [],
    source: 'engine',
  };
}

/** calibration/status.json after a fixture C00: qualified families agree 11/12, the others 6/12. */
function trustStatus(judges: readonly JudgeRef[], qualified: readonly Family[]): Record<string, unknown> {
  const families: Record<string, unknown> = {};
  for (const family of [...new Set(judges.map((j) => j.family))].sort()) {
    const q = qualified.some((f) => f === family);
    const n = 12;
    const k = q ? 11 : 6;
    const alpha = 1 + k;
    const beta = 1 + n - k;
    const mean = alpha / (alpha + beta);
    const sd = Math.sqrt((alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1)));
    const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
    families[family] = {
      qualified: q,
      qualified_by: q ? 'C00' : null,
      requal_used: { calibration_fail: false, suspension: false },
      gate_judge: true,
      gate_by: 'C00',
      agreement: {
        epoch: 'C00',
        n,
        k,
        alpha,
        beta,
        mean: round4(mean),
        ci90: [round4(Math.max(0, mean - 1.645 * sd)), round4(Math.min(1, mean + 1.645 * sd))],
        p_below: q ? 0.01 : 0.6,
        state: 'ok',
      },
      suspended_at: null,
    };
  }
  return { schema: 'trust-status/1', updated_after: 'C00', labels_sha256: sha256('fixture-labels'), families };
}

function book(): string {
  return ['# 群星回响（夹具书）', '', paragraph('旗舰的候船大厅', 5).join(''), '', paragraph('旧港的货运栈桥', 7).join(''), ''].join('\n');
}

/** Two regression quotes (verbatim canon sentences) in the brief's `{id, case, source, quote}` row shape. */
function regression(ref02: string, ref03: string): Record<string, unknown> {
  return {
    source: 'fixture WB-B1 evidence',
    quotes: [
      { id: 'G-001', case: 'P01', source: 'judge-a', quote: firstSentence(ref02, '砧港的维修棚') },
      { id: 'G-002', case: 'N01', source: 'judge-b', quote: firstSentence(ref03, '息壤外层的接应站') },
    ],
  };
}

/**
 * Temp forge root: real bundle files (PROTOCOL.md, families.json, judges.json), schema/, skills/, map rows and
 * fact statuses copied byte for byte; fixture canon repo (8.1, files 01–08, BOOK.md, REFERENCE.md, hashes.json);
 * local.json with fixture-gateway.invalid; github.json, writers.json, prices.json, cells, aliases, tags, champions,
 * regression quotes, calibration/build.json, canary results; plus the optional benchmark / trust status / owner
 * entries. `dir` must be an empty temp directory.
 */
export function fixtureWorld(dir: string, opts: FixtureOptions): FixtureWorld {
  const repo = join(dir, 'repo');
  const root = join(repo, 'world', 'forge');
  const current = join(repo, 'world', 'current');
  const main: Record<string, string> = {};
  const put = (repoRel: string, text: string, tracked: boolean): void => {
    const abs = join(repo, repoRel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    if (tracked) main[repoRel] = text;
  };
  const forge = (rel: string, text: string): void => put(`world/forge/${rel}`, text, true);
  const canon = (rel: string, text: string): void => put(`world/current/${rel}`, text, true);
  const real = (rel: string): string => readFileSync(join(REAL_ROOT, rel), 'utf8');

  for (const f of ['PROTOCOL.md', 'families.json', 'judges.json', '.gitignore', 'prices.json', 'fact-status.json', 'map/rows.json']) forge(f, real(f));
  for (const sub of ['schema', 'skills']) {
    if (!existsSync(join(REAL_ROOT, sub))) continue;
    for (const name of readdirSync(join(REAL_ROOT, sub)).sort()) {
      if (name.endsWith('.json') || name.endsWith('.md')) forge(`${sub}/${name}`, real(`${sub}/${name}`));
    }
  }
  const bundle = loadProtocolBundle(root);
  if (!bundle.ok) throw new Error(`fixture: ${bundle.error}`);

  const facts = (readArray(JSON.parse(real('fact-status.json')), 'facts') ?? []).map((f) => ({ id: readStr(f, 'id'), fact: readStr(f, 'fact') }));
  const refs: Record<string, string> = {};
  proseFiles(bundle.value.protocol.fixtureRxx.extends).forEach((f, i) => {
    refs[f.name] = renderProse(f, i);
  });
  refs['07-register-and-creation.md'] = render07(facts);
  canon('BOOK.md', book());
  canon('README.md', '# 夹具正典\n\n只用于测试。\n');
  canon('REVISION.md', '# 修订记录\n\n- 8.1：夹具正典。\n');
  canon('reference/manifest.json', json({ revision: '8.1', header: MANIFEST_HEADER, files: FIXTURE_REFERENCE_FILES }));
  for (const name of FIXTURE_REFERENCE_FILES) canon(`reference/${name}`, refs[name] ?? '');
  canon('reference/CHANGES.md', '# 变更\n\n- 8.1：夹具正典。\n');
  canon('reference/README.md', '# 参考集\n\n夹具正典，只用于测试。\n');
  const assembled = assembleFixtureReference(current);
  canon('reference/REFERENCE.md', assembled.reference);
  canon('reference/hashes.json', json(assembled.hashes));

  const judgesJson = real('judges.json');
  const judges = judgesOf(judgesJson);
  put('world/forge/local.json', json(local()), false);
  forge('github.json', json({ repo: 'fixture/forge', epic_issue: 1, base_branch: 'main' }));
  forge('writers.json', json(writers()));
  for (const c of CELLS) forge(`cells/${c.id}.json`, json(cell(c.id, c.rowId, c.title, c.entity)));
  forge('map/aliases.json', json(aliases(refs['04-war-and-diplomacy.md'] ?? '', refs['05-ecology-and-everyday.md'] ?? '')));
  forge('map/tags.json', json({ cells: {} }));
  forge('map/snapshot-r0.json', json({ revision: '8.1', cells: {} }));
  forge('champions.json', json(champions(opts)));
  forge('regression/wb-b1.json', json(regression(refs['02-technology-and-infrastructure.md'] ?? '', refs['03-government-and-economy.md'] ?? '')));
  forge('calibration/build.json', json(calibrationBuild()));
  forge('canary/results.json', json(canary(judges)));
  if (opts.benchmark !== 'none') {
    const v1 = json(benchmarkV1(JSON.parse(real('benchmark/v0.json'))));
    forge('benchmark/v1.json', v1);
    const entry = benchLogEntry(opts.benchmark === 'active' ? 'activate' : 'pending_owner', sha256(v1), bundle.value.bundleSha256);
    forge('benchmark/log.jsonl', `${JSON.stringify(entry)}\n`);
  }
  if (opts.trust !== 'none') forge('calibration/status.json', json(trustStatus(judges, opts.trust.qualified)));

  if (opts.protocolApproved || opts.benchmark === 'active') {
    const sim = ownerSim(root, fakeClock(FIXTURE_AT));
    if (opts.protocolApproved) sim.approveProtocol();
    if (opts.benchmark === 'active') sim.viewBenchDiff('v1');
    main['world/forge/owner-log.jsonl'] = readFileSync(join(root, 'owner-log.jsonl'), 'utf8');
  }
  return { repo, root, main, cells: CELLS.map((c) => `cells/${c.id}.json`), gatewayHost: FIXTURE_GATEWAY_HOST };
}

/** Places of the extra calibration blocks (one per block; distinct places keep every block distinct). */
const CALIB_PLACES: readonly string[] = ['北侧的储水舱', '旧货栈的二层', '轮值室的门口', '菌毯培养架旁'];

/**
 * Appends four more 250–600 character prose blocks to every passage file (01–06, 08) of a fixture world and records
 * them in `w.main` (so fakeGit keeps them): the base canon has 2 passage-grade blocks per file, a C00 build needs 24
 * distinct passages plus spares with at most 5 per file. Call before fakePorts / fakeGit reads `w.main`.
 */
export function addCalibrationPassages(w: FixtureWorld): void {
  FIXTURE_REFERENCE_FILES.filter((name) => !name.startsWith('07-')).forEach((name, i) => {
    const rel = `world/current/reference/${name}`;
    const blocks = CALIB_PLACES.map((place, k) => paragraph(`${name.slice(0, 2)}号篇的${place}`, i * 4 + k).join(''));
    appendFileSync(join(w.repo, rel), `\n${blocks.join('\n\n')}\n`);
    w.main[rel] = readFileSync(join(w.repo, rel), 'utf8');
  });
}
