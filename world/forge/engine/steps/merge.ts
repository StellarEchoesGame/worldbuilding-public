import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isFamily, type Family } from '../config.ts';
import type { StepContext } from '../context.ts';
import { isRecord, readArray, readNumber, readString, stringArray } from '../json.ts';
import { sha256Bytes } from '../marker.ts';
import {
  APPLY_FILE, applyCanonEditChecked, CANON_DIR, EDIT_FILE, gatePool, judgeMergeGate, loadMergeSources, MERGE_POINTER_FILE, mergeAttempt, mergeCommitMessage,
  MERGECHECK_FILE, needsRegate, PLAN_FILE, POSTMERGE_GATE_FILE, postMergeMechanical, postMergePack, postmergeTaskId, REGATE_FILE, regateFacts,
  regateMechanical, regatePack, regateTaskId, restoreCanon, trialDonors, unexpectedCanonChanges,
  type MergeAttempt, type MergeJudge, type MergePointer, type PostMergeGateRecord, type RegateRecord, type RegateStatus,
} from '../merge.ts';
import { sentencesCarrying, type MergeDecision } from '../mergecheck.ts';
import { protocolGate } from '../owner-inputs.ts';
import { checkPostMerge, buildPostMerge, POST_MERGE_FILE, readPostMerge } from '../postmerge.ts';
import { err, ok, type Result } from '../result.ts';
import { ensureRoundBranch, type StepDef, type StepOutcome } from '../runner.ts';
import { canonicalJson } from '../seal.ts';
import { readJson, sha256 } from '../store.ts';
import { loadSubmission } from '../submission.ts';
import { IntegrityError, runTask } from '../task.ts';
import { familyStates } from '../tasks/assign.ts';
import { taskId } from '../tasks/ids.ts';
import { fallbackPlan, mergeability, mergeEditorTask, mergeEditorTaskId, renderedViolations, renderMerge, type CanonEdit, type EditorResult, type MergeSources } from '../tasks/merge-editor.ts';
import { FACT_STATUSES, readBriefJson } from './brief.ts';
import { judgeFamilies } from './gate-llm.ts';

/**
 * Steps 10a–10f (plan §4 rows 23–28, §8; PR-D group D1). Outputs under `rounds/RNN/merge/<d8>/`; every task id carries
 * d8. `pick = none` → every step skips. Rewinds (10a trial / fail / split, 10e fail) write the gate record, restore
 * world/current from start.base_sha, and return `{kind:'rewind', to:'09b-decision', detail, outputs:[record]}` with
 * detail `trial_pair:<d8>` | `regate_failed:<d8>` | `postmerge_failed:<d8>`.
 */

const PICK_NONE = 'pick none';

function failed(detail: string): StepOutcome {
  return { kind: 'failed', detail };
}

function blocked(detail: string): StepOutcome {
  return { kind: 'blocked', detail };
}

/** The attempt of the pinned decision, or null for `pick = none`. */
function attemptOf(ctx: StepContext): MergeAttempt | null {
  return ctx.decision().pick === 'none' ? null : mergeAttempt(ctx);
}

function attemptPath(a: MergeAttempt, file: string): string {
  return join(a.dir, file);
}

function repoRel(ctx: StepContext, abs: string): string {
  return relative(ctx.repo, abs).split(sep).join('/');
}

/** Inputs every 10a–10c step reads: the pinned decision, labels, brief (forge-root-relative). */
function baseInputs(ctx: StepContext, a: MergeAttempt): string[] {
  return [a.decision.file, ctx.files.rel(join(ctx.paths.dir, 'labels.json')), ctx.files.rel(ctx.paths.brief)];
}

async function sourcesOf(ctx: StepContext, a: MergeAttempt): Promise<MergeSources> {
  const src = await loadMergeSources(ctx, a);
  if (!src.ok) throw new IntegrityError(`merge sources of ${a.round}: ${src.error}`);
  return src.value;
}

async function rewind(ctx: StepContext, a: MergeAttempt, rel: string, detail: string): Promise<StepOutcome> {
  const restored = await restoreCanon(ctx, a.baseSha);
  if (!restored.ok) return blocked(`restore from base_sha: ${restored.error}`);
  return { kind: 'rewind', to: '09b-decision', detail, outputs: [rel] };
}

