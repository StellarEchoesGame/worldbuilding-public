import { isRecord, readArray, readString, stringArray } from './json.ts';
import { err, ok, type Result } from './result.ts';

export interface Stance {
  id: string;
  text: string;
}

export interface Cell {
  id: string;
  rowId: string;
  title: string;
  entity: string;
  time: string;
  layers: string[];
  settingNotes: string[];
  protagonists: string[];
  forbidden: string[];
  stances: Stance[];
}

export interface Canon {
  book: string;
  reference: string;
  bookSha256: string;
  referenceSha256: string;
}

export const WRITER_ROLE =
  '你是科幻游戏《群星回响》的现场作者。你写的是可以被玩家走进去的“样本现场”：有人、有物、有气味和声音，而不是设定说明。你严格遵守给定正典，只在允许的范围内新增细节。';

export function parseCell(value: unknown): Result<Cell> {
  const id = readString(value, 'id');
  const rowId = readString(value, 'row_id');
  const title = readString(value, 'title');
  const entity = readString(value, 'entity');
  const time = readString(value, 'time');
  const layers = stringArray(isRecord(value) ? value['layers'] : null);
  const settingNotes = stringArray(isRecord(value) ? value['setting_notes'] : null);
  const protagonists = stringArray(isRecord(value) ? value['protagonists'] : null);
  const forbidden = stringArray(isRecord(value) ? value['forbidden'] : null);
  const stanceList = readArray(value, 'stances');
  if (id === null || rowId === null || title === null || entity === null || time === null) return err('cell: id, row_id, title, entity and time are required');
  if (layers === null || settingNotes === null || protagonists === null || forbidden === null || stanceList === null) {
    return err('cell: layers, setting_notes, protagonists, forbidden and stances are required arrays');
  }
  const stances: Stance[] = [];
  for (const s of stanceList) {
    const sid = readString(s, 'id');
    const text = readString(s, 'text');
    if (sid === null || text === null) return err('cell: every stance needs id and text');
    stances.push({ id: sid, text });
  }
  return ok({ id, rowId, title, entity, time, layers, settingNotes, protagonists, forbidden, stances });
}

function list(items: readonly string[]): string {
  return items.map((s) => `- ${s}`).join('\n');
}

function canonBlock(canon: Canon): string {
  return [
    '# 正典（不得违背；下列两份文件是唯一依据）',
    '',
    '<<<BOOK 修订 8 正文',
    canon.book,
    'BOOK>>>',
    '',
    '<<<REFERENCE 参考集 8.1',
    canon.reference,
    'REFERENCE>>>',
  ].join('\n');
}

function taskBlock(cell: Cell): string {
  return [
    `# 任务：${cell.title}`,
    '',
    `- 实体：${cell.entity}`,
    `- 时间：${cell.time}`,
    `- 本次要补厚的层：${cell.layers.join('、')}`,
    '- 背景提示：',
    list(cell.settingNotes),
  ].join('\n');
}

const FORMAT = [
  '# 输出格式（严格只输出下面三个代码块和种子列表，代码块之外不写任何别的话）',
  '',
  '```submission',
  '（现场正文，Markdown，可有一个小标题）',
  '```',
  '```delta',
  '{"new_proper_nouns": ["本文新造的专名"], "claims": [{"id": "A-01", "kind": "author_fact | character_belief | rumor", "claim": "≤40字的一句话", "status": "共同事实 | 已选地方事实 | 状态与路径实例 | 有边界的未知", "row_id": "SHIP", "attaches_to": "挂靠的正典条目，如 04-life-and-people", "extends": "所延伸的正典原句，或 F/R 编号", "misuse": "≤30字：最容易被误用成什么", "source_quote": "正文中逐字出现的一段原文", "register": true}]}',
  '```',
  '```interface',
  '{"shots": [{"地点": "", "时间与光源": "", "景别与视点高度": "", "主体人物与动作": "", "尺度参照物": "", "材质色彩": ["", "", ""], "禁画项": [""]}, {}, {}], "object": {"名称": "", "位置": "", "玩家动词": ["", ""], "状态": ["", ""], "使用权限": "", "拒绝或失败后": ""}, "hook": {"玩家不来时会发生什么": "", "需要谁同意": "", "选项": ["", "拒绝"], "消耗与义务": "", "回到母舰后留下什么": "", "玩法类型": "经营 | 战略与战斗 | 探索 | 生成支线"}}',
  '```',
  '种子：',
  '- （一行：你觉得这个世界下一个值得写的现场）',
  '- （同上）',
  '- （同上）',
].join('\n');

export function writerPrompt(cell: Cell, canon: Canon, stanceId: string): string {
  const stance = cell.stances.find((s) => s.id === stanceId);
  const stanceText = stance === undefined ? '自选写法。' : stance.text;
  return [
    canonBlock(canon),
    '',
    taskBlock(cell),
    '',
    `# 写法立场\n${stanceText}`,
    '',
    '# 硬性要求',
    '1. 正文不超过 2500 字（按字符计，Markdown 标记不计）。',
    `2. 一个具名主角，从 ${cell.protagonists.join(' / ')} 中选一位；写出他/她此刻想要什么、为此付出什么代价。`,
    '3. 至少复用一件正典里已有的物件或习俗，并让至少一位正典已有的具名人物出场（可以就是主角）。',
    '4. 至少写到两种非视觉的感官（声音、气味、触感、温度、味道等）。',
    '5. 新专名不超过 3 个，全部列入 delta 的 new_proper_nouns。',
    '6. 叙述中少用规则句（必须、不能、禁止之类），对白除外；让世界通过人和物显出来，不要写成设定说明。',
    '7. delta 列出正文里所有新增的说法：作者事实 author_fact、角色认识 character_belief、传闻 rumor。register 为 true 的作者事实最多 6 条；没有 extends 的作者事实最多 3 条；source_quote 必须逐字出自正文。',
    '8. 不得违背正典核心事实（参考集 07 §2）：没有星门，跃迁只向前，没有即时星际通信，没有复活，等等。',
    '9. 禁止：',
    list(cell.forbidden),
    '10. 舱室尺寸、容量、舱段位置不能写成作者事实，它们属于概念设计。',
    '',
    FORMAT,
  ].join('\n');
}

export function baselinePrompt(cell: Cell, canon: Canon): string {
  return [
    canonBlock(canon),
    '',
    taskBlock(cell),
    '',
    '# 这是一篇“零新事实基线”',
    '只用正典里已经写明的人、物、习俗和事件来写这个现场。不得新增任何作者事实：不造新专名，不发明新的制度、物件来历或历史。可以写动作、对白和感官，但每一处设定都必须能在正典里找到依据。',
    '',
    '# 硬性要求',
    '1. 正文不超过 2500 字（按字符计，Markdown 标记不计）。',
    `2. 一个具名主角，从 ${cell.protagonists.join(' / ')} 中选一位。`,
    '3. 至少写到两种非视觉的感官。',
    '4. delta 的 claims 里只允许 character_belief；new_proper_nouns 为空。',
    '5. 禁止：',
    list(cell.forbidden),
    '',
    FORMAT,
  ].join('\n');
}
