import type { Assemble, Child, Plan } from './index.js';
import type { Db } from './database.js';
import { OrmError } from './runtime_error.js';
import { QueryCore } from './builder.js';

export type Key = number | string | bigint;
export interface RowConstructor<T extends Row = Row> {
  new (): T;
  entity(): string;
  primaryKey(): string;
  versionColumn(): string | undefined;
  columns(): Readonly<Record<string, string>>;
  fromResult(values: unknown[], assemble: Assemble, rows: ExecutionRows): T;
}

const rowTypes = new Map<string, RowConstructor>();
export function registerRow(entity: string, row: RowConstructor): void { rowTypes.set(entity, row); }

function keyIdentity(key: Key): string {
  if (typeof key === 'number' && (!Number.isSafeInteger(key) || !Number.isFinite(key))) throw new OrmError('IR_INVALID', 'collection number key must be a finite safe integer');
  return `${typeof key}:${String(key)}`;
}

export class Collection<T extends Row = Row> implements Iterable<T> {
  private readonly items: Map<string, { key: Key; value: T }> = new Map();
  public put(key: Key, value: T): void { this.items.set(keyIdentity(key), { key, value }); }
  public get(key: Key): T | undefined { return this.items.get(keyIdentity(key))?.value; }
  public first(): T | undefined { return this.items.values().next().value?.value; }
  public get length(): number { return this.items.size; }
  public keys(): Key[] { return [...this.items.values()].map(item => item.key); }
  public entries(): Array<[Key, T]> { return [...this.items.values()].map(item => [item.key, item.value]); }
  public values(): T[] { return [...this.items.values()].map(item => item.value); }
  public toArray(): unknown[] { return this.values().map(value => value.toObject()); }
  public [Symbol.iterator](): Iterator<T> { return this.values()[Symbol.iterator](); }
}

export class Page<T extends Row = Row> {
  public constructor(public readonly items: Collection<T>, public readonly total: number, public readonly pages: number, public readonly current: number, public readonly per: number) {
    if (!Number.isSafeInteger(per) || per <= 0) throw new OrmError('IR_INVALID', 'paginate per must be positive');
  }
}

interface StepRows { data: unknown[][]; byKey: Map<string, number[]>; }
export class ExecutionRows {
  public readonly steps = new Map<number, StepRows>();
  public constructor(
    public readonly binding: Db,
    public readonly plan: Plan,
    public readonly params: readonly unknown[],
    public readonly data: unknown[][],
  ) {}
  public related(child: Child, parent: readonly unknown[]): unknown[][] {
    const rows = this.steps.get(child.step);
    if (!rows) return [];
    return (rows.byKey.get(scalarKey(parent[child.parent_index])) ?? []).map(index => rows.data[index]!);
  }
  public stepAssemble(child: Child): Assemble {
    const assemble = this.plan.steps.find(step => step.id === child.step)?.assemble;
    if (!assemble) throw new OrmError('INTERNAL', `relation step ${child.step} has no assembly`);
    return assemble;
  }
  public setStep(id: number, data: unknown[][], childIndex: number): void {
    const byKey = new Map<string, number[]>();
    data.forEach((row, index) => {
      const key = scalarKey(row[childIndex]);
      const indexes = byKey.get(key) ?? [];
      indexes.push(index);
      byKey.set(key, indexes);
    });
    this.steps.set(id, { data, byKey });
  }
}

export class Row {
  protected values: unknown[] = [];
  protected indexes: Map<string, number> = new Map();
  protected relations: Map<string, Row | Collection | null> = new Map();
  protected dirty: Map<string, unknown> = new Map();
  protected dirtyStyles: Map<string, readonly string[]> = new Map();
  protected hidden: Set<string> = new Set();
  protected extras: Map<string, unknown> = new Map();
  protected binding: Db | undefined;
  protected loaded: boolean = false;
  protected identity: unknown;
  protected originalVersion: unknown;
  protected cascade: string[] = [];

  public static entity(): string { throw new OrmError('INTERNAL', 'row entity is not declared'); }
  public static primaryKey(): string { throw new OrmError('INTERNAL', 'row primary key is not declared'); }
  public static versionColumn(): string | undefined { return undefined; }
  public static columns(): Readonly<Record<string, string>> { return {}; }

  public static fromResult<T extends typeof Row>(this: T, values: unknown[], assemble: Assemble, rows: ExecutionRows): InstanceType<T> {
    const row = new this() as InstanceType<T>;
    row.binding = rows.binding;
    row.values = values;
    for (const column of assemble.columns) {
      row.indexes.set(column.name, column.index);
      if (column.hidden) row.hidden.add(column.name);
    }
    const pk = this.primaryKey();
    row.loaded = row.indexes.has(pk) && row.column(pk) !== null;
    row.identity = row.column(pk);
    const version = this.versionColumn();
    if (version && row.indexes.has(version)) row.originalVersion = row.column(version);
    for (const child of assemble.children) row.attach(child, values, rows);
    return row;
  }

