import { spawnSync } from 'node:child_process';

// Pages does not accept account_id in wrangler.jsonc. Pin the explicitly
// selected account in the child process environment instead.
const account = 'ea58698c1f03fa6362e2f823e99d0815';
if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_ID !== account) {
  throw new Error('Cloudflare account differs from the configured Stellar Echoes target.');
}
const result = spawnSync('wrangler', ['pages', 'deploy', 'dist', '--project-name', 'stellar-echoes-wiki', '--branch', 'main'], {
  stdio: 'inherit', env: {...process.env, CLOUDFLARE_ACCOUNT_ID: account},
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
