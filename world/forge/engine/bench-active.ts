import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBenchLog, type BenchLogEntry, type VersionRef } from './bench-log.ts';
import type { StepContext } from './context.ts';
import { postedBenchNotices } from './mirror-log.ts';
import { readOwnerLog, type OwnerLogEntry } from './owner-inputs.ts';
import { err, ok, type Result } from './result.ts';
import { sha256 } from './store.ts';
import { IntegrityError } from './task.ts';

/** The benchmark a freeze pins; `since` = the effective moment. */
export interface Resolution extends VersionRef {
  via: 'activate' | 'approved' | 'rollback';
  since: string;
}

export interface ResolveInputs {
  log: readonly BenchLogEntry[];
  owner: readonly OwnerLogEntry[];
  /** Posted bench_notice comments (mirror-log.ts postedBenchNotices). */
  posted: ReadonlyArray<{ version: string; createdAt: string }>;
  /** Reads a forge-root-relative benchmark file (bytes as UTF-8) for sha checks; null when absent. */
  files: (path: string) => string | null;
  autoDelayMs: number;
}

/** What rollback eligibility needs: everything but the file reader. */
export type TimingInputs = Omit<ResolveInputs, 'files'>;

/** 24 h: an `activate` entry becomes effective at min(first matching view, posted notice + 24 h). */
export const AUTO_DELAY_MS = 86_400_000;

/** A point in time: `ms` orders, `iso` is reported (original string when the moment is a logged timestamp). */
interface Moment {
  ms: number;
  iso: string;
}

interface Candidate {
  ref: VersionRef;
  via: Resolution['via'];
  moment: Moment;
  /** Log index (versions) or owner-log index (rollbacks): the later one wins a tie within a kind. */
  order: number;
  /** Log index of the version entry (versions and rollback targets). */
  logIndex: number;
  loggedMs: number;
}

function moment(iso: string): Moment | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : { ms, iso };
}

function earliest(moments: ReadonlyArray<Moment | null>): Moment | null {
  let best: Moment | null = null;
  for (const m of moments) if (m !== null && (best === null || m.ms < best.ms)) best = m;
  return best;
}

function latest(a: Moment, b: Moment): Moment {
  return b.ms > a.ms ? b : a;
}

function refOf(e: BenchLogEntry): VersionRef | null {
  return e.version === null || e.sha256 === null || e.path === null ? null : { version: e.version, sha256: e.sha256, path: e.path };
}

/** First owner entry of `action` for (version, sha256) at or after `notBefore`. */
function firstOwner(owner: readonly OwnerLogEntry[], action: 'bench_diff_viewed' | 'bench_approved', ref: VersionRef, notBefore: number): Moment | null {
  return earliest(
    owner
      .filter((o) => o.action === action && o.version === ref.version && o.sha256 === ref.sha256)
      .map((o) => moment(o.at))
      .filter((m) => m !== null && m.ms >= notBefore),
  );
}

/** When an `activate` line takes effect: the first matching view or the posted notice + delay, never before it was logged. */
function activateEffective(inputs: TimingInputs, ref: VersionRef, logged: Moment): Moment | null {
  const viewed = firstOwner(inputs.owner, 'bench_diff_viewed', ref, logged.ms);
  const notice = earliest(inputs.posted.filter((p) => p.version === ref.version).map((p) => moment(p.createdAt)));
  const autoMs = notice === null ? null : latest(logged, notice).ms + inputs.autoDelayMs;
  const auto = autoMs === null ? null : { ms: autoMs, iso: new Date(autoMs).toISOString() };
  const first = earliest([viewed, auto]);
  return first === null ? null : latest(logged, first);
}

/**
 * The log line a rollback to `version` targets (its first activate / pending_owner line), when that line was once
 * active (an `activate` line effective no later than `at`) or approved (a `pending_owner` line approved no later than
 * `at`); null otherwise.
 */
function onceActive(inputs: TimingInputs, version: string, at: Moment): { ref: VersionRef; logIndex: number; logged: Moment } | null {
  const logIndex = inputs.log.findIndex((e) => e.version === version && (e.outcome === 'activate' || e.outcome === 'pending_owner'));
  const target = inputs.log[logIndex];
  const ref = target === undefined ? null : refOf(target);
  const logged = target === undefined ? null : moment(target.at);
  if (target === undefined || ref === null || logged === null || logged.ms > at.ms) return null;
  const since = target.outcome === 'pending_owner' ? firstOwner(inputs.owner, 'bench_approved', ref, logged.ms) : activateEffective(inputs, ref, logged);
  return since === null || since.ms > at.ms ? null : { ref, logIndex, logged };
}

/**
 * The version a rollback clicked at `at` would restore (the one line resolveBenchmark counts), or null when the
 * resolver would ignore such a rollback. The UI offers and accepts only these targets.
 */
export function rollbackEligible(inputs: TimingInputs, version: string, at: string): VersionRef | null {
  const when = moment(at);
  return when === null ? null : (onceActive(inputs, version, when)?.ref ?? null);
}

/** Owner rollbacks that count: onceActive at the click, and the owner's sha256 equals the logged one. Others are ignored. */
function validRollbacks(inputs: ResolveInputs): Candidate[] {
  const out: Candidate[] = [];
  for (const [order, o] of inputs.owner.entries()) {
    const at = moment(o.at);
    if (o.action !== 'rollback' || o.version === null || at === null) continue;
    const target = onceActive(inputs, o.version, at);
    if (target === null || target.ref.sha256 !== o.sha256) continue;
    out.push({ ref: target.ref, via: 'rollback', moment: at, order, logIndex: target.logIndex, loggedMs: target.logged.ms });
  }
  return out;
}

