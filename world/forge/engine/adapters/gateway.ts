import { readFileSync } from 'node:fs';
import type { Family, LocalConfig, WriterSlot } from '../config.ts';
import { readArray, readNumber, readRecord, readString } from '../json.ts';
import { failure, type Backend, type CallOptions, type CallResult } from './types.ts';
import type { ParsedOutput } from './judges.ts';

/** Reads one variable from a dotenv-style file. The value is returned to the caller and never logged. */
export function readEnvValue(path: string, key: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u.exec(line);
    if (m === null || m[1] !== key) continue;
    const raw = (m[2] ?? '').trim();
    const quoted = /^(['"])(.*)\1$/u.exec(raw);
    return quoted === null ? raw : (quoted[2] ?? '');
  }
  return null;
}

export function parseChatCompletion(body: unknown): ParsedOutput {
  const apiError = readRecord(body, 'error');
  if (apiError !== null) {
    return { text: '', servedModel: null, tokensIn: null, tokensOut: null, costUsd: null, error: `gateway error: ${readString(apiError, 'message') ?? JSON.stringify(apiError)}` };
  }
  const choice = readArray(body, 'choices')?.[0];
  const message = readRecord(choice, 'message');
  const text = readString(message, 'content') ?? '';
  const usage = readRecord(body, 'usage');
  const finish = readString(choice, 'finish_reason') ?? 'unknown';
  return {
    text,
    servedModel: readString(body, 'model'),
    tokensIn: readNumber(usage, 'prompt_tokens'),
    tokensOut: readNumber(usage, 'completion_tokens'),
    costUsd: null,
    error: text.trim() === '' ? `empty content (finish_reason ${finish})` : null,
  };
}

async function callGateway(local: LocalConfig, slot: WriterSlot, prompt: string, opts: CallOptions): Promise<CallResult> {
  const started = Date.now();
  const key = readEnvValue(local.gatewayEnvFile, local.gatewayKeyVar);
  if (key === null) return failure(`could not read ${local.gatewayKeyVar} from the gateway env file (check local.json gateway.env_file)`, 0, '', null);
  let status = 0;
  let bodyText = '';
  try {
    const res = await fetch(`${local.gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: slot.model,
        messages: [
          { role: 'system', content: opts.role },
          { role: 'user', content: prompt },
        ],
        max_tokens: slot.maxTokens,
        temperature: slot.temperature,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    status = res.status;
    bodyText = await res.text();
  } catch (e) {
    return failure(`gateway request failed: ${e instanceof Error ? e.message : String(e)}`, Date.now() - started, '', null);
  }
  const ms = Date.now() - started;
  let body: unknown = null;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return failure(`gateway HTTP ${status}: non-JSON body`, ms, bodyText.slice(0, 2_000), null);
  }
  const parsed = parseChatCompletion(body);
  const raw = JSON.stringify(body, null, 1);
  if (status !== 200 || parsed.error !== null) return failure(parsed.error ?? `gateway HTTP ${status}`, ms, raw, null);
  return { ok: true, text: parsed.text, servedModel: parsed.servedModel, version: null, ms, tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut, costUsd: null, error: null, raw };
}

export function gatewayBackend(slot: WriterSlot, family: Family, local: LocalConfig): Backend {
  return { id: slot.id, family, model: slot.model, call: (prompt, opts) => callGateway(local, slot, prompt, opts) };
}

