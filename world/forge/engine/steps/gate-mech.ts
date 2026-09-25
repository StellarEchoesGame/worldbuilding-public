import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mechanicalGate, type GateCheck } from '../gate.ts';
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
