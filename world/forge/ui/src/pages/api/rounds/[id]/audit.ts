import type { APIRoute } from 'astro';
import { uiNow } from '../../../../lib/clock.ts';
import { dataDir } from '../../../../lib/data.ts';
import { FORM_ERROR, noticeUrl, readForm } from '../../../../lib/forms.ts';
import { submitAudit } from '../../../../lib/owner.ts';

export const POST: APIRoute = async ({ params, request, redirect }) => {
  const id = params.id ?? '';
  if (!/^[A-Z]\d{2}$/u.test(id)) return new Response('bad round id', { status: 400 });
  const form = await readForm(request);
  if (form === null) return redirect(noticeUrl(`/rounds/${id}/audit`, 'error', FORM_ERROR), 303);
  const answers: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === 'string') answers[k] = v;
  const r = submitAudit(dataDir(), id, answers, uiNow());
  if (!r.ok) return redirect(noticeUrl(`/rounds/${id}/audit`, 'error', r.error), 303);
  return redirect(`/rounds/${id}`, 303);
};
