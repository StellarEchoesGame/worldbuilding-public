import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isFamily, type Family } from './config.ts';
import type { StepContext } from './context.ts';
import { parseFreeze } from './freeze.ts';
import { isRecord, readString } from './json.ts';
import { readMarker, sha256Bytes } from './marker.ts';
import { appendMirrorEntry, mirroredAt, type MirrorStatus } from './mirror-log.ts';
import { isTrustedAuthor, type GitHubComment } from './ports.ts';
import { err, ok, type Result } from './result.ts';
import { ensureRoundBranch } from './runner.ts';
import { canonicalJson, verifySeal } from './seal.ts';
import { isIsoTimestamp, type RoundPaths } from './store.ts';
import { IntegrityError } from './task.ts';
import { FORECAST_SLOTS, type Forecast, type ForecastSlot } from './tasks/forecast.ts';

/** Tries per network stage of 03c (one try + 3 retries), then blocked (exit 4). */
export const PROBE_ATTEMPTS = 4;

/** Waits between the tries, on ctx.ports.clock. */
export const PROBE_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000];

export interface SealedForecast {
  forecaster: string;
  family: Family;
  model: string;
  writer_model: boolean;
  items: Forecast[];
}

/** `.sealed/RNN/sealed.json` = canonicalJson of this, forecasts sorted by forecaster. */
export interface SealedForecasts {
  round: string;
  row_id: string;
  brief_sha256: string;
  forecasts: SealedForecast[];
}

/** One forecaster's 03a result (void forecasters contribute nothing to the seal, only to probes-meta.json). */
export interface ForecasterResult {
  forecaster: string;
  family: Family;
  model: string;
  writerModel: boolean;
  status: 'ok' | 'void';
  items: Forecast[];
}

/** `rounds/RNN/probe.json`. */
export interface ProbeRecord {
  probe: string;
  branch: string;
  commit: string;
  issue: number;
  comment_id: number;
  comment_url: string;
  /** GitHub created_at of the probe comment (= freeze.json.probe_created_at). */
  created_at: string;
  /** Local clock after createComment returned (after listComments found it, when a crashed run had posted it). */
  mirrored_at: string;
  /** Tries the comment stage needed in the run that wrote this record (1…PROBE_ATTEMPTS). */
  attempts: number;
}

export type ProbeStage = 'scan' | 'commit' | 'push' | 'comment';

export type ProbeMirrorResult =
  | { status: 'mirrored'; record: ProbeRecord }
  | { status: 'blocked'; stage: ProbeStage; error: string }
  | { status: 'conflict'; error: string };

export interface UnsealResult {
  status: 'valid' | 'invalid';
  /** Empty when valid. */
  reasons: string[];
  remote: 'verified' | 'unavailable' | 'mismatch';
  /** null when invalid; never written to a tracked file. */
  forecasts: SealedForecasts | null;
}

/** The files of the seal and the probe (sealed ones under `.sealed/RNN/`, git-ignored). */
export interface ProbeFiles {
  sealed: string;
  nonce: string;
  probes: string;
  meta: string;
  probe: string;
}

export function probeFiles(paths: RoundPaths): ProbeFiles {
  return {
    sealed: join(paths.sealed, 'sealed.json'),
    nonce: join(paths.sealed, 'nonce.hex'),
    probes: paths.probes,
    meta: join(paths.dir, 'probes-meta.json'),
    probe: join(paths.dir, 'probe.json'),
  };
}

const HEX64 = /^[0-9a-f]{64}$/u;
const COMMIT_SHA = /^[0-9a-f]{40,64}$/u;
const SCAN_PREFIX = 'public-content scan:';
/** Commit placeholder of the pre-commit body scan; the one scan of the body (the sha is hex and cannot add a hit). */
const PREVIEW_COMMIT = '0'.repeat(40);
/** Call kinds whose `started_at` must follow the probe mirror (writers incl. resubmission, decoy, defect; never baseline). */
export const PROBE_ORDERED_KINDS: readonly string[] = ['write', 'decoy', 'defect'];

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `|mirrored_at − created_at|` above this adds the `clock_skew` card flag (PR-B). */
export const CLOCK_SKEW_MS = 5 * 60_000;

export function clockSkewed(record: Pick<ProbeRecord, 'mirrored_at' | 'created_at'>): boolean {
  return Math.abs(Date.parse(record.mirrored_at) - Date.parse(record.created_at)) > CLOCK_SKEW_MS;
}

