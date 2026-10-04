// Turns a validated request into a plan: SELECT statements for the root and
// its joins, a separate statement per relation bound to the parent step's
// rows, and INSERT, UPDATE, and DELETE statements.
import type { Assemble, Assignment, BindSlot, Child, Group, KeyReference, OrmFunction, Plan, PlanStep, Predicate, Request, RequestQuery, Subquery } from '../ir.js';
import { OrmError } from '../runtime_error.js';
import { CURRENT_TIME_TOKEN, type Dialect } from './dialect.js';
import { entityOf, fieldOf as columnOf, type Entity, type Field as Column, type RuntimeModel } from './model.js';

/** One entity occurrence in a statement (root or join) with its alias. */
interface Scope {
  ent: Entity;
  alias: string;
  q: RequestQuery;
  joins: Map<string, Scope>;
  parent: Scope | undefined;
  /** The enclosing query of a subquery root ("^" references). */
  outer: Scope | undefined;
  /** Columns a relation step needs selected. */
  extra: string[];
}

/** The relation a step loads. */
interface RelationContext {
  parentStep: number;
  parentAsm: Assemble;
  parentKeys: string[];
  childKeys: string[];
  kind: string;
}

interface OutColumn {
  name: string;
  column: string;
  expr?: { sql: string; ps?: number[] };
  fn?: OrmFunction;
  sub?: Subquery;
}

function fail(code: string, message: string): never { throw new OrmError(code, message); }

function slot(fields: Partial<BindSlot> & { from: string }): BindSlot {
  return { param: 0, transform: '', name: '', step: 0, column: '', host_styles: [], col_type: '', ...fields };
}

class Builder {
  public readonly binds: BindSlot[] = [];
  public subs = 0;
  /** statement가 이름으로 쓴 table이다. */
  private readonly tableNames = new Set<string>();
  public constructor(private readonly d: Dialect) {}

  /** ent의 table 이름을 quote하고 statement의 table로 기록한다. */
  public table(ent: Entity): string {
    this.tableNames.add(ent.table);
    return this.d.quote(ent.table);
  }
  /** statement가 쓴 table을 정렬해 돌려준다. */
  public tables(): string[] { return [...this.tableNames].sort(); }

  private push(s: BindSlot): string {
    this.binds.push(s);
    return this.d.placeholder(this.binds.length);
  }
  public param(i: number, transform = ''): string { return this.push(slot({ from: 'param', param: i, transform })); }
  public secret(name: string): string { return this.push(slot({ from: 'secret', name })); }
  public config(name: string): string { return this.push(slot({ from: 'config', name })); }
  /** A timestamp the executor supplies (dialects without a sub-second clock) with p fraction digits. */
  public now(precision: number): string { return this.push(slot({ from: 'now', precision })); }
  /**
   * The key of the transaction's audit record, written to the audit column of an audited table. name is the
   * audit record table; the executor checks that the transaction's audit is a row of it.
   */
  public audit(ent: Entity): string {
    return this.push(slot({ from: 'audit', name: ent.auditRecord }));
  }
  /** The one placeholder an executor expands to the parent values. */
  public parentList(step: number): string { return this.push(slot({ from: 'parent', step })); }
  public last(): BindSlot { return this.binds[this.binds.length - 1]!; }
}

function cmp(op: string): string {
  switch (op) {
    case 'eq': return '=';
    case 'not_eq': return '!=';
    case 'gt': return '>';
    case 'gte': return '>=';
    case 'lt': return '<';
    case 'lte': return '<=';
  }
  throw new Error(`cmp: ${op}`);
}

function indexOf(a: Assemble, name: string): number {
  const col = a.columns.find(c => c.name === name);
  if (!col) throw new Error(`planner: column ${name} not projected in ${a.entity}`);
  return col.index;
}

