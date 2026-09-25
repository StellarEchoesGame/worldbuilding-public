import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StepContext } from './context.ts';
import { isRecord, readBoolean, readRecord, readString, stringArray } from './json.ts';
import { sha256Bytes } from './marker.ts';
import { APPLY_FILE, CANON_DIR, EDIT_FILE, mergeAttempt, MERGECHECK_FILE, PLAN_FILE, POSTMERGE_GATE_FILE, readMergePointer, type MergePointer } from './merge.ts';
import { APPROVAL_DIFF_COMMAND } from './ports-cli.ts';
import { checkPostMerge, POST_MERGE_FILE, readPostMerge } from './postmerge.ts';
import { err, ok, type Result } from './result.ts';
import type { StepDef } from './runner.ts';
import { readUnsealFile } from './steps/surprise.ts';
import { readJson } from './store.ts';
import { IntegrityError } from './task.ts';
import { RECHECK_FILE, THINMAP_DELTA_FILE } from './bookkeeping.ts';

/**
 * Step 12 preparation (plan §4 rows 41–42, §8, s5 §7; PR-D group D4; registered by PR-E). 12a writes the approval
 * diff, final.json and an English pr-body.md draft; 12b waits for the owner's `diff_approved`. The engine never opens
 * the PR (a Claude Code session does, after approval).
 */

export const APPROVAL_DIFF_FILE = 'approval.diff';
export const FINAL_FILE = 'final.json';
export const PR_BODY_FILE = 'pr-body.md';

/** `rounds/RNN/final.json` (the UI 定稿 page and owner-sim approveDiff read `approval_diff_sha256`). */
export interface FinalJson {
  round: string;
  status: 'merged_on_branch' | 'no_merge';
  /** null when no_merge. */
  revision: string | null;
  rxx: string[];
  /** SHA-256 of approval.diff bytes (empty diff when no_merge, still approved). */
  approval_diff_sha256: string;
  mergecheck: { ok: boolean; violations: string[] } | null;
  book_sha256_unchanged: boolean;
  reference_book_sha256: string | null;
  /** checkPostMerge against the pinned post-merge.json; [] when clean or no_merge. */
  post_merge_check: string[];
  /** postmerge-gate.json status was split (shown on the 定稿 page). */
  postmerge_split: boolean;
  editor: 'llm' | 'fallback' | null;
  /** thinmap-delta.json; `snapshot: 'missing'` when map/snapshot-r0.json did not exist yet (F1-05), so `all_targets_above` is not a measurement. */
  thinmap: { all_targets_above: boolean; snapshot: 'present' | 'missing' } | null;
  /** PR-E (11g–11j); null until then. */
  maintainer: { outcome: string; version: string | null; evidence_ids: string[] } | null;
  unseal: { status: 'valid' | 'invalid'; remote: 'verified' | 'unavailable' | 'mismatch' };
}

const HEX64 = /^[0-9a-f]{64}$/u;
const REMOTES: ReadonlyArray<FinalJson['unseal']['remote']> = ['verified', 'unavailable', 'mismatch'];

/** `git.diff(baseSha, ['world/current'])` (canonical options, ports-cli APPROVAL_DIFF_COMMAND) and the SHA-256 of its bytes. */
export async function approvalDiff(ctx: StepContext, baseSha: string): Promise<Result<{ text: string; sha256: string }>> {
  const diff = await ctx.ports.git.diff(baseSha, [CANON_DIR]);
  if (!diff.ok) return err(`git diff ${baseSha.slice(0, 12)} -- ${CANON_DIR}: ${diff.error}`);
  return ok({ text: diff.value, sha256: sha256Bytes(Buffer.from(diff.value, 'utf8')) });
}

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function parseMergecheckField(value: unknown): Result<FinalJson['mergecheck']> {
  if (value === null) return ok(null);
  const passed = readBoolean(value, 'ok');
  const violations = stringArray(isRecord(value) ? value['violations'] : null);
  return passed === null || violations === null ? err('final.json: mergecheck must be null or {ok, violations}') : ok({ ok: passed, violations });
}

function parseMaintainer(value: unknown): Result<FinalJson['maintainer']> {
  if (value === null) return ok(null);
  const outcome = readString(value, 'outcome');
  const version = isRecord(value) ? value['version'] : undefined;
  const ids = stringArray(isRecord(value) ? value['evidence_ids'] : null);
  if (outcome === null || !nullableString(version) || ids === null) return err('final.json: maintainer must be null or {outcome, version, evidence_ids}');
  return ok({ outcome, version, evidence_ids: ids });
}

