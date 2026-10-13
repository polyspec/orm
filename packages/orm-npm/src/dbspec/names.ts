// Names that the renderer writes (docs/dbspec.md "Names"): the plain form
// <table>$<suffix> when it has at most 63 bytes, otherwise its first 46 bytes,
// a $ and the first 16 lowercase hexadecimal digits of its SHA-256.

import { createHash } from 'node:crypto';

const MAX_NAME_BYTES = 63;
const HASH_DIGITS = 8;
const PREFIX_BYTES = MAX_NAME_BYTES - 1 - HASH_DIGITS;

/** The name that the renderer writes for the suffix (a column or an event) of table. */
export function rendererName(table: string, suffix: string): string {
  const plain = `${table}$${suffix}`;
  if (Buffer.byteLength(plain, 'utf8') <= MAX_NAME_BYTES) return plain;
  const digest = createHash('sha256').update(plain, 'utf8').digest('hex');
  return `${plain.slice(0, PREFIX_BYTES)}$${digest.slice(0, HASH_DIGITS)}`;
}

/** The column among columns whose renderer name is name, or null. Recomputes each name; never splits on $. */
export function renderedColumn(table: string, name: string, columns: Iterable<string>): string | null {
  for (const column of columns) {
    if (rendererName(table, column) === name) return column;
  }
  return null;
}
