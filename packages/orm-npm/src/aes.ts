import { OrmError } from './runtime_error.js';

export interface AesRotationColumn {
  name: string;
  styles: readonly string[];
}

export interface AesRowCodec {
  decode(value: unknown, styles: readonly string[], key: string): unknown;
  encode(value: unknown, styles: readonly string[], key: string): unknown;
}

/** The keys that decode stored AES values, by version. */
export class AesKeyring {
  private readonly keys: ReadonlyMap<number, string>;
  public constructor(keys: ReadonlyMap<number, string>, public readonly currentVersion: number) {
    if (!Number.isSafeInteger(currentVersion) || currentVersion < 1 || !keys.has(currentVersion)) throw new OrmError('CONFIG', `AES version ${currentVersion} is not declared`);
    for (const [version, key] of keys) {
      if (!Number.isSafeInteger(version) || version < 1 || key.length === 0) throw new OrmError('CONFIG', `AES version ${version} has no key`);
    }
    this.keys = new Map(keys);
  }

  public versions(): number[] { return [...this.keys.keys()].sort((a, b) => a - b); }

  public key(version: number): string {
    const key = this.keys.get(version);
    if (key === undefined) throw new OrmError('CONFIG', `AES version ${version} is not declared`);
    return key;
  }

  /** Re-encrypts every AES column of a row with the target version. */
  public rotateRow(row: Readonly<Record<string, unknown>>, versionColumn: string, columns: readonly AesRotationColumn[], targetVersion: number, codec: AesRowCodec): Record<string, unknown> {
    const oldVersion = row[versionColumn];
    if (typeof oldVersion !== 'number' || !Number.isInteger(oldVersion)) throw new OrmError('CODEC_DECODE', 'AES row version must be an integer');
    const oldKey = this.key(oldVersion);
    const newKey = this.key(targetVersion);
    const out = { ...row };
    for (const column of columns) {
      if (!(column.name in row)) throw new OrmError('CONFIG', `AES column ${column.name} is missing`);
      out[column.name] = codec.encode(codec.decode(row[column.name], column.styles, oldKey), column.styles, newKey);
    }
    out[versionColumn] = targetVersion;
    return out;
  }
}
