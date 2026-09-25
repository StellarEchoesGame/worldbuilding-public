import { isRecord } from '../json.ts';
import { err, ok, type Result } from '../result.ts';
import type { FactRow, ForbiddenRow, RegressionRow } from '../steps/brief.ts';
import type { TaskSpec } from '../task.ts';
import { citedIn, outputBlock, parseFencedJson, quoteSpan, readCapped, mustWrap, spansOverlap, type Span } from './fenced.ts';
import { ROLE_GATE } from './roles.ts';

/**
 * Gate judge for texts (05c, 05d, 10e post-merge gate) and fact sets (10a re-gate), s2 §5 + PROTOCOL §2. Findings
 * are classified by the engine from the pack's FactRows, never by the model: `path_instance` iff `against` names
 * an F-ID (kind `fact`) whose status is 状态与路径实例; every Rxx (kind `registered`, fixture-rxx included) and every
 * G-id is `binding`. A verdict counts as yes iff it has ≥ 1 binding finding.
 */

export interface GatePack {
  /** `text`: an anonymized display text; `fact_set`: rendered claims + their source sentences (10a). */
  subjectKind: 'text' | 'fact_set';
  subject: string;
  facts: FactRow[];
  regression: RegressionRow[];
  /** The brief's forbidden moves (X-ids): what a D3 copy contradicts. */
  forbidden: ForbiddenRow[];
  /** Sentences the mechanical gate flagged as negated forbidden words (may be empty). */
  negatedFlags: string[];
}

export type FindingClass = 'binding' | 'path_instance';

export interface GateFinding {
  /** Verbatim quote of the subject (citedIn ≥ GATE_QUOTE_MIN). */
  quote: string;
  /** A pack fact id, regression id or forbidden-move id. */
  against: string;
  /** ≤ GATE_REASON_MAX chars. */
  reason: string;
  /** Engine classification (classifyFinding), recomputed by the parser on resume. */
  class: FindingClass;
}

export interface GateVerdict {
  /** The model's claim; the parser enforces contradiction ⇔ findings.length > 0. */
  contradiction: boolean;
  findings: GateFinding[];
  /** ≥ 1 binding finding (path-instance findings never make a verdict yes). */
  yes: boolean;
}

/** Both valid verdicts yes → fail; exactly one → split (passes, shown on the card); < 2 valid → unverified (enters taste, flagged). */
export type GateOutcome = 'pass' | 'fail' | 'split' | 'unverified';

export const GATE_MAX_FINDINGS = 8;
export const GATE_QUOTE_MIN = 6;
export const GATE_REASON_MAX = 80;
/** A copy is caught when a binding finding's quoteSpan overlaps the injected span by at least this many normalized chars. */
export const DEFECT_OVERLAP_MIN = 4;

/** Longest accepted quote (code points); a quote is one contradicting passage, not the whole text. */
export const GATE_QUOTE_MAX = 300;
const AGAINST_MAX = 40;
const PATH_INSTANCE = '状态与路径实例';

function factLines(facts: readonly FactRow[]): string {
  return facts.length === 0 ? '（无）' : facts.map((f) => `${f.id}｜${f.status}｜${f.text}`).join('\n');
}

function regressionLines(rows: readonly RegressionRow[]): string {
  return rows.length === 0 ? '（无）' : rows.map((r) => `${r.id}｜${r.case}｜${r.quote}`).join('\n');
}

function forbiddenLines(rows: readonly ForbiddenRow[]): string {
  return rows.length === 0 ? '（无）' : rows.map((r) => `${r.id}｜${r.text}`).join('\n');
}

const SHAPE = {
  contradiction: true,
  findings: [{ quote: `逐字引用的原文，至少 ${GATE_QUOTE_MIN} 个字`, against: 'F01 或 R01-02 或 G-014 或 X01', reason: `不超过 ${GATE_REASON_MAX} 字的理由` }],
};

function gatePrompt(pack: GatePack, id: string, seed: string): string {
  const subjectHead =
    pack.subjectKind === 'text' ? '【待查文本】' : '【待查事实集】（合并后要写入正典的说法，每条附出处句）';
  const flags = pack.negatedFlags.length === 0 ? '（无）' : pack.negatedFlags.map((f) => `- ${f}`).join('\n');
  return [
    '你是事实门评委，只判断下面的文字是否与冻结事实表、回归证据矛盾或写出了禁用写法里的事物，不评价文笔。',
    '',
    subjectHead,
    mustWrap('gate-judge', '文本甲', pack.subject, seed, `${id}:文本甲`),
    '',
    '【冻结事实表】（编号｜地位｜事实）',
    mustWrap('gate-judge', '事实表', factLines(pack.facts), seed, `${id}:事实表`),
    '',
    '【回归证据】（编号｜案例｜证据句）',
    mustWrap('gate-judge', '回归证据', regressionLines(pack.regression), seed, `${id}:回归证据`),
    '',
    '【禁用写法】（编号｜这个世界里不存在或不允许写出的事物）',
    mustWrap('gate-judge', '禁用写法', forbiddenLines(pack.forbidden), seed, `${id}:禁用写法`),
    '',
    '【机械门标记的否定句】（这些句子含被否定的禁用词，请确认它们没有借否定之名写出矛盾）',
    mustWrap('gate-judge', '否定句', flags, seed, `${id}:否定句`),
    '',
    '# 判定规则',
    '1. 只有明确矛盾才算；角色的认识或传闻若被写成事实也算；写出禁用写法里的事物（如未登记的第三方势力）也算矛盾。',
    `2. 每条矛盾逐字引用${pack.subjectKind === 'text' ? '文本甲' : '事实集'}中的原文（至少 ${GATE_QUOTE_MIN} 个字），并在 against 写出所违背条目的编号（只能用上面事实表、回归证据或禁用写法里的编号）。`,
    `3. 最多列 ${GATE_MAX_FINDINGS} 条，理由不超过 ${GATE_REASON_MAX} 字。`,
    '4. 没有矛盾时 contradiction 写 false，findings 写空数组；有矛盾时 contradiction 写 true。',
    '',
    outputBlock(SHAPE),
  ].join('\n');
}