/** `tally.json` champion pairs as {label, trial} (the only part 10a reads). */
function tallyTrials(ctx: StepContext): { champion_pairs: Array<{ label: string; trial: boolean }> } {
  const raw = readJson(join(ctx.paths.dir, 'tally.json'));
  const pairs = readArray(raw, 'champion_pairs');
  if (pairs === null) throw new IntegrityError(`rounds/${ctx.roundId}/tally.json has no champion_pairs`);
  return {
    champion_pairs: pairs.map((p) => {
      const label = readString(p, 'label');
      const trial = isRecord(p) ? p['trial'] : null;
      if (label === null || typeof trial !== 'boolean') throw new IntegrityError(`rounds/${ctx.roundId}/tally.json: a champion pair lacks label or trial`);
      return { label, trial };
    }),
  };
}

/** Families voided in step 5: gate/resubmit.json's list (05d ran), else gate/llm.json's; [] when neither exists. */
function voidedFamilies(ctx: StepContext): Family[] {
  for (const name of ['resubmit.json', 'llm.json']) {
    const raw = readJson(join(ctx.paths.gate, name));
    if (raw === null) continue;
    const list = readArray(raw, 'voided_families');
    if (list === null) throw new IntegrityError(`rounds/${ctx.roundId}/gate/${name}: voided_families missing`);
    return list.flatMap((v) => {
      const f = readString(v, 'family');
      return f !== null && isFamily(f) ? [f] : [];
    });
  }
  return [];
}

/** labels.json label → submission id (null when absent). */
function submissionOf(ctx: StepContext, label: string): string | null {
  return readString(readJson(join(ctx.paths.dir, 'labels.json')), label);
}

/** The labels whose texts a merge combines: the base and every fact donor. */
function involvedLabels(d: MergeDecision): string[] {
  return [...new Set([d.baseLabel, ...d.registered.map((r) => r.label)])];
}

/** Author families of the base and donors (gate pool exclusion; a non-judge family simply excludes nothing). */
function mergeAuthors(ctx: StepContext, d: MergeDecision): Family[] {
  const out = new Set<Family>();
  for (const label of involvedLabels(d)) {
    const id = submissionOf(ctx, label);
    const family = id === null ? null : (loadSubmission(ctx.paths, id)?.family ?? null);
    if (family !== null && isFamily(family)) out.add(family);
  }
  return [...out];
}

/** Distinct new proper nouns of the involved submissions that occur in the base text or a donor source sentence. */
function mergeProperNouns(ctx: StepContext, src: MergeSources): string[] {
  const d = src.decision;
  const texts = [src.sources.find((s) => s.label === d.baseLabel)?.submission ?? ''];
  for (const r of d.registered) {
    if (r.label === d.baseLabel) continue;
    const source = src.sources.find((s) => s.label === r.label);
    const fact = source?.facts.find((f) => f.id === r.factId);
    if (source !== undefined && fact !== undefined) texts.push(...sentencesCarrying(source.submission, fact.sourceQuote));
  }
  const nouns = new Set<string>();
  for (const label of involvedLabels(d)) {
    const id = submissionOf(ctx, label);
    for (const noun of (id === null ? null : loadSubmission(ctx.paths, id))?.output?.delta.newProperNouns ?? []) {
      if (noun.trim() !== '' && texts.some((t) => t.includes(noun))) nouns.add(noun);
    }
  }
  return [...nouns].sort();
}

function gateOrder(ctx: StepContext, d: MergeDecision, key: string): Family[] {
  return gatePool(familyStates(ctx.freeze(), judgeFamilies(ctx)), voidedFamilies(ctx), mergeAuthors(ctx, d), ctx.seed(), key);
}

/** A pool too small to ever give two verdicts: a gate failure the owner answers with a new decision, not an outage. */
const POOL_TOO_SMALL = 'gate pool has fewer than two families';

/**
 * Judge generation of 10a / 10e (the record's `attempts`): 1, or one more than a stored `unverified` record of this
 * decision, so a rerun after an outage calls afresh (`-t<g>` ids) instead of reusing the void task records, which
 * stay as evidence. A stored pass / split keeps its generation (a crash before the marker reuses its records).
 */
function judgeGeneration(ctx: StepContext, a: MergeAttempt, path: string): number {
  const raw = readJson(path);
  if (raw === null || readString(raw, 'decision_sha256') !== a.decisionSha256) return 1;
  const attempts = readNumber(raw, 'attempts') ?? 1;
  if (!Number.isInteger(attempts) || attempts < 1) throw new IntegrityError(`${ctx.files.rel(path)}: attempts must be a positive integer`);
  return readString(raw, 'status') === 'unverified' ? attempts + 1 : attempts;
}

