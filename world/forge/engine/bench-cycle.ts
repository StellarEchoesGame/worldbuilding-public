import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeBenchmark } from './bench-active.ts';
import { rollbackHolds, validateCandidate, type CandidateVerdict } from './bench-check.ts';
import { buildEvidence, collectEvidence, evidencePath, parseEvidencePacket, readEvidencePacket, type EvidencePacket } from './bench-evidence.ts';
import { appendBenchLogOnce, BENCH_LOG, loadVersion, nextVersion, parseBenchLog, readBenchLog, VERSION_ID, writeVersion } from './bench-log.ts';
import type { BenchActivation, BenchLogEntry, BenchOutcome, ReplaySummary, VersionRef } from './bench-log.ts';
import { assembleCandidate, authorityTable, citedIds, dropCanonCliches, initialTask, logReasons, maintainerTask, V1_INPUTS } from './bench-propose.ts';
import type { BenchReason, MaintainerOutput, NoChangeReason } from './bench-propose.ts';
import { parseReplayResult, REPLAY_FILE, runReplay } from './bench-replay.ts';
import type { RollbackEntry } from './bench-validate.ts';
import { callRecordPath } from './calls.ts';
import type { Family } from './config.ts';
import type { StepContext } from './context.ts';
import { isRecord, readBoolean, readNumber, readRecord, readString, stringArray, type JsonRecord } from './json.ts';
import { OWNER_ANSWERS, OWNER_LOG, protocolGate, type OwnerInputs, type OwnerRead } from './owner-inputs.ts';
import { err, ok, type Result } from './result.ts';
import { engineJsonlLogs, type StepDef, type StepOutcome, type WaitReason } from './runner.ts';
import { sha256, type RoundPaths } from './store.ts';
import { IntegrityError, readTaskRecord, runTask, type TaskSpec } from './task.ts';
import { readCanaryFailed, readTrustStatus, trustPins, TRUST_STATUS } from './trust-status.ts';

/*
 * The benchmark cycle on the shared runner (plan §6, §4 rows 34–38): 11f evidence, 11g propose, 11h validate, 11i
 * replay, 11j outcome for R rounds (ROUND_STEPS) and round 0 (bench-r00 pipeline on rounds/R00/, cycle R00), and
 * i1–i3 for the initial v1 (bench-initial pipeline under benchmark/initial/, cycle R00-init). Outcome side effects,
 * each idempotent: protocol gate → writeVersion → appendBenchLogOnce → marker (activate / pending_owner only for the
 * first two); the bench_notice mirror is derived from the log line by mirror.ts.
 */

/** Round-local cycle files (under RoundPaths.bench; bench-initial: benchmark/initial/). */
export const PROPOSAL_FILE = 'proposal.json';
export const CANDIDATE_FILE = 'candidate.json';
export const VALIDATE_FILE = 'validate.json';
export const OUTCOME_FILE = 'outcome.json';
/** Cycle id of the initial proposal. */
export const INITIAL_CYCLE = 'R00-init';
/** Forge-root-relative directory of the bench-initial pipeline. */
export const INITIAL_DIR = 'benchmark/initial';

/** `proposal.json` (11g / i1): the version is allocated once (nextVersion) and reused by reruns. */
export interface ProposalFile {
  cycle: string;
  version: string;
  parent: string | null;
  parent_sha256: string | null;
  evidence_packet: string | null;
  evidence_packet_sha256: string | null;
  /** null = void after the retry (outcome no_change_invalid). */
  output: MaintainerOutput | null;
  errors: string[];
  task: string;
  /** Forge-root-relative call records of the maintainer attempts. */
  calls: string[];
  /** Served model (task record), else the backend model: `author.model` of the candidate. */
  model: string;
  dropped_cliches: string[];
}

/** `validate.json` (11h / i2). */
export interface ValidateFile {
  version: string;
  parent: string | null;
  verdict: CandidateVerdict;
  /** Strongest §11 class of the changed keys before the hold upgrade (replay runs iff any changed key is replay). */
  base_activation: BenchActivation | null;
  holds: RollbackEntry[];
}

export interface OutcomeInput {
  output: MaintainerOutput | null;
  verdict: CandidateVerdict | null;
  replay: ReplaySummary | null;
}

/** What 11j / i3 logs, before `at` is stamped. */
export interface LogEntryInput {
  at: string;
  cycle: string;
  outcome: BenchOutcome;
  proposal: ProposalFile;
  verdict: CandidateVerdict | null;
  replay: ReplaySummary | null;
  /** benchmark/vN.json for activate / pending_owner; else null. */
  written: VersionRef | null;
  /** Forge-root-relative candidate.json when one exists and was not written as a version. */
  candidatePath: string | null;
  candidateSha256: string | null;
  bundleSha256: string;
}

const STRENGTH: Readonly<Record<BenchActivation, number>> = { auto: 0, replay: 1, owner: 2 };
const ACTIVATIONS: readonly BenchActivation[] = ['auto', 'replay', 'owner'];
/** Owner-log read failures from the shared readers start with this (WAIT owner_log_repair, never exit 3). */
const OWNER_REPAIR = 'owner-log.jsonl needs repair';

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** First match: null → no_change_invalid; no_change or verdict.noChange → no_change; !ok → rejected_validate; replay failed → rejected_by_replay; owner → pending_owner; else activate. */
export function decideOutcome(p: OutcomeInput): BenchOutcome {
  if (p.output === null) return 'no_change_invalid';
  if (p.output.kind === 'no_change' || p.verdict?.noChange === true) return 'no_change';
  if (p.verdict === null || !p.verdict.ok) return 'rejected_validate';
  if (p.replay !== null && !p.replay.passed) return 'rejected_by_replay';
  return p.verdict.activation === 'owner' ? 'pending_owner' : 'activate';
}

