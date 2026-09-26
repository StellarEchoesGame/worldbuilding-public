import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { childSpawner, drainEnv, drainMirror, mirrorDrainArgs, nodeSpawner, type ChildLike, type SpawnResult, type Spawner } from './mirror-drain.ts';

test('mirrorDrainArgs: node engine/cli.ts mirror --round RNN; bad ids throw', () => {
  assert.deepEqual(mirrorDrainArgs('R03'), ['engine/cli.ts', 'mirror', '--round', 'R03']);
  for (const bad of ['r03', 'R3', 'R03; rm -rf /', '--round', '']) assert.throws(() => mirrorDrainArgs(bad), bad);
});

test('drainEnv drops the UI token, data dir and clock file and keeps the rest', () => {
  const env = drainEnv({ PATH: '/bin', HOME: '/h', FORGE_UI_TOKEN: 'secret', FORGE_DATA_DIR: '/d', FORGE_UI_CLOCK_FILE: '/c', HOST: '127.0.0.1' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', HOST: '127.0.0.1' });
});

function fake(result: SpawnResult | Error, seen: Array<{ cmd: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }>): Spawner {
  return async (cmd, args, opts) => {
    seen.push({ cmd, args, ...opts });
    if (result instanceof Error) throw result;
    return result;
  };
}

test('drainMirror runs the CLI in the forge root with the scrubbed env and reports the last stdout line', async () => {
  const seen: Array<{ cmd: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }> = [];
  const r = await drainMirror({
    forgeRoot: '/forge',
    round: 'R02',
    spawner: fake({ exitCode: 0, stdout: 'x\nR02: 1 posted, 0 failed, 0 rejected by the public-content scan\n\n', stderr: '', timedOut: false }, seen),
    env: { PATH: '/bin', FORGE_UI_TOKEN: 'secret' },
    timeoutMs: 5000,
  });
  assert.deepEqual(r, { ok: true, exitCode: 0, summary: 'R02: 1 posted, 0 failed, 0 rejected by the public-content scan' });
  assert.equal(seen[0]?.cmd, process.execPath);
  assert.deepEqual(seen[0]?.args, ['engine/cli.ts', 'mirror', '--round', 'R02']);
  assert.equal(seen[0]?.cwd, '/forge');
  assert.equal(seen[0]?.env['FORGE_UI_TOKEN'], undefined);
  assert.equal(seen[0]?.timeoutMs, 5000);
});

test('drainMirror: exit 1 (engine lock held), other exits, timeout and spawn errors → ok false in Chinese', async () => {
  const run = (res: SpawnResult | Error): ReturnType<typeof drainMirror> => drainMirror({ forgeRoot: '/forge', round: 'R02', spawner: fake(res, []), env: {}, timeoutMs: 10 });
  const locked = await run({ exitCode: 1, stdout: '', stderr: 'forge: engine lock held by pid 42 since 2026-09-01T00:00:00Z\n', timedOut: false });
  assert.ok(!locked.ok && /引擎锁/u.test(locked.error) && /pid 42/u.test(locked.error));
  const failed = await run({ exitCode: 3, stdout: '', stderr: 'integrity\n', timedOut: false });
  assert.ok(!failed.ok && /3/u.test(failed.error));
  const slow = await run({ exitCode: null, stdout: '', stderr: '', timedOut: true });
  assert.ok(!slow.ok && /超时/u.test(slow.error));
  const broken = await run(new Error('spawn ENOENT'));
  assert.ok(!broken.ok && /ENOENT/u.test(broken.error));
  const bad = await drainMirror({ forgeRoot: '/forge', round: 'nope', spawner: fake(new Error('never'), []), env: {}, timeoutMs: 10 });
  assert.ok(!bad.ok);
});

test('nodeSpawner runs a real child, captures output and stops it at the timeout', async () => {
  const done = await nodeSpawner(process.execPath, ['-e', 'process.stdout.write("hi\\n"); process.exitCode = 4'], { cwd: process.cwd(), env: { PATH: process.env['PATH'] }, timeoutMs: 10_000 });
  assert.deepEqual(done, { exitCode: 4, stdout: 'hi\n', stderr: '', timedOut: false });
  const slow = await nodeSpawner(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { cwd: process.cwd(), env: {}, timeoutMs: 200 });
  assert.equal(slow.timedOut, true);
});

/** A child whose `close` fires only when `closeOn` says so for the signal received (never: it ignores every signal). */
class FakeChild extends EventEmitter implements ChildLike {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kills: string[] = [];
  closeOn: (signal: string) => boolean = () => false;
  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal);
    if (this.closeOn(signal)) setImmediate(() => this.emit('close', null));
    return true;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((wake) => setTimeout(wake, ms));

/** Rejects when `p` has not settled after `ms` (a ref'd timer: the spawner's own timers are unref'd). */
async function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_ok, fail) => { timer = setTimeout(() => fail(new Error(`not settled within ${ms} ms`)), ms); });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

test('childSpawner: a child whose close never fires resolves at the timeout with timedOut, then gets SIGKILL after the grace', async () => {
  const child = new FakeChild();
  const spawner = childSpawner(() => child, 80);
  const started = Date.now();
  const pending = spawner('node', ['x'], { cwd: '/', env: {}, timeoutMs: 40 });
  child.stdout.emit('data', Buffer.from('partial\n'));
  const r = await within(pending, 40 + 80);
  assert.deepEqual(r, { exitCode: null, stdout: 'partial\n', stderr: '', timedOut: true });
  assert.ok(Date.now() - started < 40 + 80, 'resolved before the grace ran out');
  assert.deepEqual(child.kills, ['SIGTERM']);
  await sleep(120);
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
});

test('childSpawner: a child that exits on SIGTERM is not killed again; a normal exit clears both timers', async () => {
  const obeys = new FakeChild();
  obeys.closeOn = (signal) => signal === 'SIGTERM';
  const r = await within(childSpawner(() => obeys, 60)('node', [], { cwd: '/', env: {}, timeoutMs: 20 }), 200);
  assert.equal(r.timedOut, true);
  await sleep(100);
  assert.deepEqual(obeys.kills, ['SIGTERM']);
  const quick = new FakeChild();
  const pending = childSpawner(() => quick, 60)('node', [], { cwd: '/', env: {}, timeoutMs: 40 });
  quick.stderr.emit('data', Buffer.from('warn\n'));
  quick.emit('close', 0);
  assert.deepEqual(await within(pending, 200), { exitCode: 0, stdout: '', stderr: 'warn\n', timedOut: false });
  await sleep(120);
  assert.deepEqual(quick.kills, []);
});

test('childSpawner timers are unref\'d: a pending timeout and grace keep no process alive', () => {
  const script = `import { EventEmitter } from 'node:events';
import { childSpawner } from ${JSON.stringify(new URL('./mirror-drain.ts', import.meta.url).href)};
const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
void childSpawner(() => child, 60000)('node', [], { cwd: '/', env: {}, timeoutMs: 60000 });`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 10_000, encoding: 'utf8' });
  assert.equal(r.status, 0, `exit ${String(r.status)} signal ${String(r.signal)}: ${r.stderr}`);
});
