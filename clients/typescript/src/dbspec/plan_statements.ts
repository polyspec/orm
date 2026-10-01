// plan의 statement를 한 dialect로 쓴다 (docs/plans.md "Statements").
// 기준은 Go 엔진(engine/dbspec/plan_statements.go)이며 statement는 Go와 같은 바이트다.
import { readCheck } from './check.js';
import type { DbspecColumn, DbspecDiagnostic, DbspecDocument, DbspecTable } from './model.js';
import { sortedBy, type DbspecPlan } from './plan.js';
import { columnOf, planDiff, sameDefault, sameType, sortedKeys, type PlanDiff } from './plan_diff.js';
import { checkOf, foreignKeyOf, hasTriggers, indexOf, uniqueOf, type ObjectRef } from './plan_objects.js';
import { Renderer, type DbspecDialect } from './render.js';

/** The statements and no diagnostic, or the plan diagnostics and no statements. */
export type DbspecPlanStatementsResult =
  | { readonly statements: readonly string[]; readonly diagnostics: readonly [] }
  | { readonly statements: null; readonly diagnostics: readonly DbspecDiagnostic[] };

const DIALECTS: ReadonlySet<string> = new Set(['mysql', 'postgres', 'sqlite']);

/**
 * Writes the statements of a plan in one dialect (docs/plans.md
 * "Statements"). The source is the schema the plan starts from, null for an
 * empty database. An unknown dialect is a TypeError.
 */
export function planStatements(source: DbspecDocument | null, plan: DbspecPlan, dialect: DbspecDialect): DbspecPlanStatementsResult {
  if (!DIALECTS.has(dialect)) throw new TypeError(`unknown dbspec dialect ${String(dialect)}`);
  const { diff, diagnostics } = planDiff(source, plan);
  if (diff === null) return Object.freeze({ statements: null, diagnostics: Object.freeze(diagnostics) });
  const statements = new PlanWriter(diff, new Renderer(dialect)).statements();
  return Object.freeze({ statements: Object.freeze(statements), diagnostics: Object.freeze([]) as readonly [] });
}

class PlanWriter {
  private readonly out: string[] = [];
  /** SQLite에서 다시 만드는 target table */
  private readonly rebuilt = new Set<string>();

  constructor(
    private readonly d: PlanDiff,
    private readonly r: Renderer,
  ) {}

  private add(...statements: string[]): void {
    this.out.push(...statements);
  }

  private q(name: string): string {
    return this.r.q(name);
  }

  statements(): string[] {
    const d = this.d;
    const sqlite = this.r.d === 'sqlite';
    if (sqlite) for (const name of d.matched) if (this.sqliteRebuilds(name)) this.rebuilt.add(name);
    // 1. trigger
    for (const name of d.matched) {
      const src = d.source.get(d.tableOf.get(name)!)!;
      if (hasTriggers(src) && (d.triggers.has(name) || this.rebuilt.has(name))) this.dropTriggers(src);
    }
    for (const name of d.dropped) {
      const src = d.source.get(name)!;
      if (hasTriggers(src)) this.dropTriggers(src);
    }
    // 2. foreign key, 3. check, unique, index
    if (!sqlite) {
      for (const s of sortedKeys(d.dropObjects)) {
        for (const o of d.dropObjects.get(s)!) if (o.kind === 'foreign_key') this.dropObject(s, o);
      }
    }
    for (const s of sortedKeys(d.dropObjects)) {
      if (sqlite && (this.rebuilt.has(this.targetName(s)) || d.dropped.includes(s))) continue;
      for (const o of d.dropObjects.get(s)!) {
        if (o.kind !== 'foreign_key' && !(sqlite && o.kind === 'check')) this.dropObject(s, o);
      }
    }
    const rendererChecks = new Map<string, [Map<string, string>, Map<string, string>]>();
    if (!sqlite) {
      for (const name of d.matched) {
        const src = d.source.get(d.tableOf.get(name)!)!;
        const before = this.rendererChecks(src);
        const after = this.rendererChecks(d.target.get(name)!);
        rendererChecks.set(name, [before, after]);
        for (const n of sortedKeys(before)) if (after.get(n) !== before.get(n)) this.add(this.dropCheck(src.name, n));
      }
    }
    // 4. rename
    for (const r of sortedBy(d.renamedTables, r => r.old)) this.add(`ALTER TABLE ${this.q(r.old)} RENAME TO ${this.q(r.new)}`);
    for (const r of sortedBy(d.renamedColumns, r => `${r.table}.${r.old}`)) {
      this.add(`ALTER TABLE ${this.q(r.table)} RENAME COLUMN ${this.q(r.old)} TO ${this.q(r.new)}`);
    }
    // 5. drop column, drop table
    if (!sqlite) {
      for (const name of d.matched) for (const c of d.removed.get(name) ?? []) this.add(`ALTER TABLE ${this.q(name)} DROP COLUMN ${this.q(c)}`);
    }
    for (const name of d.dropped) this.add(`DROP TABLE ${this.q(name)}`);
    // 6. create table
    for (const name of d.created) this.add(...this.r.table(d.target.get(name)!));
    // 7. add, alter column; SQLite rebuild
    for (const name of d.matched) {
      if (sqlite) {
        if (this.rebuilt.has(name)) this.rebuild(name);
        continue;
      }
      const t = d.target.get(name)!;
      for (const c of d.added.get(name) ?? []) this.add(`ALTER TABLE ${this.q(name)} ADD COLUMN ${this.r.column(columnOf(t, c)!)}`);
      for (const c of d.altered.get(name) ?? []) {
        const src = d.source.get(d.tableOf.get(name)!)!;
        this.alterColumn(name, columnOf(src, d.columnOf.get(name)!.get(c)!)!, columnOf(t, c)!);
      }
    }
    // 8. unique, index, check
    for (const t of sortedKeys(d.addObjects)) {
      if (this.rebuilt.has(t)) continue;
      for (const o of d.addObjects.get(t)!) {
        if (o.kind !== 'foreign_key' && !(sqlite && o.kind === 'check')) this.addObject(t, o);
      }
    }
    if (!sqlite) {
      for (const name of d.matched) {
        const [before, after] = rendererChecks.get(name)!;
        for (const n of sortedKeys(after)) {
          if (after.get(n) !== before.get(n)) this.add(`ALTER TABLE ${this.q(name)} ADD CONSTRAINT ${this.q(n)} CHECK (${after.get(n)})`);
        }
      }
    }
    // 9. foreign key
    if (!sqlite) {
      for (const name of d.created) {
        for (const f of sortedBy(d.target.get(name)!.foreignKeys, f => f.name)) this.add(`ALTER TABLE ${this.q(name)} ADD ${this.r.foreignKey(f)}`);
      }
      for (const t of sortedKeys(d.addObjects)) {
        for (const o of d.addObjects.get(t)!) if (o.kind === 'foreign_key') this.addObject(t, o);
      }
    }
    // 10. trigger
    for (const name of d.created) this.add(...this.r.triggers(d.target.get(name)!));
    for (const name of d.matched) {
      const t = d.target.get(name)!;
      if (hasTriggers(t) && (d.triggers.has(name) || this.rebuilt.has(name))) this.add(...this.r.triggers(t));
    }
    return this.out;
  }

