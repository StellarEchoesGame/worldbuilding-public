import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Family } from './config.ts';
import type { StepContext } from './context.ts';
import { mechanicalGate } from './gate.ts';
import { canonFiles, sourcesFromRound } from './inputs.ts';
import { isRecord, readString, stringArray, type JsonRecord } from './json.ts';
import { sha256Bytes } from './marker.ts';
import { mergecheck, sentencesCarrying, type MergeCheckResult, type MergeConstants, type MergeDecision, type MergeSource } from './mergecheck.ts';
import { decisionDirName, type Decision } from './owner-inputs.ts';
import type { GitPort } from './ports.ts';
import type { Protocol, ProtocolMerge } from './protocol.ts';
import { err, ok, type Result } from './result.ts';
import { runAll } from './runner.ts';
import { forbiddenRows, loadAliasFile, loadRows, readBriefJson, type BriefJson } from './steps/brief.ts';
import { judgeBackend } from './steps/gate-llm.ts';
import { seededShuffle, sha256, type RoundPaths } from './store.ts';
import type { RoundTally } from './tally.ts';
import { runTask } from './task.ts';
import { eligibleFamilies, type FamilyState } from './tasks/assign.ts';
import { gateJudgeTask, gateOutcome, type GateOutcome, type GatePack, type GateVerdict } from './tasks/gate-judge.ts';
import { taskId } from './tasks/ids.ts';
import { REGISTER_PATH, SCENES_PATH, type CanonEdit, type MergeSources } from './tasks/merge-editor.ts';
import { normalizeForQuote, stripMarkdown } from './text.ts';


/**
 * Merge preparation (plan §8 steps 10a–10f, s5 §4; PR-D group D1): decision → MergeDecision, the trial-pair
 * precondition, fact-set and post-merge gate packs and pools, restore-from-base_sha, apply + assembler + BOOK checks,
 * and runMergecheck (the body `forge mergecheck` used to carry in cli.ts). Every 10a–10f output lives in
 * `rounds/RNN/merge/<d8>/` (owner-inputs.ts decisionDirName); world/current/** is written through ctx.files and never
 * listed in a marker.
 */

/** `rounds/RNN/merge.json` (10f): the pointer to the committed attempt. */
export const MERGE_POINTER_FILE = 'merge.json';
export const REGATE_FILE = 'regate.json';
export const PLAN_FILE = 'plan.json';
export const EDIT_FILE = 'edit.json';
export const APPLY_FILE = 'apply.json';
export const MERGECHECK_FILE = 'mergecheck.json';
export const POSTMERGE_GATE_FILE = 'postmerge-gate.json';
/** Repository-relative canon root. */
export const CANON_DIR = 'world/current';
/** world/current-relative files the assembler writes (PROTOCOL §7.7); 10c confirms it touched nothing else. */
export const ASSEMBLER_WRITES: readonly string[] = ['reference/REFERENCE.md', 'reference/hashes.json'];
/** Engine-edited by 10c (revision, header, 09 appended on the first merge). */
export const MANIFEST_PATH = 'reference/manifest.json';
/** notesPaths that 10c templates (`## <rev> 样本现场 RNN` + Rxx line); the other notesPaths are F1-07's. */
export const TEMPLATED_NOTES: readonly string[] = ['reference/CHANGES.md', 'REVISION.md'];
/** Paths mergecheck does not see that a merge may still change (checked by reproducing them). */
export const OUTSIDE_MERGECHECK: readonly string[] = ['reference/REFERENCE.md', 'reference/hashes.json', 'reference/manifest.json'];

/** The attempt of the decision the 09b marker pins. */
export interface MergeAttempt {
  round: string;
  decision: Decision;
  decisionSha256: string;
  /** decisionDirName(decisionSha256). */
  d8: string;
  /** Absolute `rounds/RNN/merge/<d8>`. */
  dir: string;
  /** start.json base_sha. */
  baseSha: string;
}

/** One registered fact of a re-gated set (regate.json `facts`). */
export interface RegateFact {
  rxx: string;
  label: string;
  fact_id: string;
  claim: string;
  status: string;
  row_id: string;
  extends: string;
  source_sentences: string[];
}

/** Inputs of the mechanical fact-set checks. */
export interface RegateLimits {
  rowIds: readonly string[];
  /** The four 07 §1 statuses (brief.ts FACT_STATUSES). */
  statuses: readonly string[];
  /** Distinct new proper nouns of the involved submissions occurring in the base text or a donor source sentence. */
  properNouns: readonly string[];
  /** protocol.fixtureRxx.claim (must never appear). */
  fixtureClaim: string;
}

