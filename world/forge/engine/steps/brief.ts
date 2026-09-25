import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeBenchmark } from '../bench-active.ts';
import { parseCell, type Cell, type Stance } from '../brief.ts';
import type { StepContext } from '../context.ts';
import { canonFiles } from '../inputs.ts';
import { isRecord, readArray, readRecord, readString, stringArray } from '../json.ts';
import type { Topic, TopicSource } from '../owner-inputs.ts';
import { err, ok, type Result } from '../result.ts';
import type { StepDef, StepOutcome } from '../runner.ts';
import { sha256 } from '../store.ts';
import { IntegrityError } from '../task.ts';
import { LAYER_LABELS, LAYERS, parseAliases, parseRows, type Alias, type Row } from '../thinmap.ts';

/** The four 07 §1 statuses. */
export type FactStatus = '共同事实' | '已选地方事实' | '状态与路径实例' | '有边界的未知';

export const FACT_STATUSES: readonly FactStatus[] = ['共同事实', '已选地方事实', '状态与路径实例', '有边界的未知'];

/** A frozen fact: 07 §2 F-ID joined with fact-status.json, or a 07 §8 Rxx touching the row. */
export interface FactRow {
  /** F01…F15 or Rnn-nn. */
  id: string;
  kind: 'fact' | 'registered';
  text: string;
  status: FactStatus;
  /** Thin-map rows (fact-status.json rows; Rxx: its row_id). */
  rows: string[];
}

/** A live regression quote (regression/wb-b1.json), re-verified as a substring of the current canon. */
export interface RegressionRow {
  /** G-nnn. */
  id: string;
  case: string;
  source: string;
  quote: string;
}

export interface CanonPassage {
  /** world/current-relative file. */
  file: string;
  /** Verbatim. */
  text: string;
}

/** A fact-status.json entry. */
export interface FactStatusEntry {
  id: string;
  status: FactStatus;
  rows: string[];
}

/** The cell in its committed file shape (snake_case; `parseCell(brief.cell)` gives a Cell). */
export interface CellJson {
  id: string;
  row_id: string;
  title: string;
  entity: string;
  time: string;
  layers: string[];
  setting_notes: string[];
  protagonists: string[];
  forbidden: string[];
  stances: Stance[];
}

/** `rounds/RNN/brief.json` (written as is by writeJson). */
export interface BriefJson {
  round: string;
  kind: 'round';
  row_id: string;
  layer: string;
  topic_source: TopicSource;
  cell: CellJson;
  canon: { revision: string; book_sha256: string; reference_sha256: string };
  canon_passages: CanonPassage[];
  facts: FactRow[];
  regression: RegressionRow[];
  /** Regression ids whose quote no longer occurs in the canon (flagged, not offered). */
  regression_stale: string[];
  /** The cell's forbidden moves. */
  forbidden: string[];
  /** Benchmark cliché list minus entries that occur in the canon. */
  cliches: string[];
  /** Positive requirements (Chinese lines). */
  requirements: string[];
  interface_requirements: string[];
  /** Row primary + aliases (Rxx touching, skin-swap). */
  aliases: string[];
  seed: string;
  created_at: string;
}

export interface BriefInput {
  round: string;
  seed: string;
  topic: Topic;
  cell: Cell;
  /** inputs.ts canonFiles(repo) plus `reference/REFERENCE.md` (hashed into `canon.reference_sha256`, used by the cliché and regression checks, never a passage). */
  canon: Record<string, string>;
  revision: string;
  factStatus: readonly FactStatusEntry[];
  /** map/aliases.json entries, plus map/rows.json rows in the same shape (first_quote unused here). */
  aliases: readonly Alias[];
  /** Raw regression items {id, case, source, quote} before re-verification. */
  regression: readonly RegressionRow[];
  cliches: readonly string[];
  createdAt: string;
}


/** The 07 file (reference-relative key of canonFiles). */
export const REF_07 = 'reference/07-register-and-creation.md';
/** Canon passage budget: whole blocks in file order until one more would pass it. */
export const PASSAGE_BUDGET_CHARS = 20_000;

export const REQUIREMENT_REUSE = '复用至少一件正典里已有的物件或习俗。';
export const REQUIREMENT_CHARACTER = '让至少一位正典已有的具名人物出场（可以就是主角）。';
export const REQUIREMENT_SENSES = '至少写到两种非视觉的感官（声音、气味、触感、温度、味道等）。';

