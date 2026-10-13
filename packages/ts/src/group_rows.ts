import { OrmError } from './runtime_error.js';

function checkedCount(value: unknown): number {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new OrmError('CODEC_DECODE', 'group result row_count is not an exact integer');
    return Number(value);
  }
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new OrmError('CODEC_DECODE', 'group result row_count is not an exact integer');
    return number;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new OrmError('CODEC_DECODE', 'group result row_count is not an exact integer');
  }
  if (value < 0 || Object.is(value, -0)) throw new OrmError('INTERNAL', 'group result has a negative row_count');
  return value;
}

/** One grouped result with only selected values and a checked row count. */
export class GroupRow {
  private readonly values = new Map<string, unknown>();
  public readonly count: number;

  public constructor(entries: readonly (readonly [string, unknown])[]) {
    for (const entry of entries) {
      if (entry.length !== 2) throw new OrmError('CONFIG', 'group result entry must have a name and value');
      const [name, value] = entry;
      if (!name || this.values.has(name)) throw new OrmError('CONFIG', `group result repeats or omits column ${name}`);
      this.values.set(name, value);
    }
    if (!this.values.has('row_count')) throw new OrmError('INTERNAL', 'group result has no row_count');
    this.count = checkedCount(this.values.get('row_count'));
    this.values.set('row_count', this.count);
  }

  public value(name: string): unknown {
    if (!this.values.has(name)) throw new OrmError('COLUMN_UNSELECTED', `group column ${name} was not selected`);
    return this.values.get(name);
  }

  public toArray(): Record<string, unknown> { return Object.fromEntries(this.values); }
  public toJSON(): Record<string, unknown> { return this.toArray(); }
}

/** Grouped values in result order, without partial model rows. */
export class GroupRows implements Iterable<GroupRow> {
  private readonly rows: readonly GroupRow[];
  public constructor(rows: readonly GroupRow[]) {
    if (rows.some(row => !(row instanceof GroupRow))) throw new OrmError('CONFIG', 'group result contains an invalid row');
    this.rows = [...rows];
  }
  public get length(): number { return this.rows.length; }
  public values(): GroupRow[] { return [...this.rows]; }
  public toArray(): Array<Record<string, unknown>> { return this.rows.map(row => row.toArray()); }
  public toJSON(): Array<Record<string, unknown>> { return this.toArray(); }
  public [Symbol.iterator](): Iterator<GroupRow> { return this.rows[Symbol.iterator](); }
}
