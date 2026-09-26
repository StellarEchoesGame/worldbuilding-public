import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { readEnvValue } from '../../../../engine/adapters/gateway.ts';
import { expandHome, familyOf, loadConfig, type Family, type JudgeSpec, type LocalConfig, type PrefixRule, type WriterSlot } from '../../../../engine/config.ts';
import { parsePrices } from '../../../../engine/cost.ts';
import { readArray, readString } from '../../../../engine/json.ts';
import { readJson } from '../../../../engine/store.ts';
import { redactRoot } from '../data.ts';
import { writersLock } from '../writers-config.ts';

/** One writer slot (writers.json slots[] or baseline) with its family by families.json prefixes. */
export interface SlotView {
  id: string;
  model: string;
  family: Family | null;
  warning: string | null;
}

export interface GatewayModel {
  id: string;
  family: Family | null;
  warning: string | null;
}

/** Model list of the gateway; errors are redacted (the gateway host never reaches the page). */
export type ModelList = { ok: true; models: GatewayModel[] } | { ok: false; error: string };

/** The part of fetch the model-list call uses (injectable for tests; production passes globalThis.fetch). */
export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Contract: the 配置 page waits at most 5 s for the gateway model list; the timeout notice derives its seconds from this. */
export const MODEL_LIST_TIMEOUT_MS = 5000;

export interface ConfigPageView {
  writers: { present: boolean; slots: SlotView[]; baseline: SlotView | null; error: string | null };
  /** judges.json, read-only. */
  judges: { present: boolean; list: JudgeSpec[]; error: string | null };
  /** local.json presence only (never its values). */
  local: { present: boolean; error: string | null };
  /** prices.json per_million entries. */
  prices: { present: boolean; models: Array<{ model: string; input: number; output: number }>; error: string | null };
  judgeFamilies: Family[];
  /** Why writers.json cannot change now (a round between freeze and done pins it), else null. */
  locked: string | null;
}

/** null = fine; 未知家族 when no prefix matches; a warning when the family is a judge family (its judges sit out). */
export function familyWarning(model: string, prefixes: readonly PrefixRule[], judgeFamilies: readonly Family[]): string | null {
  const family = familyOf(model, prefixes);
  if (family === null) return '未知家族：families.json 没有匹配的前缀，引擎无法判断哪些评委要回避。';
  if (judgeFamilies.includes(family)) return `${family} 也是评委或维护者家族：这个家族的评委在该写手的配对里回避，有效评委会变少。`;
  return null;
}

function message(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return '超时';
  const cause = e.cause instanceof Error ? `（${e.cause.message}）` : '';
  return `${e.message}${cause}`;
}

/** Replaces the gateway URL, host, host name and key in `text`. */
function redact(text: string, baseUrl: string, key: string | null): string {
  let out = text;
  const secrets: string[] = [baseUrl];
  try {
    const url = new URL(baseUrl);
    secrets.push(url.host, url.hostname);
  } catch {
    // not a URL: the base string itself is replaced
  }
  if (key !== null && key !== '') secrets.push(key);
  for (const s of secrets.filter((x) => x !== '').sort((a, b) => b.length - a.length)) out = out.split(s).join(s === key ? '<key>' : '<gateway>');
  return out;
}

/**
 * GET `<local.gatewayBaseUrl>/v1/models` with `Authorization: Bearer <readEnvValue(expandHome(env_file), key_var)>`,
 * aborted after `timeoutMs`; OpenAI list shape `{data: [{id}]}`, ids sorted; every error string has the host replaced.
 */
