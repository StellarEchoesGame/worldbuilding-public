import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTO_DELAY_MS, resolveBenchmark, rollbackEligible, type Resolution, type ResolveInputs } from '../../../../engine/bench-active.ts';
import { pendingVersions, type PendingVersion } from '../../../../engine/bench-evidence.ts';
import {
  readBenchLog, VERSION_ID, type BenchActivation, type BenchLogEntry, type BenchLogReason, type BenchOutcome, type ReplaySummary,
} from '../../../../engine/bench-log.ts';
import { IntegrityError } from '../../../../engine/calls.ts';
import { isRecord } from '../../../../engine/json.ts';
import { postedBenchNotices } from '../../../../engine/mirror-log.ts';
import { ownerInputs, readOwnerLog, sha256Bytes, type OwnerInputs, type OwnerLogEntry } from '../../../../engine/owner-inputs.ts';
import { BUNDLE_FILES } from '../../../../engine/protocol.ts';
import type { Result } from '../../../../engine/result.ts';
import { loadProtocolBundle } from '../../../../engine/rules.ts';
import { redactRoot } from '../data.ts';

/** One leaf difference between two benchmark versions (JSON path like `taste.questions[1].text`). */
export interface BenchDiffLine {
  path: string;
  /** JSON text of the value, null when absent on that side. */
  before: string | null;
  after: string | null;
}

/** One version line of benchmark/log.jsonl (outcome activate | pending_owner), newest first. */
export interface BenchVersionView {
  version: string;
  cycle: string;
  at: string;
  outcome: BenchOutcome;
  parent: string | null;
  activation: BenchActivation | null;
  path: string;
  /** Logged SHA-256 and the SHA-256 of the file bytes now (null when the file is missing). */
  sha256: string | null;
  fileSha256: string | null;
  changedKeys: string[];
  reasons: BenchLogReason[];
  evidenceIds: string[];
  errors: string[];
  replay: ReplaySummary | null;
  /** ownerInputs benchDiffViewed / benchApproved for (version, fileSha256). */
  viewedAt: string | null;
  approvedAt: string | null;
  /** In pendingVersions(log, owner). */
  pending: boolean;
  /** submitRollback would accept it (bench-active rollbackEligible now: once effective or approved), the file is intact, and it is not the effective version. */
  rollbackTarget: boolean;
}

export interface ProtocolView {
  bundleSha256: string | null;
  error: string | null;
  /** ownerInputs(root).protocolApproval(bundleSha256)?.at. */
  approvedAt: string | null;
  /** Latest protocol_approved entry's hash (differs from bundleSha256 when the bundle changed since). */
  lastApprovedSha256: string | null;
  /** BUNDLE_FILES with the SHA-256 of their bytes (null when missing). */
  files: Array<{ name: string; sha256: string | null }>;
}

export interface BenchPageView {
  versions: BenchVersionView[];
  /** resolveBenchmark(…, now, 'effective' | 'head'); null + resolveError when unresolved. */
  effective: Resolution | null;
  head: Resolution | null;
  resolveError: string | null;
  pending: PendingVersion[];
  protocol: ProtocolView;
  /** readBenchLog / readOwnerLog error (the page shows it and no forms). */
  logError: string | null;
}

export interface BenchVersionPage {
  version: BenchVersionView;
  /** versionDiff(parent file, this file); parent null → every leaf is an addition. */
  diff: BenchDiffLine[];
  text: string;
}

/** Marks a side of the diff where the key or index does not exist (JSON has no undefined). */
const ABSENT: unique symbol = Symbol('absent');

const PLAIN_KEY = /^[\p{L}_$][\p{L}\p{N}_$-]*$/u;

function childPath(path: string, key: string): string {
  if (!PLAIN_KEY.test(key)) return `${path}[${JSON.stringify(key)}]`;
  return path === '' ? key : `${path}.${key}`;
}

