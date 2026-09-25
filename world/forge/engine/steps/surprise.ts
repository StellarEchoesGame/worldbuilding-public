import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Family } from '../config.ts';
import type { StepContext } from '../context.ts';
import { isRecord, readString } from '../json.ts';
import { parseSealedForecasts, probeFiles, readProbeFile, unseal, type SealedForecasts } from '../probe.ts';
import { err, ok, type Result } from '../result.ts';
import { runAll, type StepDef, type StepOutcome } from '../runner.ts';
import { verifySeal } from '../seal.ts';
import { readJson } from '../store.ts';
import { IntegrityError, runSealedTask, runTask } from '../task.ts';
import { pickFamilies, surpriseRoles, type SurpriseRoles } from '../tasks/assign.ts';
import { surpriseTaskId } from '../tasks/ids.ts';
import { renderMeasurePrompt, type Detail } from '../tasks/measures.ts';
import {
  acceptTask, canonContexts, chainAuthors, chainTask, classifyForecast, detailContexts, flattenForecasts, matchTask,
  type AcceptVerdict, type Chain, type DetailOutcome, type MatchVerdict, type OpaqueForecast, type SurpriseDetail, type SurpriseReport,
} from '../tasks/surprise.ts';
import { readBriefJson, type BriefJson } from './brief.ts';
import { judgeBackend, passingSubmissions } from './gate-llm.ts';
import { loadMeasured, measurePath, measurePool, readRecallFile, type MeasuredText } from './measures.ts';

/** `rounds/RNN/unseal.json` (07a): the probe.ts unseal result without forecasts; 11a never rewrites it. */
export interface UnsealFile {
  round: string;
  status: 'valid' | 'invalid';
  reasons: string[];
  remote: 'verified' | 'unavailable' | 'mismatch';
  /** Valid forecasters in the seal (0 when invalid). */
  forecasters: number;
  checked_at: string;
}

/** `rounds/RNN/surprise.json` (07b; absent when 07b skipped: unseal invalid or measures.surprise inactive). */
export interface SurpriseFile {
  round: string;
  remote: UnsealFile['remote'];
  submissions: Record<string, SurpriseReport>;
}


/** `rounds/RNN/unseal.json`. */
export function unsealPath(ctx: Pick<StepContext, 'paths'>): string {
  return join(ctx.paths.dir, 'unseal.json');
}

const REMOTES: ReadonlyArray<UnsealFile['remote']> = ['verified', 'unavailable', 'mismatch'];

/** Reads and narrows `unseal.json` (07b, 08, 11a). */
export function readUnsealFile(ctx: Pick<StepContext, 'paths'>): Result<UnsealFile> {
  const rel = `rounds/${ctx.paths.id}/unseal.json`;
  const raw = readJson(unsealPath(ctx));
  if (!isRecord(raw)) return err(`${rel} is missing or not a JSON object`);
  const round = readString(raw, 'round');
  const status = readString(raw, 'status');
  const remote = REMOTES.find((r) => r === raw['remote']);
  const reasons = raw['reasons'];
  const forecasters = raw['forecasters'];
  const checkedAt = readString(raw, 'checked_at');
  if (round === null || (status !== 'valid' && status !== 'invalid') || remote === undefined || checkedAt === null) return err(`${rel}: needs round, status, remote and checked_at`);
  if (!Array.isArray(reasons) || !reasons.every((r) => typeof r === 'string')) return err(`${rel}: reasons must be strings`);
  if (typeof forecasters !== 'number' || !Number.isInteger(forecasters) || forecasters < 0) return err(`${rel}: forecasters must be a count`);
  return ok({ round, status, reasons: reasons.filter((r): r is string => typeof r === 'string'), remote, forecasters, checked_at: checkedAt });
}

/**
 * 07a-unseal: probe.ts unseal(ctx) → `unseal.json` (no plaintext). Invalid is a result, never a failed step; GitHub
 * down → remote `unavailable`. A valid seal with zero forecasters (every forecaster void) is recorded invalid.
 * Inputs list the sealed files (hashed as local) and `probes.sha256`, `probe.json`.
 */
