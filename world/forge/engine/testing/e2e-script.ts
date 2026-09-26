import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FakeReply } from '../adapters/fake.ts';
import { anonymizeText } from '../anonymize.ts';
import { benchCommand, benchValidateCommand } from '../cli-bench.ts';
import { calibCommand } from '../cli-calib.ts';
import { mergeCommand, mirrorCommand, postMergeCommand } from '../cli-merge.ts';
import { freezeCommand, roundCommand } from '../cli-round.ts';
import { MAINTAINER_KEYS } from '../bench-validate.ts';
import type { Family } from '../config.ts';
import type { EngineDeps, RunHooks } from '../context.ts';
import { isRecord, type JsonRecord } from '../json.ts';
import { seededShuffle, sha256 } from '../store.ts';
import { unwrap } from '../tasks/fenced.ts';
import { splitSentences } from '../text.ts';
import type { FixtureOptions } from './fixture-world.ts';
import type { ChoosePair } from './owner-sim.ts';
import { benchQuestions, deps, fence, head, world, type Script, type World } from './round-script.ts';
import type { FakeCallMeta, FakeRouter, Route } from './scripted.ts';

/*
 * Scripted world of the end-to-end fixture round (engine/e2e.test.ts, plan "End-to-end fixture round"): wraps
 * round-script.ts (its texts, writer / gate / taste / measure / surprise / merge routes and fake ports) and adds what
 * round 0 and the benchmark cycle need: fixture without benchmark or trust, calibration gateway routes, calibration
 * and audit answers by one preference rule, the maintainer script per cycle, replay routes with the E7 override, and
 * the forge(argv) entry point (one EngineDeps per call, synthetic pids, guards after every call). Test-only.
 */

/** fixtureWorld options of the e2e world: no benchmark (v1 comes from E0), SHIP owner_pick champion, no trust status, no approval. */
export const E2E_FIXTURE: FixtureOptions = { benchmark: 'none', champions: 'ship_owner_pick', trust: 'none', protocolApproved: false };
/** pid of the first forge() call; each call takes the next one. */
export const E2E_FIRST_PID = 1001;
/** Cliché marks of the preference rule (fewer wins). */
export const CLICHE_MARKS: readonly string[] = ['仿佛', '宛如', '某种'];
/** The R01 maintainer's replacement text of taste.questions[0] (replay routes key the new version on it). */
export const REPLAY_Q = '哪一篇让你更想知道这个地方明天会发生什么？';
/** The family that prefers the decoy in W1 s1 and its rerun (E3: one void session pair drops it, |E| = 3). */
export const E2E_DECOY_LOVER: Family = 'xAI';
/** build.json models of the fixture (calibration/build.json) and their families. */
export const CALIB_MODELS: ReadonlyArray<{ model: string; family: Family }> = [{ model: 'deepseek-fixture-a', family: 'DeepSeek' }, { model: 'qwen/fixture-b', family: 'Alibaba' }];

/** E7: families answering against the owner on named labels under one version (label ids). */
export interface ReplayOverride {
  newAgainst: ReadonlyMap<Family, readonly string[]>;
  oldAgainst: ReadonlyMap<Family, readonly string[]>;
}

/** The cycle knobs the scenarios flip between runs (round-script's Script stays the world's `script`). */
export interface E2EScript {
  replay: ReplayOverride | null;
  /** Maintainer reply per task id (`bench-initial`, `bench-propose-R00`, …); built from the unwrapped packet. */
  maintainer: (prompt: string, meta: FakeCallMeta) => FakeReply;
}

export interface E2EWorld extends World {
  e2e: E2EScript;
}

/** One forge() call: dispatches argv (round | calib | bench | merge | mirror | freeze) with a fresh EngineDeps, then the guards. */
export type ForgeCall = (argv: readonly string[], hooks?: RunHooks) => Promise<number>;

export interface E2EHarness {
  x: E2EWorld;
  forge: ForgeCall;
  /** pids used so far, in call order. */
  pids(): readonly number[];
}

