// Writes the steps that the connection's addTablesAndColumns runs (docs/schema.md "Adding tables and columns").
import { present } from '../present.js';
import { compareSchemas } from './compare.js';
import { emitDocument } from './emit.js';
import type { DbspecUnsupported } from './introspect_catalog.js';
import type { DbspecDiagnostic, DbspecDocument, DbspecTable } from './model.js';
import { planTo } from './plan.js';
import { planSteps, type DbspecPlanStep } from './plan_steps.js';
import type { DbspecDialect } from './render.js';
import { dbspecManifest } from './index.js';

/** The tables to create, the columns to add, the steps, and the differences. If there are differences, the list and the steps are empty. */
export interface DbspecAddTablesAndColumnsSteps {
  readonly added: readonly string[];
  readonly steps: readonly DbspecPlanStep[];
  readonly differences: readonly string[];
}

function qualified(table: string, name: string): string {
  return name === '' ? table : `${table}.${name}`;
}

function schemaDocument(tables: readonly DbspecTable[]): DbspecDocument {
  return { name: 'schema', uses: [], tables, diagrams: [], closingComments: [] };
}

/**
 * Checks whether the database is the same as the document set (docs/schema.md "Schema installation"). live is the
 * document of the database introspected through the connection, unsupported is the objects that introspection could not read, target is the
 * schema text document of the set. Tables of the database that are not in the set are not compared. A table of the set that has an unread
 * object is reported as "unsupported_<kind> <table>[.<name>]: <reason>"; otherwise, the
 * differences from the set's table to the set are returned as "<kind> <table>[.<name>]". An empty list means they are the same.
 */
export function installedDifferences(live: DbspecDocument, unsupported: readonly DbspecUnsupported[], target: DbspecDocument): readonly string[] {
  const { comparison, differences } = compareSet(live, unsupported, target);
  for (const d of comparison?.differences ?? []) differences.push(`${d.kind} ${qualified(d.table, d.name)}`);
  return differences;
}

/**
 * Compares the database's table of the set (source) with the set. If a table of the set has an unread object,
 * that object is returned as a difference without a source. Otherwise, the definition of each table name of the set, the source, the comparison result and the
 * diagnostic are returned.
 */
function compareSet(live: DbspecDocument, unsupported: readonly DbspecUnsupported[], target: DbspecDocument): {
  declared: Map<string, DbspecTable>;
  source: DbspecDocument | null;
  comparison: ReturnType<typeof compareSchemas> | null;
  differences: string[];
} {
  const declared = new Map(target.tables.map(t => [t.name, t]));
  const differences: string[] = [];
  // If a table of the set has an unread object, that table cannot be said to be the same as the set.
  for (const u of unsupported) {
    if (declared.has(u.table)) differences.push(`unsupported_${u.kind} ${qualified(u.table, u.name)}: ${u.reason}`);
  }
  if (differences.length > 0) return { declared, source: null, comparison: null, differences };
  const source = schemaDocument(live.tables.filter(t => declared.has(t.name)));
  const comparison = compareSchemas(source, target);
  for (const d of comparison.diagnostics) differences.push(`${d.rule}: ${d.message}`);
  return { declared, source, comparison, differences };
}

/**
 * live is the document of the database introspected through the connection, unsupported is the objects that introspection could not read,
 * target is the schema text document of the document set. Tables of the database that are not in the set are neither compared nor changed
 * The only differences between the set's tables in the database and the set are create_table for a table not in the database, add_column for a null or defaulted column,
 * or add_index for an index that is not unique: then the plan steps run from the set's table in the database
 * to the set (docs/plans.md "Steps"), and the tables created in table name order are "table",
 * the columns added in column order are "table.column", and the indexes added after them in index order are "table.index"
 * list. Other differences are returned as "<kind> <table>[.<name>]" without steps, and a missing unique key that exists
 * in a row may fail, so it is returned together with its reason.
 */
export function addTablesAndColumnsSteps(live: DbspecDocument, unsupported: readonly DbspecUnsupported[], target: DbspecDocument, dialect: DbspecDialect): DbspecAddTablesAndColumnsSteps {
  const { declared, source, comparison, differences } = compareSet(live, unsupported, target);
  const none = (): DbspecAddTablesAndColumnsSteps => ({ added: [], steps: [], differences });
  if (source === null || comparison === null) return none();
  const adding = new Set<string>();
  for (const d of comparison.differences ?? []) {
    if (d.kind === 'create_table') {
      adding.add(d.table);
      continue;
    }
    if (d.kind === 'add_column') {
      const column = present(declared.get(d.table), 'declared.get(d.table)').columns.find(c => c.name === d.name);
      if (column === undefined || column.identity || (!column.nullable && column.default === null)) {
        differences.push(`add_column ${qualified(d.table, d.name)} without null or default`);
        continue;
      }
      adding.add(qualified(d.table, d.name));
      continue;
    }
    if (d.kind === 'add_index') {
      // An index does not reject rows, so it is added to an existing table as well.
      adding.add(qualified(d.table, d.name));
      continue;
    }
    if (d.kind === 'add_unique') {
      // A unique key fails when existing rows overlap, so the plan and apply handle it.
      differences.push(`add_unique ${qualified(d.table, d.name)}: a missing unique key can fail on the existing rows; add it with a plan`);
      continue;
    }
    differences.push(`${d.kind} ${qualified(d.table, d.name)}`);
  }
  if (differences.length > 0 || adding.size === 0) return none();
  // Tables to create, columns to add, and indexes are in table name order; within a table they follow column order, then index order.
  const added = target.tables.flatMap(t => adding.has(t.name)
    ? [t.name]
    : [...t.columns.map(c => qualified(t.name, c.name)), ...t.indexes.map(i => qualified(t.name, i.name))].filter(name => adding.has(name)));
  // Columns to add and tables are written as one plan. The plan starts from the set's table in the database, so
  // (if there are none, an empty database) the steps keep the order and rollback of docs/plans.md.
  let failed: readonly DbspecDiagnostic[] = [];
  let from: string | null = null;
  if (source.tables.length > 0) {
    const manifest = dbspecManifest([source]);
    failed = manifest.diagnostics;
    if (manifest.manifest !== null) from = manifest.manifest.schemaHash;
  }
  let steps: readonly DbspecPlanStep[] = [];
  if (failed.length === 0) {
    // The target may be the schema text of a set that writes an external document, so the plan is made from the target without parsing the plan document.
    const plan = planTo(
      { name: 'add_tables_and_columns', from, renameTables: [], renameColumns: [], dropTables: [], dropColumns: [] },
      target,
      emitDocument(target, 'canonical'),
    );
    failed = plan.diagnostics;
    if (plan.plan !== null) {
      const written = planSteps(source.tables.length > 0 ? source : null, plan.plan, dialect);
      failed = written.diagnostics;
      steps = written.steps ?? [];
    }
  }
  for (const d of failed) differences.push(`${d.rule}: ${d.message}`);
  if (differences.length > 0) return none();
  return { added, steps, differences: [] };
}
