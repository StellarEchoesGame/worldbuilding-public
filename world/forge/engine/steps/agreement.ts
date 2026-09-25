import { IntegrityError } from '../task.ts';
import { LABELS_FILE, updateTrust } from '../trust.ts';
import { TRUST_STATUS } from '../trust-status.ts';
import type { StepDef } from '../runner.ts';

/**
 * 11e: binding of trust.ts updateTrust(ctx, roundId) (PR-D group D3). ok status → done with external
 * calibration/{labels,status}.json; TrustWait → WAIT owner_log_repair (as calib-score scoreStep); err → IntegrityError.
 * Nothing is listed as input: the ledger reads every audited round and calibration set, and a rerun rebuilds it.
 */
export const agreementStep: StepDef = {
  id: '11e-agreement',
  run: async (ctx) => {
    const trust = updateTrust(ctx, ctx.roundId);
    if (!trust.ok) throw new IntegrityError(`trust: ${trust.error}`);
    if (trust.value.kind === 'wait') return { kind: 'wait', waitingFor: trust.value.waitingFor, detail: trust.value.detail, inputs: [], outputs: [] };
    const families = Object.entries(trust.value.status.families);
    ctx.progress('11e-agreement', 'info', `trust rebuilt after ${ctx.roundId}: ${families.filter(([, f]) => f.qualified).length}/${families.length} families qualified`);
    return { kind: 'done', inputs: [], outputs: [], external: [LABELS_FILE, TRUST_STATUS] };
  },
};
