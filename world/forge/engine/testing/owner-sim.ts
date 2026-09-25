import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { readArray, readNumber, readRecord, readString } from '../json.ts';
import { OWNER_ANSWERS, OWNER_LOG, calibSet, ownerInputs, parseOwnerLogEntry, sha256Bytes, validateOwnerFile, type OwnerSchemaName } from '../owner-inputs.ts';
import { CHAMPION_ID, displayText, submissionFor } from '../round.ts';
import { loadProtocolBundle } from '../rules.ts';
import { readJson, readLines } from '../store.ts';
import {
  readAuditSet, readLabels, submitAudit, submitBenchApproval, submitBenchView, submitCalibAnswers, submitDecision, submitDiffApproval,
  submitProtocolApproval, submitRedecision, submitRollback, submitTopic, type CalibAnswerInput, type DecisionInput, type OwnerResult,
} from '../../ui/src/lib/owner.ts';
import type { FakeClock } from './fakes.ts';

/** What the UI would show for one pair (ids plus display texts). */
export interface OwnerPairView {
  id: string;
  left: string;
  right: string;
  leftText: string;
  rightText: string;
}

export type ChoosePair = (pair: OwnerPairView) => 'left' | 'right';

/**
 * Test-only stand-in for the UI: wraps the ui/src/lib/owner.ts writers, stamps clock.now() then advances 1 s,
 * validates every file against schema/, and throws on input the UI would refuse. Imported only by tests.
 */
export interface OwnerSim {
  approveProtocol(): void;
  pickTopic(round: string, input: { row_id: string; layer: string }): void;
  answerAudit(round: string, choose: ChoosePair): void;
  decide(round: string, input: DecisionInput): void;
  redecide(round: string, input: DecisionInput): void;
  viewBenchDiff(version: string): void;
  approveBench(version: string): void;
  rollback(version: string, from: string): void;
  /** All displayed slots of the set, or only `slots` (a partial POST). */
  answerCalibration(set: string, choose: ChoosePair, slots?: readonly number[]): void;
  /** Approves the approval diff recorded in rounds/<round>/final.json. */
  approveDiff(round: string): void;
  /** Forge-root-relative owner file → SHA-256 of what the sim last wrote. */
  /** A round owner file (`rounds/RNN/audit.json`, `decision*.json`) written by hand without its owner-log line. */
  writeUnlogged(rel: string, value: unknown): void;
  /** A hand edit of an owner file (round audit / decision, calibration answers) after the UI logged it. */
  tamper(rel: string, edit: (text: string) => string): void;
  /** Deletes an owner file (a test resetting the owner's state). */
  removeOwnerFile(rel: string): void;
  expected(): ReadonlyMap<string, string>;
}

function fileSha(path: string): string {
  return sha256Bytes(readFileSync(path));
}

/** The owner files the hand-edit helpers may touch (a subset of context.ts OWNER_ONLY). */
const EDITABLE_OWNER_FILE = /^(?:rounds\/[A-Z]\d{2}\/(?:audit|decision[^/]*)\.json|calibration\/owner-answers\.json)$/u;

