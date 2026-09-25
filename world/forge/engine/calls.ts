import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Backend, CallResult } from './adapters/types.ts';
import type { QuotaPolicy, RunHooks } from './context.ts';
import { failure } from './adapters/types.ts';
import { isRecord, readBoolean, readNumber, readString } from './json.ts';
import type { Result } from './result.ts';
import { readJson, sha256, writeJson, writeText, type RoundPaths } from './store.ts';

export function limiter(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    while (active >= n) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}

/**
 * Where call records go: `RoundFiles` (context.ts) in every engine pipeline; the plain store writers only for
 * the prototype runner (P01), which passes no options.
 */
export interface CallWriter {
  writeJson(path: string, value: unknown): unknown;
  writeText(path: string, text: string): unknown;
}

const PLAIN_WRITER: CallWriter = { writeJson, writeText };

export interface CallRecordMeta {
  files?: CallWriter;
  /** Clock time just before the backend call; defaults to `at`. */
  startedAt?: string;
  /** Clock time of the record; defaults to the system clock (prototype only). */
  at?: string;
  /** A quota try (`<id>-a<k>-q<n>`): recorded for cost and provenance, never recovered or counted. */
  quota?: boolean;
}

/** `.runs/<RNN>/<label>.out.txt`: the exact output text, written before the call JSON. */
export function callOutputPath(paths: RoundPaths, label: string): string {
  return join(paths.runs, `${label}.out.txt`);
}

/** `calls/<label>.json`: the commit point of a call. */
export function callRecordPath(paths: RoundPaths, label: string): string {
  return join(paths.calls, `${label}.json`);
}

/**
 * Records one backend call. Order matters for crash recovery: the exact output (`.out.txt`, tmp + rename)
 * and the raw transcript are written first, the call JSON last; a call counts only once its JSON exists and
 * `output_sha256` matches the `.out.txt` bytes. A kill between the two writes leaves no record, so the task calls
 * again (at most one repeated call per in-flight task; the orphaned `.out.txt` is overwritten); a kill after the JSON
 * is recovered without a call. `r.error` must already be redacted.
 */
export function recordCall(paths: RoundPaths, label: string, backend: Backend, prompt: string, r: CallResult, meta: CallRecordMeta = {}): void {
  const files = meta.files ?? PLAIN_WRITER;
  const at = meta.at ?? new Date().toISOString();
  files.writeText(callOutputPath(paths, label), r.text);
  files.writeText(join(paths.runs, `${label}.txt`), `${r.raw}\n\n=== prompt ===\n${prompt}\n`);
  files.writeJson(callRecordPath(paths, label), {
    label,
    backend: backend.id,
    family: backend.family,
    requested_model: backend.model,
    served_model: r.servedModel,
    version: r.version,
    ok: r.ok,
    error: r.error,
    ms: r.ms,
    tokens_in: r.tokensIn,
    tokens_out: r.tokensOut,
    cost_usd: r.costUsd,
    prompt_sha256: sha256(prompt),
    output_sha256: sha256(r.text),
    quota: meta.quota ?? false,
    started_at: meta.startedAt ?? at,
    at,
  });
}

/** A counted call rebuilt from `calls/<label>.json` + `.runs/<label>.out.txt`. */
export interface RecordedCall {
  label: string;
  backend: string;
  /** `requested_model` and `family` of the record (null when absent). */
  model: string | null;
  family: string | null;
  promptSha256: string;
  result: CallResult;
}

/**
 * The recorded call under `label`, or null when its JSON is absent or malformed, it is a quota try, the
 * `.out.txt` is missing (fresh clone) or its SHA-256 differs from `output_sha256` (torn or tampered).
 */
