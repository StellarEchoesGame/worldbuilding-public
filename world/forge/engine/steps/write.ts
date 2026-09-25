import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Backend } from '../adapters/types.ts';
import { parseCell, type Cell } from '../brief.ts';
import type { StepContext } from '../context.ts';
import type { FreezeRecord } from '../freeze.ts';
import { isDone, sha256Bytes } from '../marker.ts';
import { err, ok, type Result } from '../result.ts';
import { runAll, type StepDef, type StepOutcome } from '../runner.ts';
import { seededShuffle } from '../store.ts';
import { IntegrityError, runTask } from '../task.ts';
import { isConsequenceStance, writerTask, type SkillSnapshot } from '../tasks/writing.ts';
import { DEFAULT_STANCES, readBriefJson } from './brief.ts';

export const SKILL_SYSTEMIC = 'systemic-worldbuilding';
export const SKILL_METABOLIC = 'metabolic-cultures';
/** Tracked snapshots under `skills/<name>.md`; 02c pins their SHA-256 in `freeze.json.skills`. */
export const SKILL_NAMES: readonly string[] = [SKILL_SYSTEMIC, SKILL_METABOLIC];

/** `R07` → 7 (the Latin-square row); any other id → err. */
export function roundNumber(roundId: string): Result<number> {
  const m = /^[A-Z](\d{2})$/u.exec(roundId);
  return m === null ? err(`bad round id ${roundId}`) : ok(Number(m[1]));
}

/**
 * Slot i of round r gets stances[(i + r) mod stances.length]: a cyclic Latin square, so within a round the slots
 * get distinct stances (while slots ≤ stances) and over stances.length consecutive rounds each slot writes each
 * stance once. Pass the cell's own stance ids when it has any, else DEFAULT_STANCES.
 */
export function stanceSchedule(round: number, slots: readonly string[], stances: readonly string[]): Record<string, string> {
  const n = stances.length;
  if (n === 0) throw new Error('stanceSchedule: no stances');
  const out: Record<string, string> = {};
  slots.forEach((slot, i) => {
    const stance = stances[(((i + round) % n) + n) % n];
    if (stance === undefined) throw new Error('stanceSchedule: index out of range');
    out[slot] = stance;
  });
  return out;
}

/**
 * 母舰 cells (row SHIP) and neighbourhood cells get metabolic-cultures for one slot (epic step 4, R1 note). A
 * neighbourhood cell of another row declares itself by the word 邻里 in its title (documented cell convention).
 */
export function isMetabolicCell(cell: Cell): boolean {
  return cell.rowId === 'SHIP' || /邻里/u.test(cell.title);
}

/** A cell's stance ids must be canonical (DEFAULT_STANCES), so the skill schedule cannot silently miss one. */
export function checkStanceIds(ids: readonly string[]): Result<void> {
  const known = DEFAULT_STANCES.map((st) => st.id);
  const unknown = ids.filter((id) => !known.includes(id));
  return unknown.length === 0 ? ok(undefined) : err(`unknown stance id(s) ${unknown.join(', ')}; the cell's stances must be among ${known.join(', ')}`);
}

/** The round's slot → stance schedule, needed to pick the one metabolic slot among the non-consequence slots. */
export interface SkillPlan {
  round: string;
  schedule: Readonly<Record<string, string>>;
}

/** The one seeded non-consequence slot (key `skill:<round>`) of a 母舰 / neighbourhood cell, else null. */
export function metabolicSlot(cell: Cell, seed: string, plan: SkillPlan): string | null {
  if (!isMetabolicCell(cell)) return null;
  const candidates = Object.keys(plan.schedule)
    .filter((slot) => !isConsequenceStance(plan.schedule[slot] ?? ''))
    .sort();
  return seededShuffle(candidates, seed, `skill:${plan.round}`)[0] ?? null;
}

/**
 * Consequence stance → 'systemic-worldbuilding'; in 母舰 / neighbourhood cells one seeded non-consequence slot
 * (key `skill:<round>`) → 'metabolic-cultures'; other scene-first stances → null.
 */
export function skillFor(stance: string, cell: Cell, slot: string, seed: string, plan: SkillPlan): string | null {
  if (isConsequenceStance(stance)) return SKILL_SYSTEMIC;
  return metabolicSlot(cell, seed, plan) === slot ? SKILL_METABOLIC : null;
}

/** The snapshot text a writer sees: the file without its leading provenance comment. */
export function snapshotBody(text: string): string {
  const m = /^<!--[\s\S]*?-->\s*/u.exec(text);
  return (m === null ? text : text.slice(m[0].length)).trimEnd();
}

