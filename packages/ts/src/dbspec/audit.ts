// The columns that the audit setting records (docs/dbspec.md "Audit").
import type { DbspecSetting, DbspecTable } from './model.js';

export type DbspecAuditSetting = Extract<DbspecSetting, { readonly kind: 'audit' }>;

/**
 * Tells whether the audit trigger copies a column: audit columns always, columns in the exclude list never,
 * and if there is an include list, only the columns in it.
 */
export function auditRecords(a: DbspecAuditSetting, column: string): boolean {
  if (column === a.column) return true;
  if (a.exclude !== null) return !a.exclude.includes(column);
  if (a.include !== null) return a.include.includes(column);
  return true;
}

/** Returns, in column order, the columns of a table that the audit trigger does not copy. This is the list that the schema text writes. */
export function auditExcluded(a: DbspecAuditSetting, t: DbspecTable): string[] {
  return t.columns.filter(c => !auditRecords(a, c.name)).map(c => c.name);
}

/** A setting line. If columns is null, it writes no list; otherwise it writes the list keyword and its columns. */
export function auditLine(a: DbspecAuditSetting, list: 'exclude' | 'include', columns: readonly string[] | null): string {
  const head = `audit into ${a.into} column ${a.column} references ${a.references} action ${a.action} previous ${a.previous}`;
  return columns === null || columns.length === 0 ? head : `${head} ${list} (${columns.join(', ')})`;
}
