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
