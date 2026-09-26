import type { APIRoute } from 'astro';
import { dataDir, isRealData } from '../../../lib/data.ts';
import { FORM_ERROR, noticeUrl, readForm } from '../../../lib/forms.ts';
import { drainMirror, MIRROR_DRAIN_TIMEOUT_MS, nodeSpawner } from '../../../lib/mirror-drain.ts';

export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await readForm(request);
  if (form === null) return redirect(noticeUrl('/mirror', 'error', FORM_ERROR), 303);
  const round = form.get('round');
  if (typeof round !== 'string' || !/^[A-Z]\d{2}$/u.test(round)) return new Response('bad round id', { status: 400 });
  if (!isRealData()) {
    return new Response('这是夹具数据目录：重试会启动真实的 forge mirror，只在真实数据目录上可用。', { status: 409, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const r = await drainMirror({ forgeRoot: dataDir(), round, spawner: nodeSpawner, env: process.env, timeoutMs: MIRROR_DRAIN_TIMEOUT_MS });
  if (!r.ok) return redirect(noticeUrl('/mirror', 'error', r.error), 303);
  return redirect(noticeUrl('/mirror', 'result', `forge mirror 退出码 ${r.exitCode}：${r.summary}`), 303);
};