export function readRecordedCall(paths: RoundPaths, label: string): RecordedCall | null {
  const rec = readJson(callRecordPath(paths, label));
  if (!isRecord(rec) || readString(rec, 'label') !== label || readBoolean(rec, 'quota') === true) return null;
  const outputSha = readString(rec, 'output_sha256');
  const okFlag = readBoolean(rec, 'ok');
  const backend = readString(rec, 'backend');
  const promptSha256 = readString(rec, 'prompt_sha256');
  if (outputSha === null || okFlag === null || backend === null || promptSha256 === null) return null;
  const outFile = callOutputPath(paths, label);
  if (!existsSync(outFile)) return null;
  const text = readFileSync(outFile, 'utf8');
  if (sha256(text) !== outputSha) return null;
  const result: CallResult = {
    ok: okFlag,
    text,
    servedModel: readString(rec, 'served_model'),
    version: readString(rec, 'version'),
    ms: readNumber(rec, 'ms') ?? 0,
    tokensIn: readNumber(rec, 'tokens_in'),
    tokensOut: readNumber(rec, 'tokens_out'),
    costUsd: readNumber(rec, 'cost_usd'),
    error: readString(rec, 'error'),
    raw: '',
  };
  return { label, backend, model: readString(rec, 'requested_model'), family: readString(rec, 'family'), promptSha256, result };
}

/** Rebuilds a recorded call when `calls/<label>.json` exists and its output_sha256 matches `.runs/<label>.out.txt`. */
export function recoverCall(paths: RoundPaths, label: string): CallResult | null {
  return readRecordedCall(paths, label)?.result ?? null;
}

export interface Attempted<T> {
  value: T | null;
  error: string | null;
  attempts: number;
  last: CallResult | null;
}

/** Quota backoff budget spent (exit 4, no task record, resumes on the same backend). Re-exported by task.ts. */
export class QuotaExhausted extends Error {}

/** A stored record, output or pin that no longer matches what it claims (runner exit 3). Defined here so runner.ts and task.ts do not import each other. */
export class IntegrityError extends Error {}

async function safeCall(backend: Backend, prompt: string, role: string, timeoutMs: number, taskId: string, attempt: 1 | 2): Promise<CallResult> {
  const started = Date.now();
  try {
    return await backend.call(prompt, { role, timeoutMs, taskId, attempt });
  } catch (e) {
    return failure(`backend threw: ${e instanceof Error ? e.message : String(e)}`, Date.now() - started, '', null);
  }
}

const ATTEMPTS: readonly (1 | 2)[] = [1, 2];

/**
 * Optional plumbing used by task.ts runTask; absent options keep the prototype behaviour.
 * Hook order: beforeCall → backend.call → record (.out.txt, then calls/*.json) → afterCall → validate → retry.
 * Hooks fire around every backend call (quota tries included), outside safeCall's try/catch, so a throwing
 * hook is a crash; recovered attempts fire none.
 */
export interface CallRetryOptions {
  /**
   * Reuse a recorded attempt instead of calling (recoverCall of `<label>-a<attempt>`); `prompt` is the prompt
   * that attempt would send (the retry prompt for attempt 2 after a validation failure).
   */
  recover?: (attempt: 1 | 2, prompt: string) => CallResult | null;
  /** Prompt for attempt 2 after attempt 1's output failed validation; absent = identical prompt. */
  retryPrompt?: (error: string) => string;
  /** Quota failures matching `isQuota` back off and never count as attempts; absent = counted like any failure. */
  quota?: QuotaPolicy;
  sleep?: (ms: number) => Promise<void>;
  /** Stamps `started_at` and `at` of call records. */
  now?: () => string;
  hooks?: RunHooks;
  /** Writes go through RoundFiles (a CallWriter) when given. */
  files?: CallWriter;
  /** Applied to every error string before it is written or returned. */
  redact?: (text: string) => string;
  /** Told about each quota try before its backoff sleep (label `<id>-a<k>-q<n>`, redacted error). */
  onQuota?: (label: string, delayMs: number, error: string) => void;
  /**
   * Called before every backend call and every quota wait; throws to stop (runner.ts throwIfAborted: a sibling
   * job crashed, so this job makes no further call).
   */
  checkpoint?: () => void;
}

function redactResult(r: CallResult, redact: (text: string) => string): CallResult {
  return r.error === null ? r : { ...r, error: redact(r.error) };
}