/** One gate judge of 10a / 10e (`n` as gateTaskId: 1, 2 seeded; 3… reserves in pool order). */
export interface MergeJudge {
  family: Family;
  n: number;
  task: string;
  status: 'ok' | 'void';
  yes: boolean | null;
  verdict: GateVerdict | null;
  error: string | null;
}

/** GateRecordStatus as owner-inputs.ts gateRejection reads it. */
export type RegateStatus = 'pass' | 'fail' | 'split' | 'unverified' | 'trial';

/** `merge/<d8>/regate.json`. */
export interface RegateRecord {
  round: string;
  decision_sha256: string;
  d8: string;
  status: RegateStatus;
  /** Base / donor labels whose champion pair was trial (status trial, no calls). */
  trial_labels: string[];
  facts: RegateFact[];
  mechanical: { ok: boolean; violations: string[] };
  judges: MergeJudge[];
}

/** `merge/<d8>/postmerge-gate.json` (a split continues; fail → restore + rewind; unverified → failed). */
export interface PostMergeGateRecord {
  round: string;
  decision_sha256: string;
  d8: string;
  status: 'pass' | 'fail' | 'split' | 'unverified';
  scene_sha256: string;
  mechanical: { ok: boolean; violations: string[] };
  judges: MergeJudge[];
}

/** `merge/<d8>/apply.json` (10c; written on success and on a failed check, after the restore). */
export interface ApplyRecord {
  round: string;
  d8: string;
  decision_sha256: string;
  base_sha: string;
  revision: string;
  status: 'applied' | 'failed';
  reasons: string[];
  /** world/current-relative paths restored from base_sha before this attempt. */
  restored: string[];
  /**
   * world/current-relative path → SHA-256 of the bytes 10c leaves for 10d: what it wrote (edit files, manifest,
   * templated notes) and, once every check passed, the ASSEMBLER_WRITES outputs. 10d fails on any mismatch and on any
   * changed canon path not listed here, so post-merge.json never pins a hand edit made after 10c.
   */
  written: Record<string, string>;
  assembler: { reference_book_sha256: string; characters: number } | null;
  /** SHA-256 of BOOK.md after the assembler (must equal base). */
  book_sha256: string;
  /** Every changed world/current path vs base_sha after the attempt (git.changedPaths). */
  changed: string[];
}

/** `rounds/RNN/merge.json` (10f; written before the commit that carries it, so it holds no commit sha). */
export interface MergePointer {
  round: string;
  /** d8 of the committed attempt. */
  current: string;
  decision_sha256: string;
  status: 'merged_on_branch';
  revision: string;
  /** Mergecheck / post-merge notes carried to final.json (e.g. `postmerge_split`); [] when clean. */
  reasons: string[];
}

/** mergecheck over the working tree vs a git ref, without a StepContext (the `forge mergecheck` CLI). */
export interface MergecheckEnv {
  root: string;
  repo: string;
  git: GitPort;
  constants: MergeConstants;
  rowIds: readonly string[];
}


/** 01–06 reference files: the only index-line targets (mergecheck INDEXED_PATH). */
const INDEXED_PATH = /^reference\/0[1-6]-[^/]+\.md$/u;
const BOOK_PATH = 'BOOK.md';
const HASHES_PATH = 'reference/hashes.json';
/** Mechanical fact-set limits (PROTOCOL §2 / §7, s5 §4.1). */
const MAX_FACTS = 6;
const MAX_WITHOUT_EXTENDS = 3;
const MAX_PROPER_NOUNS = 3;
const MANIFEST_TITLE = '# 群星回响 · 世界设定参考集';

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Repository-relative `world/current/<rel>`. */
function canonRepoPath(rel: string): string {
  return `${CANON_DIR}/${rel}`;
}

/** world/current-relative form of a repository-relative path, or null outside the canon. */
function canonRel(repoPath: string): string | null {
  const prefix = `${CANON_DIR}/`;
  return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : null;
}

/** The attempt of the decision the 09b marker pins. */
export function mergeAttempt(ctx: StepContext): MergeAttempt {
  const decision = ctx.decision();
  // ctx.decision() has just checked these bytes against the 09b pin.
  const decisionSha256 = sha256Bytes(readFileSync(join(ctx.root, decision.file)));
  const d8 = decisionDirName(decisionSha256);
  return { round: ctx.roundId, decision, decisionSha256, d8, dir: join(ctx.paths.merge, d8), baseSha: ctx.start().base_sha };
}

/** protocol.merge + protocol.connectives. */
export function mergeConstants(protocol: Protocol): MergeConstants {
  const m = protocol.merge;
  return {
    preamble09: m.preamble09,
    pointer07: m.pointer07,
    heading8: m.heading8,
    tableHeader8: m.tableHeader8,
    connectives: [...protocol.connectives],
    maxJointsPer500: m.maxJointsPer500,
    notesPaths: [...m.notesPaths],
  };
}

