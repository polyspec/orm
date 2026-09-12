import type { Order, Param } from './index.js';
import { OrmError } from './runtime_error.js';

type EncodedValue = { type: 'bool'|'i64'|'f64'|'string'|'datetime'; value: boolean|string|number };
export interface KeysetCursor { version: 1; order: Order[]; values: EncodedValue[]; }

export function encodeKeysetCursor(order: readonly Order[], values: readonly unknown[]): string {
  if (order.length === 0 || order.length !== values.length) throw new OrmError('CURSOR_INVALID', `cursor has ${values.length} values for ${order.length} order columns`);
  const encoded: EncodedValue[] = values.map((value, index) => {
    if (typeof value === 'boolean') return { type: 'bool', value };
    if (typeof value === 'bigint') return { type: 'i64', value: value.toString() };
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new OrmError('CURSOR_INVALID', `cursor value ${index} is not finite`);
      if (Number.isSafeInteger(value)) return { type: 'i64', value: String(value) };
      return { type: 'f64', value };
    }
    if (typeof value === 'string') return { type: 'string', value };
    if (value instanceof Date) {
      const iso = value.toISOString();
      return { type: 'datetime', value: `${iso.slice(0, 19).replace('T', ' ')}.${iso.slice(20, 23)}000` };
    }
    throw new OrmError('CURSOR_INVALID', `cursor value ${index} has an unsupported type`);
  });
  return Buffer.from(JSON.stringify({ version: 1, order, values: encoded }), 'utf8').toString('base64url');
}

export function decodeKeysetCursor(input: string): KeysetCursor {
  if (input === '') throw new OrmError('CURSOR_INVALID', 'cursor is empty');
  let value: unknown;
  try { value = JSON.parse(Buffer.from(input, 'base64url').toString('utf8')); } catch (error) { throw new OrmError('CURSOR_INVALID', `cursor is invalid: ${String(error)}`); }
  const cursor = value as Partial<KeysetCursor>;
  if (cursor.version !== 1 || !Array.isArray(cursor.order) || !Array.isArray(cursor.values) || cursor.order.length === 0 || cursor.order.length !== cursor.values.length) throw new OrmError('CURSOR_INVALID', 'cursor version, order, or values are invalid');
  return cursor as KeysetCursor;
}

export function cursorParams(cursor: KeysetCursor): Param[] {
  return cursor.values.map((value, index) => {
    switch (value.type) {
      case 'bool': if (typeof value.value !== 'boolean') break; return value.value;
      case 'i64': if (typeof value.value === 'string' && /^-?[0-9]+$/.test(value.value)) { const n = BigInt(value.value); return n <= BigInt(Number.MAX_SAFE_INTEGER) && n >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(n) : n; } break;
      case 'f64': if (typeof value.value === 'number' && Number.isFinite(value.value)) return value.value;
      case 'string': case 'datetime': if (typeof value.value === 'string') return value.value;
    }
    throw new OrmError('CURSOR_INVALID', `cursor value ${index} has an invalid ${value.type} representation`);
  });
}

export function sameOrder(a: readonly Order[], b: readonly Order[]): boolean {
  return a.length === b.length && a.every((item, index) => item.column === b[index]?.column && item.expr === b[index]?.expr && Boolean(item.desc) === Boolean(b[index]?.desc));
}