/** The first line of every probe comment. */
export function probeMarker(round: string): string {
  return `<!-- forge:probe ${round} -->`;
}

/** Pure; drops void forecasters, sorts by forecaster. */
export function buildSealed(round: string, rowId: string, briefSha256: string, results: readonly ForecasterResult[]): SealedForecasts {
  const forecasts = results
    .filter((r) => r.status === 'ok')
    .map((r) => ({ forecaster: r.forecaster, family: r.family, model: r.model, writer_model: r.writerModel, items: r.items.map((i) => ({ slot: i.slot, value: i.value })) }))
    .sort((a, b) => byCodeUnit(a.forecaster, b.forecaster));
  return { round, row_id: rowId, brief_sha256: briefSha256, forecasts };
}

/** English body, hex and ids only; starts with `<!-- forge:probe <round> -->`. */
export function probeCommentBody(round: string, probe: string, commit: string): string {
  return [
    probeMarker(round),
    `**Forecast probe · ${round}** \`sha256(nonce ‖ sealed.json)\` = \`${probe}\``,
    `Committed as \`rounds/${round}/probes.sha256\` in \`${commit}\`. Nonce and forecasts are published at bookkeeping (step 11).`,
    '',
  ].join('\n');
}

const BODY_PROBE = /`sha256\(nonce ‖ sealed\.json\)` = `([0-9a-f]{64})`/u;

/** The probe a probe comment carries, or null when the body has none. */
export function probeOfComment(body: string): string | null {
  return BODY_PROBE.exec(body)?.[1] ?? null;
}

export type ProbeCommentMatch =
  | { kind: 'none' }
  | { kind: 'same'; comment: GitHubComment }
  | { kind: 'other'; comment: GitHubComment; probe: string | null };

/**
 * Probe comments are those by a trusted author (isTrustedAuthor: the repository is public, so anyone else's marked
 * comment is ignored) whose body starts with the round's marker. Any of them carrying another (or no) probe →
 * `other` (a foreign or tampered probe, integrity); else the earliest one with this probe → `same`; else `none`.
 */
export function matchProbeComment(
  comments: readonly GitHubComment[],
  round: string,
  probe: string,
  isSuperseded: (probe: string) => boolean = () => false,
): ProbeCommentMatch {
  const marked = comments
    .filter((c) => isTrustedAuthor(c.authorAssociation) && c.body.trimStart().startsWith(probeMarker(round)))
    .filter((c) => {
      const p = probeOfComment(c.body);
      return p === null || !isSuperseded(p);
    })
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id);
  const foreign = marked.find((c) => probeOfComment(c.body) !== probe);
  if (foreign !== undefined) return { kind: 'other', comment: foreign, probe: probeOfComment(foreign.body) };
  const same = marked[0];
  return same === undefined ? { kind: 'none' } : { kind: 'same', comment: same };
}

/**
 * A probe this round sealed and then superseded by a `--redo-from` (some `markers/stale/<n>/03b-seal.json` lists
 * the bytes of its probes.sha256). A comment carrying it was posted by a run that died before probe.json; 03c posts
 * the current probe next to it instead of treating it as foreign, and 07a ignores it.
 */
export function isSupersededProbe(ctx: StepContext, probe: string): boolean {
  const staleRoot = join(ctx.paths.markers, 'stale');
  if (!existsSync(staleRoot)) return false;
  const rel = ctx.files.rel(ctx.paths.probes);
  const hash = sha256Bytes(Buffer.from(`${probe}\n`, 'utf8'));
  return readdirSync(staleRoot).some((n) => {
    const m = readMarker(join(staleRoot, n, '03b-seal.json'));
    return m !== null && m.ok && m.value.outputs[rel] === hash;
  });
}

function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

