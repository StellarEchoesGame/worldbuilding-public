import { join } from 'node:path';
import type { StepContext } from '../context.ts';
import { isRecord, type JsonRecord } from '../json.ts';
import type { FixtureRxx } from '../protocol.ts';
import { err, ok, type Result } from '../result.ts';
import type { StepDef } from '../runner.ts';
import { sha256 } from '../store.ts';
import { displayText, loadSubmission } from '../submission.ts';
import { IntegrityError, runTask } from '../task.ts';
import { applyDefect, defectTargets, defectTask, fixtureRxxRow, pickDefectSubmission, pickDefectType, targetIds } from '../tasks/defect.ts';
import type { Span } from '../tasks/fenced.ts';
import { defectTaskId } from '../tasks/ids.ts';
import { readBriefJson, type BriefJson, type FactRow } from './brief.ts';
import { readMechanicalFile, readRoundJson } from './gate-mech.ts';
import { roundNumber } from './write.ts';

/** `rounds/RNN/gate/defect.json`, written by 05b (the only defect record of the round). */
export interface DefectFile {
  round: string;
  /** ok = copy made; void = the defect call voided (that submission's gate carries `defect_unverified`); none = no gate-bound submission or no enabled type. */
  status: 'ok' | 'void' | 'none';
  /** D1…D4 (seeded, key `defect:<round>`); null when none. */
  type: string | null;
  /** The seeded gate-bound submission (key `defectsub:<round>`); null when none. */
  submission: string | null;
  /** `defect-<submission>`; null when none. */
  task: string | null;
  against: string | null;
  sentence_no: number | null;
  original: string | null;
  /** The replacement sentence. */
  injected: string | null;
  /** normalizeForQuote(copy) coordinates. */
  injected_span: Span | null;
  /** Full display text of the copy (sent only to that submission's gate judges). */
  copy: string | null;
  copy_sha256: string | null;
  /** Redacted ASCII error of a void call, else null. */
  error: string | null;
}

function strOrNull(rec: JsonRecord, key: string): Result<string | null> {
  const v = rec[key];
  if (v === null) return ok(null);
  return typeof v === 'string' ? ok(v) : err(`${key}: expected a string or null`);
}

/** fixture-rxx when this is a round-0 drill (round number 00), else null. */
export function drillFixture(ctx: StepContext): FixtureRxx | null {
  const n = roundNumber(ctx.roundId);
  return n.ok && n.value === 0 ? ctx.protocol.fixtureRxx : null;
}

/** The gate's fact rows: the brief's facts (07 §2 ⋈ fact-status + Rxx), plus fixture-rxx in a round-0 drill. */
export function gateFacts(brief: Pick<BriefJson, 'facts'>, fixture: FixtureRxx | null): FactRow[] {
  const rows = [...brief.facts];
  if (fixture !== null && !rows.some((r) => r.id === fixture.rxx)) rows.push(fixtureRxxRow(fixture));
  return rows;
}

function parseSpan(value: unknown): Result<Span | null> {
  if (value === null) return ok(null);
  if (!isRecord(value)) return err('injected_span: expected an object or null');
  const { start, end } = value;
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    return err('injected_span: expected integer start <= end');
  }
  return ok({ start, end });
}

function parseDefectFile(value: unknown): Result<DefectFile> {
  if (!isRecord(value)) return err('not an object');
  const status = value['status'];
  if (status !== 'ok' && status !== 'void' && status !== 'none') return err('status: expected ok, void or none');
  const round = value['round'];
  if (typeof round !== 'string') return err('round: expected a string');
  const no = value['sentence_no'];
  if (no !== null && (typeof no !== 'number' || !Number.isInteger(no))) return err('sentence_no: expected an integer or null');
  const span = parseSpan(value['injected_span']);
  if (!span.ok) return err(span.error);
  const keys = ['type', 'submission', 'task', 'against', 'original', 'injected', 'copy', 'copy_sha256', 'error'];
  const s: Record<string, string | null> = {};
  for (const key of keys) {
    const v = strOrNull(value, key);
    if (!v.ok) return err(v.error);
    s[key] = v.value;
  }
  const get = (key: string): string | null => s[key] ?? null;
  const file: DefectFile = {
    round, status, type: get('type'), submission: get('submission'), task: get('task'), against: get('against'), sentence_no: no,
    original: get('original'), injected: get('injected'), injected_span: span.value, copy: get('copy'), copy_sha256: get('copy_sha256'),
    error: get('error'),
  };
  if (status === 'ok' && (file.copy === null || file.injected_span === null || file.submission === null)) return err('status ok without copy, span or submission');
  if (status === 'void' && file.submission === null) return err('status void without submission');
  return ok(file);
}

