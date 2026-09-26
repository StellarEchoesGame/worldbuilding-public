import { defineMiddleware } from 'astro:middleware';
import { agentMarkers } from '../../engine/ui-launch.ts';
import { serverRefusal } from './lib/bind.ts';
import { isRealData } from './lib/data.ts';
import { guard } from './lib/guard.ts';

function refusalPage(reason: string, status: number): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>回响工坊</title><p style="font:16px system-ui;padding:2rem">${reason}</p>`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

export const onRequest = defineMiddleware(async (context, next) => {
  // Before the /login bypass: a server bound or addressed off loopback, or an agent session on real data, serves nothing.
  const refusal = serverRefusal({ bindHost: process.env['HOST'], requestHost: context.url.host, markers: agentMarkers(process.env), realData: isRealData() });
  if (refusal !== null) return refusalPage(refusal, 403);
  if (context.url.pathname === '/login') return next();
  const verdict = guard({
    method: context.request.method,
    cookieToken: context.cookies.get('forge_token')?.value ?? null,
    expectedToken: process.env['FORGE_UI_TOKEN'] ?? null,
    origin: context.request.headers.get('origin'),
    requestOrigin: context.url.origin,
  });
  if (!verdict.ok) return refusalPage(verdict.reason, verdict.status);
  return next();
});