/** `id` for generation 1, `<id>-t<g>` after (the engine's retry-id convention, as `baseline-BASE-t2`). */
function generationId(id: string, generation: number): string {
  return generation <= 1 ? id : taskId(`${id}-t${generation}`);
}

/** world/current-relative paths changed vs base_sha that are not in `allowed` (a hand edit or a new file after 10c). */
async function strayCanon(ctx: StepContext, baseSha: string, allowed: ReadonlySet<string>): Promise<Result<string[]>> {
  const changed = await ctx.ports.git.changedPaths(baseSha, [CANON_DIR]);
  if (!changed.ok) return err(`git: ${changed.error}`);
  const prefix = `${CANON_DIR}/`;
  return ok(changed.value.flatMap((p) => (p.startsWith(prefix) && !allowed.has(p.slice(prefix.length)) ? [p.slice(prefix.length)] : [])));
}

/** 10a: trial donor → regate.json status trial, no calls, rewind; no foreign-label fact → skip; mechanical + 2 judges. */
export const regateStep: StepDef = {
  id: '10a-regate',
  run: async (ctx) => {
    const a = attemptOf(ctx);
    if (a === null) return { kind: 'skip', reason: PICK_NONE };
    const unexpected = await unexpectedCanonChanges(ctx, a.baseSha);
    if (!unexpected.ok) return blocked(unexpected.error);
    if (unexpected.value.length > 0) return failed(`world/current has changes a merge cannot make: ${unexpected.value.join(', ')}`);
    const src = await sourcesOf(ctx, a);
    const facts = regateFacts(src.decision, src.sources);
    if (!facts.ok) throw new IntegrityError(facts.error);
    const path = attemptPath(a, REGATE_FILE);
    const generation = judgeGeneration(ctx, a, path);
    const record = (status: RegateStatus, extra: Partial<RegateRecord>): string =>
      ctx.files.writeJson(path, {
        round: a.round, decision_sha256: a.decisionSha256, d8: a.d8, status, trial_labels: [], facts: facts.value, mechanical: { ok: true, violations: [] }, judges: [],
        attempts: generation, ...extra,
      });
    const trial = trialDonors(tallyTrials(ctx), src.decision);
    if (trial.length > 0) {
      ctx.progress('10a-regate', 'info', `trial pair: ${trial.join(',')}`);
      return rewind(ctx, a, record('trial', { trial_labels: trial }), `trial_pair:${a.d8}`);
    }
    // A decision no plan can merge (malformed 07 cell, donor quote no sentence carries, …) goes back to the owner
    // here: otherwise 10b fails on every rerun and nothing supersedes the decision.
    const unmergeable = mergeability(src, ctx.protocol.fixtureRxx.claim);
    if (unmergeable.length > 0) {
      ctx.progress('10a-regate', 'error', `decision cannot be merged: ${unmergeable.join('; ')}`);
      return rewind(ctx, a, record('fail', { mechanical: { ok: false, violations: unmergeable } }), `regate_failed:${a.d8}`);
    }
    if (!needsRegate(src.decision)) return { kind: 'skip', reason: 'every registered fact is from the base' };
    const violations = regateMechanical(facts.value, {
      rowIds: src.rowIds, statuses: FACT_STATUSES, properNouns: mergeProperNouns(ctx, src), fixtureClaim: ctx.protocol.fixtureRxx.claim,
    });
    const mechanical = { ok: violations.length === 0, violations };
    if (!mechanical.ok) return rewind(ctx, a, record('fail', { mechanical }), `regate_failed:${a.d8}`);
    const order = gateOrder(ctx, src.decision, `regate:${a.d8}`);
    if (order.length < 2) return rewind(ctx, a, record('fail', { mechanical: { ok: false, violations: [POOL_TOO_SMALL] } }), `regate_failed:${a.d8}`);
    const gate = await judgeMergeGate(ctx, regatePack(facts.value, readBriefJson(ctx)), order, (f, n) => generationId(regateTaskId(a.d8, f, n), generation));
    const status: RegateStatus = gate.outcome;
    const rel = record(status, { mechanical, judges: gate.judges });
    ctx.progress('10a-regate', status === 'pass' ? 'info' : 'error', `regate ${status}`);
    if (status === 'fail' || status === 'split') return rewind(ctx, a, rel, `regate_failed:${a.d8}`);
    if (status === 'unverified') return failed(`10a-regate: fewer than two valid judge verdicts (${gate.judges.length} calls, attempt ${generation}); a rerun calls afresh`);
    return { kind: 'done', inputs: [...baseInputs(ctx, a), ctx.files.rel(join(ctx.paths.dir, 'tally.json')), ctx.files.rel(ctx.paths.freeze)], outputs: [rel], external: [] };
  },
};

