import { StyledValue } from '../../packages/orm-npm/dist/index.js';
import { Value as JsonValue, parse } from '@polyspec/ordered-json';

export function derivedInteger(value) {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && Number.isInteger(value) && value >= -(2 ** 63) && value < 2 ** 63) return value;
  } else if (typeof value === 'bigint' || (typeof value === 'string' && /^-?(?:0|[1-9][0-9]*)$/.test(value))) {
    const integer = BigInt(value);
    if (integer >= -(1n << 63n) && integer < 1n << 63n) {
      const number = Number(integer);
      if (BigInt(number) === integer) return number;
    }
  }
  throw new Error('invalid derived integer');
}

/** Keep an unexpected vector failure visible to the caller. */
export async function executeVector(name, fn, transaction = null) {
  try {
    return await (transaction === null ? fn() : transaction(fn));
  } catch (error) {
    throw new Error(`conformance vector ${name} failed`, { cause: error });
  }
}

/** Preserves exact ordered-json numbers when writing a conformance result. */
export function resultValue(value) {
  if (value === undefined) throw new Error('undefined conformance result');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite conformance result');
  if (typeof value === 'bigint') return resultValue(parse(value.toString()));
  if (typeof value === 'function' || typeof value === 'symbol') throw new Error('non-JSON conformance result');
  if (value instanceof StyledValue) {
    if (value.kind === 'value') resultValue(value.payload());
    return value.toJSON();
  }
  if (value instanceof JsonValue) return StyledValue.value(value).toJSON().value;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error('sparse conformance result');
    return value.map(resultValue);
  }
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error('symbol-keyed conformance result');
    if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length) throw new Error('non-enumerable conformance result');
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resultValue(item)]));
  }
  if (value !== null && typeof value === 'object') throw new Error(`unsupported conformance result object ${Object.getPrototypeOf(value)?.constructor?.name}`);
  return value;
}
