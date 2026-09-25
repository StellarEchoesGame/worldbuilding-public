import type { APIRoute } from 'astro';
import { guard } from '../lib/guard.ts';

export const GET: APIRoute = ({ url, cookies, redirect }) => {
  const token = url.searchParams.get('t');
  const verdict = guard({ method: 'GET', cookieToken: token, expectedToken: process.env['FORGE_UI_TOKEN'] ?? null, origin: null, requestOrigin: url.origin });
  if (!verdict.ok || token === null) return new Response(verdict.ok ? '缺少令牌' : verdict.reason, { status: verdict.ok ? 401 : verdict.status });
  cookies.set('forge_token', token, { httpOnly: true, sameSite: 'strict', path: '/' });
  return redirect('/', 303);
};