/** Strongest class of `changed` under `activation` (unknown key → owner); null when nothing changed. */
export function baseActivation(changed: readonly string[], activation: Readonly<Record<string, BenchActivation>>): BenchActivation | null {
  let strongest: BenchActivation | null = null;
  for (const key of changed) {
    const cls = activation[key] ?? 'owner';
    if (strongest === null || STRENGTH[cls] > STRENGTH[strongest]) strongest = cls;
  }
  return strongest;
}

/** True iff some changed key's own class (before the hold upgrade) is replay. */
export function needsReplay(changed: readonly string[], activation: Readonly<Record<string, BenchActivation>>): boolean {
  return changed.some((key) => activation[key] === 'replay');
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

/** Outcomes that burn a version number (the log line names the candidate). */
function namesVersion(outcome: BenchOutcome): boolean {
  return outcome !== 'no_change' && outcome !== 'no_change_invalid';
}

function logErrors(p: LogEntryInput): string[] {
  const v = p.verdict;
  if (p.outcome === 'no_change_invalid') return [...p.proposal.errors];
  if (p.outcome === 'no_change') return v?.noChange === true ? [...v.errors] : [];
  if (p.outcome === 'rejected_validate') return v === null ? ['no validation verdict'] : unique([...v.errors, ...v.slotErrors, ...v.versionErrors]);
  return [];
}

/** The log line of a cycle (source engine, protocol_bundle_sha256, reasons via logReasons, evidence_ids via citedIds). */
export function buildLogEntry(p: LogEntryInput): BenchLogEntry {
  const named = namesVersion(p.outcome);
  const output = p.proposal.output;
  return {
    at: p.at,
    cycle: p.cycle,
    outcome: p.outcome,
    version: named ? p.proposal.version : null,
    parent: p.proposal.parent,
    sha256: named ? (p.written?.sha256 ?? p.candidateSha256) : null,
    path: named ? (p.written?.path ?? p.candidatePath) : null,
    activation: named ? (p.verdict?.activation ?? null) : null,
    changed_keys: [...(p.verdict?.changedKeys ?? [])],
    evidence_packet: p.proposal.evidence_packet,
    evidence_packet_sha256: p.proposal.evidence_packet_sha256,
    evidence_ids: output === null ? [] : citedIds(output),
    reasons: output === null ? [] : logReasons(output),
    errors: logErrors(p),
    replay: p.replay,
    dropped_cliches: [...p.proposal.dropped_cliches],
    protocol_bundle_sha256: p.bundleSha256,
    calls: [...p.proposal.calls],
    source: 'engine',
  };
}

/** `R00-init` for bench-initial, else ctx.roundId (R00 for bench-r00). */
export function benchCycle(ctx: StepContext): string {
  return ctx.pipeline === 'bench-initial' ? INITIAL_CYCLE : ctx.roundId;
}

/** RoundPaths of the bench-initial pipeline: id R00, dir and bench = benchmark/initial, runs .runs/bench-initial, sealed .sealed/bench-initial. */
export function initialPaths(root: string): RoundPaths {
  const dir = join(root, INITIAL_DIR);
  const sealed = join(root, '.sealed', 'bench-initial');
  return {
    root,
    id: 'R00',
    dir,
    runs: join(root, '.runs', 'bench-initial'),
    calls: join(dir, 'calls'),
    submissions: join(dir, 'submissions'),
    taste: join(dir, 'taste'),
    progress: join(dir, 'progress.jsonl'),
    markers: join(dir, 'markers'),
    tasks: join(dir, 'tasks'),
    gate: join(dir, 'gate'),
    measures: join(dir, 'measures'),
    merge: join(dir, 'merge'),
    bookkeeping: join(dir, 'bookkeeping'),
    bench: dir,
    status: join(dir, 'status.json'),
    start: join(dir, 'start.json'),
    topic: join(dir, 'topic.json'),
    brief: join(dir, 'brief.json'),
    freeze: join(dir, 'freeze.json'),
    probes: join(dir, 'probes.sha256'),
    sealed,
    sealedTasks: join(sealed, 'tasks'),
  };
}

/** Why `--initial` is refused (a calib_answers owner-log entry or calibration/owner-answers.json exists), else null. */
export function initialRefusal(root: string, owner: OwnerInputs): string | null {
  if (owner.entries().some((e) => e.action === 'calib_answers')) {
    return 'bench propose --initial is refused: owner-log.jsonl already has a calib_answers entry (v1 must be logged before the first calibration answer)';
  }
  if (existsSync(join(root, OWNER_ANSWERS))) {
    return `bench propose --initial is refused: ${OWNER_ANSWERS} exists (v1 must be logged before the first calibration answer)`;
  }
  return null;
}

/** Replay pool: trustPins(status, ctx.roundId, judges, canary failures, protocol.calibration).eligibleFamilies. */
export function replayFamilies(ctx: StepContext): Result<Family[]> {
  const status = readTrustStatus(ctx.root);
  if (status !== null && !status.ok) return err(`${TRUST_STATUS}: ${status.error}`);
  const canary = readCanaryFailed(ctx.root);
  if (!canary.ok) return canary;
  const pins = trustPins(status === null ? null : status.value, ctx.roundId, ctx.config.judges, canary.value, ctx.protocol.calibration);
  return pins.ok ? ok(pins.value.eligibleFamilies) : pins;
}

/* Parsers of the cycle files read back from disk (a malformed file is an integrity error at the call site). */

function nullableString(value: JsonRecord, key: string): string | null | undefined {
  const v = value[key];
  return v === null ? null : typeof v === 'string' ? v : undefined;
}

function strings(value: JsonRecord, key: string): string[] | null {
  return stringArray(value[key]);
}

function parseNoChangeReason(raw: unknown): NoChangeReason | null {
  const text = readString(raw, 'text');
  const ids = isRecord(raw) ? strings(raw, 'evidence_ids') : null;
  return text === null || ids === null ? null : { text, evidence_ids: ids };
}

function parseBenchReason(raw: unknown): BenchReason | null {
  const change = readString(raw, 'change');
  const effect = readString(raw, 'expected_effect');
  const keys = isRecord(raw) ? strings(raw, 'keys') : null;
  const ids = isRecord(raw) ? strings(raw, 'evidence_ids') : null;
  return change === null || effect === null || keys === null || ids === null ? null : { change, keys, evidence_ids: ids, expected_effect: effect };
}

function parseList<T>(raw: unknown, item: (r: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw)) return null;
  const out: T[] = [];
  for (const r of raw) {
    const parsed = item(r);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

function parseOutput(raw: unknown): Result<MaintainerOutput | null> {
  if (raw === null) return ok(null);
  const kind = readString(raw, 'kind');
  const reasons = isRecord(raw) ? raw['reasons'] : null;
  if (kind === 'no_change') {
    const list = parseList(reasons, parseNoChangeReason);
    return list === null ? err('output.reasons: malformed no_change reasons') : ok({ kind, reasons: list });
  }
  const body = readRecord(raw, 'body');
  if (kind !== 'change' || body === null) return err('output: expected null, a no_change or a change with a body');
  const list = parseList(reasons, parseBenchReason);
  return list === null ? err('output.reasons: malformed change reasons') : ok({ kind, body, reasons: list });
}

function parseProposal(value: unknown): Result<ProposalFile> {
  if (!isRecord(value)) return err('expected an object');
  const cycle = readString(value, 'cycle');
  const version = readString(value, 'version');
  const task = readString(value, 'task');
  const model = readString(value, 'model');
  const parent = nullableString(value, 'parent');
  const parentSha = nullableString(value, 'parent_sha256');
  const packet = nullableString(value, 'evidence_packet');
  const packetSha = nullableString(value, 'evidence_packet_sha256');
  const errors = strings(value, 'errors');
  const calls = strings(value, 'calls');
  const dropped = strings(value, 'dropped_cliches');
  if (cycle === null || version === null || !VERSION_ID.test(version) || task === null || model === null) return err('cycle, version (v<N>), task and model are required');
  if (parent === undefined || parentSha === undefined || packet === undefined || packetSha === undefined) return err('parent, parent_sha256, evidence_packet and evidence_packet_sha256 must be strings or null');
  if (errors === null || calls === null || dropped === null) return err('errors, calls and dropped_cliches must be string arrays');
  const output = parseOutput(value['output']);
  if (!output.ok) return output;
  return ok({ cycle, version, parent, parent_sha256: parentSha, evidence_packet: packet, evidence_packet_sha256: packetSha, output: output.value, errors, task, calls, model, dropped_cliches: dropped });
}

function isActivation(value: unknown): value is BenchActivation {
  return ACTIVATIONS.some((a) => a === value);
}

function parseVerdict(raw: unknown): Result<CandidateVerdict> {
  if (!isRecord(raw)) return err('verdict: expected an object');
  const okFlag = readBoolean(raw, 'ok');
  const noChange = readBoolean(raw, 'noChange');
  const errors = strings(raw, 'errors');
  const changed = strings(raw, 'changedKeys');
  const slotErrors = strings(raw, 'slotErrors');
  const versionErrors = strings(raw, 'versionErrors');
  const activation = raw['activation'];
  if (okFlag === null || noChange === null || errors === null || changed === null || slotErrors === null || versionErrors === null) return err('verdict: ok, noChange and the four string lists are required');
  if (activation !== null && !isActivation(activation)) return err('verdict.activation: auto, replay, owner or null');
  return ok({ ok: okFlag, errors, changedKeys: changed, activation, noChange, slotErrors, versionErrors });
}

function parseHolds(raw: unknown): RollbackEntry[] | null {
  return parseList(raw, (h) => {
    const round = readNumber(h, 'round');
    const keys = isRecord(h) ? strings(h, 'rolledBackKeys') : null;
    return round === null || !Number.isInteger(round) || round < 0 || keys === null ? null : { round, rolledBackKeys: keys };
  });
}

function parseValidate(value: unknown): Result<ValidateFile> {
  if (!isRecord(value)) return err('expected an object');
  const version = readString(value, 'version');
  const parent = nullableString(value, 'parent');
  const base = value['base_activation'];
  const holds = parseHolds(value['holds']);
  if (version === null || parent === undefined) return err('version and parent are required');
  if (base !== null && !isActivation(base)) return err('base_activation: auto, replay, owner or null');
  if (holds === null) return err('holds: malformed rollback entries');
  const verdict = parseVerdict(value['verdict']);
  if (!verdict.ok) return verdict;
  return ok({ version, parent, verdict: verdict.value, base_activation: base, holds });
}

/** A cycle file under `paths.bench`: null when absent; err names the forge-root-relative path. */
function readCycleFile<T>(paths: RoundPaths, name: string, parse: (value: unknown) => Result<T>): Result<T> | null {
  const abs = join(paths.bench, name);
  const rel = abs.startsWith(`${paths.root}/`) ? abs.slice(paths.root.length + 1) : name;
  if (!existsSync(abs)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (e) {
    return err(`${rel}: not valid JSON (${e instanceof Error ? e.message.split(abs).join(rel) : String(e)})`);
  }
  const parsed = parse(value);
  return parsed.ok ? parsed : err(`${rel}: ${parsed.error}`);
}

export function readProposal(paths: RoundPaths): Result<ProposalFile> | null {
  return readCycleFile(paths, PROPOSAL_FILE, parseProposal);
}

export function readValidate(paths: RoundPaths): Result<ValidateFile> | null {
  return readCycleFile(paths, VALIDATE_FILE, parseValidate);
}

/** `outcome.json` = the log line of this cycle as appended (12a fills FinalJson.maintainer from it). */
export function readOutcome(paths: RoundPaths): Result<BenchLogEntry> | null {
  return readCycleFile(paths, OUTCOME_FILE, (value) => {
    const parsed = parseBenchLog([value]);
    const entry = parsed.ok ? parsed.value[0] : undefined;
    return entry === undefined ? err(parsed.ok ? 'empty' : parsed.error) : ok(entry);
  });
}

/* Step bodies (shared by the round / bench-r00 steps and the bench-initial steps). */

function wait(waitingFor: WaitReason, detail: string): StepOutcome {
  return { kind: 'wait', waitingFor, detail, inputs: [], outputs: [] };
}

function must<T>(r: Result<T>): T {
  if (!r.ok) throw new IntegrityError(r.error);
  return r.value;
}

function cyclePath(ctx: StepContext, name: string): string {
  return join(ctx.paths.bench, name);
}

function readLog(ctx: StepContext): BenchLogEntry[] {
  return must(readBenchLog(ctx.root));
}

/** The proposal 11g / i1 wrote (a later step without it is a broken chain). */
function proposalOf(ctx: StepContext): ProposalFile {
  const read = readProposal(ctx.paths);
  if (read === null) throw new IntegrityError(`${ctx.files.rel(cyclePath(ctx, PROPOSAL_FILE))} is missing`);
  const proposal = must(read);
  if (proposal.cycle !== benchCycle(ctx)) throw new IntegrityError(`${ctx.files.rel(cyclePath(ctx, PROPOSAL_FILE))} belongs to cycle ${proposal.cycle}, not ${benchCycle(ctx)}`);
  return proposal;
}

function candidateOf(ctx: StepContext): { value: JsonRecord; text: string } {
  const abs = cyclePath(ctx, CANDIDATE_FILE);
  const rel = ctx.files.rel(abs);
  if (!existsSync(abs)) throw new IntegrityError(`${rel} is missing`);
  const text = readFileSync(abs, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new IntegrityError(`${rel} is not valid JSON`);
  }
  if (!isRecord(value)) throw new IntegrityError(`${rel} is not a JSON object`);
  return { value, text };
}

/** The logged file of an activate / pending_owner version (re-hashed by loadVersion). */
function loggedRef(log: readonly BenchLogEntry[], version: string): VersionRef {
  const e = log.find((x) => x.version === version && (x.outcome === 'activate' || x.outcome === 'pending_owner'));
  if (e === undefined || e.sha256 === null || e.path === null) throw new IntegrityError(`${BENCH_LOG} has no activate or pending_owner line for ${version}`);
  return { version, sha256: e.sha256, path: e.path };
}

/** The proposal's parent version as JSON (null for a root version). */
function parentOf(ctx: StepContext, p: ProposalFile): { ref: VersionRef; value: JsonRecord } | null {
  if (p.parent === null) return null;
  if (p.parent_sha256 === null) throw new IntegrityError(`${ctx.files.rel(cyclePath(ctx, PROPOSAL_FILE))}: parent ${p.parent} has no parent_sha256`);
  const ref = { version: p.parent, sha256: p.parent_sha256, path: `benchmark/${p.parent}.json` };
  return { ref, value: must(loadVersion(ctx.root, ref)) };
}

/** Hash-free append-only logs: a packet that differs from its rebuild only through them was written by an earlier 11f. */
const APPEND_ONLY = new Set([OWNER_LOG, BENCH_LOG]);

function hashedInputs(p: EvidencePacket): string {
  return JSON.stringify(Object.entries(p.inputs).filter(([k]) => !APPEND_ONLY.has(k)).sort(([a], [b]) => byCodeUnit(a, b)));
}

/**
 * The packet already on disk when it differs from the rebuild: kept iff it is a parseable packet in the engine's own
 * serialization for the same round and pin, and every hashed input except the append-only logs is unchanged (the
 * owner or this cycle's 11j appended since, moving the head / RB / PEND items); else err (integrity). A head that
 * moved is caught at 11h / 11j (staleParent), never by rewriting the packet.
 */
function keptPacket(text: string, rebuilt: EvidencePacket): Result<EvidencePacket> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return err('not valid JSON');
  }
  if (text !== `${JSON.stringify(value, null, 2)}\n`) return err('not the engine\'s serialization');
  const parsed = parseEvidencePacket(value);
  if (!parsed.ok) return parsed;
  const p = parsed.value;
  if (p.round !== rebuilt.round || p.benchmark_version !== rebuilt.benchmark_version) return err('round or benchmark_version differs');
  if (hashedInputs(p) !== hashedInputs(rebuilt)) return err('an input other than the append-only logs changed');
  return ok(p);
}

/**
 * 11f: WAIT until the round's audit and decision are readable (never a cycle on partial labels); head =
 * activeBenchmark 'head'; collectEvidence → buildEvidence → benchmark/evidence/RNN.json, written once (existing
 * different bytes → keptPacket, else integrity). Inputs = every file collectEvidence read (unfolded) minus the append-only logs.
 */
async function evidence(ctx: StepContext): Promise<StepOutcome> {
  if (ctx.pipeline === 'round') {
    const reads: Array<{ what: 'audit' | 'decision'; read: OwnerRead<unknown> }> = [
      { what: 'audit', read: ctx.owner.audit(ctx.roundId) },
      { what: 'decision', read: ctx.owner.decision(ctx.roundId) },
    ];
    for (const { what, read } of reads) {
      if (read.state === 'missing' || read.state === 'superseded') return wait(what, `rounds/${ctx.roundId}/${what}: ${read.state}; the benchmark cycle waits for the owner's labels`);
      if (read.state === 'repair') return wait('owner_log_repair', read.detail);
      if (read.state === 'invalid') throw new IntegrityError(read.error);
    }
  }
  const head = activeBenchmark(ctx, 'head');
  if (!head.ok) return head.error.startsWith(OWNER_REPAIR) ? wait('owner_log_repair', head.error) : { kind: 'failed', detail: `no head benchmark: ${head.error}` };
  const collected = collectEvidence(ctx, { version: head.value.version, sha256: head.value.sha256, path: head.value.path });
  if (!collected.ok) throw new IntegrityError(`evidence: ${collected.error}`);
  const rebuilt = buildEvidence(collected.value);
  const text = `${JSON.stringify(rebuilt, null, 2)}\n`;
  const rel = evidencePath(ctx.roundId);
  const abs = join(ctx.root, rel);
  let packet = rebuilt;
  if (!existsSync(abs)) ctx.files.writeText(abs, text);
  else {
    const existing = readFileSync(abs, 'utf8');
    const kept = existing === text ? ok(rebuilt) : keptPacket(existing, rebuilt);
    if (!kept.ok) throw new IntegrityError(`${rel} already exists with different bytes (${kept.error}; an evidence packet is never rewritten)`);
    packet = kept.value;
  }
  const logs = new Set([OWNER_LOG, BENCH_LOG, ctx.files.rel(ctx.paths.status), ...engineJsonlLogs(ctx).map((p) => ctx.files.rel(p))]);
  const inputs = Object.keys(collected.value.files).filter((p) => !logs.has(p) && p !== rel && existsSync(join(ctx.root, p))).sort(byCodeUnit);
  ctx.progress('11f-bench-evidence', 'info', `${packet.items.length} evidence items, head ${packet.head_version}`);
  return { kind: 'done', inputs, outputs: [rel], external: [] };
}

interface ProposalSource {
  spec: TaskSpec<MaintainerOutput>;
  parent: VersionRef | null;
  /** The parent version's JSON (dropCanonCliches keeps what it inherits). */
  head: JsonRecord | null;
  packet: { path: string; sha256: string } | null;
}

function protocolText(ctx: StepContext): string {
  return readFileSync(join(ctx.root, 'PROTOCOL.md'), 'utf8');
}

/** 11g: the packet 11f wrote, its head version (by the logged sha) and the maintainer task (seed = packet sha). */
function cycleSource(ctx: StepContext, log: readonly BenchLogEntry[]): ProposalSource {
  const read = readEvidencePacket(ctx.root, ctx.roundId);
  if (read === null) throw new IntegrityError(`${evidencePath(ctx.roundId)} is missing (11f-bench-evidence writes it)`);
  const { packet, sha256: packetSha } = must(read);
  const parent = loggedRef(log, packet.head_version);
  const head = must(loadVersion(ctx.root, parent));
  const spec = maintainerTask({ packet, head, authority: authorityTable(ctx.protocol), protocolMd: protocolText(ctx), round: ctx.roundId, seed: packetSha });
  return { spec, parent, head, packet: { path: evidencePath(ctx.roundId), sha256: packetSha } };
}

/** i1: no packet, no parent; the optional owner input file; seed = the protocol bundle hash. */
function initialSource(ctx: StepContext): ProposalSource {
  const inputs = join(ctx.root, V1_INPUTS);
  const inputsMd = existsSync(inputs) ? readFileSync(inputs, 'utf8') : null;
  return { spec: initialTask({ protocolMd: protocolText(ctx), inputsMd, authority: authorityTable(ctx.protocol), seed: ctx.bundleSha256 }), parent: null, head: null, packet: null };
}

/** BOOK.md and REFERENCE.md of the working canon (the cliché filter drops entries that occur in canon). */
function canonTexts(ctx: StepContext): { book: string; reference: string } {
  const read = (rel: string): string => {
    const abs = join(ctx.repo, rel);
    if (!existsSync(abs)) throw new IntegrityError(`${rel} is missing (the cliché filter reads canon)`);
    return readFileSync(abs, 'utf8');
  };
  return { book: read('world/current/BOOK.md'), reference: read('world/current/reference/REFERENCE.md') };
}

function proposalInputs(ctx: StepContext, p: ProposalFile): string[] {
  const out: string[] = [];
  if (p.evidence_packet !== null) out.push(p.evidence_packet);
  if (p.parent !== null) out.push(`benchmark/${p.parent}.json`);
  if (ctx.pipeline === 'bench-initial' && existsSync(join(ctx.root, V1_INPUTS))) out.push(V1_INPUTS);
  return out;
}

function proposalDone(ctx: StepContext, p: ProposalFile): StepOutcome {
  const outputs = [ctx.files.rel(cyclePath(ctx, PROPOSAL_FILE))];
  if (p.output !== null && p.output.kind === 'change') {
    if (!existsSync(cyclePath(ctx, CANDIDATE_FILE))) throw new IntegrityError(`${ctx.files.rel(cyclePath(ctx, CANDIDATE_FILE))} is missing for a change proposal`);
    outputs.push(ctx.files.rel(cyclePath(ctx, CANDIDATE_FILE)));
  }
  return { kind: 'done', inputs: proposalInputs(ctx, p), outputs, external: [] };
}

/**
 * 11g / i1. The version is nextVersion at the first attempt; candidate.json is written before proposal.json, so a
 * kill before proposal.json reruns with the same id (nothing burned it) and the reused task record, and an existing
 * proposal.json is final. A void maintainer output is a result (output null → no_change_invalid).
 */
async function propose(ctx: StepContext, initial: boolean): Promise<StepOutcome> {
  if (initial) {
    const refusal = initialRefusal(ctx.root, ctx.owner);
    if (refusal !== null) return { kind: 'failed', detail: refusal };
    const gate = protocolGate(ctx);
    if (gate !== null) return gate;
  }
  const existing = readProposal(ctx.paths);
  if (existing !== null) return proposalDone(ctx, proposalOf(ctx));
  const log = readLog(ctx);
  const version = nextVersion(ctx.root, log);
  const source = initial ? initialSource(ctx) : cycleSource(ctx, log);
  const r = await runTask(ctx, ctx.backends.maintainer, source.spec);
  const recordPath = join(ctx.paths.tasks, `${source.spec.id}.json`);
  const record = readTaskRecord(recordPath);
  if (record === null || !record.ok) throw new IntegrityError(`${ctx.files.rel(recordPath)}: the maintainer task record is unreadable`);
  const model = record.value.served_model ?? ctx.backends.maintainer.model;
  const output = r.value;
  let dropped: string[] = [];
  if (output !== null && output.kind === 'change') {
    const assembled = assembleCandidate(output, { version, parent: source.parent?.version ?? null, createdAt: ctx.ports.clock.now(), model });
    const filtered = dropCanonCliches(assembled, canonTexts(ctx), source.head);
    dropped = filtered.dropped;
    ctx.files.writeJson(cyclePath(ctx, CANDIDATE_FILE), filtered.candidate);
  }
  const proposal: ProposalFile = {
    cycle: benchCycle(ctx), version, parent: source.parent?.version ?? null, parent_sha256: source.parent?.sha256 ?? null,
    evidence_packet: source.packet?.path ?? null, evidence_packet_sha256: source.packet?.sha256 ?? null,
    output, errors: output === null ? [ctx.redact(r.error ?? 'void maintainer output')] : [], task: source.spec.id,
    calls: record.value.calls.map((label) => ctx.files.rel(callRecordPath(ctx.paths, label))), model, dropped_cliches: dropped,
  };
  ctx.files.writeJson(cyclePath(ctx, PROPOSAL_FILE), proposal);
  ctx.progress(initial ? 'i1-propose' : '11g-bench-propose', 'info', `${version}: ${output === null ? 'void' : output.kind}`);
  return proposalDone(ctx, proposal);
}

function hasCandidate(p: ProposalFile): boolean {
  return p.output !== null && p.output.kind === 'change';
}

function cycleLogged(ctx: StepContext): boolean {
  return readLog(ctx).some((e) => e.cycle === benchCycle(ctx));
}

/**
 * Why the proposal's parent (the packet's head at 11f) is no longer activeBenchmark 'head', else null: an owner
 * rollback or approval since 11f. A child of it would silently undo that click, so 11h / 11j reject it. err = the
 * owner log needs repair (WAIT). Callers skip a cycle already logged (its own line moved the head).
 */
function staleParent(ctx: StepContext, proposal: ProposalFile): Result<string | null> {
  if (proposal.parent === null) return ok(null);
  const head = activeBenchmark(ctx, 'head');
  if (!head.ok && head.error.startsWith(OWNER_REPAIR)) return head;
  const now = head.ok ? head.value.version : 'none';
  return ok(now === proposal.parent ? null : `parent ${proposal.parent} is no longer head (${now})`);
}

/** The verdict of a candidate built on a stale parent (logged rejected_validate; no replay). */
function staleVerdict(reason: string): CandidateVerdict {
  return { ok: false, errors: [reason], changedKeys: [], activation: null, noChange: false, slotErrors: [], versionErrors: [] };
}

/** An owner-log read failure → WAIT owner_log_repair; any other error is an integrity error. */
function repairOrThrow(error: string, what: string): StepOutcome {
  if (error.startsWith(OWNER_REPAIR)) return wait('owner_log_repair', error);
  throw new IntegrityError(`${what}: ${error}`);
}

/** 11h / i2: validateCandidate against the proposal's parent (bench-initial: null head, no holds); a stale parent is not validated. */
async function validate(ctx: StepContext, initial: boolean): Promise<StepOutcome> {
  const proposal = proposalOf(ctx);
  if (!hasCandidate(proposal)) return { kind: 'skip', reason: 'no candidate' };
  const candidate = candidateOf(ctx);
  const parent = parentOf(ctx, proposal);
  let holds: RollbackEntry[] = [];
  if (!initial) {
    const read = rollbackHolds(ctx.root, ctx.owner, readLog(ctx), ctx.protocol.activation);
    if (!read.ok) return repairOrThrow(read.error, 'rollback holds');
    holds = read.value;
  }
  const stale = cycleLogged(ctx) ? ok(null) : staleParent(ctx, proposal);
  if (!stale.ok) return repairOrThrow(stale.error, 'head');
  const verdict = stale.value !== null ? staleVerdict(stale.value) : validateCandidate(ctx, candidate.value, parent === null ? null : parent.value, holds, proposal.version);
  const file: ValidateFile = { version: proposal.version, parent: proposal.parent, verdict, base_activation: baseActivation(verdict.changedKeys, ctx.protocol.activation), holds };
  const out = ctx.files.writeJson(cyclePath(ctx, VALIDATE_FILE), file);
  ctx.progress(initial ? 'i2-validate' : '11h-bench-validate', 'info', `${proposal.version}: ${verdict.ok ? `ok (${verdict.activation ?? 'none'})` : verdict.noChange ? 'no change' : 'rejected'}`);
  const inputs = [ctx.files.rel(cyclePath(ctx, PROPOSAL_FILE)), ctx.files.rel(cyclePath(ctx, CANDIDATE_FILE)), ...(parent === null ? [] : [parent.ref.path])];
  return { kind: 'done', inputs, outputs: [out], external: [] };
}

function validated(ctx: StepContext): ValidateFile {
  const read = readValidate(ctx.paths);
  if (read === null) throw new IntegrityError(`${ctx.files.rel(cyclePath(ctx, VALIDATE_FILE))} is missing for a change proposal`);
  return must(read);
}

/** The step's own reason not to replay, else null. */
function replaySkip(ctx: StepContext, proposal: ProposalFile, v: CandidateVerdict | null): string | null {
  if (!hasCandidate(proposal) || v === null) return 'no candidate';
  if (v.noChange) return 'no change';
  if (!v.ok) return 'verdict not ok';
  if (proposal.parent === null) return 'root version';
  return needsReplay(v.changedKeys, ctx.protocol.activation) ? null : 'no replay-class key';
}

/** 11i: runReplay(head, candidate) over replayFamilies → replay.json; runs before the hold upgrade decides the class. */
async function replay(ctx: StepContext): Promise<StepOutcome> {
  const proposal = proposalOf(ctx);
  const verdict = hasCandidate(proposal) ? validated(ctx).verdict : null;
  const skip = replaySkip(ctx, proposal, verdict);
  if (skip !== null) return { kind: 'skip', reason: skip };
  const parent = parentOf(ctx, proposal);
  if (parent === null) return { kind: 'skip', reason: 'root version' };
  const families = replayFamilies(ctx);
  if (!families.ok) return { kind: 'blocked', detail: `replay families: ${families.error}` };
  const result = await runReplay(ctx, parent.value, candidateOf(ctx).value, families.value);
  const out = ctx.files.writeJson(cyclePath(ctx, REPLAY_FILE), result);
  ctx.progress('11i-bench-replay', 'info', `${result.summary.reason}: pooled ${result.summary.pooled.old} → ${result.summary.pooled.new} of ${result.summary.pooled.n}`);
  const inputs = [PROPOSAL_FILE, VALIDATE_FILE, CANDIDATE_FILE].map((f) => ctx.files.rel(cyclePath(ctx, f)));
  return { kind: 'done', inputs: [...inputs, parent.ref.path], outputs: [out], external: [] };
}

function replaySummary(ctx: StepContext): ReplaySummary | null {
  const abs = cyclePath(ctx, REPLAY_FILE);
  if (!existsSync(abs)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(abs, 'utf8'));
  } catch {
    throw new IntegrityError(`${ctx.files.rel(abs)} is not valid JSON`);
  }
  const parsed = parseReplayResult(value, ctx.protocol.calibration.replayMinPairs);
  if (!parsed.ok) throw new IntegrityError(`${ctx.files.rel(abs)}: ${parsed.error}`);
  return parsed.value.summary;
}

