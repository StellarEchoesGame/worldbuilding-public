import { join } from 'node:path';
import type { Backend } from '../adapters/types.ts';
import { anonymizeText } from '../anonymize.ts';
import type { Attempted } from '../calls.ts';
import { isFamily, type Family } from '../config.ts';
import type { StepContext } from '../context.ts';
import { mechanicalGate, type GateCheck } from '../gate.ts';
import { isRecord, readString } from '../json.ts';
import { err, ok, type Result } from '../result.ts';
import { runAll, type StepDef, type StepOutcome } from '../runner.ts';
import { readJson, seededShuffle } from '../store.ts';
import { displayText, loadSubmission } from '../submission.ts';
import { IntegrityError, runTask } from '../task.ts';
import { eligibleFamilies, familyStates, gateRoles, type FamilyState } from '../tasks/assign.ts';
import { isOneOf, quoteSpan, type Span } from '../tasks/fenced.ts';
import { caughtDefect, gateJudgeTask, gateOutcome, type GateOutcome, type GatePack, type GateVerdict } from '../tasks/gate-judge.ts';
import { gateTaskId, resubmissionId } from '../tasks/ids.ts';
import { writerTask } from '../tasks/writing.ts';
import { forbiddenRows, readBriefJson } from './brief.ts';
import { drillFixture, gateFacts, readDefectFile } from './defect.ts';
import { negatedFlags, readMechanicalFile, readRoundJson } from './gate-mech.ts';
import type { MechanicalEntry, MechanicalGateFile } from './gate-mech.ts';
import { loadSkill } from './write.ts';

/** One gate call as recorded in `gate/<sub>.json`. */
export interface GateCall {
  task: string;
  status: 'ok' | 'void';
  /** GateVerdict.yes; null when void. */
  yes: boolean | null;
  verdict: GateVerdict | null;
  error: string | null;
}

/** One family's assignment on one submission (real call, plus the copy call on the defect submission). */
export interface GateJudge {
  family: Family;
  /** Ordinal on this submission (gateTaskId n): 1, 2 seeded judges; 3, 4, … reserve replacements. */
  n: number;
  reserve: boolean;
  real: GateCall;
  /** Only on the seeded defect submission (with a non-void defect). */
  copy: GateCall | null;
  /** caughtDefect on the copy; null without a copy call. */
  caught: boolean | null;
  /** The family's verdicts of the round are void (missed copy anywhere, or a void real / copy call). */
  voided: boolean;
}

export interface PathInstanceNote {
  family: Family;
  quote: string;
  against: string;
  reason: string;
}

/** `rounds/RNN/gate/<sub>.json` (05c for writer slots, 05d for `<slot>-r2`). */
export interface GateSubmissionFile {
  round: string;
  submission: string;
  /** false for 05c, true for the 05d pass on a resubmission. */
  resubmission: boolean;
  outcome: GateOutcome;
  judges: GateJudge[];
  /** Families whose verdicts count (non-voided, valid), in assignment order. */
  counted: Family[];
  /** This submission carried the round's defect copy but the defect call voided. */
  defect_unverified: boolean;
  path_instance_notes: PathInstanceNote[];
  negated_flags: string[];
}

export type VoidReason = 'missed_copy' | 'void_call';

/** `rounds/RNN/gate/llm.json` (05c summary). */
export interface GateLlmFile {
  round: string;
  defect_submission: string | null;
  defect_status: 'ok' | 'void' | 'none';
  voided_families: Array<{ family: Family; reason: VoidReason }>;
  /** Gate-bound submission → outcome (writer slots only; resubmissions are in resubmit.json). */
  submissions: Record<string, { outcome: GateOutcome; defect_unverified: boolean }>;
  /** Gate-bound submissions whose reserve ran out (outcome unverified, card flag ⚑事实门评委不足). */
  unverified: string[];
}

