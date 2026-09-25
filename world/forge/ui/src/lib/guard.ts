import { timingSafeEqual } from 'node:crypto';

export interface GuardInput {
  method: string;
  cookieToken: string | null;
  expectedToken: string | null;
  origin: string | null;
  requestOrigin: string;
}

export type GuardResult = { ok: true } | { ok: false; status: 401 | 403; reason: string };

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function guard(i: GuardInput): GuardResult {
  if (i.expectedToken === null || i.expectedToken === '') return { ok: false, status: 403, reason: '这个 UI 没有通过 forge ui 启动，拒绝访问。' };
  if (i.cookieToken === null || !sameToken(i.cookieToken, i.expectedToken)) return { ok: false, status: 401, reason: '缺少访问令牌：请用 npm run ui 重新打开。' };
  if (i.method !== 'GET' && i.method !== 'HEAD' && i.origin !== i.requestOrigin) return { ok: false, status: 403, reason: '来源不符，拒绝写入。' };
  return { ok: true };
}
