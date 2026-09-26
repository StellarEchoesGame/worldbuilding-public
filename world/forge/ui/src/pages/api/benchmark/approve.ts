import type { APIRoute } from 'astro';
import { VERSION_ID } from '../../../../../engine/bench-log.ts';
import { uiNow } from '../../../lib/clock.ts';
import { dataDir } from '../../../lib/data.ts';
import { FORM_ERROR, noticeUrl, readForm } from '../../../lib/forms.ts';
import { submitBenchApproval } from '../../../lib/owner.ts';

export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await readForm(request);
  if (form === null) return redirect(noticeUrl('/benchmark', 'error', FORM_ERROR), 303);
  const version = form.get('version');
  const sha256 = form.get('sha256');
  if (typeof version !== 'string' || !VERSION_ID.test(version)) return new Response('bad version', { status: 400 });
  if (typeof sha256 !== 'string') return redirect(noticeUrl('/benchmark', 'error', '缺少基准文件的 SHA-256。'), 303);
  const r = submitBenchApproval(dataDir(), version, sha256, uiNow());
  if (!r.ok) return redirect(noticeUrl('/benchmark', 'error', r.error), 303);
  return redirect('/benchmark', 303);
};