export interface ResubmitEntry {
  slot: string;
  /** `<slot>-r2`. */
  submission: string;
  reason: 'mechanical_fail' | 'gate_fail';
  writer: 'ok' | 'void';
  mechanical: 'pass' | 'fail' | 'missing';
  /** mechanicalGate checks of the resubmission ([] when the writer voided). */
  checks: GateCheck[];
  /** Gate outcome of the fresh pass; null when it never reached the gate. */
  outcome: GateOutcome | null;
}

/** `rounds/RNN/gate/resubmit.json` (05d). */
export interface ResubmitFile {
  round: string;
  entries: ResubmitEntry[];
  /** Final gate-passing submission ids after 05d (same as passingSubmissions). */
  passing: string[];
  /**
   * Every family voided this round after 05d: llm.json's list plus families that voided a call in the 05d pass.
   * Their 05c verdicts are not recomputed (05c is final once marked); 10a re-gates only with families never voided.
   */
  voided_families: GateLlmFile['voided_families'];
}


const OUTCOMES: readonly GateOutcome[] = ['pass', 'fail', 'split', 'unverified'];

/** One submission's gate pass input: its packs and its seeded family order (gateRoles judges, then reserve). */
interface GateSubject {
  id: string;
  pack: GatePack;
  /** The round's defect copy, only on the seeded defect submission with a non-void defect. */
  copy: { pack: GatePack; span: Span } | null;
  order: Family[];
  /** How many of `order` are seeded judges (the rest is reserve). */
  seeded: number;
}

interface PassResult {
  judges: Map<string, GateJudge[]>;
  /** Every voided family of the pass (pre-voided included), with its first reason. */
  voided: Map<Family, VoidReason>;
}

/** The judge families of this round (freeze pins) and each family's backend. */
interface JudgePool {
  states: FamilyState[];
  backendFor(family: Family): Backend;
}

/** Distinct families of the configured judge backends. */
export function judgeFamilies(ctx: StepContext): Family[] {
  return [...new Set(ctx.backends.judges.map((j) => j.backend.family))];
}

/** The first judge backend of `family` (a fresh session per call; the adapters guarantee it). Shared by 05c–07b. */
export function judgeBackend(ctx: StepContext, family: Family): Backend {
  const slot = ctx.backends.judges.find((j) => j.backend.family === family);
  if (slot === undefined) throw new Error(`no judge backend of family ${family}`);
  return slot.backend;
}

function judgePool(ctx: StepContext): JudgePool {
  return { states: familyStates(ctx.freeze(), ctx.backends.judges.map((j) => j.backend.family)), backendFor: (family) => judgeBackend(ctx, family) };
}

/** The writer family as judged-text authors (a family the judges cannot hold is simply no exclusion). */
function authorsOf(family: string): Family[] {
  return isFamily(family) ? [family] : [];
}

function subjectFor(id: string, pack: GatePack, copy: GateSubject['copy'], pool: readonly Family[], seed: string): GateSubject {
  const roles = gateRoles(pool, seed, id);
  return { id, pack, copy, order: [...roles.judges, ...roles.reserve], seeded: roles.judges.length };
}

function gateCall(ctx: StepContext, task: string, a: Attempted<GateVerdict>): GateCall {
  if (a.value === null) return { task, status: 'void', yes: null, verdict: null, error: ctx.redact(a.error ?? 'void') };
  return { task, status: 'ok', yes: a.value.yes, verdict: a.value, error: null };
}

/**
 * One family's fresh calls on one submission: the real text, plus the copy on the defect submission, in seeded
 * order (key `gateorder:<sub>:<family>`). The GateJudge's `voided` is settled by runGatePass.
 */