export const INTERFACE_REQUIREMENTS: readonly string[] = [
  'shots 三个：地点（行 ID 或舰上空间类型；母舰现场必须对应已有概念页，否则写“新空间·需概念任务”，且不得登记为作者事实）、时间与光源、景别与视点高度、主体人物与动作、尺度参照物、3 个材质或色彩词、禁画项（如星门、即时星际通信、跃迁中交战）。',
  'object 一件：名称、位置、至少 2 个玩家动词、至少 2 个状态、使用权限归谁、拒绝或失败之后的结果。',
  'hook 一个：玩家不来时何时自行发生什么（07 §7.4）、需要谁同意、至少 2 个选项且含拒绝、消耗与义务由谁承担、回到母舰后留下什么、玩法类型只能是 经营 / 战略与战斗 / 探索 / 生成支线（不得是固定主线）。',
  '尺寸、容量、舱段位置不得写成作者事实，它们属于概念设计。',
];

/** Stances of a topic cell (UI or auto_default topics have no cell file): the four of the Latin square. */
export const DEFAULT_STANCES: readonly Stance[] = [
  { id: 'resident-day', text: '居民的一天：跟着主角过完这一天里最普通、也最要紧的几个时刻。' },
  { id: 'object-history', text: '物件的来历：从一件物件写起，让它的来历和用法把人和地方带出来。' },
  { id: 'outsider-first-visit', text: '外来者初访：透过一位初来者第一次走进这里的眼睛来写。' },
  { id: 'counter-consequence', text: '反直觉后果：从一条既有规则出发，写出它在这里带来的一个意外后果。' },
];

/** Forbidden moves of a topic cell: the protocol's standing defect targets and the concept-track rule. */
export const DEFAULT_FORBIDDEN: readonly string[] = [
  '出现早于先遣队的人工痕迹',
  '出现未登记的第三方势力',
  '把舰队编成、舰体尺寸、载具数量、武器性能、生态产率等数字写成作者事实',
];

const F_ROW = /^\|\s*(F\d{2})\s*\|([^|]*)\|/u;
const R_ROW = /^\|\s*(R\d{2}-\d{2})\s*\|(.*)\|\s*$/u;
const PASSAGE_FILE = /^reference\/(\d{2})-[^/]+\.md$/u;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function isFactStatus(value: string): value is FactStatus {
  return FACT_STATUSES.some((s) => s === value);
}

function nfkc(text: string): string {
  return text.normalize('NFKC');
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

/** Lines of one `## N.` section of a Markdown file. */
function sectionLines(text: string, n: number): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith('## ')) inside = new RegExp(`^## ${n}\\.\\s`, 'u').test(line);
    else if (inside) out.push(line);
  }
  return out;
}

/** 07 §2 rows: `| F01 | 事实与地位 | 关联条目 | 容易造成的错误 |` → {id, text}. */
export function factTable07(text: string): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  for (const line of sectionLines(text, 2)) {
    const m = F_ROW.exec(line);
    const id = m?.[1];
    const fact = m?.[2]?.trim();
    if (id !== undefined && fact !== undefined && fact !== '') out.push({ id, text: fact });
  }
  return out;
}

/** 07 §8 rows: `| R-ID | 行 | 事实 | 地位 | 挂靠 | 延伸自 | 误用 | 来源 |` → {id, rowId, claim, status}. */
export function registered07(text: string): Array<{ id: string; rowId: string; claim: string; status: string }> {
  const out: Array<{ id: string; rowId: string; claim: string; status: string }> = [];
  for (const line of sectionLines(text, 8)) {
    const m = R_ROW.exec(line);
    const id = m?.[1];
    const cells = m?.[2]?.split('|').map((c) => c.trim()) ?? [];
    const [rowId, claim, status] = cells;
    if (id !== undefined && rowId !== undefined && claim !== undefined && status !== undefined) out.push({ id, rowId, claim, status });
  }
  return out;
}

/** Primary names and aliases of a row across every alias entry for it (map/aliases.json and map/rows.json). */
export function rowNames(rowId: string, aliases: readonly Alias[]): string[] {
  const names: string[] = [];
  for (const a of aliases) if (a.row_id === rowId) names.push(a.primary, ...a.aliases);
  return unique(names.map((n) => n.trim()).filter((n) => n !== ''));
}

