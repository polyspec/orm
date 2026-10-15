// Request validation against the manifest. Every client renders the same
// request; the rules below are the shared statement rules.
import type { Assignment, Group, Item, Join, Predicate, Request, RequestQuery, Subquery, OrmFunction } from '../ir.js';
import { OrmError } from '../runtime_error.js';
import { columnFunctionArity, columnFunctionTypes, isValueFunction, valueFunctionUnits } from './dialect.js';
import { entityOf, fieldOf as columnOf, type Entity, type Field as Column, type RuntimeModel } from './model.js';

const IR_VERSION = 1;

const comparable = ['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'between', 'is_null', 'is_not_null'];

const equality = ['eq', 'not_eq', 'in', 'not_in', 'is_null', 'is_not_null'];

/** Operators by dbspec column type. */
const opsByType: Readonly<Record<string, readonly string[]>> = {
  i16: comparable,
  i32: comparable,
  i64: comparable,
  f64: comparable,
  decimal: comparable,
  date: comparable,
  time: comparable,
  datetime: comparable,
  uuid: comparable,
  varchar: ['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'contains', 'contains_binary', 'is_null', 'is_not_null'],
  text: ['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'contains', 'contains_binary', 'is_null', 'is_not_null'],
  bool: ['eq', 'not_eq', 'is_null', 'is_not_null'],
  bytes: equality,
};

/** Codec stages whose stored value is compared through the encoded bind value. */
const hostStages = new Set(['aes', 'hex', 'ip']);

const columnOps = new Set(['eq_col', 'not_eq_col', 'gt_col', 'gte_col', 'lt_col', 'lte_col']);

const numericTypes = new Set(['i16', 'i32', 'i64', 'f64', 'decimal']);

function fail(code: string, message: string): never { throw new OrmError(code, message); }

/**
 * One entity place of a statement (its root or a join), as the planner's scope:
 * column-to-column refs resolve against it. A relation and a subquery are the
 * roots of statements of their own.
 */
interface Scope {
  readonly name: string;
  readonly ent: Entity | undefined;
  readonly parent: Scope | undefined;
  /** The scope a subquery root appears in ("^" refs). */
  readonly outer: Scope | undefined;
  readonly joins: Map<string, Scope>;
}

/**
 * Reports whether op is valid for a column of the given type and codec
 * stages: an AES column compares through its blind index, a column of host
 * stages only by equality, and any other codec only by NULL.
 */
export function opAllowed(c: Column, op: string): boolean {
  if (columnOps.has(op)) return true;
  if (c.stages.length > 0) {
    if (c.stages.every(s => hostStages.has(s))) return equality.includes(op);
    return op === 'is_null' || op === 'is_not_null';
  }
  return opsByType[c.type]?.includes(op) ?? false;
}

/**
 * Whether two columns compare alike on the three databases, as dbspec's check operands do: integers with integers,
 * decimals of one scale, f64, bool, varchar and text together, uuid, date, time or datetime of one precision, and bytes
 * with bytes.
 */
function meets(a: Column, b: Column): boolean {
  const integer = (t: string): boolean => t === 'i16' || t === 'i32' || t === 'i64';
  if (integer(a.type)) return integer(b.type);
  if (a.type === 'decimal') return b.type === 'decimal' && a.scale === b.scale;
  if (a.type === 'varchar' || a.type === 'text') return b.type === 'varchar' || b.type === 'text';
  if (a.type === 'time' || a.type === 'datetime') return b.type === a.type && a.precision === b.precision;
  return a.type === b.type;
}

/**
 * Whether the column comparison `op` may compare `left` with `right`: its base operator (eq for eq_col) must be one of
 * the left column's type, and neither column may have a codec, since a codec's stored form is not the value the
 * operator orders. Two columns whose only codec is ip compare by eq_col and not_eq_col, because both sides are the
 * dialect's same stored form.
 */
function colPairOpAllowed(left: Column, right: Column, op: string): boolean {
  const base = op.replace(/_col$/, '');
  if (left.stages.length === 0 && right.stages.length === 0) return opsByType[left.type]?.includes(base) ?? false;
  const isIP = (c: Column): boolean => c.stages.length === 1 && c.stages[0] === 'ip';
  return isIP(left) && isIP(right) && (base === 'eq' || base === 'not_eq');
}

class Validator {
  /** `root` is the request's own query, the only one that may group. */
  public constructor(private readonly m: RuntimeModel, private readonly n: number, private readonly root: RequestQuery) {}

  public params(ps: readonly number[] | undefined): void {
    for (const i of ps ?? []) {
      if (!Number.isSafeInteger(i) || i < 0 || i >= this.n) fail('IR_INVALID', `param index ${i} out of range (n_params ${this.n})`);
    }
  }

  public entity(name: string): Entity {
    return entityOf(this.m, name) ?? fail('ENTITY_UNKNOWN', name);
  }

  /** The scope tree of q and its joins, built before any condition is checked, as the planner's buildScopes. */
  public scopes(q: RequestQuery, parent: Scope | undefined, outer: Scope | undefined): Scope {
    const s: Scope = { name: q.entity, ent: entityOf(this.m, q.entity), parent, outer, joins: new Map() };
    for (const j of q.joins ?? []) {
      if (s.joins.has(j.rel) || !j.query) continue;
      s.joins.set(j.rel, this.scopes(j.query, s, undefined));
    }
    return s;
  }

  /**
   * Resolves a column-to-column ref as the planner's resolvePath: path "" is the
   * statement root, "^" the query around a subquery (only inside one), and any
   * other path the join names from the root joined by "/". The target has the column.
   */
  private ref(s: Scope, path: string, column: string): Column {
    let root = s;
    while (root.parent) root = root.parent;
    let target = root;
    if (path === '^') {
      target = root.outer ?? fail('IR_INVALID', '^ reference outside a subquery');
    } else if (path !== '') {
      for (const seg of path.split('/')) target = target.joins.get(seg) ?? fail('ENTITY_NOT_JOINED', `${target.name}.${seg}`);
    }
    const ent = target.ent ?? fail('ENTITY_UNKNOWN', target.name);
    return columnOf(ent, column) ?? fail('COLUMN_UNKNOWN', `${target.name}.${column}`);
  }

  public assign(ent: Entity, r: Request, a: Assignment): void {
    const c = columnOf(ent, a.column) ?? fail('COLUMN_UNKNOWN', `${r.entity}.${a.column}`);
    const n = [a.p !== undefined, a.null === true, a.plus_p !== undefined, a.minus_p !== undefined].filter(Boolean).length;
    if (n !== 1) fail('IR_INVALID', `set ${a.column}: exactly one of p/null/plus_p/minus_p`);
    if (a.null && !c.nullable) fail('IR_INVALID', `set ${r.entity}.${a.column} to null but column is NOT NULL`);
    if (a.column === ent.auditColumn) fail('IR_INVALID', `${r.entity}.${a.column} is written by the executor from the audit of the transaction`);
    if ((a.plus_p !== undefined || a.minus_p !== undefined) && !numericTypes.has(c.type)) {
      fail('OPERATOR_NOT_ALLOWED', `plus/minus on ${r.entity}.${a.column} (${c.type})`);
    }
    for (const idx of [a.p, a.plus_p, a.minus_p]) if (idx !== undefined) this.params([idx]);
  }

  public query(q: RequestQuery, s: Scope, isJoin: boolean, isRelation: boolean): void {
    const ent = this.entity(q.entity);
    if (q.columns) {
      const cols = q.columns;
      if (cols.mode !== undefined && cols.mode !== '' && cols.mode !== 'all' && cols.mode !== 'none') fail('IR_INVALID', `columns.mode "${String(cols.mode)}"`);
      for (const c of [...cols.add ?? [], ...cols.remove ?? []]) if (!columnOf(ent, c)) fail('COLUMN_UNKNOWN', `${q.entity}.${c}`);
      const outputs = new Set<string>();
      for (const [out, cf] of Object.entries(cols.fn ?? {})) {
        if (columnOf(ent, out) || outputs.has(out)) fail('COLUMN_ALIAS_CONFLICT', `${q.entity}.${out} is already a row name`);
        outputs.add(out);
        const col = columnOf(ent, cf.column) ?? fail('COLUMN_UNKNOWN', `${q.entity}.${cf.column}`);
        this.columnFunction(ent, col, cf.fn);
      }
      for (const [out, sub] of Object.entries(cols.sub ?? {})) {
        if (columnOf(ent, out) || outputs.has(out)) fail('COLUMN_ALIAS_CONFLICT', `${q.entity}.${out} is already a row name`);
        outputs.add(out);
        this.sub(sub, true, s);
      }
    }
    const joined = new Map<string, Join>();
    for (const j of q.joins ?? []) {
      if (j.kind !== 'inner' && j.kind !== 'left') fail('IR_INVALID', `join kind "${String(j.kind)}"`);
      if (j.rel === '' || joined.has(j.rel)) fail('IR_INVALID', `join name "${j.rel}" is empty or used twice`);
      if (!j.left || !j.right || !j.query) fail('IR_INVALID', `join ${j.rel}: left, right and query are required`);
      const target = this.entity(j.query.entity);
      const left = columnOf(ent, j.left) ?? fail('COLUMN_UNKNOWN', `${ent.name}.${j.left}`);
      const right = columnOf(target, j.right) ?? fail('COLUMN_UNKNOWN', `${target.name}.${j.right}`);
      if (!meets(left, right)) fail('OPERATOR_NOT_ALLOWED', `join ${j.rel}: ${ent.name}.${j.left} does not meet ${target.name}.${j.right}`);
      joined.set(j.rel, j);
      this.query(j.query, s.joins.get(j.rel) ?? fail('IR_INVALID', `join ${j.rel} has no scope`), true, false);
    }
    if (!isJoin && q.on) fail('IR_INVALID', 'on[] is only valid on join children');
    if (q.on?.not || q.where?.not) fail('IR_INVALID', 'not applies to a nested group');
    // top-level group 은 앞 형제가 없으므로 conn 을 갖지 않는다.
    for (const top of [q.on, q.where]) {
      if (top && (top.conn ?? '') !== '') fail('IR_INVALID', `the top-level group takes no conn ("${top.conn}")`);
    }
    if (q.on) this.group(s, q.on, joined);
    if (q.where) {
      this.group(s, q.where, joined);
      joinedRefs(q.where, new Set());
    }
    const relationNames = new Set<string>();
    for (const r of q.relations ?? []) {
      if (r.rel === '' || relationNames.has(r.rel)) fail('COLUMN_ALIAS_CONFLICT', `relation name "${r.rel}" is empty or used twice`);
      relationNames.add(r.rel);
      if (columnOf(ent, r.rel)) fail('COLUMN_ALIAS_CONFLICT', `${q.entity}.${r.rel} is already a column`);
      if (!r.query) fail('IR_INVALID', `relation ${r.rel} needs a query`);
      const kind = r.kind ?? '';
      const keys = Array.isArray(r.keys) && r.keys.length > 0 && (kind === 'one' || kind === 'many') ? r.keys : fail('IR_INVALID', `relation ${r.rel}: keys and kind one|many are required`);
      const target = this.entity(r.query.entity);
      const lefts = new Set<string>();
      const rights = new Set<string>();
      for (const k of keys) {
        if (!k.left || !k.right) fail('IR_INVALID', `relation ${r.rel}: every key needs left and right`);
        const left = columnOf(ent, k.left) ?? fail('COLUMN_UNKNOWN', `${q.entity}.${k.left}`);
        const right = columnOf(target, k.right) ?? fail('COLUMN_UNKNOWN', `${target.name}.${k.right}`);
        if (!meets(left, right)) fail('OPERATOR_NOT_ALLOWED', `relation ${r.rel}: ${q.entity}.${k.left} does not meet ${target.name}.${k.right}`);
        // 한 column이 두 성분에 나오면 key가 아니다.
        if (lefts.has(k.left) || rights.has(k.right)) fail('IR_INVALID', `relation ${r.rel}: key column ${k.left} or ${k.right} is used twice`);
        lefts.add(k.left);
        rights.add(k.right);
      }
      if (r.query.limit) fail('LIMIT_IN_RELATION', `${r.rel}: use limit_per_parent`);
      if (r.query.flatten && kind !== 'one') fail('IR_INVALID', `relation ${r.rel}: flatten needs a one relation`);
      if ((r.query.key_by ?? '') !== '' && kind !== 'many') fail('IR_INVALID', `relation ${r.rel}: key_by needs a many relation`);
      if (r.query.if_parent && !columnOf(ent, r.query.if_parent.column)) fail('COLUMN_UNKNOWN', `${q.entity}.${r.query.if_parent.column} (if_parent)`);
      this.query(r.query, this.scopes(r.query, undefined, undefined), false, true);
    }
    if (q.key_by !== undefined && q.key_by !== '') {
      const keyColumn = columnOf(ent, q.key_by) ?? fail('COLUMN_UNKNOWN', `${q.entity}.${q.key_by}`);
      // A NULL collection key has no answer that every language shares.
      if (keyColumn.nullable) fail('IR_INVALID', `key_by ${q.key_by} is nullable`);
    }
    if (q.if_parent) this.params([q.if_parent.p]);
    if (!isRelation && ((q.key_by ?? '') !== '' || q.flatten || (q.limit_per_parent ?? 0) > 0 || q.if_parent || q.no_cascade_delete)) {
      fail('IR_INVALID', `relation-only options on ${q.entity}`);
    }
    for (const o of q.order ?? []) {
      const kinds = [(o.column ?? '') !== '', o.random === true].filter(Boolean).length;
      if (kinds !== 1) fail('IR_INVALID', 'order needs exactly one of column, random');
      if (o.column !== undefined && o.column !== '') {
        const col = columnOf(ent, o.column) ?? fail('COLUMN_UNKNOWN', `${q.entity}.${o.column}`);
        if (o.fn) this.columnFunction(ent, col, o.fn);
      } else if (o.fn) fail('IR_INVALID', 'order function needs a column');
    }
    for (const g of q.group_by ?? []) if (!columnOf(ent, g)) fail('COLUMN_UNKNOWN', `${q.entity}.${g}`);
    if (hasGroupBy(q)) {
      if (q !== this.root) fail('IR_INVALID', "group_by is only valid on the request's root query");
      // An order item of a grouped query sorts the groups: only a group column (or random) has a value per group.
      for (const o of q.order ?? []) {
        if (o.column !== undefined && o.column !== '' && !(q.group_by ?? []).includes(o.column)) fail('IR_INVALID', `order by ${o.column}, which is not a group column`);
      }
    }
    if (q.limit && (!Number.isSafeInteger(q.limit.offset) || !Number.isSafeInteger(q.limit.count) || q.limit.offset < 0 || q.limit.count <= 0)) {
      fail('IR_INVALID', 'limit offset>=0, count>0');
    }
    const lock = q.lock ?? '';
    if (lock !== '' && !['update', 'share', 'update_nowait', 'share_nowait'].includes(lock)) {
      fail('IR_INVALID', `lock "${lock}": want update, share, update_nowait or share_nowait`);
    }
    if (lock !== '' && (isJoin || isRelation || q.group_by !== undefined || (q.limit_per_parent ?? 0) > 0)) {
      fail('IR_INVALID', 'row lock is only valid on a root row select');
    }
    if (q.force_index !== undefined && q.force_index !== '' && !ent.indexes.includes(q.force_index)) fail('INDEX_UNKNOWN', `${q.entity}.${q.force_index}`);
  }

  private group(s: Scope, g: Group, joined: ReadonlyMap<string, Join>): void {
    g.items.forEach((it, i) => {
      const given = [it.pred, it.group, it.joined].filter(v => v !== undefined);
      const [only] = given;
      if (given.length !== 1 || only === undefined) fail('IR_INVALID', 'where item must be exactly one of pred/group/joined');
      const conn = only.conn ?? '';
      if (conn !== '' && conn !== 'and' && conn !== 'or') fail('IR_INVALID', `conn "${conn}"`);
      if (i === 0 && conn === 'or') fail('OR_AT_GROUP_START', 'a group may not start with OR');
      // group 의 첫 item 은 앞 형제가 없으므로 conn 을 갖지 않는다.
      if (i === 0 && conn !== '') fail('IR_INVALID', `the first item of a group takes no conn ("${conn}")`);
      if (it.joined) {
        const j = joined.get(it.joined.join) ?? fail('ENTITY_NOT_JOINED', `${it.joined.join} is not joined in this statement`);
        if (!j.query.where || j.query.where.items.length === 0) fail('IR_INVALID', `joined ${it.joined.join} has no conditions`);
      } else if (it.pred) {
        this.pred(s, it.pred);
      } else if (it.group) {
        if (it.group.items.length === 0) fail('IR_INVALID', 'empty group');
        this.group(s, it.group, joined);
      }
    });
  }

  private pred(s: Scope, p: Predicate): void {
    const ent = s.ent ?? fail('IR_INVALID', `scope ${s.name} has no entity`);
    this.params(p.ps);
    if (p.p !== undefined) this.params([p.p]);
    const ps = p.ps ?? [];
    if (p.op === 'tuple_in' || p.op === 'tuple_not_in') {
      const cols = p.cols ?? [];
      if (cols.length < 2) fail('IR_INVALID', `${p.op} needs at least two columns`);
      for (const name of cols) {
        const c = columnOf(ent, name) ?? fail('COLUMN_UNKNOWN', `${ent.name}.${name}`);
        if (c.stages.length > 0) fail('OPERATOR_NOT_ALLOWED', `${p.op} on ${ent.name}.${name}`);
      }
      if (ps.length === 0) fail('EMPTY_IN', `${ent.name}(${cols.join(',')})`);
      if (ps.length % cols.length !== 0) fail('IR_INVALID', `${p.op}: ${ps.length} values for ${cols.length} columns`);
      return;
    }
    if ((p.cols ?? []).length > 0) fail('IR_INVALID', 'cols is only valid with tuple_in or tuple_not_in');
    const column = p.column ?? '';
    if (p.sub) {
      const compared = columnOf(ent, column) ?? fail('COLUMN_UNKNOWN', `${ent.name}.${column}`);
      if (p.op !== 'in' && p.op !== 'not_in') fail('IR_INVALID', 'subquery needs in or not_in');
      if (p.p !== undefined || ps.length > 0 || p.fn || p.value) fail('IR_INVALID', 'subquery pred may not carry values');
      this.sub(p.sub, false, s);
      // sub checked the subquery column; it meets the compared column as check operands do.
      const subColumn = columnOf(this.entity(p.sub.query.entity), p.sub.column ?? '');
      if (subColumn && !meets(compared, subColumn)) fail('OPERATOR_NOT_ALLOWED', `${ent.name}.${column} does not meet the subquery column ${p.sub.query.entity}.${p.sub.column}`);
      return;
    }
    if (p.fn || p.value) {
      const c = columnOf(ent, column) ?? fail('COLUMN_UNKNOWN', `${ent.name}.${column}`);
      if (p.fn && p.value) fail('IR_INVALID', 'fn and value cannot be combined');
      if (p.fn) {
        this.columnFunction(ent, c, p.fn);
        switch (p.op) {
          case 'eq': case 'not_eq': case 'gt': case 'gte': case 'lt': case 'lte':
            if (p.p === undefined) fail('IR_INVALID', `${p.op} needs a value (p)`);
            break;
          case 'in': case 'not_in':
            if (ps.length === 0) fail('EMPTY_IN', `${ent.name}.${column}`);
            break;
          case 'between':
            if (ps.length !== 2) fail('IR_INVALID', 'between needs 2 params (ps)');
            break;
          default:
            fail('OPERATOR_NOT_ALLOWED', `${p.op} with a column function`);
        }
        return;
      }
      const value = p.value ?? fail('IR_INVALID', 'a predicate without fn needs a value function');
      if (!isValueFunction(value.name)) fail('FUNCTION_UNKNOWN', value.name);
      if (c.type !== 'date' && c.type !== 'datetime') fail('OPERATOR_NOT_ALLOWED', `${value.name} on ${ent.name}.${column} (${c.type})`);
      const want = Object.hasOwn(valueFunctionUnits, value.name) ? 1 : 0;
      if ((value.ps ?? []).length !== want) fail('IR_INVALID', `${value.name} takes ${want} arguments`);
      if (p.p !== undefined || ps.length > 0) fail('IR_INVALID', 'value function pred may not carry p or ps');
      if (!['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte'].includes(p.op ?? '')) fail('OPERATOR_NOT_ALLOWED', `${p.op} with a value function`);
      this.params(value.ps);
      return;
    }
    const c = columnOf(ent, column) ?? fail('COLUMN_UNKNOWN', `${ent.name}.${column}`);
    const op = p.op ?? '';
    if (!opAllowed(c, op)) fail('OPERATOR_NOT_ALLOWED', `${op} on ${ent.name}.${column} (${c.type})`);
    switch (op) {
      case 'is_null': case 'is_not_null':
        return;
      case 'in': case 'not_in':
        if (ps.length === 0) fail('EMPTY_IN', `${ent.name}.${column}`);
        return;
      case 'between':
        if (ps.length !== 2) fail('IR_INVALID', 'between needs 2 params (ps)');
        return;
    }
    if (columnOps.has(op)) {
      if (!p.ref) fail('IR_INVALID', `${op} needs ref`);
      // 없거나 null인 path는 root다. 문자열이 아닌 path나 column은 request의 형태가 틀린 것이다.
      const path: unknown = p.ref.path ?? '';
      const refColumn: unknown = p.ref.column;
      if (typeof path !== 'string' || typeof refColumn !== 'string') fail('IR_INVALID', `${op} ref path and column must be strings`);
      const other = this.ref(s, path, refColumn);
      if (!meets(c, other)) fail('OPERATOR_NOT_ALLOWED', `${ent.name}.${column} does not meet ${path}.${refColumn}`);
      if (!colPairOpAllowed(c, other, op)) fail('OPERATOR_NOT_ALLOWED', `${op} on ${ent.name}.${column} (${c.type}) and ${path}.${refColumn} (${other.type})`);
      return;
    }
    if (p.p === undefined) fail('IR_INVALID', `${op} ${ent.name}.${column} needs a value (p)`);
  }

  private columnFunction(ent: Entity, c: Column, f: OrmFunction): void {
    const types = columnFunctionTypes[f.name] ?? fail('FUNCTION_UNKNOWN', f.name);
    if (!types.includes(c.type)) fail('OPERATOR_NOT_ALLOWED', `${f.name} on ${ent.name}.${c.name} (${c.type})`);
    if ((f.ps ?? []).length !== columnFunctionArity[f.name]) fail('IR_INVALID', `${f.name} takes ${columnFunctionArity[f.name]} arguments`);
    this.params(f.ps);
  }

  /** Checks a subquery; outer is the scope it appears in, which its "^" refs name. */
  private sub(s: Subquery | undefined, scalar: boolean, outer: Scope): void {
    if (!s || !s.query) fail('IR_INVALID', 'subquery needs a query');
    const ent = this.entity(s.query.entity);
    const column = s.column ?? '';
    switch (s.agg ?? '') {
      case '':
        if (column === '') fail('IR_INVALID', 'subquery needs a column');
        break;
      case 'sum': case 'avg': {
        if (!scalar) fail('IR_INVALID', `${s.agg} subquery is only valid as a column`);
        const c = columnOf(ent, column) ?? fail('COLUMN_UNKNOWN', `${ent.name}.${column}`);
        if (!numericTypes.has(c.type)) fail('OPERATOR_NOT_ALLOWED', `${s.agg} on ${ent.name}.${column} (${c.type})`);
        break;
      }
      case 'count':
        if (!scalar) fail('IR_INVALID', 'count subquery is only valid as a column');
        break;
      default:
        fail('IR_INVALID', `subquery agg "${s.agg}"`);
    }
    if (column !== '' && !columnOf(ent, column)) fail('COLUMN_UNKNOWN', `${ent.name}.${column}`);
    // A scalar column subquery yields at most one row by its shape: MySQL answers 1242 and PostgreSQL 21000 for several
    // rows, and SQLite returns the first, so the request makes one row certain. An in subquery (MySQL 1235) and an
    // aggregate take no limit.
    const scalarColumn = scalar && (s.agg ?? '') === '';
    if ((s.query.relations ?? []).length > 0 || (s.query.lock ?? '') !== '' || s.query.columns || (s.query.limit && !scalarColumn)) {
      fail('IR_INVALID', 'subquery may not use limit, relations, lock or columns');
    }
    if (scalarColumn) {
      if (!s.query.limit || s.query.limit.count !== 1) fail('IR_INVALID', 'a scalar column subquery needs limit with count 1');
      const order = s.query.order ?? [];
      if (order.some(o => o.random)) fail('IR_INVALID', 'a scalar column subquery may not order by random');
      for (const pk of ent.primaryKey) {
        if (!order.some(o => o.column === pk && !o.fn)) fail('IR_INVALID', `a scalar column subquery needs an order that includes the primary key column ${pk}`);
      }
    }
    this.query(s.query, this.scopes(s.query, undefined, outer), false, false);
  }
}

/** Each join a group places appears once. */
function joinedRefs(g: Group, seen: Set<string>): void {
  for (const it of g.items) {
    if (it.joined) {
      if (seen.has(it.joined.join)) fail('IR_INVALID', `joined ${it.joined.join} is placed twice`);
      seen.add(it.joined.join);
    }
    if (it.group) joinedRefs(it.group, seen);
  }
}

const kinds = new Set(['one', 'all', 'count', 'group_count', 'sum', 'avg', 'paginate', 'insert', 'update', 'delete', 'restore', 'restart_identity']);

function hasGroupBy(q: RequestQuery): boolean {
  return (q.group_by ?? []).length > 0;
}

/**
 * The one key an insert with on_duplicate conflicts on. MySQL updates the row met on any unique key, while PostgreSQL
 * and SQLite name one target and a meeting on another key is a unique violation, so no order of keys reproduces both:
 * an upsert has exactly one key that can meet the inserted row, and the insert assigns every column of it. The
 * candidates are the primary key, unless the insert leaves it out (an identity, or a key an IR executor assigns), and
 * each unique key; a blind index column counts as assigned with its AES source.
 */
export function conflictKey(ent: Entity, set: readonly Assignment[]): readonly string[] {
  const assigned = new Set(set.map(a => a.column));
  for (const f of ent.fields) if (f.blindIndex !== '' && assigned.has(f.name)) assigned.add(f.blindIndex);
  const candidates: { name: string; columns: readonly string[] }[] = [];
  if (ent.primaryKey.some(c => assigned.has(c))) candidates.push({ name: `primary key (${ent.primaryKey.join(', ')})`, columns: ent.primaryKey });
  for (const u of ent.uniques) candidates.push({ name: `unique (${u.join(', ')})`, columns: u });
  if (candidates.length === 0) fail('IR_INVALID', 'on_duplicate needs exactly one conflict key; no key can meet the row');
  if (candidates.length !== 1) fail('IR_INVALID', `on_duplicate needs exactly one conflict key; ${candidates.map(k => k.name).join(', ')} can meet the row`);
  const [candidate] = candidates;
  if (candidate === undefined || candidates.length !== 1) fail('IR_INVALID', `on_duplicate needs exactly one conflict key; ${candidates.map(k => k.name).join(', ')} can meet the row`);
  const missing = candidate.columns.find(c => !assigned.has(c));
  if (missing !== undefined) fail('IR_INVALID', `on_duplicate needs exactly one conflict key; ${candidate.name} can meet the row but the insert does not assign ${missing}`);
  return candidate.columns;
}

/** Checks a request against the manifest. */
export function validate(m: RuntimeModel, r: Request): void {
  if (r.ir_version !== IR_VERSION) fail('VERSION_MISMATCH', `ir_version ${String(r.ir_version)}, engine ${String(IR_VERSION)}`);
  if (r.manifest_hash !== m.manifestHash) fail('SCHEMA_HASH_MISMATCH', `client ${r.manifest_hash}, engine ${m.manifestHash}`);
  if (!kinds.has(r.kind)) fail('IR_INVALID', `unknown kind "${r.kind}"`);
  if (r.load === true && (r.kind !== 'insert' || (r.on_duplicate ?? []).length > 0)) fail('IR_INVALID', 'load is only valid on insert without on_duplicate');
  // restart_identity은 entity 하나의 identity만 다시 시작하므로 행이나 값을 받지 않는다.
  if (r.kind === 'restart_identity' && ((r.set ?? []).length > 0 || (r.rows ?? []).length > 0 || (r.on_duplicate ?? []).length > 0 || r.where !== undefined || r.optimistic !== undefined)) {
    fail('IR_INVALID', 'restart_identity takes no set, rows, on_duplicate, where or optimistic');
  }
  const v = new Validator(m, r.n_params, r);
  v.query(r, v.scopes(r, undefined, undefined), false, false);
  if ((r.lock ?? '') !== '' && r.kind !== 'one' && r.kind !== 'all') fail('IR_INVALID', 'row lock is only valid on one or all');
  const ent = v.entity(r.entity);
  if (r.kind === 'sum' || r.kind === 'avg') {
    const c = columnOf(ent, r.agg ?? '') ?? fail('COLUMN_UNKNOWN', `${r.entity}.${r.agg ?? ''}`);
    if (!numericTypes.has(c.type)) fail('OPERATOR_NOT_ALLOWED', `${r.kind} on ${r.entity}.${r.agg} (${c.type})`);
  }
  if (r.kind === 'group_count' && !hasGroupBy(r)) fail('IR_INVALID', 'group_count needs group_by');
  if (hasGroupBy(r) && r.kind !== 'count' && r.kind !== 'group_count') fail('IR_INVALID', `group_by is only valid on count or group_count, not ${r.kind}`);
  if (r.kind === 'insert' || r.kind === 'update' || r.kind === 'restore') {
    if ((r.set ?? []).length === 0 && r.kind !== 'restore') fail('IR_INVALID', `${r.kind} needs set[]`);
    for (const a of r.set ?? []) {
      v.assign(ent, r, a);
      // A VALUES list has no current row for plus_p or minus_p to read; on_duplicate does.
      if (r.kind === 'insert' && (a.plus_p !== undefined || a.minus_p !== undefined)) fail('IR_INVALID', `insert cannot assign ${a.column} by plus or minus`);
      // The key is the table's own. A restore checks its set with its key below.
      if (r.kind === 'update') {
        const c = columnOf(ent, a.column) ?? fail('COLUMN_UNKNOWN', `${r.entity}.${a.column}`);
        if (c.primary || c.identity) fail('IR_INVALID', `cannot update ${a.column}`);
      }
    }
  }
  const rows = r.rows ?? [];
  if (rows.length > 0) {
    if (r.kind !== 'insert' || (r.on_duplicate ?? []).length > 0) fail('IR_INVALID', 'rows are only valid on insert without on_duplicate');
    for (const a of r.set ?? []) if (a.p === undefined) fail('IR_INVALID', `multi-row insert assigns ${r.entity}.${a.column} without a value`);
    rows.forEach((row, i) => {
      if (row.length !== (r.set ?? []).length) fail('IR_INVALID', `insert row ${i + 1} has ${row.length} values for ${(r.set ?? []).length} columns`);
      v.params(row);
    });
  }
  const onDuplicate = r.on_duplicate ?? [];
  if (onDuplicate.length > 0) {
    if (r.kind !== 'insert') fail('IR_INVALID', 'on_duplicate is only valid on insert');
    for (const a of onDuplicate) {
      v.assign(ent, r, a);
      const c = columnOf(ent, a.column) ?? fail('COLUMN_UNKNOWN', `${r.entity}.${a.column}`);
      if (c.primary || c.identity) fail('IR_INVALID', `on_duplicate cannot assign ${r.entity}.${a.column}`);
    }
    conflictKey(ent, r.set ?? []);
  }
  if (r.optimistic) {
    if (!columnOf(ent, r.optimistic.column)) fail('COLUMN_UNKNOWN', `${r.entity}.${r.optimistic.column}`);
    v.params([r.optimistic.p]);
  }
  if ((r.kind === 'update' || r.kind === 'delete') && (!r.where || r.where.items.length === 0)) fail('IR_INVALID', `${r.kind} without where`);
  if (r.kind === 'restore') {
    // restore 는 지워진 행만 고치므로 읽은 version 과 비교할 것이 없다.
    if (r.optimistic !== undefined) fail('IR_INVALID', 'restore takes no optimistic');
    restoreKey(ent, r);
  }
}

/** The parts of the statement of a restore request: the key that names its row, the conditions and the new values. */
export interface RestoreParts {
  /** The primary key, or the unique key, whose columns the request gives values. */
  readonly key: readonly string[];
  /** The where of the request with an eq condition for each set value of a key column. */
  readonly where: Group;
  /** The set values of the columns outside the key: the new values of the row. */
  readonly set: readonly Assignment[];
}

/**
 * Picks the key of a restore request (docs/protocol.md 1.5) after the request hook. The set values with a parameter
 * and the eq conditions with a parameter that the where joins with and give columns their values; the key is the
 * primary key when they cover it, otherwise the first unique key in name order that they cover. A set value of a key
 * column becomes a condition, every other set value is a new value, and the where keeps its other conditions, which
 * narrow the restore further; the key still names at most one row.
 */
export function restoreKey(ent: Entity, r: Request): RestoreParts {
  if (ent.softDelete === '') fail('IR_INVALID', `restore of ${ent.name}, which has no soft_delete setting`);
  const items = r.where?.items ?? [];
  const valued = new Set<string>();
  items.forEach((item, i) => {
    if (i > 0 && itemConn(item) === 'or') fail('IR_INVALID', `restore of ${ent.name} joins the conditions of its where with and`);
    const p = item.pred;
    if (p !== undefined && p.op === 'eq' && p.p !== undefined && p.fn === undefined && p.value === undefined && p.ref === undefined && p.sub === undefined) valued.add(p.column ?? '');
  });
  for (const a of r.set ?? []) if (a.p !== undefined) valued.add(a.column);
  const covered = (columns: readonly string[]) => columns.length > 0 && columns.every(c => valued.has(c));
  // indexes 의 앞부분이 uniques 와 같은 순서의 unique key 이름이다.
  const uniques = ent.uniques.map((columns, i) => ({ name: ent.indexes[i] ?? fail('IR_INVALID', `${ent.name} has no index name for unique key ${i + 1}`), columns })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const key = covered(ent.primaryKey) ? ent.primaryKey : uniques.find(u => covered(u.columns))?.columns
    ?? fail('IR_INVALID', `restore of ${ent.name} gives no primary key or unique key a value in its set or in an eq condition of its where`);
  const where: Item[] = [...items];
  const set: Assignment[] = [];
  for (const a of r.set ?? []) {
    if (a.p !== undefined && key.includes(a.column)) {
      where.push({ pred: { ...(where.length > 0 ? { conn: 'and' } : {}), column: a.column, op: 'eq', p: a.p } });
      continue;
    }
    // The key and the soft delete column are the table's own: a restore clears the latter itself.
    const c = columnOf(ent, a.column) ?? fail('COLUMN_UNKNOWN', `${ent.name}.${a.column}`);
    if (c.primary || c.identity || a.column === ent.softDelete) fail('IR_INVALID', `restore cannot assign ${a.column}`);
    set.push(a);
  }
  return { key, where: { items: where }, set };
}

/** The connector that joins an item to the item before it. */
function itemConn(item: Item): string {
  return item.pred?.conn ?? item.group?.conn ?? item.joined?.conn ?? '';
}
