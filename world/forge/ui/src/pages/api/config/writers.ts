import type { APIRoute } from 'astro';
import { dataDir } from '../../../lib/data.ts';
import { FORM_ERROR, noticeUrl, readForm } from '../../../lib/forms.ts';
import { writeWritersConfig } from '../../../lib/writers-config.ts';

export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await readForm(request);
  if (form === null) return redirect(noticeUrl('/config', 'error', FORM_ERROR), 303);
  const models: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === 'string') models[k] = v.trim();
  const r = writeWritersConfig(dataDir(), models);
  if (!r.ok) return redirect(noticeUrl('/config', 'error', r.error), 303);
  return redirect('/config', 303);
};