/** BOOK.md and the numbered reference files except 07 (the fact table travels as `facts`), in key order. */
function passageFiles(canon: Readonly<Record<string, string>>): string[] {
  return Object.keys(canon)
    .filter((k) => k === 'BOOK.md' || (PASSAGE_FILE.test(k) && !k.startsWith('reference/07-')))
    .sort(byCodeUnit);
}

/** Verbatim runs of consecutive prose lines (no headings, tables or blank lines) of one file. */
function proseRuns(text: string): string[] {
  const runs: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length > 0) runs.push(run.join('\n'));
    run = [];
  };
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('#') || t.startsWith('|')) flush();
    else run.push(line);
  }
  flush();
  return runs;
}

/**
 * Verbatim canon passages for the entity: prose runs of BOOK.md and reference 01–06, 08+ that name the row
 * (primary or alias) or one of the cell's protagonists, in file order, within PASSAGE_BUDGET_CHARS.
 */
export function canonPassages(canon: Readonly<Record<string, string>>, names: readonly string[], budget = PASSAGE_BUDGET_CHARS): CanonPassage[] {
  const needles = unique(names.map((n) => n.trim()).filter((n) => n !== ''));
  const out: CanonPassage[] = [];
  let used = 0;
  for (const file of passageFiles(canon)) {
    for (const text of proseRuns(canon[file] ?? '')) {
      if (!needles.some((n) => text.includes(n))) continue;
      const size = [...text].length;
      if (used + size > budget) continue;
      used += size;
      out.push({ file, text });
    }
  }
  return out;
}

function cellJson(cell: Cell): CellJson {
  return {
    id: cell.id,
    row_id: cell.rowId,
    title: cell.title,
    entity: cell.entity,
    time: cell.time,
    layers: [...cell.layers],
    setting_notes: [...cell.settingNotes],
    protagonists: [...cell.protagonists],
    forbidden: [...cell.forbidden],
    stances: cell.stances.map((st) => ({ id: st.id, text: st.text })),
  };
}

/** Positive requirements (Chinese, writer-facing). */
export function briefRequirements(cell: Cell): string[] {
  const who = cell.protagonists.length > 0 ? `从 ${cell.protagonists.join(' / ')} 中选一位作为具名主角` : '一个具名主角';
  return [REQUIREMENT_REUSE, REQUIREMENT_CHARACTER, `${who}：写出他/她此刻想要什么、为此付出什么代价。`, REQUIREMENT_SENSES];
}

/** Inconsistent inputs buildBrief refuses (02a turns them into `failed`). */
export function briefInputProblems(input: BriefInput): string[] {
  const problems: string[] = [];
  if (input.cell.rowId !== input.topic.row_id) problems.push(`cell ${input.cell.id} is for row ${input.cell.rowId}, the topic for ${input.topic.row_id}`);
  if (input.topic.round !== input.round) problems.push(`topic.json is for ${input.topic.round}`);
  const ref07 = input.canon[REF_07];
  if (ref07 === undefined) problems.push(`${REF_07} missing from the canon`);
  const table = factTable07(ref07 ?? '');
  if (ref07 !== undefined && table.length === 0) problems.push('07 §2 has no F-ID rows');
  const statusIds = new Set(input.factStatus.map((f) => f.id));
  for (const f of table) if (!statusIds.has(f.id)) problems.push(`fact-status.json has no entry for ${f.id}`);
  for (const r of registered07(ref07 ?? '')) if (!isFactStatus(r.status)) problems.push(`07 §8 ${r.id}: status ${r.status} is not one of the four 07 §1 statuses`);
  if (input.canon['BOOK.md'] === undefined) problems.push('BOOK.md missing from the canon');
  if (input.canon['reference/REFERENCE.md'] === undefined) problems.push('reference/REFERENCE.md missing from the canon');
  return problems;
}

/**
 * Pure: 07 §2 ⋈ fact-status, every 07 §8 Rxx touching the row (its row_id, or a claim naming the row), verbatim
 * canon passages, requirements, the cliché list minus entries found in the canon (NFKC), regression quotes
 * re-verified as canon substrings (the rest listed as stale). Throws on inputs briefInputProblems reports.
 */
