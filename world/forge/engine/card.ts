import type { ChampionKind } from './champions.ts';
import type { Family } from './config.ts';
import { readString, type JsonRecord } from './json.ts';
import type { PathInstanceNote } from './steps/gate-llm.ts';
import type { GateOutcome } from './tasks/gate-judge.ts';
import type { ColdRead } from './tasks/measures.ts';
import type { RoundTally, SubmissionMeasures } from './tally.ts';
import { IntegrityError } from './task.ts';
import type { Claim, WriterOutput } from './writer-output.ts';

/**
 * `rounds/RNN/card.json` (08): one entry per gate-passing submission, the engine half of the 9b decision card.
 * Flags are codes; CARD_FLAG_TEXT holds the Chinese labels the UI shows.
 */

export type CardFlag =
  | 'gate_judges_short'
  | 'gate_split'
  | 'defect_unverified'
  | 'trial'
  | 'layer3_red'
  | 'surprise_invalid'
  | 'probe_remote_unavailable'
  | 'acceptor_reused'
  | 'resubmitted';

export const CARD_FLAG_TEXT: Readonly<Record<CardFlag, string>> = {
  gate_judges_short: '⚑事实门评委不足',
  gate_split: '⚑事实门分歧',
  defect_unverified: '⚑缺陷抓取未验证',
  trial: '⚑试评（有效家族 ≤ 2，不可合并）',
  layer3_red: '⚑接口卡未通过',
  surprise_invalid: '⚑惊喜无效',
  probe_remote_unavailable: '⚑封存远端未核验',
  acceptor_reused: '⚑推理链由判定家族复核',
  resubmitted: '⚑重交稿',
};

export interface CardFact {
  /** delta claim id. */
  id: string;
  claim: string;
  kind: 'author_fact' | 'character_belief' | 'rumor';
  register: boolean;
  /** ⚑新专名 / ⚑贴近 F-ID / ⚑改变既有理解 (engine-detectable ones; [] when none). */
  flags: string[];
}

export interface CardEntry {
  submission: string;
  /** Writer slot (`W1` for `W1-r2`). */
  slot: string;
  label: string;
  resubmitted: boolean;
  flags: CardFlag[];
  /** false when trial (never replaces a champion, blocked from merge at 10a). */
  mergeable: boolean;
  wins: { total: number; needed: number; e: number; bar: string; beats_champion: boolean; by_family: Record<string, number> };
  gate: { outcome: GateOutcome; counted: Family[]; path_instance_notes: PathInstanceNote[] };
  /** From the cold reader's `who`, labelled 冷读者理解; null when the cold reader was void or inactive. */
  protagonist: { name: string; wants: string; cost: string | null; source: 'cold_reader' } | null;
  interface: { status: 'pass' | 'fail' | 'unjudged'; shots: string[]; object: string | null; hook: string | null; play_type: string | null };
  measures: SubmissionMeasures;
  facts: CardFact[];
  /** SHA-256 of the display text. */
  text_sha256: string;
}

export interface CardJson {
  v: 1;
  round: string;
  row_id: string;
  benchmark: string;
  /** Kind of the row's champion the pairs were judged against (`champion.json`): baseline, owner_pick or golden. */
  champion: ChampionKind;
  /** Round-level flags (surprise_invalid, probe_remote_unavailable). */
  flags: CardFlag[];
  entries: CardEntry[];
}

export interface CardSubmission {
  submission: string;
  slot: string;
  label: string;
  resubmitted: boolean;
  output: WriterOutput;
  displaySha256: string;
  gate: { outcome: GateOutcome; counted: Family[]; defectUnverified: boolean; pathInstanceNotes: PathInstanceNote[] };
  cold: ColdRead | null;
  /** surprise.json `acceptor_reused`: a fresh session of a matcher family accepted a chain (PROTOCOL §4 标注). */
  acceptorReused: boolean;
}

