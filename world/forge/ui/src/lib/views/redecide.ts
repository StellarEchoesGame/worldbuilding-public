import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord, readArray, readBoolean, readRecord, readString, stringArray } from '../../../../engine/json.ts';
import { decisionFiles, gateRejection, readOwnerLog, sha256Bytes, staleDecisionPin } from '../../../../engine/owner-inputs.ts';
import { err, ok, type Result } from '../../../../engine/result.ts';
import { redactRoot } from '../data.ts';

/** The 重新决策 page: open only while submitRedecision would accept (same checks, same order). */
export interface RedecideView {
  round: string;
  allowed: boolean;
  /** Why not (Chinese, shown on the page); null when allowed. */
  reason: string | null;
  /** Latest file of the decision chain (decisionFiles) and its SHA-256. */
  current: { file: string; sha256: string; pick: string; base: string | null; facts: string[] } | null;
  /** gateRejection(...) path of the non-pass gate record. */
  rejectionPath: string | null;
  /** Next file name, e.g. decision-2.json. */
  nextFile: string | null;
  /** What the non-pass gate record says (read leniently from rejectionPath); null without a rejection. */
  rejection: GateRejectionView | null;
  /**
   * Chain files without their owner-log decision line: submitRedecision re-logs them first and refuses, so the page is
   * closed and offers that re-log (an empty POST to the redecision route) instead of the form.
   */
  unlogged: string[];
}

export interface GateRejectionView {
  status: string;
  /** Mechanical fact-set violations (regate / post-merge `mechanical.violations`). */
  violations: string[];
  /** regate.json `trial_labels` (a trial champion pair sends the decision back without calls). */
  trialLabels: string[];
  judges: Array<{ family: string; status: string; yes: boolean | null; error: string | null; findings: Array<{ quote: string; against: string; reason: string }> }>;
}

const ROUND_ID = /^[A-Z]\d{2}$/u;

type Current = NonNullable<RedecideView['current']>;

/** The decision file as shown (lenient: the chain reader, not this page, judges its validity); err when unreadable. */
function currentOf(root: string, rel: string): Result<Current> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(root, rel));
  } catch (e) {
    return err(`决策文件 ${rel} 无法读取（${redactRoot(e instanceof Error ? e.message : String(e), root)}），需要先修复。`);
  }
  let value: unknown = null;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    // an unparseable decision shows its hash only; submitRedecision's checks still decide
  }
  const facts = (readArray(value, 'facts') ?? []).flatMap((f) => {
    const label = readString(f, 'label');
    const id = readString(f, 'id');
    return label === null || id === null ? [] : [`${label}:${id}`];
  });
  return ok({ file: rel, sha256: sha256Bytes(bytes), pick: readString(value, 'pick') ?? '', base: readString(value, 'base'), facts });
}

/** Chain files with no `decision` owner-log line for them (ui/src/lib/owner.ts relogOwnerFile's match); [] when the log is unreadable, as there. */
function unloggedFiles(root: string, roundId: string, chain: readonly string[]): string[] {
  const log = readOwnerLog(root);
  if (!log.ok) return [];
  return chain.filter((rel) => !log.value.some((e) => e.action === 'decision' && e.round === roundId && e.file === rel));
}

function rejectionOf(root: string, rel: string): GateRejectionView | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(root, rel), 'utf8'));
  } catch {
    return null;
  }
  const judges = (readArray(value, 'judges') ?? []).map((j) => ({
    family: readString(j, 'family') ?? '',
    status: readString(j, 'status') ?? '',
    yes: readBoolean(j, 'yes'),
    error: readString(j, 'error'),
    findings: (readArray(readRecord(j, 'verdict'), 'findings') ?? []).map((f) => ({
      quote: readString(f, 'quote') ?? '',
      against: readString(f, 'against') ?? '',
      reason: readString(f, 'reason') ?? '',
    })),
  }));
  return {
    status: readString(value, 'status') ?? '',
    violations: stringArray(readRecord(value, 'mechanical')?.['violations']) ?? [],
    trialLabels: stringArray(isRecord(value) ? value['trial_labels'] : null) ?? [],
    judges,
  };
}

export function redecideView(root: string, roundId: string): RedecideView {
  const closed = (reason: string, rest: Partial<Omit<RedecideView, 'round' | 'allowed' | 'reason'>> = {}): RedecideView => ({
    round: roundId, allowed: false, reason, current: rest.current ?? null, rejectionPath: rest.rejectionPath ?? null, nextFile: rest.nextFile ?? null,
    rejection: rest.rejection ?? null, unlogged: rest.unlogged ?? [],
  });
  if (!ROUND_ID.test(roundId)) return closed('轮次编号不对。');
  const chain = decisionFiles(root, roundId);
  if (!chain.ok) return closed(`决策链有问题：${chain.error}`);
  const prevRel = chain.value.at(-1);
  if (prevRel === undefined) return closed('这一轮还没有决策，请先提交第一份决策。');
  const read = currentOf(root, prevRel);
  if (!read.ok) return closed(read.error);
  const current = read.value;
  const nextName = `decision-${chain.value.length + 1}.json`;
  // submitRedecision's first check after the chain: files without their log line are re-logged and the POST refused
  const unlogged = unloggedFiles(root, roundId, chain.value);
  if (unlogged.length > 0) {
    return closed(`决策链中有文件没有记入 owner 日志：${unlogged.join('、')}。先点“补记 owner 日志”，再刷新页面重新核对。`, { current, nextFile: nextName, unlogged });
  }
  const rejection = gateRejection(root, roundId, current.sha256);
  if (rejection.kind === 'malformed') return closed(`过门记录无法读取：${rejection.path}（需要先修复）。`, { current, rejectionPath: rejection.path, nextFile: nextName });
  if (rejection.kind !== 'rejected') return closed('当前决策没有未通过的过门记录，不能追加新决策。', { current, nextFile: nextName });
  const rest = { current, rejectionPath: rejection.path, nextFile: nextName, rejection: rejectionOf(root, rejection.path) };
  if (!staleDecisionPin(root, roundId, current.sha256)) return closed('引擎还没有把这一轮退回 9b，请先运行引擎。', rest);
  if (existsSync(join(root, 'rounds', roundId, nextName))) return closed('新决策已经存在，不能覆盖。', rest);
  return { round: roundId, allowed: true, reason: null, ...rest, unlogged: [] };
}