export function buildBrief(input: BriefInput): BriefJson {
  const problems = briefInputProblems(input);
  if (problems.length > 0) throw new Error(`buildBrief: ${problems.join('; ')}`);
  const ref07 = input.canon[REF_07] ?? '';
  const statusById = new Map(input.factStatus.map((f) => [f.id, f]));
  const facts: FactRow[] = [];
  for (const f of factTable07(ref07)) {
    const entry = statusById.get(f.id);
    if (entry !== undefined) facts.push({ id: f.id, kind: 'fact', text: f.text, status: entry.status, rows: [...entry.rows] });
  }
  const rowId = input.topic.row_id;
  const names = rowNames(rowId, input.aliases);
  for (const r of registered07(ref07)) {
    if (!isFactStatus(r.status)) continue;
    if (r.rowId === rowId || names.some((n) => r.claim.includes(n))) facts.push({ id: r.id, kind: 'registered', text: r.claim, status: r.status, rows: [r.rowId] });
  }
  const canonText = nfkc(Object.keys(input.canon).sort(byCodeUnit).map((k) => input.canon[k] ?? '').join('\n'));
  const live = input.regression.filter((q) => q.quote.trim() !== '' && canonText.includes(nfkc(q.quote)));
  const cliches = unique(input.cliches.map((c) => c.trim()).filter((c) => c !== '' && !canonText.includes(nfkc(c))));
  return {
    round: input.round,
    kind: 'round',
    row_id: rowId,
    layer: input.topic.layer,
    topic_source: input.topic.source,
    cell: cellJson(input.cell),
    canon: { revision: input.revision, book_sha256: sha256(input.canon['BOOK.md'] ?? ''), reference_sha256: sha256(input.canon['reference/REFERENCE.md'] ?? '') },
    canon_passages: canonPassages(input.canon, [...names, ...input.cell.protagonists]),
    facts,
    regression: live.map((q) => ({ id: q.id, case: q.case, source: q.source, quote: q.quote })),
    regression_stale: input.regression.filter((q) => !live.includes(q)).map((q) => q.id),
    forbidden: [...input.cell.forbidden],
    cliches,
    requirements: briefRequirements(input.cell),
    interface_requirements: [...INTERFACE_REQUIREMENTS],
    aliases: names,
    seed: input.seed,
    created_at: input.createdAt,
  };
}

/**
 * The cell of a topic without a cell file (UI or auto_default): the row as entity, the topic layer, the four
 * default stances and forbidden moves; protagonists = character aliases named in the row's canon passages (≤ 4).
 */
export function topicCell(topic: Topic, aliases: readonly Alias[], canon: Readonly<Record<string, string>>): Cell {
  const names = rowNames(topic.row_id, aliases);
  const primary = names[0] ?? topic.row_id;
  const layer = LAYERS.find((l) => l === topic.layer);
  const label = layer === undefined ? topic.layer : LAYER_LABELS[layer];
  const passages = canonPassages(canon, names).map((p) => p.text);
  const protagonists = unique(aliases.filter((a) => a.kind === 'character' && passages.some((t) => t.includes(a.primary))).map((a) => a.primary)).slice(0, 4);
  return {
    id: `${topic.round}-${topic.row_id}-${topic.layer}`,
    rowId: topic.row_id,
    title: `${primary} · ${label}`,
    entity: primary,
    time: '正典当前时间线内的任一常态日',
    layers: [label],
    settingNotes: [`本轮要补厚的层：${label}`],
    protagonists,
    forbidden: [...DEFAULT_FORBIDDEN],
    stances: DEFAULT_STANCES.map((st) => ({ ...st })),
  };
}

function strings(value: unknown, key: string): string[] | null {
  return isRecord(value) ? stringArray(value[key]) : null;
}

function parseCellJson(value: unknown): Result<CellJson> {
  const parsed = parseCell(value);
  if (!parsed.ok) return err(`brief.cell: ${parsed.error}`);
  return ok(cellJson(parsed.value));
}

function parseFactRows(list: readonly unknown[]): Result<FactRow[]> {
  const out: FactRow[] = [];
  for (const [i, f] of list.entries()) {
    const id = readString(f, 'id');
    const kind = readString(f, 'kind');
    const text = readString(f, 'text');
    const status = readString(f, 'status');
    const rows = strings(f, 'rows');
    if (id === null || text === null || rows === null || (kind !== 'fact' && kind !== 'registered')) return err(`brief.facts[${i}]: id, kind, text and rows are required`);
    if (status === null || !isFactStatus(status)) return err(`brief.facts[${i}].status: not one of the four 07 §1 statuses`);
    out.push({ id, kind, text, status, rows });
  }
  return ok(out);
}

