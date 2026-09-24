import { CORE, Core, RowState, configError, isModel, type EntityDef, type ModelLike, type SetSpec } from './core.js';
import { encode, parsePoint, type CodecValue } from './codec.js';
import { Db, keyOfValues, keyText, keyValue, normalizeTime, paginate, query, resolve, rowKey, scalar, scalarKey, statement, write, type Executor, type Key, type Result } from './database.js';
import type { Assemble, Request } from './ir.js';
import { columnName, parseChain, parseOrder, snake, splitPair, upperFirst, type ChainKey, type ColumnSchema, type EntitySchema, type SchemaSet } from './names.js';
import { OrmError } from './runtime_error.js';

export { CORE } from './core.js';

/** A generated model class. */
export interface ModelClass<T extends Model = Model> {
  new (core?: Core): T;
  readonly entity: EntityDef;
}

type Resolved = (this: Model, ...args: unknown[]) => unknown;

const protocolNames = new Set(['then', 'catch', 'finally', 'toJSON', 'constructor', 'inspect', 'nodeType', 'asymmetricMatch', '$$typeof', 'toString', 'valueOf', 'length', 'prototype']);
const resolvers = new WeakMap<object, Map<string, Resolved | undefined>>();

const handler: ProxyHandler<Model> = {
  get(target, prop, receiver) {
    if (typeof prop !== 'string' || prop in target) return Reflect.get(target, prop, receiver);
    const ctor = target.constructor as ModelClass;
    let cache = resolvers.get(ctor);
    if (cache === undefined) { cache = new Map(); resolvers.set(ctor, cache); }
    if (!cache.has(prop)) cache.set(prop, protocolNames.has(prop) ? undefined : resolveName(ctor.entity, prop));
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
    const def = (new.target as unknown as ModelClass).entity;
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
  public raw(sql: string, ...binds: unknown[]): this { this[CORE].raw('', sql, binds); return this; }
  public andRaw(sql: string, ...binds: unknown[]): this { this[CORE].raw('and', sql, binds); return this; }
  public orRaw(sql: string, ...binds: unknown[]): this { this[CORE].raw('or', sql, binds); return this; }
  /** Sets the join ON conditions. */
  public on(fn: (q: this) => unknown): this { this[CORE].setOn(fn as (m: ModelLike) => unknown); return this; }
  public relation(child: Model): this { this[CORE].relation(false, child); return this; }
  public relations(child: Model): this { this[CORE].relation(true, child); return this; }
  public limit(offset: number, count: number): this { this[CORE].setLimit(offset, count); return this; }
  public orderByRandom(): this { this[CORE].order.push({ random: true }); return this; }
  public orderByRaw(sql: string): this { this[CORE].order.push({ raw: sql }); return this; }
  public groupByRaw(sql: string): this { this[CORE].groupRaw.push(sql); return this; }
  public removeAllColumns(): this { this[CORE].columns.mode = 'none'; return this; }
  public addAllColumns(): this { this[CORE].columns.mode = 'all'; return this; }
  public parentNode(): this { this[CORE].parentNode = true; return this; }
  public groupLimit(n: number): this { this[CORE].setGroupLimit(n); return this; }
  public deleteLock(): this { this[CORE].deleteLock = true; return this; }
  public fetchKey(fn: (row: this) => Key): this { this[CORE].fetchKey = fn as (m: ModelLike) => unknown; return this; }
  public fetchValue(fn: (row: this) => unknown): this { this[CORE].fetchValue = fn as (m: ModelLike) => unknown; return this; }
  public forUpdate(): this { this[CORE].lock = 'update'; return this; }
  public forShare(): this { this[CORE].lock = 'share'; return this; }
  public forUpdateNoWait(): this { this[CORE].lock = 'update_nowait'; return this; }
  public forShareNoWait(): this { this[CORE].lock = 'share_nowait'; return this; }
  public duplication(model: this): this { this[CORE].setDuplication(model); return this; }

  /** Returns the first matching row; NO_ROWS when no row matches. */
  public async get(): Promise<this> {
    const rows = await load(this[CORE], 'one');
    const row = rows.first() as this | undefined;
    if (row === undefined) throw new OrmError('NO_ROWS', 'query matched no rows');
    return row;
  }
  /** Returns the matching rows. */
  public async gets(): Promise<Collection<this>> { return load(this[CORE], 'all') as Promise<Collection<this>>; }
  /** Returns grouped rows with row_count. */
  public async getsCount(): Promise<Collection<this>> { return load(this[CORE], 'group_count') as Promise<Collection<this>>; }
  public async getCount(): Promise<number> { return Number(await scalarOf(this[CORE], 'count')); }
  public async getSum(): Promise<number> { return aggregate(this[CORE], 'sum'); }
  public async getAvg(): Promise<number> { return aggregate(this[CORE], 'avg'); }
  /** Returns one page of matching rows. */
  public async getsPage(page: number, perPage: number): Promise<Page<this>> { return pageOf(this[CORE], page, perPage) as Promise<Page<this>>; }
  /** Returns the statement of gets() without executing it. */
  public async getQuery(): Promise<{ sql: string; binds: unknown[] }> {
    const c = this[CORE];
    const ex = terminal(c);
    const r = c.build('all');
    if (r.error) throw r.error;
    return statement(ex, r.finish(), r.params);
  }
  /** Inserts the row and returns the created row. */
  public async create(): Promise<this> { return create(this[CORE]) as Promise<this>; }
  /** Inserts rows in one transaction and returns the inserted row count. */
  public async creates(rows: readonly this[]): Promise<number> { return creates(this[CORE], rows); }
  /** Writes the changed columns; update(true) requires an unchanged update time. */
  public async update(optimistic = false): Promise<this> { await update(this[CORE], optimistic); return this; }
  /** Updates the row when its primary key is known, otherwise creates it. */
  public async save(): Promise<this> { return save(this[CORE]) as Promise<this>; }
  /** Deletes the row; delete(true) first deletes loaded related rows. */
  public async delete(recursive = false): Promise<void> { await deleteRow(this[CORE], recursive); }

  public toArray(): Record<string, unknown> { return toArray(this[CORE]); }
  public toJSON(): Record<string, unknown> { return toArray(this[CORE]); }
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
  public toJSON(): Array<Record<string, unknown>> { return this.toArray(); }
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

function convert(type: string, value: unknown, zone: string): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'i32': case 'i64': case 'f64': case 'decimal':
      return typeof value === 'number' ? value : Number(value);
    case 'bool':
      return value === true || value === 1 || value === 1n || value === '1' || value === 't' || value === 'true';
    case 'date': case 'datetime':
      return normalizeTime(value, zone);
    case 'bytes':
      return value instanceof Uint8Array ? value : new Uint8Array(Buffer.from(String(value)));
    case 'point':
      return parsePoint(value as string);
    case 'string': case 'text': case 'enum': case 'inet': case 'time': case 'uuid':
      return value instanceof Uint8Array ? Buffer.from(value).toString() : String(value);
  }
  return value;
}

