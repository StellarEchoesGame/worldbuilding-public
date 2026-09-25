import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFamily, type Family, type JudgeSpec } from './config.ts';
import type { FreezeFlag } from './freeze.ts';
import { isRecord, readArray, readBoolean, readNumber, readRecord, readString, type JsonRecord } from './json.ts';
import type { ProtocolCalibration } from './protocol.ts';
import { err, ok, type Result } from './result.ts';
import { loadSchema, validate, type Schema } from './schema.ts';

export type AgreementState = 'ok' | 'flagged' | 'suspended';

export interface FamilyAgreement {
  /** Set id after which audit labels count (C00, reset by a passed requal). */
  epoch: string;
  n: number;
  k: number;
  alpha: number;
  beta: number;
  mean: number;
  ci90: [number, number];
  /** P(θ < threshold). */
  p_below: number;
  state: AgreementState;
}

export interface FamilyTrust {
  qualified: boolean;
  qualified_by: string | null;
  requal_used: { calibration_fail: boolean; suspension: boolean };
  gate_judge: boolean;
  gate_by: string | null;
  agreement: FamilyAgreement;
  suspended_at: string | null;
}

/** `calibration/status.json` (schema/calib-status.schema.json); written only by trust.ts (PR-C). */
export interface TrustStatus {
  schema: 'trust-status/1';
  updated_after: string;
  labels_sha256: string;
  /** Keyed by family name. */
  families: Record<string, FamilyTrust>;
}

/** Freeze pins derived from the trust status (s4 §4.5 rules 4–6). */
export interface TrustPins {
  /** `ok` and canary-passing judge families (E pool before per-pair exclusions). */
  eligibleFamilies: Family[];
  /** Per judge family: suspended > unqualified > flagged > ok. */
  flags: Record<string, FreezeFlag>;
  /** gate_judge && !suspended && canary-passing. */
  gateFamilies: Family[];
}

/** Forge-root-relative trust status (written by trust.ts in PR-C). */
export const TRUST_STATUS = 'calibration/status.json';

/** Forge-root-relative canary results (`forge canary`, latest result per adapter). */
export const CANARY_RESULTS = 'canary/results.json';

/** PROTOCOL §9 信任状态: an R-round freeze needs at least this many qualified, unsuspended judge families. */
export const MIN_QUALIFIED_FAMILIES = 3;

const AGREEMENT_STATES: readonly AgreementState[] = ['ok', 'flagged', 'suspended'];

function isAgreementState(value: string): value is AgreementState {
  return AGREEMENT_STATES.some((s) => s === value);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

let cachedSchema: Schema | null = null;

/** The engine's copy of schema/calib-status.schema.json (module-relative, so temp forge roots need no schema dir). */
function statusSchema(): Schema {
  if (cachedSchema !== null) return cachedSchema;
  const raw: unknown = JSON.parse(readFileSync(fileURLToPath(new URL('../schema/calib-status.schema.json', import.meta.url)), 'utf8'));
  const schema = loadSchema(raw);
  if (!schema.ok) throw new Error(`schema/calib-status.schema.json: ${schema.error}`);
  cachedSchema = schema.value;
  return schema.value;
}

function narrowAgreement(value: JsonRecord | null): Result<FamilyAgreement> {
  const epoch = readString(value, 'epoch');
  const n = readNumber(value, 'n');
  const k = readNumber(value, 'k');
  const alpha = readNumber(value, 'alpha');
  const beta = readNumber(value, 'beta');
  const mean = readNumber(value, 'mean');
  const pBelow = readNumber(value, 'p_below');
  const state = readString(value, 'state');
  const ci = readArray(value, 'ci90') ?? [];
  const lo = ci[0];
  const hi = ci[1];
  if (epoch === null || n === null || k === null || alpha === null || beta === null || mean === null || pBelow === null || state === null || !isAgreementState(state) || typeof lo !== 'number' || typeof hi !== 'number') {
    return err('agreement: malformed');
  }
  if (k > n) return err('agreement: k exceeds n');
  if (alpha !== 1 + k || beta !== 1 + n - k) return err('agreement: alpha / beta must be 1 + k / 1 + n - k (Beta(1,1) prior)');
  if (Math.abs(mean - alpha / (alpha + beta)) > 1e-4) return err('agreement: mean is not alpha / (alpha + beta)');
  if (lo > hi) return err('agreement: ci90 is not ordered');
  return ok({ epoch, n, k, alpha, beta, mean, ci90: [lo, hi], p_below: pBelow, state });
}

function narrowFamily(value: unknown): Result<FamilyTrust> {
  const qualified = readBoolean(value, 'qualified');
  const gateJudge = readBoolean(value, 'gate_judge');
  const requal = readRecord(value, 'requal_used');
  const calibrationFail = readBoolean(requal, 'calibration_fail');
  const suspension = readBoolean(requal, 'suspension');
  if (qualified === null || gateJudge === null || calibrationFail === null || suspension === null) return err('malformed family entry');
  const agreement = narrowAgreement(readRecord(value, 'agreement'));
  if (!agreement.ok) return agreement;
  const trust: FamilyTrust = {
    qualified,
    qualified_by: readString(value, 'qualified_by'),
    requal_used: { calibration_fail: calibrationFail, suspension },
    gate_judge: gateJudge,
    gate_by: readString(value, 'gate_by'),
    agreement: agreement.value,
    suspended_at: readString(value, 'suspended_at'),
  };
  if (trust.qualified && trust.qualified_by === null) return err('qualified needs qualified_by');
  if (trust.gate_judge && trust.gate_by === null) return err('gate_judge needs gate_by');
  if (trust.agreement.state === 'suspended' && trust.suspended_at === null) return err('a suspended family needs suspended_at');
  return ok(trust);
}

/** Shape plus schema/calib-status.schema.json validation. */
export function parseTrustStatus(value: unknown): Result<TrustStatus> {
  const errors = validate(statusSchema(), value);
  if (errors.length > 0) return err(errors.join('; '));
  const updatedAfter = readString(value, 'updated_after');
  const labels = readString(value, 'labels_sha256');
  if (readString(value, 'schema') !== 'trust-status/1' || updatedAfter === null || labels === null) return err('malformed trust status');
  const families: Record<string, FamilyTrust> = {};
  for (const [name, entry] of Object.entries(readRecord(value, 'families') ?? {})) {
    if (!isFamily(name)) return err(`families: unknown family ${name}`);
    const trust = narrowFamily(entry);
    if (!trust.ok) return err(`families.${name}: ${trust.error}`);
    families[name] = trust.value;
  }
  return ok({ schema: 'trust-status/1', updated_after: updatedAfter, labels_sha256: labels, families });
}

/** null when calibration/status.json is absent. */
export function readTrustStatus(root: string): Result<TrustStatus> | null {
  const path = join(root, TRUST_STATUS);
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return err(`${TRUST_STATUS}: ${message(e).split(path).join(TRUST_STATUS)}`);
  }
  const parsed = parseTrustStatus(value);
  return parsed.ok ? parsed : err(`${TRUST_STATUS}: ${parsed.error}`);
}

