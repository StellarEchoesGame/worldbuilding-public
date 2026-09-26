import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBenchLog, type BenchLogEntry } from './bench-log.ts';
import type { CardJson } from './card.ts';
import { isFamily } from './config.ts';
import { parseStartRecord, readGithubConfig, type StepContext } from './context.ts';
import { isRecord, readArray, readRecord, readString } from './json.ts';
import { mergeDecisionFrom } from './merge.ts';
import { appendMirrorEntry, readMirrorLog, type MirrorEntry, type MirrorKind, type MirrorStatus } from './mirror-log.ts';
import { ownerInputs, sha256Bytes, type Decision, type OwnerInputs } from './owner-inputs.ts';
import { isTrustedAuthor, type GitHubComment } from './ports.ts';
import { err, ok, type Result } from './result.ts';
import { loadSchema, type Schema, schemaFile, validate } from './schema.ts';
import { canonicalJson } from './seal.ts';
import { roundPaths } from './store.ts';
import { loadSubmission } from './submission.ts';
import { isRoundTally, type RoundTally } from './tally.ts';

/**
 * Derived mirror queue and drain (plan §8 Mirror, s5 §3; PR-D group D2) over PR-A mirror-log.ts. No queue file: a
 * mirror is pending while its source exists and mirror.jsonl has no `posted` entry for (kind, key, source_sha256).
 * Bodies are English frames starting with mirrorMarker; they carry labels, counts, verdict words, Rxx claims, versions,
 * evidence ids and hashes, never candidate texts, forecasts or paths outside the repository. A drain never changes a
 * round state or an exit code. `probe` is posted inline by 03c (probe.ts), never through this queue.
 */

export type QueuedKind = Exclude<MirrorKind, 'probe'>;

/** Retry n (n ≥ 1 consecutive failures) is allowed min(2^n × MIRROR_BACKOFF_MS, MIRROR_BACKOFF_CAP_MS) after the last failure. */
export const MIRROR_BACKOFF_MS = 60_000;
export const MIRROR_BACKOFF_CAP_MS = 6 * 3600 * 1000;

/**
 * What a body is built from (discriminated by kind). card: after audit.json (blindness), `authors` (label → writer
 * model) only while a decision is ok, else null. decision: the ok decision (never a superseded file) with its hash and
 * its Rxx parallel to decision.facts (err: why the merge cannot number them). bench_notice: the benchmark/log.jsonl entry of this cycle (R00: cycles R00-init and R00).
 * diff_approval: the owner-log entry.
 */
export type MirrorSource =
  | { kind: 'card'; card: CardJson; tally: RoundTally; authors: Record<string, string> | null }
  | { kind: 'decision'; decision: Decision; sha256: string; rxx: Result<string[]> }
  | { kind: 'bench_notice'; entry: BenchLogEntry }
  | { kind: 'diff_approval'; diffSha256: string; approvedAt: string };

export interface PendingMirror {
  round: string;
  kind: QueuedKind;
  /** round (card) · decision sha256 · benchmark version, else the cycle (bench_notice) · diff sha256. */
  key: string;
  /** card: sha256 of `<tally sha>\n<card sha>\n<audit sha>`; decision / diff_approval: the key; bench_notice: sha256(canonicalJson(entry)). */
  source_sha256: string;
  body: string;
  /** Consecutive failed / rejected entries for this source since its last posted entry. */
  failures: number;
  lastError: string | null;
  /** null = never retried automatically (the last entry is rejected_scan); else the earliest next try (ISO). */
  nextAttemptAt: string | null;
}

export interface DrainReport {
  posted: number;
  failed: number;
  rejected: number;
}

const ROUND_ID = /^[A-Z]\d{2}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
/** Error prefix of public-scan.ts scannedGitHub (the second guard behind the drain's own scan). */
const SCAN_PREFIX = 'public-content scan:';
const SCAN_ERROR = `${SCAN_PREFIX} the body hits a public-content rule`;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `<!-- forge:<kind> <round> <key> -->` (probe.ts probeMarker keeps its own round-only form). */
export function mirrorMarker(kind: MirrorKind, round: string, key: string): string {
  return `<!-- forge:${kind} ${round} ${key} -->`;
}