function columnType(col: ColumnSchema): string {
  return (col.styles ?? []).some(s => s !== 'aes' && s !== 'hex' && s !== 'ip') ? 'styled' : col.type;
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
    const schema = b.ent.schema;
    for (const col of asm.columns) {
      if (col.hidden) st.hidden.add(col.name);
      st.addName(col.name);
      const declared = col.column !== '' && col.column === col.name ? schema.columns[col.name] : undefined;
      if (declared) m.values.set(col.name, convert(columnType(declared), row[col.index], this.db.zone));
      else st.extra.set(col.name, col.type === 'date' || col.type === 'datetime' ? convert(col.type, row[col.index], this.db.zone) : row[col.index]);
    }
    for (const key of asm.key) {
      const name = asm.columns.find(col => col.index === key.index)!.name;
      st.original.set(name, m.values.get(name));
    }
    if (schema.updated && st.names.includes(schema.updated)) st.original.set(schema.updated, m.values.get(schema.updated));
    for (const name of b.news) m.setNew(name, b.newValues.get(name));
    for (const ch of asm.children) {
      if (ch.kind === 'join') {
        const child = joinChild(b, ch.rel);
        const first = ch.assemble!.columns[0];
        const value = first !== undefined && row[first.index] !== null ? this.model(child, ch.assemble!, row).self : null;
        st.setRelated(ch.rel, value, false, false);
        continue;
      }
      const [child, many] = relationChild(b, ch.rel);
      const step = this.result.steps.get(ch.step);
      const childAsm = step!.step.assemble!;
      const rows = this.related(ch, row);
      if (many) {
        const coll = new Collection();
        for (const cr of rows) {
          const cm = this.model(child, childAsm, cr);
          coll.put(collectionKey(child, cm, childAsm, cr), cm.self as Model);
        }
        st.setRelated(ch.rel, coll, ch.cascade, false);
      } else {
        const value = rows.length > 0 ? this.model(child, childAsm, rows[0]!).self : null;
        st.setRelated(ch.rel, value, ch.cascade, ch.flatten);
      }
    }
    const list = this.made.get(b) ?? [];
    list.push(m);
    this.made.set(b, list);
    return m;
  }

  private related(ch: Assemble['children'][number], parent: readonly unknown[]): unknown[][] {
    const sr = this.result.steps.get(ch.step);
    if (!sr) return [];
    const ifp = sr.step.parent?.if_parent;
    if (ifp && scalarKey(parent[ifp.index]) !== scalarKey(this.result.params[ifp.param])) return [];
    const key = rowKey(parent, ch.parent_keys);
    if (key === undefined) return [];
    return (sr.byKey.get(key) ?? []).map(i => sr.data[i]!);
  }
}