/** `activate` (effective: view or posted notice + delay; head: logged) and approved, unsuperseded `pending_owner`. */
function versionCandidates(inputs: ResolveInputs, mode: 'effective' | 'head', rollbacks: readonly Candidate[]): Candidate[] {
  const out: Candidate[] = [];
  for (const [i, e] of inputs.log.entries()) {
    const ref = refOf(e);
    const logged = moment(e.at);
    if (ref === null || logged === null) continue;
    if (e.outcome === 'activate') {
      const at = mode === 'effective' ? activateEffective(inputs, ref, logged) : logged;
      if (at !== null) out.push({ ref, via: 'activate', moment: at, order: i, logIndex: i, loggedMs: logged.ms });
    } else if (e.outcome === 'pending_owner') {
      const approved = firstOwner(inputs.owner, 'bench_approved', ref, logged.ms);
      const superseded = earliest([
        ...inputs.log.slice(i + 1).filter((x) => x.outcome === 'activate' || x.outcome === 'pending_owner').map((x) => moment(x.at)),
        ...rollbacks.filter((r) => r.moment.ms > logged.ms).map((r) => r.moment),
      ]);
      if (approved !== null && (superseded === null || approved.ms < superseded.ms)) {
        out.push({ ref, via: 'approved', moment: approved, order: i, logIndex: i, loggedMs: logged.ms });
      }
    }
  }
  return out;
}

/**
 * Lineage guards for `activate` lines whose effective moment comes late: a version never takes effect after a later
 * log line's version already has (it would revert that version), nor after an owner rollback clicked while it was
 * still in flight (logged before the rollback, effective after it). This is how PROTOCOL §8's "最近一次已生效的
 * activate" is read: the latest-logged activate among those in effect, so a stale diff page cannot revert a newer
 * version and an in-flight auto version cannot undo the owner's rollback (plan §6, lineage rules).
 */
function inLineage(c: Candidate, versions: readonly Candidate[], rollbacks: readonly Candidate[]): boolean {
  if (c.via !== 'activate') return true;
  if (versions.some((v) => v.logIndex > c.logIndex && v.moment.ms <= c.moment.ms)) return false;
  return !rollbacks.some((r) => r.moment.ms > c.loggedMs && r.moment.ms <= c.moment.ms);
}

/** Greater moment first; on a tie a rollback beats a version, then the later line / click wins. */
function beats(a: Candidate, b: Candidate): boolean {
  if (a.moment.ms !== b.moment.ms) return a.moment.ms > b.moment.ms;
  const ra = a.via === 'rollback' ? 1 : 0;
  const rb = b.via === 'rollback' ? 1 : 0;
  if (ra !== rb) return ra > rb;
  return a.order > b.order;
}

/**
 * s3 §2.2 / plan §6. None → err('no active benchmark') (freeze → WAIT benchmark_approval). A chosen file
 * whose bytes do not hash to its log entry → throws IntegrityError (exit 3), never an err.
 */
export function resolveBenchmark(inputs: ResolveInputs, at: string, mode: 'effective' | 'head'): Result<Resolution> {
  const now = moment(at);
  if (now === null) return err(`resolveBenchmark: ${at} is not a timestamp`);
  const rollbacks = validRollbacks(inputs);
  const versions = versionCandidates(inputs, mode, rollbacks);
  let best: Candidate | null = null;
  for (const c of [...versions.filter((v) => inLineage(v, versions, rollbacks)), ...rollbacks]) {
    if (c.moment.ms <= now.ms && (best === null || beats(c, best))) best = c;
  }
  if (best === null) return err('no active benchmark');
  const text = inputs.files(best.ref.path);
  if (text === null) throw new IntegrityError(`${best.ref.path} is missing (benchmark log ${best.ref.version})`);
  if (sha256(text) !== best.ref.sha256) throw new IntegrityError(`${best.ref.path} was edited: its bytes no longer match the benchmark log (${best.ref.version})`);
  return ok({ version: best.ref.version, sha256: best.ref.sha256, path: best.ref.path, via: best.via, since: best.moment.iso });
}

/** Forge-root-relative benchmark file as UTF-8, null when absent. */
function benchmarkReader(root: string): (path: string) => string | null {
  return (path) => {
    const abs = join(root, path);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  };
}

/**
 * resolveBenchmark over ctx's files at `at` (default ctx.ports.clock.now()). The round resolves in 'effective' mode
 * once, at 02a-brief's time: 02a reads the cliché list, 02c re-resolves at brief.json's created_at and pins the
 * result, so a view, approval or rollback between 02a and 02c takes effect at the next freeze. A bad engine-log line
 * or an edited version file throws IntegrityError (exit 3); an owner log that needs repair is an err.
 */
export function activeBenchmark(ctx: StepContext, mode: 'effective' | 'head', at: string = ctx.ports.clock.now()): Result<Resolution & { text: string }> {
  const log = readBenchLog(ctx.root);
  if (!log.ok) throw new IntegrityError(log.error);
  const owner = readOwnerLog(ctx.root);
  if (!owner.ok) return err(`owner-log.jsonl needs repair: ${owner.error}`);
  const files = benchmarkReader(ctx.root);
  const resolved = resolveBenchmark({ log: log.value, owner: owner.value, posted: postedBenchNotices(ctx.root), files, autoDelayMs: AUTO_DELAY_MS }, at, mode);
  if (!resolved.ok) return resolved;
  const text = files(resolved.value.path);
  if (text === null || sha256(text) !== resolved.value.sha256) throw new IntegrityError(`${resolved.value.path} changed while it was resolved`);
  return ok({ ...resolved.value, text });
}
