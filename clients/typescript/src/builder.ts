import type { Assignment, Group, Item, Param, Predicate, QueryKind, Request, RequestQuery } from './index.js';
import type { Db } from './database.js';
import { OrmError } from './runtime_error.js';
import { encode, type CodecValue } from './codec.js';
import { cursorParams, decodeKeysetCursor, sameOrder } from './keyset.js';

export class ColumnReference {
  public constructor(public readonly column: string, public readonly path = '') {}
  public at(path: string): ColumnReference { return new ColumnReference(this.column, path); }
}

export class RequestState {
  public readonly ir: Request;
  public readonly params: Param[] = [];
  public deferredError?: OrmError;
  public constructor(entity: string, schemaHash = '') {
    this.ir = { ir_version: 1, schema_hash: schemaHash, kind: 'all', entity, n_params: 0 };
  }
  public parameter(value: Param): number { return this.params.push(value) - 1; }
  public shape(kind: QueryKind): Request { const ir = structuredClone(this.ir); ir.kind = kind; ir.n_params = this.params.length; return ir; }
  public attach(child: RequestState): RequestQuery {
    this.deferredError ??= child.deferredError;
    const offset = this.params.length;
    this.params.push(...child.params);
    const copy = structuredClone(child.ir) as Request;
    shiftQuery(copy, offset);
    const { ir_version: _version, schema_hash: _hash, kind: _kind, set: _set, on_duplicate: _duplicate, optimistic: _optimistic, raw: _raw, agg: _agg, debug: _debug, n_params: _count, ...query } = copy;
    return query;
  }
}

function shiftGroup(group: Group | undefined, offset: number): void {
  if (!group) return;
  for (const item of group.items) {
    if (item.pred) {
      if (item.pred.p !== undefined) item.pred.p += offset;
      if (item.pred.ps) item.pred.ps = item.pred.ps.map(value => value + offset);
    } else if (item.group) shiftGroup(item.group, offset);
    else if (item.nav) shiftGroup(item.nav.group, offset);
  }
}
function shiftQuery(query: RequestQuery, offset: number): void {
  if (query.scope_p !== undefined) query.scope_p += offset;
  shiftGroup(query.on, offset); shiftGroup(query.where, offset); shiftGroup(query.having, offset);
  for (const join of query.joins ?? []) shiftQuery(join.query, offset);
  for (const relation of query.relations ?? []) shiftQuery(relation.query, offset);
  if (query.if_parent) query.if_parent.p += offset;
}

export class WhereCore {
  private pendingConnector: 'or' | undefined;
  public constructor(public readonly request: RequestState, public readonly group: Group) {}
  public or(): this { this.pendingConnector = 'or'; return this; }
  private item(item: Item): void {
    if (this.pendingConnector) {
      if (item.pred) item.pred.conn = this.pendingConnector;
      else if (item.group) item.group.conn = this.pendingConnector;
      else if (item.nav) item.nav.conn = this.pendingConnector;
    }
    this.pendingConnector = undefined;
    this.group.items.push(item);
  }
  public predicate(column: string, operator: string, value: Param): this { this.item({ pred: { column, op: operator, p: this.request.parameter(value) } }); return this; }
  public predicateList(column: string, operator: string, values: readonly Param[]): this {
    const padded = (operator === 'in' || operator === 'not_in') ? pad(values) : [...values];
    this.item({ pred: { column, op: operator, ps: padded.map(value => this.request.parameter(value)) } }); return this;
  }
  public predicateNull(column: string, operator: string): this { this.item({ pred: { column, op: operator } }); return this; }
  public predicateColumn(column: string, operator: string, reference: ColumnReference): this { this.item({ pred: { column, op: operator, ref: { path: reference.path, column: reference.column } } }); return this; }
  public expression(expression: string, values: readonly Param[] = []): this { this.item({ pred: { expr: expression, ps: values.map(value => this.request.parameter(value)) } }); return this; }
  public match(columns: readonly string[], value: string, boolean = false): this { this.item({ pred: { op: boolean ? 'match_boolean' : 'match', match: [...columns], p: this.request.parameter(value) } }); return this; }
  public and(callback: (where: WhereCore) => void): this { const group: Group = { items: [] }; this.item({ group }); callback(new WhereCore(this.request, group)); return this; }
  public navigate(relation: string, callback: (where: WhereCore) => void): this { return this.navigateMode(relation, '', callback); }
  public navigateMode(relation: string, mode: '' | 'exists' | 'not_exists', callback: (where: WhereCore) => void): this { const group: Group = { items: [] }; this.item({ nav: { rel: relation, group, mode } }); callback(new WhereCore(this.request, group)); return this; }
}

