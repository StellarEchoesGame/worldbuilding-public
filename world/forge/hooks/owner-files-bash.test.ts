import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bashWritesOwnerFile, decide, hookOutput } from './owner-files.ts';

const FORGE = '/work/repo/world/forge';

function bash(command: string, cwd = FORGE): string {
  return decide({ tool_name: 'Bash', tool_input: { command }, cwd }).decision;
}

test('Bash with a writing construct on an owner path → deny', () => {
  const writes = [
    'echo x > owner-log.jsonl',
    'echo x >> owner-log.jsonl',
    'printf "%s" x 2>/dev/null >| rounds/R01/audit.json',
    'jq . /tmp/a.json > rounds/R01/decision.json',
    'echo x | tee -a owner-log.jsonl',
    'echo x | tee /tmp/copy calibration/owner-answers.json',
    "sed -i '' 's/a/b/' rounds/R01/decision.json",
    'sed -i.bak -e s/a/b/ owner-log.jsonl',
    "perl -pi -e 's/a/b/' rounds/R01/audit.json",
    'cp /tmp/decision.json rounds/R01/decision.json',
    'cp /tmp/audit.json rounds/R01/',
    'mv rounds/R01/decision.json /tmp/old.json',
    'mv /tmp/x rounds/R01/decision-2.json',
    'ln -sf /tmp/x owner-log.jsonl',
    'install -m 644 /tmp/x rounds/R01/audit.json',
    'rm rounds/R01/audit.json',
    'rm -rf rounds/R01',
    'rm -f rounds/*/decision*.json',
    'touch owner-log.jsonl',
    'truncate -s 0 owner-log.jsonl',
    'dd if=/dev/zero of=owner-log.jsonl bs=1 count=1',
    'git checkout -- rounds/R01/decision.json',
    'git restore owner-log.jsonl',
    'git rm --cached calibration/owner-answers.json',
    'git mv rounds/R01/audit.json rounds/R01/audit-old.json',
    "python3 -c \"open('rounds/R01/audit.json','w').write('{}')\"",
    "node -e \"require('fs').appendFileSync('owner-log.jsonl', 'x')\"",
    "node -e \"fs.writeFileSync('rounds/R01/decision.json', s)\"",
    "ruby -e \"File.open('owner-log.jsonl','a')\"",
    "python -c \"import pathlib; pathlib.Path('calibration/owner-answers.json').write_text('{}')\"",
    'cd rounds/R01 && echo {} > audit.json',
    'cat <<EOF > rounds/R01/audit.json\n{}\nEOF',
    'bash -c "echo x >> owner-log.jsonl"',
    'echo $(echo x > owner-log.jsonl)',
    'ECHO=1 echo x > ROUNDS/r01/AUDIT.JSON',
    'echo x > rounds/R01/{audit,topic}.json',
    'jq . owner-log.jsonl | sponge owner-log.jsonl',
  ];
  for (const c of writes) {
    assert.equal(bashWritesOwnerFile(c), true, c);
    assert.equal(bash(c), 'deny', c);
  }
});

test('read-only Bash on owner paths → allow', () => {
  const reads = [
    'cat owner-log.jsonl',
    'head -n 3 rounds/R01/audit.json; tail -1 owner-log.jsonl',
    "sed -n '1,20p' rounds/R01/decision.json",
    'grep -n pick rounds/*/decision*.json',
    "jq '.answers' rounds/R01/audit.json",
    'jq . rounds/R01/decision.json > /tmp/decision-copy.json',
    'git diff -- owner-log.jsonl && git show HEAD:world/forge/owner-log.jsonl | wc -l',
    'git log --oneline -- rounds/R01/audit.json',
    'diff rounds/R01/decision.json rounds/R01/decision-2.json',
    'less calibration/owner-answers.json',
    'cp rounds/R01/audit.json /tmp/audit-copy.json',
    'echo "rounds/R01/audit.json > x" ',
    "grep -c '>' owner-log.jsonl",
  ];
  for (const c of reads) {
    assert.equal(bashWritesOwnerFile(c), false, c);
    assert.equal(bash(c), 'allow', c);
  }
});

test('unrelated Bash → allow', () => {
  for (const c of ['npm test', 'echo x > /tmp/out.txt', 'rm -rf /tmp/forge-x', 'git checkout main', 'sed -i "" s/a/b/ writers.json', "node -e \"fs.writeFileSync('/tmp/a.json', '{}')\"", 'touch rounds/R01/topic.json']) {
    assert.equal(bash(c), 'allow', c);
  }
});

test('malformed input → allow', () => {
  for (const bad of [null, 'text', 42, [], {}, { tool_name: 'Bash' }, { tool_name: 'Bash', tool_input: { command: 7 } }, { tool_name: 'Write', tool_input: null }, { tool_name: 'Write', tool_input: { file_path: 3 } }]) {
    assert.equal(decide(bad).decision, 'allow', JSON.stringify(bad));
  }
});

test('hookOutput: deny JSON for Claude Code, empty on allow', () => {
  const deny = hookOutput({ decision: 'deny', reason: 'owner-only' });
  assert.deepEqual(JSON.parse(deny), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'owner-only' } });
  assert.equal(hookOutput({ decision: 'allow', reason: '' }), '');
});