function parseRegressionRows(list: readonly unknown[]): Result<RegressionRow[]> {
  const out: RegressionRow[] = [];
  for (const [i, q] of list.entries()) {
    const id = readString(q, 'id');
    const c = readString(q, 'case');
    const source = readString(q, 'source');
    const quote = readString(q, 'quote');
    if (id === null || c === null || source === null || quote === null) return err(`brief.regression[${i}]: id, case, source and quote are required`);
    out.push({ id, case: c, source, quote });
  }
  return ok(out);
}

function parsePassages(list: readonly unknown[]): Result<CanonPassage[]> {
  const out: CanonPassage[] = [];
  for (const [i, p] of list.entries()) {
    const file = readString(p, 'file');
    const text = readString(p, 'text');
    if (file === null || text === null) return err(`brief.canon_passages[${i}]: file and text are required`);
    out.push({ file, text });
  }
  return ok(out);
}

function topicSourceOf(value: string | null): TopicSource | null {
  return value === 'ui' || value === 'auto_default' || value === 'fixed' ? value : null;
}

/** Narrows `rounds/RNN/brief.json` (kind "round"; the prototype's kind "prototype" briefs are refused). */
export function parseBrief(value: unknown): Result<BriefJson> {
  if (!isRecord(value)) return err('brief: expected an object');
  if (value['kind'] !== 'round') return err('brief.kind: expected "round"');
  const round = readString(value, 'round');
  const rowId = readString(value, 'row_id');
  const layer = readString(value, 'layer');
  const source = topicSourceOf(readString(value, 'topic_source'));
  const seed = readString(value, 'seed');
  const createdAt = readString(value, 'created_at');
  if (round === null || !/^[A-Z]\d{2}$/u.test(round) || rowId === null || layer === null || seed === null || createdAt === null) {
    return err('brief: round, row_id, layer, seed and created_at are required');
  }
  if (source === null) return err('brief.topic_source: expected ui, auto_default or fixed');
  const canonRec = readRecord(value, 'canon');
  const revision = readString(canonRec, 'revision');
  const book = readString(canonRec, 'book_sha256');
  const reference = readString(canonRec, 'reference_sha256');
  if (revision === null || book === null || reference === null) return err('brief.canon: revision, book_sha256 and reference_sha256 are required');
  const cell = parseCellJson(value['cell']);
  if (!cell.ok) return err(cell.error);
  const passages = parsePassages(readArray(value, 'canon_passages') ?? [null]);
  if (!passages.ok) return err(passages.error);
  const facts = parseFactRows(readArray(value, 'facts') ?? [null]);
  if (!facts.ok) return err(facts.error);
  const regression = parseRegressionRows(readArray(value, 'regression') ?? [null]);
  if (!regression.ok) return err(regression.error);
  const lists: Record<string, string[] | null> = {
    regression_stale: strings(value, 'regression_stale'),
    forbidden: strings(value, 'forbidden'),
    cliches: strings(value, 'cliches'),
    requirements: strings(value, 'requirements'),
    interface_requirements: strings(value, 'interface_requirements'),
    aliases: strings(value, 'aliases'),
  };
  for (const [key, list] of Object.entries(lists)) if (list === null) return err(`brief.${key}: expected a string array`);
  return ok({
    round,
    kind: 'round',
    row_id: rowId,
    layer,
    topic_source: source,
    cell: cell.value,
    canon: { revision, book_sha256: book, reference_sha256: reference },
    canon_passages: passages.value,
    facts: facts.value,
    regression: regression.value,
    regression_stale: lists['regression_stale'] ?? [],
    forbidden: lists['forbidden'] ?? [],
    cliches: lists['cliches'] ?? [],
    requirements: lists['requirements'] ?? [],
    interface_requirements: lists['interface_requirements'] ?? [],
    aliases: lists['aliases'] ?? [],
    seed,
    created_at: createdAt,
  });
}

/** Forge-root-relative inputs of 02a (hashed into its marker; the canon is pinned inside brief.json instead). */
export const FACT_STATUS_FILE = 'fact-status.json';
export const REGRESSION_FILE = 'regression/wb-b1.json';
export const ROWS_FILE = 'map/rows.json';
export const ALIASES_FILE = 'map/aliases.json';