/** map/rows.json ids + character alias rows (as `forge thinmap` / the old cli mergeCheck). */
export function mergeRowIds(root: string): Result<string[]> {
  const rows = loadRows(root);
  if (!rows.ok) return err(rows.error);
  const aliases = loadAliasFile(root);
  if (!aliases.ok) return err(aliases.error);
  const characters = aliases.value.filter((a) => a.kind === 'character').map((a) => a.row_id);
  return ok([...rows.value.map((r) => r.row_id), ...characters]);
}

/** "8.1" → "8.2", "8.9" → "8.10"; anything but <int>.<int> → err. */
export function nextRevision(revision: string): Result<string> {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(revision);
  if (m === null) return err(`revision ${JSON.stringify(revision)} is not <major>.<minor>`);
  return ok(`${m[1] ?? ''}.${Number(m[2]) + 1}`);
}

/** What mergeDecisionFrom reads of a candidate: its label and its delta fact ids in delta order. */
export interface NumberingSource {
  label: string;
  facts: ReadonlyArray<{ id: string }>;
}

/**
 * base = decision.base ?? decision.pick; rows = [rowId]; registered = decision facts in card order (label A, B, C;
 * within a label the delta order of `sources`) numbered `RNN-01…`; title ''. pick = none → err. The one Rxx rule: the
 * merge feeds sourcesFromRound, the decision mirror (mirror.ts) card.json's entries, which list the same candidates
 * with the same delta facts in the same order.
 */
export function mergeDecisionFrom(decision: Decision, sources: readonly NumberingSource[], rowId: string): Result<MergeDecision> {
  if (decision.pick === 'none') return err('decision: pick is none, nothing to merge');
  const baseLabel = decision.base ?? decision.pick;
  if (!sources.some((s) => s.label === baseLabel)) return err(`decision: base ${baseLabel} is not a candidate of ${decision.round}`);
  const placed: Array<{ label: string; factId: string; index: number }> = [];
  const seen = new Set<string>();
  for (const f of decision.facts) {
    const index = sources.find((s) => s.label === f.label)?.facts.findIndex((x) => x.id === f.id) ?? -1;
    if (index < 0) return err(`decision: fact ${f.label}/${f.id} is not in that candidate's delta`);
    const key = JSON.stringify([f.label, f.id]);
    if (seen.has(key)) return err(`decision: fact ${f.label}/${f.id} is listed twice`);
    seen.add(key);
    placed.push({ label: f.label, factId: f.id, index });
  }
  placed.sort((a, b) => byCodeUnit(a.label, b.label) || a.index - b.index);
  const registered = placed.map((p, i) => ({ rxx: `${decision.round}-${pad2(i + 1)}`, label: p.label, factId: p.factId }));
  return ok({ round: decision.round, baseLabel, title: '', rows: [rowId], registered });
}

/** Some registered fact's label ≠ the base label. */
export function needsRegate(decision: MergeDecision): boolean {
  return decision.registered.some((r) => r.label !== decision.baseLabel);
}

/** Labels among base ∪ fact donors whose tally champion pair is `trial` (|E| ≤ 2), code-unit sorted. */
export function trialDonors(tally: { champion_pairs: ReadonlyArray<Pick<RoundTally['champion_pairs'][number], 'label' | 'trial'>> }, decision: MergeDecision): string[] {
  const labels = new Set([decision.baseLabel, ...decision.registered.map((r) => r.label)]);
  return [...labels].filter((l) => tally.champion_pairs.some((p) => p.label === l && p.trial)).sort(byCodeUnit);
}

/**
 * The registered facts with their delta fields and source sentences: mergecheck sentencesCarrying, the donor rule
 * 10b and mergeability use, so a donor fact lists exactly the sentences the merge inserts. [] for a donor fact only in
 * a trial / unmergeable regate.json (written before mergeability rewinds it); once mergeability passed it is never
 * empty. A base fact may carry its quote across sentences (mergecheck checks base quotes in the scene, folded), so a
 * base fact no single sentence carries lists its quote instead, which the step-5 gate matched in that text.
 */
export function regateFacts(decision: MergeDecision, sources: readonly MergeSource[]): Result<RegateFact[]> {
  const out: RegateFact[] = [];
  for (const r of decision.registered) {
    const source = sources.find((s) => s.label === r.label);
    const fact = source?.facts.find((f) => f.id === r.factId);
    if (source === undefined || fact === undefined) return err(`regate: ${r.rxx} refers to unknown fact ${r.label}/${r.factId}`);
    const carried = sentencesCarrying(source.submission, fact.sourceQuote);
    out.push({
      rxx: r.rxx, label: r.label, fact_id: fact.id, claim: fact.claim, status: fact.status, row_id: fact.rowId, extends: fact.extends,
      source_sentences: carried.length === 0 && r.label === decision.baseLabel ? [fact.sourceQuote] : carried,
    });
  }
  return ok(out);
}

