import { CORE, Core, RowState, configError, isModel, styledField, type EntityDef, type ModelLike, type SetSpec } from './core.js';
import { encodeStyled } from './codec.js';
import { Value as OrderedJsonValue, stringify as orderedJsonStringify } from '@polyspec/ordered-json';
import { Db, keyOfValues, keyText, keyValue, paginate, query, readTime, resolve, rowKey, scalar, scalarKey, statement, write, type Executor, type Key, type Result, type Written } from './database.js';
import { restoreKey } from './engine/validate.js';
import { fieldOf, type Entity, type Field, type RuntimeModel } from './engine/model.js';
import type { Assemble, Request } from './ir.js';
import { markdownLinks } from './markdown.js';
import { columnName, parseChain, parseOrder, snake, splitPair, upperFirst, type ChainKey } from './names.js';
import { present } from './present.js';
import { OrmError } from './runtime_error.js';
import { StyledValue, orderedJsonOutput } from './styled_value.js';
import { normalizeDecimal } from './decimal.js';
import { decimalFromScaled } from './decimal.js';
import { GroupRow, GroupRows } from './group_rows.js';
import * as codes from './codes.js';


/** A generated model class. */
export interface ModelClass<T extends Model = Model> {
  new (core?: Core): T;
  readonly entity: EntityDef;
}

type Resolved = (this: Model, ...args: unknown[]) => unknown;

const protocolNames = new Set(['then', 'catch', 'finally', 'toJSON', 'constructor', 'inspect', 'nodeType', 'asymmetricMatch', '$$typeof', 'toString', 'valueOf', 'length', 'prototype']);
const resolvers = new WeakMap<object, Map<string, Resolved | undefined>>();

/** Whether `value` is the entity definition that a generated model class carries. */
function isEntityDef(value: unknown): value is EntityDef {
  return typeof value === 'object' && value !== null && 'model' in value && 'entity' in value
    && typeof Reflect.get(value, 'create') === 'function';
}

/** The entity definition of the model class `ctor`; a class without one is a CONFIG error. */
function entityDefOf(ctor: unknown): EntityDef {
  const def: unknown = typeof ctor === 'function' ? Reflect.get(ctor, 'entity') : undefined;
  if (!isEntityDef(def)) throw configError('a model class has no entity definition');
  return def;
}

/** Whether `value` is a model of the entity of `model`: the rows and groups that a model makes are of its entity. */
function isModelOf<M extends Model>(model: M, value: unknown): value is M {
  return value instanceof Model && value[CORE].ent.entity === model[CORE].ent.entity;
}

/** `value` as a model of the entity of `model`; another value is an INTERNAL error. */
function modelOf<M extends Model>(model: M, value: unknown): M {
  if (!isModelOf(model, value)) throw new OrmError(codes.INTERNAL, `a model of ${model[CORE].ent.entity.name} received another value`);
  return value;
}

/** Whether every row of `rows` is a model of the entity of `model`. */
function isCollectionOf<M extends Model>(model: M, rows: Collection): rows is Collection<M> {
  return rows.values().every(row => isModelOf(model, row));
}

/** `rows` as rows of the entity of `model`; a row of another entity is an INTERNAL error. */
function collectionOf<M extends Model>(model: M, rows: Collection): Collection<M> {
  if (!isCollectionOf(model, rows)) throw new OrmError(codes.INTERNAL, `the rows of ${model[CORE].ent.entity.name} hold another model`);
  return rows;
}

/** `value` as a model: the self of a core is the model that made it. */
function asModel(value: unknown): Model {
  if (!(value instanceof Model)) throw new OrmError(codes.INTERNAL, 'the self of a core is no model');
  return value;
}

/** The text of a cell that a text column reads. */
function cellText(value: unknown): string {
  if (value instanceof Uint8Array) return Buffer.from(value).toString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? typeof value;
}

const truthyCells: readonly unknown[] = [true, 1, 1n, '1', 't', 'true'];
const falsyCells: readonly unknown[] = [false, 0, 0n, '0', 'f', 'false'];

const handler: ProxyHandler<Model> = {
  get(target, prop, receiver) {
    if (typeof prop !== 'string' || prop in target) {
      const value: unknown = Reflect.get(target, prop, receiver);
      return value;
    }
    const ctor = target.constructor;
    let cache = resolvers.get(ctor);
    if (cache === undefined) { cache = new Map(); resolvers.set(ctor, cache); }
    if (!cache.has(prop)) cache.set(prop, protocolNames.has(prop) ? undefined : resolveName(entityDefOf(ctor), prop));
    return cache.get(prop);
  },
};

/**
 * The base of every generated model: the query builder and the loaded row.
 * Condition, join, relation, and attached-value methods named by the chain
 * grammar are resolved from the method name.
 */
export abstract class Model implements ModelLike {
  declare public readonly [CORE]: Core;

  public constructor(core?: Core) {
    const def = entityDefOf(new.target);
    const c = core ?? new Core(def);
    const proxy = new Proxy(this, handler);
    Object.defineProperty(this, CORE, { value: c, enumerable: false });
    c.self = proxy;
    return proxy;
  }

  /** Sets the connection of the model or row. */
  public connect(db: Db): this { this[CORE].connect(db); return this; }
  /** Joins the next condition with AND, opens an AND group, or places a joined model's conditions. */
  public and(arg?: ((q: this) => unknown) | Model): this { this[CORE].connector('and', arg === undefined ? [] : [arg]); return this; }
  /** Joins the next condition with OR, opens an OR group, or places a joined model's conditions. */
  public or(arg?: ((q: this) => unknown) | Model): this { this[CORE].connector('or', arg === undefined ? [] : [arg]); return this; }
  /** A negated group, NOT (…), as the first condition or after a connector written as a separate call. */
  public not(fn: (q: this) => unknown): this { this[CORE].negated('', m => fn(modelOf(this, m))); return this; }
  /** A negated group joined with AND. */
  public andNot(fn: (q: this) => unknown): this { this[CORE].negated('and', m => fn(modelOf(this, m))); return this; }
  /** A negated group joined with OR. */
  public orNot(fn: (q: this) => unknown): this { this[CORE].negated('or', m => fn(modelOf(this, m))); return this; }
  /** Sets the join ON conditions. */
  public on(fn: (q: this) => unknown): this { this[CORE].setOn(m => fn(modelOf(this, m))); return this; }
  public relation(child: Model): this { this[CORE].relation(false, child); return this; }
  public relations(child: Model): this { this[CORE].relation(true, child); return this; }
  public limit(offset: number, count: number): this { this[CORE].setLimit(offset, count); return this; }
  public orderByRandom(): this { this[CORE].order.push({ random: true }); return this; }
  public removeAllColumns(): this { this[CORE].columns.mode = 'none'; return this; }
  public addAllColumns(): this { this[CORE].columns.mode = 'all'; return this; }
  public parentNode(): this { this[CORE].parentNode = true; return this; }
  public groupLimit(n: number): this { this[CORE].setGroupLimit(n); return this; }
  public deleteLock(): this { this[CORE].deleteLock = true; return this; }
  public fetchKey(fn: (row: this) => Key): this { this[CORE].fetchKey = m => fn(modelOf(this, m)); return this; }
  public fetchValue(fn: (row: this) => unknown): this { this[CORE].fetchValue = m => fn(modelOf(this, m)); return this; }
  public forUpdate(): this { this[CORE].lock = 'update'; return this; }
  public forShare(): this { this[CORE].lock = 'share'; return this; }
  public forUpdateNoWait(): this { this[CORE].lock = 'update_nowait'; return this; }
  public forShareNoWait(): this { this[CORE].lock = 'share_nowait'; return this; }
  public duplication(model: this): this { this[CORE].setDuplication(model); return this; }