/** plan.json / edit.json as 10b writes them. */
interface EditFile {
  editor: 'llm' | 'fallback';
  task: string;
  title: string;
  edit: CanonEdit;
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') return null;
    out[k] = v;
  }
  return out;
}

function readEditFile(ctx: StepContext, a: MergeAttempt): { rel: string; value: EditFile } {
  const path = attemptPath(a, EDIT_FILE);
  const rel = ctx.files.rel(path);
  const raw = readJson(path);
  const edit = isRecord(raw) ? raw['edit'] : null;
  const files = isRecord(edit) ? stringRecord(edit['files']) : null;
  const scene = readString(edit, 'scene');
  const rxx = isRecord(edit) ? stringArray(edit['rxx']) : null;
  const editor = readString(raw, 'editor');
  const task = readString(raw, 'task');
  const title = readString(raw, 'title');
  if (files === null || scene === null || rxx === null || task === null || title === null || (editor !== 'llm' && editor !== 'fallback')) {
    throw new IntegrityError(`${rel} is missing or malformed`);
  }
  return { rel, value: { editor, task, title, edit: { files, scene, rxx } } };
}

/** 10b: editor task (`merge-<d8>`) → plan.json + edit.json (`editor: llm | fallback`). */
export const mergeEditStep: StepDef = {
  id: '10b-merge-edit',
  run: async (ctx) => {
    const a = attemptOf(ctx);
    if (a === null) return { kind: 'skip', reason: PICK_NONE };
    const src = await sourcesOf(ctx, a);
    const spec = mergeEditorTask(src, mergeEditorTaskId(a.d8), ctx.seed());
    const r = await runTask(ctx, ctx.backends.mergeEditor, spec);
    let result: EditorResult;
    let editor: EditFile['editor'] = 'llm';
    if (r.value !== null) {
      result = r.value;
    } else {
      const plan = fallbackPlan(src);
      const edit = renderMerge(plan, src);
      const violations = renderedViolations(plan, edit, src);
      if (violations.length > 0) return failed(`10b-merge-edit: the editor voided and the fallback plan fails mergecheck: ${violations.join('; ')}`);
      result = { plan, edit };
      editor = 'fallback';
      ctx.progress('10b-merge-edit', 'error', `editor void (${r.error ?? 'void'}); fallback plan used`);
    }
    const plan = ctx.files.writeJson(attemptPath(a, PLAN_FILE), { plan: result.plan, task: spec.id, attempts: r.attempts, editor });
    const edit = ctx.files.writeJson(attemptPath(a, EDIT_FILE), { editor, task: spec.id, title: result.plan.title, edit: result.edit });
    return { kind: 'done', inputs: baseInputs(ctx, a), outputs: [plan, edit], external: [] };
  },
};

/** 10c: restore from base_sha, applyCanonEditChecked, apply.json + mergecheck.json; any failed check → failed (5). */
export const applyStep: StepDef = {
  id: '10c-apply',
  run: async (ctx) => {
    const a = attemptOf(ctx);
    if (a === null) return { kind: 'skip', reason: PICK_NONE };
    const edit = readEditFile(ctx, a);
    const src = await sourcesOf(ctx, a);
    const applied = await applyCanonEditChecked(ctx, a, edit.value.edit, { ...src.decision, title: edit.value.title });
    if (!applied.ok) return blocked(`10c-apply: ${applied.error}`);
    const outputs = [ctx.files.writeJson(attemptPath(a, APPLY_FILE), applied.value.record)];
    if (applied.value.mergecheck !== null) outputs.push(ctx.files.writeJson(attemptPath(a, MERGECHECK_FILE), applied.value.mergecheck));
    const r = applied.value.record;
    if (r.status === 'failed') return failed(`10c-apply: restored world/current from base_sha after a failed check: ${r.reasons.join('; ')}`);
    ctx.progress('10c-apply', 'info', `reference ${r.revision}: ${Object.keys(r.written).length} file(s) written, ${r.changed.length} changed`);
    return { kind: 'done', inputs: [edit.rel], outputs, external: [] };
  },
};

