import type { Db } from './database.js';
import type { ColumnFunction as IRColumnFunction, Expression, Group, Item, Limit, Order, Predicate, Relation, Request, RequestQuery, Subquery, Join, QueryKind } from './ir.js';
import type { ChainKey, EntitySchema, SchemaSet } from './names.js';
import { OrmError } from './runtime_error.js';
import { ColumnFunction, ValueFunction } from './values.js';

export const CORE: unique symbol = Symbol('orm.core');

/** Implemented by every model; the symbol key never collides with a generated method. */
export interface ModelLike { readonly [CORE]: Core; }

export interface EntityDef {
  readonly schema: EntitySchema;
  readonly set: SchemaSet;
  create(core: Core): ModelLike;
}

type Fn = ValueFunction | ColumnFunction;

interface PredSpec {
  column: string;
  op: string;
  value?: unknown;
  fn?: Fn;
  cols?: string[];
  ref?: Core;
  refCol?: string;
  sub?: Core;
  kind: 'value' | 'list' | 'null' | 'between' | 'tuple' | 'fulltext' | 'ref' | 'sub' | 'column_fn' | 'value_fn';
}

interface RawSpec { sql: string; binds: readonly unknown[]; }

interface CondNode {
  conn: string;
  pred?: PredSpec;
  group?: CondGroup;
  joined?: Core;
  raw?: RawSpec;
}

class CondGroup {
  public items: CondNode[] = [];
  public pending = '';
  public constructor(items: CondNode[] = []) { this.items = items; }

  public add(owner: Core, conn: string, node: Omit<CondNode, 'conn'>): void {
    if (this.pending !== '' && conn !== '') return owner.fail(`connector ${conn} follows connector ${this.pending}`);
    if (this.pending !== '') { conn = this.pending; this.pending = ''; }
    // A connector at the start has nothing to join, so it is dropped: the
    // first condition or group carries no AND or OR.
    if (this.items.length === 0) conn = '';
    if (this.items.length > 0 && conn === '') return owner.fail('condition without and/or after another condition');
    this.items.push({ ...node, conn });
  }
}

interface JoinSpec { kind: 'inner' | 'left'; left: string; right: string; child: Core; }
interface RelSpec { many: boolean; child: Core; }
interface FormatSpec { column: string; format?: string; fn?: ColumnFunction; }
interface OrderSpec { column?: string; desc?: boolean; fn?: ColumnFunction; random?: boolean; raw?: string; }
export interface SetSpec { column: string; value?: unknown; null?: boolean; raw?: RawSpec; plus?: boolean; minus?: boolean; }

class Columns {
  public mode: '' | 'all' | 'none' = '';
  public add: string[] = [];
  public remove: string[] = [];
  public formats = new Map<string, FormatSpec>();
  public funcs = new Map<string, FormatSpec>();
  public subs = new Map<string, (m: ModelLike) => ModelLike>();
  public raws = new Map<string, RawSpec>();
  public order: string[] = [];
  public clone(): Columns {
    const out = new Columns();
    out.mode = this.mode;
    out.add = [...this.add];
    out.remove = [...this.remove];
    out.formats = new Map(this.formats);
    out.funcs = new Map(this.funcs);
    out.subs = new Map(this.subs);
    out.raws = new Map(this.raws);
    out.order = [...this.order];
    return out;
  }
}

/** Row state of a loaded or created model. */
export class RowState {
  public loaded = false;
  public names: string[] = [];
  public hidden = new Set<string>();
  public original = new Map<string, unknown>();
  public extra = new Map<string, unknown>();
  public related = new Map<string, unknown>();
  public cascade = new Map<string, boolean>();
  public flat: string[] = [];
  public addName(name: string): void { if (!this.names.includes(name)) this.names.push(name); }
  public setRelated(name: string, value: unknown, cascade: boolean, flat: boolean): void {
    this.related.set(name, value);
    this.cascade.set(name, cascade);
    if (flat) this.flat.push(name);
  }
}

