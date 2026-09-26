import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionInput, FORM_ERROR, noticeUrl, readForm } from './forms.ts';

function form(entries: ReadonlyArray<[string, string]>): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

test('decisionInput: every field, facts in form order', () => {
  const input = decisionInput(form([['pick', 'A'], ['reason', '平'], ['fav', 'B'], ['publish', 'no'], ['facts', 'A:A-01'], ['facts', 'B:A-01'], ['happened', 'on'], ['base', 'B']]));
  assert.deepEqual(input, { pick: 'A', reason: '平', fav: 'B', publish: 'no', facts: ['A:A-01', 'B:A-01'], happened: 'on', base: 'B' });
});

test('decisionInput: missing fields are empty strings; empty happened / base are left out', () => {
  assert.deepEqual(decisionInput(form([['happened', ''], ['base', '']])), { pick: '', reason: '', fav: '', publish: '', facts: [] });
});

test('decisionInput: file entries are ignored', () => {
  const f = form([['pick', 'A']]);
  f.append('facts', new Blob(['x']), 'x.txt');
  f.append('facts', 'A:A-01');
  assert.deepEqual(decisionInput(f).facts, ['A:A-01']);
});

function post(body: BodyInit | null, contentType: string | null): Request {
  const headers = new Headers();
  if (contentType !== null) headers.set('content-type', contentType);
  return new Request('http://127.0.0.1/api/x', { method: 'POST', body, headers });
}

test('readForm: urlencoded and multipart bodies parse (media type case and parameters ignored)', async () => {
  const url = await readForm(post('pick=A&facts=x&facts=y', 'application/x-www-form-urlencoded'));
  assert.deepEqual([url?.get('pick'), url?.getAll('facts')], ['A', ['x', 'y']]);
  const charset = await readForm(post('pick=B', 'Application/X-WWW-Form-Urlencoded; charset=UTF-8'));
  assert.equal(charset?.get('pick'), 'B');
  const fd = new FormData();
  fd.append('sha256', 'a'.repeat(64));
  const multi = await readForm(new Request('http://127.0.0.1/api/x', { method: 'POST', body: fd }));
  assert.equal(multi?.get('sha256'), 'a'.repeat(64));
});

test('readForm: JSON, text, missing content type and a truncated multipart body are null, not thrown', async () => {
  assert.equal(await readForm(post('{"pick":"A"}', 'application/json')), null);
  assert.equal(await readForm(post('pick=A', 'text/plain')), null);
  assert.equal(await readForm(post('pick=A', null)), null);
  assert.equal(await readForm(post('--xyz\r\nContent-Disposition: form-data; name="pick"\r\n\r\nA', 'multipart/form-data; boundary=xyz')), null);
  assert.equal(await readForm(post('pick=A', 'multipart/form-data')), null);
  assert.equal(await readForm(post('pick=A', 'application/x-www-form-urlencodedX')), null);
});

test('FORM_ERROR is a non-empty page notice', () => {
  assert.match(FORM_ERROR, /表单/u);
});

test('noticeUrl: encodes the message under the key and replaces the forge root with <forge>', () => {
  const root = '/tmp/forge-root';
  assert.equal(noticeUrl('/benchmark', 'error', 'owner-log.jsonl: EACCES, open \'/tmp/forge-root/owner-log.jsonl\'', root),
    `/benchmark?error=${encodeURIComponent("owner-log.jsonl: EACCES, open '<forge>/owner-log.jsonl'")}`);
  assert.equal(noticeUrl('/mirror', 'result', 'forge mirror 退出码 0：ok', root), `/mirror?result=${encodeURIComponent('forge mirror 退出码 0：ok')}`);
  assert.equal(noticeUrl('/rounds/R01/decide', 'error', 'x & y', ''), '/rounds/R01/decide?error=x%20%26%20y');
});