/** Reads `skills/<name>.md` and checks it against the 02c pin (drift → IntegrityError, exit 3). */
export function loadSkill(root: string, name: string, freeze: FreezeRecord): Result<SkillSnapshot & { rel: string }> {
  const rel = `skills/${name}.md`;
  const pinned = freeze.skills[name];
  if (pinned === undefined) return err(`skill snapshot ${name} is not pinned in freeze.json`);
  const path = join(root, rel);
  if (!existsSync(path)) throw new IntegrityError(`${rel} pinned by 02c-freeze is missing`);
  const bytes = readFileSync(path);
  if (sha256Bytes(bytes) !== pinned) throw new IntegrityError(`${rel}: pinned skill snapshot changed since 02c-freeze`);
  return ok({ name, text: snapshotBody(bytes.toString('utf8')), rel });
}

function failed(detail: string): StepOutcome {
  return { kind: 'failed', detail };
}

interface SlotPlan {
  slot: string;
  backend: Backend;
  stance: string;
  skill: (SkillSnapshot & { rel: string }) | null;
}

/**
 * 04-write: precondition `probe.json` + a final 03c marker + `freeze.probe_created_at` (independent of ordering:
 * writers never run before the probe is public); stances by stanceSchedule, skills by skillFor from the pinned
 * snapshots; the writer tasks run in parallel and each lands in `submissions/<slot>.json` (void → `ok: false`).
 */
export const writeStep: StepDef = {
  id: '04-write',
  run: async (ctx) => {
    const probe = join(ctx.paths.dir, 'probe.json');
    if (!existsSync(probe)) return failed('precondition: probe.json is missing; writers run only after 03c-probe-mirror published the probe');
    if (!isDone(ctx, '03c-probe-mirror')) return failed('precondition: 03c-probe-mirror is not marked');
    const freeze = ctx.freeze();
    if (freeze.probe_created_at === null) return failed('precondition: freeze.json has no probe_created_at');
    const brief = readBriefJson(ctx);
    const cell = parseCell(brief.cell);
    if (!cell.ok) throw new IntegrityError(`rounds/${ctx.roundId}/brief.json: ${cell.error}`);
    const round = roundNumber(ctx.roundId);
    if (!round.ok) return failed(round.error);
    const writers = ctx.backends.writers;
    if (writers.length === 0) return failed('no writer slots configured (writers.json)');
    const stances = cell.value.stances.length > 0 ? cell.value.stances.map((s) => s.id) : DEFAULT_STANCES.map((s) => s.id);
    const stanceCheck = checkStanceIds(stances);
    if (!stanceCheck.ok) return { kind: 'failed', detail: `04-write: ${stanceCheck.error}` };
    const schedule = stanceSchedule(round.value, writers.map((w) => w.slot), stances);
    const seed = ctx.seed();
    const plans: SlotPlan[] = [];
    for (const w of writers) {
      const stance = schedule[w.slot] ?? '';
      const name = skillFor(stance, cell.value, w.slot, seed, { round: ctx.roundId, schedule });
      const skill = name === null ? null : loadSkill(ctx.root, name, freeze);
      if (skill !== null && !skill.ok) return failed(skill.error);
      plans.push({ slot: w.slot, backend: w.backend, stance, skill: skill === null ? null : skill.value });
    }
    const results = await runAll(
      ctx,
      plans.map((plan) => async () => {
        const spec = writerTask(brief, plan.slot, plan.stance, plan.skill === null ? null : { name: plan.skill.name, text: plan.skill.text });
        const r = await runTask(ctx, plan.backend, spec);
        const rel = ctx.files.writeJson(join(ctx.paths.submissions, `${plan.slot}.json`), {
          id: plan.slot,
          kind: 'writer',
          task: spec.id,
          model: plan.backend.model,
          served_model: r.last?.servedModel ?? null,
          family: plan.backend.family,
          stance: plan.stance,
          skill: plan.skill === null ? null : plan.skill.name,
          ok: r.value !== null,
          error: r.error,
          attempts: r.attempts,
          text: r.value === null ? '' : (r.last?.text ?? ''),
        });
        return { rel, ok: r.value !== null };
      }),
    );
    const good = results.filter((r) => r.ok).length;
    ctx.progress('04-write', good === results.length ? 'info' : 'error', `${good}/${results.length} submissions`);
    const skills = [...new Set(plans.flatMap((p) => (p.skill === null ? [] : [p.skill.rel])))].sort();
    return { kind: 'done', inputs: [ctx.files.rel(ctx.paths.brief), ctx.files.rel(probe), ...skills], outputs: results.map((r) => r.rel), external: [] };
  },
};