/**
 * 11j's re-check of an ok verdict before the cycle is logged: the parent must still be the head (staleParent), and the
 * rollback holds are re-read; when they differ from validate.json's, the candidate is validated again with them (a
 * rollback after 11h upgrades the class). err = owner log needs repair / unreadable holds.
 */
function recheck(ctx: StepContext, proposal: ProposalFile, file: ValidateFile, candidate: JsonRecord): Result<CandidateVerdict> {
  const stale = staleParent(ctx, proposal);
  if (!stale.ok) return stale;
  if (stale.value !== null) return ok(staleVerdict(stale.value));
  const holds = rollbackHolds(ctx.root, ctx.owner, readLog(ctx), ctx.protocol.activation);
  if (!holds.ok) return holds;
  if (JSON.stringify(holds.value) === JSON.stringify(file.holds)) return ok(file.verdict);
  const parent = parentOf(ctx, proposal);
  return ok(validateCandidate(ctx, candidate, parent === null ? null : parent.value, holds.value, proposal.version));
}

/**
 * 11j / i3: decideOutcome (11j: on recheck's verdict), then in order, each idempotent: protocolGate (activate /
 * pending_owner only; WAIT) → writeVersion (same two; refuses different bytes) → appendBenchLogOnce (a line of this
 * cycle already present is kept) → outcome.json = the cycle's logged line. benchmark/log.jsonl is an engine log and
 * never listed.
 */