const operators: Record<string, string> = { '': 'eq', ne: 'not_eq', gt: 'gt', lt: 'lt', ge: 'gte', le: 'lte', lk: 'contains', lb: 'contains_binary' };

export function configError(message: string): OrmError { return new OrmError('CONFIG', message); }

export function isModel(value: unknown): value is ModelLike {
  return typeof value === 'object' && value !== null && CORE in value;
}

/** The query under construction and, for a loaded row, the row state. */
export class Core {
  public self!: ModelLike;
  public conn: Db | undefined;
  public error: OrmError | undefined;
  public group = false;
  public target: Core | undefined;

  public where = new CondGroup();
  public on: CondGroup | undefined;
  public joins: JoinSpec[] = [];
  public relations: RelSpec[] = [];
  public columns = new Columns();
  public order: OrderSpec[] = [];
  public groupBy: string[] = [];
  public groupRaw: string[] = [];
  public limit: Limit | undefined;
  public index = '';
  public lock = '';
  public agg = '';
  public aggFn = '';

  public matchLeft = '';
  public matchRight = '';
  public alias = '';
  public parentNode = false;
  public possible: { column: string; value: unknown } | undefined;
  public groupLimit = 0;
  public deleteLock = false;
  public keyName = '';
  public fetchKey: ((m: ModelLike) => unknown) | undefined;
  public fetchValue: ((m: ModelLike) => unknown) | undefined;

  public sets: SetSpec[] = [];
  public news: string[] = [];
  public newValues = new Map<string, unknown>();
  public duplication: Core | undefined;

  public values = new Map<string, unknown>();
  public row: RowState | undefined;

  public constructor(public readonly ent: EntityDef) {}

  public fail(message: string): void { if (this.error === undefined) this.error = configError(message); }
  public failError(error: unknown): void {
    if (this.error !== undefined) return;
    this.error = error instanceof OrmError ? error : configError(String(error));
  }

  public subject(): Core {
    let c: Core = this;
    while (c.target !== undefined) c = c.target;
    return c;
  }

  public connect(db: unknown): void {
    if (this.group) return this.fail('connect is not allowed inside a group callback');
    if (db === undefined || db === null) return this.fail('connect requires a database');
    this.conn = db as Db;
  }

  public newGroup(): Core {
    const g = new Core(this.ent);
    g.group = true;
    g.target = this;
    return g;
  }

  public connector(conn: string, args: readonly unknown[]): void {
    const g = this.where;
    if (args.length === 0) {
      if (g.pending !== '') return this.fail(`connector ${conn} follows connector ${g.pending}`);
      g.pending = conn;
      return;
    }
    if (args.length > 1) return this.fail(`${conn} accepts at most one argument`);
    const value = args[0];
    if (typeof value === 'function') {
      const group = this.newGroup();
      const model = this.ent.create(group);
      (value as (m: ModelLike) => unknown)(model);
      this.addGroup(conn, group);
      return;
    }
    if (!isModel(value)) return this.fail(`${conn} accepts a callback of the same model or a joined model`);
    const child = value[CORE];
    if (child === this.subject()) return this.fail(`${conn} cannot place the model inside itself`);
    g.add(this, conn, { joined: child });
  }

  private addGroup(conn: string, g: Core): void {
    if (g.error) return this.failError(g.error);
    if (g.where.items.length === 0) return this.fail(`${conn} group callback added no condition`);
    if (g.where.pending !== '') return this.fail(`connector ${g.where.pending} without a following condition`);
    this.where.add(this, conn, { group: new CondGroup(g.where.items) });
  }

  public setOn(fn: (m: ModelLike) => unknown): void {
    if (this.group) return this.fail('on is not allowed inside a group callback');
    const g = this.newGroup();
    fn(this.ent.create(g));
    if (g.error) return this.failError(g.error);
    if (g.where.pending !== '') return this.fail(`connector ${g.where.pending} without a following condition`);
    if (g.where.items.length === 0) return this.fail('on callback added no condition');
    this.on = new CondGroup(g.where.items);
  }

