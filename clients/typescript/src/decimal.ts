import { OrmError } from './runtime_error.js';

/** Validate an exact decimal field value and pad it to its declared scale. */
export function normalizeDecimal(input: string, precision: number, scale: number): string {
  const fail = (reason: string): never => { throw new OrmError('CODEC_ENCODE', `decimal ${JSON.stringify(input)}: ${reason}`); };
  if (!Number.isInteger(precision) || precision < 1 || precision > 18 || !Number.isInteger(scale) || scale < 0 || scale > precision) {
    return fail('invalid precision or scale');
  }
  if (typeof input !== 'string' || !/^[+-]?[0-9]+(?:\.[0-9]+)?$/.test(input)) return fail('invalid text');
  let negative = input.startsWith('-');
  const unsigned = /^[+-]/.test(input) ? input.slice(1) : input;
  const [wholePart, fractionPart = ''] = unsigned.split('.');
  const whole = wholePart.replace(/^0+/, '') || '0';
  if (fractionPart.length > scale) return fail('fraction exceeds scale');
  if ((whole === '0' ? 0 : whole.length) + scale > precision) return fail('value exceeds precision');
  const fraction = fractionPart.padEnd(scale, '0');
  if (whole === '0' && /^0*$/.test(fraction)) negative = false;
  return `${negative ? '-' : ''}${whole}${scale === 0 ? '' : `.${fraction}`}`;
}

/** SQLite stores a declared decimal as an exact scaled signed integer. */
export function decimalScaled(input: string, precision: number, scale: number): bigint {
  return BigInt(normalizeDecimal(input, precision, scale).replace('.', ''));
}

export function decimalFromScaled(raw: unknown, precision: number, scale: number): string {
  if (typeof raw !== 'bigint') throw new OrmError('CODEC_DECODE', `decimal scaled cell has type ${typeof raw}`);
  const negative = raw < 0n;
  let digits = (negative ? -raw : raw).toString().padStart(scale + 1, '0');
  if (scale > 0) digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  try { return normalizeDecimal(`${negative ? '-' : ''}${digits}`, precision, scale); }
  catch (cause) { throw new OrmError('CODEC_DECODE', `invalid scaled decimal cell: ${String(cause)}`); }
}