function marks(text: string): number {
  return CLICHE_MARKS.reduce((n, m) => n + text.split(m).length - 1, 0);
}

/** The form both sides compare: anonymized (idempotent), trimmed, NFC; the owner sees raw files, judges anonymized ones. */
function comparable(text: string): string {
  return anonymizeText(text).trim().normalize('NFC');
}

/** Fewer CLICHE_MARKS wins; tie → the code-unit-smaller NFC string. */
export function panelPrefers(t1: string, t2: string): 1 | 2 {
  const a = comparable(t1);
  const b = comparable(t2);
  const ma = marks(a);
  const mb = marks(b);
  if (ma !== mb) return ma < mb ? 1 : 2;
  return a <= b ? 1 : 2;
}

/** Owner-sim policy for calibration and audits: panelPrefers on the displayed texts. */
export const ownerChoice: ChoosePair = (pair) => (panelPrefers(pair.leftText, pair.rightText) === 1 ? 'left' : 'right');

/** A taste answer (no decoy) picking `pick` on every question, quoting the first 12 characters of the chosen text. */
function tasteAnswer(questions: readonly string[], pick: 1 | 2, t1: string, t2: string): FakeReply {
  const quote = head(pick === 1 ? t1 : t2);
  return fence({ answers: Object.fromEntries(questions.map((q) => [q, { pick, quote }])) });
}

/** `replay-<label>-<family>-<old|new>-<fwd|rev>` → its parts (label ids contain dashes). */
export function replayCallOf(taskId: string): { label: string; family: string; version: 'old' | 'new' } | null {
  const parts = taskId.split('-');
  const version = parts.at(-2);
  const family = parts.at(-3);
  if (parts[0] !== 'replay' || parts.length < 5 || family === undefined || (version !== 'old' && version !== 'new')) return null;
  return { label: parts.slice(1, -3).join('-'), family, version };
}

/**
 * Judge routes added to round-script's: `calib` (panelPrefers) and `replay` (panelPrefers unless e2e.replay names the
 * family and label under that version: then the other text, i.e. against the owner, in both orders).
 */
export function cycleJudgeRoutes(e2e: E2EScript, script: Script, family: Family): Record<string, Route> {
  return {
    calib: (prompt) => {
      const t1 = unwrap(prompt, '文本甲') ?? '';
      const t2 = unwrap(prompt, '文本乙') ?? '';
      return tasteAnswer(script.questions, panelPrefers(t1, t2), t1, t2);
    },
    replay: (prompt, _n, meta) => {
      const t1 = unwrap(prompt, '文本甲') ?? '';
      const t2 = unwrap(prompt, '文本乙') ?? '';
      const call = replayCallOf(meta.taskId);
      const o = e2e.replay;
      const against = call !== null && o !== null && (call.version === 'new' ? o.newAgainst : o.oldAgainst).get(family)?.includes(call.label) === true;
      const pick = panelPrefers(t1, t2);
      return tasteAnswer(script.questions, against ? (pick === 1 ? 2 : 1) : pick, t1, t2);
    },
  };
}

/** The degrade answer: the first three sentences get a 宛如 tail (3 verbatim changes, 3 marks, same sentence count). */
function degraded(original: string): { text: string; changes: Array<{ from: string; to: string }> } {
  const changes = splitSentences(original).slice(0, 3).map((s) => ({ from: s, to: `${s.slice(0, -1)}，宛如往常。` }));
  let text = original;
  for (const c of changes) text = text.replace(c.from, c.to);
  return { text, changes };
}

/**
 * Calibration gateway routes of one build.json model: `calibrewrite` = the passage's sentences shuffled by (model,
 * prompt) plus one closing sentence of its own (never the passage, never another rewrite, no mark); `calibdegrade`
 * inserts three 宛如 marks.
 */
export function calibGatewayRoutes(model: string): Record<string, Route> {
  return {
    calibrewrite: (prompt) => fence({ text: `${seededShuffle(splitSentences(unwrap(prompt, '原文') ?? ''), model, sha256(prompt)).join('')}这一天就这样过去了。` }),
    calibdegrade: (prompt) => fence(degraded(unwrap(prompt, '现场') ?? '')),
  };
}

