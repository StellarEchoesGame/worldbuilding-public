import type { APIRoute } from 'astro';
import { dataDir } from '../../lib/data.ts';
import { FORM_ERROR, noticeUrl, readForm } from '../../lib/forms.ts';
import { writeGameNeed } from '../../lib/game-need.ts';

/** Form fields `w:<row_id>` = weight; an empty field leaves the row out (it weighs 1); anything else must be a number. */
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await readForm(request);
  if (form === null) return redirect(noticeUrl('/game-need', 'error', FORM_ERROR), 303);
  const weights: Record<string, number> = {};
  for (const [key, value] of form.entries()) {
    if (!key.startsWith('w:') || typeof value !== 'string' || value.trim() === '') continue;
    weights[key.slice(2)] = Number(value.trim());
  }
  const r = writeGameNeed(dataDir(), weights);
  if (!r.ok) return redirect(noticeUrl('/game-need', 'error', r.error), 303);
  return redirect('/topic', 303);
};