/** min(2^failures min, 6 h) in ms; failures ≥ 1. */
export function mirrorBackoffMs(failures: number): number {
  const n = Math.max(1, Math.floor(failures));
  // 2^9 min already exceeds the cap; larger exponents only risk Infinity
  return n >= 9 ? MIRROR_BACKOFF_CAP_MS : Math.min(2 ** n * MIRROR_BACKOFF_MS, MIRROR_BACKOFF_CAP_MS);
}

// --- card.json narrowing (engine-written by 08; schema/ plus the members the schema subset cannot express; tally.json: tally.ts isRoundTally)

const schemaCache = new Map<string, Schema>();

/** schema/<file> (module-relative, like owner-inputs.ts), or the sub-schema at `path` inside it. */
function schemaOf(file: string, path: readonly string[]): Schema {
  const id = `${file}#${path.join('/')}`;
  const cached = schemaCache.get(id);
  if (cached !== undefined) return cached;
  let raw: unknown = JSON.parse(readFileSync(schemaFile(file), 'utf8'));
  for (const key of path) raw = isRecord(raw) ? raw[key] : null;
  const schema = loadSchema(raw);
  if (!schema.ok) throw new Error(`schema/${file} ${path.join('.')}: ${schema.error}`);
  schemaCache.set(id, schema.value);
  return schema.value;
}

function familyList(value: unknown): boolean {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && isFamily(v));
}

function valuesAre(value: unknown, check: (v: unknown) => boolean): boolean {
  return isRecord(value) && Object.values(value).every(check);
}

function isCount(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

/** card.schema.json plus Family members and numeric by_family maps. */
function isCardJson(value: unknown): value is CardJson {
  if (validate(schemaOf('card.schema.json', []), value).length > 0) return false;
  return (readArray(value, 'entries') ?? []).every((e) => {
    const gate = readRecord(e, 'gate');
    const notes = readArray(gate, 'path_instance_notes') ?? [];
    return familyList(gate?.['counted']) && notes.every((n) => familyList([readString(n, 'family')])) && valuesAre(readRecord(e, 'wins')?.['by_family'], isCount);
  });
}

// --- bodies (pure)

/** One line of free text inside a Markdown frame: no line breaks, no table pipes, no HTML comment openers. */
function inline(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/gu, ' ').replace(/\|/gu, '¦').replace(/<!--/gu, '&lt;!--').trim();
}

function code(text: string): string {
  return `\`${inline(text).replace(/`/gu, 'ʹ')}\``;
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function list(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.map(code).join(', ');
}

/** A trial (|E| ≤ 2 or no champion pair) never merges: the public verdict says so next to the word. */
function verdict(entry: CardJson['entries'][number]): string {
  if (entry.wins.bar === 'trial' || entry.flags.includes('trial')) return 'trial (not mergeable)';
  return entry.wins.beats_champion ? 'beats champion' : 'below bar';
}

function cardLines(round: string, card: CardJson, tally: RoundTally, authors: Record<string, string> | null): string[] {
  const head = ['Label', 'Bar', 'Wins', 'Needed', 'E', 'Verdict', 'Fact gate', 'Mergeable', 'Facts (to register)', 'Flags', 'Text sha256'];
  if (authors !== null) head.push('Author model');
  const rows = [...card.entries]
    .sort((a, b) => byCodeUnit(a.label, b.label))
    .map((e) => {
      const cells = [
        inline(e.label), inline(e.wins.bar), String(e.wins.total), String(e.wins.needed), String(e.wins.e), verdict(e), e.gate.outcome, yesNo(e.mergeable),
        `${e.facts.length} (${e.facts.filter((f) => f.register).length})`, list(e.flags), code(e.text_sha256),
      ];
      if (authors !== null) cells.push(code(authors[e.label] ?? 'unknown'));
      return `| ${cells.join(' | ')} |`;
    });
  const v = tally.voids;
  return [
    `**Decision card · ${round}** — row ${code(card.row_id)}, benchmark ${code(card.benchmark)}, champion kind ${code(card.champion)}, ${tally.session_pairs} session-pairs per champion pair.`,
    `Round flags: ${list(card.flags)}.`,
    '',
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows,
    '',
    `Calls ${v.calls} · void tasks ${v.void_tasks} · retried tasks ${v.retried_tasks} · session reruns ${v.session_reruns} · dropped families ${v.dropped_families}.`,
    authors === null ? 'Author models are shown once the owner decision is recorded.' : 'Author models are shown because the owner decision is recorded.',
  ];
}

