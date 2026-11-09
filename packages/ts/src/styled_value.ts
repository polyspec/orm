import { Value as OrderedJsonValue, stringify as orderedJsonStringify } from '@polyspec/ordered-json';
import { present } from './present.js';
import { OrmError } from './runtime_error.js';
import * as codes from './codes.js';

let readStored: (value: StyledValue) => unknown;

/** The SQL NULL state or an encoded value of a styled column. */
export class StyledValue<T = unknown> {
  static {
    readStored = value => value.stored?.value;
  }

  /** stored holds the value of the value variant, and SQL NULL has none. */
  private constructor(public readonly kind: 'sql-null' | 'value', private readonly stored?: { readonly value: T }) {}

  public static sqlNull<T>(): StyledValue<T> { return new StyledValue<T>('sql-null'); }
  public static value<T>(value: T): StyledValue<T> { return new StyledValue<T>('value', { value }); }

  /**
   * The value of the value variant, returned unchecked: every encode of it checks it, and the JSON output refuses what
   * JSON cannot write; SQL NULL is the one refusal (COD-73).
   */
  public payload(): T {
    if (this.stored === undefined) throw new OrmError(codes.CODEC_DECODE, 'SQL NULL has no styled value');
    return this.stored.value;
  }

  public toJSON(): { kind: 'sql-null' } | { kind: 'value'; value: unknown } {
    if (this.kind === 'sql-null') return { kind: 'sql-null' };
    const value = this.payload();
    checkJsonOutput(value, '');
    if (!(value instanceof OrderedJsonValue)) return { kind: 'value', value };
    return { kind: 'value', value: orderedJsonOutput(value) };
  }
}

/**
 * The value that a styled value holds, as it was given, undefined for SQL NULL: the codec stages refuse a value by their
 * own rules of COD-70.
 *
 * @internal
 */
export function storedValue(value: StyledValue): unknown {
  return readStored(value);
}

/**
 * Refuses a value that JSON.stringify would write as another value or leave out, as CODEC_ENCODE with the place of the
 * output before the text (COD-16, COD-26): payload() returns the stored value unchecked (COD-73), so the JSON output
 * refuses by its own rule a number that is not finite, which JSON.stringify writes as null, and undefined, a function, a
 * symbol, a missing array index, a member that is not an enumerable string-keyed property, an object without a JSON
 * form and a cycle, which it leaves out, writes as null or as another object, or cannot write. A bigint is an exact
 * integer of the output, and an ordered-json value is written as its stored text.
 *
 * @internal
 */
export function checkJsonOutput(value: unknown, place: string): void {
  const refused = (what: string): OrmError => new OrmError(codes.CODEC_ENCODE, `${place}JSON output cannot write ${what}`);
  const visit = (node: unknown, ancestors: Set<object>): void => {
    if (node === null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'bigint') return;
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) throw refused('a number that is not finite');
      return;
    }
    if (typeof node !== 'object' || ancestors.has(node)) throw refused('a value that JSON has no form for');
    if (node instanceof OrderedJsonValue) return;
    ancestors.add(node);
    const prototype: unknown = Object.getPrototypeOf(node);
    if (Array.isArray(node)) {
      for (const key of Reflect.ownKeys(node)) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || !Object.getOwnPropertyDescriptor(node, key)?.enumerable) {
          throw refused('a value that JSON has no form for');
        }
      }
      for (let index = 0; index < node.length; index++) {
        if (!Object.hasOwn(node, index)) throw refused('a value that JSON has no form for');
        visit(node[index], ancestors);
      }
    } else if (prototype === Object.prototype || prototype === null) {
      for (const name of Reflect.ownKeys(node)) {
        if (typeof name !== 'string' || !Object.getOwnPropertyDescriptor(node, name)?.enumerable) throw refused('a value that JSON has no form for');
        visit(Reflect.get(node, name), ancestors);
      }
    } else {
      // An object of a class is written as the value that its toJSON returns.
      const writer: unknown = Reflect.get(node, 'toJSON');
      if (typeof writer !== 'function') throw refused('a value that JSON has no form for');
      visit(Reflect.apply(writer, node, []), ancestors);
    }
    ancestors.delete(node);
  };
  visit(value, new Set());
}

/** The exact JSON.stringify representation of an ordered-json value. */
export function orderedJsonOutput(value: OrderedJsonValue): unknown {
  if (value.kind === 'array') return value.items.map(orderedJsonOutput);
  if (value.kind === 'object') return Object.fromEntries(value.keys.map(key => {
    const name = key.stringValue();
    if (/^(0|[1-9][0-9]*)$/.test(name) && Number(name) < 4294967295 || JSON.stringify(name) !== key.raw) {
      throw new OrmError(codes.CODEC_ENCODE, `JSON.stringify cannot preserve the object key ${key.raw}; use toJSONText`);
    }
    return [name, orderedJsonOutput(present(value.members.get(name), `the member ${key.raw} of an ordered-json object`))];
  }));
  const rawJSON: unknown = Reflect.get(JSON, 'rawJSON');
  if (typeof rawJSON !== 'function') throw new OrmError(codes.CODEC_ENCODE, 'JSON.rawJSON is required to write an ordered-json value');
  return Reflect.apply(rawJSON, JSON, [orderedJsonStringify(value)]);
}