  /** The target name of a source table. */
  private targetName(source: string): string {
    for (const [t, s] of this.d.tableOf) if (s === source) return t;
    return source;
  }

  /**
   * Whether SQLite rebuilds the table: its name, a column, a foreign key or a
   * check changes. Index and unique changes alone, and trigger changes
   * alone, do not rebuild.
   */
  private sqliteRebuilds(name: string): boolean {
    const d = this.d;
    if (d.tableOf.get(name) !== name || d.added.has(name) || d.removed.has(name) || d.altered.has(name)) return true;
    if (d.renamedColumns.some(r => r.table === name)) return true;
    const structural = (o: ObjectRef): boolean => o.kind === 'foreign_key' || o.kind === 'check';
    if ((d.dropObjects.get(d.tableOf.get(name)!) ?? []).some(structural)) return true;
    return (d.addObjects.get(name) ?? []).some(structural);
  }

  /** Recreates a SQLite table in its target definition and copies the matched columns. */
  private rebuild(name: string): void {
    const d = this.d;
    const t = d.target.get(name)!;
    const src = d.source.get(d.tableOf.get(name)!)!;
    const statements = this.r.table(t);
    const prefix = `CREATE TABLE ${this.q(name)} (`;
    const create = statements[0]!;
    if (!create.startsWith(prefix)) throw new Error(`rendered table ${name} does not start with ${prefix}`);
    this.add(`CREATE TABLE ${this.q('$rebuild')} (${create.slice(prefix.length)}`);
    // AUTOINCREMENT counter를 옮겨, 지운 row의 key까지 다시 쓰지 않는다. dbspec
    // 이름에는 따옴표가 없으므로 문자열 literal로 그대로 쓴다.
    for (const c of t.columns) {
      if (c.identity) this.add(`INSERT INTO sqlite_sequence (name, seq) SELECT '$rebuild', seq FROM sqlite_sequence WHERE name = '${name}'`);
    }
    const into: string[] = [];
    const from: string[] = [];
    const columns = d.columnOf.get(name)!;
    for (const c of t.columns) {
      const old = columns.get(c.name);
      if (old === undefined) continue;
      into.push(this.q(c.name));
      // rename은 이미 끝났으므로 source column은 target 이름이다.
      from.push(this.copyValue(columnOf(src, old)!, c));
    }
    this.add(`INSERT INTO ${this.q('$rebuild')} (${into.join(', ')}) SELECT ${from.join(', ')} FROM ${this.q(name)}`);
    this.add(`DROP TABLE ${this.q(name)}`);
    this.add(`ALTER TABLE ${this.q('$rebuild')} RENAME TO ${this.q(name)}`);
    this.add(...statements.slice(1));
  }