  public raw(conn: string, sql: string, binds: readonly unknown[]): void {
    this.where.add(this, conn, { raw: { sql, binds } });
  }

  /** Appends the conditions of a chain; a column function takes the compared value as the next argument. */
  public whereChain(conn: string, keys: readonly ChainKey[], args: readonly unknown[]): void {
    let i = 0;
    for (const [k, key] of keys.entries()) {
      if (i >= args.length) return this.fail(`the condition expects ${keys.length} values`);
      const value = args[i++];
      let pred: PredSpec;
      let extra: number;
      try { [pred, extra] = this.predicate(key, value, args.slice(i), keys.length === 1); }
      catch (error) { return this.failError(error); }
      i += extra;
      this.where.add(this, k === 0 ? conn : key.conn, { pred });
    }
    if (i !== args.length) this.fail(`the condition expects ${keys.length} values, got ${args.length}`);
  }

  private predicate(key: ChainKey, value: unknown, rest: readonly unknown[], single: boolean): [PredSpec, number] {
    const p = (fields: Omit<PredSpec, 'column'>): PredSpec => ({ column: key.column, ...fields });
    switch (key.op) {
      case 'fulltext': case 'fulltext_boolean':
        if (typeof value !== 'string') throw configError(`full-text value must be a string`);
        return [p({ kind: 'fulltext', op: key.op === 'fulltext' ? 'match' : 'match_boolean', cols: key.columns, value }), 0];
      case 'tuple': case 'ne_tuple': {
        if (!Array.isArray(value)) throw configError('tuple values must be a list');
        if (value.length === 0) throw new OrmError('EMPTY_IN', 'tuple condition received an empty list');
        const rows = value.map(row => {
          if (!Array.isArray(row) || row.length !== key.columns.length) throw configError('tuple values must be value groups of the tuple columns');
          return row;
        });
        return [p({ kind: 'tuple', op: key.op === 'tuple' ? 'tuple_in' : 'tuple_not_in', cols: key.columns, value: rows }), 0];
      }
      case 'between':
        if (!Array.isArray(value) || value.length !== 2) throw configError(`between value for ${key.column} must be a two-value array`);
        return [p({ kind: 'between', op: 'between', value }), 0];
    }
    if (key.compare !== '') {
      if (!isModel(value)) throw configError(`column comparison ${key.column} requires a model`);
      return [p({ kind: 'ref', op: `${operators[key.op]}_col`, ref: value[CORE], refCol: key.compare }), 0];
    }
    const op = operators[key.op]!;
    const nullable = key.op === '' || key.op === 'ne';
    if (value === null) {
      if (!nullable) throw configError(`null is not accepted by the ${key.op} operator`);
      return [p({ kind: 'null', op: key.op === 'ne' ? 'is_not_null' : 'is_null' }), 0];
    }
    if (value === undefined) throw configError(`${key.column} received undefined; use null`);
    if (value instanceof ColumnFunction) {
      if (!single) throw configError('a column function is accepted only by a single-key condition');
      if (rest.length !== 1) throw configError(`column function on ${key.column} requires one compared value`);
      return [p({ kind: 'column_fn', op, fn: value, value: rest[0] }), 1];
    }
    if (value instanceof ValueFunction) return [p({ kind: 'value_fn', op, fn: value }), 0];
    if (isModel(value)) {
      if (!nullable) throw configError(`a subquery is not accepted by the ${key.op} operator`);
      return [p({ kind: 'sub', op: key.op === 'ne' ? 'not_in' : 'in', sub: value[CORE] }), 0];
    }
    if (Array.isArray(value)) {
      if (!nullable) throw configError(`a list is not accepted by the ${key.op} operator`);
      if (value.length === 0) throw new OrmError('EMPTY_IN', `${key.column} received an empty list`);
      return [p({ kind: 'list', op: key.op === 'ne' ? 'not_in' : 'in', value }), 0];
    }
    return [p({ kind: 'value', op, value }), 0];
  }

