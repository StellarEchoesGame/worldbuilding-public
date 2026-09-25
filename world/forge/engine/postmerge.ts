import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isFamily, type Family } from './config.ts';
import type { StepContext } from './context.ts';
import { isRecord, readRecord, readString, stringArray } from './json.ts';
import { sha256Bytes } from './marker.ts';
import { ASSEMBLER_WRITES, CANON_DIR, MANIFEST_PATH, TEMPLATED_NOTES } from './merge.ts';
import { decisionDirName } from './owner-inputs.ts';
import { err, ok, type Result } from './result.ts';
import { sha256, type RoundPaths } from './store.ts';
import type { CanonEdit } from './tasks/merge-editor.ts';


/**
 * Post-merge manifest (10d, `forge freeze --post-merge [RNN] [--check]`; plan §8, s5 §5; PR-D group D1). Pins what a
 * gate rerun on the branch needs; gate fields are copied from freeze.json / brief.json, never recomputed. Canonical
 * JSON. The approval-diff hash lives in final.json (12a), so this file is immutable once 10d is marked.
 */

/** `rounds/RNN/merge/<d8>/post-merge.json`. */
export const POST_MERGE_FILE = 'post-merge.json';

export interface PostMergeManifest {
  round: string;
  kind: 'post_merge';
  decision_sha256: string;
  base_sha: string;
  revision: string;
  /** SHA-256 of world/current/BOOK.md (must equal base). */
  book_sha256: string;
  /** hashes.json reference_book_sha256 after 10c. */
  reference_book_sha256: string;
  /** world/current-relative → SHA-256: 09, 07, touched 01–06, REFERENCE.md, hashes.json, manifest.json, BOOK.md, templated notes. */
  files: Record<string, string>;
  scene: { sha256: string; chars: number; rxx: string[] };
  gate: {
    fact_table_sha256: string;
    regression_sha256: string;
    protocol_bundle_sha256: string;
    benchmark_version: string;
    eligible_gate_families: Family[];
    /** `postmerge:<d8>`. */
    seed_key: string;
  };
}

const BOOK = 'BOOK.md';
const HASHES = 'reference/hashes.json';
const HEX64 = /^[0-9a-f]{64}$/u;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function canonText(ctx: StepContext, rel: string): string | null {
  const path = join(ctx.repo, CANON_DIR, rel);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function jsonField(text: string | null, key: string): string | null {
  if (text === null) return null;
  try {
    return readString(JSON.parse(text), key);
  } catch {
    return null;
  }
}

/** The world/current-relative files a post-merge manifest pins: the edit's, the assembler outputs, manifest, BOOK, notes. */
function pinnedPaths(edit: CanonEdit): string[] {
  return [...new Set([...Object.keys(edit.files), ...ASSEMBLER_WRITES, MANIFEST_PATH, BOOK, ...TEMPLATED_NOTES])].sort(byCodeUnit);
}

/** Builds the manifest from the applied tree, the edit and the pinned freeze / brief (err = a missing input). */
export function buildPostMerge(ctx: StepContext, edit: CanonEdit, decisionSha256: string): Result<PostMergeManifest> {
  const freeze = ctx.freeze();
  const files: Record<string, string> = {};
  for (const rel of pinnedPaths(edit)) {
    const path = join(ctx.repo, CANON_DIR, rel);
    if (!existsSync(path)) return err(`${CANON_DIR}/${rel} is missing`);
    files[rel] = sha256Bytes(readFileSync(path));
  }
  const revision = jsonField(canonText(ctx, MANIFEST_PATH), 'revision');
  if (revision === null) return err(`${CANON_DIR}/${MANIFEST_PATH} has no revision`);
  const reference = jsonField(canonText(ctx, HASHES), 'reference_book_sha256');
  if (reference === null) return err(`${CANON_DIR}/${HASHES} has no reference_book_sha256`);
  const factTable = freeze.sha256['fact-status.json'];
  const regression = freeze.sha256['regression'];
  if (factTable === undefined || regression === undefined) return err(`rounds/${ctx.roundId}/freeze.json pins no fact-status.json / regression hash`);
  return ok({
    round: ctx.roundId,
    kind: 'post_merge',
    decision_sha256: decisionSha256,
    base_sha: ctx.start().base_sha,
    revision,
    book_sha256: files[BOOK] ?? '',
    reference_book_sha256: reference,
    files,
    scene: { sha256: sha256(edit.scene), chars: [...edit.scene].length, rxx: [...edit.rxx] },
    gate: {
      fact_table_sha256: factTable,
      regression_sha256: regression,
      protocol_bundle_sha256: freeze.protocol_bundle_sha256,
      benchmark_version: freeze.benchmark_version,
      eligible_gate_families: freeze.gate_families.filter(isFamily),
      seed_key: `postmerge:${decisionDirName(decisionSha256)}`,
    },
  });
}

/** Drift lines (`file changed: reference/09-scenes-and-people.md`, …) of the tree vs a pinned manifest; [] = ok. */
export function checkPostMerge(ctx: StepContext, pinned: PostMergeManifest): string[] {
  const out: string[] = [];
  for (const rel of Object.keys(pinned.files).sort(byCodeUnit)) {
    const path = join(ctx.repo, CANON_DIR, rel);
    if (!existsSync(path)) out.push(`file missing: ${rel}`);
    else if (sha256Bytes(readFileSync(path)) !== pinned.files[rel]) out.push(`file changed: ${rel}`);
  }
  return out;
}

function hexRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string' || !HEX64.test(v)) return null;
    out[k] = v;
  }
  return out;
}

