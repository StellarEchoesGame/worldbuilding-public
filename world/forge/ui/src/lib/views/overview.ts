import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AUTO_DELAY_MS, resolveBenchmark, type Resolution } from '../../../../engine/bench-active.ts';
import { pendingVersions, type PendingVersion } from '../../../../engine/bench-evidence.ts';
import { readBenchLog } from '../../../../engine/bench-log.ts';
import { IntegrityError } from '../../../../engine/calls.ts';
import { SET_ID } from '../../../../engine/calib-build.ts';
import type { Family } from '../../../../engine/config.ts';
import { round10 } from '../../../../engine/cost.ts';
import { isRecord, readBoolean, readNumber, readRecord, readString } from '../../../../engine/json.ts';
import { pendingMirrors } from '../../../../engine/mirror.ts';
import { postedBenchNotices } from '../../../../engine/mirror-log.ts';
import { ownerInputs, readOwnerLog } from '../../../../engine/owner-inputs.ts';
import { pairVerdicts, readPairsFile, sessionVoid } from '../../../../engine/pairs.ts';
import { loadProtocolBundle } from '../../../../engine/rules.ts';
import { BENCH_R00_STEP_IDS, parseStatus, readStatus, STEP_IDS, type RoundStatus, type WaitReason } from '../../../../engine/runner.ts';
import { readJson, readLines, roundPaths } from '../../../../engine/store.ts';
import { readTrustStatus, type AgreementState } from '../../../../engine/trust-status.ts';
import { redactRoot, type ProgressEvent } from '../data.ts';

export interface ActiveRoundView {
  round: string;
  status: RoundStatus | null;
  statusError: string | null;
  /** status.done.length / STEP_IDS.length. */
  doneSteps: number;
  totalSteps: number;
  /** Last 8 progress.jsonl events, newest last. */
  recent: ProgressEvent[];
}

export interface JudgeHealth {
  family: string;
  qualified: boolean;
  gateJudge: boolean;
  state: AgreementState;
  n: number;
  mean: number;
  ci90: [number, number];
  /** P(agreement < threshold). */
  pBelow: number;
  suspendedAt: string | null;
}

/** Latest round with a tally.json: tally.voids plus answered (ok, non-shadow) taste calls and how many preferred the decoy. */
export interface VoidHealth {
  round: string;
  calls: number;
  voidTasks: number;
  sessionReruns: number;
  droppedFamilies: number;
  tasteCalls: number;
  decoyPreferred: number;
  /** The engine's void_decoy numbers per family (bench-evidence sessionItems over the same reader); [] + error when unreadable. */
  families: FamilyDecoy[];
  familiesError: string | null;
}

/** One family's champion session pairs in a round (shadow sessions included, as the evidence packet counts them). */
export interface FamilyDecoy {
  family: Family;
  sessionPairs: number;
  /** sessionVoid: either call void or preferring the decoy. */
  void: number;
  /** Either call preferred the decoy. */
  decoyFail: number;
}

/** Last call record per backend in the latest round's calls/ (what the CLIs actually served). */
export interface BackendSeen {
  backend: string;
  family: string | null;
  requested: string | null;
  served: string | null;
  version: string | null;
  at: string;
}

export type OwnerTodoKind = 'protocol_approval' | 'benchmark_approval' | 'topic' | 'audit' | 'decision' | 'diff_approval' | 'calib_answers' | 'owner_log_repair';

export interface OwnerTodo {
  kind: OwnerTodoKind;
  round: string | null;
  detail: string;
  href: string;
}

export interface OverviewView {
  active: ActiveRoundView | null;
  /** Sum of rounds/<R>/cost.json total_usd and unpriced_calls over every round that has one. */
  cost: { totalUsd: number; unpricedCalls: number; rounds: number };
  judges: JudgeHealth[];
  trustError: string | null;
  voids: VoidHealth | null;
  backends: BackendSeen[];
  /** forge doctor persists nothing (only start.json doctor_sha256): always null → the page shows 未检测. */
  doctor: null;
  /** effective = what the next freeze pins; head = what the next proposal builds on. */
  benchmark: { effective: Resolution | null; head: Resolution | null; pending: PendingVersion[]; error: string | null };
  todos: OwnerTodo[];
  /** pendingMirrors(root, round, now) per round with any pending entry (or an error). */
  mirrors: Array<{ round: string; count: number; error: string | null }>;
}