  public join(kind: 'inner' | 'left', left: string, right: string, child: unknown): void {
    if (this.group) return this.fail('join is not allowed inside a group callback');
    if (!isModel(child)) return this.fail('join requires a model');
    const ch = child[CORE];
    if (ch.conn !== undefined) return this.fail('a join child cannot have its own connection');
    if (this.joins.some(j => j.child === ch)) return this.fail('the model is already joined');
    this.joins.push({ kind, left, right, child: ch });
  }

  public relation(many: boolean, child: unknown): void {
    if (this.group) return this.fail('relation is not allowed inside a group callback');
    if (!isModel(child)) return this.fail('relation requires a model');
    const ch = child[CORE];
    if (ch.matchLeft === '') return this.fail(`relation child ${ch.ent.schema.name} requires match<L>With<R>()`);
    this.relations.push({ many, child: ch });
  }

  private addName(name: string): boolean {
    if (this.columns.order.includes(name)) { this.fail(`column name ${name} is already added`); return false; }
    this.columns.order.push(name);
    return true;
  }
  public addColumn(column: string): void { if (!this.columns.add.includes(column)) this.columns.add.push(column); }
  public addColumnFormat(column: string, name: string, format: unknown): void {
    if (!this.addName(name)) return;
    if (format instanceof ColumnFunction) this.columns.funcs.set(name, { column, fn: format });
    else if (typeof format === 'string') this.columns.formats.set(name, { column, format });
    else this.fail(`addColumn ${name} requires a format or a column function`);
  }
  public addColumnSub(name: string, fn: (m: ModelLike) => ModelLike): void {
    if (typeof fn !== 'function') return this.fail(`addColumn ${name} requires a callback`);
    if (this.addName(name)) this.columns.subs.set(name, fn);
  }
  public addRawColumn(name: string, sql: string, binds: readonly unknown[]): void { if (this.addName(name)) this.columns.raws.set(name, { sql, binds }); }
  public removeColumn(column: string): void { if (!this.columns.remove.includes(column)) this.columns.remove.push(column); }
  public orderBy(column: string, desc: boolean, fn: readonly unknown[]): void {
    if (fn.length > 1) return this.fail('orderBy accepts one column function');
    if (fn.length === 1 && !(fn[0] instanceof ColumnFunction)) return this.fail('orderBy accepts a column function only');
    this.order.push({ column, desc, fn: fn[0] as ColumnFunction | undefined });
  }
  public setLimit(offset: number, count: number): void {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(count) || offset < 0 || count < 1) return this.fail('limit requires a non-negative offset and a positive count');
    this.limit = { offset, count };
  }
  public setGroupLimit(n: number): void {
    if (!Number.isSafeInteger(n) || n < 1) return this.fail('groupLimit requires a positive count');
    this.groupLimit = n;
  }
  public aggregate(fn: string, column: string): void { this.aggFn = fn; this.agg = column; }

  public column(name: string): unknown { return this.values.get(name) ?? null; }
  /** Stores a column value and records it for the next write; null stores NULL. */
  public setValue(column: string, value: unknown): void {
    this.values.set(column, value);
    this.putSet(value === null ? { column, null: true } : { column, value });
  }

  public putSet(spec: SetSpec): void {
    if (this.group) return this.fail('set is not allowed inside a group callback');
    const index = this.sets.findIndex(s => s.column === spec.column);
    if (index >= 0) this.sets[index] = spec; else this.sets.push(spec);
  }

  public setNew(name: string, value: unknown): void {
    if (!this.newValues.has(name)) this.news.push(name);
    this.newValues.set(name, value);
  }

  public newValue(name: string): unknown {
    if (this.newValues.has(name)) return this.newValues.get(name);
    return this.row?.extra.get(name) ?? null;
  }

  public setDuplication(m: unknown): void {
    if (!isModel(m)) return this.fail('duplication requires a model');
    this.duplication = m[CORE];
  }

  /** Copies the builder state; the copy owns a new model. */
  public clone(): Core {
    const out = new Core(this.ent);
    Object.assign(out, this);
    out.where = new CondGroup([...this.where.items]);
    out.where.pending = this.where.pending;
    out.joins = [...this.joins];
    out.relations = [...this.relations];
    out.columns = this.columns.clone();
    out.order = [...this.order];
    out.groupBy = [...this.groupBy];
    out.groupRaw = [...this.groupRaw];
    out.sets = [...this.sets];
    out.news = [...this.news];
    out.newValues = new Map(this.newValues);
    out.values = new Map(this.values);
    out.self = this.ent.create(out);
    return out;
  }

  /** Applies a getBy/getsBy/getCountBy chain to a copy; the chain joins existing conditions with AND. */
  public by(keys: readonly ChainKey[], args: readonly unknown[]): Core {
    const out = this.clone();
    out.whereChain(out.where.items.length > 0 ? 'and' : '', keys, args);
    return out;
  }

  public resultName(many: boolean): string {
    if (this.alias !== '') return this.alias;
    return `${this.ent.schema.name}_${many ? 'models' : 'model'}`;
  }

  public build(kind: QueryKind): BuiltRequest {
    const r = new BuiltRequest(kind, this.ent.set.hash);
    if (this.error) { r.fail(this.error); return r; }
    const q = r.query(this, new Frame(this, undefined), '');
    if (q) Object.assign(r.ir, q);
    return r;
  }
}