/** null = absent; err = unreadable or not JSON (forge-root-relative names only: errors can reach status.json). */
function readJsonAt(root: string, rel: string): Result<unknown> | null {
  const path = join(root, rel);
  if (!existsSync(path)) return null;
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return ok(v);
  } catch {
    return err(`${rel}: not valid JSON`);
  }
}

/** map/rows.json (required). */
export function loadRows(root: string): Result<Row[]> {
  const raw = readJsonAt(root, ROWS_FILE);
  if (raw === null) return err(`${ROWS_FILE} missing`);
  if (!raw.ok) return err(raw.error);
  const rows = parseRows(raw.value);
  return rows.ok ? rows : err(`${ROWS_FILE}: ${rows.error}`);
}

/** map/aliases.json; [] while it does not exist (F1-05 writes it). */
export function loadAliasFile(root: string): Result<Alias[]> {
  const raw = readJsonAt(root, ALIASES_FILE);
  if (raw === null) return ok([]);
  if (!raw.ok) return err(raw.error);
  const parsed = parseAliases(raw.value);
  return parsed.ok ? parsed : err(`${ALIASES_FILE}: ${parsed.error}`);
}

/** map/aliases.json plus every map/rows.json row in the Alias shape (first_quote unused by the brief). */
export function loadRowAliases(root: string): Result<Alias[]> {
  const rows = loadRows(root);
  if (!rows.ok) return err(rows.error);
  const listed = loadAliasFile(root);
  if (!listed.ok) return err(listed.error);
  const fromRows: Alias[] = rows.value.map((r) => ({ row_id: r.row_id, kind: r.kind, primary: r.primary, aliases: [...r.aliases], first_quote: { file: ROWS_FILE, quote: '' } }));
  return ok([...listed.value, ...fromRows]);
}

/** fact-status.json facts → entries (every status one of the four 07 §1 statuses). */
export function parseFactStatus(value: unknown): Result<FactStatusEntry[]> {
  const facts = readArray(value, 'facts');
  if (facts === null) return err(`${FACT_STATUS_FILE}: facts must be an array`);
  const out: FactStatusEntry[] = [];
  for (const f of facts) {
    const id = readString(f, 'id');
    const status = readString(f, 'status');
    const rows = strings(f, 'rows');
    if (id === null || rows === null) return err(`${FACT_STATUS_FILE}: every fact needs id and rows`);
    if (status === null || !isFactStatus(status)) return err(`${FACT_STATUS_FILE}: ${id} has no 07 §1 status`);
    out.push({ id, status, rows });
  }
  return ok(out);
}

/** regression/wb-b1.json `{quotes: [{id, case, source, quote}]}`. */
export function parseRegressionFile(value: unknown): Result<RegressionRow[]> {
  const list = readArray(value, 'quotes');
  if (list === null) return err(`${REGRESSION_FILE}: quotes must be an array`);
  const rows = parseRegressionRows(list);
  return rows.ok ? rows : err(`${REGRESSION_FILE}: ${rows.error.replace(/^brief\.regression/u, 'quotes')}`);
}

/** The cliché list of a benchmark file (absent key → []). */
function clicheList(text: string): Result<string[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return err('benchmark: not valid JSON');
  }
  if (!isRecord(raw) || raw['cliche_list'] === undefined) return ok([]);
  const list = stringArray(raw['cliche_list']);
  return list === null ? err('benchmark.cliche_list: expected a string array') : ok(list);
}

/**
 * A failed effective resolution (02a, 02c): no active benchmark → WAIT benchmark_approval; an owner log that needs
 * repair → WAIT owner_log_repair; anything else is an integrity error.
 */
export function benchmarkUnresolved(error: string): StepOutcome {
  if (error === 'no active benchmark') return { kind: 'wait', waitingFor: 'benchmark_approval', detail: '没有生效的基准版本：等待 owner 在基准页查看或批准', inputs: [], outputs: [] };
  if (error.startsWith('owner-log.jsonl needs repair')) return { kind: 'wait', waitingFor: 'owner_log_repair', detail: error, inputs: [], outputs: [] };
  throw new IntegrityError(error);
}

function failed(detail: string): StepOutcome {
  return { kind: 'failed', detail };
}

function need<T>(r: Result<T> | null, missing: string): Result<T> {
  return r === null ? err(missing) : r;
}