async function outcome(ctx: StepContext): Promise<StepOutcome> {
  const proposal = proposalOf(ctx);
  const cycle = benchCycle(ctx);
  const inputs = [ctx.files.rel(cyclePath(ctx, PROPOSAL_FILE))];
  let verdict: CandidateVerdict | null = null;
  let summary: ReplaySummary | null = null;
  let candidate: { value: JsonRecord; text: string } | null = null;
  if (hasCandidate(proposal)) {
    const file = validated(ctx);
    verdict = file.verdict;
    candidate = candidateOf(ctx);
    summary = replaySummary(ctx);
    inputs.push(...[VALIDATE_FILE, CANDIDATE_FILE, ...(summary === null ? [] : [REPLAY_FILE])].map((f) => ctx.files.rel(cyclePath(ctx, f))));
    if (summary === null && replaySkip(ctx, proposal, verdict) === null) throw new IntegrityError(`${ctx.files.rel(cyclePath(ctx, REPLAY_FILE))} is missing for a replay-class change`);
    if (verdict.ok && ctx.pipeline !== 'bench-initial' && !cycleLogged(ctx)) {
      const current = recheck(ctx, proposal, file, candidate.value);
      if (!current.ok) return repairOrThrow(current.error, 'outcome re-check');
      verdict = current.value;
    }
  }
  const decided = decideOutcome({ output: proposal.output, verdict, replay: summary });
  let written: VersionRef | null = null;
  if (decided === 'activate' || decided === 'pending_owner') {
    const gate = protocolGate(ctx);
    if (gate !== null) return gate;
    if (candidate === null) throw new IntegrityError(`${cycle}: ${decided} without a candidate`);
    written = must(writeVersion(ctx.files, ctx.root, candidate.value));
  }
  const named = candidate !== null && written === null;
  const entry = buildLogEntry({
    at: ctx.ports.clock.now(), cycle, outcome: decided, proposal, verdict, replay: summary, written,
    candidatePath: named ? ctx.files.rel(cyclePath(ctx, CANDIDATE_FILE)) : null, candidateSha256: named && candidate !== null ? sha256(candidate.text) : null,
    bundleSha256: ctx.bundleSha256,
  });
  let appended: 'appended' | 'present';
  try {
    appended = appendBenchLogOnce(ctx.files, ctx.root, entry);
  } catch (e) {
    throw new IntegrityError(e instanceof Error ? e.message : String(e));
  }
  const line = readLog(ctx).find((e) => e.cycle === cycle);
  if (line === undefined) throw new IntegrityError(`${BENCH_LOG} has no line for cycle ${cycle}`);
  const out = ctx.files.writeJson(cyclePath(ctx, OUTCOME_FILE), line);
  ctx.progress(ctx.pipeline === 'bench-initial' ? 'i3-outcome' : '11j-bench-outcome', 'info', `${cycle}: ${line.outcome}${line.version === null ? '' : ` ${line.version}`}${appended === 'present' ? ' (already logged)' : ''}`);
  return { kind: 'done', inputs, outputs: [out], external: written === null ? [] : [written.path] };
}