export function parsePostMerge(value: unknown): Result<PostMergeManifest> {
  const bad = (what: string): Result<PostMergeManifest> => err(`post-merge.json: ${what}`);
  if (!isRecord(value) || value['kind'] !== 'post_merge') return bad('kind must be post_merge');
  const s = (key: string): string | null => readString(value, key);
  const round = s('round');
  const decision = s('decision_sha256');
  const base = s('base_sha');
  const revision = s('revision');
  const book = s('book_sha256');
  const reference = s('reference_book_sha256');
  if (round === null || base === null || revision === null) return bad('round, base_sha and revision are required');
  if (decision === null || book === null || reference === null || ![decision, book, reference].every((h) => HEX64.test(h))) return bad('decision, book and reference hashes must be SHA-256 hex');
  const files = hexRecord(value['files']);
  if (files === null) return bad('files must map paths to SHA-256 hex');
  const scene = readRecord(value, 'scene');
  const sceneSha = readString(scene, 'sha256');
  const chars = scene === null ? null : scene['chars'];
  const rxx = stringArray(scene === null ? null : scene['rxx']);
  if (sceneSha === null || !HEX64.test(sceneSha) || typeof chars !== 'number' || !Number.isInteger(chars) || rxx === null) return bad('scene needs sha256, chars and rxx');
  const gate = readRecord(value, 'gate');
  const g = (key: string): string | null => readString(gate, key);
  const fams = stringArray(gate === null ? null : gate['eligible_gate_families']);
  const factTable = g('fact_table_sha256');
  const regression = g('regression_sha256');
  const bundle = g('protocol_bundle_sha256');
  const version = g('benchmark_version');
  const seedKey = g('seed_key');
  if (factTable === null || regression === null || bundle === null || version === null || seedKey === null || fams === null) return bad('gate is incomplete');
  const families: Family[] = fams.filter(isFamily);
  if (families.length !== fams.length) return bad('gate.eligible_gate_families holds an unknown family');
  return ok({
    round, kind: 'post_merge', decision_sha256: decision, base_sha: base, revision, book_sha256: book, reference_book_sha256: reference, files,
    scene: { sha256: sceneSha, chars, rxx },
    gate: { fact_table_sha256: factTable, regression_sha256: regression, protocol_bundle_sha256: bundle, benchmark_version: version, eligible_gate_families: families, seed_key: seedKey },
  });
}

/** `merge/<d8>/post-merge.json`, null when absent. */
export function readPostMerge(paths: RoundPaths, d8: string): Result<PostMergeManifest> | null {
  const path = join(paths.merge, d8, POST_MERGE_FILE);
  if (!existsSync(path)) return null;
  try {
    return parsePostMerge(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return err(`rounds/${paths.id}/merge/${d8}/${POST_MERGE_FILE}: not valid JSON`);
  }
}
