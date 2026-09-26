import { Value as OrderedJsonValue, stringify as orderedJsonStringify } from 'ordered-json';
import { OrmError } from './runtime_error.js';

/** The SQL NULL state or an encoded value of a styled column. */
export class StyledValue<T = unknown> {
  private constructor(public readonly kind: 'sql-null' | 'value', private readonly stored?: T) {}

  public static sqlNull<T>(): StyledValue<T> { return new StyledValue<T>('sql-null'); }
  public static value<T>(value: T): StyledValue<T> { return new StyledValue<T>('value', value); }

  public payload(): T {
    if (this.kind === 'sql-null') throw new OrmError('CODEC_DECODE', 'SQL NULL has no styled value');
    return this.stored as T;
  }

  public toJSON(): { kind: 'sql-null' } | { kind: 'value'; value: unknown } {
    if (this.kind === 'sql-null') return { kind: 'sql-null' };
    const value = this.payload();
    if (!(value instanceof OrderedJsonValue)) return { kind: 'value', value };
    return { kind: 'value', value: orderedJsonOutput(value) };
  }
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