/** Registered facts in Rxx order; facts the merge cannot number are listed in the owner's order with the reason and no id. */
function factLines(decision: Decision, rxx: Result<string[]>): string[] {
  const n = decision.facts.length;
  if (n === 0) return ['No facts registered.'];
  if (!rxx.ok) {
    const facts = decision.facts.map((f) => `- label ${inline(f.label)}, fact ${code(f.id)} — ${inline(f.claim)}`);
    return [`Facts not numbered (${n}): the merge cannot register them (${inline(rxx.error)}).`, ...facts];
  }
  const ids = rxx.value;
  const facts = decision.facts
    .map((f, i) => ({ f, rxx: ids[i] ?? '' }))
    .sort((a, b) => byCodeUnit(a.rxx, b.rxx))
    .map(({ f, rxx: id }) => `- ${id} · label ${inline(f.label)}, fact ${code(f.id)} — ${inline(f.claim)}`);
  return [`Registered facts (${n}):`, ...facts];
}

function decisionLines(round: string, key: string, decision: Decision, rxx: Result<string[]>): string[] {
  const pick = decision.pick === 'none' ? '**none** (no merge this round)' : `**${inline(decision.pick)}**`;
  const base = decision.pick === 'none' ? '' : ` · base **${inline(decision.base ?? decision.pick)}**`;
  return [
    `**Owner decision · ${round}** — decision file sha256 ${code(key)}; ${decision.supersedes === null ? 'first decision of the round' : `supersedes ${code(decision.supersedes)}`}.`,
    `Pick ${pick}${base} · favourite ${inline(decision.fav)} · reason ${inline(decision.reason)} · happened ${yesNo(decision.happened)} · publish ${inline(decision.publish)}.`,
    '',
    ...factLines(decision, rxx),
    '',
    `Decided at ${inline(decision.decided_at)}.`,
  ];
}

function benchLines(round: string, e: BenchLogEntry): string[] {
  const version = e.version === null ? 'no candidate version' : `version ${code(e.version)}${e.parent === null ? '' : ` (parent ${code(e.parent)})`}`;
  const replay = e.replay === null ? 'not run' : `${e.replay.passed ? 'passed' : 'failed'} (${code(e.replay.reason)}), pooled old ${e.replay.pooled.old} / new ${e.replay.pooled.new} over ${e.replay.pooled.n}`;
  return [
    `**Benchmark notice · ${round}** — cycle ${code(e.cycle)}, outcome ${code(e.outcome)}, ${version}, activation ${e.activation === null ? 'none' : code(e.activation)}.`,
    `Candidate sha256 ${e.sha256 === null ? 'none' : code(e.sha256)} · protocol bundle sha256 ${code(e.protocol_bundle_sha256)}.`,
    `Changed keys: ${list(e.changed_keys)}.`,
    `Evidence ids: ${list(e.evidence_ids)} · evidence packet sha256 ${e.evidence_packet_sha256 === null ? 'none' : code(e.evidence_packet_sha256)}.`,
    `Replay: ${replay}.`,
    `Reasons ${e.reasons.length} · errors ${e.errors.length} · dropped clichés ${e.dropped_cliches.length} · calls ${e.calls.length}.`,
    `Logged at ${inline(e.at)}.`,
  ];
}

/** Pure; first line mirrorMarker(source.kind, round, key). */
export function mirrorBody(round: string, key: string, source: MirrorSource): string {
  const lines = [mirrorMarker(source.kind, round, key)];
  switch (source.kind) {
    case 'card':
      lines.push(...cardLines(round, source.card, source.tally, source.authors));
      break;
    case 'decision':
      lines.push(...decisionLines(round, key, source.decision, source.rxx));
      break;
    case 'bench_notice':
      lines.push(...benchLines(round, source.entry));
      break;
    case 'diff_approval':
      lines.push(`**Final diff approved · ${round}** — approval diff sha256 ${code(source.diffSha256)}, approved by the owner at ${inline(source.approvedAt)}.`);
      break;
  }
  return `${lines.join('\n')}\n`;
}