  /** Returns the first matching row; NO_ROWS when no row matches. */
  public async get(): Promise<this> {
    const rows = await load(this[CORE], 'one');
    const row = rows.first();
    if (row === undefined) throw new OrmError(codes.NO_ROWS, 'query matched no rows');
    return modelOf(this, row);
  }
  /** Returns the matching rows. */
  public async gets(): Promise<Collection<this>> { return collectionOf(this, await load(this[CORE], 'all')); }
  /** Returns grouped values and checked row counts without partial models. */
  public async getsCount(): Promise<GroupRows> { return grouped(this[CORE]); }
  public async getCount(): Promise<number> { return Number(await scalarOf(this[CORE], 'count')); }
  public async getSum(): Promise<number> { return aggregate(this[CORE], 'sum'); }
  public async getAvg(): Promise<number> { return aggregate(this[CORE], 'avg'); }
  /** Returns one page of matching rows. */
  public async getsPage(page: number, perPage: number): Promise<Page<this>> {
    const found = await pageOf(this[CORE], page, perPage);
    return { ...found, items: collectionOf(this, found.items) };
  }
  /** Returns the statement of gets() without executing it. */
  public async getQuery(): Promise<{ sql: string; binds: unknown[] }> {
    const c = this[CORE];
    const ex = terminal(c);
    const r = c.build('all');
    if (r.error) throw r.error;
    return statement(ex, r.finish(), r.params);
  }
  /** Inserts the row and returns the created row. */
  public async create(): Promise<this> { return modelOf(this, await create(this[CORE])); }
  /** Inserts rows in one transaction and returns the inserted row count. */
  public async creates(rows: readonly this[]): Promise<number> { return creates(this[CORE], rows); }
  /** Writes the changed columns; update(true) requires an unchanged update time. */
  public async update(optimistic = false): Promise<this> { await update(this[CORE], optimistic); return this; }
  /** Updates the row when its primary key is known, otherwise creates it. */
  public async save(): Promise<this> { return modelOf(this, await save(this[CORE])); }
  /** Deletes the row; delete(true) first deletes loaded related rows. */
  public async delete(recursive = false): Promise<void> { await deleteRow(this[CORE], recursive); }
  /**
   * Restores the soft-deleted row that the set values name by its primary key or one unique key, writes the other
   * set values into it, and returns the restored row. A row that is not deleted is returned unchanged; a missing row
   * fails with NO_ROWS.
   */
  public async restore(): Promise<this> { return modelOf(this, await restore(this[CORE])); }

  public toArray(): Record<string, unknown> { return toArray(this[CORE]); }
  public toJSON(): Record<string, unknown> { return toJson(this[CORE]); }
  /** Returns the JSON text of the row: members in row order, an ordered-json value as its stored text. */
  public toJSONText(): string { return rowText(this[CORE]); }
}

/** An ordered set of rows keyed by primary key, key column, or key callback. */
export class Collection<T extends Model = Model> implements Iterable<T> {
  private readonly items = new Map<string, { key: Key; value: T; fetched?: unknown }>();
  public put(key: Key, value: T, fetched?: unknown): void { this.items.set(keyText(key), { key, value, fetched }); }
  public get(key: Key): T | undefined { return this.items.get(keyText(key))?.value; }
  public has(key: Key): boolean { return this.items.has(keyText(key)); }
  public first(): T | undefined { return this.items.values().next().value?.value; }
  public get length(): number { return this.items.size; }
  public keys(): Key[] { return [...this.items.values()].map(item => item.key); }
  public values(): T[] { return [...this.items.values()].map(item => item.value); }
  public entries(): Array<[Key, T]> { return [...this.items.values()].map(item => [item.key, item.value]); }
  /** Returns the fetchValue result of the key. */
  public fetched(key: Key): unknown { return this.items.get(keyText(key))?.fetched; }
  public fetchedValues(): unknown[] { return [...this.items.values()].map(item => item.fetched); }
  /** Sets the connection of every row. */
  public connect(db: Db): this { for (const row of this.values()) row.connect(db); return this; }
  /** Deletes every row in one transaction; delete(true) first deletes loaded related rows. */
  public async delete(recursive = false): Promise<void> {
    const first = this.first();
    if (first === undefined) return;
    await inTransaction(first[CORE].conn, async () => { for (const row of this.values()) await deleteOne(row[CORE], recursive); });
  }
  public toArray(): Array<Record<string, unknown>> { return this.values().map(row => row.toArray()); }
  public toJSON(): Array<Record<string, unknown>> { return this.values().map(row => row.toJSON()); }
  /** Returns the JSON text of the rows; see Model.toJSONText. */
  public toJSONText(): string { return `[${this.values().map(row => row.toJSONText()).join(',')}]`; }
  public [Symbol.iterator](): Iterator<T> { return this.values()[Symbol.iterator](); }
}

export interface Page<T extends Model = Model> {
  items: Collection<T>;
  totalCount: number;
  totalPages: number;
  page: number;
  perPage: number;
}

function terminal(c: Core): Executor {
  if (c.group) throw configError('a terminal is not allowed inside a group callback');
  if (c.error) throw c.error;
  return resolve(c.conn);
}

