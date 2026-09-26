import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readStatus } from '../../../engine/runner.ts';

export interface NavLink {
  label: string;
  href: string;
  /** The current page belongs to this section. */
  current: boolean;
}

const ROUND_ID = /^[A-Z]\d{2}$/u;

/** Newest round (id order) with a status.json whose state is not `done`; an unreadable status counts as active. */
export function activeRoundId(root: string): string | null {
  const dir = join(root, 'rounds');
  if (!existsSync(dir)) return null;
  for (const id of readdirSync(dir).filter((n) => ROUND_ID.test(n)).sort().reverse()) {
    if (!existsSync(join(dir, id, 'status.json'))) continue;
    const st = readStatus(root, id);
    if (st.ok && st.value.state === 'done') continue;
    return id;
  }
  return null;
}

/** Path prefixes of each nav section (the first entry is the section's own index page). */
const SECTIONS: ReadonlyArray<{ label: string; prefixes: readonly string[] }> = [
  { label: '总览', prefixes: ['/'] },
  { label: '选题', prefixes: ['/topic', '/game-need'] },
  { label: '轮次', prefixes: ['/rounds'] },
  { label: '校准', prefixes: ['/calibration'] },
  { label: '基准', prefixes: ['/benchmark'] },
  { label: '配置', prefixes: ['/config'] },
  { label: '镜像', prefixes: ['/mirror'] },
];

function inSection(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => (p === '/' ? pathname === '/' : pathname === p || pathname.startsWith(`${p}/`)));
}

/**
 * The header nav 总览 · 选题 · 轮次 · 校准 · 基准 · 配置 · 镜像. 选题 and 轮次 open the active round when it has a
 * topic page (topic-offer.json or topic.json) or a round page (brief.json); otherwise their index pages.
 */
export function navLinks(root: string, pathname: string): NavLink[] {
  const active = activeRoundId(root);
  const has = (file: string): boolean => active !== null && existsSync(join(root, 'rounds', active, file));
  return SECTIONS.map(({ label, prefixes }) => {
    let href = prefixes[0] ?? '/';
    if (label === '选题' && active !== null && (has('topic-offer.json') || has('topic.json'))) href = `/topic/${active}`;
    if (label === '轮次' && active !== null && has('brief.json')) href = `/rounds/${active}`;
    return { label, href, current: inSection(pathname, prefixes) };
  });
}
