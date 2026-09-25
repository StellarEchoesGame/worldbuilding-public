import type { APIRoute } from 'astro';
import { dataDir } from '../../../../lib/data.ts';
import { submitAudit } from '../../../../lib/owner.ts';

export const POST: APIRoute = async ({ params, request, redirect }) => {
  const id = params.id ?? '';
  if (!/^[A-Z]\d{2}$/u.test(id)) return new Response('bad round id', { status: 400 });
  const form = await request.formData();
  const answers: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === 'string') answers[k] = v;
  const r = submitAudit(dataDir(), id, answers, new Date().toISOString());
  if (!r.ok) return redirect(`/rounds/${id}/audit?error=${encodeURIComponent(r.error)}`, 303);
  return redirect(`/rounds/${id}`, 303);
};