const integerRanges: Readonly<Record<string, readonly [number, number]>> = {
  i16: [-32768, 32767],
  i32: [-2147483648, 2147483647],
  i64: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
};

/** Converts a cell to the value type of its column type (docs/dbspec.md "Runtime model"). */
function convert(type: string, value: unknown, zone: string, declared?: Field): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'i16': case 'i32': case 'i64': {
      const converted = typeof value === 'bigint' ? Number(value) : value;
      const [min, max] = present(integerRanges[type], `the range of ${type}`);
      if (typeof converted !== 'number' || !Number.isSafeInteger(converted) || converted < min || converted > max) {
        throw new OrmError(codes.CODEC_DECODE, `${type} cell is not an exact integer in its range`);
      }
      return converted;
    }
    case 'f64':
      return typeof value === 'number' ? value : Number(value);
    case 'decimal': {
      if (declared === undefined) throw new OrmError(codes.CODEC_DECODE, 'decimal column metadata is missing');
      if (typeof value === 'bigint') return decimalFromScaled(value, declared.precision, declared.scale);
      if (typeof value !== 'string') throw new OrmError(codes.CODEC_DECODE, `decimal cell has type ${typeof value}`);
      try { return normalizeDecimal(value, declared.precision, declared.scale); }
      catch (cause) { throw new OrmError(codes.CODEC_DECODE, `invalid decimal cell: ${String(cause)}`); }
    }
    case 'bool':
      return value === true || value === 1 || value === 1n || value === '1' || value === 't' || value === 'true';
    case 'date': case 'time': case 'datetime':
      return readTime(value, type, zone, declared?.precision ?? (type === 'datetime' ? 6 : 0));
    case 'bytes':
      return value instanceof Uint8Array ? value : new Uint8Array(Buffer.from(cellText(value)));
    case 'varchar': case 'text': case 'uuid':
      return cellText(value);
    case 'styled':
      return value;
  }
  throw new OrmError(codes.INTERNAL, `cell of unknown type ${type}`);
}

// host stage(aes, hex, ip)만 가진 column의 model 값은 문자열이다. 저장 형식은
// executor가 bind할 때 만든다.
function columnType(col: Field): string {
  if (styledField(col)) return 'styled';
  if (col.stages.length > 0 && col.stages.every(s => s === 'aes' || s === 'hex' || s === 'ip')) return 'text';
  return col.type;
}

function newModel(def: EntityDef): Core {
  const c = new Core(def);
  def.create(c);
  return c;
}

class Assembler {
  public readonly made = new Map<Core, Core[]>();
  public constructor(private readonly result: Result, private readonly db: Db, private readonly conn: Db | undefined) {}

  public model(b: Core, asm: Assemble, row: readonly unknown[]): Core {
    const m = newModel(b.ent);
    m.conn = this.conn;
    const st = new RowState();
    st.loaded = true;
    m.row = st;
    const schema = b.ent.entity;
    for (const col of asm.columns) {
      if (col.hidden) st.hidden.add(col.name);
      st.addName(col.name);
      const declared = col.column !== '' && col.column === col.name ? fieldOf(schema, col.name) : undefined;
      if (declared) m.values.set(col.name, convert(columnType(declared), row[col.index], this.db.zone, declared));
      else st.extra.set(col.name, col.type === 'date' || col.type === 'datetime' ? convert(col.type, row[col.index], this.db.zone) : row[col.index]);
    }
    for (const key of asm.key) {
      const name = present(asm.columns.find(col => col.index === key.index), `the key column at ${key.index}`).name;
      st.original.set(name, m.values.get(name));
    }
    if (schema.updated !== '' && st.names.includes(schema.updated)) st.original.set(schema.updated, m.values.get(schema.updated));
    for (const name of b.news) m.setNew(name, b.newValues.get(name));
    for (const ch of asm.children) {
      if (ch.kind === 'join') {
        const child = joinChild(b, ch.rel);
        const joined = this.joinRow(ch, row);
        const value = joined !== undefined ? this.model(child, present(ch.assemble, `the assembly of join ${ch.rel}`), joined).self : null;
        st.setRelated(ch.rel, value, false, false);
        continue;
      }
      const [child, many] = relationChild(b, ch.rel);
      const [rows, childAsm] = this.related(ch, row);
      if (many) {
        const coll = new Collection();
        for (const cr of rows) {
          const cm = this.model(child, childAsm, cr);
          coll.put(collectionKey(child, cm, childAsm, cr), asModel(cm.self));
        }
        st.setRelated(ch.rel, coll, ch.cascade, false);
      } else {
        const value = rows.length > 0 ? this.model(child, childAsm, present(rows[0], `the row of relation ${ch.rel}`)).self : null;
        st.setRelated(ch.rel, value, ch.cascade, ch.flatten);
      }
    }
    const list = this.made.get(b) ?? [];
    list.push(m);
    this.made.set(b, list);
    return m;
  }

  /**
   * join ch의 행이고, 없으면 undefined다. SQL 결과에서는 join column이 부모 행에 함께 있고 첫 column이 NULL이면
   * 없다. markdown 답에서는 부모 행의 마지막 칸이 join 행을 가진다.
   */
  private joinRow(ch: Assemble['children'][number], row: readonly unknown[]): readonly unknown[] | undefined {
    if (this.result.markdown) return markdownLinks(row).joins.get(ch.rel) ?? undefined;
    const first = present(ch.assemble, `the assembly of join ${ch.rel}`).columns[0];
    return first !== undefined && row[first.index] !== null ? row : undefined;
  }

  /**
   * relation ch에서 부모 행 parent의 행과 그 배치다. SQL 결과에서는 relation step의 행을 key로 찾고, markdown
   * 답에서는 부모 행의 마지막 칸이 relation 행을 가진다.
   */
  private related(ch: Assemble['children'][number], parent: readonly unknown[]): [unknown[][], Assemble] {
    if (this.result.markdown) return [markdownLinks(parent).rels.get(ch.rel) ?? [], present(ch.assemble, `the assembly of relation ${ch.rel}`)];
    const sr = present(this.result.steps.get(ch.step), `the result of step ${ch.step}`);
    const childAsm = present(sr.step.assemble, `the assembly of step ${ch.step}`);
    const ifp = sr.step.parent?.if_parent;
    if (ifp && scalarKey(parent[ifp.index]) !== scalarKey(this.result.params[ifp.param])) return [[], childAsm];
    const key = rowKey(parent, ch.parent_keys);
    if (key === undefined) return [[], childAsm];
    return [(sr.byKey.get(key) ?? []).map(i => present(sr.data[i], `row ${i} of step ${ch.step}`)), childAsm];
  }
}