export class Binding {
  public constructor(public readonly executor?: Db) {}
  public resolve(): Db { if (!this.executor) throw new OrmError('CONFIG', 'query has no database; call using(database) before a terminal'); return this.executor; }
}

export class QueryCore {
  public readonly request: RequestState;
  public binding: Binding = new Binding();
  public keySelector?: (row: unknown) => number | string | bigint;
  public linkSelection?: { parentKey: string; childKey: string };
  private rootWhere: WhereCore | undefined;
  public constructor(entity: string, schemaHash = '') { this.request = new RequestState(entity, schemaHash); }
  public using(database: Db): this { this.binding = new Binding(database); this.request.ir.schema_hash = database.schemaHash; return this; }
  public scope(value: Param): this { this.request.ir.scope_p = this.request.parameter(value); return this; }
  public whereCore(): WhereCore { this.request.ir.where ??= { items: [] }; return this.rootWhere ??= new WhereCore(this.request, this.request.ir.where); }
  protected onGroup(callback: (where: WhereCore) => void): this { this.request.ir.on ??= { items: [] }; callback(new WhereCore(this.request, this.request.ir.on)); return this; }
  protected havingGroup(callback: (where: WhereCore) => void): this { this.request.ir.having ??= { items: [] }; callback(new WhereCore(this.request, this.request.ir.having)); return this; }
  public predicate(column: string, operator: string, value: Param): this { this.whereCore().predicate(column, operator, value); return this; }
  public predicateList(column: string, operator: string, values: readonly Param[]): this { this.whereCore().predicateList(column, operator, values); return this; }
  public predicateNull(column: string, operator: string): this { this.whereCore().predicateNull(column, operator); return this; }
  public predicateColumn(column: string, operator: string, reference: ColumnReference): this { this.whereCore().predicateColumn(column, operator, reference); return this; }
  public expression(expression: string, values: readonly Param[] = []): this { this.whereCore().expression(expression, values); return this; }
  public or(): this { this.whereCore().or(); return this; }
  public match(columns: readonly string[], value: string, boolean = false): this { this.whereCore().match(columns, value, boolean); return this; }
  protected attachJoin(relation: string, child: QueryCore, kind: 'inner' | 'left' = 'inner'): this { this.request.ir.joins ??= []; this.request.ir.joins.push({ rel: relation, kind, query: this.request.attach(child.request) }); return this; }
  protected attachRelation(relation: string, child: QueryCore): this { this.request.ir.relations ??= []; this.request.ir.relations.push({ rel: relation, query: this.request.attach(child.request) }); return this; }
  public matchKeys(parentKey: string, childKey: string): this { this.linkSelection = { parentKey, childKey }; return this; }
  public selectAll(): this { return this.projectionMode('all'); }
  public selectNone(): this { return this.projectionMode('none'); }
  public select(column: string): this { (this.request.ir.columns ??= {}).add ??= []; this.request.ir.columns.add.push(column); return this; }
  public omit(column: string): this { (this.request.ir.columns ??= {}).remove ??= []; this.request.ir.columns.remove.push(column); return this; }
  public selectAs(alias: string, column: string): this { (this.request.ir.columns ??= {}).as ??= {}; this.request.ir.columns.as[alias] = column; return this; }
  public selectExpression(alias: string, expression: string): this { (this.request.ir.columns ??= {}).expr ??= {}; this.request.ir.columns.expr[alias] = expression; return this; }
  private projectionMode(mode: 'all' | 'none'): this { (this.request.ir.columns ??= {}).mode = mode; return this; }
  public orderBy(column: string, descending = false): this { this.request.ir.order ??= []; this.request.ir.order.push({ column, desc: descending }); return this; }
  public orderByExpression(expression: string, descending = false): this { this.request.ir.order ??= []; this.request.ir.order.push({ expr: expression, desc: descending }); return this; }
  public lock(mode: 'update' | 'share'): this { this.request.ir.lock = mode; return this; }
  public groupBy(column: string): this { this.request.ir.group_by ??= []; this.request.ir.group_by.push(column); return this; }
  public groupByExpression(expression: string, alias: string): this { this.request.ir.group_by_expr ??= []; this.request.ir.group_by_expr.push({ expr: expression, as: alias }); return this; }
  public limit(offset: number, count: number): this { this.request.ir.limit = { offset: uint(offset, 'limit offset'), count: uint(count, 'limit count') }; return this; }
  public keyset(direction: 'after'|'before', cursor: string, per: number, primaryKeys: readonly string[]): this {
    if (direction !== 'after' && direction !== 'before') throw new OrmError('CURSOR_INVALID', 'keyset direction must be after or before');
    if (!Number.isSafeInteger(per) || per < 1) throw new OrmError('IR_INVALID', 'keyset limit must be positive');
    if ((this.request.ir.order ?? []).length === 0) this.request.ir.order = primaryKeys.map(column => ({ column }));
    const order = this.request.ir.order ?? [];
    if (order.some(item => !item.column || item.expr)) throw new OrmError('CURSOR_INVALID', 'keyset order must use table columns');
    const seen = new Set<string>();
    for (const item of order) { if (seen.has(item.column!)) throw new OrmError('CURSOR_INVALID', `keyset order contains duplicate column ${item.column}`); seen.add(item.column!); }
    for (const column of primaryKeys) if (!seen.has(column)) { order.push({ column }); seen.add(column); }
    this.request.ir.limit = { offset: 0, count: per };
    if (cursor === '') { delete this.request.ir.keyset; return this; }
    const decoded = decodeKeysetCursor(cursor);
    if (!sameOrder(order, decoded.order)) throw new OrmError('CURSOR_INVALID', 'cursor order does not match query order');
    const values = cursorParams(decoded).map(value => this.request.parameter(value));
    this.request.ir.keyset = { direction, values };
    return this;
  }
  public distinct(): this { this.request.ir.distinct = true; return this; }
  public forceIndex(index: string): this { this.request.ir.force_index = index; return this; }
  public keyBy(column: string): this { this.request.ir.key_by = column; return this; }
  public keyByFunction(selector: (row: unknown) => number | string | bigint): this { this.keySelector = selector; return this; }
  public flatten(): this { this.request.ir.flatten = true; return this; }
  public limitPerParent(count: number): this { this.request.ir.limit_per_parent = uint(count, 'limit per parent'); return this; }
  public ifParent(column: string, value: Param): this { this.request.ir.if_parent = { column, p: this.request.parameter(value) }; return this; }
  public dropChildKey(): this { this.request.ir.drop_child_key = true; return this; }
  public noCascadeDelete(): this { this.request.ir.no_cascade_delete = true; return this; }
  public raw(sql: string, values: readonly Param[] = []): this { this.request.ir.raw = { sql, ps: values.map(value => this.request.parameter(value)) }; return this; }
  public set(column: string, value: Param): this { return this.assignment('set', { column, p: this.request.parameter(value) }); }
  public setEncoded(column: string, value: unknown, styles: readonly string[]): this { return this.set(column, encode(styles, value as CodecValue)); }
  public setNull(column: string): this { return this.assignment('set', { column, null: true }); }
  public setExpression(column: string, expression: string, values: readonly Param[] = []): this { return this.assignment('set', { column, expr: expression, ps: values.map(value => this.request.parameter(value)) }); }
  public plus(column: string, value: Param): this { return this.assignment('set', { column, plus_p: this.request.parameter(value) }); }
  public minus(column: string, value: Param): this { return this.assignment('set', { column, minus_p: this.request.parameter(value) }); }
  public duplicate(column: string, value: Param): this { return this.assignment('on_duplicate', { column, p: this.request.parameter(value) }); }
  public duplicateEncoded(column: string, value: unknown, styles: readonly string[]): this { return this.duplicate(column, encode(styles, value as CodecValue)); }
  public duplicateExpression(column: string, expression: string, values: readonly Param[] = []): this { return this.assignment('on_duplicate', { column, expr: expression, ps: values.map(value => this.request.parameter(value)) }); }
  public duplicatePlus(column: string, value: Param): this { return this.assignment('on_duplicate', { column, plus_p: this.request.parameter(value) }); }
  public duplicateMinus(column: string, value: Param): this { return this.assignment('on_duplicate', { column, minus_p: this.request.parameter(value) }); }
  public duplicateAll(skip: readonly string[] = []): this { const blocked=new Set(skip); this.request.ir.on_duplicate=(this.request.ir.set??[]).filter(value=>!blocked.has(value.column)).map(value=>structuredClone(value)); return this; }
  public optimistic(column: string, value: Param): this { this.request.ir.optimistic = { column, p: this.request.parameter(value) }; return this; }
  private assignment(target: 'set' | 'on_duplicate', assignment: Assignment): this {
    const assignments = this.request.ir[target] ??= [];
    const existing = assignments.findIndex(value => value.column === assignment.column);
    if (existing < 0) assignments.push(assignment); else assignments[existing] = assignment;
    return this;
  }
  public requestShape(kind: QueryKind = this.request.ir.kind): Request { return this.request.shape(kind); }
  public parameters(): Param[] { return [...this.request.params]; }
  protected async terminal(kind: QueryKind): Promise<unknown> { if (this.request.deferredError) throw this.request.deferredError; const database=this.binding.resolve(); return database.executeRequest(this.request.shape(kind), [...this.request.params]); }
  protected async terminalRows(): Promise<import('./model.js').ExecutionRows> { if (this.request.deferredError) throw this.request.deferredError; const database=this.binding.resolve(); return database.executeRowsRequest(this.request.shape('all'), [...this.request.params]); }
  protected async streamRows<T extends import('./model.js').Row>(visit: (row: T) => boolean | Promise<boolean>): Promise<import('./index.js').StreamResult> { if(this.request.deferredError)throw this.request.deferredError;const database=this.binding.resolve();return database.stream<T>(await database.plan(this.request.shape('all')),[...this.request.params],visit); }
  protected async insertKey(): Promise<unknown> { return (await this.terminal('insert') as { insertId: unknown }).insertId; }
  protected async writeAffected(kind: 'update'|'delete'): Promise<number> { return (await this.terminal(kind) as { affected: number }).affected; }
  protected async saveKeys(primaryKeys: readonly string[]): Promise<unknown[]> {
    const assignments = this.request.ir.set ?? [];
    const indexes = primaryKeys.map(key => assignments.findIndex(assignment => assignment.column === key));
    const present = indexes.filter(index => index >= 0).length;
    if (present === 0) return [await this.insertKey()];
    if (present !== primaryKeys.length) throw new OrmError('IR_INVALID', 'save requires every primary-key column or none');
    const selected = indexes.map(index => assignments[index]!);
    if (selected.some(assignment => assignment.p === undefined)) throw new OrmError('IR_INVALID', 'save primary-key assignments must use values');
    const removed = new Set(indexes);
    this.request.ir.set = assignments.filter((_, current) => !removed.has(current));
    this.request.ir.where ??= { items: [] };
    selected.forEach((assignment, index) => this.request.ir.where!.items.push({ pred: { column: primaryKeys[index]!, op: 'eq', p: assignment.p } }));
    await this.writeAffected('update');
    return selected.map(assignment => this.request.params[assignment.p!]);
  }
  protected assignedKeyValues(primaryKeys: readonly string[]): unknown[] {
    const assignments = this.request.ir.set ?? [];
    return primaryKeys.map(key => {
      const assignment = assignments.find(value => value.column === key);
      if (!assignment) throw new OrmError('IR_INVALID', 'insert requires every non-auto primary-key column');
      if (assignment.p === undefined) throw new OrmError('IR_INVALID', 'insert primary-key assignments must use values');
      return this.request.params[assignment.p];
    });
  }
  protected async statement(): Promise<{sql:string;binds:unknown[]}> { if(this.request.deferredError)throw this.request.deferredError; const database=this.binding.resolve(); const plan=await database.plan(this.request.shape('all')); return database.sql(plan.steps[0]!,this.request.params); }
}

function uint(value: number, name: string): number { if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new OrmError('IR_INVALID', `${name} is outside uint32`); return value; }
function pad(values: readonly Param[]): Param[] { if (values.length < 2) return [...values]; let size=1;while(size<values.length)size<<=1;const out=[...values];while(out.length<size)out.push(out[out.length-1]);return out; }