function joinChild(c: Core, name: string): Core {
  const j = c.joins.find(j => j.child.resultName(false) === name);
  if (!j) throw new OrmError('INTERNAL', `join result ${name} without a model`);
  return j.child;
}

function relationChild(c: Core, name: string): [Core, boolean] {
  const r = c.relations.find(r => r.child.resultName(r.many) === name);
  if (!r) throw new OrmError('INTERNAL', `relation result ${name} without a model`);
  return [r.child, r.many];
}

function valueOf(m: Core, name: string): unknown {
  if (m.values.has(name)) return m.values.get(name);
  return m.row?.extra.get(name) ?? null;
}

function collectionKey(c: Core, m: Core, asm: Assemble, row: readonly unknown[]): Key {
  if (c.fetchKey) return keyValue(c.fetchKey(m.self));
  if (c.keyName !== '') return keyValue(valueOf(m, c.keyName));
  if (asm.key.length === 1) return keyValue(m.values.get(asm.columns.find(col => col.index === asm.key[0]!.index)!.name) ?? row[asm.key[0]!.index]);
  return rowKey(row, asm.key) ?? '';
}

async function load(c: Core, kind: 'one' | 'all' | 'group_count'): Promise<Collection> {
  const ex = terminal(c);
  const r = c.build(kind);
  if (r.error) throw r.error;
  const result = await query(ex, r.finish(), r.params);
  return assemble(c, ex, r.external, result);
}

