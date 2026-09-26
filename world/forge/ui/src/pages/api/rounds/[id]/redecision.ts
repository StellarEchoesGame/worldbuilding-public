import type { APIRoute } from 'astro';
import { uiNow } from '../../../../lib/clock.ts';
import { dataDir } from '../../../../lib/data.ts';
import { decisionInput, FORM_ERROR, noticeUrl, readForm } from '../../../../lib/forms.ts';
import { submitRedecision } from '../../../../lib/owner.ts';

export const POST: APIRoute = async ({ params, request, redirect }) => {
  const id = params.id ?? '';
  if (!/^[A-Z]\d{2}$/u.test(id)) return new Response('bad round id', { status: 400 });
  const form = await readForm(request);
  if (form === null) return redirect(noticeUrl(`/rounds/${id}/redecide`, 'error', FORM_ERROR), 303);
  const r = submitRedecision(dataDir(), id, decisionInput(form), uiNow());
  if (!r.ok) return redirect(noticeUrl(`/rounds/${id}/redecide`, 'error', r.error), 303);
  return redirect(`/rounds/${id}`, 303);
};