function record(text: string | null, what: string): JsonRecord {
  const value: unknown = JSON.parse(text ?? 'null');
  if (!isRecord(value)) throw new Error(`fake maintainer: ${what} is not a JSON object`);
  return value;
}

const REAL_V0 = fileURLToPath(new URL('../../benchmark/v0.json', import.meta.url));

/** v1 (--initial): the v0 maintainer keys with a 2-detail decoy recipe, two questions, bars 7 and one cliché. */
export function initialReply(): FakeReply {
  const v0 = record(readFileSync(REAL_V0, 'utf8'), 'benchmark/v0.json');
  const body: JsonRecord = Object.fromEntries(MAINTAINER_KEYS.map((k) => [k, v0[k]]));
  body['cliche_list'] = ['时光在指缝间流走'];
  body['decoy_recipe'] = { details: 2, instructions: '把现任稿中最具体的两个细节换成泛泛的同类说法，长度、段落和格式保持不变。' };
  body['bars'] = { beats_champion_four_families: 7 };
  return fence({ kind: 'change', body, reasons: [{ change: '根版本：沿用原型的两个问题与门槛 7', keys: [...MAINTAINER_KEYS], evidence_ids: [], expected_effect: '给第 0 轮一个可批准的起点' }] });
}

/** Evidence ids of the packet items whose id starts with `E-<round>-<code>` (e.g. every AGR or SAT item). */
function idsWith(packet: JsonRecord, round: string, codes: readonly string[]): string[] {
  const items = Array.isArray(packet['items']) ? packet['items'] : [];
  const ids = items.flatMap((i) => (isRecord(i) && typeof i['id'] === 'string' ? [i['id']] : []));
  return ids.filter((id) => codes.some((c) => id === `E-${round}-${c}` || id.startsWith(`E-${round}-${c}-`)));
}

