import type { APIRoute } from 'astro';
import { uiNow } from '../../../../lib/clock.ts';
import { dataDir } from '../../../../lib/data.ts';
import { FORM_ERROR, noticeUrl, readForm } from '../../../../lib/forms.ts';
import { submitDiffApproval } from '../../../../lib/owner.ts';

export const POST: APIRoute = async ({ params, request, redirect }) => {
  const id = params.id ?? '';
  if (!/^[A-Z]\d{2}$/u.test(id)) return new Response('bad round id', { status: 400 });
  const form = await readForm(request);
  if (form === null) return redirect(noticeUrl(`/rounds/${id}/final`, 'error', FORM_ERROR), 303);
  const sha = form.get('sha256');
  const r = submitDiffApproval(dataDir(), id, typeof sha === 'string' ? sha : '', uiNow());
  if (!r.ok) return redirect(noticeUrl(`/rounds/${id}/final`, 'error', r.error), 303);
  return redirect(`/rounds/${id}/final`, 303);
};