// --- the derived queue

interface QueuedSource {
  kind: QueuedKind;
  key: string;
  sourceSha256: string;
  source: MirrorSource;
}

type Loaded = { value: unknown; sha256: string } | null;

/** Forge-root-relative JSON file: null when absent, err when unreadable or not JSON. */
function loadJson(root: string, rel: string): Result<Loaded> {
  const path = join(root, rel);
  if (!existsSync(path)) return ok(null);
  try {
    const bytes = readFileSync(path);
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    return ok({ value, sha256: sha256Bytes(bytes) });
  } catch (e) {
    return err(`${rel}: ${e instanceof SyntaxError ? 'not JSON' : message(e)}`);
  }
}

function sha256Text(text: string): string {
  return sha256Bytes(Buffer.from(text, 'utf8'));
}

/**
 * Rxx parallel to decision.facts, from merge.ts mergeDecisionFrom over card.json's entries: the card lists every
 * labelled candidate with its delta facts in delta order, as sourcesFromRound gives them to the merge, so the body
 * carries exactly the ids the merge registers (pinned in mirror.test.ts). err = the merge cannot number the facts
 * (no card.json, pick none with facts, a fact outside its candidate's delta); the body then shows no id.
 */
function decisionRxx(decision: Decision, card: CardJson | null): Result<string[]> {
  if (decision.facts.length === 0) return ok([]);
  if (card === null) return err(`rounds/${decision.round}/card.json is missing`);
  const merged = mergeDecisionFrom(decision, card.entries, card.row_id);
  if (!merged.ok) return err(merged.error);
  const { registered } = merged.value;
  return ok(decision.facts.map((f) => registered.find((r) => r.label === f.label && r.factId === f.id)?.rxx ?? ''));
}

/** Card label → writer model of its submission (shown only once a decision is ok). */
function authorsOf(root: string, round: string, card: CardJson): Result<Record<string, string>> {
  const paths = roundPaths(root, round);
  const out: Record<string, string> = {};
  for (const e of card.entries) {
    const sub = loadSubmission(paths, e.submission);
    if (sub === null) return err(`rounds/${round}/submissions/${e.submission}.json: missing or malformed`);
    out[e.label] = sub.model;
  }
  return ok(out);
}

/** tally.json + card.json, both present and well-formed; null while either is absent. */
function loadCard(root: string, round: string): Result<{ card: CardJson; tally: RoundTally; sha256: { card: string; tally: string } } | null> {
  const tally = loadJson(root, `rounds/${round}/tally.json`);
  if (!tally.ok) return tally;
  const card = loadJson(root, `rounds/${round}/card.json`);
  if (!card.ok) return card;
  if (tally.value === null || card.value === null) return ok(null);
  const t = tally.value.value;
  const c = card.value.value;
  if (!isRoundTally(t)) return err(`rounds/${round}/tally.json: not a tally v2 (schema/tally.schema.json)`);
  if (!isCardJson(c)) return err(`rounds/${round}/card.json: not a decision card (schema/card.schema.json)`);
  return ok({ card: c, tally: t, sha256: { card: card.value.sha256, tally: tally.value.sha256 } });
}

/** benchmark/log.jsonl cycles whose notices a round mirrors: round 0 holds the initial benchmark (R00-init) and its own cycle. */
function cyclesOf(round: string): readonly string[] {
  return round === 'R00' ? ['R00-init', 'R00'] : [round];
}