async function judgeOnce(ctx: StepContext, backend: Backend, s: GateSubject, index: number, resubmission: boolean, seed: string): Promise<GateJudge> {
  const family = backend.family;
  const n = index + 1;
  const realSpec = gateJudgeTask(s.pack, gateTaskId(s.id, family, n, { copy: false, resubmission }), seed);
  const copySpec = s.copy === null ? null : gateJudgeTask(s.copy.pack, gateTaskId(s.id, family, n, { copy: true, resubmission }), seed);
  const copyFirst = copySpec !== null && seededShuffle(['real', 'copy'], seed, `gateorder:${s.id}:${family}`)[0] === 'copy';
  const early = copySpec !== null && copyFirst ? await runTask(ctx, backend, copySpec) : null;
  const real = await runTask(ctx, backend, realSpec);
  const late = copySpec !== null && !copyFirst ? await runTask(ctx, backend, copySpec) : null;
  const copyRun = early ?? late;
  const copy = copySpec === null || copyRun === null ? null : gateCall(ctx, copySpec.id, copyRun);
  const caught = s.copy === null || copyRun === null ? null : caughtDefect(copyRun.value, s.copy.pack.subject, s.copy.span);
  return { family, n, reserve: index >= s.seeded, real: gateCall(ctx, realSpec.id, real), copy, caught, voided: false };
}

/** Why a finished assignment voids its family for the round, or null. */
function voidReason(j: GateJudge): VoidReason | null {
  if (j.real.status === 'void' || (j.copy !== null && j.copy.status === 'void')) return 'void_call';
  if (j.copy !== null && j.caught !== true) return 'missed_copy';
  return null;
}

/**
 * The family-level gate pass (PROTOCOL §2): every subject keeps two non-voided families, taken in its seeded order.
 * Calls run in waves; after each wave a family that voided a call or missed the copy is voided for the whole pass
 * (all its verdicts on every subject), and each affected subject takes its next reserve family (same catch rule on
 * the defect submission). Pre-voided families are never assigned. Waves are deterministic, so a resumed run reuses
 * every task record and makes no new call.
 */
async function runGatePass(
  ctx: StepContext,
  subjects: readonly GateSubject[],
  pool: JudgePool,
  pre: ReadonlyMap<Family, VoidReason>,
  resubmission: boolean,
  seed: string,
): Promise<PassResult> {
  const voided = new Map<Family, VoidReason>(pre);
  const judges = new Map<string, GateJudge[]>(subjects.map((s) => [s.id, []]));
  const next = new Map<string, number>(subjects.map((s) => [s.id, 0]));
  for (;;) {
    const wave: Array<{ s: GateSubject; index: number; family: Family }> = [];
    for (const s of subjects) {
      const done = judges.get(s.id) ?? [];
      let active = done.filter((j) => !voided.has(j.family)).length;
      let i = next.get(s.id) ?? 0;
      while (active < 2 && i < s.order.length) {
        const family = s.order[i];
        if (family !== undefined && !voided.has(family)) {
          wave.push({ s, index: i, family });
          active += 1;
        }
        i += 1;
      }
      next.set(s.id, i);
    }
    if (wave.length === 0) break;
    const results = await runAll(
      ctx,
      wave.map(({ s, index, family }) => () => judgeOnce(ctx, pool.backendFor(family), s, index, resubmission, seed)),
    );
    wave.forEach(({ s }, k) => {
      const j = results[k];
      if (j === undefined) return;
      judges.get(s.id)?.push(j);
      const reason = voidReason(j);
      if (reason !== null && !voided.has(j.family)) voided.set(j.family, reason);
    });
  }
  for (const list of judges.values()) for (const j of list) j.voided = voided.has(j.family);
  return { judges, voided };
}

function submissionFile(ctx: StepContext, s: GateSubject, judges: readonly GateJudge[], resubmission: boolean, defectUnverified: boolean): GateSubmissionFile {
  const counted = judges.filter((j) => !j.voided && j.real.verdict !== null).slice(0, 2);
  const notes: PathInstanceNote[] = counted.flatMap((j) =>
    (j.real.verdict?.findings ?? []).filter((f) => f.class === 'path_instance').map((f) => ({ family: j.family, quote: f.quote, against: f.against, reason: f.reason })),
  );
  return {
    round: ctx.roundId,
    submission: s.id,
    resubmission,
    outcome: gateOutcome(counted.map((j) => j.real.verdict)),
    judges: [...judges],
    counted: counted.map((j) => j.family),
    defect_unverified: defectUnverified,
    path_instance_notes: notes,
    negated_flags: [...s.pack.negatedFlags],
  };
}