class Frame {
  public readonly paths = new Map<Core, string>();
  public readonly parent = new Map<Core, Core>();
  public readonly placed = new Set<Core>();
  public constructor(public readonly root: Core, public readonly outer: Core | undefined) {
    this.paths.set(root, '');
    this.register(root, '');
  }
  private register(c: Core, prefix: string): void {
    for (const j of c.joins) {
      const path = prefix + j.child.resultName(false);
      this.paths.set(j.child, path);
      this.parent.set(j.child, c);
      this.register(j.child, `${path}/`);
    }
  }
  public pathOf(c: Core): string {
    const path = this.paths.get(c);
    if (path !== undefined) return path;
    if (this.outer !== undefined && c === this.outer) return '^';
    throw configError(`${c.ent.schema.name} is not part of the statement`);
  }
}

function pad<T>(values: readonly T[]): T[] {
  let n = 1;
  while (n < values.length) n <<= 1;
  const out = [...values];
  while (out.length < n) out.push(values[values.length - 1]!);
  return out;
}

/** A request under construction: the value-free IR plus values. */
export class BuiltRequest {
  public readonly ir: Request;
  public readonly params: unknown[] = [];
  public error: OrmError | undefined;
  public readonly joinPaths = new Set<string>();
  /** Relations whose child has its own connection, per parent model. */
  public readonly external = new Map<Core, RelSpec[]>();

  public constructor(kind: QueryKind, hash: string) {
    this.ir = { ir_version: 1, schema_hash: hash, kind, entity: '', n_params: 0 };
  }

  public param(value: unknown): number {
    this.params.push(value);
    return this.params.length - 1;
  }

  public fail(error: unknown): void {
    if (this.error === undefined) this.error = error instanceof OrmError ? error : configError(String(error));
  }

  public finish(): Request {
    this.ir.n_params = this.params.length;
    return this.ir;
  }