export interface CardInput {
  round: string;
  rowId: string;
  benchmark: string;
  /** Kind of the row's champion the pairs were judged against (`champion.json`): baseline, owner_pick or golden. */
  champion: ChampionKind;
  tally: RoundTally;
  unseal: { status: 'valid' | 'invalid'; remote: 'verified' | 'unavailable' | 'mismatch' };
  submissions: readonly CardSubmission[];
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const FLAG_ORDER: readonly CardFlag[] = [
  'gate_judges_short', 'gate_split', 'defect_unverified', 'trial', 'layer3_red', 'surprise_invalid', 'probe_remote_unavailable', 'acceptor_reused', 'resubmitted',
];

function inFlagOrder(flags: ReadonlySet<CardFlag>): CardFlag[] {
  return FLAG_ORDER.filter((f) => flags.has(f));
}

function text(rec: JsonRecord | null, key: string): string | null {
  const v = readString(rec, key)?.trim() ?? '';
  return v === '' ? null : v;
}

/** Shot title for the card: 地点 · 主体人物与动作 (whichever the writer filled). */
function shotTitle(shot: JsonRecord): string {
  return [text(shot, '地点'), text(shot, '主体人物与动作')].filter((v) => v !== null).join(' · ');
}

/** ⚑新专名 when the claim names one of the submission's new proper nouns; ⚑贴近 F-ID when it extends an F-ID. */
function factFlags(claim: Claim, newNouns: readonly string[]): string[] {
  const flags: string[] = [];
  if (newNouns.some((n) => n !== '' && claim.claim.includes(n))) flags.push('⚑新专名');
  if (/^F\d{2}\b/u.test(claim.extends.trim())) flags.push('⚑贴近 F-ID');
  return flags;
}

function cardFacts(output: WriterOutput): CardFact[] {
  return output.delta.claims.map((c) => ({ id: c.id, claim: c.claim, kind: c.kind, register: c.register, flags: factFlags(c, output.delta.newProperNouns) }));
}

function cardEntry(sub: CardSubmission, input: CardInput): CardEntry {
  const pair = input.tally.champion_pairs.find((p) => p.submission === sub.submission) ?? null;
  const measures = input.tally.measures[sub.submission];
  if (measures === undefined) throw new IntegrityError(`tally.json has no measures for card submission ${sub.submission}`);
  const trial = pair === null || pair.trial;
  const flags = new Set<CardFlag>();
  if (sub.gate.outcome === 'unverified') flags.add('gate_judges_short');
  if (sub.gate.outcome === 'split') flags.add('gate_split');
  if (sub.gate.defectUnverified) flags.add('defect_unverified');
  if (trial) flags.add('trial');
  if (measures.interface !== 'pass') flags.add('layer3_red');
  if (sub.acceptorReused) flags.add('acceptor_reused');
  if (sub.resubmitted) flags.add('resubmitted');
  const hook = sub.output.iface.hook;
  return {
    submission: sub.submission,
    slot: sub.slot,
    label: sub.label,
    resubmitted: sub.resubmitted,
    flags: inFlagOrder(flags),
    mergeable: !trial,
    wins: pair === null
      ? { total: 0, needed: 0, e: 0, bar: 'trial', beats_champion: false, by_family: {} }
      : { total: pair.total_wins, needed: pair.needed, e: pair.e.length, bar: pair.bar, beats_champion: pair.beats_champion, by_family: { ...pair.wins_by_family } },
    gate: { outcome: sub.gate.outcome, counted: [...sub.gate.counted], path_instance_notes: sub.gate.pathInstanceNotes.map((n) => ({ ...n })) },
    protagonist: sub.cold === null ? null : { name: sub.cold.who.name, wants: sub.cold.who.wants, cost: sub.cold.who.cost, source: 'cold_reader' },
    interface: {
      status: measures.interface,
      shots: sub.output.iface.shots.map(shotTitle),
      object: text(sub.output.iface.object, '名称') ?? text(sub.output.iface.object, '位置'),
      hook: text(hook, '玩家不来时会发生什么'),
      play_type: text(hook, '玩法类型'),
    },
    measures,
    facts: cardFacts(sub.output),
    text_sha256: sub.displaySha256,
  };
}

/**
 * card.json for every gate-passing submission, in label order. Entry flags: ⚑事实门评委不足 (gate unverified),
 * gate split, defect_unverified, trial (|E| ≤ 2 or no champion pair: never mergeable), layer 3 red (interface
 * fail or unjudged), acceptor reused, resubmitted. Round flags: surprise invalid (unseal invalid), probe remote
 * unavailable. The protagonist line is the cold reader's `who` (null when it was void or inactive).
 */
export function buildCard(input: CardInput): CardJson {
  const round = new Set<CardFlag>();
  if (input.unseal.status === 'invalid') round.add('surprise_invalid');
  if (input.unseal.remote === 'unavailable') round.add('probe_remote_unavailable');
  const entries = input.submissions.map((s) => cardEntry(s, input)).sort((a, b) => byCodeUnit(a.label, b.label) || byCodeUnit(a.submission, b.submission));
  return { v: 1, round: input.round, row_id: input.rowId, benchmark: input.benchmark, champion: input.champion, flags: inFlagOrder(round), entries };
}
