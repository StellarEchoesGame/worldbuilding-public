import type { Family } from '../config.ts';

export interface CallResult {
  ok: boolean;
  text: string;
  servedModel: string | null;
  version: string | null;
  ms: number;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  error: string | null;
  /** Raw stdout/stderr or HTTP body, stored only under the git-ignored .runs/ directory. */
  raw: string;
}

export interface CallOptions {
  role: string;
  timeoutMs: number;
  /** Provenance label of the call (task id); real adapters ignore it, fakes route on it. */
  taskId: string;
  /** 1 = first attempt, 2 = the one retry (quota backoff tries keep their attempt number). */
  attempt: 1 | 2;
}

export interface Backend {
  id: string;
  family: Family;
  model: string;
  call(prompt: string, opts: CallOptions): Promise<CallResult>;
}

export interface Invocation {
  cmd: string;
  args: string[];
  envSet: Record<string, string>;
  envUnset: string[];
}

export function failure(error: string, ms: number, raw: string, version: string | null): CallResult {
  return { ok: false, text: '', servedModel: null, version, ms, tokensIn: null, tokensOut: null, costUsd: null, error, raw };
}

const QUOTA_PATTERNS: readonly RegExp[] = [
  /\bHTTP\s*429\b/iu,
  /\bstatus(?:\s*code)?\s*[:=]?\s*429\b/iu,
  /rate[\s_-]*limit/iu,
  /quota/iu,
  /usage[\s_-]*limit/iu,
  /too many requests/iu,
  /resource[\s_-]*exhausted/iu,
];

/** True for HTTP 429, rate-limit, quota and CLI usage-limit failures (never counted as attempts). */
export function isQuotaError(r: CallResult): boolean {
  if (r.ok || r.error === null) return false;
  const error = r.error;
  return QUOTA_PATTERNS.some((p) => p.test(error));
}
