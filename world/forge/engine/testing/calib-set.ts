// Test-only: the hand-built calibration set of engine/calib-run.test.ts (four pairs, five display slots, one dry-run
// copy) and the files c1-build would leave for it. Imported only by tests.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CalibSetRecord } from '../calib-build.ts';
import type { Family } from '../config.ts';
import { sha256 } from '../store.ts';
import { quoteSpan } from '../tasks/fenced.ts';

const SEED = '0123456789abcdef'.repeat(4);
export const INJECTED = '冷湾的港口从来没有过任何常住居民。';
const PRIMARY = 'deepseek-fixture-a';

export function body(n: number): string {
  return `编号${n}的现场：温芮在第${n}邻里修好了循环泵，林澈把菌毯卷好送回培养架。`;
}

/** Text n of a hand-built set: [role, model, author family, of]; T08 is T07 with a cliché, T09 its dry-run copy. */
const TEXTS: ReadonlyArray<readonly [number, 'passage' | 'rewrite' | 'degraded' | 'defect', string | null, Family, number | null]> = [
  [1, 'passage', null, 'OpenAI', null], [2, 'rewrite', PRIMARY, 'DeepSeek', null], [3, 'rewrite', PRIMARY, 'DeepSeek', null],
  [4, 'rewrite', 'qwen/fixture-b', 'Alibaba', null], [5, 'rewrite', PRIMARY, 'DeepSeek', null], [6, 'rewrite', PRIMARY, 'DeepSeek', null],
  [7, 'rewrite', PRIMARY, 'DeepSeek', null], [8, 'degraded', PRIMARY, 'DeepSeek', 7], [9, 'defect', PRIMARY, 'DeepSeek', 7],
];

function textOf(n: number): string {
  if (n === 8) return body(7).replace('修好了循环泵', '仿佛修好了循环泵');
  if (n === 9) return `${body(7)}${INJECTED}`;
  return body(n);
}

/** P01 canon_vs_rewrite (OpenAI authored), P02 cross_model, P03 stance, P04 known; slot 5 retests slot 1 swapped. */
export function setRecord(set: string, kind: CalibSetRecord['kind'], family: Family | null): CalibSetRecord {
  const t = (n: number): string => `${set}-T0${n}`;
  const texts: CalibSetRecord['texts'] = {};
  for (const [n, role, model, author, of] of TEXTS) {
    texts[t(n)] = {
      path: `texts/${t(n)}.md`, sha256: sha256(textOf(n)), role, model, author_family: author, stance: role === 'rewrite' ? 'resident-day' : null,
      source: role === 'passage' ? { file: 'reference/05-ecology-and-everyday.md', quote_sha256: sha256(textOf(n)) } : null,
      of: of === null ? null : t(of), call: role === 'passage' ? null : `calibrewrite-${t(n)}`,
    };
  }
  const split = kind === 'round0' ? 'visible' : 'none';
  const pairs: CalibSetRecord['pairs'] = [
    { id: `${set}-P01`, category: 'canon_vs_rewrite', a: t(1), b: t(2), known_better: null, authors: ['DeepSeek', 'OpenAI'], split },
    { id: `${set}-P02`, category: 'cross_model', a: t(3), b: t(4), known_better: null, authors: ['Alibaba', 'DeepSeek'], split },
    { id: `${set}-P03`, category: 'stance', a: t(5), b: t(6), known_better: null, authors: ['DeepSeek'], split },
    { id: `${set}-P04`, category: 'known', a: t(7), b: t(8), known_better: t(7), authors: ['DeepSeek'], split },
  ];
  const display: CalibSetRecord['display'] = [
    { slot: 1, pair: `${set}-P02`, left: t(3), right: t(4), retest_of: null }, { slot: 2, pair: `${set}-P01`, left: t(2), right: t(1), retest_of: null },
    { slot: 3, pair: `${set}-P04`, left: t(8), right: t(7), retest_of: null }, { slot: 4, pair: `${set}-P03`, left: t(5), right: t(6), retest_of: null },
    { slot: 5, pair: `${set}-P02`, left: t(4), right: t(3), retest_of: 1 },
  ];
  const span = quoteSpan(INJECTED, textOf(9));
  if (span === null) throw new Error('fixture: injected sentence not found');
  const dryrun = kind === 'requal' ? [] : [{ id: `${set}-G1`, defect_type: 'D1', base: t(7), copy: t(9), injected: INJECTED, injected_span: span, against: 'F01' }];
  return { kind, family, reason: kind === 'requal' ? 'calibration_fail' : null, seed: SEED, built_at: '2026-10-01T00:00:00.000Z', size: display.length, texts, pairs, display, dryrun };
}

export function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

/** pairs.json (set added), texts and `<set>/reference.json`, as c1-build leaves them. */
export function writeSet(root: string, set: string, record: CalibSetRecord): void {
  put(root, 'calibration/pairs.json', `${JSON.stringify({ schema: 'calib-pairs/1', sets: { [set]: record } }, null, 2)}\n`);
  for (const [id, t] of Object.entries(record.texts)) put(root, `calibration/${t.path}`, textOf(Number(id.slice(-2))));
  const facts = [{ id: 'F01', kind: 'fact', text: '冷湾的港口有常住居民。', status: '共同事实', rows: ['S1-冷湾'] }];
  put(root, `calibration/${set}/reference.json`, `${JSON.stringify({ facts, regression: [], forbidden: [] }, null, 2)}\n`);
}
