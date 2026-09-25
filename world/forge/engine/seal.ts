import { createHash, randomBytes } from 'node:crypto';
import { isRecord } from './json.ts';

export interface Sealed {
  canonical: string;
  nonceHex: string;
  probe: string;
}

const NONCE_BYTES = 32;
const HEX_32_BYTES = /^[0-9a-f]{64}$/u;

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function encode(value: unknown, ancestors: Set<object>, path: string): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));
  if (typeof value !== 'object') throw new TypeError(`canonicalJson: ${typeof value} is not a JSON value at ${path}`);
  if (ancestors.has(value)) throw new TypeError(`canonicalJson: cycle at ${path}`);
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    ancestors.add(value);
    const parts: string[] = [];
    for (let i = 0; i < items.length; i += 1) parts.push(encode(items[i], ancestors, `${path}[${i}]`));
    ancestors.delete(value);
    return `[${parts.join(',')}]`;
  }
  if (!isRecord(value) || !isPlainObject(value)) throw new TypeError(`canonicalJson: non-plain object at ${path}`);
  const entries = Object.entries(value)
    .map(([raw, child]) => ({ key: raw.normalize('NFC'), child }))
    .sort((a, b) => compareCodeUnits(a.key, b.key));
  ancestors.add(value);
  const parts: string[] = [];
  let previous: string | null = null;
  for (const { key, child } of entries) {
    // two distinct keys that are canonically equivalent would make the canonical form ambiguous
    if (key === previous) throw new TypeError(`canonicalJson: duplicate key after NFC at ${path}: ${JSON.stringify(key)}`);
    previous = key;
    parts.push(`${JSON.stringify(key)}:${encode(child, ancestors, `${path}.${key}`)}`);
  }
  ancestors.delete(value);
  return `{${parts.join(',')}}`;
}

/** Deterministic JSON text: sorted keys (UTF-16 order), NFC strings, no whitespace, one trailing LF. */
export function canonicalJson(value: unknown): string {
  return `${encode(value, new Set<object>(), '$')}\n`;
}

function probeOf(nonce: Buffer, canonical: string): string {
  return createHash('sha256').update(nonce).update(canonical, 'utf8').digest('hex');
}

export function seal(value: unknown, nonce: Buffer): Sealed {
  if (nonce.length !== NONCE_BYTES) throw new RangeError(`seal: nonce must be ${NONCE_BYTES} bytes, got ${nonce.length}`);
  const canonical = canonicalJson(value);
  return { canonical, nonceHex: nonce.toString('hex'), probe: probeOf(nonce, canonical) };
}

/** Only lowercase 64-digit hex is accepted for nonce and probe, as produced by `seal`. */
export function verifySeal(canonical: string, nonceHex: string, probe: string): boolean {
  if (!HEX_32_BYTES.test(nonceHex) || !HEX_32_BYTES.test(probe)) return false;
  return probeOf(Buffer.from(nonceHex, 'hex'), canonical) === probe;
}

export function newNonce(): Buffer {
  return randomBytes(NONCE_BYTES);
}