/**
 * The round's `brief.json` text and parsed value, the one reader every later step uses (02a is marked before any of
 * them runs): missing, not JSON or invalid → IntegrityError naming only the forge-relative path.
 */
export function readRoundBrief(ctx: StepContext): { text: string; brief: BriefJson } {
  const rel = `rounds/${ctx.roundId}/brief.json`;
  if (!existsSync(ctx.paths.brief)) throw new IntegrityError(`${rel} is missing`);
  const text = readFileSync(ctx.paths.brief, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new IntegrityError(`${rel} is not JSON`);
  }
  const brief = parseBrief(raw);
  if (!brief.ok) throw new IntegrityError(`${rel}: ${brief.error}`);
  return { text, brief: brief.value };
}

export function readBriefJson(ctx: StepContext): BriefJson {
  return readRoundBrief(ctx).brief;
}

/** 02a-brief. */
export const briefStep: StepDef = {
  id: '02a-brief',
  run: async (ctx) => {
    const topic = ctx.owner.topic(ctx.roundId);
    if (topic.state === 'repair') return { kind: 'wait', waitingFor: 'owner_log_repair', detail: topic.detail, inputs: [], outputs: [] };
    if (topic.state !== 'ok') throw new IntegrityError(`rounds/${ctx.roundId}/topic.json: ${topic.state === 'invalid' ? topic.error : topic.state} after 01-topic`);
    const aliases = loadRowAliases(ctx.root);
    if (!aliases.ok) return failed(aliases.error);
    const canon: Record<string, string> = canonFiles(ctx.repo);
    const refPath = join(ctx.repo, 'world', 'current', 'reference', 'REFERENCE.md');
    if (existsSync(refPath)) canon['reference/REFERENCE.md'] = readFileSync(refPath, 'utf8');
    const inputs: string[] = [ctx.files.rel(ctx.paths.topic), FACT_STATUS_FILE, ROWS_FILE, REGRESSION_FILE];
    if (existsSync(join(ctx.root, ALIASES_FILE))) inputs.push(ALIASES_FILE);
    let cell: Cell;
    if (topic.value.cell !== null) {
      const raw = need(readJsonAt(ctx.root, topic.value.cell), `${topic.value.cell} missing`);
      const parsed = raw.ok ? parseCell(raw.value) : raw;
      if (!parsed.ok) return failed(`${topic.value.cell}: ${parsed.error}`);
      cell = parsed.value;
      inputs.push(topic.value.cell);
    } else {
      cell = topicCell(topic.value, aliases.value, canon);
    }
    const manifest = need(readJsonAt(ctx.repo, 'world/current/reference/manifest.json'), 'world/current/reference/manifest.json missing');
    const revision = manifest.ok ? readString(manifest.value, 'revision') : null;
    if (revision === null) return failed('world/current/reference/manifest.json: revision missing');
    const statusRaw = need(readJsonAt(ctx.root, FACT_STATUS_FILE), `${FACT_STATUS_FILE} missing`);
    const factStatus = statusRaw.ok ? parseFactStatus(statusRaw.value) : statusRaw;
    if (!factStatus.ok) return failed(factStatus.error);
    const regressionRaw = need(readJsonAt(ctx.root, REGRESSION_FILE), `${REGRESSION_FILE} missing (F1-06 extracts it)`);
    const regression = regressionRaw.ok ? parseRegressionFile(regressionRaw.value) : regressionRaw;
    if (!regression.ok) return failed(regression.error);
    const bench = activeBenchmark(ctx, 'effective');
    if (!bench.ok) return benchmarkUnresolved(bench.error);
    const cliches = clicheList(bench.value.text);
    if (!cliches.ok) throw new IntegrityError(`${bench.value.path}: ${cliches.error}`);
    inputs.push(bench.value.path);
    const input: BriefInput = {
      round: ctx.roundId,
      seed: ctx.seed(),
      topic: topic.value,
      cell,
      canon,
      revision,
      factStatus: factStatus.value,
      aliases: aliases.value,
      regression: regression.value,
      cliches: cliches.value,
      createdAt: ctx.ports.clock.now(),
    };
    const problems = briefInputProblems(input);
    if (problems.length > 0) return failed(problems.join('; '));
    const out = ctx.files.writeJson(ctx.paths.brief, buildBrief(input));
    return { kind: 'done', inputs: unique(inputs), outputs: [out], external: [] };
  },
};
