import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNumber, readString } from './json.ts';
import { LOCK_FILE, runSteps, verifyChain } from './runner.ts';
import { readJson, readLines } from './store.ts';
import { readTaskRecord } from './task.ts';
import { KILL_SIGNAL, KILL_STEPS, KILL_STRAY, KILL_TASK, KILL_TASKS, processAlive, toyContext, toyWorld } from './testing/kill-child.ts';

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'testing', 'kill-child.ts');

/** Up to 60 s for a cold child (type stripping, toy world, three calls) on a slow CI runner; a child exit fails at once. */
const SIGNAL_POLLS = 2400;

/** Polls for the child's signal file (cross-process, so real timers); fails if the child exits first. */
async function waitForSignal(path: string, child: ChildProcess, stderr: string[]): Promise<void> {
  for (let i = 0; i < SIGNAL_POLLS; i += 1) {
    if (existsSync(path)) return;
    if (child.exitCode !== null) throw new Error(`child exited ${child.exitCode} before blocking: ${stderr.join('')}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`child never blocked: ${stderr.join('')}`);
}

test('a SIGKILLed run resumes: dead lock taken over, stray tmp deleted, call record recovered, no call repeated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-kill-'));
  const world = toyWorld(dir);
  const stderr: string[] = [];
  const child = spawn(process.execPath, [CHILD, dir], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  await waitForSignal(join(dir, KILL_SIGNAL), child, stderr);
  child.kill('SIGKILL');
  await exited;
  const childPid = child.pid;
  assert.ok(childPid !== undefined);

  const lockPath = join(world.root, LOCK_FILE);
  assert.equal(readNumber(readJson(lockPath), 'pid'), childPid, 'the killed run leaves its lock');
  assert.ok(existsSync(join(world.root, KILL_STRAY)));
  const round = join(world.root, 'rounds', 'R01');
  assert.ok(existsSync(join(round, 'calls', `${KILL_TASK}-a1.json`)), 'call record written before the kill');
  assert.ok(!existsSync(join(round, 'tasks', `${KILL_TASK}.json`)), 'no task record after the kill');
  assert.ok(existsSync(join(round, 'markers', '00-start.json')));
  assert.ok(!existsSync(join(round, 'markers', '01-topic.json')));
  assert.deepEqual(readLines(world.callLog), ['toy-t1#1', 'toy-t2#1', 'toy-t3#1']);
  const killedCall = readFileSync(join(round, 'calls', `${KILL_TASK}-a1.json`), 'utf8');

  const logs: string[] = [];
  const ctx = toyContext(world, { logs, concurrency: 1 });
  const report = await runSteps(ctx, { pipeline: 'round', steps: KILL_STEPS, until: null, from: null, redoFrom: null, pid: process.pid, isAlive: processAlive });
  assert.equal(report.exitCode, 0, report.detail);
  assert.ok(logs.includes(`lock taken over from pid ${childPid}`), logs.join('\n'));
  assert.ok(!existsSync(join(world.root, KILL_STRAY)), 'stray tmp deleted');
  assert.ok(!existsSync(lockPath), 'lock released after a clean exit');
  const calls = readLines(world.callLog);
  assert.deepEqual(calls, KILL_TASKS.map((t) => `${t}#1`), 'every task called exactly once across both processes');
  const record = readTaskRecord(join(round, 'tasks', `${KILL_TASK}.json`));
  assert.ok(record !== null && record.ok, 'the real runTask wrote the task record');
  assert.equal(record.value.status, 'ok');
  assert.deepEqual(record.value.calls, [`${KILL_TASK}-a1`]);
  assert.equal(readFileSync(join(round, 'calls', `${KILL_TASK}-a1.json`), 'utf8'), killedCall, 'recovered from calls/ + .out.txt, not called again');
  assert.equal(readString(readJson(join(round, 'status.json')), 'state'), 'done');
  assert.deepEqual(verifyChain(world.root, 'rounds/R01', KILL_STEPS.map((s) => s.id)), []);
  rmSync(dir, { recursive: true, force: true });
});
