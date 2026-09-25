import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LocalConfig } from './config.ts';
import { publicDeny, redactPublic, scannedGit, scannedGitHub, scanPublic, WIKI_DENY } from './public-scan.ts';
import type { PublicDeny } from './public-scan.ts';
import { fakeClock, fakeGit, fakeGitHub } from './testing/fakes.ts';

const HOST = 'fixture-gateway.invalid';

function local(baseUrl: string, phrases: string[]): LocalConfig {
  return {
    gatewayBaseUrl: baseUrl,
    gatewayEnvFile: 'gateway.env',
    gatewayKeyVar: 'KEY',
    binaries: { codex: 'codex', claude: 'claude', kimi: 'kimi', grok: 'grok' },
    codexAuth: 'auth.json',
    kimiHome: 'kimi',
    privatePhrases: phrases,
  };
}

const DENY: PublicDeny = publicDeny(local(`https://${HOST}/v1`, ['秘密短语']), { PUBLIC_CHECK_DENYLIST: ' handle-x , ,mail@example.invalid ' });

test('WIKI_DENY is a verbatim copy of the wiki check-public.mjs forbidden list and its denylist rule', () => {
  const script = readFileSync(new URL('../../../wiki/scripts/check-public.mjs', import.meta.url), 'utf8');
  const copy = WIKI_DENY.map((re) => re.toString()).join(',');
  assert.ok(script.includes(`const forbidden = [...extra,${copy}];`), 'wiki forbidden list changed: update WIKI_DENY');
  const extraRule =
    "const extra = (process.env.PUBLIC_CHECK_DENYLIST ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => new RegExp(s.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'), 'i'));";
  assert.ok(script.includes(extraRule), 'wiki PUBLIC_CHECK_DENYLIST rule changed: update publicDeny');
});

test('publicDeny: host from local.json, private phrases, PUBLIC_CHECK_DENYLIST entries; no local.json → no host', () => {
  assert.deepEqual(DENY, { gatewayHost: HOST, privatePhrases: ['秘密短语'], extra: ['handle-x', 'mail@example.invalid'] });
  assert.deepEqual(publicDeny(null, {}), { gatewayHost: null, privatePhrases: [], extra: [] });
  assert.equal(publicDeny(local('not a url', []), {}).gatewayHost, 'not a url');
});

test('scanPublic names the rules hit and never echoes the matched text', () => {
  assert.deepEqual(scanPublic('clean 文本 https://github.com/x', DENY), []);
  const hits = scanPublic(`POST https://${HOST.toUpperCase()}/v1 failed; 秘密短语; HANDLE-X; /Users/someone; sk-${'a'.repeat(30)}`, DENY);
  assert.deepEqual(hits, ['gateway host', 'private phrase 1', 'denylist entry 1', 'wiki rule 1', 'wiki rule 7']);
  for (const h of hits) assert.ok(!h.includes(HOST) && !h.includes('秘密') && !h.toLowerCase().includes('handle'));
  assert.deepEqual(scanPublic('127.0.0.1 ~/.secret/x feishu.cn CLOUDFLARE_GLOBAL_API_KEY x-auth-key', DENY), [
    'wiki rule 2',
    'wiki rule 3',
    'wiki rule 4',
    'wiki rule 5',
    'wiki rule 6',
  ]);
  assert.deepEqual(scanPublic(`no local ${HOST}`, publicDeny(null, {})), []);
});

test('redactPublic replaces every hit, gateway host as [redacted:gateway-host]', () => {
  const text = `a https://${HOST}/x b ${HOST.toUpperCase()} c 秘密短语 /Users/me 127.0.0.1`;
  const out = redactPublic(text, DENY);
  assert.equal(out, 'a https://[redacted:gateway-host]/x b [redacted:gateway-host] c [redacted:private-phrase-1] [redacted:wiki-rule-1] [redacted:wiki-rule-2]');
  // Path rules take the whole path token, so neither the user name nor the path survives.
  const paths = redactPublic("ENOENT: open '/Users/someone/forge/rounds/R01/x.json' (see ~/.secret/gw/key.env)", DENY);
  assert.equal(paths, "ENOENT: open '[redacted:wiki-rule-1]' (see ~/[redacted:wiki-rule-3])");
  assert.equal(paths.includes('someone'), false);
  assert.deepEqual(scanPublic(out, DENY), []);
  assert.equal(redactPublic('nothing here', DENY), 'nothing here');
});

