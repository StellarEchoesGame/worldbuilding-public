import { extractJsonObject, isRecord, readArray, readBoolean, readString, stringArray, type JsonRecord } from './json.ts';
import { err, ok, type Result } from './result.ts';

export type ClaimKind = 'author_fact' | 'character_belief' | 'rumor';

export interface Claim {
  id: string;
  kind: ClaimKind;
  claim: string;
  status: string;
  rowId: string;
  attachesTo: string;
  extends: string;
  misuse: string;
  sourceQuote: string;
  register: boolean;
}

export interface Delta {
  newProperNouns: string[];
  claims: Claim[];
}

export interface InterfaceCard {
  shots: JsonRecord[];
  object: JsonRecord | null;
  hook: JsonRecord | null;
  raw: JsonRecord;
}

export interface WriterOutput {
  submission: string;
  delta: Delta;
  iface: InterfaceCard;
  seeds: string[];
}

function isClaimKind(v: string): v is ClaimKind {
  return v === 'author_fact' || v === 'character_belief' || v === 'rumor';
}

function blocks(text: string): { blocks: Map<string, string>; after: string } {
  const found = new Map<string, string>();
  const lines = text.split('\n');
  let name: string | null = null;
  let buf: string[] = [];
  let lastEnd = 0;
  for (const [i, line] of lines.entries()) {
    if (name === null) {
      const m = /^\s*```\s*(submission|delta|interface)\s*$/u.exec(line);
      if (m !== null) {
        name = m[1] ?? null;
        buf = [];
      }
    } else if (/^\s*```\s*$/u.test(line)) {
      found.set(name, buf.join('\n').trim());
      name = null;
      lastEnd = i + 1;
    } else {
      buf.push(line);
    }
  }
  return { blocks: found, after: lines.slice(lastEnd).join('\n') };
}

function parseClaim(value: unknown, index: number): Result<Claim> {
  const id = readString(value, 'id');
  const kind = readString(value, 'kind');
  const claim = readString(value, 'claim');
  const sourceQuote = readString(value, 'source_quote');
  if (id === null || kind === null || claim === null || sourceQuote === null) return err(`delta claims[${index}]: id, kind, claim and source_quote are required`);
  if (!isClaimKind(kind)) return err(`delta claims[${index}]: kind is not author_fact, character_belief or rumor`);
  return ok({
    id,
    kind,
    claim,
    status: readString(value, 'status') ?? '',
    rowId: readString(value, 'row_id') ?? '',
    attachesTo: readString(value, 'attaches_to') ?? '',
    extends: readString(value, 'extends') ?? '',
    misuse: readString(value, 'misuse') ?? '',
    sourceQuote,
    register: readBoolean(value, 'register') === true,
  });
}

export function parseWriterOutput(text: string): Result<WriterOutput> {
  const { blocks: found, after } = blocks(text);
  for (const name of ['submission', 'delta', 'interface']) {
    if (!found.has(name)) return err(`missing \`\`\`${name} block`);
  }
  const submission = found.get('submission') ?? '';
  if (submission === '') return err('submission block is empty');

  const deltaObj = extractJsonObject(found.get('delta') ?? '');
  if (deltaObj === null) return err('delta block is not a JSON object');
  const nouns = stringArray(deltaObj['new_proper_nouns']);
  const claimList = readArray(deltaObj, 'claims');
  if (nouns === null || claimList === null) return err('delta needs new_proper_nouns[] and claims[]');
  const claims: Claim[] = [];
  for (const [i, c] of claimList.entries()) {
    const parsed = parseClaim(c, i);
    if (!parsed.ok) return parsed;
    claims.push(parsed.value);
  }

  const ifaceObj = extractJsonObject(found.get('interface') ?? '');
  if (ifaceObj === null) return err('interface block is not a JSON object');
  const shots = (readArray(ifaceObj, 'shots') ?? []).filter(isRecord);
  const object = isRecord(ifaceObj['object']) ? ifaceObj['object'] : null;
  const hook = isRecord(ifaceObj['hook']) ? ifaceObj['hook'] : null;

  const seeds = after
    .split('\n')
    .map((l) => /^\s*[-*・]\s+(.+)$/u.exec(l)?.[1]?.trim() ?? '')
    .filter((s) => s !== '');

  return ok({ submission, delta: { newProperNouns: nouns, claims }, iface: { shots, object, hook, raw: ifaceObj }, seeds });
}