/**
 * The 05a negated-sentence flags as the judges of `subject` see them: typeset like the display text (anonymizeText)
 * and only those that occur in it. A flag on a sentence the defect replaced therefore never reaches the copy's
 * judges, and a flag on the dropped title line never reaches anyone.
 */
export function judgedFlags(subject: string, flags: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of flags) {
    const typeset = anonymizeText(f);
    if (typeset !== '' && !out.includes(typeset) && quoteSpan(typeset, subject) !== null) out.push(typeset);
  }
  return out;
}

function textPack(ctx: StepContext, id: string, entry: MechanicalEntry | undefined, facts: GatePack['facts'], regression: GatePack['regression'], forbidden: GatePack['forbidden']): { pack: GatePack; family: string; rel: string; flags: string[] } {
  const path = join(ctx.paths.submissions, `${id}.json`);
  const loaded = loadSubmission(ctx.paths, id);
  if (loaded === null || loaded.output === null) throw new IntegrityError(`${ctx.files.rel(path)} passed the mechanical gate but does not load`);
  const subject = displayText(loaded.output);
  const flags = negatedFlags(entry);
  const pack: GatePack = { subjectKind: 'text', subject, facts, regression, forbidden, negatedFlags: judgedFlags(subject, flags) };
  return { pack, family: loaded.family, rel: ctx.files.rel(path), flags };
}

function outcomeOf(v: unknown): GateOutcome | null {
  return typeof v === 'string' && isOneOf(v, OUTCOMES) ? v : null;
}

/** A `voided_families` list; null when malformed. */
function parseVoided(value: unknown): GateLlmFile['voided_families'] | null {
  if (!Array.isArray(value)) return null;
  const out: GateLlmFile['voided_families'] = [];
  for (const e of value) {
    if (!isRecord(e) || typeof e['family'] !== 'string' || !isFamily(e['family']) || (e['reason'] !== 'missed_copy' && e['reason'] !== 'void_call')) return null;
    out.push({ family: e['family'], reason: e['reason'] });
  }
  return out;
}

/** `gate/llm.json` (05c), parsed. */
function readGateLlmFile(ctx: StepContext): Result<GateLlmFile> {
  const raw = readRoundJson(ctx, join(ctx.paths.gate, 'llm.json'));
  if (!raw.ok) return raw;
  const bad = err<GateLlmFile>(`rounds/${ctx.roundId}/gate/llm.json: malformed`);
  const v = raw.value;
  if (!isRecord(v) || typeof v['round'] !== 'string' || !isRecord(v['submissions']) || !Array.isArray(v['voided_families']) || !Array.isArray(v['unverified'])) return bad;
  const status = v['defect_status'];
  if (status !== 'ok' && status !== 'void' && status !== 'none') return bad;
  const defectSub = v['defect_submission'];
  if (defectSub !== null && typeof defectSub !== 'string') return bad;
  const voided = parseVoided(v['voided_families']);
  if (voided === null) return bad;
  const submissions: GateLlmFile['submissions'] = {};
  for (const [id, e] of Object.entries(v['submissions'])) {
    const outcome = isRecord(e) ? outcomeOf(e['outcome']) : null;
    if (!isRecord(e) || outcome === null || typeof e['defect_unverified'] !== 'boolean') return bad;
    submissions[id] = { outcome, defect_unverified: e['defect_unverified'] };
  }
  const unverified = v['unverified'].filter((u): u is string => typeof u === 'string');
  return ok({ round: v['round'], defect_submission: defectSub, defect_status: status, voided_families: voided, submissions, unverified });
}