/** Every source of the round that exists now (plan §8 table), in kind order card, decision, bench_notice, diff_approval. */
function queuedSources(root: string, round: string, owner: OwnerInputs): Result<QueuedSource[]> {
  const out: QueuedSource[] = [];
  const loaded = loadCard(root, round);
  if (!loaded.ok) return loaded;
  const decision = owner.decision(round);
  const card = loaded.value;
  const audit = owner.audit(round);
  // blindness: panel verdicts reach the public issue only after the owner's audit
  if (card !== null && audit.state === 'ok') {
    const authors = decision.state === 'ok' ? authorsOf(root, round, card.card) : ok(null);
    if (!authors.ok) return authors;
    out.push({
      kind: 'card', key: round, sourceSha256: sha256Text([card.sha256.tally, card.sha256.card, audit.sha256].join('\n')),
      source: { kind: 'card', card: card.card, tally: card.tally, authors: authors.value },
    });
  }
  // only while the owner reader says ok: a superseded, invalid or unlogged decision file is never mirrored
  if (decision.state === 'ok') {
    const rxx = decisionRxx(decision.value, card?.card ?? null);
    out.push({ kind: 'decision', key: decision.sha256, sourceSha256: decision.sha256, source: { kind: 'decision', decision: decision.value, sha256: decision.sha256, rxx } });
  }
  const bench = readBenchLog(root);
  if (!bench.ok) return bench;
  const cycles = cyclesOf(round);
  for (const entry of bench.value.filter((e) => cycles.includes(e.cycle))) {
    out.push({ kind: 'bench_notice', key: entry.version ?? entry.cycle, sourceSha256: sha256Text(canonicalJson(entry)), source: { kind: 'bench_notice', entry } });
  }
  const final = loadJson(root, `rounds/${round}/final.json`);
  if (!final.ok) return final;
  const diffSha = readString(final.value?.value, 'approval_diff_sha256');
  const approvedAt = diffSha !== null && HEX64.test(diffSha) ? owner.diffApproved(round, diffSha) : null;
  if (diffSha !== null && approvedAt !== null) {
    out.push({ kind: 'diff_approval', key: diffSha, sourceSha256: diffSha, source: { kind: 'diff_approval', diffSha256: diffSha, approvedAt } });
  }
  return ok(out);
}

/** mirrorBody plus the source hash the drain matches listed comments by (a card redone after 08 keeps its key). */
function bodyOf(round: string, s: QueuedSource): string {
  return `${mirrorBody(round, s.key, s.source)}\n<sub>forge source sha256 \`${s.sourceSha256}\`</sub>\n`;
}

function pendingOf(round: string, s: QueuedSource, entries: readonly MirrorEntry[], now: string): PendingMirror {
  const last = entries.at(-1);
  let nextAttemptAt: string | null = now;
  if (last !== undefined) nextAttemptAt = last.status === 'rejected_scan' ? null : new Date(Date.parse(last.at) + mirrorBackoffMs(entries.length)).toISOString();
  return {
    round, kind: s.kind, key: s.key, source_sha256: s.sourceSha256, body: bodyOf(round, s), failures: entries.length, lastError: last?.error ?? null, nextAttemptAt,
  };
}

/** Every queued mirror of the round whose source exists and is not posted (the UI shows the count). err = unreadable log / source. */
export function pendingMirrors(root: string, round: string, now: string): Result<PendingMirror[]> {
  if (!ROUND_ID.test(round)) return err(`mirror: round id must look like R01, got ${JSON.stringify(round)}`);
  const log = readMirrorLog(root, round);
  if (!log.ok) return log;
  const sources = queuedSources(root, round, ownerInputs(root));
  if (!sources.ok) return sources;
  const out: PendingMirror[] = [];
  for (const s of sources.value) {
    const entries = log.value.filter((e) => e.kind === s.kind && e.key === s.key && e.source_sha256 === s.sourceSha256);
    // pending = no posted entry for (kind, key, source); what is left are its failed / rejected tries
    if (entries.some((e) => e.status === 'posted')) continue;
    out.push(pendingOf(round, s, entries, now));
  }
  return ok(out);
}

/** start.json issue.number; R00 → github.json epic issue. */
export function mirrorIssue(root: string, round: string): Result<number> {
  if (!ROUND_ID.test(round)) return err(`mirror: round id must look like R01, got ${JSON.stringify(round)}`);
  if (round === 'R00') {
    const github = readGithubConfig(root);
    return github.ok ? ok(github.value.epicIssue) : err(github.error);
  }
  const start = loadJson(root, `rounds/${round}/start.json`);
  if (!start.ok) return err(start.error);
  if (start.value === null) return err(`rounds/${round}/start.json is missing`);
  const parsed = parseStartRecord(start.value.value);
  return parsed.ok ? ok(parsed.value.issue.number) : err(`rounds/${round}/${parsed.error}`);
}

