// Lists every difference between two schemas without a plan (docs/plans.md "Comparison").
// The reference is the Go engine (engine/dbspec/compare.go), and the diagnostic messages are the same bytes as Go.
import { emitDbspec } from './index.js';
import { emitDocument } from './emit.js';
import type { DbspecDiagnostic, DbspecDocument, DbspecSetting, DbspecTable } from './model.js';
import { auditRecords } from './audit.js';
import { columnOf, sameDefault, sameType, sortedKeys, widens } from './plan_diff.js';
import { foreignKeyDef, indexDef } from './plan_objects.js';

/** One difference between two schemas. name is the name of a column or object, and is an empty string for a table-level difference. */
export interface DbspecDifference {
  readonly kind: string;
  readonly table: string;
  readonly name: string;
}

/** A difference without a diagnostic, or a compare diagnostic with no difference. */
export type DbspecComparisonResult =
  | { readonly differences: readonly DbspecDifference[]; readonly diagnostics: readonly [] }
  | { readonly differences: null; readonly diagnostics: readonly DbspecDiagnostic[] };

/** The order in which differences come within one table. */
const KINDS = [
  'create_table',
  'drop_table',
  'drop_column',
  'add_column',
  'alter_column',
  'change_column_type',
  'change_column_identity',
  'reorder_columns',
  'change_primary_key',
  'drop_unique',
  'add_unique',
  'drop_index',
  'add_index',
  'drop_foreign_key',
  'add_foreign_key',
  'drop_check',
  'add_check',
  'drop_immutable',
  'add_immutable',
  'drop_audit',
  'add_audit',
];

type Add = (kind: string, name: string) => void;

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Returns every difference from source to target without a plan. There are no renames; tables and
 * columns are matched by name only. Both documents must be schema texts, and for each side that is not, a compare
 * diagnostic is returned, in source, target order.
 */
export function compareSchemas(source: DbspecDocument, target: DbspecDocument): DbspecComparisonResult {
  const diagnostics: DbspecDiagnostic[] = [];
  for (const [side, document] of [['source', source], ['target', target]] as const) {
    if (!isSchemaText(document)) {
      diagnostics.push(
        Object.freeze({
          rule: 'compare',
          line: 1,
          column: 1,
          message: `the ${side} is not a schema text: one document named schema in canonical form with its tables in name order and only the immutable and audit settings`,
        }),
      );
    }
  }
  if (diagnostics.length > 0) return Object.freeze({ differences: null, diagnostics: Object.freeze(diagnostics) });
  const sourceTables = new Map(source.tables.map(t => [t.name, t]));
  const targetTables = new Map(target.tables.map(t => [t.name, t]));
  const differences: DbspecDifference[] = [];
  for (const name of sortedKeys(new Map([...sourceTables, ...targetTables]))) {
    const found: DbspecDifference[] = [];
    const add: Add = (kind, n) => found.push(Object.freeze({ kind, table: name, name: n }));
    const s = sourceTables.get(name);
    const t = targetTables.get(name);
    if (s === undefined) add('create_table', '');
    else if (t === undefined) add('drop_table', '');
    else compareTables(s, t, add);
    found.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || compare(a.name, b.name));
    differences.push(...found);
  }
  const noDiagnostics: readonly [] = Object.freeze([]);
  return Object.freeze({ differences: Object.freeze(differences), diagnostics: noDiagnostics });
}

/**
 * Tells whether the canonical emission of a document is that document's own schema text. The use lines of an external document are in document name order, and its tables
 * must be in name order. The external document itself is not needed.
 */
export function isSchemaText(document: DbspecDocument): boolean {
  if (document.name !== 'schema') return false;
  const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const tables = [...document.tables].sort((a, b) => order(a.name, b.name));
  const uses = document.uses.map(u => ({ comments: [], document: u.document, tables: [...new Set(u.tables)].sort(order) }));
  return emitDbspec(document) === emitDocument({ name: document.name, uses, tables, diagrams: [], closingComments: [] }, 'schema');
}

/** Adds the differences of the columns, primary key, objects and settings of tables that are on both sides. */
function compareTables(s: DbspecTable, t: DbspecTable, add: Add): void {
  for (const c of s.columns) if (columnOf(t, c.name) === undefined) add('drop_column', c.name);
  const keptTarget: string[] = [];
  let lastKept = -1;
  let firstAdded = -1;
  t.columns.forEach((c, i) => {
    const sc = columnOf(s, c.name);
    if (sc === undefined) {
      add('add_column', c.name);
      if (firstAdded < 0) firstAdded = i;
      return;
    }
    keptTarget.push(c.name);
    lastKept = i;
    const same = sameType(sc.type, c.type);
    if ((!same && widens(sc.type, c.type)) || sc.nullable !== c.nullable || !sameDefault(sc.default, c.default)) add('alter_column', c.name);
    if (!same && !widens(sc.type, c.type)) add('change_column_type', c.name);
    if (sc.identity !== c.identity) add('change_column_identity', c.name);
  });
  const kept = s.columns.filter(c => columnOf(t, c.name) !== undefined).map(c => c.name);
  if (kept.join(',') !== keptTarget.join(',') || (firstAdded >= 0 && firstAdded < lastKept)) add('reorder_columns', '');
  if (s.primaryKey.columns.join(',') !== t.primaryKey.columns.join(',')) add('change_primary_key', '');
  const same = (c: string): string => c;
  compareObjects(add, 'unique', s.uniques, t.uniques, u => u.columns.join(','));
  compareObjects(add, 'index', s.indexes, t.indexes, x => indexDef(x, same));
  compareObjects(add, 'foreign_key', s.foreignKeys, t.foreignKeys, f => foreignKeyDef(f.columns, f.table, f.references, f));
  compareObjects(add, 'check', s.checks, t.checks, k => k.expression);
  for (const kind of ['immutable', 'audit'] as const) {
    const from = settingOf(s, kind, s, t);
    const to = settingOf(t, kind, s, t);
    if (from !== to) {
      if (from !== null) add(`drop_${kind}`, '');
      if (to !== null) add(`add_${kind}`, '');
    }
  }
}

/** If an object matched by name is on one side only, adds a drop or an add; if the definitions differ, adds both. */
function compareObjects<T extends { readonly name: string }>(add: Add, kind: string, source: readonly T[], target: readonly T[], def: (o: T) => string): void {
  for (const o of source) {
    const other = target.find(x => x.name === o.name);
    if (other === undefined || def(other) !== def(o)) add(`drop_${kind}`, o.name);
  }
  for (const o of target) {
    const other = source.find(x => x.name === o.name);
    if (other === undefined || def(other) !== def(o)) add(`add_${kind}`, o.name);
  }
}

/**
 * The definition of a setting that exists only once in the table, or null if none. audit is compared on columns that exist on both sides
 * but it also compares columns it does not record. A column on one side only is left as a difference by add_column or drop_column.
 */
function settingOf(x: DbspecTable, kind: 'immutable' | 'audit', s: DbspecTable, t: DbspecTable): string | null {
  const setting: DbspecSetting | undefined = x.settings?.settings.find(e => e.kind === kind);
  if (setting === undefined) return null;
  if (setting.kind !== 'audit') return setting.kind;
  const excluded = t.columns.filter(c => columnOf(s, c.name) !== undefined && !auditRecords(setting, c.name)).map(c => c.name);
  return [`${setting.into} ${setting.column} ${setting.references} ${setting.action} ${setting.previous}`, ...excluded].join(' ');
}