function joinChild(c: Core, name: string): Core {
  const j = c.joins.find(j => j.child.resultName(false) === name);
  if (!j) throw new OrmError(codes.INTERNAL, `join result ${name} without a model`);
  return j.child;
}

function relationChild(c: Core, name: string): [Core, boolean] {
  const r = c.relations.find(r => r.child.resultName(r.many) === name);
  if (!r) throw new OrmError(codes.INTERNAL, `relation result ${name} without a model`);
  return [r.child, r.many];
}

function valueOf(m: Core, name: string): unknown {
  if (m.values.has(name)) return m.values.get(name);
  return m.row?.extra.get(name) ?? null;
}

function collectionKey(c: Core, m: Core, asm: Assemble, row: readonly unknown[]): Key {
  if (c.fetchKey) return keyValue(c.fetchKey(m.self));
  if (c.keyName !== '') return keyValue(valueOf(m, c.keyName));
  const [only] = asm.key;
  if (asm.key.length === 1 && only !== undefined) {
    const column = present(asm.columns.find(col => col.index === only.index), `the key column at ${only.index}`);
    return keyValue(m.values.get(column.name) ?? row[only.index]);
  }
  return rowKey(row, asm.key) ?? '';
}

async function load(c: Core, kind: 'one' | 'all'): Promise<Collection> {
  const ex = terminal(c);
  const r = c.build(kind);
  if (r.error) throw r.error;
  const result = await query(ex, r.finish(), r.params);
  return assemble(c, ex, r.external, result);
}

function groupValue(db: Db, column: Assemble['columns'][number], raw: unknown, schema: Entity): unknown {
  const declared = column.column === column.name ? fieldOf(schema, column.name) : undefined;
  if (raw === undefined) throw new OrmError(codes.INTERNAL, `group result column ${column.name} is missing`);
  if (column.name === 'row_count') return raw;
  if (raw === null) {
    if (declared && declared.nullable !== true) throw new OrmError(codes.CODEC_DECODE, `group column ${column.name} is SQL NULL`);
    return null;
  }
  const type = declared ? columnType(declared) : column.type;
  if (type === 'styled') {
    if (!(raw instanceof StyledValue)) throw new OrmError(codes.CODEC_DECODE, `group column ${column.name} is not StyledValue`);
    return raw;
  }
  if (type === 'bool') {
    if (truthyCells.includes(raw)) return true;
    if (falsyCells.includes(raw)) return false;
    throw new OrmError(codes.CODEC_DECODE, `group column ${column.name} is not boolean`);
  }
  if (type === 'i16' || type === 'i32' || type === 'i64') {
    let value: number;
    if (typeof raw === 'string' && /^-?(0|[1-9][0-9]*)$/.test(raw)) value = Number(raw);
    else if (typeof raw === 'bigint') value = Number(raw);
    else if (typeof raw === 'number') value = raw;
    else throw new OrmError(codes.CODEC_DECODE, `group column ${column.name} is not an exact integer`);
    const [min, max] = present(integerRanges[type], `the range of ${type}`);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new OrmError(codes.CODEC_DECODE, `group column ${column.name} is outside its exact integer range`);
    }
    return value;
  }
  if (type === 'f64') {
    if (typeof raw !== 'number' && !(typeof raw === 'string' && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(raw))) {
      throw new OrmError(codes.CODEC_DECODE, `group column ${column.name} is not numeric`);
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new OrmError(codes.CODEC_DECODE, `group column ${column.name} is not finite`);
    return value;
  }
  if (type === 'decimal') return convert(type, raw, db.zone, declared);
  if (type === 'date' || type === 'time' || type === 'datetime') {
    if (!(raw instanceof Date) && typeof raw !== 'string') throw new OrmError(codes.CODEC_DECODE, `group column ${column.name} is not a ${type}`);
    return convert(type, raw, db.zone, declared);
  }
  if (type === 'bytes') {
    if (!(raw instanceof Uint8Array)) throw new OrmError(codes.CODEC_DECODE, `group column ${column.name} is not bytes`);
    return raw;
  }
  if (['string', 'varchar', 'text', 'uuid'].includes(type)) {
    if (typeof raw === 'string') return raw;
    if (raw instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: true }).decode(raw);
    throw new OrmError(codes.CODEC_DECODE, `group column ${column.name} is not text`);
  }
  throw new OrmError(codes.INTERNAL, `group column ${column.name} has unsupported type ${type}`);
}

async function grouped(c: Core): Promise<GroupRows> {
  const ex = terminal(c);
  const r = c.build('group_count');
  if (r.error) throw r.error;
  if (r.external.size !== 0) throw configError('group count cannot return relations');
  const result = await query(ex, r.finish(), r.params);
  const columns = result.plan.steps[0]?.assemble?.columns;
  if (!columns) throw new OrmError(codes.INTERNAL, 'group count has no result declaration');
  const names = new Set<string>();
  for (const column of columns) {
    if (column.hidden) continue;
    if (!column.name || names.has(column.name)) throw configError(`group result repeats or omits column ${column.name}`);
    names.add(column.name);
  }
  if (!names.has('row_count')) throw new OrmError(codes.INTERNAL, 'group result has no row_count');
  const rows: GroupRow[] = [];
  for (const raw of result.main) {
    const entries: Array<[string, unknown]> = [];
    for (const column of columns) {
      if (column.hidden) continue;
      if (column.index < 0 || column.index >= raw.length) throw new OrmError(codes.INTERNAL, `group result column ${column.name} is missing`);
      entries.push([column.name, groupValue(ex.db, column, raw[column.index], c.ent.entity)]);
    }
    rows.push(new GroupRow(entries));
  }
  return new GroupRows(rows);
}

async function assemble(c: Core, ex: Executor, external: Map<Core, Array<{ many: boolean; child: Core }>>, result: Result): Promise<Collection> {
  const a = new Assembler(result, ex.db, c.conn);
  const asm = present(present(result.plan.steps[0], 'the main step of a plan').assemble, 'the assembly of the main step');
  const out = new Collection();
  for (const row of result.main) {
    const m = a.model(c, asm, row);
    out.put(collectionKey(c, m, asm, row), asModel(m.self));
  }
  for (const [parent, rels] of external) {
    const parents = a.made.get(parent) ?? [];
    if (parents.length === 0) continue;
    for (const rel of rels) await attachExternal(parents, rel);
  }
  if (c.fetchValue) {
    const fetched = new Collection();
    for (const [key, row] of out.entries()) fetched.put(key, row, c.fetchValue(row));
    return fetched;
  }
  return out;
}

