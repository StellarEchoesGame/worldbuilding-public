import { defineMiddleware } from 'astro:middleware';
import { guard } from './lib/guard.ts';

export const onRequest = defineMiddleware(async (context, next) => {
  if (context.url.pathname === '/login') return next();
  const verdict = guard({
    method: context.request.method,
    cookieToken: context.cookies.get('forge_token')?.value ?? null,
    expectedToken: process.env['FORGE_UI_TOKEN'] ?? null,
    origin: context.request.headers.get('origin'),
    requestOrigin: context.url.origin,
  });
  if (!verdict.ok) {
    return new Response(`<!doctype html><meta charset="utf-8"><title>回响工坊</title><p style="font:16px system-ui;padding:2rem">${verdict.reason}</p>`, {
      status: verdict.status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
  return next();
});