function parseResubmitEntry(e: unknown): ResubmitEntry | null {
  if (!isRecord(e)) return null;
  const { slot, submission, reason, writer, mechanical, checks, outcome } = e;
  if (typeof slot !== 'string' || typeof submission !== 'string' || !Array.isArray(checks)) return null;
  if ((reason !== 'mechanical_fail' && reason !== 'gate_fail') || (writer !== 'ok' && writer !== 'void')) return null;
  if (mechanical !== 'pass' && mechanical !== 'fail' && mechanical !== 'missing') return null;
  const parsedOutcome = outcome === null ? null : outcomeOf(outcome);
  if (outcome !== null && parsedOutcome === null) return null;
  const parsedChecks: GateCheck[] = [];
  for (const c of checks) {
    if (!isRecord(c) || typeof c['name'] !== 'string' || typeof c['ok'] !== 'boolean' || typeof c['detail'] !== 'string') return null;
    const flags = c['flags'];
    const strings = Array.isArray(flags) ? flags.filter((f): f is string => typeof f === 'string') : null;
    parsedChecks.push(strings === null ? { name: c['name'], ok: c['ok'], detail: c['detail'] } : { name: c['name'], ok: c['ok'], detail: c['detail'], flags: strings });
  }
  return { slot, submission, reason, writer, mechanical, checks: parsedChecks, outcome: parsedOutcome };
}

/** `gate/resubmit.json` (05d), parsed. */
function readResubmitFile(ctx: StepContext): Result<ResubmitFile> {
  const raw = readRoundJson(ctx, join(ctx.paths.gate, 'resubmit.json'));
  if (!raw.ok) return raw;
  const v = raw.value;
  const bad = err<ResubmitFile>(`rounds/${ctx.roundId}/gate/resubmit.json: malformed`);
  if (!isRecord(v) || typeof v['round'] !== 'string' || !Array.isArray(v['entries']) || !Array.isArray(v['passing'])) return bad;
  const entries: ResubmitEntry[] = [];
  for (const e of v['entries']) {
    const entry = parseResubmitEntry(e);
    if (entry === null) return bad;
    entries.push(entry);
  }
  const voided = parseVoided(v['voided_families']);
  if (voided === null) return bad;
  return ok({ round: v['round'], entries, passing: v['passing'].filter((p): p is string => typeof p === 'string'), voided_families: voided });
}

/** The slots 05d resubmits: a mechanical fail, or a mechanical pass whose 05c gate outcome is fail (void writers stay missing). */
function failedSlots(mech: MechanicalGateFile, llm: GateLlmFile): Array<{ slot: string; reason: ResubmitEntry['reason'] }> {
  const out: Array<{ slot: string; reason: ResubmitEntry['reason'] }> = [];
  for (const [slot, e] of Object.entries(mech.submissions)) {
    if (e.status === 'fail') out.push({ slot, reason: 'mechanical_fail' });
    else if (e.status === 'pass' && llm.submissions[slot]?.outcome === 'fail') out.push({ slot, reason: 'gate_fail' });
  }
  return out;
}

/** passingSubmissions over parsed files; `resubmit` is needed only when some slot failed. */
function computePassing(mech: MechanicalGateFile, llm: GateLlmFile, resubmit: ResubmitFile | null): Result<string[]> {
  const out: string[] = [];
  for (const [slot, e] of Object.entries(mech.submissions)) {
    if (e.status === 'missing') continue;
    if (e.status === 'pass') {
      const g = llm.submissions[slot];
      if (g === undefined) return err(`gate/llm.json has no entry for ${slot}`);
      if (g.outcome !== 'fail') {
        out.push(slot);
        continue;
      }
    }
    if (resubmit === null) return err('gate/resubmit.json is missing');
    const r = resubmit.entries.find((x) => x.slot === slot);
    if (r === undefined) return err(`gate/resubmit.json has no entry for ${slot}`);
    if (r.mechanical === 'pass' && r.outcome !== null && r.outcome !== 'fail') out.push(r.submission);
  }
  return ok(out);
}

