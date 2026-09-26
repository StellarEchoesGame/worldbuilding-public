import { statSync } from 'node:fs';
import { resolve } from 'node:path';

function identity(path: string): string | null {
  try {
    const s = statSync(path, { bigint: true, throwIfNoEntry: false });
    return s === undefined ? null : `${s.dev}:${s.ino}`;
  } catch {
    return null;
  }
}

/**
 * True when `a` and `b` name the same directory: lexically equal after resolve, or the same existing
 * filesystem object (device and inode), so a symlinked alias or a case variant on a case-insensitive
 * volume matches. Guards that must recognise the real forge root use this, never a string comparison.
 */
export function sameDir(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  const ia = identity(a);
  return ia !== null && ia === identity(b);
}
