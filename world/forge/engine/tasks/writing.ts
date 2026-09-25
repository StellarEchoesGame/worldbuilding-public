import { WRITER_ROLE } from '../brief.ts';
import { err, ok, type Result } from '../result.ts';
import { DEFAULT_STANCES, type BriefJson, type FactRow } from '../steps/brief.ts';
import type { TaskSpec } from '../task.ts';
import { charCount, sentenceKey, splitSentences, stripMarkdown } from '../text.ts';
import { parseWriterOutput, type WriterOutput } from '../writer-output.ts';
import { mustWrap } from './fenced.ts';
import { ROLE_BASELINE } from './roles.ts';

/** A skill snapshot inlined into the writer prompt (skills/<name>.md, SHA-256 pinned in freeze.json.skills). */
export interface SkillSnapshot {
  name: string;
  text: string;
}

/** The one Latin-square stance that gets systemic-worldbuilding (DEFAULT_STANCES); every other stance is scene-first. */
export const CONSEQUENCE_STANCE = 'counter-consequence';

export function isConsequenceStance(id: string): boolean {
  return id === CONSEQUENCE_STANCE;
}

/** Epic step 2: the baseline is at most 2,500 characters (after Markdown stripping). */
export const BASELINE_MAX_CHARS = 2500;
export const BASELINE_TASK_ID = 'baseline-BASE';

/** Writer output format (the three fenced blocks parseWriterOutput reads, plus three seed lines). */
const FORMAT = [
  '# 输出格式（严格只输出下面三个代码块和种子列表，代码块之外不写任何别的话）',
  '',
  '```submission',
  '（现场正文，Markdown，可有一个小标题）',
  '```',
  '```delta',
  '{"new_proper_nouns": ["本文新造的专名"], "claims": [{"id": "A-01", "kind": "author_fact | character_belief | rumor", "claim": "≤40字的一句话", "status": "共同事实 | 已选地方事实 | 状态与路径实例 | 有边界的未知", "row_id": "所属行，如 SHIP", "attaches_to": "挂靠的正典条目，如 04-life-and-people", "extends": "所延伸的正典原句，或 F/R 编号", "misuse": "≤30字：最容易被误用成什么", "source_quote": "正文中逐字出现的一段原文", "register": true}]}',
  '```',
  '```interface',
  '{"shots": [{"地点": "", "时间与光源": "", "景别与视点高度": "", "主体人物与动作": "", "尺度参照物": "", "材质色彩": ["", "", ""], "禁画项": [""]}, {}, {}], "object": {"名称": "", "位置": "", "玩家动词": ["", ""], "状态": ["", ""], "使用权限": "", "拒绝或失败后": ""}, "hook": {"玩家不来时会发生什么": "", "需要谁同意": "", "选项": ["", "拒绝"], "消耗与义务": "", "回到母舰后留下什么": "", "玩法类型": "经营 | 战略与战斗 | 探索 | 生成支线"}}',
  '```',
  '种子：',
  '- （一行：你觉得这个世界下一个值得写的现场）',
  '- （同上）',
  '- （同上）',
].join('\n');

function list(items: readonly string[]): string {
  return items.length === 0 ? '- （无）' : items.map((s) => `- ${s}`).join('\n');
}

function canonMaterial(brief: BriefJson): string {
  return brief.canon_passages.map((p) => `【${p.file}】\n${p.text}`).join('\n\n');
}

function factLine(f: FactRow): string {
  return `- ${f.id}（${f.status}）：${f.text}`;
}

function taskBlock(brief: BriefJson): string {
  const c = brief.cell;
  return [
    `# 任务：${c.title}`,
    '',
    `- 实体：${c.entity}`,
    `- 时间：${c.time}`,
    `- 本次要补厚的层：${c.layers.join('、')}`,
    `- 可选主角：${c.protagonists.length === 0 ? '正典中已有的具名人物' : c.protagonists.join(' / ')}`,
    '- 背景提示：',
    list(c.setting_notes),
  ].join('\n');
}

function stanceText(brief: BriefJson, stance: string): string {
  const found = brief.cell.stances.find((s) => s.id === stance) ?? DEFAULT_STANCES.find((s) => s.id === stance);
  return found === undefined ? '自选写法。' : found.text;
}