export function parseProbeRecord(value: unknown): Result<ProbeRecord> {
  if (!isRecord(value)) return err('probe.json: expected an object');
  const { probe, branch, commit, issue, comment_id: commentId, comment_url: commentUrl, created_at: createdAt, mirrored_at: mirroredAt, attempts } = value;
  if (typeof probe !== 'string' || !HEX64.test(probe)) return err('probe.json.probe: expected 64 lowercase hex digits');
  if (typeof branch !== 'string' || branch.trim() === '') return err('probe.json.branch: expected a branch name');
  if (typeof commit !== 'string' || !COMMIT_SHA.test(commit)) return err('probe.json.commit: expected a commit sha');
  if (!positiveInt(issue) || !positiveInt(commentId)) return err('probe.json: issue and comment_id must be positive integers');
  if (typeof commentUrl !== 'string' || commentUrl === '') return err('probe.json.comment_url: expected a url');
  if (typeof createdAt !== 'string' || !isIsoTimestamp(createdAt) || typeof mirroredAt !== 'string' || !isIsoTimestamp(mirroredAt)) {
    return err('probe.json: created_at and mirrored_at must be ISO 8601 UTC timestamps');
  }
  if (!positiveInt(attempts) || attempts > PROBE_ATTEMPTS) return err(`probe.json.attempts: expected 1…${PROBE_ATTEMPTS}`);
  return ok({ probe, branch, commit, issue, comment_id: commentId, comment_url: commentUrl, created_at: createdAt, mirrored_at: mirroredAt, attempts });
}

function parseItems(value: unknown, at: string): Result<Forecast[]> {
  if (!Array.isArray(value)) return err(`${at}.items: expected an array`);
  const out: Forecast[] = [];
  for (const [i, item] of value.entries()) {
    const slot = readString(item, 'slot');
    const v = readString(item, 'value');
    const known: ForecastSlot | undefined = FORECAST_SLOTS.find((s) => s === slot);
    if (known === undefined || v === null || v === '') return err(`${at}.items[${i}]: expected {slot, value} with a known slot`);
    out.push({ slot: known, value: v });
  }
  return ok(out);
}

/** Narrows parsed `sealed.json` (forecasters unique and sorted by code unit). */
export function parseSealedForecasts(value: unknown): Result<SealedForecasts> {
  if (!isRecord(value)) return err('sealed.json: expected an object');
  const { round, row_id: rowId, brief_sha256: briefSha, forecasts } = value;
  if (typeof round !== 'string' || typeof rowId !== 'string') return err('sealed.json: round and row_id must be strings');
  if (typeof briefSha !== 'string' || !HEX64.test(briefSha)) return err('sealed.json.brief_sha256: expected a SHA-256 hex digest');
  if (!Array.isArray(forecasts)) return err('sealed.json.forecasts: expected an array');
  const out: SealedForecast[] = [];
  for (const [i, f] of forecasts.entries()) {
    const at = `sealed.json.forecasts[${i}]`;
    const forecaster = readString(f, 'forecaster');
    const family = readString(f, 'family');
    const model = readString(f, 'model');
    const writerModel = isRecord(f) ? f['writer_model'] : undefined;
    if (forecaster === null || forecaster === '' || model === null) return err(`${at}: forecaster and model must be strings`);
    if (family === null || !isFamily(family)) return err(`${at}.family: expected a known family`);
    if (typeof writerModel !== 'boolean') return err(`${at}.writer_model: expected a boolean`);
    const prev = out[out.length - 1];
    if (prev !== undefined && byCodeUnit(prev.forecaster, forecaster) >= 0) return err(`${at}: forecasters must be unique and sorted`);
    const items = parseItems(isRecord(f) ? f['items'] : undefined, at);
    if (!items.ok) return items;
    out.push({ forecaster, family, model, writer_model: writerModel, items: items.value });
  }
  return ok({ round, row_id: rowId, brief_sha256: briefSha, forecasts: out });
}

/** The probe of `probes.sha256` (exactly probe hex + LF), else err. */
export function readProbeFile(paths: RoundPaths): Result<string> {
  const path = probeFiles(paths).probes;
  if (!existsSync(path)) return err(`rounds/${paths.id}/probes.sha256 is missing`);
  const text = readFileSync(path, 'utf8');
  const probe = text.slice(0, -1);
  if (!HEX64.test(probe) || text !== `${probe}\n`) return err(`rounds/${paths.id}/probes.sha256: expected 64 lowercase hex digits and a LF`);
  return ok(probe);
}