/** 11f: head = activeBenchmark 'head'; collectEvidence → buildEvidence → benchmark/evidence/RNN.json (existing different bytes → integrity). */
export const evidenceStep: StepDef = {
  id: '11f-bench-evidence',
  run: async (ctx) => evidence(ctx),
};

/** 11g: maintainerTask on ctx.backends.maintainer → proposal.json (+ candidate.json for change); void is a result. */
export const proposeStep: StepDef = {
  id: '11g-bench-propose',
  run: async (ctx) => propose(ctx, false),
};

/** 11h: skip (no candidate); else validateCandidate against the proposal's parent with rollbackHolds → validate.json. */
export const validateStep: StepDef = {
  id: '11h-bench-validate',
  run: async (ctx) => validate(ctx, false),
};

/** 11i: skip (no replay-class key, or verdict not ok / no change); else runReplay over replayFamilies → replay.json. */
export const replayStep: StepDef = {
  id: '11i-bench-replay',
  run: async (ctx) => replay(ctx),
};

/** 11j: decideOutcome; activate / pending_owner: protocolGate (WAIT protocol_approval) → writeVersion; appendBenchLogOnce → outcome.json. */
export const outcomeStep: StepDef = {
  id: '11j-bench-outcome',
  run: async (ctx) => outcome(ctx),
};

