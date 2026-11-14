// A parameter is checked against the logical type of each slot it fills before any statement (docs/spec/protocol.md §5
// "Parameters"): the SQL bind path reads the slot of the plan step, an IR executor the uses of ir.ParamUses.
import { timeValue } from './database.js';
import { normalizeDecimal } from './decimal.js';
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

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const integerRanges: Record<string, readonly [bigint, bigint]> = {
  i16: [-32768n, 32767n],
  i32: [-2147483648n, 2147483647n],
  i64: [-9223372036854775808n, 9223372036854775807n],
};

/**
 * The value v of a slot of type colType as it is bound: a uuid text is its 16 bytes on MySQL, MariaDB, SQLite and flowmark, the 32
 * digits of the canonical text two to a byte in their order, and the text itself on PostgreSQL, which casts it (DIA-27, PRT-67).
 * Another value is v.
 */
export function uuidBind(v: unknown, colType: string, postgres: boolean): unknown {
  if (colType !== 'uuid' || typeof v !== 'string' || postgres) return v;
  if (!canonicalUuid.test(v)) throw new OrmError(codes.CODEC_ENCODE, 'uuid value is not a lower-case canonical uuid');
  return Buffer.from(v.replaceAll('-', ''), 'hex');
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
 * canonical uuid. A value outside it is CODEC_ENCODE with the text of PRT-32a, which names no value; SQL NULL is accepted.
 */
export function checkParam(i: number, value: unknown, slot: ParamSlot, zone: string): void {
  if (value === null || value === undefined) return;
  const kind = (): OrmError => new OrmError(codes.CODEC_ENCODE, `parameter ${i} is not a ${slot.type} value`);
  switch (slot.type) {
    case 'i16': case 'i32': case 'i64': {
      if (!(typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value)))) throw kind();
      const n = BigInt(value);
      const [low, high] = integerRanges[slot.type] ?? [0n, 0n];
      if (n < low || n > high) throw new OrmError(codes.CODEC_ENCODE, `parameter ${i} is outside ${slot.type}`);
      return;
    }
    case 'f64':
      if (typeof value === 'bigint') return;
      if (typeof value !== 'number') throw kind();
      if (!Number.isFinite(value)) throw new OrmError(codes.CODEC_ENCODE, `parameter ${i} is not a finite f64`);
      return;
    case 'bool':
      if (typeof value !== 'boolean') throw kind();
      return;
    case 'decimal':
      if (typeof value !== 'string') throw kind();
      try {
        normalizeDecimal(value, slot.precision, slot.scale);
      } catch (error) {
        throw refused(error, `parameter ${i} is not a decimal of its precision and scale`);
      }
      return;
    case 'varchar': case 'text': case 'uuid': {
      // A text with a lone surrogate is no sequence of Unicode scalar values, so it is not valid UTF-8 (PRT-32a, COD-64).
      if (typeof value !== 'string' || !value.isWellFormed()) throw kind();
      if (value.includes('\u0000')) throw new OrmError(codes.CODEC_ENCODE, `parameter ${i} holds U+0000, which no ${slot.type} value holds`);
      // The length of a varchar is in characters, the code points of the text.
      const n = Array.from(value).length;
      if (slot.type === 'varchar' && slot.length > 0 && n > slot.length) throw new OrmError(codes.CODEC_ENCODE, `parameter ${i} is longer than varchar(${slot.length})`);
      if (slot.type === 'uuid' && !canonicalUuid.test(value)) throw new OrmError(codes.CODEC_ENCODE, `parameter ${i} is not a lower-case canonical uuid`);
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
        throw refused(error, `parameter ${i} is not a ${slot.type} value`);
      }
      if (slot.type !== 'time' && (!/^\d{4}-/.test(text) || text.startsWith('0000'))) {
        throw new OrmError(codes.CODEC_ENCODE, `parameter ${i} is outside 0001-01-01 to 9999-12-31`);
      }
      return;
    }
  }
}

/**
 * The PRT-32a refusal text of a parameter in place of the CODEC_ENCODE that refused its value; any other failure is
 * returned as it is, so it stays its own error.
 */
function refused(error: unknown, text: string): unknown {
  return error instanceof OrmError && error.code === codes.CODEC_ENCODE ? new OrmError(codes.CODEC_ENCODE, text, error) : error;
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
  if (kind === 'fulltext_boolean' || kind === 'fulltext_text') {
    const out = fulltextBoolean(value);
    if (out === '') throw new OrmError(codes.IR_INVALID, 'fulltext search text has no term');
    return kind === 'fulltext_text' ? value : out;
  }
  return value;
}

/**
 * The transform fulltext_boolean (DIA-6): the search text of a MySQL boolean-mode match. It splits the value on whitespace,
 * removes the boolean operator characters from each term, drops the terms that are empty, prefixes every term with +,
 * suffixes the last term with *, and joins the terms with single spaces. A value with no term is ''.
 */
export function fulltextBoolean(value: string): string {
  const terms = value.split(/\s+/).map(t => t.replace(/[+\-<>()~*"@]/g, '')).filter(t => t !== '').map(t => `+${t}`);
  if (terms.length === 0) return '';
  terms[terms.length - 1] += '*';
  return terms.join(' ');
}