/** model의 relation key 성분 값을 key 순서로 반환한다. 성분 하나라도 null이면 undefined다. */
function matchValues(m: Core, ch: Core, side: 'left' | 'right'): unknown[] | undefined {
  const values: unknown[] = [];
  for (const k of ch.matches) {
    const v = valueOf(m, k[side]);
    if (v === null || v === undefined) return undefined;
    values.push(v);
  }
  return values;
}

async function attachExternal(parents: Core[], rel: { many: boolean; child: Core }): Promise<void> {
  const ch = rel.child;
  const possible = (p: Core) => ch.possible === undefined || scalarKey(valueOf(p, ch.possible.column)) === scalarKey(ch.possible.value);
  const values: unknown[] = [];
  const seen = new Set<string>();
  for (const p of parents) {
    if (!possible(p)) continue;
    const v = matchValues(p, ch, 'left');
    if (v === undefined || seen.has(keyOfValues(v))) continue;
    seen.add(keyOfValues(v));
    values.push(v.length === 1 ? v[0] : v);
  }
  const byKey = new Map<string, Array<[Key, Core]>>();
  if (values.length > 0) {
    const q = ch.clone();
    q.matches = [];
    q.alias = '';
    // composite key는 자식 key column 전체를 tuple로 거른다.
    const rights = ch.matches.map(k => k.right);
    const keys: ChainKey[] = rights.length === 1
      ? [{ conn: '', op: '', column: present(rights[0], 'the one key column of a relation'), columns: [], compare: '' }]
      : [{ conn: '', op: 'tuple', column: '', columns: rights, compare: '' }];
    const rows = await load(q.by(keys, [values]), 'all');
    for (const [key, row] of rows.entries()) {
      const v = matchValues(row[CORE], ch, 'right');
      if (v === undefined) continue;
      const k = keyOfValues(v);
      const list = byKey.get(k) ?? [];
      if (ch.groupLimit > 0 && list.length >= ch.groupLimit) continue;
      list.push([key, row[CORE]]);
      byKey.set(k, list);
    }
  }
  const name = ch.resultName(rel.many);
  for (const p of parents) {
    const parentRow = present(p.row, 'the loaded row of a relation parent');
    if (parentRow.related.has(name)) throw configError(`relation result name ${name} is used twice`);
    const v = matchValues(p, ch, 'left');
    const matched = possible(p) && v !== undefined ? byKey.get(keyOfValues(v)) ?? [] : [];
    if (rel.many) {
      const coll = new Collection();
      for (const [key, m] of matched) coll.put(key, asModel(m.self));
      parentRow.setRelated(name, coll, !ch.deleteLock, false);
    } else {
      parentRow.setRelated(name, matched.length > 0 ? present(matched[0], 'the matched row')[1].self : null, !ch.deleteLock, ch.parentNode);
    }
  }
}

async function scalarOf(c: Core, kind: 'count' | 'sum' | 'avg', agg = ''): Promise<unknown> {
  const ex = terminal(c);
  const r = c.build(kind);
  if (r.error) throw r.error;
  if (agg !== '') r.ir.agg = agg;
  return scalar(ex, r.finish(), r.params);
}

async function aggregate(c: Core, fn: 'sum' | 'avg'): Promise<number> {
  if (c.aggFn !== fn) throw configError(`get${upperFirst(fn)} requires ${fn}<Col>()`);
  const value = await scalarOf(c, fn, c.agg);
  return aggregateNumber(value);
}

export function aggregateNumber(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'bigint'
      && !(typeof value === 'string' && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value))) {
    throw new OrmError(codes.CODEC_DECODE, 'aggregate scalar is not a finite number');
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new OrmError(codes.CODEC_DECODE, 'aggregate scalar is outside finite binary64 range');
  return number;
}

async function pageOf(c: Core, page: number, perPage: number): Promise<Page> {
  if (!Number.isSafeInteger(page) || !Number.isSafeInteger(perPage) || page < 1 || perPage < 1) throw configError('getsPage requires a positive page and perPage');
  if (c.limit) throw configError('getsPage cannot be combined with limit');
  const ex = terminal(c);
  const q = c.clone();
  q.limit = { offset: (page - 1) * perPage, count: perPage };
  const r = q.build('paginate');
  if (r.error) throw r.error;
  const { result, total } = await paginate(ex, r.finish(), r.params);
  const items = await assemble(q, ex, r.external, result);
  return { items, totalCount: total, totalPages: Math.ceil(total / perPage), page, perPage };
}

async function inTransaction(conn: Db | undefined, fn: () => Promise<void>): Promise<void> {
  if (conn === undefined) {
    resolve(undefined);
    return fn();
  }
  return conn.transaction(fn, { retry: 0 });
}

interface WriteRequest { ir: Request; params: unknown[]; }

function writeRequest(c: Core, kind: 'insert' | 'update' | 'delete'): WriteRequest {
  return { ir: { ir_version: 1, manifest_hash: c.ent.model.manifestHash, kind, entity: c.ent.entity.name, n_params: 0 }, params: [] };
}

function param(r: WriteRequest, value: unknown): number {
  r.params.push(value);
  return r.params.length - 1;
}

function encodeValue(schema: Entity, column: string, value: unknown): unknown {
  const col = fieldOf(schema, column);
  if (col === undefined) throw new OrmError(codes.COLUMN_UNKNOWN, `${schema.name}.${column}`);
  const codec = col.stages.filter(s => s !== 'aes' && s !== 'hex' && s !== 'ip');
  if (codec.length === 0) return value;
  if (!(value instanceof StyledValue)) throw new OrmError(codes.CODEC_ENCODE, `${column} requires StyledValue`);
  return encodeStyled(codec, value);
}

function assign(r: WriteRequest, schema: Entity, s: SetSpec): NonNullable<Request['set']>[number] {
  if (s.null) return { column: s.column, null: true };
  if (s.plus) return { column: s.column, plus_p: param(r, s.value) };
  if (s.minus) return { column: s.column, minus_p: param(r, s.value) };
  const value = encodeValue(schema, s.column, s.value);
  if (value === null || value === undefined) return { column: s.column, null: true };
  return { column: s.column, p: param(r, value) };
}