/** apply.json's `written` byte hashes (10c's writes and the assembler outputs) still on disk (a hand edit between steps is drift, not a new merge). */
function appliedDrift(ctx: StepContext, a: MergeAttempt): { rel: string; revision: string; written: string[]; drift: string[] } {
  const path = attemptPath(a, APPLY_FILE);
  const rel = ctx.files.rel(path);
  const raw = readJson(path);
  const written = isRecord(raw) ? stringRecord(raw['written']) : null;
  const revision = readString(raw, 'revision');
  if (written === null || revision === null || readString(raw, 'status') !== 'applied') throw new IntegrityError(`${rel} is missing, malformed or not applied`);
  const drift = Object.entries(written).flatMap(([p, h]) => {
    const abs = join(ctx.repo, CANON_DIR, p);
    return existsSync(abs) && sha256Bytes(readFileSync(abs)) === h ? [] : [p];
  });
  return { rel, revision, written: Object.keys(written), drift };
}

/** 10d: post-merge.json (buildPostMerge); protocolGate first (WAIT protocol_approval). */
export const postMergeFreezeStep: StepDef = {
  id: '10d-post-merge-freeze',
  run: async (ctx) => {
    const a = attemptOf(ctx);
    if (a === null) return { kind: 'skip', reason: PICK_NONE };
    const gate = protocolGate(ctx);
    if (gate !== null) return gate;
    const edit = readEditFile(ctx, a);
    const applied = appliedDrift(ctx, a);
    if (applied.drift.length > 0) return failed(`10d-post-merge-freeze: world/current changed since 10c: ${applied.drift.join(', ')}`);
    // `written` lists the assembler outputs too: 10d allows exactly the canon paths apply.json hashes.
    const stray = await strayCanon(ctx, a.baseSha, new Set(applied.written));
    if (!stray.ok) return blocked(`10d-post-merge-freeze: ${stray.error}`);
    if (stray.value.length > 0) return failed(`10d-post-merge-freeze: world/current has changes 10c did not write: ${stray.value.join(', ')}`);
    const manifest = buildPostMerge(ctx, edit.value.edit, a.decisionSha256);
    if (!manifest.ok) return failed(`10d-post-merge-freeze: ${manifest.error}`);
    const rel = ctx.files.writeText(attemptPath(a, POST_MERGE_FILE), canonicalJson(manifest.value));
    return { kind: 'done', inputs: [edit.rel, applied.rel], outputs: [rel], external: [] };
  },
};

/** 10e: text checks + 2 gate judges (`postmerge-<d8>-<family>-<n>`); fail → restore + rewind; split continues; unverified → failed. */
export const postMergeGateStep: StepDef = {
  id: '10e-post-merge-gate',
  run: async (ctx) => {
    const a = attemptOf(ctx);
    if (a === null) return { kind: 'skip', reason: PICK_NONE };
    const edit = readEditFile(ctx, a).value.edit;
    const src = await sourcesOf(ctx, a);
    const quotes = src.decision.registered.flatMap((r) => src.sources.find((s) => s.label === r.label)?.facts.find((f) => f.id === r.factId)?.sourceQuote ?? []);
    const violations = postMergeMechanical(edit.scene, ctx.protocol, quotes);
    const mechanical = { ok: violations.length === 0, violations };
    const path = attemptPath(a, POSTMERGE_GATE_FILE);
    const generation = judgeGeneration(ctx, a, path);
    const write = (status: PostMergeGateRecord['status'], judges: MergeJudge[], checks: PostMergeGateRecord['mechanical']): string =>
      ctx.files.writeJson(path, { round: a.round, decision_sha256: a.decisionSha256, d8: a.d8, status, scene_sha256: sha256(edit.scene), mechanical: checks, judges, attempts: generation });
    if (!mechanical.ok) return rewind(ctx, a, write('fail', [], mechanical), `postmerge_failed:${a.d8}`);
    const order = gateOrder(ctx, src.decision, `postmerge:${a.d8}`);
    if (order.length < 2) return rewind(ctx, a, write('fail', [], { ok: false, violations: [POOL_TOO_SMALL] }), `postmerge_failed:${a.d8}`);
    const pack = postMergePack(edit.scene, readBriefJson(ctx), edit.rxx);
    const gate = await judgeMergeGate(ctx, pack, order, (f, n) => generationId(postmergeTaskId(a.d8, f, n), generation));
    const rel = write(gate.outcome, gate.judges, mechanical);
    ctx.progress('10e-post-merge-gate', gate.outcome === 'pass' ? 'info' : 'error', `post-merge gate ${gate.outcome}`);
    if (gate.outcome === 'fail') return rewind(ctx, a, rel, `postmerge_failed:${a.d8}`);
    if (gate.outcome === 'unverified') return failed(`10e-post-merge-gate: fewer than two valid judge verdicts (${gate.judges.length} calls, attempt ${generation}); a rerun calls afresh`);
    return { kind: 'done', inputs: [ctx.files.rel(attemptPath(a, EDIT_FILE)), ctx.files.rel(ctx.paths.brief)], outputs: [rel], external: [] };
  },
};

