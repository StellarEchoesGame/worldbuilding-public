import type { APIRoute } from 'astro';
import { VERSION_ID } from '../../../../../engine/bench-log.ts';
import { uiNow } from '../../../lib/clock.ts';
import { dataDir } from '../../../lib/data.ts';
import { FORM_ERROR, noticeUrl, readForm } from '../../../lib/forms.ts';
import { submitBenchView } from '../../../lib/owner.ts';
import { benchView } from '../../../lib/views/bench.ts';

/**
 * Logs bench_diff_viewed (sent by the version page's inline script on load, or its fallback button). Once per shown
 * SHA-256: a second POST for a (version, sha) that is already logged writes nothing.
 */
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await readForm(request);
  if (form === null) return redirect(noticeUrl('/benchmark', 'error', FORM_ERROR), 303);
  const version = form.get('version');
  const sha256 = form.get('sha256');
  if (typeof version !== 'string' || !VERSION_ID.test(version)) return new Response('bad version', { status: 400 });
  const page = `/benchmark/${version}`;
  if (typeof sha256 !== 'string') return redirect(noticeUrl(`${page}`, 'error', '缺少基准文件的 SHA-256。'), 303);
  const root = dataDir();
  const now = uiNow();
  const shown = benchView(root, now).versions.find((v) => v.version === version);
  if (shown !== undefined && shown.fileSha256 === sha256 && shown.viewedAt !== null) return redirect(page, 303);
  const r = submitBenchView(root, version, sha256, now);
  if (!r.ok) return redirect(noticeUrl(`${page}`, 'error', r.error), 303);
  return redirect(page, 303);
};