/** i1: initialRefusal (failed) → protocolGate (WAIT, before any call) → initialTask → proposal.json + candidate.json. */
export const initialProposeStep: StepDef = {
  id: 'i1-propose',
  run: async (ctx) => propose(ctx, true),
};

/** i2: validateCandidate(candidate, null head, no holds) → validate.json (a root version is owner class). */
export const initialValidateStep: StepDef = {
  id: 'i2-validate',
  run: async (ctx) => validate(ctx, true),
};

/** i3: as 11j with cycle R00-init (a valid v1 is always pending_owner). */
export const initialOutcomeStep: StepDef = {
  id: 'i3-outcome',
  run: async (ctx) => outcome(ctx),
};

/** The five cycle steps, appended to ROUND_STEPS after 11e and run alone by the bench-r00 pipeline. */
export const BENCH_CYCLE_STEPS: readonly StepDef[] = [evidenceStep, proposeStep, validateStep, replayStep, outcomeStep];
/** The bench-r00 pipeline (ids = runner BENCH_R00_STEP_IDS). */
export const BENCH_R00_STEPS: readonly StepDef[] = BENCH_CYCLE_STEPS;
/** The bench-initial pipeline (ids = runner INITIAL_STEP_IDS). */
export const INITIAL_STEPS: readonly StepDef[] = [initialProposeStep, initialValidateStep, initialOutcomeStep];
