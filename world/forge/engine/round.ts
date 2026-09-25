/**
 * Facade kept after the PR-A split so existing importers (ui/src/lib/*.ts, inputs.ts, context.ts, owner-sim) compile
 * unchanged: submission helpers live in submission.ts, the P-round prototype runner in prototype.ts, RoundRules in
 * rules.ts. New code imports from those modules directly.
 */
export { CHAMPION_ID, displayText, loadSubmission, stableLabels, submissionFor, type LoadedSubmission } from './submission.ts';
export {
  runPrototypeRound,
  runPrototypeRound as runRound,
  type CandidateTally,
  type JudgeSlot,
  type PrototypeDeps,
  type PrototypeDeps as RoundDeps,
  type RoundPins,
} from './prototype.ts';
export type { RoundRules } from './rules.ts';
