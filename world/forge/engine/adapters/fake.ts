import type { Family } from '../config.ts';
import type { Backend, CallOptions, CallResult } from './types.ts';

export type FakeReply = string | { error: string };

/** Deterministic backend for tests: `reply` sees the prompt and returns text or an error. */
export function fakeBackend(id: string, family: Family, reply: (prompt: string, opts: CallOptions) => FakeReply): Backend & { calls: string[] } {
  const calls: string[] = [];
  return {
    id,
    family,
    model: `fake-${id}`,
    calls,
    call: (prompt: string, opts: CallOptions): Promise<CallResult> => {
      calls.push(prompt);
      const r = reply(prompt, opts);
      if (typeof r === 'string') {
        return Promise.resolve({ ok: r.trim() !== '', text: r, servedModel: `fake-${id}`, version: 'fake 0', ms: 1, tokensIn: prompt.length, tokensOut: r.length, costUsd: null, error: r.trim() === '' ? 'empty output' : null, raw: r });
      }
      return Promise.resolve({ ok: false, text: '', servedModel: null, version: 'fake 0', ms: 1, tokensIn: null, tokensOut: null, costUsd: null, error: r.error, raw: '' });
    },
  };
}