function keyRefs(a: Assemble, columns: readonly string[]): KeyReference[] {
  return columns.map(column => ({ column, index: indexOf(a, column) }));
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sortedKeys(record: Readonly<Record<string, unknown>> | undefined): string[] {
  return Object.keys(record ?? {}).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

function hasGroupBy(q: RequestQuery): boolean {
  return (q.group_by ?? []).length > 0 || (q.group_by_expr ?? []).length > 0;
}

function styles(c: Column): readonly string[] { return c.stages; }

function aesVersionColumn(ent: Entity): string { return ent.aesVersion; }

function assignsAES(ent: Entity, set: readonly Assignment[]): boolean {
  return set.some(a => { const c = columnOf(ent, a.column); return c !== undefined && styles(c).includes('aes'); });
}

function assigned(set: readonly Assignment[], column: string): boolean { return set.some(a => a.column === column); }

/** One key version describes the whole row: an AES update replaces every AES column. */
function validateAESAssignments(ent: Entity, set: readonly Assignment[], requireComplete: boolean): void {
  const version = aesVersionColumn(ent);
  if (version === '') return;
  if (assigned(set, version)) fail('IR_INVALID', `${version} is managed by the AES writer`);
  if (!requireComplete || !assignsAES(ent, set)) return;
  for (const col of ent.fields) {
    if (styles(col).includes('aes') && !assigned(set, col.name)) fail('IR_INVALID', `AES update must assign every AES column; missing ${col.name}`);
  }
}

/**
 * An insert assigns every required column: a NOT NULL column without a
 * default that is neither the identity column nor a column the planner writes
 * (the AES key version and the audit column). An omitted column with a
 * default takes the database default.
 */
function validateRequiredAssignments(ent: Entity, set: readonly Assignment[]): void {
  for (const col of ent.fields) {
    if (col.nullable || col.hasDefault || col.identity || col.name === ent.aesVersion || col.name === ent.auditColumn || assigned(set, col.name)) continue;
    fail('IR_INVALID', `required column ${ent.name}.${col.name} is not set`);
  }
}

function addBlindIndexAssignments(ent: Entity, set: Assignment[]): Assignment[] {
  for (const a of [...set]) {
    const col = columnOf(ent, a.column);
    if (!col || col.blindIndex === '' || assigned(set, col.blindIndex)) continue;
    set.push({ column: col.blindIndex, p: a.p, null: a.null });
  }
  return set;
}

function blindIndexSource(ent: Entity, target: string): Column | undefined {
  return ent.fields.find(c => c.blindIndex === target);
}

/** The unique key an upsert conflicts on: the first unique key fully inserted, else the primary key. */
function conflictTarget(ent: Entity, set: readonly Assignment[]): readonly string[] {
  const inserted = new Set(set.map(a => a.column));
  for (const uk of ent.uniques) if (uk.every(c => inserted.has(c))) return uk;
  return ent.primaryKey;
}

/** Normalized bind type for executors without a date type. */
function bindType(col: Column | undefined): string {
  switch (col?.type) {
    case 'date': case 'time': case 'datetime': case 'decimal': return col.type;
  }
  return '';
}

function functionType(name: string, col: Column | undefined): string {
  switch (name) {
    case 'day_of_week': case 'year': case 'month': return 'i64';
    case 'date': return 'date';
  }
  return col?.type ?? 'string';
}

function placedJoins(g: Group, out: Set<string>): void {
  for (const it of g.items) {
    if (it.joined) out.add(it.joined.join);
    if (it.group) placedJoins(it.group, out);
  }
}

export class Planner {
  public constructor(public readonly m: RuntimeModel, public readonly d: Dialect) {}

  private entity(name: string): Entity { return entityOf(this.m, name)!; }

  public compile(r: Request): Plan {
    const steps: PlanStep[] = [];
    const add = (st: Omit<PlanStep, 'id'>): PlanStep => {
      const step = { id: steps.length, ...st } as PlanStep;
      steps.push(step);
      return step;
    };
    switch (r.kind) {
      case 'one': case 'all': case 'count': case 'group_count': case 'sum': case 'avg':
        this.selectStep(add, steps, r, r.kind, r.agg ?? '', undefined);
        break;
      case 'paginate':
        // main (and its relation steps), then the count step
        this.selectStep(add, steps, r, 'all', '', undefined);
        this.selectStep(add, steps, r, 'count', '', undefined);
        break;
      case 'insert': add(this.insertStep(r)); break;
      case 'update': add(this.updateStep(r)); break;
      case 'delete': add(this.deleteStep(r)); break;
      case 'restore': add(this.restoreStep(r)); break;
    }
    return { manifest_hash: this.m.manifestHash, kind: r.kind, steps };
  }

  /** Deterministic aliases: root "a", joins by name (nested joins prefixed by the parent alias). */
  private buildScopes(q: RequestQuery, alias: string, parent: Scope | undefined): Scope {
    const s: Scope = { ent: this.entity(q.entity), alias, q, joins: new Map(), parent, outer: undefined, extra: [] };
    for (const j of q.joins ?? []) {
      const ja = parent !== undefined || alias !== 'a' ? `${alias}__${j.rel}` : j.rel;
      s.joins.set(j.rel, this.buildScopes(j.query, ja, s));
    }
    return s;
  }

  private qcol(s: Scope, col: string): string { return `${this.d.quote(s.alias)}.${this.d.quote(col)}`; }

  private qualified(s: Scope, columns: readonly string[]): string[] { return columns.map(c => this.qcol(s, c)); }

  private sqlStyles(list: readonly string[]): string[] { return list.filter(s => this.d.handlesStage(s)); }

  private clientStyles(list: readonly string[]): string[] { return list.filter(s => !this.d.handlesStage(s)); }

  private selectStep(add: (st: Omit<PlanStep, 'id'>) => PlanStep, steps: readonly PlanStep[], q: RequestQuery, kind: string, agg: string, rc: RelationContext | undefined): PlanStep {
    const b = new Builder(this.d);
    const root = this.buildScopes(q, 'a', undefined);
    if (rc) {
      root.extra.push(...rc.childKeys);
      if ((q.key_by ?? '') !== '') root.extra.push(q.key_by!);
    }
    let sql = 'SELECT ';
    const asm: Assemble = { entity: root.ent.name, alias: root.alias, columns: [], children: [], key: [] };
    const outNames: string[] = [];
    const idx = { n: 0 };
    const groupCount = kind === 'count' && hasGroupBy(q);
    const groupRows = kind === 'group_count';
    switch (kind) {
      case 'count':
        sql += groupCount ? '1' : 'COUNT(*)';
        break;
      case 'sum':
        sql += `COALESCE(SUM(${this.qcol(root, agg)}), 0)`;
        break;
      case 'avg':
        sql += `AVG(${this.qcol(root, agg)})`;
        break;
      case 'group_count': {
        sql += this.selectGroupCountList(b, root, asm, idx, outNames);
        asm.key = keyRefs(asm, [...q.group_by ?? [], ...(q.group_by_expr ?? []).map(g => g.as)]);
        break;
      }
      default:
        sql += this.selectList(b, root, asm, idx, outNames);
        asm.key = keyRefs(asm, root.ent.primaryKey);
    }
    // Rows per parent: ROW_NUMBER() over the match columns. A one relation
    // with an order is the same with n = 1.
    let perParent = 0;
    if (rc) {
      perParent = q.limit_per_parent ?? 0;
      if (perParent === 0 && rc.kind === 'one' && (q.order ?? []).length > 0) perParent = 1;
    }
    if (perParent > 0) {
      let order = this.renderOrder(b, root, q);
      if (order === '') order = ` ORDER BY ${this.qcol(root, root.ent.primaryKey[0]!)} ASC`;
      sql += `, ROW_NUMBER() OVER (PARTITION BY ${this.qualified(root, rc!.childKeys).join(', ')}${order}) AS ${this.d.quote('orm_rn')}`;
    }
    sql += ` FROM ${b.table(root.ent)} AS ${this.d.quote(root.alias)}`;
    if ((q.force_index ?? '') !== '') sql += this.d.forceIndex(q.force_index!);
    sql += this.renderJoins(b, root);
    const where: string[] = [];
    if (rc) {
      if (rc.childKeys.length === 1) where.push(`${this.qcol(root, rc.childKeys[0]!)} IN (${b.parentList(rc.parentStep)})`);
      else where.push(`(${this.qualified(root, rc.childKeys).join(', ')}) IN ((${b.parentList(rc.parentStep)}))`);
    }
    if (root.ent.softDelete) where.push(`${this.qcol(root, root.ent.softDelete)} IS NULL`);
    if (q.where && q.where.items.length > 0) where.push(this.renderGroup(b, root, q.where, rc === undefined));
    this.collectJoinWhere(b, root, where);
    if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
    // GROUP BY applies to row selects and group counts; scalar aggregates ignore it.
    if (hasGroupBy(q) && (kind === 'one' || kind === 'all' || groupCount || groupRows)) {
      sql += ` GROUP BY ${this.renderGroupBy(root, q)}`;
    }
    if (groupCount) sql = `SELECT COUNT(*) FROM (${sql}) AS ${this.d.quote('orm_g')}`;
    if (kind === 'one' || kind === 'all' || kind === 'group_count') {
      if (perParent > 0) {
        // keep the output columns in order, drop orm_rn, cut at n per parent
        const w = this.d.quote('orm_w');
        let outer = `SELECT ${outNames.map(n => `${w}.${this.d.quote(n)}`).join(', ')}`;
        outer += ` FROM (${sql}) AS ${w} WHERE ${w}.${this.d.quote('orm_rn')} <= ${perParent}`;
        outer += ` ORDER BY ${rc!.childKeys.map(key => `${w}.${this.d.quote(`${root.alias}__${key}`)}`).join(', ')}`;
        outer += `, ${w}.${this.d.quote('orm_rn')}`;
        sql = outer;
      } else {
        sql += this.renderOrder(b, root, q);
        if (kind === 'one' && rc === undefined) sql += this.d.limit(0, 1);
        else if (q.limit) sql += this.d.limit(q.limit.offset, q.limit.count);
        const lock = q.lock ?? '';
        if (lock !== '') {
          const suffix = this.d.rowLock(lock);
          if (suffix === undefined) fail('CAPABILITY_UNSUPPORTED', `${this.d.name} row lock "${lock}" is not supported`);
          sql += suffix;
        }
      }
    }
    const st: Omit<PlanStep, 'id'> = { role: 'main', sql, tables: b.tables(), bind_slots: b.binds };
    if ((q.lock ?? '') !== '') st.lock = q.lock;
    if (kind === 'count' && steps.length > 0) st.role = 'count';
    else if (rc) {
      st.role = 'relation';
      st.parent = { step: rc.parentStep, keys: keyRefs(rc.parentAsm, rc.parentKeys) };
      if (q.if_parent) st.parent.if_parent = { column: q.if_parent.column, index: indexOf(rc.parentAsm, q.if_parent.column), param: q.if_parent.p };
    }
    if (kind === 'one' || kind === 'all' || kind === 'group_count') st.assemble = asm;
    const step = add(st);
    if (step.assemble) this.relationSteps(add, steps, root, asm, step.id);
    return step;
  }

  /** A step per relation of s (and of its joins); records how rows attach. */
  private relationSteps(add: (st: Omit<PlanStep, 'id'>) => PlanStep, steps: readonly PlanStep[], s: Scope, asm: Assemble, stepId: number): void {
    for (const r of s.q.relations ?? []) {
      const rc: RelationContext = { parentStep: stepId, parentAsm: asm, parentKeys: r.keys!.map(k => k.left), childKeys: r.keys!.map(k => k.right), kind: r.kind! };
      const target = this.entity(r.query.entity);
      const st = this.selectStep(add, steps, r.query, 'all', '', rc);
      const child: Child = {
        rel: r.rel, kind: rc.kind, step: st.id,
        parent_keys: keyRefs(asm, rc.parentKeys),
        child_keys: keyRefs(st.assemble!, rc.childKeys),
        key: [],
        flatten: r.query.flatten ?? false,
        // owned when the child holds the foreign key to this row's primary key
        cascade: !(r.query.no_cascade_delete ?? false) && sameList(rc.parentKeys, s.ent.primaryKey) && !sameList(rc.childKeys, target.primaryKey),
      };
      child.key = keyRefs(st.assemble!, (r.query.key_by ?? '') !== '' ? [r.query.key_by!] : this.entity(st.assemble!.entity).primaryKey);
      asm.children.push(child);
    }
    for (const j of s.q.joins ?? []) {
      const js = s.joins.get(j.rel)!;
      for (const ch of asm.children) {
        if (ch.kind === 'join' && ch.rel === j.rel) this.relationSteps(add, steps, js, ch.assemble!, stepId);
      }
    }
  }

  private renderOrder(b: Builder, root: Scope, q: RequestQuery): string {
    const order = q.order ?? [];
    if (order.length === 0) return '';
    const parts = order.map(o => {
      if (o.random) return this.d.random();
      // A raw order expression carries its own direction.
      if ((o.expr ?? '') !== '') return this.renderExpr(root, o.expr!);
      const target = o.fn ? this.columnFunction(b, root, o.column!, o.fn) : this.qcol(root, o.column!);
      return target + (o.desc ? ' DESC' : ' ASC');
    });
    return ` ORDER BY ${parts.join(', ')}`;
  }

  private renderGroupBy(root: Scope, q: RequestQuery): string {
    return [
      ...(q.group_by ?? []).map(name => this.qcol(root, name)),
      ...(q.group_by_expr ?? []).map(g => this.renderExpr(root, g.expr)),
    ].join(', ');
  }

  /** The grouped columns and row_count of a grouped count, assembled as the root entity. */
  private selectGroupCountList(b: Builder, s: Scope, asm: Assemble, idx: { n: number }, outNames: string[]): string {
    const parts: string[] = [];
    for (const name of s.q.group_by ?? []) {
      const col = columnOf(s.ent, name) ?? fail('COLUMN_UNKNOWN', `${s.ent.name}.${name}`);
      const out = `${s.alias}__${name}`;
      parts.push(`${this.d.readExpr(this.qcol(s, name), this.sqlStyles(styles(col)))} AS ${this.d.quote(out)}`);
      outNames.push(out);
      asm.columns.push({ index: idx.n++, name, column: name, type: col.type, styles: this.clientStyles(styles(col)), hidden: false });
    }
    for (const g of s.q.group_by_expr ?? []) {
      const out = `${s.alias}__${g.as}`;
      parts.push(`${this.renderExpr(s, g.expr)} AS ${this.d.quote(out)}`);
      outNames.push(out);
      asm.columns.push({ index: idx.n++, name: g.as, column: '', type: 'string', styles: [], hidden: false });
    }
    const out = `${s.alias}__row_count`;
    parts.push(`COUNT(*) AS ${this.d.quote(out)}`);
    outNames.push(out);
    asm.columns.push({ index: idx.n++, name: 'row_count', column: '', type: 'i64', styles: [], hidden: false });
    return parts.join(', ');
  }

  /** The projection of a scope and its joins; join columns become join children. */
  private selectList(b: Builder, s: Scope, asm: Assemble, idx: { n: number }, outNames: string[]): string {
    const parts: string[] = [];
    let hasAES = false;
    for (const c of this.projection(s)) {
      let col = c.column === '' ? undefined : columnOf(s.ent, c.column);
      if (col && styles(col).includes('aes')) hasAES = true;
      let expr: string;
      let colStyles: string[] = [];
      let type = 'string';
      if (c.fn) {
        expr = this.columnFunction(b, s, c.column, c.fn);
        type = functionType(c.fn.name, col);
        col = undefined;
      } else if (c.sub) {
        expr = `(${this.subSelect(b, s, c.sub)})`;
        type = this.subType(c.sub);
      } else if (c.expr) {
        expr = this.fillPlaceholders(b, this.renderExpr(s, c.expr.sql), c.expr.ps ?? []);
      } else {
        expr = this.d.readExpr(this.qcol(s, c.column), this.sqlStyles(styles(col!)));
        colStyles = this.clientStyles(styles(col!));
      }
      const out = `${s.alias}__${c.name}`;
      parts.push(`${expr} AS ${this.d.quote(out)}`);
      outNames.push(out);
      if (col) type = col.type;
      asm.columns.push({ index: idx.n++, name: c.name, column: c.column, type, styles: colStyles, hidden: false });
    }
    if (hasAES) {
      const version = columnOf(s.ent, s.ent.aesVersion) ?? fail('SCHEMA_INVALID', `${s.ent.name}: AES column requires an aes_version column`);
      // 고른 version column이 있으면 그것을 쓰고, 없을 때만 숨겨서 읽는다.
      const chosen = asm.columns.findIndex(c => c.column === version.name && c.styles.length === 0);
      if (chosen >= 0) asm.aes_version = chosen;
      else {
        const out = `${s.alias}__${version.name}`;
        parts.push(`${this.qcol(s, version.name)} AS ${this.d.quote(out)}`);
        outNames.push(out);
        asm.aes_version = asm.columns.length;
        asm.columns.push({ index: idx.n++, name: version.name, column: version.name, type: version.type, styles: [], hidden: true });
      }
    }
    let sql = parts.join(', ');
    for (const j of s.q.joins ?? []) {
      const js = s.joins.get(j.rel)!;
      const child: Child = { rel: j.rel, kind: 'join', step: 0, parent_keys: [], child_keys: [], key: [], flatten: false, cascade: false, assemble: { entity: js.ent.name, alias: js.alias, columns: [], children: [], key: [] } };
      const joined = this.selectList(b, js, child.assemble!, idx, outNames);
      if (joined !== '') sql += (sql === '' ? '' : ', ') + joined;
      asm.children.push(child);
    }
    asm.key = keyRefs(asm, s.ent.primaryKey);
    return sql;
  }

  /** Resolves mode, add, remove, and named outputs into an ordered list. */
  private projection(s: Scope): OutColumn[] {
    const c = s.q.columns;
    const mode = c?.mode ?? '';
    let base: string[] = [];
    for (const col of s.ent.fields) {
      if (mode === 'all') base.push(col.name);
      else if (mode === 'none') { if (col.primary || col.foreign) base.push(col.name); }
      else if (col.selected) base.push(col.name);
    }
    const push = (name: string) => { if (!base.includes(name)) base.push(name); };
    if (c) {
      for (const a of c.add ?? []) push(a);
      if ((c.remove ?? []).length > 0) base = base.filter(x => !c.remove!.includes(x) || columnOf(s.ent, x)!.primary);
    }
    // Columns relation steps bind or key on are always selected.
    for (const x of s.extra) push(x);
    for (const r of s.q.relations ?? []) {
      for (const k of r.keys!) push(k.left);
      if (r.query.if_parent) push(r.query.if_parent.column);
    }
    // The primary key is always selected.
    for (const pk of s.ent.primaryKey) if (!base.includes(pk)) base = [pk, ...base];
    const out: OutColumn[] = base.map(x => ({ name: x, column: x }));
    if (c) {
      for (const name of sortedKeys(c.expr)) out.push({ name, column: '', expr: c.expr![name] });
      for (const name of sortedKeys(c.fn)) out.push({ name, column: c.fn![name]!.column, fn: c.fn![name]!.fn });
      for (const name of sortedKeys(c.sub)) out.push({ name, column: '', sub: c.sub![name] });
    }
    return out;
  }

  private renderJoins(b: Builder, s: Scope): string {
    let sql = '';
    for (const j of s.q.joins ?? []) {
      const js = s.joins.get(j.rel)!;
      const conditions = [`${this.qcol(s, j.left!)} = ${this.qcol(js, j.right!)}`];
      sql += `${j.kind === 'left' ? ' LEFT JOIN ' : ' INNER JOIN '}${b.table(js.ent)} AS ${this.d.quote(js.alias)} ON ${conditions.join(' AND ')}`;
      if (j.query.on && j.query.on.items.length > 0) sql += ` AND ${this.renderGroup(b, js, j.query.on, true)}`;
      sql += this.renderJoins(b, js);
    }
    return sql;
  }

  /** Appends each join's where group (and its nested joins') unless a group places it. */
  private collectJoinWhere(b: Builder, s: Scope, where: string[]): void {
    const placed = new Set<string>();
    if (s.q.where) placedJoins(s.q.where, placed);
    for (const j of s.q.joins ?? []) {
      const js = s.joins.get(j.rel)!;
      if (j.query.where && j.query.where.items.length > 0 && !placed.has(j.rel)) where.push(this.renderGroup(b, js, j.query.where, false));
      this.collectJoinWhere(b, js, where);
    }
  }

  /** A group; top omits the outer parentheses. */
  private renderGroup(b: Builder, s: Scope, g: Group, top: boolean): string {
    const parts: string[] = [];
    g.items.forEach((it, i) => {
      let conn: string | undefined;
      let text: string;
      if (it.pred) {
        conn = it.pred.conn;
        text = this.renderPred(b, s, it.pred);
      } else if (it.group) {
        conn = it.group.conn;
        text = this.renderGroup(b, s, it.group, false);
      } else {
        conn = it.joined!.conn;
        const js = s.joins.get(it.joined!.join)!;
        text = this.renderGroup(b, js, js.q.where!, false);
      }
      if (i > 0) parts.push(conn === 'or' ? 'OR' : 'AND');
      parts.push(text);
    });
    const out = parts.join(' ');
    return top ? out : `(${out})`;
  }

  private renderPred(b: Builder, s: Scope, pr: Predicate): string {
    const op = pr.op ?? '';
    if ((pr.expr ?? '') !== '') return `(${this.fillPlaceholders(b, this.renderExpr(s, pr.expr!), pr.ps ?? [])})`;
    if (op === 'tuple_in' || op === 'tuple_not_in') {
      const cols = pr.cols!;
      const ps = pr.ps!;
      const rows: string[][] = [];
      for (let i = 0; i < ps.length; i += cols.length) {
        rows.push(cols.map((name, k) => this.renderValue(b, columnOf(s.ent, name)!, ps[i + k]!)));
      }
      return this.d.tupleIn(this.qualified(s, cols), rows, op === 'tuple_not_in');
    }
    const col = columnOf(s.ent, pr.column!)!;
    let lhs = this.qcol(s, pr.column!);
    if (pr.sub) return `${lhs}${op === 'not_in' ? ' NOT IN ' : ' IN '}(${this.subSelect(b, s, pr.sub)})`;
    if (pr.value) {
      const fn = pr.value;
      const value = this.d.valueFunction(fn.name, () => b.param(fn.ps![0]!), () => b.now(col.type === 'datetime' ? col.precision : 6));
      if (value === undefined) fail('CAPABILITY_UNSUPPORTED', `${fn.name} is not available on ${this.d.name}`);
      return `${lhs} ${cmp(op)} ${value}`;
    }
    if (pr.fn) {
      const fn = this.columnFunction(b, s, pr.column!, pr.fn);
      switch (op) {
        case 'in': case 'not_in':
          return `${fn}${op === 'not_in' ? ' NOT IN ' : ' IN '}(${pr.ps!.map(i => b.param(i)).join(', ')})`;
        case 'between':
          return `${fn} BETWEEN ${b.param(pr.ps![0]!)} AND ${b.param(pr.ps![1]!)}`;
      }
      return `${fn} ${cmp(op)} ${b.param(pr.p!)}`;
    }
    const aes = styles(col).includes('aes');
    switch (op) {
      case 'eq': case 'not_eq': case 'gt': case 'gte': case 'lt': case 'lte': {
        if (aes) {
          if (op !== 'eq' && op !== 'not_eq') fail('OPERATOR_NOT_ALLOWED', 'AES columns support only equality through a declared blind index');
          if (col.blindIndex === '') fail('IR_INVALID', `${s.ent.name}.${col.name} requires a declared blind index for equality search`);
          lhs = this.qcol(s, col.blindIndex);
          return `${lhs} ${cmp(op)} ${this.renderBlindIndexValue(b, pr.p!)}`;
        }
        return `${lhs} ${cmp(op)} ${this.renderValue(b, col, pr.p!)}`;
      }
      case 'eq_col': case 'not_eq_col': case 'gt_col': case 'gte_col': case 'lt_col': case 'lte_col': {
        const rs = this.resolvePath(s, pr.ref!.path);
        if (!columnOf(rs.ent, pr.ref!.column)) fail('COLUMN_UNKNOWN', `${rs.ent.name}.${pr.ref!.column}`);
        return `${lhs} ${cmp(op.slice(0, -4))} ${this.qcol(rs, pr.ref!.column)}`;
      }
      case 'in': case 'not_in': {
        let values: string[];
        if (aes) {
          if (col.blindIndex === '') fail('IR_INVALID', `${s.ent.name}.${col.name} requires a declared blind index for equality search`);
          lhs = this.qcol(s, col.blindIndex);
          values = pr.ps!.map(i => this.renderBlindIndexValue(b, i));
        } else {
          values = pr.ps!.map(i => this.renderValue(b, col, i));
        }
        return `${lhs} ${op === 'not_in' ? 'NOT IN' : 'IN'} (${values.join(', ')})`;
      }
      case 'between':
        return `${lhs} BETWEEN ${this.renderValue(b, col, pr.ps![0]!)} AND ${this.renderValue(b, col, pr.ps![1]!)}`;
      case 'is_null':
        return `${lhs} IS NULL`;
      case 'is_not_null':
        return `${lhs} IS NOT NULL`;
      case 'contains':
        return this.d.like(lhs, b.param(pr.p!, 'like_contains'));
      case 'contains_binary':
        return this.d.containsBinary(lhs, transform => b.param(pr.p!, transform));
    }
    return fail('OPERATOR_UNKNOWN', op);
  }

  /** Binds one value; SQL-side stages wrap it, host-side stages are recorded on the slot. */
  private renderValue(b: Builder, col: Column, i: number): string {
    const host = styles(col).filter(st => (st === 'aes' || st === 'hex' || st === 'ip') && !this.d.handlesStage(st));
    const ph = b.param(i);
    b.last().host_styles = host;
    b.last().col_type = bindType(col);
    if (col.type === 'decimal' || col.type === 'time' || col.type === 'datetime') b.last().precision = col.precision;
    if (col.type === 'decimal') b.last().scale = col.scale;
    return this.d.writeExpr(ph, this.sqlStyles(styles(col)));
  }

  /** Binds plaintext that the executor hashes with the blind index key. */
  private renderBlindIndexValue(b: Builder, i: number): string {
    const ph = b.param(i);
    b.last().host_styles = ['blind_index'];
    return ph;
  }

  private resolvePath(s: Scope, path: string): Scope {
    let cur = s;
    while (cur.parent) cur = cur.parent;
    if (path === '^') return cur.outer ?? fail('IR_INVALID', '^ reference outside a subquery');
    if (path === '') return cur;
    for (const seg of path.split('/')) cur = cur.joins.get(seg) ?? fail('ENTITY_NOT_JOINED', `${cur.ent.name}.${seg}`);
    return cur;
  }

  /** Checks {column} and `column` names of a fragment and qualifies them. */
  private renderExpr(s: Scope, frag: string): string {
    frag = frag.replaceAll(CURRENT_TIME_TOKEN, this.d.currentTime());
    let out = '';
    let i = 0;
    while (i < frag.length) {
      const c = frag[i]!;
      if (c !== '{' && c !== '`') { out += c; i++; continue; }
      const close = c === '{' ? '}' : '`';
      const j = frag.indexOf(close, i + 1);
      if (j < 0) fail('IR_INVALID', `unterminated ${c} in expr`);
      const name = frag.slice(i + 1, j);
      if (!columnOf(s.ent, name)) fail('COLUMN_UNKNOWN', `${s.ent.name}.${name} in expr`);
      out += this.qcol(s, name);
      i = j + 1;
    }
    return out;
  }

  /** Replaces each `?` of a fragment with the dialect placeholder of the next bind. */
  private fillPlaceholders(b: Builder, frag: string, ps: readonly number[]): string {
    const count = frag.split('?').length - 1;
    if (count !== ps.length) fail('IR_INVALID', `fragment has ${count} placeholders but ${ps.length} binds`);
    let k = 0;
    return frag.replace(/\?/g, () => b.param(ps[k++]!));
  }

  private columnFunction(b: Builder, s: Scope, column: string, f: OrmFunction): string {
    return this.d.columnFunction(f.name, this.qcol(s, column), i => b.param(f.ps![i]!)) ?? fail('CAPABILITY_UNSUPPORTED', `${f.name} is not available on ${this.d.name}`);
  }

  /** A subquery for an IN list or a scalar column; "^" refers to outer. */
  private subSelect(b: Builder, outer: Scope, sub: Subquery): string {
    b.subs++;
    const root = this.buildScopes(sub.query, `s${b.subs}`, undefined);
    root.outer = outer;
    let sql = 'SELECT ';
    switch (sub.agg ?? '') {
      case 'sum': sql += `COALESCE(SUM(${this.qcol(root, sub.column!)}), 0)`; break;
      case 'avg': sql += `AVG(${this.qcol(root, sub.column!)})`; break;
      case 'count': sql += 'COUNT(*)'; break;
      default: sql += this.qcol(root, sub.column!);
    }
    sql += ` FROM ${b.table(root.ent)} AS ${this.d.quote(root.alias)}`;
    sql += this.renderJoins(b, root);
    const where: string[] = [];
    if (root.ent.softDelete) where.push(`${this.qcol(root, root.ent.softDelete)} IS NULL`);
    if (sub.query.where && sub.query.where.items.length > 0) where.push(this.renderGroup(b, root, sub.query.where, true));
    this.collectJoinWhere(b, root, where);
    if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
    if ((sub.query.group_by ?? []).length > 0) sql += ` GROUP BY ${this.renderGroupBy(root, sub.query)}`;
    return sql;
  }

  private subType(sub: Subquery): string {
    switch (sub.agg) {
      case 'count': return 'i64';
      case 'avg': return 'f64';
    }
    return columnOf(this.entity(sub.query.entity), sub.column ?? '')?.type ?? 'string';
  }

  private renderAssign(b: Builder, ent: Entity, col: Column, a: Assignment): string {
    if (blindIndexSource(ent, col.name)) {
      if ((a.expr ?? '') !== '' || a.plus_p !== undefined || a.minus_p !== undefined) fail('IR_INVALID', 'blind index assignment must use its AES source value');
      if (a.null) return 'NULL';
      return this.renderBlindIndexValue(b, a.p!);
    }
    if ((a.expr ?? '') !== '') {
      const scope: Scope = { ent, alias: ent.table, q: { entity: ent.name }, joins: new Map(), parent: undefined, outer: undefined, extra: [] };
      return this.fillPlaceholders(b, this.renderExpr(scope, a.expr!), a.ps ?? []);
    }
    // table-qualified: a bare name is ambiguous inside ON CONFLICT DO UPDATE
    const q = `${this.d.quote(ent.table)}.${this.d.quote(col.name)}`;
    if (a.plus_p !== undefined) return `${q} + ${b.param(a.plus_p)}`;
    if (a.minus_p !== undefined) {
      const ph = b.param(a.minus_p);
      return `CASE WHEN ${q} > ${ph} THEN ${q} - ${b.param(a.minus_p)} ELSE 0 END`;
    }
    if (a.null) return 'NULL';
    return this.renderValue(b, col, a.p!);
  }

  /**
   * update time과 soft deletion이 datetime column에 쓰는 clock이다. sub-second clock이 없는
   * dialect는 executor의 microsecond `now` slot을 bind하고, 나머지는 column의 소수 자리로
   * dialect의 database clock을 쓴다.
   */
  private clock(b: Builder, col: Column): string {
    return this.d.hostNow ? b.now(col.precision) : this.d.now(col.precision);
  }

  /** The assignment of the audit column of an audited table, or undefined. */
  private auditAssignment(b: Builder, ent: Entity): string | undefined {
    if (ent.auditColumn === '') return undefined;
    return `${this.d.quote(ent.auditColumn)} = ${b.audit(ent)}`;
  }

  /**
   * insert가 사용자 assignment 외에 쓰는 column이다: AES key version, audit column,
   * sub-second clock이 없는 dialect에서 assign되지 않은 `default now` column(field 순서).
   * 그런 dialect의 database clock은 millisecond만 가지므로 executor의 microsecond clock을 쓴다.
   */
  private managedInsertColumns(ent: Entity, set: readonly Assignment[]): { column: string; value: (b: Builder) => string }[] {
    const out: { column: string; value: (b: Builder) => string }[] = [];
    const version = aesVersionColumn(ent);
    if (version !== '' && !assigned(set, version)) out.push({ column: version, value: b => b.config('aes_version') });
    if (ent.auditColumn !== '') {
      out.push({ column: ent.auditColumn, value: b => b.audit(ent) });
    }
    if (this.d.hostNow) {
      for (const f of ent.fields) {
        if (f.defaultNow && !assigned(set, f.name)) out.push({ column: f.name, value: b => b.now(f.precision) });
      }
    }
    return out;
  }

  private insertStep(r: Request): Omit<PlanStep, 'id'> {
    const b = new Builder(this.d);
    const ent = this.entity(r.entity);
    const input = r.set ?? [];
    const set = addBlindIndexAssignments(ent, [...input]);
    validateAESAssignments(ent, set, false);
    validateRequiredAssignments(ent, set);
    const version = aesVersionColumn(ent);
    const cols: string[] = [];
    const vals: string[] = [];
    for (const a of set) {
      const col = columnOf(ent, a.column)!;
      if (col.identity) fail('IR_INVALID', `cannot set identity column ${a.column}`);
      cols.push(this.d.quote(a.column));
      vals.push(this.renderAssign(b, ent, col, a));
    }
    // executor가 관리하는 column은 사용자 assignment 뒤에 AES key version, audit column,
    // `default now` column 순서로 쓴다.
    const managed = this.managedInsertColumns(ent, set);
    for (const c of managed) {
      cols.push(this.d.quote(c.column));
      vals.push(c.value(b));
    }
    let sql = `INSERT INTO ${b.table(ent)} (${cols.join(', ')}) VALUES (${vals.join(', ')})`;
    if ((r.rows ?? []).length > 0) {
      // Derived blind-index columns take the value of their AES source column.
      const source = set.map((a, i) => i < input.length ? i : input.findIndex(x => x.column === blindIndexSource(ent, a.column)!.name));
      for (const row of r.rows!) {
        const more = set.map((a, i) => this.renderAssign(b, ent, columnOf(ent, a.column)!, { column: a.column, p: row[source[i]!] }));
        for (const c of managed) more.push(c.value(b));
        sql += `, (${more.join(', ')})`;
      }
      return { role: 'main', sql, tables: b.tables(), bind_slots: b.binds };
    }
    if ((r.on_duplicate ?? []).length > 0) {
      const duplicate = addBlindIndexAssignments(ent, [...r.on_duplicate!]);
      validateAESAssignments(ent, duplicate, true);
      const sets = duplicate.map(a => `${this.d.quote(a.column)} = ${this.renderAssign(b, ent, columnOf(ent, a.column)!, a)}`);
      if (version !== '' && assignsAES(ent, duplicate) && !assigned(duplicate, version)) sets.push(`${this.d.quote(version)} = ${b.config('aes_version')}`);
      const op = this.auditAssignment(b, ent);
      if (op !== undefined) sets.push(op);
      if (ent.identity !== '' && !this.d.insertReturningId) {
        // make the last insert id report the existing row on update
        sets.push(`${this.d.quote(ent.identity)} = LAST_INSERT_ID(${this.d.quote(ent.identity)})`);
      }
      sql += this.d.upsert(conflictTarget(ent, set), sets.join(', '));
    }
    if (this.d.insertReturningId && ent.identity !== '') sql += ` RETURNING ${this.d.quote(ent.identity)}`;
    return { role: 'main', sql, tables: b.tables(), bind_slots: b.binds };
  }

  private updateStep(r: Request): Omit<PlanStep, 'id'> {
    const b = new Builder(this.d);
    const ent = this.entity(r.entity);
    const set = addBlindIndexAssignments(ent, [...r.set ?? []]);
    validateAESAssignments(ent, set, true);
    const root = this.buildScopes(r, ent.table, undefined);
    const sets: string[] = [];
    for (const a of set) {
      const col = columnOf(ent, a.column)!;
      if (col.primary || col.identity) fail('IR_INVALID', `cannot update ${a.column}`);
      sets.push(`${this.d.quote(a.column)} = ${this.renderAssign(b, ent, col, a)}`);
    }
    const version = aesVersionColumn(ent);
    if (version !== '' && assignsAES(ent, set) && !assigned(set, version)) sets.push(`${this.d.quote(version)} = ${b.config('aes_version')}`);
    // The update time is always assigned: optimistic locking needs the same behavior on every dialect.
    if (ent.updated !== '' && !assigned(r.set ?? [], ent.updated)) sets.push(`${this.d.quote(ent.updated)} = ${this.clock(b, columnOf(ent, ent.updated)!)}`);
    const op = this.auditAssignment(b, ent);
    if (op !== undefined) sets.push(op);
    let where = this.renderGroup(b, root, r.where!, true);
    if (r.optimistic) where += ` AND ${this.qcol(root, r.optimistic.column)} = ${b.param(r.optimistic.p)}`;
    if (ent.softDelete !== '') where += ` AND ${this.qcol(root, ent.softDelete)} IS NULL`;
    return { role: 'main', sql: `UPDATE ${b.table(ent)} SET ${sets.join(', ')} WHERE ${where}`, tables: b.tables(), bind_slots: b.binds };
  }

  private deleteStep(r: Request): Omit<PlanStep, 'id'> {
    const b = new Builder(this.d);
    const ent = this.entity(r.entity);
    const root = this.buildScopes(r, ent.table, undefined);
    if (ent.softDelete === '') {
      return { role: 'main', sql: `DELETE FROM ${b.table(ent)} WHERE ${this.renderGroup(b, root, r.where!, true)}`, tables: b.tables(), bind_slots: b.binds };
    }
    // A soft delete is an update: it stamps the column and, on an audited table, the audit column.
    const sets = [`${this.d.quote(ent.softDelete)} = ${this.clock(b, columnOf(ent, ent.softDelete)!)}`];
    const op = this.auditAssignment(b, ent);
    if (op !== undefined) sets.push(op);
    const where = `${this.renderGroup(b, root, r.where!, true)} AND ${this.qcol(root, ent.softDelete)} IS NULL`;
    return { role: 'main', sql: `UPDATE ${b.table(ent)} SET ${sets.join(', ')} WHERE ${where}`, tables: b.tables(), bind_slots: b.binds };
  }

  /**
   * soft delete 한 행 하나를 되돌리는 update 다. where 는 primary key 나 unique key 하나의 모든 column 을 eq 값으로
   * 한 번씩 이름한다. 지워진 행만 고치므로 지워지지 않은 행과 없는 행은 아무것도 바꾸지 않는다. set 은 되돌리는 행에
   * 함께 쓰는 새 값이며 update 처럼 쓴다. primary key, identity, soft delete column 은 쓸 수 없다. SET 순서는 새 값,
   * AES key version, soft delete column, audit table 의 audit column 이다. updated column 은 쓰지 않는다.
   */
  private restoreStep(r: Request): Omit<PlanStep, 'id'> {
    const ent = this.entity(r.entity);
    if (ent.softDelete === '') fail('IR_INVALID', `restore of ${ent.name}, which has no soft_delete setting`);
    restoreKey(ent, r.where!);
    const set = addBlindIndexAssignments(ent, [...r.set ?? []]);
    validateAESAssignments(ent, set, true);
    const b = new Builder(this.d);
    const root = this.buildScopes(r, ent.table, undefined);
    const sets: string[] = [];
    for (const a of set) {
      const col = columnOf(ent, a.column)!;
      if (col.primary || col.identity || col.name === ent.softDelete) fail('IR_INVALID', `restore cannot assign ${a.column}`);
      sets.push(`${this.d.quote(a.column)} = ${this.renderAssign(b, ent, col, a)}`);
    }
    const version = aesVersionColumn(ent);
    if (version !== '' && assignsAES(ent, set)) sets.push(`${this.d.quote(version)} = ${b.config('aes_version')}`);
    sets.push(`${this.d.quote(ent.softDelete)} = NULL`);
    const op = this.auditAssignment(b, ent);
    if (op !== undefined) sets.push(op);
    const where = `${this.renderGroup(b, root, r.where!, true)} AND ${this.qcol(root, ent.softDelete)} IS NOT NULL`;
    return { role: 'main', sql: `UPDATE ${b.table(ent)} SET ${sets.join(', ')} WHERE ${where}`, tables: b.tables(), bind_slots: b.binds };
  }
}

/** restore 의 where 가 primary key 나 unique key 하나의 모든 column 을 and 로 이은 eq 값 조건으로 한 번씩 이름하는지 확인한다. */
function restoreKey(ent: Entity, where: Group): void {
  const invalid = (): never => fail('IR_INVALID', `restore of ${ent.name} names every column of its primary key or of one unique key once with an eq value`);
  const columns: string[] = [];
  where.items.forEach((item, i) => {
    const p = item.pred;
    if (p === undefined || p.op !== 'eq' || p.p === undefined || p.fn !== undefined || p.value !== undefined || p.ref !== undefined
      || p.sub !== undefined || (p.expr ?? '') !== '' || (i > 0 && p.conn !== 'and') || columns.includes(p.column ?? '')) invalid();
    columns.push(p!.column ?? '');
  });
  const same = (key: readonly string[]) => key.length === columns.length && key.every(c => columns.includes(c));
  if (!same(ent.primaryKey) && !ent.uniques.some(same)) invalid();
}