test('CLI entry: stdin JSON → stdout decision, exit 0; malformed stdin → allow', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-hook-'));
  mkdirSync(join(dir, 'rounds', 'R01'), { recursive: true });
  writeFileSync(join(dir, 'rounds', 'R01', 'status.json'), '{}');
  const script = join(import.meta.dirname, 'owner-files.ts');
  const run = (stdin: string): { status: number | null; stdout: string } => {
    const r = spawnSync(process.execPath, [script], { input: stdin, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout };
  };
  const denied = run(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'rounds/R01/audit.json' }, cwd: dir }));
  assert.equal(denied.status, 0);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const allowed = run(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'rounds/R01/status.json' }, cwd: dir }));
  assert.deepEqual(allowed, { status: 0, stdout: '' });
  assert.deepEqual(run('{not json'), { status: 0, stdout: '' });
  rmSync(dir, { recursive: true });
});

test('recursive removals, reverts and copies over a tree that holds owner files → deny', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-hook-tree-'));
  mkdirSync(join(dir, 'rounds', 'R01'), { recursive: true });
  for (const c of ['git checkout .', 'git restore --source=HEAD~1 .', 'find . -name "*.json" -delete', 'rm -rf rounds', 'mv rounds /tmp/rounds-old', 'cp -r /tmp/r rounds/', 'rsync -a /tmp/r/ rounds/R01/']) {
    assert.equal(bash(c, dir), 'deny', c);
  }
  for (const c of ['git checkout main', 'find . -name "*.json"', 'rm -rf .runs', 'cp /tmp/notes.md rounds/R01/notes.md']) {
    assert.equal(bash(c, dir), 'allow', c);
  }
  rmSync(dir, { recursive: true });
});

test('code fed on stdin (here-document, here-string, pipe) that writes an owner file → deny', () => {
  const writes = [
    "python3 - <<'EOF'\nopen('rounds/R01/audit.json','w').write('x')\nEOF",
    "bash <<'EOF'\necho x > rounds/R01/audit.json\nEOF",
    "node - <<'EOF'\nrequire('fs').writeFileSync('owner-log.jsonl','')\nEOF",
    'python3 <<EOF\nopen("owner-log.jsonl","a").write("x")\nEOF',
    "python3.12 - <<-EOF\n\topen('owner-log.jsonl','a')\n\tEOF",
    'sh <<EOF && echo done\ntouch owner-log.jsonl\nEOF',
    "python3 - <<< \"open('owner-log.jsonl','a')\"",
    'bash -s <<< "rm owner-log.jsonl"',
    "echo \"open('owner-log.jsonl','a')\" | python3",
    'echo "echo x > owner-log.jsonl" | bash',
    "cat <<'EOF' | sh\nrm rounds/R01/audit.json\nEOF",
  ];
  for (const c of writes) assert.equal(bash(c), 'deny', c);
});

test('stdin-fed code and interpreters that only read owner files → allow', () => {
  const reads = [
    "python3 - <<'EOF'\nimport json\nprint(json.load(open('rounds/R01/audit.json')))\nEOF",
    "bash <<'EOF'\ncat owner-log.jsonl\nEOF",
    "cat rounds/R01/audit.json | python3 -c 'import json,sys; print(json.load(sys.stdin))'",
    'cat owner-log.jsonl | python3 -m json.tool',
    "echo 'print(1)' | python3",
    "git commit -F - <<'EOF'\nfix: stop the rm of audit.json in tests\nEOF",
    "cat <<'EOF' > /tmp/notes.md\nrounds/R01/audit.json is owner-only\nEOF",
  ];
  for (const c of reads) assert.equal(bash(c), 'allow', c);
});

test('wrappers with option values and xargs-fed paths → deny', () => {
  const writes = [
    'nice -n 10 tee rounds/R01/audit.json',
    'timeout 5 tee owner-log.jsonl',
    'timeout -k 2 5s rm owner-log.jsonl',
    'stdbuf -o0 tee owner-log.jsonl',
    'stdbuf -o L tee owner-log.jsonl',
    'echo x | sudo -u roy tee rounds/R01/audit.json',
    'sudo -E -u roy rm owner-log.jsonl',
    'ionice -c 3 cp /tmp/x owner-log.jsonl',
    'caffeinate -i tee owner-log.jsonl',
    'flock /tmp/lock tee owner-log.jsonl',
    "env -S 'tee owner-log.jsonl'",
    'echo rounds/R01/audit.json | xargs rm',
    'ls rounds/*/audit.json | xargs truncate -s0',
    'xargs -I{} cp /tmp/x {} <<< rounds/R01/audit.json',
    'find . -name owner-log.jsonl -print0 | xargs -0 rm -f',
    // no writer verb after the wrapper: only the option/operand table exposes the interpreter
    "timeout 30 python3 -c \"open('owner-log.jsonl','a')\"",
    'nice -n 5 bash -c "echo x > owner-log.jsonl"',
    "sudo -u roy node - <<'EOF'\nrequire('fs').writeFileSync('rounds/R01/decision.json','{}')\nEOF",
  ];
  for (const c of writes) assert.equal(bash(c), 'deny', c);
  for (const c of ['nice -n 10 cat owner-log.jsonl', 'timeout 5 tee /tmp/out.txt', 'sudo -u roy cat rounds/R01/audit.json', 'find rounds -name audit.json | xargs cat', 'echo /tmp/a | xargs rm']) {
    assert.equal(bash(c), 'allow', c);
  }
});