function parseUnseal(value: unknown): Result<FinalJson['unseal']> {
  const status = readString(value, 'status');
  const remote = REMOTES.find((r) => isRecord(value) && r === value['remote']);
  if ((status !== 'valid' && status !== 'invalid') || remote === undefined) return err('final.json: unseal must be {status: valid|invalid, remote}');
  return ok({ status, remote });
}

function parseThinmap(value: unknown): Result<FinalJson['thinmap']> {
  if (value === null) return ok(null);
  const above = readBoolean(value, 'all_targets_above');
  const snapshot = readString(value, 'snapshot');
  if (above === null || (snapshot !== 'present' && snapshot !== 'missing')) return err('final.json: thinmap must be null or {all_targets_above, snapshot: present | missing}');
  return ok({ all_targets_above: above, snapshot });
}

export function parseFinal(value: unknown): Result<FinalJson> {
  if (!isRecord(value)) return err('final.json: not an object');
  const { round, status, revision, approval_diff_sha256: diffSha, book_sha256_unchanged: bookSame, reference_book_sha256: refSha, postmerge_split: split, editor } = value;
  const rxx = stringArray(value['rxx']);
  const drift = stringArray(value['post_merge_check']);
  if (typeof round !== 'string' || (status !== 'merged_on_branch' && status !== 'no_merge')) return err('final.json: round and status (merged_on_branch | no_merge) are required');
  if (!nullableString(revision) || rxx === null || drift === null) return err('final.json: revision, rxx and post_merge_check are required');
  if (!isHex64(diffSha)) return err('final.json: approval_diff_sha256 must be a SHA-256');
  if (typeof bookSame !== 'boolean' || typeof split !== 'boolean') return err('final.json: book_sha256_unchanged and postmerge_split must be booleans');
  if (refSha !== null && !isHex64(refSha)) return err('final.json: reference_book_sha256 must be null or a SHA-256');
  if (editor !== null && editor !== 'llm' && editor !== 'fallback') return err('final.json: editor must be llm, fallback or null');
  const mergecheck = parseMergecheckField(value['mergecheck'] ?? null);
  if (!mergecheck.ok) return mergecheck;
  const thinmap = parseThinmap(value['thinmap'] ?? null);
  if (!thinmap.ok) return thinmap;
  const maintainer = parseMaintainer(value['maintainer'] ?? null);
  if (!maintainer.ok) return maintainer;
  const unseal = parseUnseal(value['unseal']);
  if (!unseal.ok) return unseal;
  return ok({
    round, status, revision, rxx, approval_diff_sha256: diffSha, mergecheck: mergecheck.value, book_sha256_unchanged: bookSame, reference_book_sha256: refSha,
    post_merge_check: drift, postmerge_split: split, editor, thinmap: thinmap.value, maintainer: maintainer.value, unseal: unseal.value,
  });
}

