import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchLogEntry } from '../../../../engine/bench-log.ts';
import { readOutcome } from '../../../../engine/bench-cycle.ts';
import { APPROVAL_DIFF_FILE, FINAL_FILE, parseFinal, PR_BODY_FILE, type FinalJson } from '../../../../engine/final.ts';
import { ownerInputs, sha256Bytes } from '../../../../engine/owner-inputs.ts';
import { readStatus, type RoundStatus } from '../../../../engine/runner.ts';
import { roundPaths } from '../../../../engine/store.ts';

/** The 定稿 page (step 12) of one round. */
export interface FinalPageView {
  round: string;
  /** rounds/RNN/final.json via parseFinal; null + finalError when absent or invalid. */
  final: FinalJson | null;
  finalError: string | null;
  /** rounds/RNN/approval.diff text and the SHA-256 of its bytes (what the approve form posts). */
  diffText: string | null;
  diffSha256: string | null;
  /** diffSha256 === final.approval_diff_sha256. */
  diffMatches: boolean;
  /** rounds/RNN/pr-body.md (English draft). */
  prBody: string | null;
  /** rounds/RNN/bench/outcome.json (readOutcome); null before 11j or when unreadable. */
  outcome: BenchLogEntry | null;
  /** Why outcome.json does not read (null when absent or valid). */
  outcomeError: string | null;
  /** ownerInputs(root).diffApproved(round, diffSha256). */
  approvedAt: string | null;
  status: RoundStatus | null;
  /** final + diff present, diffMatches, not yet approved. */
  canApprove: boolean;
}

const ROUND_ID = /^[A-Z]\d{2}$/u;

function readFinal(dir: string): { final: FinalJson | null; error: string | null } {
  const path = join(dir, FINAL_FILE);
  if (!existsSync(path)) return { final: null, error: null };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { final: null, error: `${FINAL_FILE}: not valid JSON` };
  }
  const parsed = parseFinal(value);
  return parsed.ok ? { final: parsed.value, error: null } : { final: null, error: parsed.error };
}

export function finalView(root: string, roundId: string): FinalPageView | null {
  if (!ROUND_ID.test(roundId)) return null;
  const paths = roundPaths(root, roundId);
  if (!existsSync(paths.dir)) return null;
  const { final, error } = readFinal(paths.dir);
  const diffPath = join(paths.dir, APPROVAL_DIFF_FILE);
  const diffBytes = existsSync(diffPath) ? readFileSync(diffPath) : null;
  const diffSha256 = diffBytes === null ? null : sha256Bytes(diffBytes);
  const prPath = join(paths.dir, PR_BODY_FILE);
  const outcome = readOutcome(paths);
  const status = readStatus(root, roundId);
  const diffMatches = final !== null && diffSha256 !== null && diffSha256 === final.approval_diff_sha256;
  const approvedAt = diffSha256 === null ? null : ownerInputs(root).diffApproved(roundId, diffSha256);
  return {
    round: roundId,
    final,
    finalError: error,
    diffText: diffBytes === null ? null : diffBytes.toString('utf8'),
    diffSha256,
    diffMatches,
    prBody: existsSync(prPath) ? readFileSync(prPath, 'utf8') : null,
    outcome: outcome !== null && outcome.ok ? outcome.value : null,
    outcomeError: outcome !== null && !outcome.ok ? outcome.error : null,
    approvedAt,
    status: status.ok ? status.value : null,
    canApprove: diffMatches && approvedAt === null,
  };
}
