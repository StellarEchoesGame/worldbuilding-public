export type JsonRecord = { [key: string]: unknown };

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readString(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const v = value[key];
  return typeof v === 'string' ? v : null;
}

export function readNumber(value: unknown, key: string): number | null {
  if (!isRecord(value)) return null;
  const v = value[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function readBoolean(value: unknown, key: string): boolean | null {
  if (!isRecord(value)) return null;
  const v = value[key];
  return typeof v === 'boolean' ? v : null;
}

export function readArray(value: unknown, key: string): unknown[] | null {
  if (!isRecord(value)) return null;
  const v = value[key];
  return Array.isArray(v) ? v : null;
}

export function readRecord(value: unknown, key: string): JsonRecord | null {
  if (!isRecord(value)) return null;
  const v = value[key];
  return isRecord(v) ? v : null;
}

export function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}

function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Returns the first JSON object embedded in model output (bare, fenced or wrapped in prose). */
export function extractJsonObject(text: string): JsonRecord | null {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = balancedEnd(text, start);
    if (end === -1) continue;
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1));
      if (isRecord(parsed)) return parsed;
    } catch {
      // not a JSON object at this position; keep scanning
    }
  }
  return null;
}