/**
 * The submission ids that enter taste, in slot order: per slot its first version when the gate outcome is pass /
 * split / unverified, else `<slot>-r2` when that one passed mechanical + gate (not fail), else nothing. Reads
 * `gate/mechanical.json`, `gate/llm.json` and, when some slot failed (05d ran), `gate/resubmit.json`. err when a
 * needed file is missing.
 */
export function passingSubmissions(ctx: StepContext): Result<string[]> {
  const mech = readMechanicalFile(ctx);
  if (!mech.ok) return err(mech.error);
  const llm = readGateLlmFile(ctx);
  if (!llm.ok) return err(llm.error);
  if (failedSlots(mech.value, llm.value).length === 0) return computePassing(mech.value, llm.value, null);
  const resubmit = readResubmitFile(ctx);
  if (!resubmit.ok) return err(resubmit.error);
  return computePassing(mech.value, llm.value, resubmit.value);
}

function voidedList(voided: ReadonlyMap<Family, VoidReason>): GateLlmFile['voided_families'] {
  return [...voided].map(([family, reason]) => ({ family, reason })).sort((a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : 0));
}

/**
 * 05c-gate-llm: per gate-bound submission `gateRoles(pool, seed, sub)` over `eligibleFamilies(familyStates(freeze),
 * authors, 'gate')`; 2 fresh real calls; the defect submission's two judges also judge the copy in seeded order
 * (`gateorder:<sub>:<family>`). A family that misses the copy or voids any call loses all its verdicts of the round;
 * each affected submission takes the next reserve family (same catch rule). Outputs `gate/llm.json`, `gate/<sub>.json`.
 */
export const gateLlmStep: StepDef = {
  id: '05c-gate-llm',
  run: async (ctx) => {
    const mech = readMechanicalFile(ctx);
    if (!mech.ok) throw new IntegrityError(mech.error);
    const defect = readDefectFile(ctx);
    if (!defect.ok) throw new IntegrityError(defect.error);
    const brief = readBriefJson(ctx);
    const seed = ctx.seed();
    const facts = gateFacts(brief, drillFixture(ctx));
    const pool = judgePool(ctx);
    const inputs = ['mechanical.json', 'defect.json'].map((f) => ctx.files.rel(join(ctx.paths.gate, f)));
    inputs.push(ctx.files.rel(ctx.paths.brief));
    const d = defect.value;
    const subjects: GateSubject[] = [];
    for (const [id, entry] of Object.entries(mech.value.submissions)) {
      if (entry.status !== 'pass') continue;
      const t = textPack(ctx, id, entry, facts, brief.regression, forbiddenRows(brief));
      inputs.push(t.rel);
      const copy = d.status === 'ok' && d.submission === id && d.copy !== null && d.injected_span !== null ? { pack: { ...t.pack, subject: d.copy, negatedFlags: judgedFlags(d.copy, t.flags) }, span: d.injected_span } : null;
      const families = eligibleFamilies(pool.states, [{ id, authors: authorsOf(t.family) }], 'gate');
      subjects.push(subjectFor(id, t.pack, copy, families, seed));
    }
    const pass = await runGatePass(ctx, subjects, pool, new Map(), false, seed);
    const outputs: string[] = [];
    const summary: GateLlmFile['submissions'] = {};
    for (const s of subjects) {
      const unverifiedDefect = d.status === 'void' && d.submission === s.id;
      const file = submissionFile(ctx, s, pass.judges.get(s.id) ?? [], false, unverifiedDefect);
      outputs.push(ctx.files.writeJson(join(ctx.paths.gate, `${s.id}.json`), file));
      summary[s.id] = { outcome: file.outcome, defect_unverified: unverifiedDefect };
    }
    const llm: GateLlmFile = {
      round: ctx.roundId,
      defect_submission: d.submission,
      defect_status: d.status,
      voided_families: voidedList(pass.voided),
      submissions: summary,
      unverified: Object.entries(summary).filter(([, e]) => e.outcome === 'unverified').map(([id]) => id),
    };
    outputs.push(ctx.files.writeJson(join(ctx.paths.gate, 'llm.json'), llm));
    const text = Object.entries(summary).map(([id, e]) => `${id}:${e.outcome}`).join(' ');
    const voidedText = llm.voided_families.length === 0 ? '' : ` voided ${llm.voided_families.map((v) => `${v.family}(${v.reason})`).join(',')}`;
    ctx.progress('05c-gate-llm', llm.unverified.length === 0 ? 'info' : 'error', `${text === '' ? 'no gate-bound submission' : text}${voidedText}`);
    return { kind: 'done', inputs, outputs, external: [] };
  },
};

