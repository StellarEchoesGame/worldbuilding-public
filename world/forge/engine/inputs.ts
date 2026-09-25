import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord, readArray, readString, stringArray } from './json.ts';
import type { MergeDecision, MergeSource } from './mergecheck.ts';
import { err, ok, type Result } from './result.ts';
import { CHAMPION_ID, submissionFor } from './round.ts';
import { readJson, roundPaths } from './store.ts';
import type { RegisteredFact } from './thinmap.ts';

/** The assembled bundle is generated from the other files, so it is never a quote source. */
const GENERATED = new Set(['reference/REFERENCE.md']);

function markdownIn(dir: string, prefix: string, out: Record<string, string>): void {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const key = `${prefix}${name}`;
    if (!name.endsWith('.md') || GENERATED.has(key) || !statSync(path).isFile()) continue;
    out[key] = readFileSync(path, 'utf8');
  }
}

/** Canon Markdown under world/current and world/current/reference, keyed relative to world/current. */
export function canonFiles(repo: string): Record<string, string> {
  const base = join(repo, 'world', 'current');
  const out: Record<string, string> = {};
  markdownIn(base, '', out);
  markdownIn(join(base, 'reference'), 'reference/', out);
  return out;
}

const SECTION_8 = /^## 8\.\s/u;
const REGISTER_ROW = /^\|\s*(R\d{2}-\d{2})\s*\|(.*)\|\s*$/u;

/** Registered scene facts from 07 §8: `| R-ID | 行 | 事实 | 地位 | 挂靠 | 延伸自 | 误用 | 来源 |`. */
export function parseRegister07(text: string): RegisteredFact[] {
  const out: RegisteredFact[] = [];
  let inSection = false;
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith('## ')) inSection = SECTION_8.test(line);
    if (!inSection) continue;
    const m = REGISTER_ROW.exec(line);
    const rxx = m?.[1];
    const cells = m?.[2]?.split('|').map((c) => c.trim()) ?? [];
    const rowId = cells[0];
    const ext = cells[4];
    if (rxx === undefined || rowId === undefined || ext === undefined) continue;
    out.push({ rxx, rowId, extends: ext });
  }
  return out;
}

/** F-ID → rows from fact-status.json (`ALL` stands for every row). */
export function factRowsFrom(value: unknown): Result<Record<string, string[]>> {
  const facts = readArray(value, 'facts');
  if (facts === null) return err('fact-status: facts must be an array');
  const out: Record<string, string[]> = {};
  for (const f of facts) {
    const id = readString(f, 'id');
    const rows = isRecord(f) ? stringArray(f['rows']) : null;
    if (id === null || rows === null) return err('fact-status: every fact needs id and rows');
    out[id] = rows;
  }
  return ok(out);
}

export function parseMergeDecision(value: unknown): Result<MergeDecision> {
  const round = readString(value, 'round');
  const baseLabel = readString(value, 'baseLabel');
  const title = readString(value, 'title');
  const rows = isRecord(value) ? stringArray(value['rows']) : null;
  const list = readArray(value, 'registered');
  if (round === null || baseLabel === null || title === null || rows === null || list === null) {
    return err('merge decision: round, baseLabel, title, rows and registered are required');
  }
  const registered: MergeDecision['registered'] = [];
  for (const r of list) {
    const rxx = readString(r, 'rxx');
    const label = readString(r, 'label');
    const factId = readString(r, 'factId');
    if (rxx === null || label === null || factId === null) return err('merge decision: every registered entry needs rxx, label and factId');
    registered.push({ rxx, label, factId });
  }
  return ok({ round, baseLabel, title, rows, registered });
}

/** Every labelled candidate of a round plus its baseline, as mergecheck sources. */
export function sourcesFromRound(root: string, roundId: string): Result<MergeSource[]> {
  const labels = readJson(join(roundPaths(root, roundId).dir, 'labels.json'));
  if (!isRecord(labels)) return err(`round ${roundId}: labels.json is missing`);
  const entries: Array<[string, string]> = [];
  for (const [label, id] of Object.entries(labels)) if (typeof id === 'string') entries.push([label, id]);
  entries.push([CHAMPION_ID, CHAMPION_ID]);
  const out: MergeSource[] = [];
  for (const [label, id] of entries) {
    const sub = submissionFor(root, roundId, id);
    if (sub === null || sub.output === null) return err(`round ${roundId}: submission ${id} is missing or unparsable`);
    out.push({
      label,
      submission: sub.output.submission,
      facts: sub.output.delta.claims.map((c) => ({
        id: c.id,
        claim: c.claim,
        status: c.status,
        rowId: c.rowId,
        attachesTo: c.attachesTo,
        extends: c.extends,
        misuse: c.misuse,
        sourceQuote: c.sourceQuote,
      })),
    });
  }
  return ok(out);
}