function ceilingsOf(packet: JsonRecord): string[] {
  const c = packet['ceilings'];
  return Array.isArray(c) ? c.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * The cycle maintainer (task `bench-propose-RNN`): R00 raises decoy_recipe 2 → 3 citing every AGR and SAT item; R01
 * replaces taste.questions[0].text with REPLAY_Q citing the disagreements, SAT and PEND items; later rounds keep the
 * version (no_change). Every reply also cites the packet's ceilings, as the parser requires.
 */
export function cycleReply(prompt: string, meta: FakeCallMeta): FakeReply {
  const round = meta.taskId.slice('bench-propose-'.length);
  const packet = record(unwrap(prompt, '证据包'), '证据包');
  const current = record(unwrap(prompt, '当前版本'), '当前版本');
  const ceilings = ceilingsOf(packet);
  const cite = (codes: readonly string[]): string[] => [...new Set([...idsWith(packet, round, codes), ...ceilings])];
  const body: JsonRecord = Object.fromEntries(MAINTAINER_KEYS.map((k) => [k, structuredClone(current[k])]));
  if (round === 'R00') {
    body['decoy_recipe'] = { details: 3, instructions: '把现任稿中最具体的三个细节换成泛泛的同类说法，长度、段落和格式保持不变。' };
    return fence({ kind: 'change', body, reasons: [{ change: '诱饵多换一个细节', keys: ['decoy_recipe'], evidence_ids: cite(['AGR', 'SAT']), expected_effect: '诱饵更难被一眼认出' }] });
  }
  if (round === 'R01') {
    // body holds clones of the head's values, so the question can be edited in place
    const taste = body['taste'];
    const first = isRecord(taste) && Array.isArray(taste['questions']) ? taste['questions'][0] : null;
    if (!isRecord(first)) throw new Error('fake maintainer: the head has no taste.questions[0]');
    first['text'] = REPLAY_Q;
    return fence({ kind: 'change', body, reasons: [{ change: '换掉决定性问题的问法', keys: ['taste'], evidence_ids: cite(['DIS', 'SAT', 'PEND']), expected_effect: '问题更贴近“想知道明天”' }] });
  }
  return fence({ kind: 'no_change', reasons: [{ text: '证据不足以支持改动，维持当前版本', evidence_ids: cite(['SAT']) }] });
}

/** Maintainer dispatch of the e2e world: `bench-initial` → initialReply, `bench-propose-RNN` → cycleReply. */
export function e2eMaintainer(prompt: string, meta: FakeCallMeta): FakeReply {
  return meta.taskId === 'bench-initial' ? initialReply() : cycleReply(prompt, meta);
}

/** The e2e world: round-script world over E2E_FIXTURE with the cycle routes, calibration passages and gateway backends. */
export function e2eWorld(): E2EWorld {
  const e2e: E2EScript = { replay: null, maintainer: e2eMaintainer };
  const x = world({
    claims: true,
    fixture: E2E_FIXTURE,
    calibPassages: true,
    judgeRoutes: (script, family) => cycleJudgeRoutes(e2e, script, family),
    maintainer: { bench: (prompt, _n, meta) => e2e.maintainer(prompt, meta) },
    calibGateway: CALIB_MODELS.map((m) => ({ model: m.model, family: m.family, routes: calibGatewayRoutes(m.model) })),
  });
  x.script.decoyLover = E2E_DECOY_LOVER;
  return { ...x, e2e };
}

/** EngineDeps of one call (round-script deps: shared ports / backends / log, isAlive only for `pid`, +1 s per paid call). */
export function e2eDeps(x: E2EWorld, pid: number, hooks: RunHooks): EngineDeps {
  return deps(x, pid, hooks);
}

async function dispatch(x: E2EWorld, argv: readonly string[], d: EngineDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'round') return roundCommand(rest, d, x.at);
  if (cmd === 'calib') return calibCommand(rest, d, x.at);
  if (cmd === 'bench' && rest[0] === 'validate' && rest[1] !== undefined && !/^R\d{2}$/u.test(rest[1])) {
    return benchValidateCommand(rest.slice(1), x.at, x.at.root, { out: (l) => x.logs.push(l), err: (l) => x.logs.push(l) });
  }
  if (cmd === 'bench') return benchCommand(rest, d, x.at);
  if (cmd === 'merge') return mergeCommand(rest, d, x.at);
  if (cmd === 'mirror') return mirrorCommand(rest, d, x.at);
  if (cmd === 'freeze') return rest.includes('--post-merge') ? postMergeCommand(rest, d, x.at) : freezeCommand(rest, d, x.at);
  throw new Error(`forge(): unknown command ${argv.join(' ')}`);
}

/** forge(argv): pid E2E_FIRST_PID + n, dispatch to the command functions, then `guards(x)` (also after a rejected call). */
export function forgeHarness(x: E2EWorld, guards: (x: E2EWorld) => void): E2EHarness {
  const pids: number[] = [];
  const forge: ForgeCall = async (argv, hooks = {}) => {
    const pid = E2E_FIRST_PID + pids.length;
    pids.push(pid);
    try {
      return await dispatch(x, argv, e2eDeps(x, pid, hooks));
    } finally {
      // the taste routes answer every question of the version; v1 appears during round 0
      if (x.script.questions.length === 0) x.script.questions = benchQuestions(x.w.root);
      guards(x);
    }
  };
  return { x, forge, pids: () => [...pids] };
}

/** Routers of the three writer slots. */
function writerRouters(x: World): FakeRouter[] {
  return x.routers.filter((r) => r.id === 'W1' || r.id === 'W2' || r.id === 'W3');
}

/** Every prompt the writers W1–W3 received (the forecast-leak guard scans them). */
export function writerPrompts(x: World): string[] {
  return writerRouters(x).flatMap((r) => r.log().map((c) => c.prompt));
}

/** `taskId#attempt` of router `id`'s calls. */
export function callsOf(x: World, id: string): string[] {
  return x.routers.filter((r) => r.id === id).flatMap((r) => r.log().map((c) => `${c.taskId}#${c.attempt}`));
}