export const unsealStep: StepDef = {
  id: '07a-unseal',
  run: async (ctx) => {
    const result = await unseal(ctx);
    const count = result.status === 'valid' && result.forecasts !== null ? result.forecasts.forecasts.length : 0;
    const empty = result.status === 'valid' && count === 0;
    const file: UnsealFile = {
      round: ctx.roundId,
      status: empty ? 'invalid' : result.status,
      reasons: empty ? ['forecasters: every forecaster was void, the seal holds no forecast'] : result.reasons.map((r) => ctx.redact(r)),
      remote: result.remote,
      forecasters: empty ? 0 : count,
      checked_at: ctx.ports.clock.now(),
    };
    const output = ctx.files.writeJson(unsealPath(ctx), file);
    const f = probeFiles(ctx.paths);
    const inputs = [f.probes, f.probe, f.sealed, f.nonce].filter((p) => existsSync(p)).map((p) => ctx.files.rel(p));
    ctx.progress('07a-unseal', 'info', `${file.status}, remote ${file.remote}, ${file.forecasters} forecasters${file.reasons.length > 0 ? `: ${file.reasons.join('; ')}` : ''}`);
    return { kind: 'done', inputs, outputs: [output], external: [] };
  },
};

/** The sealed forecasts, re-verified against probes.sha256 (07a found them valid; a mismatch now is integrity). */
function readVerifiedSeal(ctx: StepContext): SealedForecasts {
  const f = probeFiles(ctx.paths);
  const probe = readProbeFile(ctx.paths);
  const sealedText = existsSync(f.sealed) ? readFileSync(f.sealed, 'utf8') : null;
  const nonceText = existsSync(f.nonce) ? readFileSync(f.nonce, 'utf8') : null;
  const broken = `rounds/${ctx.roundId}/unseal.json is valid but the seal no longer verifies against probes.sha256`;
  if (!probe.ok || sealedText === null || nonceText === null || !verifySeal(sealedText, nonceText.trim(), probe.value)) throw new IntegrityError(broken);
  let raw: unknown;
  try {
    raw = JSON.parse(sealedText);
  } catch {
    throw new IntegrityError(broken);
  }
  const parsed = parseSealedForecasts(raw);
  if (!parsed.ok) throw new IntegrityError(`${broken}: ${parsed.error}`);
  return parsed.value;
}

interface SurpriseEnv {
  forecasts: readonly OpaqueForecast[];
  measure: { active: boolean; prompt: string | null };
  brief: BriefJson;
  seed: string;
}

/**
 * The acceptor: the seeded fourth family unless it authored a quoted text (canon → CANON_AUTHOR) or wrote the chain;
 * else another fresh eligible family (seeded, key `accept:<sub>`); else a fresh session of an eligible matcher family
 * (acceptor_reused); null when every family is excluded.
 */
function pickAcceptor(roles: SurpriseRoles, pool: readonly Family[], quotedAuthors: readonly Family[], seed: string, submission: string): { family: Family; reused: boolean } | null {
  const excluded = new Set<Family>(quotedAuthors);
  if (roles.chainWriter !== null) excluded.add(roles.chainWriter);
  if (roles.acceptor !== null && !roles.acceptorReused && !excluded.has(roles.acceptor)) return { family: roles.acceptor, reused: false };
  const fresh = pool.filter((f) => !roles.matchers.includes(f) && !excluded.has(f));
  const picked = pickFamilies(fresh, 1, seed, `accept:${submission}`)[0];
  if (picked !== undefined) return { family: picked, reused: false };
  const matcher = roles.matchers.find((f) => !excluded.has(f));
  return matcher === undefined ? null : { family: matcher, reused: true };
}

