import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MERGE_FROM, MERGE_UNTIL, mergeCommand, mergecheckCommand, mirrorCommand, postMergeCommand } from './cli-merge.ts';
import type { EngineDeps, RoundBackends } from './context.ts';
import { readString } from './json.ts';
import { sha256Bytes } from './marker.ts';
import { mirrorMarker } from './mirror.ts';
import { STEP_IDS } from './runner.ts';
import { mergeHarness, type MergeHarness } from './testing/fake-assembler.ts';
import { fakeRouter } from './testing/scripted.ts';

const R = 'R01';
const SCENES = 'world/current/reference/09-scenes-and-people.md';

interface Cli {
  deps: EngineDeps;
  logs: string[];
}

/** EngineDeps over the harness ports (the CLI builds its own context from the temp forge root). */
function cli(h: MergeHarness): Cli {
  const logs: string[] = [];
  const idle = fakeRouter({}, { id: 'idle', family: 'DeepSeek', model: 'idle' });
  const backends: RoundBackends = {
    writers: [], baseline: idle, decoy: idle, defect: idle, judges: [...h.judges.values()].map((backend) => ({ backend, concurrency: 2 })),
    forecasters: [], maintainer: idle, mergeEditor: h.editor, calibGateway: new Map(),
  };
  return { logs, deps: { ports: h.ports, backends: () => backends, env: {}, pid: 9, isAlive: () => false, log: (line) => logs.push(line) } };
}

async function merged(): Promise<MergeHarness> {
  const h = await mergeHarness();
  h.decide({ pick: 'A', reason: '平', fav: 'A', publish: 'no', facts: ['A:A-01'] });
  assert.equal((await h.run()).exitCode, 0);
  return h;
}

function at(h: MergeHarness): { root: string; repo: string } {
  return { root: h.world.root, repo: h.world.repo };
}

test('forge merge runs 10a-regate … 10f-commit and refuses bad arguments before touching the round', async () => {
  assert.deepEqual([MERGE_FROM, MERGE_UNTIL], ['10a-regate', '10f-commit']);
  assert.ok(STEP_IDS.indexOf(MERGE_FROM) === STEP_IDS.indexOf('09b-decision') + 1);
  const h = await mergeHarness();
  const c = cli(h);
  for (const argv of [[], ['R1'], [R, 'R02'], [R, '--force'], [R, '--quota-budget-min', '0']]) {
    assert.equal(await mergeCommand(argv, c.deps, at(h)), 1, argv.join(' '));
  }
  // 09b is not marked (no decision yet): refused with the reason, nothing written
  assert.equal(await mergeCommand([R], c.deps, at(h)), 1);
  assert.match(c.logs.at(-1) ?? '', /09b-decision is not marked/u);
  rmSync(h.dir, { recursive: true, force: true });
});

test('forge mergecheck (moved onto merge.ts mergecheckWith): pass, unknown ref, a change outside 09 / 07 / 01–06, usage; verdicts on out, forge: errors on err', async () => {
  const h = await merged();
  const d8 = readString(JSON.parse(readFileSync(join(h.ctx.paths.dir, 'merge.json'), 'utf8')), 'current') ?? '';
  const title = readString(JSON.parse(readFileSync(join(h.ctx.paths.merge, d8, 'edit.json'), 'utf8')), 'title');
  const file = join(h.dir, 'merge-decision.json');
  writeFileSync(file, JSON.stringify({ round: R, baseLabel: 'A', title, rows: ['SHIP'], registered: [{ rxx: 'R01-01', label: 'A', factId: 'A-01' }] }));
  const out: string[] = [];
  const errs: string[] = [];
  const sinks = { out: (line: string): void => void out.push(line), err: (line: string): void => void errs.push(line) };
  const check = (argv: readonly string[]): Promise<number> => mergecheckCommand(argv, at(h), h.ports.git, sinks);
  assert.equal(await check(['--decision', file]), 0, errs.join('\n'));
  assert.deepEqual([out, errs], [['mergecheck 通过（对照 main）'], []]);
  assert.equal(await check(['--decision', file, '--base', 'no-such-ref']), 1);
  assert.equal(await check([]), 1);
  assert.equal(await check(['--decision', join(h.dir, 'missing.json')]), 1);
  assert.equal(out.length, 1, 'errors never reach out');
  assert.equal(errs.length, 3);
  assert.ok(errs.every((l) => l.startsWith('forge: ')), errs.join('\n'));
  assert.match(errs[0] ?? '', /unknown git ref no-such-ref/u);
  assert.match(errs[1] ?? '', /usage: forge mergecheck/u);
  assert.match(errs[2] ?? '', /cannot read .*missing\.json/u);
  appendFileSync(join(h.world.repo, 'world/current/reference/01-space-and-history.md'), '多写的一句。\n');
  assert.equal(await check(['--decision', file]), 1);
  assert.match(out.at(-1) ?? '', /^mergecheck 未通过（对照 main）：\n- /u);
  assert.equal(errs.length, 3, 'a failed verdict is not an error line');
  rmSync(h.dir, { recursive: true, force: true });
});