function failed(detail: string): StepOutcome {
  return { kind: 'failed', detail };
}

interface Rewrite {
  slot: string;
  reason: ResubmitEntry['reason'];
  submission: string;
  rel: string;
  writer: 'ok' | 'void';
  inputs: string[];
}

/** One blind resubmission: the slot's first prompt, byte for byte (same brief, stance and skill), id `write-<slot>-r2`. */
async function rewrite(ctx: StepContext, slot: string, reason: ResubmitEntry['reason']): Promise<Rewrite> {
  const firstPath = join(ctx.paths.submissions, `${slot}.json`);
  const first = readJson(firstPath);
  const stance = readString(first, 'stance');
  if (stance === null) throw new IntegrityError(`${ctx.files.rel(firstPath)} has no stance`);
  const skillName = readString(first, 'skill');
  const writer = ctx.backends.writers.find((w) => w.slot === slot);
  if (writer === undefined) throw new IntegrityError(`writer slot ${slot} of gate/mechanical.json is not configured`);
  const inputs = [ctx.files.rel(firstPath)];
  let skill: { name: string; text: string } | null = null;
  if (skillName !== null) {
    const loaded = loadSkill(ctx.root, skillName, ctx.freeze());
    if (!loaded.ok) throw new IntegrityError(loaded.error);
    skill = { name: loaded.value.name, text: loaded.value.text };
    inputs.push(loaded.value.rel);
  }
  const submission = resubmissionId(slot);
  const spec = writerTask(readBriefJson(ctx), submission, stance, skill);
  const r = await runTask(ctx, writer.backend, spec);
  const rel = ctx.files.writeJson(join(ctx.paths.submissions, `${submission}.json`), {
    id: submission,
    kind: 'writer',
    task: spec.id,
    model: writer.backend.model,
    served_model: r.last?.servedModel ?? null,
    family: writer.backend.family,
    stance,
    skill: skillName,
    ok: r.value !== null,
    error: r.value === null ? ctx.redact(r.error ?? 'void') : null,
    attempts: r.attempts,
    text: r.value === null ? '' : (r.last?.text ?? ''),
  });
  return { slot, reason, submission, rel, writer: r.value === null ? 'void' : 'ok', inputs };
}

/** mechanicalGate on a resubmission file, as 05a does for first versions. */
function mechanicalOf(ctx: StepContext, submission: string): MechanicalEntry {
  const sub = loadSubmission(ctx.paths, submission);
  if (sub === null || sub.output === null) return { status: 'missing', pass: false, checks: [], error: sub === null ? 'malformed submission file' : (sub.error ?? 'void') };
  const r = ctx.rules;
  const g = mechanicalGate(sub.output, { baseline: false, limits: r.limits, forbidden: r.forbidden, negations: r.negations, negationExceptions: r.negationExceptions });
  return { status: g.pass ? 'pass' : 'fail', pass: g.pass, checks: g.checks, error: null };
}

/**
 * 05d-resubmit: every mechanical or gate `fail` slot gets one blind writerTask call (same prompt, id
 * `write-<slot>-r2`, no gate feedback), then the mechanical gate and a fresh gate pass (`gate-<slot>-r2-…-re`) by
 * families not voided in 05c; no new defect copy. resubmit.json lists every family voided this round (05c + 05d).
 * skip when nothing failed; failed (5) when no submission passes.
 * Outputs `submissions/<slot>-r2.json`, `gate/<slot>-r2.json`, `gate/resubmit.json`.
 */