  private attach(child: Child, values: unknown[], rows: ExecutionRows): void {
    if (child.kind === 'join') {
      const assemble = child.assemble;
      if (!assemble) throw new OrmError('INTERNAL', `join ${child.rel} has no assembly`);
      const type = rowTypes.get(assemble.entity);
      if (!type) throw new OrmError('INTERNAL', `row type ${assemble.entity} is not registered`);
      this.relations.set(child.rel, values[assemble.columns[0]!.index] === null ? null : type.fromResult(values, assemble, rows));
      return;
    }
    const related = rows.related(child, values);
    const assemble = rows.stepAssemble(child);
    const type = rowTypes.get(assemble.entity);
    if (!type) throw new OrmError('INTERNAL', `row type ${assemble.entity} is not registered`);
    if (child.kind === 'one') {
      const value = related[0] ? type.fromResult(related[0], assemble, rows) : null;
      this.relations.set(child.rel, value);
      if (value && child.flatten) {
        for (const column of assemble.columns) if (!column.hidden && !this.indexes.has(column.name)) this.extras.set(column.name, value.column(column.name));
      }
      return;
    }
    if (child.cascade) this.cascade.push(child.rel);
    const collection = new Collection();
    for (const values of related) collection.put(asKey(values[child.key_index]), type.fromResult(values, assemble, rows));
    this.relations.set(child.rel, collection);
  }

  public using(database: Db): this { this.binding = database; return this; }
  public has(column: string): boolean { return this.indexes.has(column) || this.dirty.has(column) || this.extras.has(column); }
  public relLoaded(relation: string): boolean { return this.relations.has(relation); }
  public column(column: string): unknown {
    if (this.dirty.has(column)) return this.dirty.get(column);
    if (!this.indexes.has(column)) {
      if (this.extras.has(column)) return this.extras.get(column);
      if (column in (this.constructor as typeof Row).columns()) return null;
      throw new OrmError('COLUMN_UNKNOWN', `${(this.constructor as typeof Row).entity()}.${column}`);
    }
    return this.values[this.indexes.get(column)!];
  }
  public setColumn(column: string, value: unknown): this {
    if (!this.indexes.has(column)) { this.indexes.set(column, this.values.length); this.values.push(value); }
    else this.values[this.indexes.get(column)!] = value;
    this.dirty.set(column, value);
    return this;
  }
  protected setStyledColumn(column: string, value: unknown, styles: readonly string[]): this { this.setColumn(column, value); this.dirtyStyles.set(column, [...styles]); return this; }
  public relation<T extends Row | Collection>(name: string): T | null { return (this.relations.get(name) as T | null | undefined) ?? null; }
  public toObject(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name] of this.indexes) if (!this.hidden.has(name)) out[name] = this.column(name);
    for (const [name, value] of this.extras) out[name] = value;
    for (const [name, value] of this.dirty) if (!this.hidden.has(name)) out[name] = value;
    for (const [name, value] of this.relations) out[name] = value instanceof Row ? value.toObject() : value instanceof Collection ? value.toArray() : value;
    return out;
  }
  public async update(): Promise<void> { await this.updateRow(false); }
  public async updateOptimistic(): Promise<void> { await this.updateRow(true); }
  private async updateRow(optimistic: boolean): Promise<void> {
    if (!this.loaded) throw new OrmError('CONFIG', 'update requires a loaded row');
    if (optimistic && this.originalVersion === undefined) throw new OrmError('CONFIG', 'optimistic update requires a loaded version column');
    if (this.dirty.size === 0) return;
    const database = this.requiredBinding();
    const query = new QueryCore((this.constructor as typeof Row).entity()).using(database);
    for (const [column, value] of this.dirty) {
      const styles = this.dirtyStyles.get(column);
      if (styles) query.setEncoded(column, value, styles); else query.set(column, value);
    }
    query.predicate((this.constructor as typeof Row).primaryKey(), 'eq', this.identity);
    if (optimistic) query.optimistic((this.constructor as typeof Row).versionColumn()!, this.originalVersion);
    const result = await database.execute(await database.plan(query.request.shape('update')), query.request.params) as {affected:number};
    if (optimistic && result.affected === 0) throw new OrmError('OPTIMISTIC_LOCK', 'row changed since it was read');
    this.dirty.clear(); this.dirtyStyles.clear();
  }
  public async delete(): Promise<void> { await this.deleteRow(false); }
  public async deleteCascade(): Promise<void> { await this.deleteRow(true); }
  private async deleteRow(cascade: boolean): Promise<void> {
    if (!this.loaded) throw new OrmError('CONFIG', 'delete requires a loaded row');
    const database = this.requiredBinding();
    if (cascade) {
      for (const name of this.cascade) {
        const related = this.relations.get(name);
        if (related instanceof Collection) for (const row of related) await row.deleteCascade();
        else if (related instanceof Row) await related.deleteCascade();
      }
    }
    const query = new QueryCore((this.constructor as typeof Row).entity()).using(database);
    query.predicate((this.constructor as typeof Row).primaryKey(), 'eq', this.identity);
    await database.execute(await database.plan(query.request.shape('delete')), query.request.params);
  }
  private requiredBinding(): Db { if (!this.binding) throw new OrmError('CONFIG', 'row has no database'); return this.binding; }
}

export function rowCollection<T extends Row>(rows: ExecutionRows, assemble: Assemble, keyIndex?: number): Collection<T> {
  const type = rowTypes.get(assemble.entity);
  if (!type) throw new OrmError('INTERNAL', `row type ${assemble.entity} is not registered`);
  const collection = new Collection<T>();
  for (const values of rows.data) collection.put(asKey(values[keyIndex ?? assemble.columns[0]!.index]), type.fromResult(values, assemble, rows) as T);
  return collection;
}

export function scalarKey(value: unknown): string { return value === null ? 'null:' : `${typeof value}:${String(value)}`; }
function asKey(value: unknown): Key {
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') return value;
  throw new OrmError('IR_INVALID', `collection key must be an integer or string: ${String(value)}`);
}