// --- drain

function isDue(p: PendingMirror, now: string): boolean {
  return p.nextAttemptAt !== null && Date.parse(p.nextAttemptAt) <= Date.parse(now);
}

function record(ctx: StepContext, p: PendingMirror, status: MirrorStatus, comment: GitHubComment | null, error: string | null): void {
  appendMirrorEntry(ctx.files, ctx.roundId, {
    at: ctx.ports.clock.now(), kind: p.kind, key: p.key, source_sha256: p.source_sha256, status,
    comment_id: comment?.id ?? null, created_at: comment?.createdAt ?? null, url: comment?.url ?? null, error: error === null ? null : ctx.redact(error),
  });
}

/**
 * The earliest comment by a trusted author (the repository is public: anyone can post a marker) whose first line is the
 * mirror's marker and which carries its source hash: a run that died after createComment, or a fresh clone.
 */
function postedComment(comments: readonly GitHubComment[], p: PendingMirror): GitHubComment | null {
  const marker = mirrorMarker(p.kind, p.round, p.key);
  const matching = comments
    .filter((c) => isTrustedAuthor(c.authorAssociation) && (c.body.trimStart().split('\n', 1)[0] ?? '').trimEnd() === marker && c.body.includes(`\`${p.source_sha256}\``))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id);
  return matching[0] ?? null;
}

async function drain(ctx: StepContext, report: DrainReport): Promise<void> {
  const round = ctx.roundId;
  const now = ctx.ports.clock.now();
  const pending = pendingMirrors(ctx.root, round, now);
  if (!pending.ok) {
    ctx.log(`mirror ${round}: ${ctx.redact(pending.error)}`);
    return;
  }
  const clean: PendingMirror[] = [];
  for (const p of pending.value.filter((m) => isDue(m, now))) {
    // scanned before any GitHub call; scannedGitHub stays the second guard
    if (ctx.redact(p.body) === p.body) {
      clean.push(p);
      continue;
    }
    record(ctx, p, 'rejected_scan', null, SCAN_ERROR);
    report.rejected += 1;
  }
  if (clean.length === 0) return;
  const fail = (error: string): void => {
    for (const p of clean) record(ctx, p, 'failed', null, error);
    report.failed += clean.length;
  };
  const issue = mirrorIssue(ctx.root, round);
  if (!issue.ok) return fail(issue.error);
  // without the list a crashed post cannot be told apart from a missing one: nothing is posted blind
  const listed = await ctx.ports.github.listComments(issue.value);
  if (!listed.ok) return fail(listed.error);
  for (const p of clean) {
    const reused = postedComment(listed.value, p);
    if (reused !== null) {
      record(ctx, p, 'posted', reused, null);
      report.posted += 1;
      continue;
    }
    const created = await ctx.ports.github.createComment(issue.value, p.body);
    if (created.ok) {
      record(ctx, p, 'posted', created.value, null);
      report.posted += 1;
    } else if (ctx.redact(created.error).startsWith(SCAN_PREFIX)) {
      record(ctx, p, 'rejected_scan', null, created.error);
      report.rejected += 1;
    } else {
      record(ctx, p, 'failed', null, created.error);
      report.failed += 1;
    }
  }
}

/**
 * Drains ctx.roundId: first re-records `posted` from trusted listComments markers (fresh clone, crash after post), then
 * per due item: ctx.redact(body) ≠ body → `rejected_scan` entry, no GitHub call; else createComment → `posted` /
 * `failed`. Never throws for a port error; appends via mirror-log.ts appendMirrorEntry.
 */
export async function drainMirrors(ctx: StepContext): Promise<DrainReport> {
  const report: DrainReport = { posted: 0, failed: 0, rejected: 0 };
  try {
    await drain(ctx, report);
  } catch (e) {
    // a mirror never changes a round state or an exit code: even a file error only ends this drain
    ctx.log(`mirror ${ctx.roundId}: drain stopped: ${ctx.redact(message(e))}`);
  }
  if (report.posted + report.failed + report.rejected > 0) {
    ctx.log(`mirror ${ctx.roundId}: posted ${report.posted}, failed ${report.failed}, rejected ${report.rejected}`);
  }
  return report;
}
