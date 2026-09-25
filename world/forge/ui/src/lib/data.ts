import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord, readArray, readBoolean, readNumber, readRecord, readString } from '../../../engine/json.ts';
import { CHAMPION_ID, displayText, submissionFor } from '../../../engine/round.ts';
import { readJson, readLines, roundPaths } from '../../../engine/store.ts';
import type { Claim, InterfaceCard } from '../../../engine/writer-output.ts';
import { readAuditSet, readLabels, type AuditPair } from './owner.ts';

export function dataDir(): string {
  const fromEnv = process.env['FORGE_DATA_DIR'];
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : resolve(fileURLToPath(new URL('../../..', import.meta.url)));
}

export interface ProgressEvent {
  at: string;
  step: string;
  status: string;
  detail: string;
}

export interface RoundListItem {
  id: string;
  title: string;
  done: boolean;
  judged: number;
  errors: number;
  last: ProgressEvent | null;
  audited: boolean;
  decided: boolean;
}

function events(root: string, id: string): ProgressEvent[] {
  return readLines(roundPaths(root, id).progress).map((e) => ({
    at: readString(e, 'at') ?? '',
    step: readString(e, 'step') ?? '',
    status: readString(e, 'status') ?? '',
    detail: readString(e, 'detail') ?? '',
  }));
}

export function listRounds(root: string): RoundListItem[] {
  const dir = join(root, 'rounds');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((id) => /^[A-Z]\d{2}$/u.test(id))
    .sort()
    .map((id) => {
      const ev = events(root, id);
      const brief = readJson(join(dir, id, 'brief.json'));
      return {
        id,
        title: readString(readRecord(brief, 'cell'), 'title') ?? id,
        done: ev.some((e) => e.step === 'round' && e.status === 'done'),
        judged: ev.filter((e) => e.step === 'taste' && e.status === 'info').length,
        errors: ev.filter((e) => e.status === 'error').length,
        last: ev.at(-1) ?? null,
        audited: existsSync(join(dir, id, 'audit.json')),
        decided: existsSync(join(dir, id, 'decision.json')),
      };
    });
}

export interface GateCheckView {
  name: string;
  ok: boolean;
  detail: string;
  /** Sentences the check passed but wants reviewed, e.g. negated forbidden words. */
  flags: string[];
}

/** ✔ passed, ⚠ passed with flagged sentences to review, ✖ failed. */
export function gateMark(check: GateCheckView): '✔' | '⚠' | '✖' {
  if (!check.ok) return '✖';
  return check.flags.length > 0 ? '⚠' : '✔';
}

export interface SessionView {
  family: string;
  judge: string;
  session: number;
  forward: number | null;
  reverse: number | null;
  win: boolean;
  quotes: Array<{ order: string; question: string; pick: number; quote: string; forCandidate: boolean }>;
}

export interface CandidateView {
  label: string;
  id: string;
  text: string;
  stance: string | null;
  model: string;
  gatePass: boolean;
  gate: GateCheckView[];
  facts: Claim[];
  newProperNouns: string[];
  iface: InterfaceCard | null;
  seeds: string[];
  totalWins: number | null;
  needed: number | null;
  beats: boolean;
  trial: boolean;
  eligible: string[];
  sessions: SessionView[];
}

export interface RoundView {
  id: string;
  title: string;
  entity: string;
  time: string;
  layers: string[];
  questions: Array<{ id: string; text: string }>;
  decisive: string;
  candidates: CandidateView[];
  baseline: CandidateView | null;
  failed: Array<{ id: string; error: string }>;
  auditSet: AuditPair[];
  audit: Record<string, string> | null;
  decision: Record<string, unknown> | null;
  events: ProgressEvent[];
  done: boolean;
}

/** One submission's record from gate.json. */
export function readGate(g: unknown): { pass: boolean; checks: GateCheckView[] } {
  const checks: GateCheckView[] = [];
  for (const c of readArray(g, 'checks') ?? []) {
    checks.push({
      name: readString(c, 'name') ?? '',
      ok: readBoolean(c, 'ok') === true,
      detail: readString(c, 'detail') ?? '',
      flags: (readArray(c, 'flags') ?? []).filter((x): x is string => typeof x === 'string'),
    });
  }
  return { pass: readBoolean(g, 'pass') === true, checks };
}

function gateFor(root: string, id: string, subId: string): { pass: boolean; checks: GateCheckView[] } {
  return readGate(readRecord(readJson(join(roundPaths(root, id).dir, 'gate.json')), subId));
}