async function assemble(c: Core, ex: Executor, external: Map<Core, Array<{ many: boolean; child: Core }>>, result: Result): Promise<Collection> {
  const a = new Assembler(result, ex.db, c.conn);
  const asm = result.plan.steps[0]!.assemble!;
  const out = new Collection();
  for (const row of result.main) {
    const m = a.model(c, asm, row);
    out.put(collectionKey(c, m, asm, row), m.self as Model);
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

async function attachExternal(parents: Core[], rel: { many: boolean; child: Core }): Promise<void> {
  const ch = rel.child;
  const possible = (p: Core) => ch.possible === undefined || scalarKey(valueOf(p, ch.possible.column)) === scalarKey(ch.possible.value);
  const values: unknown[] = [];
  const seen = new Set<string>();
  for (const p of parents) {
    if (!possible(p)) continue;
    const v = valueOf(p, ch.matchLeft);
    if (v === null || seen.has(keyText(v))) continue;
    seen.add(keyText(v));
    values.push(v);
  }
  const byKey = new Map<string, Array<[Key, Core]>>();
  if (values.length > 0) {
    const q = ch.clone();
    q.matchLeft = '';
    q.alias = '';
    const keys: ChainKey[] = [{ conn: '', op: '', column: ch.matchRight, columns: [], compare: '' }];
    const rows = await load(q.by(keys, [values]), 'all');
    for (const [key, row] of rows.entries()) {
      const k = keyText(valueOf(row[CORE], ch.matchRight));
      const list = byKey.get(k) ?? [];
      if (ch.groupLimit > 0 && list.length >= ch.groupLimit) continue;
      list.push([key, row[CORE]]);
      byKey.set(k, list);
    }
  }
  const name = ch.resultName(rel.many);
  for (const p of parents) {
    if (p.row!.related.has(name)) throw configError(`relation result name ${name} is used twice`);
    const matched = possible(p) ? byKey.get(keyText(valueOf(p, ch.matchLeft))) ?? [] : [];
    if (rel.many) {
      const coll = new Collection();
      for (const [key, m] of matched) coll.put(key, m.self as Model);
      p.row!.setRelated(name, coll, !ch.deleteLock, false);
    } else {
      p.row!.setRelated(name, matched.length > 0 ? matched[0]![1].self : null, !ch.deleteLock, ch.parentNode);
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
  return value === null ? 0 : Number(value);
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

export async function inTransaction(conn: Db | undefined, fn: () => Promise<void>): Promise<void> {
  if (conn === undefined) {
    resolve(undefined);
    return fn();
  }
  return conn.transaction(fn, { retry: 0 });
}

interface WriteRequest { ir: Request; params: unknown[]; }

function writeRequest(c: Core, kind: 'insert' | 'update' | 'delete'): WriteRequest {
  return { ir: { ir_version: 1, schema_hash: c.ent.set.hash, kind, entity: c.ent.schema.name, n_params: 0 }, params: [] };
}

function param(r: WriteRequest, value: unknown): number {
  r.params.push(value);
  return r.params.length - 1;
}

function encodeValue(schema: EntitySchema, column: string, value: unknown): unknown {
  const col = schema.columns[column];
  if (col === undefined) throw new OrmError('COLUMN_UNKNOWN', `${schema.name}.${column}`);
  const codec = (col.styles ?? []).filter(s => s !== 'aes' && s !== 'hex' && s !== 'ip');
  if (codec.length === 0 || value === null) return value;
  return encode(codec, value as CodecValue);
}

function assign(r: WriteRequest, schema: EntitySchema, s: SetSpec): NonNullable<Request['set']>[number] {
  if (s.null) return { column: s.column, null: true };
  if (s.raw) {
    const count = s.raw.sql.split('?').length - 1;
    if (count !== s.raw.binds.length) throw new OrmError('IR_INVALID', `raw SQL has ${count} placeholders and ${s.raw.binds.length} binds`);
    const out: NonNullable<Request['set']>[number] = { column: s.column, expr: s.raw.sql };
    if (s.raw.binds.length > 0) out.ps = s.raw.binds.map(b => param(r, b));
    return out;
  }
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
  const schema = c.ent.schema;
  const r = writeRequest(c, 'insert');
  r.ir.set = c.sets.map(s => assign(r, schema, s));
  if (c.duplication) {
    r.ir.on_duplicate = c.duplication.sets.map(s => assign(r, schema, s));
    if (r.ir.on_duplicate.length === 0) throw configError('duplication model has no set<Col> values');
  }
  const { id } = await write(ex, finishWrite(r), r.params);
  const m = newModel(c.ent);
  m.conn = c.conn;
  const st = new RowState();
  m.row = st;
  for (const s of c.sets) {
    st.addName(s.column);
    if (s.plus || s.minus || s.raw) continue;
    m.values.set(s.column, s.null ? null : convert(columnType(schema.columns[s.column]!), s.value, ex.db.zone));
  }
  if (schema.auto) {
    st.addName(schema.auto);
    m.values.set(schema.auto, id);
  }
  st.loaded = true;
  for (const pk of schema.pk) {
    const v = m.values.get(pk);
    if (v === undefined || v === null || v === 0 || v === '') st.loaded = false;
    st.original.set(pk, v);
  }
  for (const name of c.news) m.setNew(name, c.newValues.get(name));
  c.sets = [];
  c.duplication = undefined;
  return m.self as Model;
}

async function creates(c: Core, models: readonly Model[]): Promise<number> {
  const ex = terminal(c);
  if (models.length === 0) return 0;
  const first = models[0]![CORE];
  if (first.sets.length === 0) throw configError('creates requires models with set<Col> values');
  const columns = first.sets.map(s => {
    if (s.raw || s.plus || s.minus) throw configError('creates accepts stored values only');
    return s.column;
  });
  const schema = c.ent.schema;
  const per = Math.floor((ex.db.driver === 'sqlite' ? 999 : 65535) / columns.length);
  let total = 0;
  await inTransaction(c.conn, async () => {
    for (let start = 0; start < models.length; start += per) {
      const r = writeRequest(c, 'insert');
      const rows: number[][] = [];
      models.slice(start, start + per).forEach((model, i) => {
        const mc = model[CORE];
        if (mc.sets.length !== columns.length || mc.sets.some((s, j) => s.column !== columns[j] || s.raw || s.plus || s.minus)) {
          throw configError('every model of creates must set the same columns in the same order');
        }
        const ps = mc.sets.map(s => param(r, s.null ? null : encodeValue(schema, s.column, s.value)));
        if (i === 0) r.ir.set = columns.map((column, j) => ({ column, p: ps[j]! }));
        else rows.push(ps);
      });
      if (rows.length > 0) r.ir.rows = rows;
      const { affected } = await write(resolve(c.conn), finishWrite(r), r.params);
      total += affected;
    }
  });
  return total;
}

function keyValues(c: Core, schema: EntitySchema): Map<string, unknown> {
  const keys = new Map<string, unknown>();
  for (const pk of schema.pk) {
    if (c.row?.loaded) { keys.set(pk, c.row.original.get(pk)); continue; }
    const s = c.sets.find(s => s.column === pk && !s.plus && !s.minus && !s.raw && !s.null);
    if (!s) throw configError(`${schema.name} requires a loaded row or set primary key ${pk}`);
    keys.set(pk, s.value);
  }
  return keys;
}

function keyWhere(r: WriteRequest, schema: EntitySchema, keys: Map<string, unknown>): void {
  r.ir.where = { items: schema.pk.map((pk, i) => ({ pred: { ...(i > 0 ? { conn: 'and' } : {}), column: pk, op: 'eq', p: param(r, keys.get(pk)) } })) };
}

/** Adds the other AES columns of a loaded row when one AES column changes. */
function withAesColumns(c: Core, schema: EntitySchema): SetSpec[] {
  if (!schema.aesVersion) return c.sets;
  const aes = (name: string) => (schema.columns[name]?.styles ?? []).includes('aes');
  if (!c.sets.some(s => aes(s.column))) return c.sets;
  const out = [...c.sets];
  for (const name of Object.keys(schema.columns)) {
    if (!aes(name) || c.sets.some(s => s.column === name)) continue;
    if (!c.row?.names.includes(name)) throw configError(`changing an AES column of ${schema.name} requires a row loaded with ${name}`);
    const v = c.values.get(name) ?? null;
    out.push(v === null ? { column: name, null: true } : { column: name, value: v });
  }
  return out;
}

async function update(c: Core, optimistic: boolean): Promise<void> {
  const ex = terminal(c);
  const schema = c.ent.schema;
  const r = writeRequest(c, 'update');
  const keys = keyValues(c, schema);
  const loaded = c.row?.loaded === true;
  const sets = withAesColumns(c, schema).filter(s => loaded || !schema.pk.includes(s.column));
  if (sets.length === 0) return;
  r.ir.set = sets.map(s => assign(r, schema, s));
  keyWhere(r, schema, keys);
  const column = schema.updated ?? '';
  if (optimistic) {
    const version = loaded && column !== '' ? c.row!.original.get(column) : undefined;
    if (version === undefined || version === null) throw configError('update(true) requires a row loaded with its update time column');
    r.ir.optimistic = { column, p: param(r, version) };
  }
  await write(ex, finishWrite(r), r.params);
  if (loaded) {
    for (const s of c.sets) if (schema.pk.includes(s.column) && !s.plus && !s.minus && !s.raw) c.row!.original.set(s.column, s.value);
    c.row!.original.delete(column);
  }
  c.sets = [];
}

async function save(c: Core): Promise<Model> {
  terminal(c);
  let known = true;
  try { keyValues(c, c.ent.schema); } catch { known = false; }
  if (known) {
    await update(c, false);
    return c.self as Model;
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
      if (value instanceof Collection) for (const row of value.values()) await deleteOne(row[CORE], true);
      else if (isModel(value)) await deleteOne(value[CORE], true);
    }
  }
  const schema = c.ent.schema;
  const r = writeRequest(c, 'delete');
  keyWhere(r, schema, keyValues(c, schema));
  await write(ex, finishWrite(r), r.params);
}

function arrayValue(value: unknown): unknown {
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

export function toArray(c: Core): Record<string, unknown> {
  return Object.fromEntries(pairs(c).map(([k, v]) => [k, arrayValue(v)]));
}

/** Resolves a method named by the chain grammar. */
function resolveName(def: EntityDef, name: string): Resolved | undefined {
  const schema = def.schema;
  const set = def.set;
  const P = upperFirst(name);
  const attempt = (): Resolved => {
    for (const [prefix, kind] of [['GetsBy', 'all'], ['GetBy', 'one'], ['GetCountBy', 'count']] as const) {
      if (!P.startsWith(prefix)) continue;
      const keys = parseChain(set, schema, P.slice(prefix.length));
      if (kind === 'count') return function (...args) { return (this[CORE].by(keys, args).self as Model).getCount(); };
      if (kind === 'one') return function (...args) { return (this[CORE].by(keys, args).self as Model).get(); };
      return function (...args) { return (this[CORE].by(keys, args).self as Model).gets(); };
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
        const [left, right] = splitPair(set, schema, child[CORE].ent.schema, rest);
        this[CORE].join(kind, left, right, child);
        return this;
      };
    }
    if (P.startsWith('Match') && P.length > 5) {
      const [left, right] = splitPair(set, undefined, schema, P.slice(5));
      return function () { this[CORE].matchLeft = left; this[CORE].matchRight = right; return this; };
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
    if (P.startsWith('AddRawColumn') && P.length > 12) {
      const key = outputName(set, schema, P.slice(12));
      return function (sql, ...binds) { this[CORE].addRawColumn(key, sql as string, binds); return this; };
    }
    if (P.startsWith('AddColumn') && P.length > 9) {
      const rest = P.slice(9);
      const at = rest.indexOf('Alias');
      if (at > 0) {
        const column = columnName(set, schema, rest.slice(0, at));
        if (column !== '' && rest.length > at + 5) {
          const key = outputName(set, schema, rest.slice(at + 5));
          return function (format) { this[CORE].addColumnFormat(column, key, format); return this; };
        }
      }
      const key = outputName(set, schema, rest);
      return function (fn) { this[CORE].addColumnSub(key, fn as (m: ModelLike) => ModelLike); return this; };
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

function outputName(set: SchemaSet, schema: EntitySchema, name: string): string {
  if (columnName(set, schema, name) !== '') throw configError(`${name} is a column name`);
  return snake(name);
}

export { keyOfValues };
