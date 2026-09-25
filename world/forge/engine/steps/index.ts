import type { StepDef } from '../runner.ts';
import { aggregateStep } from './aggregate.ts';
import { baselineStep } from './baseline.ts';
import { briefStep } from './brief.ts';
import { defectStep } from './defect.ts';
import { forecastStep } from './forecast.ts';
import { freezeStep } from './freeze.ts';
import { gateLlmStep, resubmitStep } from './gate-llm.ts';
import { gateMechStep } from './gate-mech.ts';
import { measuresStep } from './measures.ts';
import { auditStep, decisionStep } from './owner-waits.ts';
import { probeMirrorStep } from './probe-mirror.ts';
import { sealStep } from './seal.ts';
import { startStep } from './start.ts';
import { surpriseStep, unsealStep } from './surprise.ts';
import { auxPairsStep, championPairsStep, decoyStep } from './taste.ts';
import { topicStep } from './topic.ts';
import { writeStep } from './write.ts';

/** Production registry: always a prefix of STEP_IDS (PR-B appended 05b–09b; PR-D appends 10a–11e, PR-E 11f–12b). */
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
];
