import type { APIRoute } from 'astro';
import { uiNow } from '../../../lib/clock.ts';
import { dataDir } from '../../../lib/data.ts';
import { FORM_ERROR, noticeUrl, readForm } from '../../../lib/forms.ts';
import { submitProtocolApproval } from '../../../lib/owner.ts';

export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await readForm(request);
  if (form === null) return redirect(noticeUrl('/benchmark', 'error', FORM_ERROR), 303);
  const sha256 = form.get('sha256');
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(sha256)) return redirect(noticeUrl('/benchmark', 'error', '缺少协议包的 SHA-256。'), 303);
  const r = submitProtocolApproval(dataDir(), sha256, uiNow());
  if (!r.ok) return redirect(noticeUrl('/benchmark', 'error', r.error), 303);
  return redirect('/benchmark', 303);
};