function skillBlock(skill: SkillSnapshot, seed: string): string {
  return [
    `# 构思方法（技能快照：${skill.name}）`,
    '下面是一份构思方法，只用来帮助你想清楚这个现场；成稿里不要提到它，也不要输出它要求的文件、表格或报告。它举的例子不是本世界的事实，一切以上面的正典和事实表为准。',
    mustWrap('writing', '技能', skill.text, seed, `write:skill:${skill.name}`),
  ].join('\n');
}

/**
 * The brief as writers see it, section by section. Forecasters (tasks/forecast.ts) get these same sections, byte
 * for byte, without the stance, skill, format rules and output format; null = the writer prompt omits it.
 */
export interface BriefSections {
  canon: string;
  facts: string;
  task: string;
  requirements: string;
  forbidden: string;
  cliches: string | null;
  interface: string | null;
}

export function briefSections(brief: BriefJson): BriefSections {
  return {
    canon: ['# 正典摘录（不得违背；下面的正典原文和事实表是唯一依据）', mustWrap('writing', '正典', canonMaterial(brief), brief.seed, 'write:canon')].join('\n'),
    facts: [
      '# 事实表（07 §2 核心事实与本行已登记事实，按括号里的地位理解；状态与路径实例只是一次实例，不能当成普遍规律）',
      brief.facts.length === 0 ? '- （无）' : brief.facts.map(factLine).join('\n'),
    ].join('\n'),
    task: taskBlock(brief),
    requirements: ['# 硬性要求', list(brief.requirements)].join('\n'),
    forbidden: ['# 禁止', list(brief.forbidden)].join('\n'),
    cliches: brief.cliches.length === 0 ? null : ['# 避免的陈词（不是禁令，但会让现场显得套路）', list(brief.cliches)].join('\n'),
    interface: brief.interface_requirements.length === 0 ? null : ['# 玩法接口要求', list(brief.interface_requirements)].join('\n'),
  };
}

/** The writer prompt: brief only (canon passages, fact table, task, stance, requirements) plus the assigned skill. */
function writerPrompt(brief: BriefJson, stance: string, skill: SkillSnapshot | null): string {
  const s = briefSections(brief);
  const parts = [s.canon, '', s.facts, '', s.task, '', `# 写法立场\n${stanceText(brief, stance)}`];
  if (skill !== null) parts.push('', skillBlock(skill, brief.seed));
  parts.push(
    '',
    s.requirements,
    '',
    '# 格式与登记规则',
    '1. 正文不超过 2500 字（按字符计，Markdown 标记不计）。',
    '2. 新专名不超过 3 个，全部列入 delta 的 new_proper_nouns，每个新专名至少出现在两句里。',
    '3. delta 列出正文里所有新增的说法：作者事实 author_fact、角色认识 character_belief、传闻 rumor。register 为 true 的作者事实最多 6 条；没有 extends 的作者事实最多 3 条；source_quote 必须逐字出自正文。',
    '4. 叙述中少用规则句（必须、不能、禁止之类），对白除外；让世界通过人和物显出来，不要写成设定说明。',
    '',
    s.forbidden,
  );
  if (s.cliches !== null) parts.push('', s.cliches);
  if (s.interface !== null) parts.push('', s.interface);
  parts.push('', FORMAT);
  return parts.join('\n');
}

function retryWith(prompt: string): (error: string) => string {
  return (error) => `${prompt}\n\n# 上一次输出未通过校验\n错误：${error}\n请针对这个错误完整重写，仍然严格按上面的输出格式作答。`;
}

/**
 * Writer task (s2 §3.1): role WRITER_ROLE, task id `write-<slot>` (resubmission: slot `W1-r2`; the prompt does not
 * depend on the slot, so a blind resubmission sends the identical prompt, no gate feedback); parse =
 * parseWriterOutput; retryPrompt quotes the validation error.
 */
export function writerTask(brief: BriefJson, slot: string, stance: string, skill: SkillSnapshot | null): TaskSpec<WriterOutput> {
  const prompt = writerPrompt(brief, stance, skill);
  return { id: `write-${slot}`, role: WRITER_ROLE, prompt, parse: parseWriterOutput, retryPrompt: retryWith(prompt) };
}