async function surpriseOne(ctx: StepContext, env: SurpriseEnv, m: MeasuredText, details: readonly Detail[]): Promise<SurpriseReport> {
  const sub = m.id;
  const pool = measurePool(ctx, sub, [m.family]);
  const roles = surpriseRoles(pool, env.seed, sub);
  const tasks: string[] = [];
  const outcome = new Map<string, DetailOutcome>();
  const chainOf = new Map<string, Chain>();
  const reasonOf = new Map<string, string>();
  let verdicts: Array<MatchVerdict | null> = [];
  let chains: Chain[] = [];
  let acceptor: { family: Family; reused: boolean } | null = null;
  const context = detailContexts(details, m.text);
  const markAll = (list: readonly { id: string }[], o: DetailOutcome): void => {
    for (const d of list) outcome.set(d.id, o);
  };
  if (roles.status === 'insufficient') markAll(details, 'unresolved');
  else if (details.length > 0) {
    const specs = roles.matchers.map((family) => ({ family, spec: matchTask(details, context, env.forecasts, env.measure, surpriseTaskId('match', sub, family), env.seed) }));
    tasks.push(...specs.map((s) => s.spec.id));
    // The matchers alone see forecast values: their raw replies (and records) stay under `.sealed/RNN/`, never `rounds/`.
    verdicts = await runAll(ctx, specs.map(({ family, spec }) => async () => (await runSealedTask(ctx, judgeBackend(ctx, family), spec)).value));
    const classes = classifyForecast(verdicts[0] ?? null, verdicts[1] ?? null, details.map((d) => d.id));
    const open = details.filter((d) => classes[d.id] === 'open');
    markAll(details.filter((d) => classes[d.id] !== 'open'), 'forecast');
    const writer = roles.chainWriter;
    if (open.length > 0 && (writer === null || env.brief.canon_passages.length === 0)) markAll(open, 'unresolved');
    else if (open.length > 0 && writer !== null) {
      const spec = chainTask(open, context, env.brief.canon_passages, surpriseTaskId('chain', sub, writer), env.seed);
      tasks.push(spec.id);
      const set = (await runTask(ctx, judgeBackend(ctx, writer), spec)).value;
      if (set === null) markAll(open, 'unresolved');
      else {
        chains = set.chains;
        for (const c of chains) chainOf.set(c.detail, c);
        markAll(chains.filter((c) => c.canon === null).map((c) => ({ id: c.detail })), 'drift');
        const offered = chains.filter((c) => c.canon !== null).map((c) => ({ id: c.detail }));
        if (offered.length > 0) {
          acceptor = pickAcceptor(roles, pool, chainAuthors(chains), env.seed, sub);
          if (acceptor === null) markAll(offered, 'unresolved');
          else {
            const aSpec = acceptTask(chains, details, canonContexts(chains, env.brief.canon_passages), surpriseTaskId('accept', sub, acceptor.family), env.seed);
            tasks.push(aSpec.id);
            const v: AcceptVerdict | null = (await runTask(ctx, judgeBackend(ctx, acceptor.family), aSpec)).value;
            for (const { id } of offered) {
              const item = v?.verdicts.find((x) => x.detail === id);
              outcome.set(id, item === undefined ? 'unresolved' : item.accept ? 'surprising' : 'drift');
              if (item !== undefined) reasonOf.set(id, item.reason);
            }
          }
        }
      }
    }
  }
  const matched = (id: string): string[] => [...new Set(verdicts.flatMap((v) => (v === null ? [] : v.matches.flatMap((x) => (x.detail === id && x.forecast !== null ? [x.forecast] : [])))))].sort();
  const out: SurpriseDetail[] = details.map((d) => {
    const ids = matched(d.id);
    return {
      id: d.id, image: d.image, quote: d.quote, families: d.families, outcome: outcome.get(d.id) ?? 'unresolved', forecasts: ids,
      writer_default: ids.some((fid) => env.forecasts.some((f) => f.id === fid && f.writerModel && f.model === m.model)),
      chain: chainOf.get(d.id) ?? null, accept_reason: reasonOf.get(d.id) ?? null,
    };
  });
  const count = (o: DetailOutcome): number => out.filter((d) => d.outcome === o).length;
  return {
    submission: sub,
    status: roles.status === 'full' && acceptor?.reused === true ? 'reused' : roles.status,
    surprising: count('surprising'), eligible: out.length - count('unresolved'), drift: count('drift'), unresolved: count('unresolved'), forecast: count('forecast'),
    details: out, chains, acceptor_reused: acceptor?.reused ?? false,
    roles: { matchers: roles.matchers, chain_writer: roles.chainWriter, acceptor: acceptor?.family ?? null },
    tasks,
  };
}