test('forge freeze --post-merge --check: clean → 0, drift lines → 1, round from the forge/r01 branch, refusals', async () => {
  const h = await merged();
  const c = cli(h);
  assert.equal(await postMergeCommand(['--post-merge', '--check', R], c.deps, at(h)), 0, c.logs.join('\n'));
  assert.match(c.logs.at(-1) ?? '', /world\/current matches rounds\/R01\/merge\/[0-9a-f]{8}\/post-merge\.json/u);
  appendFileSync(join(h.world.repo, SCENES), '多写的一句。\n');
  assert.equal(await postMergeCommand(['--post-merge', '--check'], c.deps, at(h)), 1);
  assert.deepEqual(c.logs.slice(-1), ['  ✖ file changed: reference/09-scenes-and-people.md']);
  for (const argv of [['--check'], ['--post-merge', 'R1'], ['--post-merge', R, 'R02'], ['--post-merge', '--bogus']]) {
    assert.equal(await postMergeCommand(argv, c.deps, at(h)), 1, argv.join(' '));
  }
  rmSync(h.dir, { recursive: true, force: true });

  const none = await mergeHarness();
  none.decide({ pick: 'none', reason: '平', fav: 'A', publish: 'no', facts: [] });
  assert.equal((await none.run()).exitCode, 0);
  const n = cli(none);
  assert.equal(await postMergeCommand(['--post-merge', '--check', R], n.deps, at(none)), 0);
  assert.match(n.logs.at(-1) ?? '', /picked none/u);
  rmSync(none.dir, { recursive: true, force: true });

  const early = await mergeHarness();
  const e = cli(early);
  assert.equal(await postMergeCommand(['--post-merge', '--check', R], e.deps, at(early)), 1);
  assert.match(e.logs.at(-1) ?? '', /09b-decision is not marked/u);
  rmSync(early.dir, { recursive: true, force: true });
});

test('forge freeze --post-merge --check: a decision file changed after the 09b pin is an integrity exit (3) with a forge: line, not a throw', async () => {
  const h = await merged();
  const c = cli(h);
  h.sim.tamper(`rounds/${R}/decision.json`, (text) => `${text} `);
  assert.equal(await postMergeCommand(['--post-merge', '--check', R], c.deps, at(h)), 3);
  assert.match(c.logs.at(-1) ?? '', /^forge: rounds\/R01\/decision\.json changed after 09b-decision pinned it$/u);
  rmSync(h.dir, { recursive: true, force: true });
});

test('forge mirror: --dry-run lists without posting; a failed post keeps exit 0 and backs off; the next due drain posts once', async () => {
  const h = await merged();
  const c = cli(h);
  const decisionSha = sha256Bytes(readFileSync(join(h.world.root, 'rounds', R, 'decision.json')));
  const marker = mirrorMarker('decision', R, decisionSha);
  assert.equal(await mirrorCommand(['--dry-run'], c.deps, at(h)), 0);
  assert.ok(c.logs.some((l) => l.startsWith(`${R} decision ${decisionSha}: ${marker} (failures 0, next try `)), c.logs.join('\n'));
  assert.match(c.logs.at(-1) ?? '', /pending mirrors in R01 \(dry run: nothing posted\)/u);
  assert.equal(h.ports.github.comments().length, 0);

  h.ports.github.failNext('createComment', 1);
  assert.equal(await mirrorCommand(['--round', R], c.deps, at(h)), 0);
  assert.match(c.logs.at(-1) ?? '', /R01: 0 posted, 1 failed, 0 rejected/u);
  assert.equal(await mirrorCommand([], c.deps, at(h)), 0, 'not due yet (backoff 2 min)');
  assert.equal(h.ports.github.comments().length, 0);
  h.ports.clock.advance(2 * 60_000);
  assert.equal(await mirrorCommand([], c.deps, at(h)), 0);
  assert.deepEqual(h.ports.github.comments().map((cm) => cm.body.split('\n', 1)[0]), [marker]);
  assert.equal(await mirrorCommand([], c.deps, at(h)), 0);
  assert.equal(c.logs.at(-1), 'no pending mirror');
  assert.equal(h.ports.github.comments().length, 1);

  for (const argv of [['--round', 'R1'], ['--round', 'R09'], ['R01'], ['--now']]) assert.equal(await mirrorCommand(argv, c.deps, at(h)), 1, argv.join(' '));
  rmSync(h.dir, { recursive: true, force: true });
});
