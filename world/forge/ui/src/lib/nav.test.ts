import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeRoundId, navLinks } from './nav.ts';

function status(root: string, round: string, state: string, extra: readonly string[] = []): void {
  const dir = join(root, 'rounds', round);
  mkdirSync(dir, { recursive: true });
  const record = { round, state, step: null, waiting_for: null, detail: '', since: '2026-10-01T00:00:00.000Z', exit_code: null, done: [] };
  writeFileSync(join(dir, 'status.json'), state === 'broken' ? '{' : `${JSON.stringify(record)}\n`);
  for (const f of extra) writeFileSync(join(dir, f), '{}\n');
}

test('nav: seven sections in order, index pages without an active round, the current section marked', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-nav-'));
  const links = navLinks(root, '/benchmark/v2');
  assert.deepEqual(links.map((l) => l.label), ['总览', '选题', '轮次', '校准', '基准', '配置', '镜像']);
  assert.deepEqual(links.map((l) => l.href), ['/', '/topic', '/rounds', '/calibration', '/benchmark', '/config', '/mirror']);
  assert.deepEqual(links.filter((l) => l.current).map((l) => l.label), ['基准']);
  assert.deepEqual(navLinks(root, '/').filter((l) => l.current).map((l) => l.label), ['总览']);
  assert.deepEqual(navLinks(root, '/game-need').filter((l) => l.current).map((l) => l.label), ['选题']);
  assert.deepEqual(navLinks(root, '/rounds-x').filter((l) => l.current).map((l) => l.label), []);
  assert.equal(activeRoundId(root), null);
  rmSync(root, { recursive: true, force: true });
});

test('nav: 选题 and 轮次 open the newest unfinished round when it has those pages', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-nav-'));
  status(root, 'R01', 'done', ['brief.json', 'topic.json']);
  status(root, 'R02', 'waiting', ['topic-offer.json']);
  mkdirSync(join(root, 'rounds', 'R03'));
  assert.equal(activeRoundId(root), 'R02');
  const href = (label: string): string | undefined => navLinks(root, '/').find((l) => l.label === label)?.href;
  assert.equal(href('选题'), '/topic/R02');
  assert.equal(href('轮次'), '/rounds', 'R02 has no brief.json yet');
  writeFileSync(join(root, 'rounds', 'R02', 'brief.json'), '{}\n');
  assert.equal(href('轮次'), '/rounds/R02');
  status(root, 'R02', 'done');
  assert.equal(activeRoundId(root), null, 'every round with a status is done');
  status(root, 'R04', 'broken');
  assert.equal(activeRoundId(root), 'R04', 'an unreadable status counts as active');
  rmSync(root, { recursive: true, force: true });
});