  public query(c: Core, f: Frame, path: string): RequestQuery | undefined {
    if (c.error) { this.fail(c.error); return undefined; }
    if (c.where.pending !== '') { this.fail(configError(`connector ${c.where.pending} without a following condition`)); return undefined; }
    const q: RequestQuery = { entity: c.ent.schema.name };
    if (c.index !== '') q.force_index = c.index;
    if (c.lock !== '') q.lock = c.lock;
    if (c.limit) q.limit = { ...c.limit };
    const columns = this.columns(c);
    if (this.error) return undefined;
    if (columns) q.columns = columns;
    for (const j of c.joins) {
      const childPath = f.paths.get(j.child)!;
      const name = childPath.slice(childPath.lastIndexOf('/') + 1);
      if (this.joinPaths.has(childPath)) { this.fail(configError(`join result name ${name} is used twice`)); return undefined; }
      this.joinPaths.add(childPath);
      const child = this.query(j.child, f, childPath);
      if (!child) return undefined;
      if (j.child.on) child.on = this.group(j.child.on, j.child, f);
      const join: Join = { rel: name, kind: j.kind, query: child, left: j.left, right: j.right };
      (q.joins ??= []).push(join);
    }
    if (c.where.items.length > 0) q.where = this.group(c.where, c, f);
    for (const rel of c.relations) {
      if (rel.child.conn !== undefined) {
        if (rel.child.limit) { this.fail(new OrmError('LIMIT_IN_RELATION', `${rel.child.ent.schema.name} relation uses limit; use groupLimit`)); return undefined; }
        const list = this.external.get(c) ?? [];
        list.push(rel);
        this.external.set(c, list);
        continue;
      }
      const child = this.relation(rel);
      if (!child) return undefined;
      (q.relations ??= []).push(child);
    }
    for (const o of c.order) {
      const item: Order = {};
      if (o.random) item.random = true;
      else if (o.raw !== undefined) item.expr = o.raw;
      else {
        item.column = o.column;
        if (o.desc) item.desc = true;
        if (o.fn) item.fn = o.fn.ir(v => this.param(v));
      }
      (q.order ??= []).push(item);
    }
    if (c.groupBy.length > 0) q.group_by = [...c.groupBy];
    c.groupRaw.forEach((sql, i) => (q.group_by_expr ??= []).push({ expr: sql, as: `group_${i + 1}` }));
    return q;
  }

  private relation(rel: RelSpec): Relation | undefined {
    const ch = rel.child;
    const q = this.query(ch, new Frame(ch, undefined), '');
    if (!q) return undefined;
    if (ch.limit) { this.fail(new OrmError('LIMIT_IN_RELATION', `${ch.ent.schema.name} relation uses limit; use groupLimit`)); return undefined; }
    if (ch.parentNode) q.flatten = true;
    if (ch.groupLimit > 0) q.limit_per_parent = ch.groupLimit;
    if (ch.deleteLock) q.no_cascade_delete = true;
    if (ch.keyName !== '') q.key_by = ch.keyName;
    if (ch.possible) q.if_parent = { column: ch.possible.column, p: this.param(ch.possible.value) };
    return { rel: ch.resultName(rel.many), kind: rel.many ? 'many' : 'one', left: ch.matchLeft, right: ch.matchRight, query: q };
  }

