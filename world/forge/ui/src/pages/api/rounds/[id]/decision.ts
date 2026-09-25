import type { APIRoute } from 'astro';
import { dataDir } from '../../../../lib/data.ts';
import { submitDecision, type DecisionInput } from '../../../../lib/owner.ts';

export const POST: APIRoute = async ({ params, request, redirect }) => {
  const id = params.id ?? '';
  if (!/^[A-Z]\d{2}$/u.test(id)) return new Response('bad round id', { status: 400 });
  const form = await request.formData();
  const text = (k: string): string => {
    const v = form.get(k);
    return typeof v === 'string' ? v : '';
  };
  const input: DecisionInput = {
    pick: text('pick'),
    reason: text('reason'),
    fav: text('fav'),
    publish: text('publish'),
    facts: form.getAll('facts').filter((v): v is string => typeof v === 'string'),
  };
  const happened = text('happened');
  const r = submitDecision(dataDir(), id, happened === '' ? input : { ...input, happened }, new Date().toISOString());
  if (!r.ok) return redirect(`/rounds/${id}/decide?error=${encodeURIComponent(r.error)}`, 303);
  return redirect(`/rounds/${id}`, 303);
};