function thinmapLine(thinmap: FinalJson['thinmap']): string {
  if (thinmap === null) return 'not measured';
  if (thinmap.snapshot === 'missing') return 'round-0 snapshot missing (F1-05): not measured';
  return `every target cell above the round-0 snapshot: ${yesNo(thinmap.all_targets_above)}`;
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function code(text: string): string {
  return `\`${text}\``;
}

/** English PR body: summary, reviewer checklist with evidence paths / hashes, `Closes`-free (the session links the issue). */
export function prBody(final: FinalJson, issue: number, evidence: readonly string[]): string {
  const r = final.round;
  const merged = final.status === 'merged_on_branch';
  const summary = merged
    ? `Round ${r} (#${issue}) merges one sample scene into the reference, revision ${final.revision ?? '?'}: ${final.rxx.length === 0 ? 'no registered facts' : final.rxx.join(', ')}.`
    : `Round ${r} (#${issue}) ends without a merge (the owner picked none); only round records and shared bookkeeping files change.`;
  const mc = final.mergecheck;
  const checklist = [
    `- [ ] Approval diff SHA-256 ${code(final.approval_diff_sha256)} equals \`sha256sum world/forge/rounds/${r}/${APPROVAL_DIFF_FILE}\` and the SHA-256 of ${code(APPROVAL_DIFF_COMMAND)} on the PR head (pinned options: the bytes do not depend on local git config).`,
    `- [ ] Owner approved exactly that diff (owner-log \`diff_approved\` entry for ${r} with this SHA-256).`,
    `- [ ] mergecheck: ${mc === null ? 'not run (no merge)' : mc.ok ? 'passed' : `failed (${mc.violations.join('; ')})`}.`,
    `- [ ] BOOK.md unchanged against the base: ${yesNo(final.book_sha256_unchanged)}.`,
    `- [ ] REFERENCE.md SHA-256 (hashes.json reference_book_sha256): ${final.reference_book_sha256 === null ? 'n/a' : code(final.reference_book_sha256)}; rerun the assembler for revision ${final.revision ?? 'n/a'} and compare.`,
    `- [ ] Post-merge pins: ${final.post_merge_check.length === 0 ? 'clean' : final.post_merge_check.join('; ')} (\`forge freeze --post-merge ${r} --check\`).`,
    `- [ ] Post-merge gate split: ${yesNo(final.postmerge_split)}; merge editor: ${final.editor ?? 'n/a'}${final.editor === 'fallback' ? ' (deterministic fallback plan: read the scene closely)' : ''}.`,
    `- [ ] Unseal: ${final.unseal.status}, remote probe ${final.unseal.remote}.`,
    `- [ ] Thin map: ${thinmapLine(final.thinmap)}.`,
    `- [ ] Benchmark maintainer: ${final.maintainer === null ? 'not in this build' : `${final.maintainer.outcome}${final.maintainer.version === null ? '' : ` (${final.maintainer.version})`}`}.`,
    `- [ ] Marker hash chain verifies: \`forge round status ${r} --verify\`.`,
  ];
  return [
    `## Summary`, '', summary, '',
    `## Reviewer checklist`, '', ...checklist, '',
    `## Evidence`, '', ...(evidence.length === 0 ? ['- (none)'] : evidence.map((e) => `- ${e}`)), '',
  ].join('\n');
}

function roundJson(ctx: StepContext, rel: string): unknown {
  const path = join(ctx.paths.dir, rel);
  if (!existsSync(path)) throw new IntegrityError(`rounds/${ctx.roundId}/${rel} is missing`);
  return readJson(path);
}

/** What 12a reads from the committed attempt `merge/<current>/`. */
interface MergedEvidence {
  pointer: MergePointer;
  mergecheck: FinalJson['mergecheck'];
  editor: 'llm' | 'fallback';
  rxx: string[];
  postMergeCheck: string[];
  split: boolean;
  referenceBookSha256: string | null;
  files: string[];
}

function mergedEvidence(ctx: StepContext): MergedEvidence | null {
  const read = readMergePointer(ctx.paths);
  if (read === null) return null;
  if (!read.ok) throw new IntegrityError(read.error);
  const pointer = read.value;
  // the pointer must name an attempt of the 09b-pinned decision, not one of a superseded decision
  const pinnedSha = mergeAttempt(ctx).decisionSha256;
  if (pointer.decision_sha256 !== pinnedSha) {
    throw new IntegrityError(`rounds/${ctx.roundId}/merge.json belongs to decision ${pointer.decision_sha256.slice(0, 8)}, not the pinned ${pinnedSha.slice(0, 8)}`);
  }
  const at = (file: string): string => `merge/${pointer.current}/${file}`;
  const mergecheck = parseMergecheckField(roundJson(ctx, at(MERGECHECK_FILE)));
  if (!mergecheck.ok) throw new IntegrityError(`rounds/${ctx.roundId}/${at(MERGECHECK_FILE)}: not {ok, violations}`);
  const editor = readString(roundJson(ctx, at(PLAN_FILE)), 'editor');
  if (editor !== 'llm' && editor !== 'fallback') throw new IntegrityError(`rounds/${ctx.roundId}/${at(PLAN_FILE)}: editor must be llm or fallback`);
  const edit = readRecord(roundJson(ctx, at(EDIT_FILE)), 'edit');
  const rxx = stringArray(isRecord(edit) ? edit['rxx'] : null);
  if (rxx === null) throw new IntegrityError(`rounds/${ctx.roundId}/${at(EDIT_FILE)}: edit.rxx is required`);
  const pinned = readPostMerge(ctx.paths, pointer.current);
  if (pinned === null || !pinned.ok) throw new IntegrityError(`rounds/${ctx.roundId}/${at(POST_MERGE_FILE)} is missing or malformed`);
  const gate = readString(roundJson(ctx, at(POSTMERGE_GATE_FILE)), 'status');
  const hashes = join(ctx.repo, CANON_DIR, 'reference', 'hashes.json');
  const reference = existsSync(hashes) ? readString(readJson(hashes), 'reference_book_sha256') : null;
  const files = [APPLY_FILE, MERGECHECK_FILE, PLAN_FILE, EDIT_FILE, POST_MERGE_FILE, POSTMERGE_GATE_FILE].map(at).filter((f) => existsSync(join(ctx.paths.dir, f)));
  return {
    pointer, mergecheck: mergecheck.value, editor, rxx, postMergeCheck: checkPostMerge(ctx, pinned.value),
    split: pointer.reasons.includes('postmerge_split') || gate === 'split', referenceBookSha256: reference !== null && HEX64.test(reference) ? reference : null, files,
  };
}

/** 07a status + remote (11a's recheck when it ran). */
function unsealOf(ctx: StepContext): FinalJson['unseal'] {
  const unseal = readUnsealFile(ctx);
  if (!unseal.ok) throw new IntegrityError(unseal.error);
  const recheck = readJson(join(ctx.paths.dir, RECHECK_FILE));
  const remote = REMOTES.find((r) => isRecord(recheck) && r === recheck['remote']) ?? unseal.value.remote;
  return { status: unseal.value.status, remote };
}

function thinmapOf(ctx: StepContext): FinalJson['thinmap'] {
  const path = join(ctx.paths.dir, THINMAP_DELTA_FILE);
  if (!existsSync(path)) return null;
  const delta = readJson(path);
  const above = readBoolean(delta, 'all_targets_above');
  const snapshot = readString(delta, 'snapshot');
  if (above === null || (snapshot !== 'present' && snapshot !== 'missing')) {
    throw new IntegrityError(`rounds/${ctx.roundId}/${THINMAP_DELTA_FILE}: all_targets_above must be a boolean and snapshot present | missing`);
  }
  return { all_targets_above: above, snapshot };
}

/** 1-based owner-log line of the latest `action` entry for this round (the reader keeps one entry per line). */
function ownerLogLine(ctx: StepContext, action: string): number | null {
  const entries = ctx.owner.entries();
  for (let i = entries.length - 1; i >= 0; i -= 1) if (entries[i]?.action === action && entries[i]?.round === ctx.roundId) return i + 1;
  return null;
}

/** The book at base vs on disk (a merge never touches BOOK.md). */
async function bookUnchanged(ctx: StepContext, baseSha: string): Promise<Result<boolean>> {
  const base = await ctx.ports.git.show(baseSha, `${CANON_DIR}/BOOK.md`);
  if (!base.ok) return err(`git show ${baseSha.slice(0, 12)}:${CANON_DIR}/BOOK.md: ${base.error}`);
  const path = join(ctx.repo, CANON_DIR, 'BOOK.md');
  const now = existsSync(path) ? readFileSync(path, 'utf8') : null;
  return ok(base.value !== null && now === base.value);
}

/**
 * 12a: approval.diff = git.diff(start.base_sha, ['world/current']) (empty for pick none), final.json from the committed
 * attempt (merge.json → merge/<d8>/), 07a / 11a unseal results and 11d's thin-map delta, and the English pr-body.md.
 * A git error is blocked (4); a missing or malformed round record is an integrity error.
 */
export const prepareFinalStep: StepDef = {
  id: '12a-prepare',
  run: async (ctx) => {
    const start = ctx.start();
    const decision = ctx.decision();
    const merged = mergedEvidence(ctx);
    if (merged === null && decision.pick !== 'none') throw new IntegrityError(`rounds/${ctx.roundId}/merge.json is missing although the decision picked ${decision.pick}`);
    const diff = await approvalDiff(ctx, start.base_sha);
    if (!diff.ok) return { kind: 'blocked', detail: `12a-prepare: ${diff.error}` };
    const book = await bookUnchanged(ctx, start.base_sha);
    if (!book.ok) return { kind: 'blocked', detail: `12a-prepare: ${book.error}` };
    const final: FinalJson = {
      round: ctx.roundId,
      status: merged === null ? 'no_merge' : 'merged_on_branch',
      revision: merged?.pointer.revision ?? null,
      rxx: merged?.rxx ?? [],
      approval_diff_sha256: diff.value.sha256,
      mergecheck: merged?.mergecheck ?? null,
      book_sha256_unchanged: book.value,
      reference_book_sha256: merged?.referenceBookSha256 ?? null,
      post_merge_check: merged?.postMergeCheck ?? [],
      postmerge_split: merged?.split ?? false,
      editor: merged?.editor ?? null,
      thinmap: thinmapOf(ctx),
      maintainer: null,
      unseal: unsealOf(ctx),
    };
    const dir = `rounds/${ctx.roundId}`;
    const actions: readonly string[] = ['audit', 'decision'];
    const lines = actions.flatMap((action) => {
      const line = ownerLogLine(ctx, action);
      return line === null ? [] : [`\`owner-log.jsonl\` line ${line}: ${action}`];
    });
    const recorded = ['merge.json', ...(merged?.files ?? []), 'unseal.json', RECHECK_FILE, THINMAP_DELTA_FILE].filter((f) => existsSync(join(ctx.paths.dir, f)));
    const evidence = [
      `\`${dir}/${APPROVAL_DIFF_FILE}\` (sha256 ${code(diff.value.sha256)})`,
      `\`${dir}/${FINAL_FILE}\``,
      `\`${decision.file}\` (the decision the 09b marker pins)`,
      ...recorded.map((f) => `\`${dir}/${f}\``),
      ...lines,
      `\`${dir}/markers/\` (marker hash chain)`,
    ];
    const outputs = [
      ctx.files.writeText(join(ctx.paths.dir, APPROVAL_DIFF_FILE), diff.value.text),
      ctx.files.writeJson(join(ctx.paths.dir, FINAL_FILE), final),
      ctx.files.writeText(join(ctx.paths.dir, PR_BODY_FILE), prBody(final, start.issue.number, evidence)),
    ];
    ctx.progress('12a-prepare', 'info', `${final.status}; approval diff ${diff.value.sha256.slice(0, 12)} (${diff.value.text.length} chars)`);
    return { kind: 'done', inputs: [decision.file], outputs, external: [] };
  },
};

/**
 * 12b: approval.diff must still match final.json and the diff recomputed from world/current now (a canon edit after 12a
 * is an integrity error even when the owner already approved the stale hash; a git error is blocked); then
 * owner.diffApproved(round, final.approval_diff_sha256) → done, else WAIT diff_approval.
 */
export const diffApprovalStep: StepDef = {
  id: '12b-diff-approval',
  run: async (ctx) => {
    const finalPath = join(ctx.paths.dir, FINAL_FILE);
    const diffPath = join(ctx.paths.dir, APPROVAL_DIFF_FILE);
    const final = parseFinal(roundJson(ctx, FINAL_FILE));
    if (!final.ok) throw new IntegrityError(`rounds/${ctx.roundId}/${final.error}`);
    if (!existsSync(diffPath) || sha256Bytes(readFileSync(diffPath)) !== final.value.approval_diff_sha256) {
      throw new IntegrityError(`rounds/${ctx.roundId}/${APPROVAL_DIFF_FILE} does not match final.json approval_diff_sha256`);
    }
    const now = await approvalDiff(ctx, ctx.start().base_sha);
    if (!now.ok) return { kind: 'blocked', detail: `12b-diff-approval: ${now.error}` };
    if (now.value.sha256 !== final.value.approval_diff_sha256) {
      throw new IntegrityError(`world/current changed after 12a: the diff against base is ${now.value.sha256.slice(0, 12)}, rounds/${ctx.roundId}/${FINAL_FILE} approval_diff_sha256 is ${final.value.approval_diff_sha256.slice(0, 12)}`);
    }
    const inputs = [ctx.files.rel(finalPath), ctx.files.rel(diffPath)];
    const at = ctx.owner.diffApproved(ctx.roundId, final.value.approval_diff_sha256);
    if (at === null) return { kind: 'wait', waitingFor: 'diff_approval', detail: `定稿差异（${final.value.approval_diff_sha256.slice(0, 12)}）待 owner 在定稿页批准`, inputs, outputs: [] };
    return { kind: 'done', inputs, outputs: [], external: [] };
  },
};