  private columns(c: Core): RequestQuery['columns'] {
    const spec = c.columns;
    const out: NonNullable<RequestQuery['columns']> = {};
    if (spec.mode !== '') out.mode = spec.mode;
    if (spec.add.length > 0) out.add = [...spec.add];
    if (spec.remove.length > 0) out.remove = [...spec.remove];
    for (const name of spec.order) {
      const format = spec.formats.get(name);
      if (format) {
        if (format.format!.split('%s').length !== 2) { this.fail(configError(`column format for ${name} must contain one %s`)); return undefined; }
        (out.expr ??= {})[name] = { sql: format.format!.replace('%s', `{${format.column}}`) };
      }
      const fn = spec.funcs.get(name);
      if (fn) (out.fn ??= {})[name] = { column: fn.column, fn: fn.fn!.ir(v => this.param(v)) } satisfies IRColumnFunction;
      const raw = spec.raws.get(name);
      if (raw) {
        const pred = this.rawPred(raw);
        const expr: Expression = { sql: pred.expr! };
        if (pred.ps && pred.ps.length > 0) expr.ps = pred.ps;
        (out.expr ??= {})[name] = expr;
      }
      const sub = spec.subs.get(name);
      if (sub) {
        const built = this.subquery(sub(c.self), c, true);
        if (!built) return undefined;
        (out.sub ??= {})[name] = built;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  private rawPred(raw: RawSpec): Predicate {
    const count = raw.sql.split('?').length - 1;
    if (count !== raw.binds.length) this.fail(new OrmError('IR_INVALID', `raw SQL has ${count} placeholders and ${raw.binds.length} binds`));
    const pred: Predicate = { expr: raw.sql };
    if (raw.binds.length > 0) pred.ps = raw.binds.map(b => this.param(b));
    return pred;
  }

  private group(g: CondGroup, owner: Core, f: Frame): Group {
    const out: Group = { items: [] };
    for (const node of g.items) {
      const item: Item = {};
      if (node.pred) {
        const pred = this.pred(node.pred, owner, f);
        if (!pred) return out;
        if (node.conn !== '') pred.conn = node.conn;
        item.pred = pred;
      } else if (node.raw) {
        item.pred = this.rawPred(node.raw);
        if (node.conn !== '') item.pred.conn = node.conn;
      } else if (node.group) {
        item.group = this.group(node.group, owner, f);
        if (node.conn !== '') item.group.conn = node.conn;
      } else if (node.joined) {
        const child = node.joined;
        const path = f.paths.get(child);
        if (path === undefined || child === f.root) { this.fail(configError(`${child.ent.schema.name} is not joined in the statement`)); return out; }
        if (f.parent.get(child) !== owner.subject()) { this.fail(configError(`${child.ent.schema.name} conditions must be placed in the model it is joined to`)); return out; }
        if (f.placed.has(child)) { this.fail(configError(`${child.ent.schema.name} conditions are placed twice`)); return out; }
        f.placed.add(child);
        if (child.where.items.length === 0) { this.fail(configError(`${child.ent.schema.name} has no condition to place`)); return out; }
        item.joined = { join: path.slice(path.lastIndexOf('/') + 1) };
        if (node.conn !== '') item.joined.conn = node.conn;
      }
      out.items.push(item);
    }
    return out;
  }

  private pred(p: PredSpec, owner: Core, f: Frame): Predicate | undefined {
    const out: Predicate = { column: p.column, op: p.op };
    switch (p.kind) {
      case 'fulltext':
        delete out.column;
        out.match = p.cols;
        out.p = this.param(p.value);
        break;
      case 'tuple':
        delete out.column;
        out.cols = p.cols;
        out.ps = (p.value as unknown[][]).flatMap(row => row.map(v => this.param(v)));
        break;
      case 'between':
        out.ps = (p.value as unknown[]).map(v => this.param(v));
        break;
      case 'list':
        out.ps = pad(p.value as unknown[]).map(v => this.param(v));
        break;
      case 'null':
        break;
      case 'ref':
        try { out.ref = { path: f.pathOf(p.ref!.subject()), column: p.refCol! }; }
        catch (error) { this.fail(error); return undefined; }
        break;
      case 'sub': {
        const sub = this.subquery(p.sub!.self, owner.subject(), false);
        if (!sub) return undefined;
        out.sub = sub;
        break;
      }
      case 'column_fn':
        out.fn = p.fn!.ir(v => this.param(v));
        out.p = this.param(p.value);
        break;
      case 'value_fn':
        out.value = p.fn!.ir(v => this.param(v));
        break;
      default:
        out.p = this.param(p.value);
    }
    return out;
  }

  private subquery(m: ModelLike | undefined, outer: Core, scalar: boolean): Subquery | undefined {
    if (!isModel(m)) { this.fail(configError('subquery callback returned no model')); return undefined; }
    const c = m[CORE];
    if (c.conn !== undefined) { this.fail(configError('a subquery model cannot have its own connection')); return undefined; }
    if (c.relations.length > 0) { this.fail(configError('a subquery model cannot load relations')); return undefined; }
    const q = this.query(c, new Frame(c, outer), '');
    if (!q) return undefined;
    const sub: Subquery = { query: q };
    if (scalar && c.agg !== '') {
      sub.agg = c.aggFn;
      sub.column = c.agg;
    } else if (c.columns.add.length === 1) {
      sub.column = c.columns.add[0];
    } else {
      this.fail(configError('a subquery model must add exactly one column with addColumn<Col>()'));
      return undefined;
    }
    delete q.columns;
    return sub;
  }
}
