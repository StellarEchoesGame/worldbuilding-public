import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claudeInvocation,
  codexInvocation,
  grokInvocation,
  kimiInvocation,
  parseClaudeJson,
  parseGrokJson,
  stripKimiBullet,
} from './judges.ts';

test('codex invocation uses a throwaway home, read-only sandbox and disables tools', () => {
  const inv = codexInvocation({ binary: '/bin/codex', model: 'gpt-6-astra', effort: 'max', codexHome: '/tmp/h', outFile: '/tmp/o.txt' });
  assert.equal(inv.cmd, '/bin/codex');
  assert.equal(inv.envSet['CODEX_HOME'], '/tmp/h');
  assert.equal(inv.envSet['CMUX_CODEX_HOOKS_DISABLED'], '1');
  for (const flag of ['--ephemeral', '--skip-git-repo-check', '--ignore-rules', 'model_reasoning_effort=max', 'project_doc_max_bytes=0', 'web_search="disabled"']) {
    assert.ok(inv.args.includes(flag), flag);
  }
  for (const feature of ['hooks', 'shell_tool', 'unified_exec', 'memories', 'plugins', 'apps', 'browser_use', 'computer_use']) {
    const i = inv.args.indexOf(feature);
    assert.ok(i > 0 && inv.args[i - 1] === '--disable', feature);
  }
  assert.deepEqual(inv.args.slice(inv.args.indexOf('-s'), inv.args.indexOf('-s') + 2), ['-s', 'read-only']);
  assert.equal(inv.args.at(-1), '-');
});

test('claude invocation removes tools, settings and the parent session marker', () => {
  const inv = claudeInvocation({ binary: 'claude', model: 'opus', effort: 'max', role: '评委', prompt: 'P' });
  assert.ok(inv.envUnset.includes('CLAUDECODE'));
  assert.equal(inv.envSet['CLAUDE_CODE_DISABLE_CLAUDE_MDS'], '1');
  const at = (flag: string): string | undefined => inv.args[inv.args.indexOf(flag) + 1];
  assert.equal(at('--tools'), '');
  assert.equal(at('--setting-sources'), '');
  assert.equal(at('--output-format'), 'json');
  assert.equal(at('--effort'), 'max');
  assert.equal(at('--system-prompt'), '评委');
  assert.ok(inv.args.includes('--strict-mcp-config'));
  assert.ok(inv.args.includes('--no-session-persistence'));
});

test('kimi invocation sets effort by env and uses an agent file and empty skills dir', () => {
  const inv = kimiInvocation({ binary: 'kimi', model: 'kimi-code/k3', effort: 'max', agentFile: '/t/judge.md', skillsDir: '/t/s', kimiHome: '/t/home', prompt: 'P' });
  assert.equal(inv.envSet['KIMI_MODEL_THINKING_EFFORT'], 'max');
  assert.equal(inv.envSet['KIMI_CODE_HOME'], '/t/home');
  assert.ok(inv.args.includes('--agent-file'));
  assert.equal(inv.args[inv.args.indexOf('--skills-dir') + 1], '/t/s');
  assert.equal(inv.args[inv.args.indexOf('-p') + 1], 'P');
});

test('grok invocation disables imported instructions, memory and tools', () => {
  const inv = grokInvocation({ binary: 'grok', model: 'grok-4.7', effort: 'xhigh', promptFile: '/t/p.txt' });
  for (const src of ['CLAUDE', 'CURSOR']) {
    for (const kind of ['AGENTS', 'RULES', 'SKILLS', 'MCPS', 'HOOKS']) assert.equal(inv.envSet[`GROK_${src}_${kind}_ENABLED`], '0');
  }
  assert.equal(inv.envSet['GROK_MEMORY'], '0');
  assert.equal(inv.args[inv.args.indexOf('--tools') + 1], 'none');
  assert.equal(inv.args[inv.args.indexOf('--reasoning-effort') + 1], 'xhigh');
  assert.ok(inv.args.includes('--disable-web-search'));
  assert.ok(inv.args.includes('--no-subagents'));
});

test('parseClaudeJson reads result, served model, tokens and error flag', () => {
  const out = JSON.stringify({ type: 'result', is_error: false, result: '{"a":1}', total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 3 }, modelUsage: { 'claude-code/claude-opus-5-5[1M]': { inputTokens: 10 } } });
  const p = parseClaudeJson(out);
  assert.equal(p.text, '{"a":1}');
  assert.equal(p.servedModel, 'claude-code/claude-opus-5-5[1M]');
  assert.equal(p.tokensIn, 10);
  assert.equal(p.error, null);
  assert.match(parseClaudeJson(JSON.stringify({ is_error: true, result: 'bad model' })).error ?? '', /bad model/);
  assert.match(parseClaudeJson('not json').error ?? '', /JSON/);
});

test('parseGrokJson reads text and served model', () => {
  const p = parseGrokJson(JSON.stringify({ text: 'OK', modelUsage: { 'grok-4.7-build': {} }, usage: { input_tokens: 5, output_tokens: 1 }, total_cost_usd: 0.01 }));
  assert.equal(p.text, 'OK');
  assert.equal(p.servedModel, 'grok-4.7-build');
  assert.equal(p.error, null);
  assert.match(parseGrokJson(JSON.stringify({ text: '' })).error ?? '', /empty/);
});

test('stripKimiBullet removes the leading bullet only', () => {
  assert.equal(stripKimiBullet('• {"a":"• b"}\n'), '{"a":"• b"}');
});

test('with several modelUsage entries the served model is the accepted one, so an auxiliary model does not void the call', () => {
  const accepted = ['claude-code/claude-opus-5-5[1M]'];
  const out = JSON.stringify({ result: 'OK', usage: {}, modelUsage: { 'claude-haiku-4-5': {}, 'claude-code/claude-opus-5-5[1M]': {} } });
  assert.equal(parseClaudeJson(out, accepted).servedModel, 'claude-code/claude-opus-5-5[1M]');
  assert.equal(parseClaudeJson(out).servedModel, 'claude-haiku-4-5', 'without a list the first entry is recorded');
  const aux = JSON.stringify({ result: 'OK', usage: {}, modelUsage: { 'claude-haiku-4-5': {} } });
  assert.equal(parseClaudeJson(aux, accepted).servedModel, 'claude-haiku-4-5', 'no accepted entry: the first one is kept so the check voids the call');
  const grok = JSON.stringify({ text: 'OK', modelUsage: { 'grok-mini': {}, 'grok-4.7-build': {} } });
  assert.equal(parseGrokJson(grok, ['grok-4.7-build']).servedModel, 'grok-4.7-build');
});