/** ≤ 6 facts, ≤ 3 without extends, unique claims, valid row / status, no `|` / newline, ≤ 3 proper nouns, no fixture claim. */
export function regateMechanical(facts: readonly RegateFact[], limits: RegateLimits): string[] {
  const out: string[] = [];
  if (facts.length > MAX_FACTS) out.push(`too many facts: ${facts.length} > ${MAX_FACTS}`);
  const bare = facts.filter((f) => f.extends.trim() === '').length;
  if (bare > MAX_WITHOUT_EXTENDS) out.push(`too many facts without extends: ${bare} > ${MAX_WITHOUT_EXTENDS}`);
  const claims = new Map<string, string>();
  const fixture = normalizeForQuote(limits.fixtureClaim);
  for (const f of facts) {
    const key = normalizeForQuote(f.claim);
    const first = claims.get(key);
    if (first !== undefined) out.push(`${f.rxx}: claim repeats ${first}`);
    else claims.set(key, f.rxx);
    if (!limits.rowIds.includes(f.row_id)) out.push(`${f.rxx}: unknown row_id`);
    if (!limits.statuses.includes(f.status)) out.push(`${f.rxx}: status is not one of the 07 §1 statuses`);
    const cells: Array<[string, string]> = [['claim', f.claim], ['status', f.status], ['row_id', f.row_id], ['extends', f.extends]];
    for (const [name, value] of cells) if (/[|\r\n]/u.test(value)) out.push(`${f.rxx}: ${name} contains | or a line break`);
    if (fixture !== '' && (key.includes(fixture) || f.source_sentences.some((s) => normalizeForQuote(s).includes(fixture)))) out.push(`${f.rxx}: repeats the fixture fact`);
  }
  if (limits.properNouns.length > MAX_PROPER_NOUNS) out.push(`too many new proper nouns: ${limits.properNouns.length} > ${MAX_PROPER_NOUNS}`);
  return out;
}

function factSetText(facts: readonly RegateFact[]): string {
  return facts.map((f) => `${f.rxx}｜${f.status}｜${f.row_id}｜${f.claim}\n出处：${f.source_sentences.join('')}`).join('\n');
}

/** 10a pack: subjectKind `fact_set` (rendered claims + source sentences) against the brief's frozen facts / regression / forbidden. */
export function regatePack(facts: readonly RegateFact[], brief: BriefJson): GatePack {
  return { subjectKind: 'fact_set', subject: factSetText(facts), facts: [...brief.facts], regression: [...brief.regression], forbidden: forbiddenRows(brief), negatedFlags: [] };
}

/** 10e pack: subjectKind `text` = the rendered scene; brief facts minus this round's `rxx` (the frozen table, s5 D9). */
export function postMergePack(scene: string, brief: BriefJson, rxx: readonly string[]): GatePack {
  return { subjectKind: 'text', subject: scene, facts: brief.facts.filter((f) => !rxx.includes(f.id)), regression: [...brief.regression], forbidden: forbiddenRows(brief), negatedFlags: [] };
}