/** First free quota-try number for `<attempt label>-q<n>` (a resumed task never overwrites earlier tries). */
function nextQuotaTry(paths: RoundPaths, attemptLabel: string): number {
  if (!existsSync(paths.calls)) return 1;
  const prefix = `${attemptLabel}-q`;
  let max = 0;
  for (const name of readdirSync(paths.calls)) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const n = name.slice(prefix.length, -'.json'.length);
    if (/^\d+$/u.test(n)) max = Math.max(max, Number(n));
  }
  return max + 1;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One call plus at most one retry; a thrown error, a failed call and an invalid output all count as failures.
 * Attempts are labelled `<label>-a1` / `<label>-a2`; a recovered attempt is decided from its record without a
 * call, so a resumed task never makes a third call. Quota tries (`<label>-a<k>-q<n>`) back off on `sleep`
 * (`quota.delaysMs`, the last value repeating) until `quota.budgetMs` of backoff would be exceeded, then
 * throw QuotaExhausted.
 */
export async function callWithRetry<T>(
  paths: RoundPaths,
  backend: Backend,
  label: string,
  prompt: string,
  role: string,
  timeoutMs: number,
  validate: (text: string) => Result<T>,
  opts: CallRetryOptions = {},
): Promise<Attempted<T>> {
  const files = opts.files ?? PLAIN_WRITER;
  const now = opts.now ?? ((): string => new Date().toISOString());
  const redact = opts.redact ?? ((text: string): string => text);
  const sleep = opts.sleep ?? defaultSleep;
  const quota = opts.quota;
  let quotaTries = 0;
  let waitedMs = 0;

  const callCounted = async (attempt: 1 | 2, sent: string): Promise<CallResult> => {
    const attemptLabel = `${label}-a${attempt}`;
    let nextTry = quota === undefined ? 1 : nextQuotaTry(paths, attemptLabel);
    for (;;) {
      opts.checkpoint?.();
      opts.hooks?.beforeCall?.(label, attempt);
      const startedAt = now();
      const r = redactResult(await safeCall(backend, sent, role, timeoutMs, label, attempt), redact);
      if (quota === undefined || !quota.isQuota(r)) {
        recordCall(paths, attemptLabel, backend, sent, r, { files, startedAt, at: now() });
        opts.hooks?.afterCall?.(label, attempt);
        return r;
      }
      const tryLabel = `${attemptLabel}-q${nextTry}`;
      recordCall(paths, tryLabel, backend, sent, r, { files, startedAt, at: now(), quota: true });
      opts.hooks?.afterCall?.(label, attempt);
      const delay = quota.delaysMs[Math.min(quotaTries, quota.delaysMs.length - 1)] ?? 0;
      const reason = r.error ?? 'quota';
      if (delay <= 0 || waitedMs + delay > quota.budgetMs) {
        throw new QuotaExhausted(`quota budget exhausted for ${label} on ${backend.id} after ${quotaTries + 1} tries (${waitedMs} ms waited): ${reason}`);
      }
      opts.onQuota?.(tryLabel, delay, reason);
      opts.checkpoint?.();
      await sleep(delay);
      waitedMs += delay;
      quotaTries += 1;
      nextTry += 1;
    }
  };

  let error: string | null = null;
  let last: CallResult | null = null;
  let validationError: string | null = null;
  for (const attempt of ATTEMPTS) {
    const sent = attempt === 2 && validationError !== null && opts.retryPrompt !== undefined ? opts.retryPrompt(validationError) : prompt;
    const recovered = opts.recover?.(attempt, sent) ?? null;
    const r = recovered === null ? await callCounted(attempt, sent) : redactResult(recovered, redact);
    last = r;
    validationError = null;
    if (!r.ok) {
      error = r.error;
      continue;
    }
    const v = validate(r.text);
    if (v.ok) return { value: v.value, error: null, attempts: attempt, last };
    error = redact(v.error);
    validationError = error;
  }
  return { value: null, error, attempts: 2, last };
}
