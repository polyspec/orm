// Recognizes the trigger set the renderer wrote as the immutable or audit setting
// (docs/dialects.md "Introspection", "Triggers").
import { present } from '../present.js';
import { byteOrder, type Catalog, type ITable } from './introspect_catalog.js';
import type { DbspecSetting, DbspecTable } from './model.js';
import { auditLine } from './audit.js';
import { Renderer, type DbspecDialect } from './render.js';import { rendererName } from './names.js';


/** Rewrites one catalog trigger in the statement form the renderer writes. PostgreSQL has two statements, a function and a trigger. */
export interface ITrigger {
  readonly name: string;
  readonly statements: readonly string[];
}

const AUDIT_INSERT_PATTERN = /^INSERT INTO [`"]([a-z0-9_]+)[`"] \(([^)]*)\) VALUES /;
const AUDIT_COLUMN_PATTERN = /^[`"]([a-z0-9_]+)[`"]$/;
const AUDIT_TABLES_PATTERN = /; INSERT INTO [`"]([a-z0-9_]+)[`"] \([`"]([a-z0-9_]+)[`"], [`"]([a-z0-9_]+)[`"]\) VALUES \(NEW\./;
const AUDIT_UPDATE_PATTERN = /VALUES \('update', OLD\.[`"]([a-z0-9_]+)[`"],/;

/**
 * For each table, if the trigger set equals the renderer output for immutable or audit, then
 * adds that setting; otherwise reports all triggers as unsupported. triggers is,
 * for each table name, the triggers in catalog order.
 */
export function recognizeTriggers(c: Catalog, dialect: DbspecDialect, triggers: ReadonlyMap<string, readonly ITrigger[]>): void {
  for (const table of [...triggers.keys()].sort(byteOrder)) {
    const list = present(triggers.get(table), 'triggers.get(table)');
    const t = c.table(table);
    if (t === undefined) {
      for (const tr of list) c.report('trigger', table, tr.name, 'the table is not read');
      continue;
    }
    const lines = triggerSetting(dialect, t, list);
    if (lines === null) {
      for (const tr of list) c.report('trigger', table, tr.name, 'the trigger is not the renderer output of immutable or audit');
      continue;
    }
    t.settings.push(...lines);
  }
}

/**
 * Recognizes each setting by its own trigger name (the recomputed renderer name), and only when the trigger set's
 * names and contents both match the renderer output of the recognized settings does it return those setting lines; otherwise null (docs/dialects.md
 * "Triggers"). A table with two settings written together is the sum of the two outputs and is not judged by count.
 */
function triggerSetting(dialect: DbspecDialect, t: ITable, list: readonly ITrigger[]): string[] | null {
  const names = new Map(list.map(tr => [tr.name, tr]));
  const settings: DbspecSetting[] = [];
  if (['immutable_update', 'immutable_delete'].some(event => names.has(rendererName(t.name, event)))) {
    settings.push({ comments: [], kind: 'immutable' });
  }
  const insert = names.get(rendererName(t.name, 'audit_insert'));
  if (insert !== undefined) {
    const update = names.get(rendererName(t.name, 'audit_update'));
    const m = AUDIT_INSERT_PATTERN.exec(statementBody(insert.statements));
    const u = AUDIT_UPDATE_PATTERN.exec(statementBody(update?.statements ?? []));
    const body = statementBody(insert.statements);
    const tm = AUDIT_TABLES_PATTERN.exec(body);
    const tables = tm === null ? null : { table: present(tm[1], 'tm[1]'), record: present(tm[2], 'tm[2]'), name: present(tm[3], 'tm[3]') };
    const audit = m !== null && u !== null ? auditOf(t, present(m[1], 'm[1]'), present(m[2], 'm[2]').split(', '), present(u[1], 'u[1]'), tables) : null;
    if (audit !== null) settings.push(audit);
  }
  if (settings.length === 0) return null;
  const want = new Renderer(dialect).triggers(triggerModel(t, settings));
  const wanted = triggerOrder(want);
  if (wanted.length !== list.length) return null;
  const got: string[] = [];
  for (const name of wanted) {
    const tr = names.get(name);
    if (tr === undefined) return null;
    got.push(...tr.statements);
  }
  if (got.length !== want.length || got.some((s, i) => s !== want[i])) return null;
  return settings.map(setting => (setting.kind === 'audit' ? auditLine(setting, 'exclude', setting.exclude) : 'immutable'));
}

/**
 * Makes the audit setting from the column list of the audit insert trigger (action, previous, the recorded columns) and the audit column of the update trigger.
 * The audit record table is the table that the foreign key of a table with only an audit column points to.
 * Columns that are not recorded become the exclude list in the table's column order. If the list is not in renderer form,
 * or the audit columns are not recorded, or the foreign key is not exactly one, the result is null. The made setting is then
 * rendered again and compared with the catalog triggers.
 */
function auditOf(
  t: ITable,
  into: string,
  quoted: readonly string[],
  column: string,
  tables: { readonly table: string; readonly record: string; readonly name: string } | null,
): DbspecSetting | null {
  const names: string[] = [];
  for (const q of quoted) {
    const m = AUDIT_COLUMN_PATTERN.exec(q);
    if (m === null) return null;
    names.push(present(m[1], 'm[1]'));
  }
  const recorded = names.slice(2);
  if (recorded.length === 0 || !recorded.includes(column)) return null;
  const references = t.fks.filter(f => f.columns.length === 1 && f.columns[0] === column).map(f => f.table);
  if (references.length !== 1) return null;
  const excluded = t.columns.filter(c => !recorded.includes(c.name)).map(c => c.name);
  return {
    comments: [], kind: 'audit', into, column, references: present(references[0], 'references[0]'), action: present(names[0], 'names[0]'), previous: present(names[1], 'names[1]'), tables,
    exclude: excluded.length === 0 ? null : excluded, include: null,
  };
}

/** The table that the renderer needs to write triggers: name, column names and types, and one setting. */
function triggerModel(t: ITable, settings: readonly DbspecSetting[]): DbspecTable {
  return {
    comments: [],
    name: t.name,
    columns: t.columns.map(c => ({ comments: [], name: c.name, type: c.type, nullable: false, identity: false, default: null })),
    primaryKey: { comments: [], columns: [] },
    uniques: [],
    indexes: [],
    foreignKeys: [],
    checks: [],
    settings: { comments: [], settings: [...settings], closingComments: [] },
    closingComments: [],
  };
}

/** Takes the trigger names out of the renderer's statement list, in order. */
function triggerOrder(statements: readonly string[]): string[] {
  const names: string[] = [];
  for (const s of statements) {
    if (!s.startsWith('CREATE TRIGGER ')) continue;
    const rest = s.slice('CREATE TRIGGER '.length);
    const end = rest.indexOf(present(rest[0], 'rest[0]'), 1);
    names.push(rest.slice(1, end));
  }
  return names;
}

/** Takes the body out of a trigger statement: after FOR EACH ROW for MySQL, after the function's BEGIN for PostgreSQL, and after BEGIN for SQLite. */
function statementBody(statements: readonly string[]): string {
  for (const s of statements) {
    for (const marker of ['$$BEGIN ', 'FOR EACH ROW BEGIN ', 'FOR EACH ROW ']) {
      const i = s.indexOf(marker);
      if (i >= 0) return s.slice(i + marker.length);
    }
  }
  return '';
}