const ROUND_ID = /^[A-Z]\d{2}$/u;
const RECENT_EVENTS = 8;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function roundIds(root: string): string[] {
  const dir = join(root, 'rounds');
  return existsSync(dir) ? readdirSync(dir).filter((n) => ROUND_ID.test(n)).sort() : [];
}

function progressEvents(root: string, round: string): ProgressEvent[] {
  return readLines(roundPaths(root, round).progress).map((e) => ({
    at: readString(e, 'at') ?? '',
    step: readString(e, 'step') ?? '',
    status: readString(e, 'status') ?? '',
    detail: readString(e, 'detail') ?? '',
  }));
}

/** Latest round (id order) whose status.json exists and is not `done` (an unreadable status counts as active). */
function activeRound(root: string, rounds: readonly string[]): ActiveRoundView | null {
  for (const round of [...rounds].reverse()) {
    if (!existsSync(join(root, 'rounds', round, 'status.json'))) continue;
    const st = readStatus(root, round);
    if (st.ok && st.value.state === 'done') continue;
    return {
      round,
      status: st.ok ? { ...st.value, detail: redactRoot(st.value.detail, root) } : null,
      statusError: st.ok ? null : redactRoot(st.error, root),
      doneSteps: st.ok ? st.value.done.length : 0,
      totalSteps: round === 'R00' ? BENCH_R00_STEP_IDS.length : STEP_IDS.length,
      recent: progressEvents(root, round).slice(-RECENT_EVENTS),
    };
  }
  return null;
}

function costToDate(root: string, rounds: readonly string[]): OverviewView['cost'] {
  let totalUsd = 0;
  let unpricedCalls = 0;
  let counted = 0;
  for (const round of rounds) {
    const cost = readJson(join(root, 'rounds', round, 'cost.json'));
    const total = readNumber(cost, 'total_usd');
    if (total === null) continue;
    totalUsd = round10(totalUsd + total);
    unpricedCalls += readNumber(cost, 'unpriced_calls') ?? 0;
    counted += 1;
  }
  return { totalUsd, unpricedCalls, rounds: counted };
}

function judgeHealth(root: string): { judges: JudgeHealth[]; trustError: string | null } {
  const trust = readTrustStatus(root);
  if (trust === null) return { judges: [], trustError: null };
  if (!trust.ok) return { judges: [], trustError: trust.error };
  const judges = Object.entries(trust.value.families)
    .map(([family, t]) => ({
      family, qualified: t.qualified, gateJudge: t.gate_judge, state: t.agreement.state, n: t.agreement.n, mean: t.agreement.mean, ci90: t.agreement.ci90, pBelow: t.agreement.p_below, suspendedAt: t.suspended_at,
    }))
    .sort((a, b) => (a.family < b.family ? -1 : 1));
  return { judges, trustError: null };
}

/**
 * Answered taste calls under `taste/` (champion and aux): status ok and not a shadow family's. Void calls carry
 * preferred_decoy false by construction and shadow calls never count, so both stay out of the decoy rate's denominator.
 */
function tasteDecoys(dir: string): { calls: number; preferred: number } {
  if (!existsSync(dir)) return { calls: 0, preferred: 0 };
  let calls = 0;
  let preferred = 0;
  for (const rel of readdirSync(dir, { encoding: 'utf8', recursive: true })) {
    if (!rel.endsWith('.json') || rel.endsWith('pairs.json')) continue;
    const rec = readJson(join(dir, rel));
    const flag = readBoolean(rec, 'preferred_decoy');
    if (flag === null || readString(rec, 'status') !== 'ok' || readBoolean(rec, 'shadow') !== false) continue;
    calls += 1;
    if (flag) preferred += 1;
  }
  return { calls, preferred };
}

