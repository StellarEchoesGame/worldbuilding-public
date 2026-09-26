import { dataDir, redactRoot } from './data.ts';
import type { DecisionInput } from './owner.ts';

/** Form fields of the decision / redecision forms → DecisionInput (pick, reason, fav, publish, facts[], happened?, base?). */
export function decisionInput(form: FormData): DecisionInput {
  const text = (key: string): string => {
    const v = form.get(key);
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
  const base = text('base');
  if (happened !== '') input.happened = happened;
  if (base !== '') input.base = base;
  return input;
}

/** Page notice for a POST body that is not a readable HTML form. */
export const FORM_ERROR = '表单无法读取：请从页面上的表单提交。';

const FORM_TYPES: readonly string[] = ['application/x-www-form-urlencoded', 'multipart/form-data'];

/**
 * The request body as FormData, or null when the content type is not an HTML form type (urlencoded / multipart) or the
 * body does not parse (e.g. a truncated multipart body) — routes turn null into their `?error=` redirect, not a 500.
 */
export async function readForm(request: Request): Promise<FormData | null> {
  const essence = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!FORM_TYPES.includes(essence)) return null;
  try {
    return await request.formData();
  } catch {
    return null;
  }
}

/**
 * `<page>?<key>=<message>` for a POST's redirect: the message is URL-encoded and every occurrence of the forge root is
 * replaced by `<forge>` (writer refusals wrap Node fs errors that quote absolute paths; pages never show a local path).
 */
export function noticeUrl(page: string, key: 'error' | 'result', message: string, root: string = dataDir()): string {
  return `${page}?${key}=${encodeURIComponent(redactRoot(message, root))}`;
}
