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
    return { kind: 'value', value: jsonOutputValue(this.payload(), '') };
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

/** The forms that the JSON output writes a node of a styled value in. */
interface JsonOutputWriter<R> {
  /** An ordered-json value, which is written as its stored text (COD-16). */
  json(value: OrderedJsonValue): R;
  scalar(value: null | boolean | string | number | bigint): R;
  list(items: R[]): R;
  map(members: Array<[string, R]>): R;
}

/**
 * Writes the value of a styled value for JSON output (COD-16, COD-26), refusing as CODEC_ENCODE, with the place of the
 * output before the text, what JSON.stringify would write as another value, leave out or fail on: payload() returns the
 * stored value unchecked (COD-73), so the output refuses by its own rule a number that is not finite, which
 * JSON.stringify writes as null, and undefined, a function, a symbol, a missing array index, a member that is not an
 * enumerable string-keyed property, an object without a JSON form and a cycle. An object of a class is written as the
 * value that its toJSON returns, read once as JSON.stringify reads it, so a form that is again an object of a class, the
 * object itself included, has no JSON form. A bigint is an exact integer, and an ordered-json value at any depth is its
 * stored text.
 */
function writeJsonOutput<R>(value: unknown, place: string, writer: JsonOutputWriter<R>): R {
  const refused = (what: string): OrmError => new OrmError(codes.CODEC_ENCODE, `${place}JSON output cannot write ${what}`);
  const plain = (node: object): boolean => {
    const prototype: unknown = Object.getPrototypeOf(node);
    return Array.isArray(node) || prototype === Object.prototype || prototype === null;
  };
  const visit = (node: unknown, ancestors: Set<object>): R => {
    if (node === null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'bigint') return writer.scalar(node);
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) throw refused('a number that is not finite');
      return writer.scalar(node);
    }
    if (typeof node !== 'object' || ancestors.has(node)) throw refused('a value that JSON has no form for');
    if (node instanceof OrderedJsonValue) return writer.json(node);
    let form: object = node;
    if (!plain(node)) {
      const toJSON: unknown = Reflect.get(node, 'toJSON');
      if (typeof toJSON !== 'function') throw refused('a value that JSON has no form for');
      const written: unknown = Reflect.apply(toJSON, node, []);
      if (written === null || typeof written !== 'object' || written instanceof OrderedJsonValue) return visit(written, ancestors);
      if (!plain(written)) throw refused('a value that JSON has no form for');
      form = written;
    }
    if (ancestors.has(form)) throw refused('a value that JSON has no form for');
    ancestors.add(node).add(form);
    let result: R;
    if (Array.isArray(form)) {
      for (const key of Reflect.ownKeys(form)) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || !Object.getOwnPropertyDescriptor(form, key)?.enumerable) {
          throw refused('a value that JSON has no form for');
        }
      }
      const items: R[] = [];
      for (let index = 0; index < form.length; index++) {
        if (!Object.hasOwn(form, index)) throw refused('a value that JSON has no form for');
        items.push(visit(form[index], ancestors));
      }
      result = writer.list(items);
    } else {
      const members: Array<[string, R]> = [];
      for (const name of Reflect.ownKeys(form)) {
        if (typeof name !== 'string' || !Object.getOwnPropertyDescriptor(form, name)?.enumerable) throw refused('a value that JSON has no form for');
        members.push([name, visit(Reflect.get(form, name), ancestors)]);
      }
      result = writer.map(members);
    }
    ancestors.delete(node);
    ancestors.delete(form);
    return result;
  };
  return visit(value, new Set());
}

/** A raw JSON number of the exact digits of a bigint, which JSON.stringify writes unchanged. */
function rawInteger(value: bigint): unknown {
  const rawJSON: unknown = Reflect.get(JSON, 'rawJSON');
  if (typeof rawJSON !== 'function') throw new OrmError(codes.CODEC_ENCODE, 'JSON.rawJSON is required to write an exact integer');
  return Reflect.apply(rawJSON, JSON, [String(value)]);
}

/**
 * The value of a styled value for JSON.stringify: an ordered-json value at any depth as orderedJsonOutput writes it, a
 * bigint as a raw JSON number, each other node as JSON writes it (writeJsonOutput).
 *
 * @internal
 */
export function jsonOutputValue(value: unknown, place: string): unknown {
  return writeJsonOutput<unknown>(value, place, {
    json: orderedJsonOutput,
    scalar: node => (typeof node === 'bigint' ? rawInteger(node) : node),
    list: items => items,
    map: members => Object.fromEntries(members),
  });
}

/**
 * The JSON text of a styled value: an ordered-json value at any depth as its stored text, which keeps every member order
 * and number text, and each other node as JSON writes it (writeJsonOutput).
 *
 * @internal
 */
export function jsonOutputText(value: unknown, place: string): string {
  return writeJsonOutput<string>(value, place, {
    json: orderedJsonStringify,
    scalar: node => (typeof node === 'bigint' ? String(node) : JSON.stringify(node)),
    list: items => `[${items.join(',')}]`,
    map: members => `{${members.map(([name, item]) => `${JSON.stringify(name)}:${item}`).join(',')}}`,
  });
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
