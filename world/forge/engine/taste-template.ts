import { err, ok, type Result } from './result.ts';
import { isOneOf } from './tasks/fenced.ts';

/**
 * Benchmark `taste.template` rules (PROTOCOL §3): the four slots each exactly once, the decoy pair after both real
 * texts, no ``` fence, at most TASTE_TEMPLATE_MAX code points. parseBenchmark validates here (before a version can
 * be adopted or frozen); tasks/taste-pair.ts renders the same function with the real texts.
 */

/** Longest `taste.template` accepted (code points). */
export const TASTE_TEMPLATE_MAX = 2000;

export type TasteSlot = 'TEXT_1' | 'TEXT_2' | 'DECOY_PAIR' | 'QUESTIONS';

/** Each must occur exactly once in a template (`{TEXT_1}` …); no ``` fence allowed. */
export const PROMPT_SLOTS: readonly TasteSlot[] = ['TEXT_1', 'TEXT_2', 'DECOY_PAIR', 'QUESTIONS'];

export type TasteSlots = Record<TasteSlot, string>;

/** Slot values for validating a template without texts (parseBenchmark). */
export const TEMPLATE_PROBE_SLOTS: TasteSlots = { TEXT_1: '甲', TEXT_2: '乙', DECOY_PAIR: '', QUESTIONS: '问' };

/** A `{NAME}` slot token in a template. */
const SLOT_TOKEN = /\{([A-Z][A-Z0-9_]*)\}/gu;
/** Any one-line `{…}` in a template: each must be a PROMPT_SLOTS token. */
const BRACE_TOKEN = /\{([^{}\n]*)\}/gu;

/**
 * Substitutes the slots; err when a slot is missing or repeated, any other `{…}` or a stray brace remains, the
 * decoy pair does not come after both real texts (PROTOCOL §3: 放在真对之后), the template holds a ``` fence, or it
 * is longer than TASTE_TEMPLATE_MAX. parseBenchmark runs it with TEMPLATE_PROBE_SLOTS, so a bad template never becomes a benchmark version. Substitution is one pass over the template, so slot
 * values (texts) are never scanned for slots themselves.
 */
export function renderTasteTemplate(template: string, slots: TasteSlots): Result<string> {
  if ([...template].length > TASTE_TEMPLATE_MAX) return err(`template: longer than ${TASTE_TEMPLATE_MAX} chars`);
  if (template.includes('```')) return err('template: must not hold a ``` fence');
  const counts = new Map<TasteSlot, number>();
  const at = new Map<TasteSlot, number>();
  for (const m of template.matchAll(BRACE_TOKEN)) {
    const name = m[1] ?? '';
    if (!isOneOf(name, PROMPT_SLOTS)) return err(`template: unknown slot {${name}}`);
    counts.set(name, (counts.get(name) ?? 0) + 1);
    at.set(name, m.index);
  }
  if (/[{}]/u.test(template.replace(BRACE_TOKEN, ''))) return err('template: holds a stray { or } outside the slots');
  for (const slot of PROMPT_SLOTS) {
    const n = counts.get(slot) ?? 0;
    if (n !== 1) return err(`template: slot {${slot}} must occur exactly once, found ${n}`);
  }
  const decoyAt = at.get('DECOY_PAIR') ?? -1;
  if (decoyAt < (at.get('TEXT_1') ?? 0) || decoyAt < (at.get('TEXT_2') ?? 0)) return err('template: slot {DECOY_PAIR} must come after {TEXT_1} and {TEXT_2}');
  return ok(template.replace(SLOT_TOKEN, (whole: string, name: string) => (isOneOf(name, PROMPT_SLOTS) ? slots[name] : whole)));
}