function sessionsFor(root: string, id: string, subId: string): SessionView[] {
  const dir = join(roundPaths(root, id).taste, subId);
  if (!existsSync(dir)) return [];
  const byKey = new Map<string, SessionView>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const rec = readJson(join(dir, f));
    const judge = readString(rec, 'judge') ?? '';
    const session = readNumber(rec, 'session') ?? 0;
    const order = readString(rec, 'order') ?? '';
    const key = `${judge}-${session}`;
    const view = byKey.get(key) ?? { family: readString(rec, 'family') ?? '', judge, session, forward: null, reverse: null, win: false, quotes: [] };
    const pick = readNumber(rec, 'decisive_pick');
    if (order === 'fwd') view.forward = pick;
    if (order === 'rev') view.reverse = pick;
    const verdict = readRecord(rec, 'verdict');
    const picks = readRecord(verdict, 'picks');
    const quotes = readRecord(verdict, 'quotes');
    if (picks !== null && quotes !== null) {
      for (const [q, p] of Object.entries(picks)) {
        const quote = readString(quotes, q);
        if (typeof p === 'number' && quote !== null) view.quotes.push({ order, question: q, pick: p, quote, forCandidate: (order === 'fwd' && p === 1) || (order === 'rev' && p === 2) });
      }
    }
    view.win = view.forward === 1 && view.reverse === 2;
    byKey.set(key, view);
  }
  return [...byKey.values()];
}

function candidateView(root: string, id: string, label: string, subId: string, tally: unknown): CandidateView | null {
  const sub = submissionFor(root, id, subId);
  if (sub === null || sub.output === null) return null;
  const g = gateFor(root, id, subId);
  const t = readRecord(tally, 'tally');
  return {
    label,
    id: subId,
    text: displayText(sub.output),
    stance: sub.stance,
    model: sub.model,
    gatePass: g.pass,
    gate: g.checks,
    facts: sub.output.delta.claims.filter((c) => c.kind === 'author_fact'),
    newProperNouns: sub.output.delta.newProperNouns,
    iface: sub.output.iface,
    seeds: sub.output.seeds,
    totalWins: readNumber(t, 'totalWins'),
    needed: readNumber(t, 'needed'),
    beats: readBoolean(t, 'beatsChampion') === true,
    trial: readBoolean(t, 'trial') === true,
    eligible: (readArray(t, 'eligible') ?? []).filter((x): x is string => typeof x === 'string'),
    sessions: subId === CHAMPION_ID ? [] : sessionsFor(root, id, subId),
  };
}

export function loadRound(root: string, id: string): RoundView | null {
  const paths = roundPaths(root, id);
  const brief = readJson(join(paths.dir, 'brief.json'));
  if (!isRecord(brief)) return null;
  const cell = readRecord(brief, 'cell');
  const bench = readRecord(brief, 'benchmark');
  const labels = readLabels(root, id);
  const tallyList = readArray(readJson(join(paths.dir, 'tally.json')), 'candidates') ?? [];
  const candidates: CandidateView[] = [];
  for (const [label, subId] of Object.entries(labels)) {
    const t = tallyList.find((x) => readString(x, 'submission') === subId);
    const v = candidateView(root, id, label, subId, t);
    if (v !== null) candidates.push(v);
  }
  const failed: Array<{ id: string; error: string }> = [];
  if (existsSync(paths.submissions)) {
    for (const f of readdirSync(paths.submissions).filter((n) => n.endsWith('.json'))) {
      const subId = f.replace(/\.json$/u, '');
      if (Object.values(labels).includes(subId) || subId === CHAMPION_ID) continue;
      const sub = submissionFor(root, id, subId);
      const gate = gateFor(root, id, subId);
      failed.push({ id: subId, error: sub?.error ?? (gate.checks.filter((c) => !c.ok).map((c) => `${c.name}：${c.detail}`).join('；') || '未通过事实门') });
    }
  }
  const auditRaw = readJson(join(paths.dir, 'audit.json'));
  let audit: Record<string, string> | null = null;
  if (isRecord(auditRaw)) {
    audit = {};
    for (const a of readArray(auditRaw, 'answers') ?? []) {
      const pair = readString(a, 'pair');
      const chosen = readString(a, 'chosen');
      if (pair !== null && chosen !== null) audit[pair] = chosen;
    }
  }
  const decisionRaw = readJson(join(paths.dir, 'decision.json'));
  const ev = events(root, id);
  return {
    id,
    title: readString(cell, 'title') ?? id,
    entity: readString(cell, 'entity') ?? '',
    time: readString(cell, 'time') ?? '',
    layers: (readArray(cell, 'layers') ?? []).filter((x): x is string => typeof x === 'string'),
    questions: (readArray(bench, 'questions') ?? []).flatMap((q) => {
      const qid = readString(q, 'id');
      const text = readString(q, 'text');
      return qid !== null && text !== null ? [{ id: qid, text }] : [];
    }),
    decisive: readString(bench, 'decisive') ?? 'q1',
    candidates,
    baseline: candidateView(root, id, '现任（基线）', CHAMPION_ID, null),
    failed,
    auditSet: readAuditSet(root, id),
    audit,
    decision: isRecord(decisionRaw) ? decisionRaw : null,
    events: ev,
    done: ev.some((e) => e.step === 'round' && e.status === 'done'),
  };
}

export function textFor(view: RoundView, label: string): string {
  if (label === CHAMPION_ID) return view.baseline?.text ?? '';
  return view.candidates.find((c) => c.label === label)?.text ?? '';
}