function jsonText(value: unknown): string | null {
  return value === ABSENT ? null : JSON.stringify(value);
}

/** A non-empty array or object: an absent counterpart is diffed leaf by leaf; an empty one is itself a leaf. */
function nonEmpty(value: unknown): boolean {
  return (Array.isArray(value) && value.length > 0) || (isRecord(value) && Object.keys(value).length > 0);
}

function walk(path: string, before: unknown, after: unknown, out: BenchDiffLine[]): void {
  if (before === ABSENT && nonEmpty(after)) return walk(path, Array.isArray(after) ? [] : {}, after, out);
  if (after === ABSENT && nonEmpty(before)) return walk(path, before, Array.isArray(before) ? [] : {}, out);
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let i = 0; i < Math.max(before.length, after.length); i += 1) {
      walk(`${path}[${i}]`, i < before.length ? before[i] : ABSENT, i < after.length ? after[i] : ABSENT, out);
    }
    return;
  }
  if (isRecord(before) && isRecord(after)) {
    const keys = [...Object.keys(before), ...Object.keys(after).filter((k) => !Object.hasOwn(before, k))];
    for (const k of keys) walk(childPath(path, k), Object.hasOwn(before, k) ? before[k] : ABSENT, Object.hasOwn(after, k) ? after[k] : ABSENT, out);
    return;
  }
  const b = jsonText(before);
  const a = jsonText(after);
  if (b !== a) out.push({ path, before: b, after: a });
}

/** Leaf-level differences, parent key order first; `parent` null → every leaf of `child` is an addition. */
export function versionDiff(parent: unknown, child: unknown): BenchDiffLine[] {
  const out: BenchDiffLine[] = [];
  walk('', parent === null ? ABSENT : parent, child === null ? ABSENT : child, out);
  return out;
}

function fileSha(root: string, rel: string): string | null {
  const abs = join(root, rel);
  return existsSync(abs) ? sha256Bytes(readFileSync(abs)) : null;
}

export function protocolView(root: string): ProtocolView {
  const bundle = loadProtocolBundle(root);
  const bundleSha256 = bundle.ok ? bundle.value.bundleSha256 : null;
  const log = readOwnerLog(root);
  const last = log.ok ? log.value.filter((e) => e.action === 'protocol_approved').at(-1) : undefined;
  return {
    bundleSha256,
    // Node read errors quote the absolute path (ENOENT …, open '<root>/judges.json'): shown forge-relative, as configView does.
    error: bundle.ok ? null : redactRoot(bundle.error, root),
    approvedAt: bundleSha256 === null ? null : (ownerInputs(root).protocolApproval(bundleSha256)?.at ?? null),
    lastApprovedSha256: last?.sha256 ?? null,
    files: BUNDLE_FILES.map((name) => ({ name, sha256: fileSha(root, name) })),
  };
}

interface Resolved {
  effective: Resolution | null;
  head: Resolution | null;
  resolveError: string | null;
}

function problem(label: string, r: Result<Resolution>): string | null {
  return r.ok ? null : `${label}：${r.error}`;
}

function resolveInputs(root: string, log: readonly BenchLogEntry[], owner: readonly OwnerLogEntry[]): ResolveInputs {
  return { log, owner, posted: postedBenchNotices(root), files: (path) => readText(root, path), autoDelayMs: AUTO_DELAY_MS };
}

/** resolveBenchmark in both modes; an edited or missing version file (IntegrityError) is reported, not thrown. */
function resolveBoth(inputs: ResolveInputs, now: string): Resolved {
  try {
    const effective = resolveBenchmark(inputs, now, 'effective');
    const head = resolveBenchmark(inputs, now, 'head');
    const failed = [problem('生效版本', effective), problem('最新版本', head)].filter((p) => p !== null);
    return { effective: effective.ok ? effective.value : null, head: head.ok ? head.value : null, resolveError: failed.length === 0 ? null : failed.join('；') };
  } catch (e) {
    if (e instanceof IntegrityError) return { effective: null, head: null, resolveError: e.message };
    throw e;
  }
}