test('scannedGitHub rejects a body or title hitting a rule before any GitHub call; clean bodies pass through', async () => {
  const inner = fakeGitHub(fakeClock('2026-10-01T00:00:00.000Z'));
  const gh = scannedGitHub(inner, DENY);
  const bad = await gh.createComment(1, `<!-- forge:probe R01 abc -->\nerror from https://${HOST}/v1`);
  assert.deepEqual(bad, { ok: false, error: 'public-content scan: gateway host' });
  const badIssue = await gh.createIssue({ title: '秘密短语', body: 'ok', labels: [], parent: 1 });
  assert.deepEqual(badIssue, { ok: false, error: 'public-content scan: private phrase 1' });
  assert.deepEqual(inner.calls(), []);
  const good = await gh.createComment(1, '<!-- forge:probe R01 abc -->\nprobe 0123');
  assert.equal(good.ok, true);
  assert.equal(inner.comments().length, 1);
  inner.failNext('listComments', 1);
  assert.equal((await gh.listComments(1)).ok, false);
});

function put(repo: string, rel: string, text: string): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
}

test('scannedGit.commit is blocked when any committed path holds the gateway host, before the inner commit', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'forge-scan-'));
  try {
    const inner = fakeGit(repo, { '.gitignore': '.runs/\n', 'world/forge/README.md': 'forge\n' });
    const git = scannedGit(inner, repo, DENY);
    put(repo, 'world/forge/rounds/R01/start.json', '{}\n');
    put(repo, 'world/forge/rounds/R01/calls/w1-a1.json', `{"error":"connect ${HOST}:443 refused"}\n`);
    put(repo, 'world/forge/.runs/R01/w1-a1.out.txt', `raw ${HOST}\n`);
    const direct = await git.commit(['world/forge/rounds/R01/calls/w1-a1.json'], 'chore: x');
    assert.equal(direct.ok, false);
    assert.ok(!direct.ok && direct.error.startsWith('public-content scan: gateway host'));
    assert.ok(!direct.ok && !direct.error.includes(HOST));
    const viaDir = await git.commit(['world/forge/rounds/R01'], 'chore: x');
    assert.ok(!viaDir.ok && viaDir.error === 'public-content scan: gateway host in world/forge/rounds/R01/calls/w1-a1.json');
    const viaMessage = await git.commit(['world/forge/rounds/R01/start.json'], `chore: ${HOST}`);
    assert.ok(!viaMessage.ok && viaMessage.error === 'public-content scan: gateway host in commit message');
    assert.deepEqual(inner.calls().filter((c) => c.op === 'commit'), []);
    assert.deepEqual(inner.commits('main'), []);
    rmSync(join(repo, 'world/forge/rounds/R01/calls'), { recursive: true });
    const sha = await git.commit(['world/forge'], 'chore: start R01');
    assert.ok(sha.ok && sha.value !== null);
    assert.deepEqual(inner.commits('main')[0]?.paths, ['world/forge/rounds/R01/start.json']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('scannedGit passes other operations through and redacts their errors', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'forge-scan-'));
  try {
    const inner = fakeGit(repo, { 'a.md': 'a\n' });
    const git = scannedGit(inner, repo, DENY);
    assert.deepEqual(await git.currentBranch(), { ok: true, value: 'main' });
    const bad = await git.show(`${HOST}`, 'a.md');
    assert.deepEqual(bad, { ok: false, error: 'fake git: unknown ref [redacted:gateway-host]' });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('scannedGit scans a committed symlink by its target text, not the file it points to', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'forge-scan-'));
  try {
    const inner = fakeGit(repo, { 'a.md': 'a\n' });
    const git = scannedGit(inner, repo, DENY);
    symlinkSync('/Users/someone/private.txt', join(repo, 'link'));
    const r = await git.commit(['link'], 'chore: link');
    assert.deepEqual(r, { ok: false, error: 'public-content scan: wiki rule 1 in link' });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
