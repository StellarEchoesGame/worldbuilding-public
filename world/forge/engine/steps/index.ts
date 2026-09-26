import { evidenceStep, outcomeStep, proposeStep, replayStep, validateStep } from '../bench-cycle.ts';
import { bookkeepingCommitStep, championStep, forecastPoolStep, taggingStep, unsealPublishStep, wikiListStep } from '../bookkeeping.ts';
import { diffApprovalStep, prepareFinalStep } from '../final.ts';
import type { StepDef } from '../runner.ts';
import { agreementStep } from './agreement.ts';
import { aggregateStep } from './aggregate.ts';
import { baselineStep } from './baseline.ts';
import { briefStep } from './brief.ts';
import { defectStep } from './defect.ts';
import { forecastStep } from './forecast.ts';
import { freezeStep } from './freeze.ts';
import { gateLlmStep, resubmitStep } from './gate-llm.ts';
import { gateMechStep } from './gate-mech.ts';
import { measuresStep } from './measures.ts';
import { applyStep, mergeCommitStep, mergeEditStep, postMergeFreezeStep, postMergeGateStep, regateStep } from './merge.ts';
import { auditStep, decisionStep } from './owner-waits.ts';
import { probeMirrorStep } from './probe-mirror.ts';
import { sealStep } from './seal.ts';
import { startStep } from './start.ts';
import { surpriseStep, unsealStep } from './surprise.ts';
import { auxPairsStep, championPairsStep, decoyStep } from './taste.ts';
import { topicStep } from './topic.ts';
import { writeStep } from './write.ts';

/**
 * Production registry = STEP_IDS in order (PR-A 00–05a, PR-B 05b–09b, PR-D 10a–11e, PR-E 11f–12b: the benchmark cycle
 * of bench-cycle.ts, then the 11k / 11l defs of bookkeeping.ts and the 12a / 12b defs of final.ts).
 */
export const ROUND_STEPS: readonly StepDef[] = [
  startStep,
  topicStep,
  briefStep,
  baselineStep,
  freezeStep,
  forecastStep,
  sealStep,
  probeMirrorStep,
  writeStep,
  gateMechStep,
  defectStep,
  gateLlmStep,
  resubmitStep,
  decoyStep,
  championPairsStep,
  auxPairsStep,
  measuresStep,
  unsealStep,
  surpriseStep,
  aggregateStep,
  auditStep,
  decisionStep,
  regateStep,
  mergeEditStep,
  applyStep,
  postMergeFreezeStep,
  postMergeGateStep,
  mergeCommitStep,
  unsealPublishStep,
  forecastPoolStep,
  championStep,
  taggingStep,
  agreementStep,
  evidenceStep,
  proposeStep,
  validateStep,
  replayStep,
  outcomeStep,
  wikiListStep,
  bookkeepingCommitStep,
  prepareFinalStep,
  diffApprovalStep,
];
