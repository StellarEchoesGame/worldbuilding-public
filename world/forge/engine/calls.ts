import type { Backend, CallResult } from './adapters/types.ts';
import { failure } from './adapters/types.ts';
import type { Result } from './result.ts';
import { sha256, writeJson, writeText, type RoundPaths } from './store.ts';

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

export function recordCall(paths: RoundPaths, label: string, backend: Backend, prompt: string, r: CallResult): void {
  writeJson(`${paths.calls}/${label}.json`, {
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
    at: new Date().toISOString(),
  });
  writeText(`${paths.runs}/${label}.txt`, `${r.raw}\n\n=== prompt ===\n${prompt}\n`);
}

export interface Attempted<T> {
  value: T | null;
  error: string | null;
  attempts: number;
  last: CallResult | null;
}

async function safeCall(backend: Backend, prompt: string, role: string, timeoutMs: number): Promise<CallResult> {
  const started = Date.now();
  try {
    return await backend.call(prompt, { role, timeoutMs });
  } catch (e) {
    return failure(`backend threw: ${e instanceof Error ? e.message : String(e)}`, Date.now() - started, '', null);
  }
}

/** One call plus at most one retry; a thrown error, a failed call and an invalid output all count as failures. */
export async function callWithRetry<T>(
  paths: RoundPaths,
  backend: Backend,
  label: string,
  prompt: string,
  role: string,
  timeoutMs: number,
  validate: (text: string) => Result<T>,
): Promise<Attempted<T>> {
  let error: string | null = null;
  let last: CallResult | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const r = await safeCall(backend, prompt, role, timeoutMs);
    last = r;
    recordCall(paths, `${label}-a${attempt}`, backend, prompt, r);
    if (!r.ok) {
      error = r.error;
      continue;
    }
    const v = validate(r.text);
    if (v.ok) return { value: v.value, error: null, attempts: attempt, last };
    error = v.error;
  }
  return { value: null, error, attempts: 2, last };
}