  /** The SQLite rebuild copy of a source value into the target column; time and datetime append zero fraction digits. */
  private copyValue(from: DbspecColumn, to: DbspecColumn): string {
    const q = this.q(to.name);
    if ((to.type.kind === 'time' || to.type.kind === 'datetime') && (from.type.kind === 'time' || from.type.kind === 'datetime')) {
      if (to.type.precision > from.type.precision) {
        let pad = '0'.repeat(to.type.precision - from.type.precision);
        if (from.type.precision === 0) pad = '.' + pad;
        return `${q} || '${pad}'`;
      }
    }
    return q;
  }

  private alterColumn(table: string, from: DbspecColumn, to: DbspecColumn): void {
    if (this.r.d === 'mysql') {
      this.add(`ALTER TABLE ${this.q(table)} MODIFY COLUMN ${this.r.column(to)}`);
      return;
    }
    const prefix = `ALTER TABLE ${this.q(table)} ALTER COLUMN ${this.q(to.name)}`;
    const typeChanges = !sameType(from.type, to.type);
    if (typeChanges) this.add(`${prefix} TYPE ${this.r.typeText(to.type)}`);
    if (from.nullable !== to.nullable) this.add(`${prefix} ${to.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`);
    if (!sameDefault(from.default, to.default) || (to.default !== null && typeChanges)) {
      this.add(to.default === null ? `${prefix} DROP DEFAULT` : `${prefix} SET DEFAULT ${this.r.defaultText(to.type, to.default)}`);
    }
  }

  private dropTriggers(t: DbspecTable): void {
    for (const s of this.r.triggers(t)) {
      if (!s.startsWith('CREATE TRIGGER ')) continue;
      const rest = s.slice('CREATE TRIGGER '.length);
      const name = rest.slice(0, rest.indexOf(' '));
      if (this.r.d === 'postgres') this.add(`DROP TRIGGER ${name} ON ${this.q(t.name)}`, `DROP FUNCTION ${name}()`);
      else this.add(`DROP TRIGGER ${name}`);
    }
  }

  private dropCheck(table: string, name: string): string {
    return this.r.d === 'mysql' ? `ALTER TABLE ${this.q(table)} DROP CHECK ${this.q(name)}` : `ALTER TABLE ${this.q(table)} DROP CONSTRAINT ${this.q(name)}`;
  }

  private dropObject(table: string, o: ObjectRef): void {
    const mysql = this.r.d === 'mysql';
    if (o.kind === 'check') this.add(this.dropCheck(table, o.name));
    else if (o.kind === 'foreign_key' && mysql) this.add(`ALTER TABLE ${this.q(table)} DROP FOREIGN KEY ${this.q(o.name)}`);
    else if (o.kind === 'unique' && mysql) this.add(`ALTER TABLE ${this.q(table)} DROP INDEX ${this.q(o.name)}`);
    else if (o.kind === 'index' && mysql) this.add(`DROP INDEX ${this.q(o.name)} ON ${this.q(table)}`);
    else if ((o.kind === 'foreign_key' || o.kind === 'unique') && this.r.d === 'postgres') this.add(`ALTER TABLE ${this.q(table)} DROP CONSTRAINT ${this.q(o.name)}`);
    else this.add(`DROP INDEX ${this.q(o.name)}`);
  }

  private addObject(table: string, o: ObjectRef): void {
    const t = this.d.target.get(table)!;
    switch (o.kind) {
      case 'unique': {
        const u = uniqueOf(t, o.name)!;
        if (this.r.d === 'sqlite') this.add(`CREATE UNIQUE INDEX ${this.q(u.name)} ON ${this.q(table)} (${this.r.list(u.columns)})`);
        else this.add(`ALTER TABLE ${this.q(table)} ADD CONSTRAINT ${this.q(u.name)} UNIQUE (${this.r.list(u.columns)})`);
        return;
      }
      case 'index': {
        const x = indexOf(t, o.name)!;
        const columns = x.columns.map(c => this.q(c.name) + (c.descending ? ' DESC' : ''));
        this.add(`CREATE INDEX ${this.q(x.name)} ON ${this.q(table)} (${columns.join(', ')})`);
        return;
      }
      case 'check': {
        const k = checkOf(t, o.name)!;
        this.add(`ALTER TABLE ${this.q(table)} ADD CONSTRAINT ${this.q(k.name)} CHECK (${this.r.predicate(t, readCheck(k.expression, k.name))})`);
        return;
      }
      case 'foreign_key':
        this.add(`ALTER TABLE ${this.q(table)} ADD ${this.r.foreignKey(foreignKeyOf(t, o.name)!)}`);
        return;
    }
  }

  /** The renderer CHECK names and expressions of a table. */
  private rendererChecks(t: DbspecTable): Map<string, string> {
    const out = new Map<string, string>();
    for (const c of t.columns) {
      const check = this.r.typeCheck(c);
      if (check !== '') out.set(`${t.name}$${c.name}`, check);
    }
    return out;
  }
}
