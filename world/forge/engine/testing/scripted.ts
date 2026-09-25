import type { FakeReply } from '../adapters/fake.ts';
import type { Backend, CallOptions, CallResult } from '../adapters/types.ts';
import type { Family } from '../config.ts';

export interface FakeCallMeta {
  taskId: string;
  attempt: 1 | 2;
}

/** `call` = 1-based count of calls this route has served so far (including this one). */
export type Route = (prompt: string, call: number, meta: FakeCallMeta) => FakeReply;

export interface RouterCall {
  taskId: string;
  attempt: 1 | 2;
  family: Family;
  role: string;
  prompt: string;
}

export interface FakeRouter extends Backend {
  log(): readonly RouterCall[];
  /** Resolves once every call started so far has settled. */
  settled(): Promise<void>;
}

/** Task-id kind = the text before the first `-` (`taste-W1-Moonshot-s1-fwd` → `taste`). */
export function taskKind(taskId: string): string {
  const dash = taskId.indexOf('-');
  return dash === -1 ? taskId : taskId.slice(0, dash);
}

function replyToResult(identity: { model: string }, prompt: string, reply: FakeReply): CallResult {
  if (typeof reply !== 'string') {
    return { ok: false, text: '', servedModel: null, version: 'fake 0', ms: 1, tokensIn: null, tokensOut: null, costUsd: null, error: reply.error, raw: '' };
  }
  const empty = reply.trim() === '';
  return {
    ok: !empty, text: reply, servedModel: identity.model, version: 'fake 0', ms: 1,
    tokensIn: prompt.length, tokensOut: reply.length, costUsd: null, error: empty ? 'empty output' : null, raw: reply,
  };
}

/**
 * Fake backend routed by task-id kind (text before the first `-` of CallOptions.taskId), with the role
 * constant (tasks/roles.ts) as fallback key; an unrouted call replies `{ error: 'no route: <kind>' }`.
 * A route that throws makes the call reject (callWithRetry records it as `backend threw`).
 */
export function fakeRouter(routes: Record<string, Route>, identity: { id: string; family: Family; model: string }): FakeRouter {
  const calls: RouterCall[] = [];
  const served = new Map<string, number>();
  const pending = new Set<Promise<CallResult>>();
  const pick = (key: string): Route | null => (Object.hasOwn(routes, key) ? (routes[key] ?? null) : null);
  const answer = async (prompt: string, opts: CallOptions): Promise<CallResult> => {
    const kind = taskKind(opts.taskId);
    calls.push({ taskId: opts.taskId, attempt: opts.attempt, family: identity.family, role: opts.role, prompt });
    const key = pick(kind) !== null ? kind : pick(opts.role) !== null ? opts.role : null;
    const route = key === null ? null : pick(key);
    if (key === null || route === null) return replyToResult(identity, prompt, { error: `no route: ${kind}` });
    const n = (served.get(key) ?? 0) + 1;
    served.set(key, n);
    return replyToResult(identity, prompt, route(prompt, n, { taskId: opts.taskId, attempt: opts.attempt }));
  };
  return {
    id: identity.id,
    family: identity.family,
    model: identity.model,
    call: (prompt: string, opts: CallOptions): Promise<CallResult> => {
      const p = answer(prompt, opts);
      pending.add(p);
      const forget = (): void => { pending.delete(p); };
      p.then(forget, forget);
      return p;
    },
    log: () => calls,
    settled: async () => {
      await Promise.allSettled([...pending]);
    },
  };
}

/** `taskId#attempt` per call, in call order. */
export function callLog(router: FakeRouter): string[] {
  return router.log().map((c) => `${c.taskId}#${c.attempt}`);
}
