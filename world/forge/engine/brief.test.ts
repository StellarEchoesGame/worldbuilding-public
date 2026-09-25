import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baselinePrompt, parseCell, writerPrompt, type Canon } from './brief.ts';

const cellJson: unknown = {
  id: 'C1', row_id: 'SHIP', title: '标题', entity: '实体', time: '时间', layers: ['物件'], setting_notes: ['注'],
  protagonists: ['温芮'], forbidden: ['禁一'], stances: [{ id: 's1', text: '立场一' }],
};
const canon: Canon = { book: 'BOOK正文', reference: 'REF正文', bookSha256: 'b', referenceSha256: 'r' };

test('parseCell validates required fields', () => {
  const r = parseCell(cellJson);
  assert.equal(r.ok, true);
  const bad = parseCell({ id: 'C1' });
  assert.equal(bad.ok, false);
});

test('writerPrompt embeds canon, stance, requirements and the output format', () => {
  const r = parseCell(cellJson);
  assert.ok(r.ok);
  if (!r.ok) return;
  const p = writerPrompt(r.value, canon, 's1');
  for (const s of ['BOOK正文', 'REF正文', '立场一', '温芮', '禁一', '```submission', '```delta', '```interface', '2500']) assert.ok(p.includes(s), s);
});

test('baselinePrompt forbids new facts', () => {
  const r = parseCell(cellJson);
  assert.ok(r.ok);
  if (!r.ok) return;
  const p = baselinePrompt(r.value, canon);
  assert.ok(p.includes('不得新增任何作者事实'));
  assert.ok(!p.includes('立场一'));
});