/** Per family over the round's champion pairs (pairs.json → pairVerdicts), counted as bench-evidence sessionItems counts VOID. */
function familyDecoys(root: string, round: string): { families: FamilyDecoy[]; error: string | null } {
  const file = readPairsFile(roundPaths(root, round), 'champion');
  if (!file.ok) return { families: [], error: file.error };
  const per = new Map<Family, FamilyDecoy>();
  try {
    for (const pair of file.value.pairs) {
      for (const fs of pairVerdicts(root, round, pair.id)) {
        const c = per.get(fs.family) ?? { family: fs.family, sessionPairs: 0, void: 0, decoyFail: 0 };
        for (const [fwd, rev] of fs.sessions) {
          c.sessionPairs += 1;
          if (fwd.preferredDecoy || rev.preferredDecoy) c.decoyFail += 1;
          if (sessionVoid(fwd, rev)) c.void += 1;
        }
        per.set(fs.family, c);
      }
    }
  } catch (e) {
    if (e instanceof IntegrityError) return { families: [], error: e.message };
    throw e;
  }
  return { families: [...per.values()].sort((a, b) => (a.family < b.family ? -1 : 1)), error: null };
}

function voidHealth(root: string, rounds: readonly string[]): VoidHealth | null {
  for (const round of [...rounds].reverse()) {
    const voids = readRecord(readJson(join(root, 'rounds', round, 'tally.json')), 'voids');
    if (voids === null) continue;
    const taste = tasteDecoys(roundPaths(root, round).taste);
    const perFamily = familyDecoys(root, round);
    return {
      round,
      calls: readNumber(voids, 'calls') ?? 0,
      voidTasks: readNumber(voids, 'void_tasks') ?? 0,
      sessionReruns: readNumber(voids, 'session_reruns') ?? 0,
      droppedFamilies: readNumber(voids, 'dropped_families') ?? 0,
      tasteCalls: taste.calls,
      decoyPreferred: taste.preferred,
      families: perFamily.families,
      familiesError: perFamily.error,
    };
  }
  return null;
}

/** Last call record per backend (by `at`) in the latest round that has any; quota tries skipped. */
function backendsSeen(root: string, rounds: readonly string[]): BackendSeen[] {
  for (const round of [...rounds].reverse()) {
    const dir = roundPaths(root, round).calls;
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    const latest = new Map<string, BackendSeen>();
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      const rec = readJson(join(dir, name));
      if (!isRecord(rec) || rec['quota'] === true) continue;
      const backend = readString(rec, 'backend');
      const at = readString(rec, 'at');
      if (backend === null || at === null) continue;
      const prev = latest.get(backend);
      if (prev !== undefined && prev.at >= at) continue;
      latest.set(backend, { backend, family: readString(rec, 'family'), requested: readString(rec, 'requested_model'), served: readString(rec, 'served_model'), version: readString(rec, 'version'), at });
    }
    if (latest.size > 0) return [...latest.values()].sort((a, b) => (a.backend < b.backend ? -1 : 1));
  }
  return [];
}

function benchmarkState(root: string, now: string): OverviewView['benchmark'] {
  const none = { effective: null, head: null, pending: [] };
  const log = readBenchLog(root);
  if (!log.ok) return { ...none, error: log.error };
  const owner = readOwnerLog(root);
  if (!owner.ok) return { ...none, error: `owner-log.jsonl 需要修复：${owner.error}` };
  const files = (path: string): string | null => {
    const abs = join(root, path);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  };
  const inputs = { log: log.value, owner: owner.value, posted: postedBenchNotices(root), files, autoDelayMs: AUTO_DELAY_MS };
  try {
    const effective = resolveBenchmark(inputs, now, 'effective');
    const head = resolveBenchmark(inputs, now, 'head');
    return {
      effective: effective.ok ? effective.value : null,
      head: head.ok ? head.value : null,
      pending: pendingVersions(log.value, ownerInputs(root)),
      error: effective.ok ? null : effective.error,
    };
  } catch (e) {
    return { ...none, error: message(e) };
  }
}

