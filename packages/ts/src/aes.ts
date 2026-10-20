import { OrmError } from './runtime_error.js';
import * as codes from './codes.js';

export interface AesRotationColumn {
  name: string;
  styles: readonly string[];
}

export interface AesRowCodec {
  decode(value: unknown, styles: readonly string[], key: string): unknown;
  encode(value: unknown, styles: readonly string[], key: string): unknown;
}

/**
 * The key version that a stored row holds: a positive 32-bit integer, as a number, a bigint (as SQLite reads it) or its decimal text. Any other value
 * is CODEC_DECODE; it is never coerced.
 */
export function storedVersion(value: unknown): number {
  const version = typeof value === 'number' || typeof value === 'bigint' ? Number(value)
    : typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(version) || version < 1 || version > 2147483647) throw new OrmError(codes.CODEC_DECODE, `aes version ${String(value)} is not a positive 32-bit integer`);
  return version;
}

/** The keys that decode stored AES values, by version. */
export class AesKeyring {
  private readonly keys: ReadonlyMap<number, string>;
  public constructor(keys: ReadonlyMap<number, string>, public readonly currentVersion: number) {
    if (!Number.isSafeInteger(currentVersion) || currentVersion < 1 || !keys.has(currentVersion)) throw new OrmError(codes.CONFIG, `AES version ${currentVersion} is not declared`);
    for (const [version, key] of keys) {
      if (!Number.isSafeInteger(version) || version < 1 || key.length === 0) throw new OrmError(codes.CONFIG, `AES version ${version} has no key`);
    }
    this.keys = new Map(keys);
  }

  public versions(): number[] { return [...this.keys.keys()].sort((a, b) => a - b); }

  public key(version: number): string {
    const key = this.keys.get(version);
    if (key === undefined) throw new OrmError(codes.CONFIG, `AES version ${version} is not declared`);
    return key;
  }

  /**
   * Re-encrypts every AES column of a row with the target version. A NULL AES value has no stored bytes: it is left as it is, and no
   * version is read for it (COD-44). The version column is set only when a value was re-encrypted.
   */
  public rotateRow(row: Readonly<Record<string, unknown>>, versionColumn: string, columns: readonly AesRotationColumn[], targetVersion: number, codec: AesRowCodec): Record<string, unknown> {
    if (!(versionColumn in row)) throw new OrmError(codes.INTERNAL, `AES version column ${versionColumn} is missing`);
    const out = { ...row };
    let oldKey: string | undefined;
    let newKey: string | undefined;
    for (const column of columns) {
      if (!(column.name in row)) throw new OrmError(codes.INTERNAL, `AES column ${column.name} is missing`);
      const value = row[column.name];
      if (value === null) continue;
      if (oldKey === undefined || newKey === undefined) {
        oldKey = this.key(storedVersion(row[versionColumn]));
        newKey = this.key(targetVersion);
      }
      out[column.name] = codec.encode(codec.decode(value, column.styles, oldKey), column.styles, newKey);
    }
    if (oldKey !== undefined) out[versionColumn] = targetVersion;
    return out;
  }
}
