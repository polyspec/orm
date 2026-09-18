// Request validation against the manifest. Every client renders the same
// request; the rules below are the shared statement rules.
import type { Assignment, Group, Join, Predicate, Request, RequestQuery, Subquery, OrmFunction } from '../ir.js';
import { OrmError } from '../runtime_error.js';
import { columnFunctionArity, columnFunctionTypes, isValueFunction, valueFunctionUnits } from './dialect.js';
import { columnOf, entityOf, type Column, type Entity, type Manifest } from './manifest.js';

export const IR_VERSION = 1;

const comparable = ['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'between', 'is_null', 'is_not_null'];

/** Operators by column type. Full-text search is checked against the indexes. */
const opsByType: Readonly<Record<string, readonly string[]>> = {
  i32: comparable,
  i64: comparable,
  f64: comparable,
  decimal: comparable,
  date: comparable,
  time: comparable,
  datetime: comparable,
  string: ['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'contains', 'contains_binary', 'is_null', 'is_not_null'],
  text: ['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'contains', 'contains_binary', 'is_null', 'is_not_null'],
  enum: ['eq', 'not_eq', 'in', 'not_in', 'is_null', 'is_not_null'],
  bool: ['eq', 'not_eq', 'is_null', 'is_not_null'],
  inet: ['eq', 'not_eq', 'in', 'not_in', 'is_null', 'is_not_null'],
  bytes: ['eq', 'not_eq', 'in', 'not_in', 'is_null', 'is_not_null'],
  json: ['is_null', 'is_not_null'],
  point: ['is_null', 'is_not_null'],
};

export const columnOps = new Set(['eq_col', 'not_eq_col', 'gt_col', 'gte_col', 'lt_col', 'lte_col']);

const numericTypes = new Set(['i32', 'i64', 'f64', 'decimal']);

function fail(code: string, message: string): never { throw new OrmError(code, message); }

/** Reports whether op is valid for a column of the given type and styles. */
export function opAllowed(c: Column, op: string): boolean {
  if (columnOps.has(op) || op === 'expr' || op === 'match' || op === 'match_boolean') return true;
  const styles = c.styles ?? [];
  if (styles.length > 0 && c.type !== 'inet') {
    if (styles[0] === 'aes') return ['eq', 'not_eq', 'in', 'not_in', 'is_null', 'is_not_null'].includes(op);
    return op === 'is_null' || op === 'is_not_null';
  }
  return opsByType[c.type]?.includes(op) ?? false;
}

class Validator {
  public constructor(private readonly m: Manifest, private readonly n: number) {}

  public params(ps: readonly number[] | undefined): void {
    for (const i of ps ?? []) {
      if (!Number.isSafeInteger(i) || i < 0 || i >= this.n) fail('IR_INVALID', `param index ${i} out of range (n_params ${this.n})`);
    }
  }

  public entity(name: string): Entity {
    return entityOf(this.m, name) ?? fail('ENTITY_UNKNOWN', name);
  }

  public assign(ent: Entity, r: Request, a: Assignment): void {
    const c = columnOf(ent, a.column) ?? fail('COLUMN_UNKNOWN', `${r.entity}.${a.column}`);
    const n = [a.p !== undefined, a.null === true, (a.expr ?? '') !== '', a.plus_p !== undefined, a.minus_p !== undefined].filter(Boolean).length;
    if (n !== 1) fail('IR_INVALID', `set ${a.column}: exactly one of p/null/expr/plus_p/minus_p`);
    if (a.null && !c.nullable) fail('IR_INVALID', `set ${r.entity}.${a.column} to null but column is NOT NULL`);
    if ((a.plus_p !== undefined || a.minus_p !== undefined) && !numericTypes.has(c.type)) {
      fail('OPERATOR_NOT_ALLOWED', `plus/minus on ${r.entity}.${a.column} (${c.type})`);
    }
    for (const idx of [a.p, a.plus_p, a.minus_p]) if (idx !== undefined) this.params([idx]);
    this.params(a.ps);
  }

  public query(q: RequestQuery, isJoin: boolean, isRelation: boolean): void {
    const ent = this.entity(q.entity);
    if (q.columns) {
      const cols = q.columns;
      if (cols.mode !== undefined && cols.mode !== '' && cols.mode !== 'all' && cols.mode !== 'none') fail('IR_INVALID', `columns.mode "${cols.mode}"`);
      for (const c of [...cols.add ?? [], ...cols.remove ?? []]) if (!columnOf(ent, c)) fail('COLUMN_UNKNOWN', `${q.entity}.${c}`);
      const outputs = new Set<string>();
      for (const [out, e] of Object.entries(cols.expr ?? {})) {
        if (columnOf(ent, out)) fail('COLUMN_ALIAS_CONFLICT', `${q.entity}.${out} already a column`);
        const count = e.sql.split('?').length - 1;
        if (count !== (e.ps ?? []).length) fail('IR_INVALID', `${q.entity}.${out} expr has ${count} placeholders but ${(e.ps ?? []).length} binds`);
        this.params(e.ps);
        outputs.add(out);
      }
      for (const [out, cf] of Object.entries(cols.fn ?? {})) {
        if (columnOf(ent, out) || outputs.has(out)) fail('COLUMN_ALIAS_CONFLICT', `${q.entity}.${out} is already a row name`);
        outputs.add(out);
        const col = columnOf(ent, cf.column) ?? fail('COLUMN_UNKNOWN', `${q.entity}.${cf.column}`);
        this.columnFunction(ent, col, cf.fn);
      }
      for (const [out, sub] of Object.entries(cols.sub ?? {})) {
        if (columnOf(ent, out) || outputs.has(out)) fail('COLUMN_ALIAS_CONFLICT', `${q.entity}.${out} is already a row name`);
        outputs.add(out);
        this.sub(sub, true);
      }
    }
    const joined = new Map<string, Join>();
    for (const j of q.joins ?? []) {
      if (j.kind !== 'inner' && j.kind !== 'left') fail('IR_INVALID', `join kind "${j.kind}"`);
      if (j.rel === '' || joined.has(j.rel)) fail('IR_INVALID', `join name "${j.rel}" is empty or used twice`);
      if ((j.left ?? '') !== '' || (j.right ?? '') !== '') {
        if (!j.left || !j.right || !j.query) fail('IR_INVALID', `join ${j.rel}: left, right and query are required`);
        const target = this.entity(j.query.entity);
        if (!columnOf(ent, j.left)) fail('COLUMN_UNKNOWN', `${ent.name}.${j.left}`);
        if (!columnOf(target, j.right)) fail('COLUMN_UNKNOWN', `${target.name}.${j.right}`);
      } else {
        const rel = ent.relations[j.rel] ?? fail('RELATION_UNKNOWN', `${q.entity}.${j.rel}`);
        if (!j.query || j.query.entity !== rel.target) fail('IR_INVALID', `join ${j.rel}: query entity must be ${rel.target}`);
      }
      joined.set(j.rel, j);
      this.query(j.query, true, false);
    }
    if (!isJoin && q.on) fail('IR_INVALID', 'on[] is only valid on join children');
    if (q.on) this.group(ent, q.on, joined);
    if (q.where) {
      this.group(ent, q.where, joined);
      joinedRefs(q.where, new Set());
    }
    const relationNames = new Set<string>();
    for (const r of q.relations ?? []) {
      if (r.rel === '' || relationNames.has(r.rel)) fail('COLUMN_ALIAS_CONFLICT', `relation name "${r.rel}" is empty or used twice`);
      relationNames.add(r.rel);
      if (columnOf(ent, r.rel)) fail('COLUMN_ALIAS_CONFLICT', `${q.entity}.${r.rel} is already a column`);
      if (!r.query) fail('IR_INVALID', `relation ${r.rel} needs a query`);
      let kind = r.kind ?? '';
      if ((r.left ?? '') !== '' || (r.right ?? '') !== '') {
        if (!r.left || !r.right || (kind !== 'one' && kind !== 'many')) fail('IR_INVALID', `relation ${r.rel}: left, right and kind one|many are required`);
        const target = this.entity(r.query.entity);
        if (!columnOf(ent, r.left)) fail('COLUMN_UNKNOWN', `${q.entity}.${r.left}`);
        if (!columnOf(target, r.right)) fail('COLUMN_UNKNOWN', `${target.name}.${r.right}`);
      } else {
        const rel = ent.relations[r.rel] ?? fail('RELATION_UNKNOWN', `${q.entity}.${r.rel}`);
        if (r.query.entity !== rel.target) fail('IR_INVALID', `relation ${r.rel}: query entity must be ${rel.target}`);
        if (kind !== '') fail('IR_INVALID', `relation ${r.rel}: kind needs left and right`);
        kind = rel.kind as typeof kind;
      }
      if (r.query.limit) fail('LIMIT_IN_RELATION', `${r.rel}: use limit_per_parent`);
      if (r.query.flatten && kind !== 'one') fail('IR_INVALID', `relation ${r.rel}: flatten needs a one relation`);
      if ((r.query.key_by ?? '') !== '' && kind !== 'many') fail('IR_INVALID', `relation ${r.rel}: key_by needs a many relation`);
      if (r.query.if_parent && !columnOf(ent, r.query.if_parent.column)) fail('COLUMN_UNKNOWN', `${q.entity}.${r.query.if_parent.column} (if_parent)`);
      this.query(r.query, false, true);
    }
    if ((q.key_by ?? '') !== '' && !columnOf(ent, q.key_by!)) fail('COLUMN_UNKNOWN', `${q.entity}.${q.key_by}`);
    if (q.if_parent) this.params([q.if_parent.p]);
    if (!isRelation && ((q.key_by ?? '') !== '' || q.flatten || (q.limit_per_parent ?? 0) > 0 || q.if_parent || q.no_cascade_delete)) {
      fail('IR_INVALID', `relation-only options on ${q.entity}`);
    }
    for (const o of q.order ?? []) {
      const kinds = [(o.column ?? '') !== '', (o.expr ?? '') !== '', o.random === true].filter(Boolean).length;
      if (kinds !== 1) fail('IR_INVALID', 'order needs exactly one of column, expr, random');
      if ((o.column ?? '') !== '') {
        const col = columnOf(ent, o.column!) ?? fail('COLUMN_UNKNOWN', `${q.entity}.${o.column}`);
        if (o.fn) this.columnFunction(ent, col, o.fn);
      } else if (o.fn) fail('IR_INVALID', 'order function needs a column');
    }
    for (const g of q.group_by ?? []) if (!columnOf(ent, g)) fail('COLUMN_UNKNOWN', `${q.entity}.${g}`);
    const groups = new Set(q.group_by ?? []);
    for (const g of q.group_by_expr ?? []) {
      if (g.expr.trim() === '' || g.as.trim() === '') fail('IR_INVALID', 'group_by_expr needs expr and as');
      if (g.expr.includes('?')) fail('IR_INVALID', 'group_by_expr does not accept parameters');
      if (groups.has(g.as)) fail('IR_INVALID', `duplicate group output ${g.as}`);
      groups.add(g.as);
    }
    if (q.limit && (!Number.isSafeInteger(q.limit.offset) || !Number.isSafeInteger(q.limit.count) || q.limit.offset < 0 || q.limit.count <= 0)) {
      fail('IR_INVALID', 'limit offset>=0, count>0');
    }
    const lock = q.lock ?? '';
    if (lock !== '' && !['update', 'share', 'update_nowait', 'share_nowait'].includes(lock)) {
      fail('IR_INVALID', `lock "${lock}": want update, share, update_nowait or share_nowait`);
    }
    if (lock !== '' && (isJoin || isRelation || q.group_by !== undefined || q.group_by_expr !== undefined || (q.limit_per_parent ?? 0) > 0)) {
      fail('IR_INVALID', 'row lock is only valid on a root row select');
    }
    if ((q.force_index ?? '') !== '' && !Object.hasOwn(ent.indexes ?? {}, q.force_index!)) fail('INDEX_UNKNOWN', `${q.entity}.${q.force_index}`);
  }

  private group(ent: Entity, g: Group, joined: ReadonlyMap<string, Join>): void {
    g.items.forEach((it, i) => {
      const present = [it.pred, it.group, it.joined].filter(v => v !== undefined);
      if (present.length !== 1) fail('IR_INVALID', 'where item must be exactly one of pred/group/joined');
      const conn = present[0]!.conn ?? '';
      if (conn !== '' && conn !== 'and' && conn !== 'or') fail('IR_INVALID', `conn "${conn}"`);
      if (i === 0 && conn === 'or') fail('OR_AT_GROUP_START', 'a group may not start with OR');
      if (it.joined) {
        const j = joined.get(it.joined.join) ?? fail('ENTITY_NOT_JOINED', `${it.joined.join} is not joined in this statement`);
        if (!j.query.where || j.query.where.items.length === 0) fail('IR_INVALID', `joined ${it.joined.join} has no conditions`);
      } else if (it.pred) {
        this.pred(ent, it.pred);
      } else if (it.group) {
        if (it.group.items.length === 0) fail('IR_INVALID', 'empty group');
        this.group(ent, it.group, joined);
      }
    });
  }

  private pred(ent: Entity, p: Predicate): void {
    this.params(p.ps);
    if (p.p !== undefined) this.params([p.p]);
    const ps = p.ps ?? [];
    if ((p.expr ?? '') !== '') {
      if ((p.column ?? '') !== '' || (p.op ?? '') !== '') fail('IR_INVALID', 'expr pred may not carry column/op');
      return;
    }
    if (p.op === 'tuple_in' || p.op === 'tuple_not_in') {
      const cols = p.cols ?? [];
      if (cols.length < 2) fail('IR_INVALID', `${p.op} needs at least two columns`);
      for (const name of cols) {
        const c = columnOf(ent, name) ?? fail('COLUMN_UNKNOWN', `${ent.name}.${name}`);
        if ((c.styles ?? []).length > 0 || c.type === 'jsontext' || c.type === 'point') fail('OPERATOR_NOT_ALLOWED', `${p.op} on ${ent.name}.${name}`);
      }
      if (ps.length === 0) fail('EMPTY_IN', `${ent.name}(${cols.join(',')})`);
      if (ps.length % cols.length !== 0) fail('IR_INVALID', `${p.op}: ${ps.length} values for ${cols.length} columns`);
      return;
    }
    if ((p.cols ?? []).length > 0) fail('IR_INVALID', 'cols is only valid with tuple_in or tuple_not_in');
    const column = p.column ?? '';
    if (p.sub) {
      if (!columnOf(ent, column)) fail('COLUMN_UNKNOWN', `${ent.name}.${column}`);
      if (p.op !== 'in' && p.op !== 'not_in') fail('IR_INVALID', 'subquery needs in or not_in');
      if (p.p !== undefined || ps.length > 0 || p.fn || p.value) fail('IR_INVALID', 'subquery pred may not carry values');
      this.sub(p.sub, false);
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
      const value = p.value!;
      if (!isValueFunction(value.name)) fail('FUNCTION_UNKNOWN', value.name);
      if (c.type !== 'date' && c.type !== 'datetime') fail('OPERATOR_NOT_ALLOWED', `${value.name} on ${ent.name}.${column} (${c.type})`);
      const want = Object.hasOwn(valueFunctionUnits, value.name) ? 1 : 0;
      if ((value.ps ?? []).length !== want) fail('IR_INVALID', `${value.name} takes ${want} arguments`);
      if (p.p !== undefined || ps.length > 0) fail('IR_INVALID', 'value function pred may not carry p or ps');
      if (!['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte'].includes(p.op ?? '')) fail('OPERATOR_NOT_ALLOWED', `${p.op} with a value function`);
      this.params(value.ps);
      return;
    }
    if (p.op === 'match' || p.op === 'match_boolean') {
      const match = p.match ?? [];
      if (match.length === 0) fail('IR_INVALID', 'match needs columns');
      if (!(ent.fulltext ?? []).some(ft => ft.length === match.length && ft.every((c, i) => c === match[i]))) {
        fail('INDEX_UNKNOWN', `no fulltext index on ${ent.name}(${match.join(',')})`);
      }
      if (p.p === undefined) fail('IR_INVALID', 'match needs a value (p)');
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

  private sub(s: Subquery | undefined, scalar: boolean): void {
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
    if (s.query.limit || (s.query.relations ?? []).length > 0 || (s.query.lock ?? '') !== '' || s.query.columns) {
      fail('IR_INVALID', 'subquery may not use limit, relations, lock or columns');
    }
    this.query(s.query, false, false);
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

const kinds = new Set(['one', 'all', 'count', 'group_count', 'sum', 'avg', 'paginate', 'insert', 'update', 'delete']);

function hasGroupBy(q: RequestQuery): boolean {
  return (q.group_by ?? []).length > 0 || (q.group_by_expr ?? []).length > 0;
}

/** Checks a request against the manifest. */
export function validate(m: Manifest, r: Request): void {
  if (r.ir_version !== IR_VERSION) fail('VERSION_MISMATCH', `ir_version ${r.ir_version}, engine ${IR_VERSION}`);
  if (r.schema_hash !== m.schema_hash) fail('SCHEMA_HASH_MISMATCH', `client ${r.schema_hash}, engine ${m.schema_hash}`);
  if (!kinds.has(r.kind)) fail('IR_INVALID', `unknown kind "${r.kind}"`);
  const v = new Validator(m, r.n_params);
  v.query(r, false, false);
  if ((r.lock ?? '') !== '' && r.kind !== 'one' && r.kind !== 'all') fail('IR_INVALID', 'row lock is only valid on one or all');
  const ent = v.entity(r.entity);
  if (r.kind === 'sum' || r.kind === 'avg') {
    const c = columnOf(ent, r.agg ?? '') ?? fail('COLUMN_UNKNOWN', `${r.entity}.${r.agg ?? ''}`);
    if (!numericTypes.has(c.type)) fail('OPERATOR_NOT_ALLOWED', `${r.kind} on ${r.entity}.${r.agg} (${c.type})`);
  }
  if (r.kind === 'group_count' && !hasGroupBy(r)) fail('IR_INVALID', 'group_count needs group_by');
  if (r.kind === 'insert' || r.kind === 'update') {
    if ((r.set ?? []).length === 0) fail('IR_INVALID', `${r.kind} needs set[]`);
    for (const a of r.set!) v.assign(ent, r, a);
  }
  if ((r.rows ?? []).length > 0) {
    if (r.kind !== 'insert' || (r.on_duplicate ?? []).length > 0) fail('IR_INVALID', 'rows are only valid on insert without on_duplicate');
    for (const a of r.set ?? []) if (a.p === undefined) fail('IR_INVALID', `multi-row insert assigns ${r.entity}.${a.column} without a value`);
    r.rows!.forEach((row, i) => {
      if (row.length !== (r.set ?? []).length) fail('IR_INVALID', `insert row ${i + 1} has ${row.length} values for ${(r.set ?? []).length} columns`);
      v.params(row);
    });
  }
  if ((r.on_duplicate ?? []).length > 0) {
    if (r.kind !== 'insert') fail('IR_INVALID', 'on_duplicate is only valid on insert');
    for (const a of r.on_duplicate!) {
      v.assign(ent, r, a);
      const c = columnOf(ent, a.column)!;
      if (c.pk || c.auto) fail('IR_INVALID', `on_duplicate cannot assign ${r.entity}.${a.column}`);
    }
  }
  if (r.optimistic) {
    if (!columnOf(ent, r.optimistic.column)) fail('COLUMN_UNKNOWN', `${r.entity}.${r.optimistic.column}`);
    v.params([r.optimistic.p]);
  }
  if ((r.kind === 'update' || r.kind === 'delete') && (!r.where || r.where.items.length === 0)) fail('IR_INVALID', `${r.kind} without where`);
}