export function todoHref(kind: OwnerTodoKind, round: string | null): string {
  if (kind === 'protocol_approval' || kind === 'benchmark_approval') return '/benchmark';
  if (kind === 'owner_log_repair') return '/';
  if (kind === 'calib_answers') return round === null ? '/calibration' : `/calibration/${round}`;
  if (kind === 'topic') return round === null ? '/topic' : `/topic/${round}`;
  if (round === null) return '/rounds';
  if (kind === 'audit') return `/rounds/${round}/audit`;
  if (kind === 'decision') return `/rounds/${round}/decide`;
  return `/rounds/${round}/final`;
}

function waitingTodo(status: RoundStatus | null, round: string | null): OwnerTodo | null {
  if (status === null || status.state !== 'waiting' || status.waiting_for === null) return null;
  const kind: WaitReason = status.waiting_for;
  return { kind, round, detail: status.detail, href: todoHref(kind, round) };
}

function statusAt(path: string): RoundStatus | null {
  if (!existsSync(path)) return null;
  const st = parseStatus(readJson(path));
  return st.ok ? st.value : null;
}

function ownerTodos(root: string, rounds: readonly string[], pending: readonly PendingVersion[]): OwnerTodo[] {
  const out: OwnerTodo[] = [];
  const log = readOwnerLog(root);
  if (!log.ok) out.push({ kind: 'owner_log_repair', round: null, detail: log.error, href: '/' });
  const bundle = loadProtocolBundle(root);
  if (bundle.ok && log.ok && ownerInputs(root).protocolApproval(bundle.value.bundleSha256) === null) {
    out.push({ kind: 'protocol_approval', round: null, detail: `协议包 ${bundle.value.bundleSha256} 尚未批准`, href: '/benchmark' });
  }
  for (const p of pending) out.push({ kind: 'benchmark_approval', round: null, detail: `基准 ${p.version} 待批准（${p.since}）`, href: `/benchmark/${p.version}` });
  const initial = waitingTodo(statusAt(join(root, 'benchmark', 'initial', 'status.json')), null);
  if (initial !== null) out.push(initial);
  for (const round of rounds) {
    const st = existsSync(join(root, 'rounds', round, 'status.json')) ? readStatus(root, round) : null;
    const todo = waitingTodo(st !== null && st.ok ? st.value : null, round);
    if (todo !== null) out.push(todo);
  }
  const calib = join(root, 'calibration');
  const sets = existsSync(calib) ? readdirSync(calib).filter((n) => SET_ID.test(n)).sort() : [];
  for (const set of sets) {
    const todo = waitingTodo(statusAt(join(calib, set, 'status.json')), set);
    if (todo !== null) out.push(todo);
  }
  // Reader errors and engine wait details wrap Node fs messages (EACCES …, open '<root>/owner-log.jsonl'): forge-relative on the page.
  return out.filter((t, i) => out.findIndex((u) => u.kind === t.kind && u.href === t.href) === i).map((t) => ({ ...t, detail: redactRoot(t.detail, root) }));
}

function mirrorCounts(root: string, rounds: readonly string[], now: string): OverviewView['mirrors'] {
  const out: OverviewView['mirrors'] = [];
  for (const round of rounds) {
    const pending = pendingMirrors(root, round, now);
    if (!pending.ok) out.push({ round, count: 0, error: pending.error });
    else if (pending.value.length > 0) out.push({ round, count: pending.value.length, error: null });
  }
  return out;
}

export function overviewView(root: string, now: string): OverviewView {
  const rounds = roundIds(root);
  const benchmark = benchmarkState(root, now);
  const { judges, trustError } = judgeHealth(root);
  return {
    active: activeRound(root, rounds),
    cost: costToDate(root, rounds),
    judges,
    trustError,
    voids: voidHealth(root, rounds),
    backends: backendsSeen(root, rounds),
    doctor: null,
    benchmark,
    todos: ownerTodos(root, rounds, benchmark.pending),
    mirrors: mirrorCounts(root, rounds, now),
  };
}