function finishWrite(r: WriteRequest): Request {
  r.ir.n_params = r.params.length;
  return r.ir;
}

async function create(c: Core): Promise<Model> {
  const ex = terminal(c);
  if (c.sets.length === 0) throw configError('create requires set<Col> values');
  const schema = c.ent.entity;
  const r = writeRequest(c, 'insert');
  r.ir.set = c.sets.map(s => assign(r, schema, s));
  if (c.duplication) {
    r.ir.on_duplicate = c.duplication.sets.map(s => assign(r, schema, s));
    if (r.ir.on_duplicate.length === 0) throw configError('duplication model has no set<Col> values');
  }
  const { key } = await write(ex, finishWrite(r), r.params);
  const m = newModel(c.ent);
  m.conn = c.conn;
  const st = new RowState();
  m.row = st;
  for (const s of c.sets) {
    st.addName(s.column);
    if (s.plus || s.minus) continue;
    const field = present(fieldOf(schema, s.column), `column ${schema.name}.${s.column}`);
    const type = columnType(field);
    m.values.set(s.column, s.null
      ? (type === 'styled' ? StyledValue.sqlNull() : null)
      : convert(type, s.value, ex.db.zone, field));
  }
  // 받은 key를 쓰는 column이다: identity, 또는 markdown executor가 정하는 key(key_prefix)로 요청이 값을 주지
  // 않은 하나뿐인 primary key column이다.
  let assignedKey = schema.identity;
  if (assignedKey === '' && ex.db.md !== undefined && schema.primaryKey.length === 1 && key !== null && !c.sets.some(s => s.column === schema.primaryKey[0])) {
    assignedKey = present(schema.primaryKey[0], `the primary key of ${schema.name}`);
  }
  if (assignedKey !== '') {
    st.addName(assignedKey);
    m.values.set(assignedKey, key);
  }
  st.loaded = true;
  for (const pk of schema.primaryKey) {
    const v = m.values.get(pk);
    if (v === undefined || v === null || v === 0 || v === '') st.loaded = false;
    st.original.set(pk, v);
  }
  for (const name of c.news) m.setNew(name, c.newValues.get(name));
  c.sets = [];
  c.duplication = undefined;
  return asModel(m.self);
}

async function creates(c: Core, models: readonly Model[]): Promise<number> {
  const ex = terminal(c);
  if (models.length === 0) return 0;
  const first = present(models[0], 'the first model of creates')[CORE];
  if (first.sets.length === 0) throw configError('creates requires models with set<Col> values');
  const columns = first.sets.map(s => {
    if (s.plus || s.minus) throw configError('creates accepts stored values only');
    return s.column;
  });
  const schema = c.ent.entity;
  let total = 0;
  await inTransaction(c.conn, async () => {
    let start = 0;
    for (const part of insertParts(models.length, columns.length, ex.db.driver)) {
      const r = writeRequest(c, 'insert');
      const rows: number[][] = [];
      models.slice(start, start + part).forEach((model, i) => {
        const mc = model[CORE];
        if (mc.sets.length !== columns.length || mc.sets.some((s, j) => s.column !== columns[j] || s.plus || s.minus)) {
          throw configError('every model of creates must set the same columns in the same order');
        }
        const ps = mc.sets.map(s => param(r, s.null ? null : encodeValue(schema, s.column, s.value)));
        if (i === 0) r.ir.set = columns.map((column, j) => ({ column, p: present(ps[j], `the parameter of ${column}`) }));
        else rows.push(ps);
      });
      if (rows.length > 0) r.ir.rows = rows;
      const { affected } = await write(resolve(c.conn), finishWrite(r), r.params);
      total += affected;
      start += part;
    }
  });
  return total;
}

/**
 * The row counts of the parts a multi-row insert of rows rows with columns columns runs as, in row order
 * (docs/protocol.md "Relation steps"): each the largest power of two that is at most the rows left and at most
 * the bind-limit chunk, floor(bind limit / columns) and at least 1.
 */
export function insertParts(rows: number, columns: number, driver: string): number[] {
  const chunk = Math.max(1, Math.floor((driver === 'sqlite' ? 999 : 65535) / columns));
  const parts: number[] = [];
  for (let left = rows; left > 0;) {
    let part = 1;
    while (part * 2 <= Math.min(left, chunk)) part *= 2;
    parts.push(part);
    left -= part;
  }
  return parts;
}

function keyValues(c: Core, schema: Entity): Map<string, unknown> {
  const keys = new Map<string, unknown>();
  for (const pk of schema.primaryKey) {
    if (c.row?.loaded) { keys.set(pk, c.row.original.get(pk)); continue; }
    const s = c.sets.find(s => s.column === pk && !s.plus && !s.minus && !s.null);
    if (!s) throw configError(`${schema.name} requires a loaded row or set primary key ${pk}`);
    keys.set(pk, s.value);
  }
  return keys;
}

function keyWhere(r: WriteRequest, schema: Entity, keys: Map<string, unknown>): void {
  r.ir.where = { items: schema.primaryKey.map((pk, i) => ({ pred: { ...(i > 0 ? { conn: 'and' } : {}), column: pk, op: 'eq', p: param(r, keys.get(pk)) } })) };
}

/** Adds the other AES columns of a loaded row when one AES column changes. */
function withAesColumns(c: Core, schema: Entity): SetSpec[] {
  if (schema.aesVersion === '') return c.sets;
  const aes = (name: string) => (fieldOf(schema, name)?.stages ?? []).includes('aes');
  if (!c.sets.some(s => aes(s.column))) return c.sets;
  const out = [...c.sets];
  for (const { name } of schema.fields) {
    if (!aes(name) || c.sets.some(s => s.column === name)) continue;
    if (!c.row?.names.includes(name)) throw configError(`changing an AES column of ${schema.name} requires a row loaded with ${name}`);
    const v = c.values.get(name) ?? null;
    out.push(v === null ? { column: name, null: true } : { column: name, value: v });
  }
  return out;
}

