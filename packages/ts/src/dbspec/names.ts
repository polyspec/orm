// Names that the renderer writes (docs/dbspec.md "Names"): the plain form
// <table>$<suffix> when it has at most 63 bytes, otherwise its first 54 bytes,
// a $ and the first 8 lowercase hexadecimal digits of its SHA-256. The module is
// reached from the browser-safe entry (docs/editor.md "Layers"), so it reads no
// Node module or global: SHA-256 comes from @noble/hashes and the byte length
// from TextEncoder.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const UTF8 = new TextEncoder();
const MAX_NAME_BYTES = 63;
const HASH_DIGITS = 8;
const PREFIX_BYTES = MAX_NAME_BYTES - 1 - HASH_DIGITS;

/** The name that the renderer writes for the suffix (a column or an event) of table. */
export function rendererName(table: string, suffix: string): string {
  const plain = `${table}$${suffix}`;
  const bytes = UTF8.encode(plain);
  if (bytes.length <= MAX_NAME_BYTES) return plain;
  const digest = bytesToHex(sha256(bytes));
  return `${plain.slice(0, PREFIX_BYTES)}$${digest.slice(0, HASH_DIGITS)}`;
}

/** The column among columns whose renderer name is name, or null. Recomputes each name; never splits on $. */
export function renderedColumn(table: string, name: string, columns: Iterable<string>): string | null {
  for (const column of columns) {
    if (rendererName(table, column) === name) return column;
  }
  return null;
}
