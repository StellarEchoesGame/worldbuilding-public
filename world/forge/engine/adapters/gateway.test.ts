import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseChatCompletion, readEnvValue } from './gateway.ts';

test('readEnvValue reads plain, exported and quoted assignments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-env-'));
  const f = join(dir, 'x.env');
  writeFileSync(f, '# comment\nexport OTHER=1\nAPI_KEY="abc=def"\n');
  assert.equal(readEnvValue(f, 'API_KEY'), 'abc=def');
  assert.equal(readEnvValue(f, 'OTHER'), '1');
  assert.equal(readEnvValue(f, 'MISSING'), null);
  rmSync(dir, { recursive: true });
});

test('parseChatCompletion returns content, served model and token counts', () => {
  const p = parseChatCompletion({
    model: 'deepseek-v4-1-flash-260910',
    choices: [{ message: { content: '正文', reasoning_content: '想' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 20 } },
  });
  assert.equal(p.text, '正文');
  assert.equal(p.servedModel, 'deepseek-v4-1-flash-260910');
  assert.equal(p.tokensIn, 100);
  assert.equal(p.tokensOut, 50);
  assert.equal(p.error, null);
});

test('parseChatCompletion flags empty content and API errors', () => {
  assert.match(parseChatCompletion({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }).error ?? '', /empty content.*length/);
  assert.match(parseChatCompletion({ error: { message: 'quota' } }).error ?? '', /quota/);
});
