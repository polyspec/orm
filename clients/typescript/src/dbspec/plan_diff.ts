// plan의 source와 target schema를 비교한다 (docs/plans.md "Diff").
// 기준은 Go 엔진(engine/dbspec/plan_diff.go)이며 diagnostic message는 Go와 같은 바이트다.
import { typeText } from './emit.js';
import { dbspecManifest } from './index.js';
import type { DbspecColumn, DbspecDefault, DbspecDiagnostic, DbspecDocument, DbspecTable, DbspecType } from './model.js';
import { planDiagnostic, sortedBy, type DbspecColumnRename, type DbspecPlan, type DbspecTableRename } from './plan.js';
import { collectChanges, diffObjects, diffTriggers, type ObjectRef } from './plan_objects.js';

/** One change of a diff: `table` is the target name, and the source name for drop_table and dropped objects. */
export interface DbspecChange {
  readonly kind: string;
  readonly table: string;
  readonly name: string;
}

/** The changes and no diagnostic, or the plan diagnostics and no changes. */
export type DbspecDiffResult =
  | { readonly changes: readonly DbspecChange[]; readonly diagnostics: readonly [] }
  | { readonly changes: null; readonly diagnostics: readonly DbspecDiagnostic[] };

/** The diff that diffPlan and planSteps share. */
export interface PlanDiff {
  readonly source: Map<string, DbspecTable>;
  readonly target: Map<string, DbspecTable>;
  /** target table: source table */
  readonly tableOf: Map<string, string>;
  /** target table: target column: source column */
  readonly columnOf: Map<string, Map<string, string>>;
  readonly created: string[];
  readonly dropped: string[];
  /** matched tables in target name order */
  readonly matched: string[];
  readonly added: Map<string, string[]>;
  readonly removed: Map<string, string[]>;
  readonly altered: Map<string, string[]>;
  readonly renamedTables: DbspecTableRename[];
  readonly renamedColumns: DbspecColumnRename[];
  /** source table: objects to drop */
  readonly dropObjects: Map<string, ObjectRef[]>;
  /** target table: objects to add */
  readonly addObjects: Map<string, ObjectRef[]>;
  /** target tables whose triggers change */
  readonly triggers: Set<string>;
  readonly changes: DbspecChange[];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortedKeys<V>(m: ReadonlyMap<string, V>): string[] {
  return [...m.keys()].sort(compare);
}

export function append<V>(m: Map<string, V[]>, key: string, value: V): void {
  const list = m.get(key);
  if (list === undefined) m.set(key, [value]);
  else list.push(value);
}

export function columnOf(t: DbspecTable, name: string): DbspecColumn | undefined {
  return t.columns.find(c => c.name === name);
}

export function renamedOr(m: ReadonlyMap<string, string> | undefined, name: string): string {
  return m?.get(name) ?? name;
}

export function sameType(a: DbspecType, b: DbspecType): boolean {
  return typeText(a) === typeText(b);
}

export function sameDefault(a: DbspecDefault | null, b: DbspecDefault | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && (a.kind === 'now' || (b.kind === 'literal' && a.text === b.text));
}

/** Whether a type change keeps every value on the three databases. */
export function widens(from: DbspecType, to: DbspecType): boolean {
  switch (from.kind) {
    case 'i16':
      return to.kind === 'i32' || to.kind === 'i64';
    case 'i32':
      return to.kind === 'i64';
    case 'varchar':
      return (to.kind === 'varchar' && to.length >= from.length) || to.kind === 'text';
    case 'decimal':
      return to.kind === 'decimal' && to.scale === from.scale && to.precision >= from.precision;
    case 'time':
    case 'datetime':
      return to.kind === from.kind && to.precision >= from.precision;
    default:
      return false;
  }
}

function planError(message: string): DbspecDiagnostic {
  return planDiagnostic('plan', 1, message);
}

function hashOrEmpty(hash: string | null): string {
  return hash ?? 'empty';
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Compares the source schema (null: the empty schema) with the plan's target,
 * or gives the plan diagnostics of the changes the plan cannot make.
 */
export function planDiff(source: DbspecDocument | null, p: DbspecPlan): { diff: PlanDiff; diagnostics: [] } | { diff: null; diagnostics: DbspecDiagnostic[] } {
  let from: string | null = null;
  if (source !== null) {
    const manifest = dbspecManifest([source]);
    if (manifest.manifest === null) return { diff: null, diagnostics: [...manifest.diagnostics] };
    from = manifest.manifest.schemaHash;
  }
  if (from !== p.from) {
    return { diff: null, diagnostics: [planError(`the plan starts from ${hashOrEmpty(p.from)}, and the source schema is ${hashOrEmpty(from)}`)] };
  }
  const d: PlanDiff = {
    source: new Map(),
    target: new Map(),
    tableOf: new Map(),
    columnOf: new Map(),
    created: [],
    dropped: [],
    matched: [],
    added: new Map(),
    removed: new Map(),
    altered: new Map(),
    renamedTables: [],
    renamedColumns: [],
    dropObjects: new Map(),
    addObjects: new Map(),
    triggers: new Set(),
    changes: [],
  };
  if (source !== null) for (const t of source.tables) d.source.set(t.name, t);
  for (const t of p.schema.tables) d.target.set(t.name, t);
  const out: DbspecDiagnostic[] = [];
  // table rename
  const renamedFrom = new Map<string, string>(); // source: target
  for (const r of sortedBy(p.renameTables, r => r.old)) {
    if (!d.source.has(r.old)) out.push(planError(`rename table ${r.old}: the source has no table ${r.old}`));
    else if (d.source.has(r.new)) out.push(planError(`rename table ${r.old}: the source already has a table ${r.new}`));
    else if (!d.target.has(r.new)) out.push(planError(`rename table ${r.old}: the target has no table ${r.new}`));
    else {
      renamedFrom.set(r.old, r.new);
      d.renamedTables.push(r);
    }
  }
  for (const name of sortedKeys(d.source)) {
    const t = renamedOr(renamedFrom, name);
    if (d.target.has(t)) d.tableOf.set(t, name);
    else d.dropped.push(name);
  }
  for (const name of sortedKeys(d.target)) {
    if (d.tableOf.has(name)) d.matched.push(name);
    else d.created.push(name);
  }
  // table drop 허가
  const allowedTables = new Set<string>();
  for (const t of p.dropTables) {
    allowedTables.add(t);
    if (!d.dropped.includes(t)) out.push(planError(`allow drop table ${t} drops nothing`));
  }
  for (const t of d.dropped) {
    if (!allowedTables.has(t)) out.push(planError(`table ${t} is dropped without allow drop table ${t}`));
  }
  // column rename
  const renamedColumn = new Map<string, Map<string, string>>(); // target table: source column: target column
  for (const r of sortedBy(p.renameColumns, r => `${r.table}.${r.old}`)) {
    const src = d.tableOf.get(r.table);
    if (src === undefined) out.push(planError(`rename column ${r.table}.${r.old}: ${r.table} is not a table of both schemas`));
    else if (columnOf(d.source.get(src)!, r.old) === undefined) {
      out.push(planError(`rename column ${r.table}.${r.old}: the source table has no column ${r.old}`));
    } else if (columnOf(d.source.get(src)!, r.new) !== undefined) {
      out.push(planError(`rename column ${r.table}.${r.old}: the source table already has a column ${r.new}`));
    } else if (columnOf(d.target.get(r.table)!, r.new) === undefined) {
      out.push(planError(`rename column ${r.table}.${r.old}: the target table has no column ${r.new}`));
    } else {
      let m = renamedColumn.get(r.table);
      if (m === undefined) renamedColumn.set(r.table, (m = new Map()));
      m.set(r.old, r.new);
      d.renamedColumns.push(r);
    }
  }
  const columnKey = (table: string, name: string): string => `${table}.${name}`;
  const allowedColumns = new Set(p.dropColumns.map(c => columnKey(c.table, c.name)));
  const usedColumnPermissions = new Set<string>();
  // matched table의 column
  for (const name of d.matched) {
    const src = d.source.get(d.tableOf.get(name)!)!;
    const tgt = d.target.get(name)!;
    const renames = renamedColumn.get(name);
    const columns = new Map<string, string>();
    d.columnOf.set(name, columns);
    for (const c of src.columns) {
      const n = renamedOr(renames, c.name);
      if (columnOf(tgt, n) === undefined) {
        const ref = columnKey(src.name, c.name);
        if (!allowedColumns.has(ref)) {
          out.push(planError(`column ${src.name}.${c.name} is dropped without allow drop column ${src.name}.${c.name}`));
        }
        usedColumnPermissions.add(ref);
        append(d.removed, name, c.name);
        continue;
      }
      columns.set(n, c.name);
    }
    for (const c of tgt.columns) {
      const old = columns.get(c.name);
      if (old === undefined) {
        if (!c.nullable && c.default === null) {
          out.push(planError(`column ${name}.${c.name} is added non-null without a default; add it null, fill it, and make it non-null in a later plan`));
        }
        if (c.identity) out.push(planError(`column ${name}.${c.name} adds an identity, which changes the primary key`));
        append(d.added, name, c.name);
        continue;
      }
      const sc = columnOf(src, old)!;
      if (sc.identity !== c.identity) {
        out.push(planError(`column ${name}.${c.name} changes identity; it needs a new table`));
        continue;
      }
      if (!sameType(sc.type, c.type) && !widens(sc.type, c.type)) {
        out.push(planError(`column ${name}.${c.name} changes type from ${typeText(sc.type)} to ${typeText(c.type)}, which does not keep every value; it needs a new column`));
        continue;
      }
      if (!sameType(sc.type, c.type) || sc.nullable !== c.nullable || !sameDefault(sc.default, c.default)) append(d.altered, name, c.name);
    }
    // PostgreSQL은 column 자리를 정하지 못하므로 남는 column의 순서는 그대로이고
    // 더한 column은 남는 column 뒤에 온다.
    const kept = src.columns.map(c => renamedOr(renames, c.name)).filter(n => columnOf(tgt, n) !== undefined);
    const keptTarget: string[] = [];
    let lastKept = -1;
    tgt.columns.forEach((c, i) => {
      if (columns.has(c.name)) {
        keptTarget.push(c.name);
        lastKept = i;
      }
    });
    if (!sameList(kept, keptTarget)) out.push(planError(`table ${name} reorders its columns; columns keep their order`));
    tgt.columns.forEach((c, i) => {
      if (!columns.has(c.name) && i < lastKept) {
        out.push(planError(`column ${name}.${c.name} is added before a kept column; added columns come last`));
      }
    });
    const sourceKey = src.primaryKey.columns.map(k => renamedOr(renames, k));
    if (!sameList(sourceKey, tgt.primaryKey.columns)) out.push(planError(`table ${name} changes its primary key; it needs a new table`));
  }
  for (const c of p.dropColumns) {
    if (!usedColumnPermissions.has(columnKey(c.table, c.name))) out.push(planError(`allow drop column ${c.table}.${c.name} drops nothing`));
  }
  if (out.length > 0) return { diff: null, diagnostics: out };
  diffObjects(d, renamedFrom, renamedColumn);
  diffTriggers(d);
  collectChanges(d);
  return { diff: d, diagnostics: [] };
}

/**
 * Gives the changes from the source schema (null: the empty schema) to the
 * plan's target (docs/plans.md "Diff"), or the plan diagnostics. A source
 * whose schemaHash differs from the plan's `from` is a diagnostic.
 */
export function diffPlan(source: DbspecDocument | null, plan: DbspecPlan): DbspecDiffResult {
  const { diff, diagnostics } = planDiff(source, plan);
  if (diff === null) return Object.freeze({ changes: null, diagnostics: Object.freeze(diagnostics) });
  return Object.freeze({ changes: Object.freeze(diff.changes.map(c => Object.freeze(c))), diagnostics: Object.freeze([]) as readonly [] });
}