async function update(c: Core, optimistic: boolean): Promise<void> {
  const ex = terminal(c);
  const schema = c.ent.entity;
  const r = writeRequest(c, 'update');
  const keys = keyValues(c, schema);
  const loaded = c.row?.loaded === true;
  const sets = withAesColumns(c, schema).filter(s => loaded || !schema.primaryKey.includes(s.column));
  if (sets.length === 0) return;
  r.ir.set = sets.map(s => assign(r, schema, s));
  keyWhere(r, schema, keys);
  const column = schema.updated;
  if (optimistic) {
    const version = loaded && column !== '' ? present(c.row, 'the loaded row of an update').original.get(column) : undefined;
    if (version === undefined || version === null) throw configError('update(true) requires a row loaded with its update time column');
    r.ir.optimistic = { column, p: param(r, version) };
  }
  await write(ex, finishWrite(r), r.params);
  if (loaded) {
    const loadedRow = present(c.row, 'the loaded row of an update');
    for (const s of c.sets) if (schema.primaryKey.includes(s.column) && !s.plus && !s.minus) loadedRow.original.set(s.column, s.value);
    loadedRow.original.delete(column);
  }
  c.sets = [];
}

async function save(c: Core): Promise<Model> {
  terminal(c);
  let known = true;
  try { keyValues(c, c.ent.entity); } catch { known = false; }
  if (known) {
    await update(c, false);
    return asModel(c.self);
  }
  return create(c);
}

async function deleteRow(c: Core, recursive: boolean): Promise<void> {
  terminal(c);
  if (recursive) return inTransaction(c.conn, () => deleteOne(c, true));
  return deleteOne(c, false);
}

async function deleteOne(c: Core, recursive: boolean): Promise<void> {
  const ex = terminal(c);
  if (recursive && c.row) {
    for (const [name, value] of c.row.related) {
      if (!c.row.cascade.get(name)) continue;
      if (value instanceof Collection) {
        for (const row of value.values()) if (row instanceof Model) await deleteOne(row[CORE], true);
      }
      else if (isModel(value)) await deleteOne(value[CORE], true);
    }
  }
  const schema = c.ent.entity;
  const r = writeRequest(c, 'delete');
  keyWhere(r, schema, keyValues(c, schema));
  await write(ex, finishWrite(r), r.params);
}

/**
 * soft delete 한 행을 되돌리고(soft delete column 을 NULL 로 쓰는 update) 그 행을 읽어 돌려준다. set 값을 restore request 의
 * set 으로 보내고, planner 가 request hook 뒤에 set 값과 where 의 eq 조건에서 key 를 고른다(docs/protocol.md 1.5): 그것들이
 * 덮으면 primary key, 아니면 이름 순서로 첫 unique key 다. key column 의 set 값은 조건이고 다른 set 값은 되돌리는 행에
 * update 처럼 함께 쓰는 새 값이다. audit table 의 update 는 다른 update 처럼 transaction 의 audit 기록 key 를 쓴다. 그 뒤
 * 그 key 의 값으로 행을 읽는다. 지워지지 않은 행은 아무것도 쓰지 않고 그대로 돌려주며, 없는 행은 NO_ROWS 다. 기본 read 는
 * 지운 행을 읽지 않는다.
 */
async function restore(c: Core): Promise<Model> {
  const ex = terminal(c);
  const schema = c.ent.entity;
  const r = newModel(c.ent).build('restore');
  if (r.error) throw r.error;
  const set = c.sets.map(s => assign(r, schema, s));
  if (set.length > 0) r.ir.set = set;
  // own 은 model 이 set 값마다 더한 parameter 의 그 set 값이다. hook 은 그 뒤에 parameter 를 더한다.
  const own = new Map<number, SetSpec>();
  set.forEach((a, i) => { if (a.p !== undefined) own.set(a.p, present(c.sets[i], `set value ${i}`)); });
  const written = await write(ex, r.finish(), r.params);
  // written 은 hook 이 남긴 request 이므로 그 key 는 planner 가 고른 key 다.
  const key = restoreKey(schema, written.request).key;
  const q = newModel(c.ent);
  q.conn = c.conn;
  q.whereChain('', key.map((column, i) => ({ conn: i > 0 ? 'and' : '', op: '', column, columns: [], compare: '' })), key.map(column => restoreKeyValue(own, written, column)));
  return asModel(q.self).get();
}

/**
 * hook 이 남긴 restore request 에서 key column 의 값이다. parameter 가 model 이 같은 column 에 더한 것인 set item 은 model
 * 자신의 set 값(read 가 다른 조건 값처럼 변환한다)을, 다른 set item 과 where 의 그 column eq 조건은 hook 이 남긴 parameter 를 쓴다.
 */
function restoreKeyValue(own: ReadonlyMap<number, SetSpec>, written: Written, column: string): unknown {
  const p = written.request.set?.find(a => a.column === column && a.p !== undefined)?.p;
  if (p !== undefined) {
    const s = own.get(p);
    return s !== undefined && s.column === column ? s.value : written.params[p];
  }
  for (const item of written.request.where?.items ?? []) {
    const p = item.pred;
    if (p !== undefined && p.column === column && p.op === 'eq' && p.p !== undefined && p.fn === undefined && p.value === undefined && p.ref === undefined && p.sub === undefined) return written.params[p.p];
  }
  throw new OrmError(codes.INTERNAL, `restore key column ${column} has no value in the request`);
}

/** The payload of a styled value, which is unknown until a codec reads it. */
function payloadOf(value: StyledValue<unknown>): unknown {
  return value.payload();
}

function arrayValue(value: unknown): unknown {
  if (value instanceof StyledValue) return value.kind === 'sql-null'
    ? { kind: 'sql-null' } : { kind: 'value', value: payloadOf(value) };
  if (value instanceof Date) return value.toISOString();
  if (isModel(value)) return toArray(value[CORE]);
  if (value instanceof Collection) return value.toArray();
  return value;
}

function pairs(c: Core): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  const seen = new Set<string>();
  const add = (name: string, value: unknown) => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push([name, value]);
  };
  const st = c.row ?? Object.assign(new RowState(), { names: c.sets.map(s => s.column) });
  for (const name of st.names) {
    if (st.hidden.has(name)) continue;
    add(name, c.values.has(name) ? c.values.get(name) : st.extra.get(name) ?? null);
  }
  for (const name of c.news) add(name, c.newValues.get(name));
  for (const [name, value] of st.related) add(name, value);
  for (const name of st.flat) {
    const value = st.related.get(name);
    if (isModel(value)) for (const [k, v] of pairs(value[CORE])) add(k, v);
  }
  return out;
}

function toArray(c: Core): Record<string, unknown> {
  return Object.fromEntries(pairs(c).map(([k, v]) => [k, temporalOutput(fieldOf(c.ent.entity, k)?.type ?? '', arrayValue(v))]));
}