export const resubmitStep: StepDef = {
  id: '05d-resubmit',
  run: async (ctx) => {
    const mech = readMechanicalFile(ctx);
    if (!mech.ok) throw new IntegrityError(mech.error);
    const llm = readGateLlmFile(ctx);
    if (!llm.ok) throw new IntegrityError(llm.error);
    const todo = failedSlots(mech.value, llm.value);
    if (todo.length === 0) {
      const passing = computePassing(mech.value, llm.value, null);
      if (!passing.ok) throw new IntegrityError(passing.error);
      if (passing.value.length === 0) return failed('05d-resubmit: no submission passed the gate and no slot can be resubmitted');
      return { kind: 'skip', reason: 'no failed slot' };
    }
    const seed = ctx.seed();
    const brief = readBriefJson(ctx);
    const facts = gateFacts(brief, drillFixture(ctx));
    const pool = judgePool(ctx);
    const pre = new Map<Family, VoidReason>(llm.value.voided_families.map((v) => [v.family, v.reason]));
    const rewrites = await runAll(ctx, todo.map((t) => () => rewrite(ctx, t.slot, t.reason)));
    const mechs = new Map<string, MechanicalEntry>(rewrites.map((w) => [w.submission, mechanicalOf(ctx, w.submission)]));
    const subjects: GateSubject[] = [];
    for (const w of rewrites) {
      const entry = mechs.get(w.submission);
      if (entry?.status !== 'pass') continue;
      const t = textPack(ctx, w.submission, entry, facts, brief.regression, forbiddenRows(brief));
      const families = eligibleFamilies(pool.states, [{ id: w.submission, authors: authorsOf(t.family) }], 'gate').filter((f) => !pre.has(f));
      subjects.push(subjectFor(w.submission, t.pack, null, families, seed));
    }
    const pass = await runGatePass(ctx, subjects, pool, pre, true, seed);
    const outputs = rewrites.map((w) => w.rel);
    const outcomes = new Map<string, GateOutcome>();
    for (const s of subjects) {
      const file = submissionFile(ctx, s, pass.judges.get(s.id) ?? [], true, false);
      outputs.push(ctx.files.writeJson(join(ctx.paths.gate, `${s.id}.json`), file));
      outcomes.set(s.id, file.outcome);
    }
    const entries: ResubmitEntry[] = rewrites.map((w) => {
      const m = mechs.get(w.submission);
      return {
        slot: w.slot, submission: w.submission, reason: w.reason, writer: w.writer, mechanical: m?.status ?? 'missing', checks: m?.checks ?? [],
        outcome: outcomes.get(w.submission) ?? null,
      };
    });
    const draft: ResubmitFile = { round: ctx.roundId, entries, passing: [], voided_families: voidedList(pass.voided) };
    const passing = computePassing(mech.value, llm.value, draft);
    if (!passing.ok) throw new IntegrityError(passing.error);
    outputs.push(ctx.files.writeJson(join(ctx.paths.gate, 'resubmit.json'), { ...draft, passing: passing.value }));
    const text = entries.map((e) => `${e.submission}:${e.writer === 'void' ? 'void' : e.mechanical === 'pass' ? (e.outcome ?? 'missing') : `mechanical_${e.mechanical}`}`).join(' ');
    ctx.progress('05d-resubmit', passing.value.length === 0 ? 'error' : 'info', `${text}; passing ${passing.value.join(',') || 'none'}`);
    if (passing.value.length === 0) return failed('05d-resubmit: no submission passed the gate after resubmission');
    const inputs = [...new Set([
      ...['mechanical.json', 'llm.json'].map((f) => ctx.files.rel(join(ctx.paths.gate, f))),
      ctx.files.rel(ctx.paths.brief),
      ...rewrites.flatMap((w) => w.inputs),
    ])];
    return { kind: 'done', inputs, outputs, external: [] };
  },
};
