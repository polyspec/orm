// A parameter is checked against the logical type of each slot it fills before any statement (docs/spec/protocol.md §5
// "Parameters"): the SQL bind path reads the slot of the plan step, an IR executor the uses of ir.ParamUses.
import { timeValue } from './database.js';
import { normalizeDecimal } from './decimal.js';
import type { ParamUse } from './engine/params.js';
import type { BindSlot } from './ir.js';
import { OrmError } from './runtime_error.js';
import * as codes from './codes.js';

/**
 * The logical type of a slot that a parameter fills: a dbspec type kind with the precision of a decimal, time or
 * datetime, the scale of a decimal and the length of a varchar.
 */
export interface ParamSlot {
  readonly type: string;
  readonly precision: number;
  readonly scale: number;
  readonly length: number;
  /** The assignment of the non-null column `column`. */
  readonly notNull?: boolean;
  readonly column?: string;
}

/** The logical type of a param bind slot of a plan step. */
export function bindSlotType(slot: BindSlot): ParamSlot {
  return { type: slot.col_type, precision: slot.precision ?? 0, scale: slot.scale ?? 0, length: slot.length ?? 0, notNull: slot.not_null === true, column: slot.column };
}

/**
 * The logical type of a parameter use: a use of its column's type takes the column's precision, scale and length; a
 * datetime or time of a function takes six digits.
 */
export function useSlotType(use: ParamUse): ParamSlot {
  const f = use.column;
  if (f !== undefined && f.type === use.type) return { type: use.type, precision: f.precision, scale: f.scale, length: f.length, notNull: use.assign === true && !f.nullable, column: f.name };
  return { type: use.type, precision: use.type === 'datetime' || use.type === 'time' ? 6 : 0, scale: 0, length: 0 };
}

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const integerRanges: Record<string, readonly [bigint, bigint]> = {
  i16: [-32768n, 32767n],
  i32: [-2147483648n, 2147483647n],
  i64: [-9223372036854775808n, 9223372036854775807n],
};

function shown(value: unknown): string {
  return typeof value === 'bigint' ? `${value}` : typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/** Refuses SQL NULL as parameter i when slot assigns a non-null column; it runs for every slot before any statement. */
export function checkAssign(i: number, value: unknown, slot: ParamSlot): void {
  if ((value === null || value === undefined) && slot.notNull === true) {
    throw new OrmError(codes.CODEC_ENCODE, `parameter ${i} assigns NULL to the non-null ${slot.column ?? ''}`);
  }
}

/**
 * Checks the value of parameter i against the logical type of a slot it fills: the host value kind, the range of an
 * integer, a finite f64, the precision and scale of a decimal, a date from 0001-01-01 to 9999-12-31, no non-zero digit
 * of a time or datetime past its precision, at most n characters of a varchar(n), no U+0000 in text and a lower-case
 * canonical uuid. A value outside it is CODEC_ENCODE; SQL NULL is accepted.
 */
export function checkParam(i: number, value: unknown, slot: ParamSlot, zone: string): void {
  if (value === null || value === undefined) return;
  const kind = (): OrmError => new OrmError(codes.CODEC_ENCODE, `parameter ${i} (${typeof value}) is not a ${slot.type} value`);
  switch (slot.type) {
    case 'i16': case 'i32': case 'i64': {
      if (!(typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value)))) throw kind();
      const n = BigInt(value);
      const [low, high] = integerRanges[slot.type] ?? [0n, 0n];
      if (n < low || n > high) throw new OrmError(codes.CODEC_ENCODE, `parameter ${i} (${shown(value)}) is outside ${slot.type}`);
      return;
    }
    case 'f64':
      if (typeof value === 'bigint') return;
      if (typeof value !== 'number') throw kind();
      if (!Number.isFinite(value)) throw new OrmError(codes.CODEC_ENCODE, `parameter ${i} (${value}) is not a finite f64`);
      return;
    case 'bool':
      if (typeof value !== 'boolean') throw kind();
      return;
    case 'decimal':
      if (typeof value !== 'string') throw kind();
      try {
        normalizeDecimal(value, slot.precision, slot.scale);
      } catch (error) {
        throw new OrmError(codes.CODEC_ENCODE, `parameter ${i}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    case 'varchar': case 'text': case 'uuid': {
      if (typeof value !== 'string') throw kind();
      if (value.includes('\u0000')) throw new OrmError(codes.CODEC_ENCODE, `parameter ${i} holds U+0000, which no ${slot.type} value holds`);
      // The length of a varchar is in characters, the code points of the text.
      const n = Array.from(value).length;
      if (slot.type === 'varchar' && slot.length > 0 && n > slot.length) throw new OrmError(codes.CODEC_ENCODE, `parameter ${i} has ${n} characters, more than varchar(${slot.length})`);
      if (slot.type === 'uuid' && !canonicalUuid.test(value)) throw new OrmError(codes.CODEC_ENCODE, `parameter ${i} (${shown(value)}) is not a lower-case canonical uuid`);
      return;
    }
    case 'bytes':
      if (!(value instanceof Uint8Array || typeof value === 'string')) throw kind();
      return;
    case 'date': case 'time': case 'datetime': {
      if (typeof value !== 'string') throw kind();
      let text: string;
      try {
        text = timeValue(value, slot.type, zone, slot.precision);
      } catch (error) {
        throw new OrmError(codes.CODEC_ENCODE, `parameter ${i}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (slot.type !== 'time' && (!/^\d{4}-/.test(text) || text.startsWith('0000'))) {
        throw new OrmError(codes.CODEC_ENCODE, `parameter ${i} (${shown(value)}) is outside 0001-01-01 to 9999-12-31`);
      }
      return;
    }
  }
}

/**
 * Applies the value transform kind to a parameter: SQL NULL binds NULL, so `col LIKE NULL` matches no row, and a value
 * other than text is CODEC_ENCODE.
 */
export function transformParam(kind: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new OrmError(codes.CODEC_ENCODE, `${kind} requires a string value`);
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
  if (kind === 'like_contains') return `%${escaped}%`;
  if (kind === 'like_starts') return `${escaped}%`;
  if (kind === 'like_ends') return `%${escaped}`;
  return value;
}
