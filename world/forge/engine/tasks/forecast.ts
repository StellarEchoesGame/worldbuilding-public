import { isRecord } from '../json.ts';
import { err, ok, type Result } from '../result.ts';
import type { BriefJson } from '../steps/brief.ts';
import { TASK_ID, type TaskSpec } from '../task.ts';
import { normalizeForQuote } from '../text.ts';
import { isOneOf, mustWrap, outputBlock, parseFencedJson, readCapped } from './fenced.ts';
import { ROLE_FORECAST } from './roles.ts';
import { briefSections } from './writing.ts';

export type ForecastSlot = '主角' | '愿望' | '代价' | '物件' | '习俗' | '声音' | '气味' | '触感' | '场所细节' | '冲突' | '结局';

/** The engine-owned 11-slot enum. */
export const FORECAST_SLOTS: readonly ForecastSlot[] = ['主角', '愿望', '代价', '物件', '习俗', '声音', '气味', '触感', '场所细节', '冲突', '结局'];

/** Exactly this many forecasts per forecaster. */
export const FORECAST_COUNT = 8;

/** Value length bounds in code points (after trim). */
const VALUE_MIN = 2;
const VALUE_MAX = 40;

export interface Forecast {
  slot: ForecastSlot;
  /** 2–40 code points; values pairwise distinct after normalizeForQuote. */
  value: string;
}

export interface Forecaster {
  backendId: string;
  model: string;
  /** The model equals a writers.json slot model. */
  writerDefault: boolean;
}

/** One fenced ```json block `{"forecasts": [{"slot", "value"}]}`. */
export function parseForecasts(text: string): Result<Forecast[]> {
  const obj = parseFencedJson(text);
  if (!obj.ok) return obj;
  const list = obj.value['forecasts'];
  if (!Array.isArray(list)) return err('forecasts: missing or not an array');
  if (list.length !== FORECAST_COUNT) return err(`forecasts: expected exactly ${FORECAST_COUNT} items, found ${list.length}`);
  const out: Forecast[] = [];
  const seen = new Set<string>();
  for (const [i, item] of list.entries()) {
    const at = `forecasts[${i}]`;
    if (!isRecord(item)) return err(`${at}: not an object`);
    const rawSlot = item['slot'];
    const trimmedSlot = typeof rawSlot === 'string' ? rawSlot.trim() : '';
    if (!isOneOf(trimmedSlot, FORECAST_SLOTS)) return err(`${at}.slot: not one of the ${FORECAST_SLOTS.length} slots`);
    const value = readCapped(item, 'value', VALUE_MAX);
    if (!value.ok) return err(`${at}.${value.error}`);
    if ([...value.value].length < VALUE_MIN) return err(`${at}.value: shorter than ${VALUE_MIN} chars`);
    const key = normalizeForQuote(value.value);
    if (key === '') return err(`${at}.value: no letters or digits`);
    if (seen.has(key)) return err(`${at}.value: duplicates an earlier value after normalization`);
    seen.add(key);
    out.push({ slot: trimmedSlot, value: value.value });
  }
  return ok(out);
}

/** The writer brief without the stance, skill, format rules and output format: the writers' own sections, byte for byte. */
function renderBrief(brief: BriefJson): string {
  const s = briefSections(brief);
  return [s.canon, s.facts, s.task, s.requirements, s.forbidden, s.cliches, s.interface].filter((x) => x !== null).join('\n\n');
}

const TASK_LINES: readonly string[] = [
  '# 任务',
  '在任何人动笔之前，预测按这份简报写出的现场里最可能出现的 8 个具体细节。每个细节给出槽位与取值。',
  `槽位只能从下列选：${FORECAST_SLOTS.join('｜')}。同一槽位可以出现多次。`,
  `取值要具体（不是“一件旧物”，而是“母亲留下的铝饭盒”），每个取值 ${VALUE_MIN}–${VALUE_MAX} 字，8 个取值互不相同。`,
  '你只做预测，不写正文。',
];

/** Task id `forecast-<backendId>`; the writer brief without FORMAT, skills and stance; no retryPrompt. */
export function forecastTask(brief: BriefJson, forecaster: Forecaster): TaskSpec<Forecast[]> {
  const id = `forecast-${forecaster.backendId}`;
  if (!TASK_ID.test(id)) throw new Error(`forecastTask: ${JSON.stringify(id)} is not a task id`);
  const wrapped = mustWrap('forecastTask', '简报', renderBrief(brief), brief.seed, 'forecast:brief');
  const prompt = [
    '# 写作简报（与写手看到的相同，不含写法立场、技能、格式规则与输出格式）',
    wrapped,
    '',
    ...TASK_LINES,
    '',
    outputBlock({ forecasts: [{ slot: '物件', value: `具体细节（${VALUE_MIN}–${VALUE_MAX}字）` }] }),
  ].join('\n');
  return { id, role: ROLE_FORECAST, prompt, parse: parseForecasts };
}
