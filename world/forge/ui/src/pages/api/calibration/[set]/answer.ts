import type { APIRoute } from 'astro';
import { SET_ID } from '../../../../../../engine/calib-build.ts';
import { uiNow } from '../../../../lib/clock.ts';
import { dataDir } from '../../../../lib/data.ts';
import { FORM_ERROR, noticeUrl, readForm } from '../../../../lib/forms.ts';
import { submitCalibAnswers } from '../../../../lib/owner.ts';

/** `ms` from the page script: a non-negative integer, or absent / empty without JavaScript (null). */
function parseMs(value: FormDataEntryValue | null): number | null | 'bad' {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{1,9}$/u.test(value)) return 'bad';
  return Number(value);
}

export const POST: APIRoute = async ({ params, request, redirect }) => {
  const set = params.set ?? '';
  if (!SET_ID.test(set)) return new Response('bad set id', { status: 400 });
  const page = `/calibration/${set}`;
  const form = await readForm(request);
  if (form === null) return redirect(noticeUrl(page, 'error', FORM_ERROR), 303);
  const slotText = form.get('slot');
  const choice = form.get('choice');
  const ms = parseMs(form.get('ms'));
  if (typeof slotText !== 'string' || !/^[1-9]\d{0,3}$/u.test(slotText)) return redirect(noticeUrl(page, 'error', '题号不对。'), 303);
  if (choice !== 'left' && choice !== 'right') return redirect(noticeUrl(page, 'error', '请选择左边或右边。'), 303);
  if (ms === 'bad') return redirect(noticeUrl(page, 'error', '用时不对。'), 303);
  const r = submitCalibAnswers(dataDir(), set, [{ slot: Number(slotText), choice, ms }], uiNow());
  if (!r.ok) return redirect(noticeUrl(page, 'error', r.error), 303);
  return redirect(page, 303);
};