/** Canon sentences a baseline may use: the brief's passages split by the shared splitter, deduplicated by sentenceKey. */
export function canonSentences(brief: BriefJson): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of brief.canon_passages) {
    for (const s of splitSentences(stripMarkdown(p.text))) {
      const key = sentenceKey(s);
      if (!/[\p{L}\p{N}]/u.test(s) || seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

function sentenceNo(i: number): string {
  return `〔C${String(i + 1).padStart(3, '0')}〕`;
}

/**
 * The strict baseline check (plan §11 #1): at most BASELINE_MAX_CHARS characters, no new proper noun, only
 * character_belief claims, and every sentence — after removing at most one leading protocol connective — equal
 * (sentenceKey) to one of `sentences`. Errors are ASCII and name sentence positions, never model text.
 */
export function checkBaseline(out: WriterOutput, sentences: readonly string[], connectives: readonly string[]): Result<WriterOutput> {
  const chars = charCount(out.submission);
  if (chars > BASELINE_MAX_CHARS) return err(`submission has ${chars} characters, over ${BASELINE_MAX_CHARS}`);
  if (out.delta.newProperNouns.length > 0) return err(`new_proper_nouns must be empty, got ${out.delta.newProperNouns.length}`);
  const notBelief = out.delta.claims.filter((c) => c.kind !== 'character_belief');
  if (notBelief.length > 0) return err(`delta claims must all be character_belief; ${notBelief.length} claim(s) are author_fact or rumor`);
  const canon = new Set(sentences.map(sentenceKey));
  const joints = connectives.map(sentenceKey).filter((c) => c !== '');
  const body = splitSentences(stripMarkdown(out.submission)).filter((s) => /[\p{L}\p{N}]/u.test(s));
  if (body.length === 0) return err('submission has no sentence');
  const bad: number[] = [];
  body.forEach((s, i) => {
    const key = sentenceKey(s);
    const hit = canon.has(key) || joints.some((c) => key.startsWith(c) && canon.has(key.slice(c.length)));
    if (!hit) bad.push(i + 1);
  });
  if (bad.length > 0) {
    const shown = bad.slice(0, 8).join(', ');
    return err(`${bad.length} of ${body.length} sentences are not verbatim numbered canon sentences (sentence ${shown}${bad.length > 8 ? ', ...' : ''})`);
  }
  return ok(out);
}

function baselinePrompt(brief: BriefJson, sentences: readonly string[], connectives: readonly string[]): string {
  const numbered = sentences.map((s, i) => `${sentenceNo(i)}${s}`).join('\n');
  const c = brief.cell;
  return [
    '# 带编号的正典句子（唯一的材料）',
    mustWrap('writing', '正典句', numbered, brief.seed, 'baseline:sentences'),
    '',
    taskBlock(brief),
    '',
    '# 这是一篇“零新事实基线”',
    '正文的每一句都必须逐字取自上面带编号的正典句子：可以挑选、重新排序、分段；每句句首最多加下列连接词中的一个；不得改写、合并、拆分或新增任何句子，不加标题，不写句子编号。',
    `可用连接词：${connectives.length === 0 ? '（无）' : connectives.join(' ')}`,
    '',
    '# 硬性要求',
    `1. 正文不超过 ${BASELINE_MAX_CHARS} 字（按字符计，Markdown 标记不计）。`,
    `2. 如果正典句子里出现了 ${c.protagonists.length === 0 ? '具名人物' : c.protagonists.join(' / ')} 中的某一位，尽量让这位人物所在的句子构成现场的主线。`,
    '3. delta 的 new_proper_nouns 必须为空；claims 只允许 character_belief，没有就留空数组。',
    '4. interface 按格式填写，只使用正文里已有的人、物和地点。',
    '5. 禁止：',
    list(brief.forbidden),
    '',
    FORMAT,
  ].join('\n');
}

/**
 * Baseline task (s2 §3.2): id `baseline-BASE` (step reruns override it with `-t<n>`); every sentence a verbatim
 * numbered canon sentence (≤ 1 protocol connective), ≤ 2,500 chars, delta only character_belief; retryPrompt
 * quotes the validation error. `connectives` = PROTOCOL.md `protocol:connectives`.
 */
export function baselineTask(brief: BriefJson, sentences: readonly string[], connectives: readonly string[]): TaskSpec<WriterOutput> {
  const prompt = baselinePrompt(brief, sentences, connectives);
  return {
    id: BASELINE_TASK_ID,
    role: ROLE_BASELINE,
    prompt,
    parse: (text) => {
      const parsed = parseWriterOutput(text);
      return parsed.ok ? checkBaseline(parsed.value, sentences, connectives) : parsed;
    },
    retryPrompt: retryWith(prompt),
  };
}