/** postmerge-gate.json status (10e marked it pass or split). */
function postGateStatus(ctx: StepContext, a: MergeAttempt): PostMergeGateRecord['status'] {
  const path = attemptPath(a, POSTMERGE_GATE_FILE);
  const status = readString(readJson(path), 'status');
  if (status !== 'pass' && status !== 'split') throw new IntegrityError(`${ctx.files.rel(path)} is missing or not pass / split`);
  return status;
}

/** 10f: commit changed world/current paths + rounds/RNN/merge/ + merge.json, push (failure → blocked). */
export const mergeCommitStep: StepDef = {
  id: '10f-commit',
  run: async (ctx) => {
    const a = attemptOf(ctx);
    if (a === null) return { kind: 'skip', reason: PICK_NONE };
    const pinned = readPostMerge(ctx.paths, a.d8);
    if (pinned === null || !pinned.ok) throw new IntegrityError(`rounds/${a.round}/merge/${a.d8}/${POST_MERGE_FILE} is missing or malformed`);
    const drift = checkPostMerge(ctx, pinned.value);
    if (drift.length > 0) return failed(`10f-commit: world/current drifted from post-merge.json: ${drift.join('; ')}`);
    // Every changed canon path must be one post-merge.json pins: a hand edit or a new file after 10c is never committed.
    const stray = await strayCanon(ctx, a.baseSha, new Set(Object.keys(pinned.value.files)));
    if (!stray.ok) return blocked(`10f-commit: ${stray.error}`);
    if (stray.value.length > 0) return failed(`10f-commit: world/current has changes post-merge.json does not pin: ${stray.value.join(', ')}`);
    const branch = await ensureRoundBranch(ctx);
    if (branch !== null) return blocked(`10f-commit: ${branch}`);
    const changed = await ctx.ports.git.changedPaths(a.baseSha, [CANON_DIR]);
    if (!changed.ok) return blocked(`10f-commit: git: ${changed.error}`);
    const split = postGateStatus(ctx, a) === 'split';
    const pointer: MergePointer = {
      round: a.round, current: a.d8, decision_sha256: a.decisionSha256, status: 'merged_on_branch', revision: pinned.value.revision,
      reasons: split ? ['postmerge_split'] : [],
    };
    const pointerPath = join(ctx.paths.dir, MERGE_POINTER_FILE);
    const rel = ctx.files.writeJson(pointerPath, pointer);
    const start = ctx.start();
    const paths = [...changed.value, repoRel(ctx, ctx.paths.merge), repoRel(ctx, pointerPath)];
    const commit = await ctx.ports.git.commit(paths, mergeCommitMessage(a.round, pinned.value.revision, start.issue.number));
    if (!commit.ok) return blocked(`10f-commit: git commit: ${commit.error}`);
    const push = await ctx.ports.git.push(start.branch);
    if (!push.ok) return blocked(`10f-commit: git push ${start.branch}: ${push.error}`);
    ctx.progress('10f-commit', 'info', `${commit.value === null ? 'already committed' : `committed ${commit.value.slice(0, 12)}`}; pushed ${start.branch}`);
    return { kind: 'done', inputs: [ctx.files.rel(attemptPath(a, POST_MERGE_FILE))], outputs: [rel], external: [] };
  },
};