/** null when absent; err when present but malformed. */
export function readProbeRecord(paths: RoundPaths): Result<ProbeRecord> | null {
  const path = probeFiles(paths).probe;
  if (!existsSync(path)) return null;
  try {
    return parseProbeRecord(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return err('probe.json: not JSON');
  }
}

type Stage<T> = { ok: true; value: T; tries: number } | { ok: false; error: string; scan: boolean };

/** PROBE_ATTEMPTS tries with PROBE_DELAYS_MS waits on the Clock; a public-content scan refusal is never retried. */
async function tryStage<T>(ctx: StepContext, stage: ProbeStage, fn: () => Promise<Result<T>>): Promise<Stage<T>> {
  let last = '';
  for (let k = 1; k <= PROBE_ATTEMPTS; k += 1) {
    const r = await fn();
    if (r.ok) return { ok: true, value: r.value, tries: k };
    last = ctx.redact(r.error);
    if (last.startsWith(SCAN_PREFIX)) return { ok: false, error: last, scan: true };
    ctx.log(`03c-probe-mirror ${stage}: try ${k}/${PROBE_ATTEMPTS} failed: ${last}`);
    const wait = PROBE_DELAYS_MS[Math.min(k - 1, PROBE_DELAYS_MS.length - 1)];
    if (k < PROBE_ATTEMPTS && wait !== undefined) await ctx.ports.clock.sleep(wait);
  }
  return { ok: false, error: last, scan: false };
}

interface SetFile {
  /** Repository-relative, `/`-separated. */
  rel: string;
  text: string;
}

/** Commits the 03c set unless HEAD already carries it byte for byte; returns the HEAD sha that carries it. */
async function commitSet(ctx: StepContext, set: readonly SetFile[], subject: string): Promise<Result<string>> {
  const git = ctx.ports.git;
  const headCarries = async (ref: string): Promise<Result<boolean>> => {
    for (const f of set) {
      const shown = await git.show(ref, f.rel);
      if (!shown.ok) return err(shown.error);
      if (shown.value !== f.text) return ok(false);
    }
    return ok(true);
  };
  const before = await headCarries('HEAD');
  if (!before.ok) return err(before.error);
  if (!before.value) {
    const c = await git.commit(set.map((f) => f.rel), subject);
    if (!c.ok) return err(c.error);
  }
  const head = await git.resolveRef('HEAD');
  if (!head.ok) return err(head.error);
  const after = await headCarries(head.value);
  if (!after.ok) return err(after.error);
  return after.value ? ok(head.value) : err('the commit does not carry the 03c files (ignored or unchanged paths?)');
}

type Posted = { kind: 'posted' | 'reused'; comment: GitHubComment } | { kind: 'conflict'; error: string };

/** listComments first (a crashed run may have posted it), then createComment. */
async function postOnce(ctx: StepContext, issue: number, probe: string, body: string): Promise<Result<Posted>> {
  const listed = await ctx.ports.github.listComments(issue);
  if (!listed.ok) return err(listed.error);
  const match = matchProbeComment(listed.value, ctx.roundId, probe, (p) => isSupersededProbe(ctx, p));
  if (match.kind === 'other') {
    const what = match.probe === null ? 'no probe' : `probe ${match.probe.slice(0, 12)}…`;
    return ok({ kind: 'conflict', error: `issue #${issue} comment ${match.comment.id} is a ${ctx.roundId} probe comment with ${what}, not ${probe.slice(0, 12)}…` });
  }
  if (match.kind === 'same') return ok({ kind: 'reused', comment: match.comment });
  const created = await ctx.ports.github.createComment(issue, body);
  return created.ok ? ok({ kind: 'posted', comment: created.value }) : err(created.error);
}

function readRequired(ctx: StepContext, path: string): string {
  if (!existsSync(path)) throw new IntegrityError(`03c-probe-mirror: ${ctx.files.rel(path)} is missing`);
  return readFileSync(path, 'utf8');
}

/** freeze.json.probe_created_at := record.created_at (every other key and its order untouched); one posted mirror entry. */
function settle(ctx: StepContext, record: ProbeRecord, sourceSha256: string): void {
  let raw: unknown;
  try {
    raw = JSON.parse(readRequired(ctx, ctx.paths.freeze));
  } catch (e) {
    if (e instanceof IntegrityError) throw e;
    throw new IntegrityError(`rounds/${ctx.roundId}/freeze.json: not JSON`);
  }
  const parsed = parseFreeze(raw);
  if (!parsed.ok || !isRecord(raw)) throw new IntegrityError(`rounds/${ctx.roundId}/freeze.json: ${parsed.ok ? 'expected an object' : parsed.error}`);
  const pinned = parsed.value.probe_created_at;
  if (pinned !== null && pinned !== record.created_at) throw new IntegrityError(`rounds/${ctx.roundId}/freeze.json: probe_created_at already records another time than probe.json`);
  if (pinned === null) ctx.files.writeJson(ctx.paths.freeze, { ...raw, probe_created_at: record.created_at });
  const logged = readMirrorPosted(ctx, record);
  if (!logged) {
    appendMirrorEntry(ctx.files, ctx.roundId, {
      at: ctx.ports.clock.now(), kind: 'probe', key: ctx.roundId, source_sha256: sourceSha256, status: 'posted',
      comment_id: record.comment_id, created_at: record.created_at, url: record.comment_url, error: null,
    });
  }
}

function readMirrorPosted(ctx: StepContext, record: ProbeRecord): boolean {
  return mirroredAt(ctx.root, ctx.roundId, 'probe', ctx.roundId) === record.created_at;
}

function logFailure(ctx: StepContext, sourceSha256: string, status: MirrorStatus, error: string): void {
  appendMirrorEntry(ctx.files, ctx.roundId, {
    at: ctx.ports.clock.now(), kind: 'probe', key: ctx.roundId, source_sha256: sourceSha256, status,
    comment_id: null, created_at: null, url: null, error: ctx.redact(error),
  });
}

function blockedOf(stage: ProbeStage, s: { error: string; scan: boolean }): ProbeMirrorResult {
  return { status: 'blocked', stage: s.scan ? 'scan' : stage, error: s.error };
}

/**
 * 03c stages, each idempotent: scan body → commit the 03c set (skip when HEAD already has it) → push →
 * listComments (same probe → reuse; other probe → conflict) else createComment → probe.json, amend
 * freeze.json.probe_created_at, append a `probe` mirror.jsonl entry. An existing probe.json is reused without any
 * network call. `mirror.jsonl` entries use source_sha256 = SHA-256 of the probes.sha256 bytes.
 */
export async function probeMirror(ctx: StepContext): Promise<ProbeMirrorResult> {
  const round = ctx.roundId;
  const files = probeFiles(ctx.paths);
  const probe = readProbeFile(ctx.paths);
  if (!probe.ok) throw new IntegrityError(probe.error);
  const sourceSha = sha256Bytes(readFileSync(files.probes));
  const existing = readProbeRecord(ctx.paths);
  if (existing !== null) {
    if (!existing.ok) throw new IntegrityError(`rounds/${round}/${existing.error}`);
    if (existing.value.probe !== probe.value) return { status: 'conflict', error: `rounds/${round}/probe.json records another probe than probes.sha256` };
    settle(ctx, existing.value, sourceSha);
    return { status: 'mirrored', record: existing.value };
  }
  const frozen = frozenProbeTime(ctx);
  if (frozen !== null && frozen !== undefined) throw new IntegrityError(`rounds/${round}/freeze.json: probe_created_at is set but probe.json is missing`);
  // Scanned before anything is committed: the real body differs only by the commit sha (hex), which cannot add a hit.
  const preview = probeCommentBody(round, probe.value, PREVIEW_COMMIT);
  if (ctx.redact(preview) !== preview) {
    const error = `${SCAN_PREFIX} the probe comment body hits a public-content rule`;
    logFailure(ctx, sourceSha, 'rejected_scan', error);
    return { status: 'blocked', stage: 'scan', error };
  }
  const start = ctx.start();
  const set: SetFile[] = [ctx.paths.start, ctx.paths.topic, ctx.paths.brief, ctx.paths.freeze, ctx.paths.probes].map((abs) => ({
    rel: relative(ctx.repo, abs).split(sep).join('/'),
    text: readRequired(ctx, abs),
  }));
  const branch = await ensureRoundBranch(ctx);
  if (branch !== null) return { status: 'blocked', stage: 'commit', error: ctx.redact(branch) };
  const committed = await tryStage(ctx, 'commit', () => commitSet(ctx, set, `chore: seal forecasts for ${round} (#${start.issue.number})`));
  if (!committed.ok) return blockedOf('commit', committed);
  const body = probeCommentBody(round, probe.value, committed.value);
  const pushed = await tryStage(ctx, 'push', () => ctx.ports.git.push(start.branch));
  if (!pushed.ok) return blockedOf('push', pushed);
  const posted = await tryStage(ctx, 'comment', () => postOnce(ctx, start.issue.number, probe.value, body));
  if (!posted.ok) {
    logFailure(ctx, sourceSha, posted.scan ? 'rejected_scan' : 'failed', posted.error);
    return blockedOf('comment', posted);
  }
  if (posted.value.kind === 'conflict') return { status: 'conflict', error: posted.value.error };
  const comment = posted.value.comment;
  const record: ProbeRecord = {
    probe: probe.value,
    branch: start.branch,
    commit: committed.value,
    issue: start.issue.number,
    comment_id: comment.id,
    comment_url: comment.url,
    created_at: comment.createdAt,
    mirrored_at: ctx.ports.clock.now(),
    attempts: posted.tries,
  };
  const checked = parseProbeRecord(record);
  if (!checked.ok) return { status: 'blocked', stage: 'comment', error: ctx.redact(`GitHub returned an unusable comment: ${checked.error}`) };
  ctx.files.writeJson(files.probe, record);
  settle(ctx, record, sourceSha);
  return { status: 'mirrored', record };
}

function readTextOrNull(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** SHA-256 and row_id of this round's brief.json, or null when it is missing or unreadable. */
function briefFacts(ctx: StepContext): { sha256: string; rowId: string | null } | null {
  if (!existsSync(ctx.paths.brief)) return null;
  const bytes = readFileSync(ctx.paths.brief);
  try {
    return { sha256: sha256Bytes(bytes), rowId: readString(JSON.parse(bytes.toString('utf8')), 'row_id') };
  } catch {
    return null;
  }
}

/** freeze.json.probe_created_at; undefined when freeze.json is missing or invalid. */
function frozenProbeTime(ctx: StepContext): string | null | undefined {
  const text = readTextOrNull(ctx.paths.freeze);
  if (text === null) return undefined;
  try {
    const parsed = parseFreeze(JSON.parse(text));
    return parsed.ok ? parsed.value.probe_created_at : undefined;
  } catch {
    return undefined;
  }
}

/** The earliest writer / resubmission / decoy / defect call (`calls/*.json` started_at, local clock) must follow mirrored_at. */
function orderingProblem(ctx: StepContext, mirroredAtIso: string): string | null {
  if (!existsSync(ctx.paths.calls)) return null;
  let earliest: { label: string; at: number } | null = null;
  for (const name of readdirSync(ctx.paths.calls).sort()) {
    if (!name.endsWith('.json')) continue;
    const label = name.slice(0, -'.json'.length);
    if (!PROBE_ORDERED_KINDS.includes(label.split('-')[0] ?? '')) continue;
    let startedAt: string | null;
    try {
      startedAt = readString(JSON.parse(readFileSync(join(ctx.paths.calls, name), 'utf8')), 'started_at');
    } catch {
      return `ordering: calls/${name} is not JSON`;
    }
    const at = startedAt === null ? Number.NaN : Date.parse(startedAt);
    if (Number.isNaN(at)) return `ordering: calls/${name} has no started_at`;
    if (earliest === null || at < earliest.at) earliest = { label, at };
  }
  if (earliest !== null && earliest.at <= Date.parse(mirroredAtIso)) return `ordering: call ${earliest.label} started before the probe was mirrored`;
  return null;
}

type Remote = { remote: UnsealResult['remote']; reason: string | null };

async function remoteCheck(ctx: StepContext, issue: number | null, probe: string | null, createdAt: string | null): Promise<Remote> {
  if (issue === null || probe === null) return { remote: 'mismatch', reason: 'remote: no probe or issue to compare' };
  const listed = await ctx.ports.github.listComments(issue);
  if (!listed.ok) {
    ctx.log(`unseal: remote probe check unavailable: ${ctx.redact(listed.error)}`);
    return { remote: 'unavailable', reason: null };
  }
  const match = matchProbeComment(listed.value, ctx.roundId, probe, (p) => isSupersededProbe(ctx, p));
  if (match.kind === 'none') return { remote: 'mismatch', reason: `remote: issue #${issue} no longer carries the probe comment` };
  if (match.kind === 'other') return { remote: 'mismatch', reason: `remote: issue #${issue} carries a probe comment with another probe` };
  if (createdAt !== null && match.comment.createdAt !== createdAt) return { remote: 'mismatch', reason: 'remote: the probe comment time differs from probe.json.created_at' };
  return { remote: 'verified', reason: null };
}

function startIssue(ctx: StepContext): number | null {
  try {
    return ctx.start().issue.number;
  } catch {
    return null;
  }
}

/**
 * 07a checks (plan §8 Unseal), every failure appends a reason; the round continues when invalid. In order: files
 * exist and are well-formed; verifySeal; canonical bytes and round / row_id / brief_sha256; probe.json agrees with
 * probes.sha256 and freeze.json.probe_created_at; probe.json.mirrored_at precedes every writer / resubmission /
 * decoy / defect call; the remote comment still carries the probe and time (port error → `unavailable`, not invalid).
 * Reasons are ASCII and never contain forecasts.
 */
export async function unseal(ctx: StepContext): Promise<UnsealResult> {
  const round = ctx.roundId;
  const files = probeFiles(ctx.paths);
  const reasons: string[] = [];
  const probe = readProbeFile(ctx.paths);
  if (!probe.ok) reasons.push(`files: ${probe.error}`);
  const sealedText = readTextOrNull(files.sealed);
  if (sealedText === null) reasons.push(`files: .sealed/${round}/sealed.json is missing`);
  const nonceText = readTextOrNull(files.nonce);
  const nonceHex = nonceText === null ? null : nonceText.slice(0, -1);
  if (nonceHex === null || !HEX64.test(nonceHex) || nonceText !== `${nonceHex}\n`) reasons.push(`files: .sealed/${round}/nonce.hex is missing or malformed`);
  let sealed: SealedForecasts | null = null;
  let sealedValue: unknown = null;
  if (sealedText !== null) {
    try {
      sealedValue = JSON.parse(sealedText);
      const parsed = parseSealedForecasts(sealedValue);
      if (parsed.ok) sealed = parsed.value;
      else reasons.push(`files: ${parsed.error}`);
    } catch {
      reasons.push('files: sealed.json is not JSON');
    }
  }
  if (sealedText !== null && nonceHex !== null && probe.ok && !verifySeal(sealedText, nonceHex, probe.value)) {
    reasons.push('seal: SHA-256(nonce ‖ sealed.json) does not equal probes.sha256');
  }
  if (sealed !== null && sealedText !== null) {
    let canonical: string | null = null;
    try {
      canonical = canonicalJson(sealedValue);
    } catch (e) {
      reasons.push(`canonical: ${message(e)}`);
    }
    if (canonical !== null && canonical !== sealedText) reasons.push('canonical: sealed.json is not in canonical form');
    const brief = briefFacts(ctx);
    if (sealed.round !== round) reasons.push('sealed: round differs from this round');
    if (brief === null) reasons.push(`sealed: rounds/${round}/brief.json is missing or unreadable`);
    else {
      if (sealed.row_id !== brief.rowId) reasons.push('sealed: row_id differs from brief.json');
      if (sealed.brief_sha256 !== brief.sha256) reasons.push('sealed: brief_sha256 differs from brief.json');
    }
  }
  const record = readProbeRecord(ctx.paths);
  let createdAt: string | null = null;
  if (record === null) reasons.push(`probe_record: rounds/${round}/probe.json is missing`);
  else if (!record.ok) reasons.push(`probe_record: ${record.error}`);
  else {
    createdAt = record.value.created_at;
    if (probe.ok && record.value.probe !== probe.value) reasons.push('probe_record: probe.json.probe differs from probes.sha256');
    if (frozenProbeTime(ctx) !== record.value.created_at) reasons.push('probe_record: freeze.json.probe_created_at differs from probe.json.created_at');
    const order = orderingProblem(ctx, record.value.mirrored_at);
    if (order !== null) reasons.push(order);
  }
  const recorded = record !== null && record.ok ? record.value : null;
  const issue = recorded?.issue ?? startIssue(ctx);
  const expected = probe.ok ? probe.value : (recorded?.probe ?? null);
  const remote = await remoteCheck(ctx, issue, expected, createdAt);
  if (remote.reason !== null) reasons.push(remote.reason);
  const valid = reasons.length === 0;
  return { status: valid ? 'valid' : 'invalid', reasons, remote: remote.remote, forecasts: valid ? sealed : null };
}