/** `gate/defect.json` of this round, parsed; err when missing or malformed. */
export function readDefectFile(ctx: StepContext): Result<DefectFile> {
  const path = join(ctx.paths.gate, 'defect.json');
  const raw = readRoundJson(ctx, path);
  if (!raw.ok) return err(raw.error);
  const parsed = parseDefectFile(raw.value);
  return parsed.ok ? parsed : err(`${ctx.files.rel(path)}: ${parsed.error}`);
}

function emptyDefect(round: string): DefectFile {
  return {
    round, status: 'none', type: null, submission: null, task: null, against: null, sentence_no: null, original: null, injected: null,
    injected_span: null, copy: null, copy_sha256: null, error: null,
  };
}

/**
 * 05b-defect: gate-bound = submissions whose `gate/mechanical.json` status is pass; one seeded type and one copy
 * per round, of one seeded gate-bound submission (PROTOCOL §2 literal); D1 never targets 状态与路径实例 F-IDs, D4
 * targets a brief Rxx (fixture-rxx in a round-0 drill). Only types that offer a target this round are enabled.
 * Paid ×1 on ctx.backends.defect. Void → status void (never a failed step). Outputs: `gate/defect.json`. Inputs:
 * `gate/mechanical.json`, `brief.json`, the chosen submission file.
 */
export const defectStep: StepDef = {
  id: '05b-defect',
  run: async (ctx) => {
    const mech = readMechanicalFile(ctx);
    if (!mech.ok) throw new IntegrityError(mech.error);
    const brief = readBriefJson(ctx);
    const seed = ctx.seed();
    const fixture = drillFixture(ctx);
    const gateBound = Object.entries(mech.value.submissions).filter(([, e]) => e.status === 'pass').map(([id]) => id);
    const usable = ctx.protocol.defectTypes.filter((t) => targetIds(defectTargets(t, brief, fixture)).length > 0);
    const type = pickDefectType(usable, brief, seed, ctx.roundId, fixture !== null);
    const sub = pickDefectSubmission(gateBound, seed, ctx.roundId);
    const inputs = [ctx.files.rel(join(ctx.paths.gate, 'mechanical.json')), ctx.files.rel(ctx.paths.brief)];
    const out = join(ctx.paths.gate, 'defect.json');
    if (type === null || sub === null) {
      const file = ctx.files.writeJson(out, emptyDefect(ctx.roundId));
      ctx.progress('05b-defect', 'info', type === null ? 'no enabled defect type' : 'no gate-bound submission');
      return { kind: 'done', inputs, outputs: [file], external: [] };
    }
    const loaded = loadSubmission(ctx.paths, sub);
    const subPath = join(ctx.paths.submissions, `${sub}.json`);
    if (loaded === null || loaded.output === null) throw new IntegrityError(`${ctx.files.rel(subPath)} passed the mechanical gate but does not load`);
    inputs.push(ctx.files.rel(subPath));
    const display = displayText(loaded.output);
    const spec = defectTask(display, type, defectTargets(type, brief, fixture), defectTaskId(sub), seed);
    const r = await runTask(ctx, ctx.backends.defect, spec);
    const base = { ...emptyDefect(ctx.roundId), type: type.id, submission: sub, task: spec.id };
    let record: DefectFile;
    if (r.value === null) {
      record = { ...base, status: 'void', error: ctx.redact(r.error ?? 'void') };
    } else {
      const d = applyDefect(display, r.value, { submission: sub, type: type.id });
      record = {
        ...base, status: 'ok', against: d.against, sentence_no: r.value.sentenceNo, original: r.value.original, injected: d.injected,
        injected_span: d.injectedSpan, copy: d.copy, copy_sha256: sha256(d.copy),
      };
    }
    const file = ctx.files.writeJson(out, record);
    ctx.progress('05b-defect', record.status === 'ok' ? 'info' : 'error', `${type.id} on ${sub}: ${record.status}`);
    return { kind: 'done', inputs, outputs: [file], external: [] };
  },
};
