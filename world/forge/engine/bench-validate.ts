import { isRecord, readArray, readNumber, readRecord, readString, stringArray, type JsonRecord } from './json.ts';
import { validate, type Schema } from './schema.ts';

export type Activation = 'auto' | 'replay' | 'owner';

export interface RollbackEntry {
  round: number;
  rolledBackKeys: string[];
}

/**
 * Changes are detected over MAINTAINER_KEYS plus every key of `activation`; a changed key without an activation
 * class is an error, so a narrowed activation map cannot hide a change.
 */
export interface BenchContext {
  schema: Schema;
  activation: Record<string, Activation>;
  protectedKeys: string[];
  currentRound: number;
  rollbacks: RollbackEntry[];
  holdRounds: number;
}

export interface BenchVerdict {
  ok: boolean;
  errors: string[];
  changedKeys: string[];
  activation: Activation | null;
  noChange: boolean;
}

export const MAINTAINER_KEYS: readonly string[] = ['taste', 'measures', 'cliche_list', 'interface_checklist_extra', 'decoy_recipe', 'baseline_rebuilds', 'bars'];

export const DEFAULT_ACTIVATION: Readonly<Record<string, Activation>> = {
  taste: 'replay',
  measures: 'auto',
  cliche_list: 'auto',
  interface_checklist_extra: 'auto',
  decoy_recipe: 'owner',
  baseline_rebuilds: 'owner',
  bars: 'auto',
};

export const META_KEYS: readonly string[] = ['version', 'parent', 'created_at', 'author', 'reasons'];

export const PROTECTED_KEYS: readonly string[] = [
  'gate',
  'forbidden_words',
  'defect_list',
  'facts',
  'fact_status',
  'regression',
  'sealing',
  'anonymization',
  'session_pairs',
  'eligibility',
  'void_rules',
  'agreement',
  'mergecheck',
  'owner_rules',
  'champions',
  'writers',
  'canon',
];

export const DEFAULT_HOLD_ROUNDS = 3;

const STRENGTH: Record<Activation, number> = { auto: 0, replay: 1, owner: 2 };

/** Canonical form for change detection: sorted object keys; an absent value is distinct from every JSON value. */
function stableStringify(value: unknown): string {
  if (value === undefined) return '#absent';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function schemaErrors(candidate: unknown, ctx: BenchContext): string[] {
  const errors: string[] = [];
  const protectedHere = isRecord(candidate) ? Object.keys(candidate).filter((k) => ctx.protectedKeys.includes(k)) : [];
  for (const key of protectedHere) errors.push(`protected key ${key}`);
  const shadowed = new Set(protectedHere.map((k) => `$: unexpected property ${k}`));
  for (const e of validate(ctx.schema, candidate)) if (!shadowed.has(e)) errors.push(e);
  return errors;
}

function comparedKeys(ctx: BenchContext): string[] {
  return [...new Set([...MAINTAINER_KEYS, ...Object.keys(ctx.activation)])];
}

function changedKeysOf(candidate: JsonRecord, parent: JsonRecord | null, ctx: BenchContext): string[] {
  return comparedKeys(ctx).filter((key) => {
    const before = parent === null ? undefined : parent[key];
    return stableStringify(candidate[key]) !== stableStringify(before);
  });
}

function evidencedKeys(candidate: JsonRecord): Set<string> {
  const out = new Set<string>();
  for (const reason of readArray(candidate, 'reasons') ?? []) {
    const keys = stringArray(isRecord(reason) ? reason['keys'] : null);
    const evidence = stringArray(isRecord(reason) ? reason['evidence_ids'] : null);
    if (keys === null || evidence === null || evidence.length === 0) continue;
    for (const key of keys) out.add(key);
  }
  return out;
}

function strongestActivation(changed: readonly string[], ctx: BenchContext): Activation {
  let strongest: Activation = 'auto';
  for (const key of changed) {
    const cls = ctx.activation[key] ?? 'owner';
    if (STRENGTH[cls] > STRENGTH[strongest]) strongest = cls;
  }
  const inHold = ctx.rollbacks.some((r) => ctx.currentRound - r.round < ctx.holdRounds && r.rolledBackKeys.some((k) => changed.includes(k)));
  return inHold ? 'owner' : strongest;
}

export function validateBenchmark(candidate: unknown, parent: unknown | null, ctx: BenchContext): BenchVerdict {
  const errors = schemaErrors(candidate, ctx);
  if (!isRecord(candidate)) return { ok: false, errors, changedKeys: [], activation: null, noChange: false };
  const parentRecord = isRecord(parent) ? parent : null;
  if (parent !== null && parentRecord === null) errors.push('parent benchmark must be an object');
  // Only a root version (candidate.parent null) may be validated without its parent; it is exempt from the evidence rule.
  const claimedParent = candidate['parent'];
  if (parent === null && typeof claimedParent === 'string') errors.push(`candidate names parent ${claimedParent}; the parent benchmark is required`);

  const changedKeys = changedKeysOf(candidate, parentRecord, ctx);
  const noChange = changedKeys.length === 0;
  // Nothing maintainer-owned changes, so no version is adopted and linkage/evidence are moot.
  if (noChange) return { ok: errors.length === 0, errors, changedKeys, activation: null, noChange };

  for (const key of changedKeys) if (!Object.hasOwn(ctx.activation, key)) errors.push(`no activation class for ${key}`);

  if (parentRecord !== null) {
    const parentVersion = readString(parentRecord, 'version');
    const claimed = candidate['parent'];
    if (parentVersion === null) errors.push('parent has no version');
    else if (claimed !== parentVersion) errors.push(`parent must be ${parentVersion}, got ${String(claimed)}`);

    const evidenced = evidencedKeys(candidate);
    for (const key of changedKeys) if (!evidenced.has(key)) errors.push(`changed key ${key} has no reason with evidence`);

    const barBefore = readNumber(readRecord(parentRecord, 'bars'), 'beats_champion_four_families');
    const barAfter = readNumber(readRecord(candidate, 'bars'), 'beats_champion_four_families');
    if (barBefore !== null && barAfter !== null && barAfter < barBefore) {
      errors.push(`bars.beats_champion_four_families may not decrease (${barBefore} → ${barAfter})`);
    }
  }

  const ok = errors.length === 0;
  return { ok, errors, changedKeys, activation: ok ? strongestActivation(changedKeys, ctx) : null, noChange };
}