/** `rounds/RNN/surprise.json`. */
export function surprisePath(ctx: Pick<StepContext, 'paths'>): string {
  return join(ctx.paths.dir, 'surprise.json');
}

/** A skipping 07b removes the surprise.json of an earlier run (e.g. `--redo-from 07a` after the probe comment changed). */
function skipSurprise(ctx: StepContext, reason: string): StepOutcome {
  if (existsSync(surprisePath(ctx))) ctx.files.remove(surprisePath(ctx));
  return { kind: 'skip', reason };
}

/**
 * The engine half of 07b for the given submissions (the step passes passingSubmissions): skip when unseal.json is
 * invalid or the measure is inactive; else per submission matchers ×2, chain writer, acceptor. Exported for tests.
 */
export async function surpriseFor(ctx: StepContext, submissions: readonly string[]): Promise<StepOutcome> {
  const unsealed = readUnsealFile(ctx);
  if (!unsealed.ok) throw new IntegrityError(unsealed.error);
  if (unsealed.value.status !== 'valid') return skipSurprise(ctx, 'unseal invalid');
  const bench = ctx.benchmark();
  const measure = bench.measures.surprise;
  if (!measure.active) return skipSurprise(ctx, `benchmark ${bench.version} measures.surprise inactive`);
  const checked = measure.prompt === null ? null : renderMeasurePrompt(measure.prompt);
  if (checked !== null && !checked.ok) return { kind: 'failed', detail: `benchmark ${bench.version} measures.surprise.prompt: ${checked.error}` };
  const env: SurpriseEnv = { forecasts: flattenForecasts(readVerifiedSeal(ctx)), measure, brief: readBriefJson(ctx), seed: ctx.seed() };
  const f = probeFiles(ctx.paths);
  const inputs = [unsealPath(ctx), ctx.paths.brief, f.probes, f.sealed, f.nonce].map((p) => ctx.files.rel(p));
  const jobs: Array<() => Promise<SurpriseReport>> = [];
  for (const sub of submissions) {
    const m = loadMeasured(ctx, sub);
    if (!m.ok) return { kind: 'failed', detail: m.error };
    const recall = readRecallFile(ctx, sub);
    if (!recall.ok) return { kind: 'failed', detail: recall.error };
    inputs.push(m.value.file, ctx.files.rel(measurePath(ctx, 'recall', sub)));
    jobs.push(() => surpriseOne(ctx, env, m.value, recall.value.details));
  }
  const reports = await runAll(ctx, jobs);
  const file: SurpriseFile = { round: ctx.roundId, remote: unsealed.value.remote, submissions: Object.fromEntries(reports.map((r) => [r.submission, r])) };
  const output = ctx.files.writeJson(surprisePath(ctx), file);
  ctx.progress('07b-surprise', 'info', reports.map((r) => `${r.submission}: ${r.status} ${r.surprising}/${r.eligible} surprising, ${r.forecast} forecast, ${r.drift} drift, ${r.unresolved} unresolved`).join('; '));
  return { kind: 'done', inputs, outputs: [output], external: [] };
}

/**
 * 07b-surprise: per passing submission — details from `measures/recall/<sub>.json`, forecasts flattened P01…,
 * surpriseRoles(pool, seed, sub), matchers ×2, chain writer, acceptor (never a chain-quoted author family). skip
 * when unseal is invalid or the measure is inactive. Output `surprise.json`.
 */
export const surpriseStep: StepDef = {
  id: '07b-surprise',
  run: async (ctx) => {
    const unsealed = readUnsealFile(ctx);
    if (unsealed.ok && unsealed.value.status !== 'valid') return skipSurprise(ctx, 'unseal invalid');
    const passing = passingSubmissions(ctx);
    if (!passing.ok) return { kind: 'failed', detail: `07b: ${passing.error}` };
    return surpriseFor(ctx, passing.value);
  },
};