export function ownerSim(root: string, clock: FakeClock): OwnerSim {
  const expected = new Map<string, string>();
  const rel = (path: string): string => relative(root, path).split(sep).join('/');
  const ownerPath = (what: string, file: string): string => {
    if (!EDITABLE_OWNER_FILE.test(file)) throw new Error(`owner-sim ${what}: ${file} is not a hand-editable owner file`);
    return join(root, file);
  };

  /** Throws on a UI refusal; validates the written file and the new owner-log line; then advances the clock. */
  function done(what: string, r: OwnerResult, schema: OwnerSchemaName | null): void {
    if (!r.ok) throw new Error(`owner-sim ${what}: UI refused (${r.status}) ${r.error}`);
    if (schema !== null) {
      const errors = validateOwnerFile(schema, JSON.parse(readFileSync(r.file, 'utf8')));
      if (errors.length > 0) throw new Error(`owner-sim ${what}: ${rel(r.file)} fails schema/${schema}.schema.json: ${errors.join('; ')}`);
      expected.set(rel(r.file), fileSha(r.file));
    }
    const logPath = join(root, OWNER_LOG);
    const last = readFileSync(logPath, 'utf8').trimEnd().split('\n').at(-1) ?? '';
    const entry = parseOwnerLogEntry(JSON.parse(last));
    if (!entry.ok) throw new Error(`owner-sim ${what}: owner-log line fails the reader: ${entry.error}`);
    expected.set(OWNER_LOG, fileSha(logPath));
    clock.advance(1000);
  }

  function textOf(round: string, label: string): string {
    const subId = label === CHAMPION_ID ? CHAMPION_ID : (readLabels(root, round)[label] ?? label);
    const sub = submissionFor(root, round, subId);
    return sub?.output ? displayText(sub.output) : '';
  }

  /** The version file the UI would show: the logged path, else benchmark/<version>.json. */
  function versionSha(version: string): string {
    let path = `benchmark/${version}.json`;
    for (const v of readLines(join(root, 'benchmark', 'log.jsonl'))) {
      const p = readString(v, 'path');
      if (readString(v, 'version') === version && p !== null) path = p;
    }
    return fileSha(join(root, path));
  }

  function calibText(texts: unknown, id: string): string {
    const path = readString(readRecord(texts, id), 'path');
    const file = path === null ? null : join(root, 'calibration', path);
    return file !== null && existsSync(file) ? readFileSync(file, 'utf8') : '';
  }

  return {
    approveProtocol() {
      const bundle = loadProtocolBundle(root);
      if (!bundle.ok) throw new Error(`owner-sim approveProtocol: ${bundle.error}`);
      done('approveProtocol', submitProtocolApproval(root, bundle.value.bundleSha256, clock.now()), null);
    },
    pickTopic(round, input) {
      done('pickTopic', submitTopic(root, round, input, clock.now()), 'topic');
    },
    answerAudit(round, choose) {
      const answers: Record<string, string> = {};
      for (const p of readAuditSet(root, round)) {
        answers[p.id] = choose({ id: p.id, left: p.left, right: p.right, leftText: textOf(round, p.left), rightText: textOf(round, p.right) });
      }
      done('answerAudit', submitAudit(root, round, answers, clock.now()), 'audit');
    },
    decide(round, input) {
      done('decide', submitDecision(root, round, input, clock.now()), 'decision');
    },
    redecide(round, input) {
      done('redecide', submitRedecision(root, round, input, clock.now()), 'decision');
    },
    viewBenchDiff(version) {
      done('viewBenchDiff', submitBenchView(root, version, versionSha(version), clock.now()), null);
    },
    approveBench(version) {
      done('approveBench', submitBenchApproval(root, version, versionSha(version), clock.now()), null);
    },
    rollback(version, from) {
      done('rollback', submitRollback(root, { version, from, sha256: versionSha(version) }, clock.now()), null);
    },
    answerCalibration(set, choose, slots) {
      const pairs = calibSet(root, set);
      if (!pairs.ok) throw new Error(`owner-sim answerCalibration: ${pairs.error}`);
      const texts = pairs.value.value['texts'];
      // like the UI, only slots not answered yet are shown
      const prior = readArray(readRecord(readRecord(readJson(join(root, OWNER_ANSWERS)), 'sets'), set), 'answers') ?? [];
      const answered = new Set(prior.map((a) => readNumber(a, 'slot')));
      const answers: CalibAnswerInput[] = [];
      for (const [slot, d] of [...pairs.value.display.entries()].sort((a, b) => a[0] - b[0])) {
        if ((slots !== undefined && !slots.includes(slot)) || answered.has(slot)) continue;
        const choice = choose({ id: d.pair, left: d.left, right: d.right, leftText: calibText(texts, d.left), rightText: calibText(texts, d.right) });
        answers.push({ slot, choice, ms: null });
      }
      done('answerCalibration', submitCalibAnswers(root, set, answers, clock.now()), null);
      const read = ownerInputs(root).calibAnswers();
      if (read.state !== 'ok') throw new Error(`owner-sim answerCalibration: the reader does not accept ${OWNER_ANSWERS} (${read.state})`);
      expected.set(OWNER_ANSWERS, read.sha256);
    },
    approveDiff(round) {
      const sha = readString(readJson(join(root, 'rounds', round, 'final.json')), 'approval_diff_sha256');
      if (sha === null) throw new Error(`owner-sim approveDiff: rounds/${round}/final.json has no approval_diff_sha256`);
      done('approveDiff', submitDiffApproval(root, round, sha, clock.now()), null);
    },
    writeUnlogged(file, value) {
      const path = ownerPath('writeUnlogged', file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
      expected.set(file, fileSha(path));
    },
    tamper(file, edit) {
      const path = ownerPath('tamper', file);
      writeFileSync(path, edit(readFileSync(path, 'utf8')));
      expected.set(file, fileSha(path));
    },
    removeOwnerFile(file) {
      rmSync(ownerPath('removeOwnerFile', file));
      expected.delete(file);
    },
    expected: () => new Map(expected),
  };
}
