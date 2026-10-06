import { Value as OrderedJsonValue, stringify as orderedJsonStringify } from '@polyspec/ordered-json';
import { OrmError } from './runtime_error.js';

/** The SQL NULL state or an encoded value of a styled column. */
export class StyledValue<T = unknown> {
  private constructor(public readonly kind: 'sql-null' | 'value', private readonly stored?: T) {}

  public static sqlNull<T>(): StyledValue<T> { return new StyledValue<T>('sql-null'); }
  public static value<T>(value: T): StyledValue<T> { return new StyledValue<T>('value', value); }

  public payload(): T {
    if (this.kind === 'sql-null') throw new OrmError('CODEC_DECODE', 'SQL NULL has no styled value');
    assertNoOmittedValue(this.stored, new Set(), 0);
    return this.stored as T;
  }

  public toJSON(): { kind: 'sql-null' } | { kind: 'value'; value: unknown } {
    if (this.kind === 'sql-null') return { kind: 'sql-null' };
    const value = this.payload();
    if (!(value instanceof OrderedJsonValue)) return { kind: 'value', value };
    return { kind: 'value', value: orderedJsonOutput(value) };
  }
}

function assertNoOmittedValue(value: unknown, ancestors: Set<object>, depth: number): void {
  if (depth > 256) throw new OrmError('CODEC_ENCODE', 'styled value nesting exceeds 256 levels');
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    throw new OrmError('CODEC_ENCODE', `styled value contains ${typeof value}`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new OrmError('CODEC_ENCODE', 'styled value contains a non-finite number');
  if (value === null || typeof value !== 'object' || value instanceof OrderedJsonValue) return;
  if (ancestors.has(value)) throw new OrmError('CODEC_ENCODE', 'styled value contains a cycle');
  ancestors.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    const writer = (value as { toJSON?: unknown }).toJSON;
    if (typeof writer !== 'function') throw new OrmError('CODEC_ENCODE', 'styled value object has no JSON representation');
    assertNoOmittedValue(writer.call(value), ancestors, depth + 1);
    ancestors.delete(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length
        || !Object.getOwnPropertyDescriptor(value, key)?.enumerable) {
        throw new OrmError('CODEC_ENCODE', `styled value array member ${String(key)} would be omitted`);
      }
    }
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) throw new OrmError('CODEC_ENCODE', `styled value array index ${index} is missing`);
      assertNoOmittedValue(value[index], ancestors, depth + 1);
    }
  } else {
    for (const name of Reflect.ownKeys(value)) {
      if (typeof name !== 'string' || !Object.getOwnPropertyDescriptor(value, name)?.enumerable) {
        throw new OrmError('CODEC_ENCODE', `styled value member ${String(name)} would be omitted`);
      }
      try { assertNoOmittedValue((value as Record<string, unknown>)[name], ancestors, depth + 1); }
      catch (error) {
        if (error instanceof OrmError && error.code === 'CODEC_ENCODE') throw new OrmError('CODEC_ENCODE', `styled value member ${JSON.stringify(name)}: ${error.message}`);
        throw error;
      }
    }
  }
  ancestors.delete(value);
}

/** The exact JSON.stringify representation of an ordered-json value. */
export function orderedJsonOutput(value: OrderedJsonValue): unknown {
  if (value.kind === 'array') return value.items.map(orderedJsonOutput);
  if (value.kind === 'object') return Object.fromEntries(value.keys.map(key => {
    const name = key.stringValue();
    if (/^(0|[1-9][0-9]*)$/.test(name) && Number(name) < 4294967295 || JSON.stringify(name) !== key.raw) {
      throw new OrmError('CODEC_ENCODE', `JSON.stringify cannot preserve the object key ${key.raw}; use toJSONText`);
    }
    return [name, orderedJsonOutput(value.members.get(name)!)];
  }));
  const rawJSON = (JSON as { rawJSON?: (text: string) => unknown }).rawJSON;
  if (rawJSON === undefined) throw new OrmError('CODEC_ENCODE', 'JSON.rawJSON is required to write an ordered-json value');
  return rawJSON(orderedJsonStringify(value));
}
