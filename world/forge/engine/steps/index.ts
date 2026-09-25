import type { StepDef } from '../runner.ts';
import { baselineStep } from './baseline.ts';
import { briefStep } from './brief.ts';
import { forecastStep } from './forecast.ts';
import { freezeStep } from './freeze.ts';
import { gateMechStep } from './gate-mech.ts';
import { probeMirrorStep } from './probe-mirror.ts';
import { sealStep } from './seal.ts';
import { startStep } from './start.ts';
import { topicStep } from './topic.ts';
import { writeStep } from './write.ts';

/** Production registry: always a prefix of STEP_IDS (PR-B appends 05b–09b, PR-D 10a–11e, PR-E 11f–12b). */
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
];
