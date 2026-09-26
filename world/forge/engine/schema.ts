import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from './json.ts';
import { err, ok, type Result } from './result.ts';

/**
 * Absolute path of `schema/<file>` under the forge root: the nearest ancestor of `from` (default: this module's
 * directory) that holds it. Works from engine/ and from the UI's Vite bundle (ui/dist/server/chunks) alike, so no
 * module resolves schemas with a path relative to its own bundled location.
 */
export function schemaFile(file: string, from: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  for (;;) {
    const candidate = join(dir, 'schema', file);
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) throw new Error(`schema/${file} not found above ${from}`);
    dir = up;
  }
}

/** The JSON Schema subset the forge uses; loadSchema rejects any other keyword so schemas never silently under-validate. */
export type SchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
export type Primitive = string | number | boolean | null;

export interface Schema {
  $schema?: string;
  $id?: string;
  title?: string;
  description?: string;
  type?: SchemaType | SchemaType[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  enum?: Primitive[];
  const?: Primitive;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

const TYPES: readonly SchemaType[] = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const NUMERIC_KEYS = ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems'];
const TEXT_KEYS = ['$schema', '$id', 'title', 'description', 'pattern'];

function isSchemaType(v: unknown): v is SchemaType {
  return typeof v === 'string' && TYPES.some((t) => t === v);
}

function isPrimitive(v: unknown): v is Primitive {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

export function loadSchema(value: unknown, path = '$'): Result<Schema> {
  if (!isRecord(value)) return err(`${path}: schema must be an object`);
  const out: Schema = {};
  for (const [key, v] of Object.entries(value)) {
    if (TEXT_KEYS.includes(key)) {
      if (typeof v !== 'string') return err(`${path}.${key}: must be a string`);
      if (key === '$schema') out.$schema = v;
      else if (key === '$id') out.$id = v;
      else if (key === 'title') out.title = v;
      else if (key === 'description') out.description = v;
      else out.pattern = v;
    } else if (NUMERIC_KEYS.includes(key)) {
      if (typeof v !== 'number') return err(`${path}.${key}: must be a number`);
      if (key === 'minLength') out.minLength = v;
      else if (key === 'maxLength') out.maxLength = v;
      else if (key === 'minimum') out.minimum = v;
      else if (key === 'maximum') out.maximum = v;
      else if (key === 'minItems') out.minItems = v;
      else out.maxItems = v;
    } else if (key === 'type') {
      if (isSchemaType(v)) out.type = v;
      else if (Array.isArray(v) && v.every(isSchemaType)) out.type = v.filter(isSchemaType);
      else return err(`${path}.type: unknown type`);
    } else if (key === 'properties') {
      if (!isRecord(v)) return err(`${path}.properties: must be an object`);
      const props: Record<string, Schema> = {};
      for (const [name, sub] of Object.entries(v)) {
        const parsed = loadSchema(sub, `${path}.properties.${name}`);
        if (!parsed.ok) return parsed;
        props[name] = parsed.value;
      }
      out.properties = props;
    } else if (key === 'required') {
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return err(`${path}.required: must be a string array`);
      out.required = v.filter((x): x is string => typeof x === 'string');
    } else if (key === 'additionalProperties') {
      if (typeof v !== 'boolean') return err(`${path}.additionalProperties: only booleans are supported`);
      out.additionalProperties = v;
    } else if (key === 'items') {
      const parsed = loadSchema(v, `${path}.items`);
      if (!parsed.ok) return parsed;
      out.items = parsed.value;
    } else if (key === 'enum') {
      if (!Array.isArray(v) || !v.every(isPrimitive)) return err(`${path}.enum: must be an array of primitives`);
      out.enum = v.filter(isPrimitive);
    } else if (key === 'const') {
      if (!isPrimitive(v)) return err(`${path}.const: must be a primitive`);
      out.const = v;
    } else {
      return err(`${path}: unsupported keyword ${key}`);
    }
  }
  return ok(out);
}

function typeOf(v: unknown): SchemaType {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'boolean';
  return 'object';
}

function typeMatches(expected: SchemaType, v: unknown): boolean {
  const actual = typeOf(v);
  return expected === actual || (expected === 'number' && actual === 'integer');
}

export function validate(schema: Schema, value: unknown, path = '$'): string[] {
  const errors: string[] = [];
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, value))) return [`${path}: expected ${types.join(' or ')}`];
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: must equal ${String(schema.const)}`);
  if (schema.enum !== undefined && !schema.enum.some((e) => e === value)) errors.push(`${path}: not one of ${schema.enum.map(String).join(', ')}`);
  if (typeof value === 'string') {
    const len = [...value].length;
    if (schema.minLength !== undefined && len < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && len > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    const items = schema.items;
    if (items !== undefined) value.forEach((item, i) => errors.push(...validate(items, item, `${path}[${i}]`)));
  }
  if (isRecord(value)) {
    for (const name of schema.required ?? []) if (!(name in value)) errors.push(`${path}: missing ${name}`);
    const props = schema.properties ?? {};
    for (const [name, v] of Object.entries(value)) {
      const sub = props[name];
      if (sub !== undefined) errors.push(...validate(sub, v, `${path}.${name}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property ${name}`);
    }
  }
  return errors;
}
