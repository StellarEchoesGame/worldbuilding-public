import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StepContext } from '../context.ts';
import { mechanicalGate, type GateCheck } from '../gate.ts';
import { isRecord } from '../json.ts';
import { err, ok, type Result } from '../result.ts';
import type { StepDef } from '../runner.ts';
import { loadSubmission } from '../submission.ts';

/** One writer slot in `gate/mechanical.json`: `missing` = no valid submission (void writer or unparsable file). */
export interface MechanicalEntry {
  status: 'pass' | 'fail' | 'missing';
  pass: boolean;
  checks: GateCheck[];
  error: string | null;
}

/** `rounds/RNN/gate/mechanical.json`. */
export interface MechanicalGateFile {
  round: string;
  submissions: Record<string, MechanicalEntry>;
}

/** Parsed JSON of a round file, or err naming only the forge-relative path. */
export function readRoundJson(ctx: StepContext, path: string): Result<unknown> {
  const rel = ctx.files.rel(path);
  if (!existsSync(path)) return err(`${rel} is missing`);
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return ok(raw);
  } catch {
    return err(`${rel} is not JSON`);
  }
}

function parseCheck(value: unknown): GateCheck | null {
  if (!isRecord(value)) return null;
  const { name, ok: pass, detail, flags } = value;
  if (typeof name !== 'string' || typeof pass !== 'boolean' || typeof detail !== 'string') return null;
  if (flags === undefined) return { name, ok: pass, detail };
  if (!Array.isArray(flags) || !flags.every((f): f is string => typeof f === 'string')) return null;
  return { name, ok: pass, detail, flags };
}

function parseMechanicalEntry(value: unknown): MechanicalEntry | null {
  if (!isRecord(value)) return null;
  const { status, pass, checks, error } = value;
  if (status !== 'pass' && status !== 'fail' && status !== 'missing') return null;
  if (typeof pass !== 'boolean' || !Array.isArray(checks) || (error !== null && typeof error !== 'string')) return null;
  const parsed: GateCheck[] = [];
  for (const c of checks) {
    const check = parseCheck(c);
    if (check === null) return null;
    parsed.push(check);
  }
  return { status, pass, checks: parsed, error };
}

/** `gate/mechanical.json` (05a) of this round, parsed; err when missing or malformed. Slot order is file order. */
export function readMechanicalFile(ctx: StepContext): Result<MechanicalGateFile> {
  const path = join(ctx.paths.gate, 'mechanical.json');
  const raw = readRoundJson(ctx, path);
  if (!raw.ok) return err(raw.error);
  const rel = ctx.files.rel(path);
  if (!isRecord(raw.value) || typeof raw.value['round'] !== 'string' || !isRecord(raw.value['submissions'])) return err(`${rel}: malformed`);
  const submissions: Record<string, MechanicalEntry> = {};
  for (const [slot, value] of Object.entries(raw.value['submissions'])) {
    const entry = parseMechanicalEntry(value);
    if (entry === null) return err(`${rel}: malformed entry ${slot}`);
    submissions[slot] = entry;
  }
  return ok({ round: raw.value['round'], submissions });
}

/** The negated-forbidden-word sentences 05a flagged on a slot (`forbidden_words` check flags). */
export function negatedFlags(entry: MechanicalEntry | undefined): string[] {
  const check = entry?.checks.find((c) => c.name === 'forbidden_words');
  return check?.flags === undefined ? [] : [...check.flags];
}

/**
 * 05a-gate-mech: the existing mechanicalGate (PROTOCOL `limits`, forbidden words, negations and exceptions from
 * ctx.rules) on every writer slot's submission → `gate/mechanical.json`. The champion is never gated here.
 */
export const gateMechStep: StepDef = {
  id: '05a-gate-mech',
  run: async (ctx) => {
    const out: MechanicalGateFile = { round: ctx.roundId, submissions: {} };
    const inputs: string[] = [];
    const rules = ctx.rules;
    for (const { slot } of ctx.backends.writers) {
      const path = join(ctx.paths.submissions, `${slot}.json`);
      if (!existsSync(path)) {
        out.submissions[slot] = { status: 'missing', pass: false, checks: [], error: 'no submission file' };
        continue;
      }
      inputs.push(ctx.files.rel(path));
      const sub = loadSubmission(ctx.paths, slot);
      if (sub === null || sub.output === null) {
        out.submissions[slot] = { status: 'missing', pass: false, checks: [], error: sub === null ? 'malformed submission file' : (sub.error ?? 'void') };
        continue;
      }
      const g = mechanicalGate(sub.output, {
        baseline: false,
        limits: rules.limits,
        forbidden: rules.forbidden,
        negations: rules.negations,
        negationExceptions: rules.negationExceptions,
      });
      out.submissions[slot] = { status: g.pass ? 'pass' : 'fail', pass: g.pass, checks: g.checks, error: null };
    }
    const file = ctx.files.writeJson(join(ctx.paths.gate, 'mechanical.json'), out);
    const summary = Object.entries(out.submissions).map(([slot, e]) => `${slot}:${e.status}`).join(' ');
    ctx.progress('05a-gate-mech', 'info', summary);
    return { kind: 'done', inputs, outputs: [file], external: [] };
  },
};
