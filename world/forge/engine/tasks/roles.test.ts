import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WRITER_ROLE } from '../brief.ts';
import { TASK_ROLES } from './roles.ts';

test('every task role is a distinct Chinese sentence, distinct from the writer role', () => {
  assert.equal(TASK_ROLES.length, 18);
  assert.equal(new Set([...TASK_ROLES, WRITER_ROLE]).size, TASK_ROLES.length + 1);
  for (const role of TASK_ROLES) assert.match(role, /^你是[\p{Script=Han}《》，、：。！？“”\s]+。$/u);
});