export async function gatewayModels(local: LocalConfig, prefixes: readonly PrefixRule[], judgeFamilies: readonly Family[], fetchImpl: FetchLike, timeoutMs: number): Promise<ModelList> {
  const key = readEnvValue(expandHome(local.gatewayEnvFile), local.gatewayKeyVar);
  if (key === null || key === '') return { ok: false, error: `读不到网关密钥（local.json gateway.env_file 里没有 ${local.gatewayKeyVar}）。` };
  let body: unknown;
  try {
    const res = await fetchImpl(`${local.gatewayBaseUrl}/v1/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, error: `网关模型列表返回 HTTP ${res.status}。` };
    body = await res.json();
  } catch (e) {
    const why = message(e);
    return { ok: false, error: why === '超时' ? `网关 ${Math.round(timeoutMs / 100) / 10} 秒内没有返回模型列表。` : `连不上网关：${redact(why, local.gatewayBaseUrl, key)}` };
  }
  const data = readArray(body, 'data');
  if (data === null) return { ok: false, error: '网关模型列表的格式不对（缺少 data[]）。' };
  const ids = [...new Set(data.map((m) => readString(m, 'id')).filter((id): id is string => id !== null && id !== ''))].sort();
  return { ok: true, models: ids.map((id) => ({ id, family: familyOf(id, prefixes), warning: familyWarning(id, prefixes, judgeFamilies) })) };
}

function slotView(slot: WriterSlot, prefixes: readonly PrefixRule[], judgeFamilies: readonly Family[]): SlotView {
  return { id: slot.id, model: slot.model, family: familyOf(slot.model, prefixes), warning: familyWarning(slot.model, prefixes, judgeFamilies) };
}

function pricesView(root: string): ConfigPageView['prices'] {
  const file = join(root, 'prices.json');
  if (!existsSync(file)) return { present: false, models: [], error: null };
  const parsed = parsePrices(readJson(file));
  if (!parsed.ok) return { present: true, models: [], error: parsed.error };
  const models = Object.entries(parsed.value).map(([model, p]) => ({ model, input: p.input, output: p.output })).sort((a, b) => (a.model < b.model ? -1 : 1));
  return { present: true, models, error: null };
}

export function configView(root: string): ConfigPageView {
  const cfg = loadConfig(root, { requireLocal: false });
  const localPresent = existsSync(join(root, 'local.json'));
  const view: ConfigPageView = {
    writers: { present: existsSync(join(root, 'writers.json')), slots: [], baseline: null, error: null },
    judges: { present: existsSync(join(root, 'judges.json')), list: [], error: null },
    local: { present: localPresent, error: null },
    prices: pricesView(root),
    judgeFamilies: [],
    locked: writersLock(root),
  };
  if (!cfg.ok) {
    // local.json errors can quote its content (the gateway host): never shown.
    const error = redactRoot(cfg.error, root);
    if (error.startsWith('local.json')) view.local.error = 'local.json 无法解析（内容不显示）；写手、评委和模型列表要等它修好后才能读出。';
    else if (error.startsWith('judges.json')) view.judges.error = error;
    else view.writers.error = error;
    return view;
  }
  const c = cfg.value;
  const families: Family[] = [];
  for (const j of [...c.judges, c.maintainer, c.mergeEditor]) if (!families.includes(j.family)) families.push(j.family);
  view.judgeFamilies = families;
  view.judges.list = [...c.judges, c.maintainer, c.mergeEditor];
  view.writers.slots = c.slots.map((s) => slotView(s, c.prefixes, families));
  view.writers.baseline = slotView(c.baseline, c.prefixes, families);
  return view;
}

/**
 * The 配置 page's model list: gatewayModels over local.json (env_file resolved against the forge root when relative),
 * or ok false with the reason (no local.json, config unreadable) — the page then shows an empty list and the notice.
 */
export async function configModels(root: string, fetchImpl: FetchLike, timeoutMs: number): Promise<ModelList> {
  if (!existsSync(join(root, 'local.json'))) return { ok: false, error: '没有 local.json：无法读取网关的实时模型列表，可以直接输入模型编号。' };
  const cfg = loadConfig(root, { requireLocal: true });
  if (!cfg.ok || cfg.value.local === null) return { ok: false, error: '配置读不通，无法读取网关的实时模型列表。' };
  const local = cfg.value.local;
  const envFile = isAbsolute(local.gatewayEnvFile) ? local.gatewayEnvFile : join(root, local.gatewayEnvFile);
  const families: Family[] = [...new Set([...cfg.value.judges, cfg.value.maintainer, cfg.value.mergeEditor].map((j) => j.family))];
  return gatewayModels({ ...local, gatewayEnvFile: envFile }, cfg.value.prefixes, families, fetchImpl, timeoutMs);
}
