import type { APIRoute } from 'astro';
import { uiNow } from '../../../../lib/clock.ts';
import { dataDir } from '../../../../lib/data.ts';
import { FORM_ERROR, noticeUrl, readForm } from '../../../../lib/forms.ts';
import { submitTopic } from '../../../../lib/owner.ts';

export const POST: APIRoute = async ({ params, request, redirect }) => {
  const id = params.id ?? '';
  if (!/^[A-Z]\d{2}$/u.test(id)) return new Response('bad round id', { status: 400 });
  const form = await readForm(request);
  if (form === null) return redirect(noticeUrl(`/topic/${id}`, 'error', FORM_ERROR), 303);
  const text = (k: string): string => {
    const v = form.get(k);
    return typeof v === 'string' ? v : '';
  };
  const r = submitTopic(dataDir(), id, { row_id: text('row_id'), layer: text('layer') }, uiNow());
  if (!r.ok) return redirect(noticeUrl(`/topic/${id}`, 'error', r.error), 303);
  return redirect(`/topic/${id}`, 303);
};