/**
 * A time or datetime text of the array form has six fraction digits, zeros past the column precision: the
 * text the database gives has the column precision (docs/protocol.md section 5, Read).
 */
function temporalOutput(columnType: string, value: unknown): unknown {
  if (typeof value !== 'string' || (columnType !== 'time' && columnType !== 'datetime')) return value;
  const dot = value.indexOf('.');
  const digits = dot < 0 ? '' : value.slice(dot + 1);
  return `${dot < 0 ? value : value.slice(0, dot)}.${(digits + '000000').slice(0, 6)}`;
}

/**
 * The row values for JSON.stringify, in row order. JSON.stringify writes an
 * ordered-json value with its stored member order and number text; toJSONText
 * returns the same text.
 */
function toJson(c: Core): Record<string, unknown> {
  return Object.fromEntries(pairs(c).map(([k, v]) => [k, jsonValue(v)]));
}

/** The JSON text of a row value: an ordered-json value as its stored text. */
function jsonText(value: unknown): string {
  if (value instanceof StyledValue) return value.kind === 'sql-null'
    ? '{"kind":"sql-null"}' : `{"kind":"value","value":${jsonText(value.payload())}}`;
  if (value instanceof OrderedJsonValue) return orderedJsonStringify(value);
  if (isModel(value)) return rowText(value[CORE]);
  if (value instanceof Collection) return value.toJSONText();
  return JSON.stringify(arrayValue(value) ?? null);
}

/** The JSON text of a row, members in row order. */
function rowText(c: Core): string {
  return `{${pairs(c).map(([k, v]) => `${JSON.stringify(k)}:${jsonText(v)}`).join(',')}}`;
}

function jsonValue(value: unknown): unknown {
  if (value instanceof StyledValue) return value.kind === 'sql-null'
    ? { kind: 'sql-null' } : { kind: 'value', value: jsonValue(value.payload()) };
  if (value instanceof OrderedJsonValue) return orderedJsonOutput(value);
  if (isModel(value)) return toJson(value[CORE]);
  if (value instanceof Collection) return value.toJSON();
  return arrayValue(value);
}

/** Resolves a method named by the chain grammar. */
function resolveName(def: EntityDef, name: string): Resolved | undefined {
  const schema = def.entity;
  const set = def.model;
  const P = upperFirst(name);
  const attempt = (): Resolved => {
    for (const [prefix, kind] of [['GetsBy', 'all'], ['GetBy', 'one'], ['GetCountBy', 'count']] as const) {
      if (!P.startsWith(prefix)) continue;
      const keys = parseChain(set, schema, P.slice(prefix.length));
      if (kind === 'count') return function (...args) { return asModel(this[CORE].by(keys, args).self).getCount(); };
      if (kind === 'one') return function (...args) { return asModel(this[CORE].by(keys, args).self).get(); };
      return function (...args) { return asModel(this[CORE].by(keys, args).self).gets(); };
    }
    if (P.startsWith('OrderBy')) {
      const keys = parseOrder(schema, P.slice(7));
      return function () { for (const k of keys) this[CORE].order.push({ column: k.column, desc: k.desc }); return this; };
    }
    for (const [prefix, kind] of [['LeftJoin', 'left'], ['Join', 'inner']] as const) {
      if (!P.startsWith(prefix)) continue;
      const rest = P.slice(prefix.length);
      return function (child) {
        if (!isModel(child)) throw configError(`${name} takes the joined model`);
        const [left, right] = splitPair(set, schema, child[CORE].ent.entity, rest);
        this[CORE].join(kind, left, right, child);
        return this;
      };
    }
    if (P.startsWith('Match') && P.length > 5) {
      const [left, right] = splitPair(set, undefined, schema, P.slice(5));
      return function () { this[CORE].matches.push({ left, right }); return this; };
    }
    if (P.startsWith('Alias') && P.length > 5) {
      const alias = snake(P.slice(5));
      return function () { this[CORE].alias = alias; return this; };
    }
    if (P.startsWith('Possible') && P.length > 8) {
      const column = columnName(set, undefined, P.slice(8));
      if (column === '') throw configError(`${name}: no model has the column ${P.slice(8)}`);
      return function (value) { this[CORE].possible = { column, value }; return this; };
    }
    if (P.startsWith('New') && P.length > 3) {
      if (columnName(set, schema, P.slice(3)) !== '') throw configError(`${name}: ${P.slice(3)} is a column; use set${P.slice(3)}`);
      const key = snake(P.slice(3));
      return function (value) { this[CORE].setNew(key, value); return this; };
    }
    if (P.startsWith('AddColumn') && P.length > 9) {
      const rest = P.slice(9);
      const at = rest.indexOf('Alias');
      if (at > 0) {
        const column = columnName(set, schema, rest.slice(0, at));
        if (column !== '' && rest.length > at + 5) {
          const key = outputName(set, schema, rest.slice(at + 5));
          return function (fn) { this[CORE].addColumnFunc(column, key, fn); return this; };
        }
      }
      const key = outputName(set, schema, rest);
      return function (fn) {
        if (typeof fn !== 'function') throw configError(`${name} takes a callback`);
        this[CORE].addColumnSub(key, m => {
          const out: unknown = Reflect.apply(fn, undefined, [m]);
          if (!isModel(out)) throw configError(`the callback of ${name} returns no model`);
          return out;
        });
        return this;
      };
    }
    if (P.startsWith('Get') && P.length > 3) {
      const key = snake(P.slice(3));
      return function () {
        const c = this[CORE];
        return c.row?.related.has(key) ? c.row.related.get(key) : c.newValue(key);
      };
    }
    let conn = '';
    let chain = P;
    if (/^And[A-Z]/.test(P)) { conn = 'and'; chain = P.slice(3); }
    else if (/^Or[A-Z]/.test(P)) { conn = 'or'; chain = P.slice(2); }
    const keys = parseChain(set, schema, chain);
    return function (...args) { this[CORE].whereChain(conn, keys, args); return this; };
  };
  try {
    return attempt();
  } catch (error) {
    return function () { throw error instanceof OrmError ? new OrmError(error.code, `${schema.name}.${name}: ${error.message.replace(/^[A-Z_]+: /, '')}`) : error; };
  }
}

function outputName(set: RuntimeModel, schema: Entity, name: string): string {
  if (columnName(set, schema, name) !== '') throw configError(`${name} is a column name`);
  return snake(name);
}