interface ViewContext {
  resolve: ResolveInputs;
  now: string;
  inputs: OwnerInputs;
  pending: readonly PendingVersion[];
  effective: Resolution | null;
}

function versionView(root: string, e: BenchLogEntry & { version: string }, ctx: ViewContext): BenchVersionView {
  const path = e.path ?? `benchmark/${e.version}.json`;
  const fileSha256 = fileSha(root, path);
  const intact = fileSha256 !== null && (e.sha256 === null || e.sha256 === fileSha256);
  const eligible = rollbackEligible(ctx.resolve, e.version, ctx.now);
  const target = eligible !== null && eligible.path === path && eligible.sha256 === e.sha256;
  return {
    version: e.version, cycle: e.cycle, at: e.at, outcome: e.outcome, parent: e.parent, activation: e.activation, path, sha256: e.sha256, fileSha256,
    changedKeys: [...e.changed_keys], reasons: e.reasons, evidenceIds: [...e.evidence_ids], errors: [...e.errors], replay: e.replay,
    viewedAt: fileSha256 === null ? null : ctx.inputs.benchDiffViewed(e.version, fileSha256),
    approvedAt: fileSha256 === null ? null : ctx.inputs.benchApproved(e.version, fileSha256),
    pending: ctx.pending.some((p) => p.version === e.version),
    rollbackTarget: target && intact && ctx.effective !== null && ctx.effective.version !== e.version,
  };
}

function hasVersion(e: BenchLogEntry): e is BenchLogEntry & { version: string } {
  return e.version !== null && (e.outcome === 'activate' || e.outcome === 'pending_owner');
}

export function benchView(root: string, now: string): BenchPageView {
  const protocol = protocolView(root);
  const empty = { versions: [], effective: null, head: null, resolveError: null, pending: [], protocol };
  const log = readBenchLog(root);
  if (!log.ok) return { ...empty, logError: `基准日志需要修复：${log.error}` };
  const owner = readOwnerLog(root);
  if (!owner.ok) return { ...empty, logError: `owner 日志需要修复：${owner.error}` };
  const inputs = ownerInputs(root);
  const resolve = resolveInputs(root, log.value, owner.value);
  const resolved = resolveBoth(resolve, now);
  const pending = pendingVersions(log.value, inputs);
  const ctx = { resolve, now, inputs, pending, effective: resolved.effective };
  const versions = log.value.filter(hasVersion).map((e) => versionView(root, e, ctx)).reverse();
  return { versions, ...resolved, pending, protocol, logError: null };
}

function readText(root: string, rel: string): string | null {
  const abs = join(root, rel);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

function parsed(text: string | null): unknown {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return null;
  }
}

/** null when `version` fails VERSION_ID or has no activate / pending_owner line. */
export function benchVersionPage(root: string, version: string, now: string): BenchVersionPage | null {
  if (!VERSION_ID.test(version)) return null;
  const view = benchView(root, now);
  const v = view.versions.find((x) => x.version === version);
  if (v === undefined) return null;
  const text = readText(root, v.path);
  const errors = [...v.errors];
  if (text === null) errors.push(`${v.path} 不存在。`);
  else if (parsed(text) === null) errors.push(`${v.path} 不是 JSON。`);
  let parent: unknown = null;
  if (v.parent !== null) {
    const parentPath = view.versions.find((x) => x.version === v.parent)?.path ?? `benchmark/${v.parent}.json`;
    parent = parsed(readText(root, parentPath));
    if (parent === null) errors.push(`上一版 ${v.parent}（${parentPath}）无法读取，下面的差异按全部新增显示。`);
  }
  return { version: { ...v, errors }, diff: versionDiff(parent, parsed(text)), text: text ?? '' };
}
