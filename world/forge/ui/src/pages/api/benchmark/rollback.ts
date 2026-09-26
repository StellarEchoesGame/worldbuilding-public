import type { APIRoute } from 'astro';
import { VERSION_ID } from '../../../../../engine/bench-log.ts';
import { uiNow } from '../../../lib/clock.ts';
import { dataDir } from '../../../lib/data.ts';
import { FORM_ERROR, noticeUrl, readForm } from '../../../lib/forms.ts';
import { submitRollback } from '../../../lib/owner.ts';

export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await readForm(request);
  if (form === null) return redirect(noticeUrl('/benchmark', 'error', FORM_ERROR), 303);
  const version = form.get('version');
  const from = form.get('from');
  const sha256 = form.get('sha256');
  if (typeof version !== 'string' || !VERSION_ID.test(version) || typeof from !== 'string' || !VERSION_ID.test(from)) return new Response('bad version', { status: 400 });
  if (typeof sha256 !== 'string') return redirect(noticeUrl('/benchmark', 'error', '缺少基准文件的 SHA-256。'), 303);
  const r = submitRollback(dataDir(), { version, from, sha256 }, uiNow());
  if (!r.ok) return redirect(noticeUrl('/benchmark', 'error', r.error), 303);
  return redirect('/benchmark', 303);
};