/**
 * The gate-judge TaskSpec (role ROLE_GATE; Chinese prompt: subject wrapped as 〔文本甲〕, 【冻结事实表】 one line per
 * fact `F05｜共同事实｜…`, 【回归证据】 `G-014｜P03｜…`, 【禁用写法】 `X01｜…`, 【机械门标记的否定句】, ending with outputBlock). No retryPrompt
 * (judges retry with the identical prompt). The real text and the defect copy produce prompts identical in form.
 */
export function gateJudgeTask(pack: GatePack, id: string, seed: string): TaskSpec<GateVerdict> {
  return { id, role: ROLE_GATE, prompt: gatePrompt(pack, id, seed), parse: (text) => parseGateVerdict(text, pack) };
}

function parseFinding(raw: unknown, i: number, pack: GatePack, ids: ReadonlySet<string>): Result<GateFinding> {
  const at = `findings[${i}]`;
  if (!isRecord(raw)) return err(`${at}: not an object`);
  const quote = readCapped(raw, 'quote', GATE_QUOTE_MAX);
  if (!quote.ok) return err(`${at}.${quote.error}`);
  if (!citedIn(quote.value, pack.subject, GATE_QUOTE_MIN)) return err(`${at}.quote: not a verbatim quote of the text of at least ${GATE_QUOTE_MIN} chars`);
  const against = readCapped(raw, 'against', AGAINST_MAX);
  if (!against.ok) return err(`${at}.${against.error}`);
  if (!ids.has(against.value)) return err(`${at}.against: not an id of the fact table, the regression list or the forbidden moves`);
  const reason = readCapped(raw, 'reason', GATE_REASON_MAX);
  if (!reason.ok) return err(`${at}.${reason.error}`);
  const f = { quote: quote.value, against: against.value, reason: reason.value };
  return ok({ ...f, class: classifyFinding(f, pack.facts) });
}

/**
 * One fenced json block `{contradiction, findings[≤8]{quote, against, reason}}`; contradiction ⇔ findings > 0;
 * quotes cited in pack.subject (≥ 6); `against` ∈ pack fact ids ∪ regression ids ∪ forbidden-move ids; reason ≤ 80. ASCII errors.
 */
export function parseGateVerdict(text: string, pack: GatePack): Result<GateVerdict> {
  const obj = parseFencedJson(text);
  if (!obj.ok) return err(obj.error);
  const contradiction = obj.value['contradiction'];
  if (typeof contradiction !== 'boolean') return err('contradiction: missing or not a boolean');
  const list = obj.value['findings'];
  if (!Array.isArray(list)) return err('findings: missing or not an array');
  if (list.length > GATE_MAX_FINDINGS) return err(`findings: more than ${GATE_MAX_FINDINGS} entries`);
  if (contradiction !== list.length > 0) return err('contradiction must be true exactly when findings is non-empty');
  const ids = new Set<string>([...pack.facts.map((f) => f.id), ...pack.regression.map((r) => r.id), ...pack.forbidden.map((x) => x.id)]);
  const findings: GateFinding[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const f = parseFinding(list[i], i, pack, ids);
    if (!f.ok) return err(f.error);
    findings.push(f.value);
  }
  return ok({ contradiction, findings, yes: findings.some((f) => f.class === 'binding') });
}

/** path_instance iff `against` is a kind-`fact` row with status 状态与路径实例; everything else (Rxx, G-, X-) binding. */
export function classifyFinding(f: Pick<GateFinding, 'against'>, facts: readonly FactRow[]): FindingClass {
  const row = facts.find((r) => r.id === f.against);
  return row !== undefined && row.kind === 'fact' && row.status === PATH_INSTANCE ? 'path_instance' : 'binding';
}

/**
 * null = void call or voided family (does not count as a valid verdict). The first two valid verdicts decide: both
 * yes → fail, one → split, none → pass; fewer than two valid → unverified.
 */
export function gateOutcome(verdicts: ReadonlyArray<GateVerdict | null>): GateOutcome {
  const valid = verdicts.filter((v): v is GateVerdict => v !== null).slice(0, 2);
  if (valid.length < 2) return 'unverified';
  const yes = valid.filter((v) => v.yes).length;
  return yes === 2 ? 'fail' : yes === 1 ? 'split' : 'pass';
}

/** Yes verdict with a binding finding whose quoteSpan(quote, copy) overlaps `span` by ≥ DEFECT_OVERLAP_MIN. */
export function caughtDefect(v: GateVerdict | null, copy: string, span: Span): boolean {
  if (v === null || !v.yes) return false;
  return v.findings.some((f) => {
    if (f.class !== 'binding') return false;
    const at = quoteSpan(f.quote, copy);
    return at !== null && spansOverlap(at, span, DEFECT_OVERLAP_MIN);
  });
}