/** Judge ids (JudgeSpec.id) whose latest entry in canary/results.json failed; missing file → empty set. */
export function readCanaryFailed(root: string): Result<ReadonlySet<string>> {
  const path = join(root, CANARY_RESULTS);
  if (!existsSync(path)) return ok(new Set<string>());
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return err(`${CANARY_RESULTS}: ${message(e).split(path).join(CANARY_RESULTS)}`);
  }
  const adapters = readArray(value, 'adapters');
  if (adapters === null) return err(`${CANARY_RESULTS}: adapters must be an array`);
  const latest = new Map<string, { ms: number; pass: boolean }>();
  for (const [i, a] of adapters.entries()) {
    const id = readString(a, 'id');
    const pass = readBoolean(a, 'pass');
    const at = readString(a, 'at');
    const ms = at === null ? Number.NaN : Date.parse(at);
    if (!isRecord(a) || id === null || pass === null || Number.isNaN(ms)) return err(`${CANARY_RESULTS}: adapters[${i}] needs id, pass and an ISO at`);
    const was = latest.get(id);
    if (was === undefined || ms >= was.ms) latest.set(id, { ms, pass });
  }
  return ok(new Set([...latest.entries()].filter(([, r]) => !r.pass).map(([id]) => id)));
}

/**
 * suspended (recorded, sticky; or the posterior now over the protocol's suspend line) > unqualified (or absent from
 * the status) > flagged (posterior over the flag line) > ok. The posterior lines come from protocol:calibration, so a
 * bundle change applies at the next freeze; only qualified families have an agreement posterior.
 */
function flagOf(trust: FamilyTrust | undefined, cal: ProtocolCalibration): FreezeFlag {
  if (trust === undefined) return 'unqualified';
  if (trust.agreement.state === 'suspended') return 'suspended';
  if (!trust.qualified) return 'unqualified';
  const { n, p_below: pBelow } = trust.agreement;
  if (n >= cal.agreement.suspendN && pBelow >= cal.agreement.suspendP) return 'suspended';
  if (n >= cal.agreement.flagN && pBelow >= cal.agreement.flagP) return 'flagged';
  return 'ok';
}

/**
 * P rounds with status null → every judge family ok, eligible and gate. R rounds: status null or fewer than
 * 3 qualified unsuspended families → err (02c maps it to blocked, exit 4). A family is canary-failing when any of
 * its judges failed; it is then neither eligible nor a gate judge. Lists follow judges.json order.
 */
export function trustPins(status: TrustStatus | null, roundId: string, judges: readonly JudgeSpec[], canaryFailed: ReadonlySet<string>, cal: ProtocolCalibration): Result<TrustPins> {
  const kind = /^([PR])\d{2}$/u.exec(roundId)?.[1];
  if (kind === undefined) return err(`trustPins: ${roundId} is not a P or R round`);
  const families: Family[] = [];
  for (const j of judges) if (!families.includes(j.family)) families.push(j.family);
  if (families.length === 0) return err('trustPins: judges.json lists no judge');
  const canaryOk = (f: Family): boolean => !judges.some((j) => j.family === f && canaryFailed.has(j.id));
  if (status === null) {
    if (kind === 'R') return err(`${TRUST_STATUS} missing: R rounds wait for a scored calibration (forge calib score)`);
    const all = families.filter(canaryOk);
    return ok({ eligibleFamilies: all, flags: Object.fromEntries(families.map((f) => [f, 'ok'])), gateFamilies: [...all] });
  }
  const flags: Record<string, FreezeFlag> = {};
  for (const f of families) flags[f] = flagOf(status.families[f], cal);
  if (kind === 'R') {
    const qualified = families.filter((f) => status.families[f]?.qualified === true && flags[f] !== 'suspended');
    if (qualified.length < MIN_QUALIFIED_FAMILIES) {
      return err(`only ${qualified.length} qualified unsuspended judge families (${qualified.join(', ') || 'none'}); R rounds need ${MIN_QUALIFIED_FAMILIES}`);
    }
  }
  return ok({
    eligibleFamilies: families.filter((f) => flags[f] === 'ok' && canaryOk(f)),
    flags,
    gateFamilies: families.filter((f) => status.families[f]?.gate_judge === true && flags[f] !== 'suspended' && canaryOk(f)),
  });
}