/** The scene body without its two header lines (the header is engine-rendered metadata). */
function sceneBody(scene: string): string {
  return scene.replace(/^## [^\n]*\n\n[^\n]*\n\n/u, '');
}

/** 10e text checks: forbidden words, rule-sentence ratio ≤ 15 %, every registered source quote present in the scene. */
export function postMergeMechanical(scene: string, protocol: Protocol, quotes: readonly string[]): string[] {
  const body = sceneBody(scene);
  const gate = mechanicalGate(
    { submission: body, delta: { newProperNouns: [], claims: [] }, iface: { shots: [], object: null, hook: null, raw: {} }, seeds: [] },
    { baseline: false, limits: protocol.limits, forbidden: protocol.forbidden, negations: protocol.negations, negationExceptions: protocol.negationExceptions },
  );
  const out = gate.checks.filter((c) => (c.name === 'forbidden_words' || c.name === 'rule_sentences') && !c.ok).map((c) => `${c.name}: ${c.detail}`);
  const folded = normalizeForQuote(stripMarkdown(body));
  for (const q of quotes) {
    const keys = [q, stripMarkdown(q)].map(normalizeForQuote).filter((k) => k !== '');
    if (!keys.some((k) => folded.includes(k))) out.push(`source quote not in scene: ${q}`);
  }
  return out;
}

/**
 * Seeded judge order: gate-eligible states (`familyStates(freeze, judge families)`, use `gate`) minus `voided`
 * (resubmit.json voided_families) minus `authors` (base + donors), then seededShuffle(seed, key); key
 * `regate:<d8>` / `postmerge:<d8>`. The first two judge, the rest replace void calls in order.
 */
export function gatePool(states: readonly FamilyState[], voided: readonly Family[], authors: readonly Family[], seed: string, key: string): Family[] {
  const pool = eligibleFamilies(states, [{ id: key, authors: [...authors] }], 'gate').filter((f) => !voided.includes(f));
  return seededShuffle(pool, seed, key);
}

function judgeTaskId(kind: string, d8: string, family: Family, n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${kind}TaskId: n must be a positive integer, got ${n}`);
  return taskId(`${kind}-${d8}-${family}-${n}`);
}

/** `regate-<d8>-<family>-<n>`. */
export function regateTaskId(d8: string, family: Family, n: number): string {
  return judgeTaskId('regate', d8, family, n);
}

/** `postmerge-<d8>-<family>-<n>`. */
export function postmergeTaskId(d8: string, family: Family, n: number): string {
  return judgeTaskId('postmerge', d8, family, n);
}

async function judgeOnce(ctx: StepContext, pack: GatePack, family: Family, n: number, id: string, seed: string): Promise<MergeJudge> {
  const r = await runTask(ctx, judgeBackend(ctx, family), gateJudgeTask(pack, id, seed));
  if (r.value === null) return { family, n, task: id, status: 'void', yes: null, verdict: null, error: ctx.redact(r.error ?? 'void') };
  return { family, n, task: id, status: 'ok', yes: r.value.yes, verdict: r.value, error: null };
}

/** Two gate judges over `order` (void → next family, fresh session); outcome by gate-judge.ts gateOutcome. */
export async function judgeMergeGate(
  ctx: StepContext,
  pack: GatePack,
  order: readonly Family[],
  taskIdOf: (family: Family, n: number) => string,
): Promise<{ judges: MergeJudge[]; outcome: GateOutcome }> {
  const seed = ctx.seed();
  const judges: MergeJudge[] = [];
  let next = 0;
  // Waves are deterministic (seeded order, fixed n), so a resumed run reuses every task record.
  for (;;) {
    const need = 2 - judges.filter((j) => j.status === 'ok').length;
    if (need <= 0 || next >= order.length) break;
    const wave = order.slice(next, next + need).map((family, k) => ({ family, n: next + k + 1 }));
    next += wave.length;
    judges.push(...(await runAll(ctx, wave.map((w) => () => judgeOnce(ctx, pack, w.family, w.n, taskIdOf(w.family, w.n), seed)))));
  }
  return { judges, outcome: gateOutcome(judges.map((j) => j.verdict)) };
}

/** world/current-relative paths changed vs `ref` (tracked diff + untracked). */
async function changedCanon(git: GitPort, ref: string): Promise<Result<string[]>> {
  const changed = await git.changedPaths(ref, [CANON_DIR]);
  if (!changed.ok) return err(`git: ${changed.error}`);
  return ok(changed.value.flatMap((p) => {
    const rel = canonRel(p);
    return rel === null ? [] : [rel];
  }));
}

/** What 10c may leave changed: 09, 07, 01–06, the manifest, the templated notes and the assembler outputs. */
function mergeWritable(rel: string): boolean {
  return rel === SCENES_PATH || rel === REGISTER_PATH || INDEXED_PATH.test(rel) || rel === MANIFEST_PATH || TEMPLATED_NOTES.includes(rel) || ASSEMBLER_WRITES.includes(rel);
}

/** world/current-relative paths changed vs `baseSha` outside what 10c may write (09, 07, 01–06, manifest, notes, assembler outputs). */
export async function unexpectedCanonChanges(ctx: StepContext, baseSha: string): Promise<Result<string[]>> {
  const changed = await changedCanon(ctx.ports.git, baseSha);
  if (!changed.ok) return changed;
  return ok(changed.value.filter((rel) => !mergeWritable(rel)));
}

/** Every changedPaths(baseSha, world/current) path back to git.show(baseSha, p) (absent at base → removed); returns them. */
export async function restoreCanon(ctx: StepContext, baseSha: string): Promise<Result<string[]>> {
  const changed = await changedCanon(ctx.ports.git, baseSha);
  if (!changed.ok) return changed;
  for (const rel of changed.value) {
    const before = await ctx.ports.git.show(baseSha, canonRepoPath(rel));
    if (!before.ok) return err(`git: ${before.error}`);
    const abs = join(ctx.repo, CANON_DIR, rel);
    if (before.value === null) ctx.files.remove(abs);
    else ctx.files.writeText(abs, before.value);
  }
  return ok(changed.value);
}

/** manifest.json text: `revision`, header line 0 `# 群星回响 · 世界设定参考集 <rev>`, first merge: 09 + manifestHeader appended. */
export function nextManifest(baseManifest: string, revision: string, merge: ProtocolMerge): Result<string> {
  let raw: unknown;
  try {
    raw = JSON.parse(baseManifest);
  } catch {
    return err('manifest.json: not valid JSON');
  }
  const header = isRecord(raw) ? stringArray(raw['header']) : null;
  const files = isRecord(raw) ? stringArray(raw['files']) : null;
  if (!isRecord(raw) || typeof raw['revision'] !== 'string' || header === null || header.length === 0 || files === null) {
    return err('manifest.json: revision, header (non-empty) and files are required');
  }
  const scenes = SCENES_PATH.slice('reference/'.length);
  const first = !files.includes(scenes);
  const next: JsonRecord = {
    ...raw,
    revision,
    header: [`${MANIFEST_TITLE} ${revision}`, ...header.slice(1), ...(first ? merge.manifestHeader : [])],
    files: first ? [...files, scenes] : files,
  };
  return ok(`${JSON.stringify(next, null, 2)}\n`);
}

/** TEMPLATED_NOTES path → new content (two-line `## <rev> 样本现场 RNN` entry + Rxx list appended to the base text). */
export function revisionNotes(before: Readonly<Record<string, string>>, revision: string, round: string, rxx: readonly string[]): Record<string, string> {
  const entry = `## ${revision} 样本现场 ${round}\n本场登记事实：${rxx.length === 0 ? '无' : rxx.join('、')}\n`;
  const out: Record<string, string> = {};
  for (const path of TEMPLATED_NOTES) {
    const text = Object.hasOwn(before, path) ? (before[path] ?? '') : '';
    out[path] = `${text}${text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n'}${entry}`;
  }
  return out;
}

/** git.show at `ref` of a world/current-relative path ('' when absent). */
async function canonAt(git: GitPort, ref: string, rel: string): Promise<Result<string | null>> {
  const r = await git.show(ref, canonRepoPath(rel));
  return r.ok ? r : err(`git: ${r.error}`);
}

/** MergeSources for the attempt: sourcesFromRound, mergeDecisionFrom, mergeRowIds, canon `before` via git.show(baseSha, …). */
export async function loadMergeSources(ctx: StepContext, attempt: MergeAttempt): Promise<Result<MergeSources>> {
  const sources = sourcesFromRound(ctx.root, attempt.round);
  if (!sources.ok) return sources;
  const brief = readBriefJson(ctx);
  const decision = mergeDecisionFrom(attempt.decision, sources.value, brief.row_id);
  if (!decision.ok) return decision;
  const rowIds = mergeRowIds(ctx.root);
  if (!rowIds.ok) return rowIds;
  const before: Record<string, string> = {};
  for (const key of [...new Set([...Object.keys(canonFiles(ctx.repo)), SCENES_PATH, ...TEMPLATED_NOTES])].sort(byCodeUnit)) {
    const text = await canonAt(ctx.ports.git, attempt.baseSha, key);
    if (!text.ok) return text;
    before[key] = text.value ?? '';
  }
  return ok({
    round: attempt.round, decision: decision.value, happened: attempt.decision.happened, sources: sources.value, rowIds: rowIds.value, before,
    cellTitle: brief.cell.title, constants: mergeConstants(ctx.protocol),
  });
}

function readIfPresent(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function baseBookSha(hashesText: string | null): string | null {
  if (hashesText === null) return null;
  try {
    const raw: unknown = JSON.parse(hashesText);
    return readString(raw, 'base_book_sha256');
  } catch {
    return null;
  }
}

/** applyCanonEditChecked's value: apply.json plus the mergecheck result (null when an earlier check failed first). */
export interface AppliedEdit {
  record: ApplyRecord;
  mergecheck: MergeCheckResult | null;
}

/** checkApplied's value; `outputs` = ASSEMBLER_WRITES path → SHA-256 of its bytes, {} unless every check passed. */
interface AppliedChecks {
  reasons: string[];
  assembler: ApplyRecord['assembler'];
  mergecheck: MergeCheckResult | null;
  outputs: Record<string, string>;
}

/** The checks after the writes, in plan order; each returns reasons ([] = passed). err = git / file problem. */
async function checkApplied(ctx: StepContext, attempt: MergeAttempt, decision: MergeDecision, writes: ReadonlySet<string>, revision: string): Promise<Result<AppliedChecks>> {
  const a = await ctx.ports.assembler.assemble(revision);
  if (!a.ok) return ok({ reasons: [`assembler: ${ctx.redact(a.error)}`], assembler: null, mergecheck: null, outputs: {} });
  const assembler = { reference_book_sha256: a.value.referenceBookSha256, characters: a.value.characters };
  const current = join(ctx.repo, CANON_DIR);
  const book = await canonAt(ctx.ports.git, attempt.baseSha, BOOK_PATH);
  if (!book.ok) return book;
  const hashes = await canonAt(ctx.ports.git, attempt.baseSha, HASHES_PATH);
  if (!hashes.ok) return hashes;
  const reasons: string[] = [];
  if (readIfPresent(join(current, BOOK_PATH)) !== book.value) reasons.push('BOOK.md differs from base_sha');
  const now = baseBookSha(readIfPresent(join(current, HASHES_PATH)));
  if (now === null || now !== baseBookSha(hashes.value)) reasons.push('hashes.json base_book_sha256 differs from base_sha');
  if (reasons.length > 0) return ok({ reasons, assembler, mergecheck: null, outputs: {} });
  const check = await runMergecheck(ctx, decision, attempt.baseSha);
  if (!check.ok) return check;
  if (!check.value.ok) return ok({ reasons: check.value.violations.map((v) => `mergecheck: ${v}`), assembler, mergecheck: check.value, outputs: {} });
  const changed = await changedCanon(ctx.ports.git, attempt.baseSha);
  if (!changed.ok) return changed;
  const extra = changed.value.filter((rel) => !writes.has(rel) && !ASSEMBLER_WRITES.includes(rel));
  if (extra.length > 0) return ok({ reasons: extra.map((rel) => `unexpected change after the assembler: ${rel}`), assembler, mergecheck: check.value, outputs: {} });
  // Hashed so 10d can refuse a hand edit of an assembler output instead of pinning it into post-merge.json.
  const outputs: Record<string, string> = {};
  for (const rel of ASSEMBLER_WRITES) {
    const path = join(current, rel);
    if (existsSync(path)) outputs[rel] = sha256Bytes(readFileSync(path));
    else reasons.push(`assembler output missing: ${rel}`);
  }
  return ok({ reasons, assembler, mergecheck: check.value, outputs: reasons.length > 0 ? {} : outputs });
}

/**
 * 10c: restoreCanon → write edit files + manifest + templated notes → assembler.assemble(rev) → BOOK bytes and
 * hashes.json base_book_sha256 equal base's → runMergecheck → changedPaths ⊆ edit ∪ manifest ∪ notes ∪ ASSEMBLER_WRITES
 * → both assembler outputs present (hashed into `written`). A failed check restores again and returns ok(status
 * failed); err = a git / file problem (canon may be dirty). `mergecheck` is what 10c writes to `mergecheck.json`.
 */
export async function applyCanonEditChecked(ctx: StepContext, attempt: MergeAttempt, edit: CanonEdit, decision: MergeDecision): Promise<Result<AppliedEdit>> {
  const foreign = Object.keys(edit.files).filter((rel) => rel !== SCENES_PATH && rel !== REGISTER_PATH && !INDEXED_PATH.test(rel));
  if (foreign.length > 0) return err(`edit: not a merge file: ${foreign.sort(byCodeUnit).join(', ')}`);
  const restored = await restoreCanon(ctx, attempt.baseSha);
  if (!restored.ok) return restored;
  const manifestBase = await canonAt(ctx.ports.git, attempt.baseSha, MANIFEST_PATH);
  if (!manifestBase.ok) return manifestBase;
  if (manifestBase.value === null) return err(`${canonRepoPath(MANIFEST_PATH)} is absent at base_sha`);
  let baseRevision: string | null;
  try {
    baseRevision = readString(JSON.parse(manifestBase.value), 'revision');
  } catch {
    baseRevision = null;
  }
  const revision = nextRevision(baseRevision ?? '');
  if (!revision.ok) return err(`${canonRepoPath(MANIFEST_PATH)} at base_sha: ${revision.error}`);
  const manifest = nextManifest(manifestBase.value, revision.value, ctx.protocol.merge);
  if (!manifest.ok) return manifest;
  const notesBefore: Record<string, string> = {};
  for (const path of TEMPLATED_NOTES) {
    const text = await canonAt(ctx.ports.git, attempt.baseSha, path);
    if (!text.ok) return text;
    notesBefore[path] = text.value ?? '';
  }
  const writes: Record<string, string> = { ...edit.files, [MANIFEST_PATH]: manifest.value, ...revisionNotes(notesBefore, revision.value, attempt.round, edit.rxx) };
  const written: Record<string, string> = {};
  for (const rel of Object.keys(writes).sort(byCodeUnit)) {
    const text = writes[rel] ?? '';
    ctx.files.writeText(join(ctx.repo, CANON_DIR, rel), text);
    written[rel] = sha256(text);
  }
  const checked = await checkApplied(ctx, attempt, decision, new Set(Object.keys(writes)), revision.value);
  if (!checked.ok) return checked;
  const bookText = readIfPresent(join(ctx.repo, CANON_DIR, BOOK_PATH));
  const failed = checked.value.reasons.length > 0;
  if (failed) {
    const again = await restoreCanon(ctx, attempt.baseSha);
    if (!again.ok) return again;
  }
  const changed = await changedCanon(ctx.ports.git, attempt.baseSha);
  if (!changed.ok) return changed;
  const pinned = Object.entries({ ...written, ...checked.value.outputs }).sort(([x], [y]) => byCodeUnit(x, y));
  const record: ApplyRecord = {
    round: attempt.round, d8: attempt.d8, decision_sha256: attempt.decisionSha256, base_sha: attempt.baseSha, revision: revision.value,
    status: failed ? 'failed' : 'applied', reasons: checked.value.reasons, restored: restored.value, written: Object.fromEntries(pinned), assembler: checked.value.assembler,
    book_sha256: bookText === null ? '' : sha256(bookText), changed: changed.value,
  };
  return ok({ record, mergecheck: checked.value.mergecheck });
}

/** Working tree vs `baseRef` (every canon Markdown + 09; unseen changed paths only OUTSIDE_MERGECHECK). */
export async function mergecheckWith(env: MergecheckEnv, decision: MergeDecision, baseRef: string): Promise<Result<MergeCheckResult>> {
  const ref = await env.git.resolveRef(baseRef);
  if (!ref.ok) return err(`unknown git ref ${baseRef}`);
  const sources = sourcesFromRound(env.root, decision.round);
  if (!sources.ok) return sources;
  // Every canon Markdown file goes to mergecheck, which fails any change outside 09, 07, 01–06 and the notes.
  const after = canonFiles(env.repo);
  const before: Record<string, string> = {};
  for (const key of new Set([...Object.keys(after), SCENES_PATH])) {
    const text = await canonAt(env.git, baseRef, key);
    if (!text.ok) return text;
    before[key] = text.value ?? '';
  }
  // Paths mergecheck does not see (deleted files, subfolders, non-Markdown) may only be the assembler's outputs.
  const changed = await changedCanon(env.git, baseRef);
  if (!changed.ok) return changed;
  const outside = changed.value.filter((key) => !Object.hasOwn(before, key) && !OUTSIDE_MERGECHECK.includes(key));
  const result = mergecheck({ constants: env.constants, rowIds: [...env.rowIds], decision, sources: sources.value, before, after });
  const violations = [...result.violations, ...[...new Set(outside)].sort(byCodeUnit).map((key) => `unexpected change: ${key}`)];
  return ok({ ok: violations.length === 0, violations });
}

/** mergecheckWith on ctx (root, repo, ports.git, mergeConstants(ctx.protocol), mergeRowIds). */
export async function runMergecheck(ctx: StepContext, decision: MergeDecision, baseRef: string): Promise<Result<MergeCheckResult>> {
  const rowIds = mergeRowIds(ctx.root);
  if (!rowIds.ok) return rowIds;
  return mergecheckWith({ root: ctx.root, repo: ctx.repo, git: ctx.ports.git, constants: mergeConstants(ctx.protocol), rowIds: rowIds.value }, decision, baseRef);
}

export function parseMergePointer(value: unknown): Result<MergePointer> {
  if (!isRecord(value)) return err('merge.json: not an object');
  const { round, current, decision_sha256: sha, status, revision } = value;
  const reasons = stringArray(value['reasons']);
  if (typeof round !== 'string' || typeof current !== 'string' || !/^[0-9a-f]{8}$/u.test(current)) return err('merge.json: round and current (d8) are required');
  if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/u.test(sha) || !sha.startsWith(current)) return err('merge.json: decision_sha256 must be the SHA-256 whose first 8 digits are current');
  if (status !== 'merged_on_branch' || typeof revision !== 'string' || reasons === null) return err('merge.json: status merged_on_branch, revision and reasons are required');
  return ok({ round, current, decision_sha256: sha, status, revision, reasons });
}

/** `merge.json`, null when absent (no merge committed: pick none or before 10f). */
export function readMergePointer(paths: RoundPaths): Result<MergePointer> | null {
  const path = join(paths.dir, MERGE_POINTER_FILE);
  if (!existsSync(path)) return null;
  try {
    return parseMergePointer(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return err(`rounds/${paths.id}/${MERGE_POINTER_FILE}: not valid JSON`);
  }
}

/** `feat: add sample scene RNN, reference <rev> (#<issue>)`. */
export function mergeCommitMessage(round: string, revision: string, issue: number): string {
  return `feat: add sample scene ${round}, reference ${revision} (#${issue})`;
}

