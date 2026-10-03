// audit setting이 기록하는 column(docs/dbspec.md "Audit").
import type { DbspecSetting, DbspecTable } from './model.js';

export type DbspecAuditSetting = Extract<DbspecSetting, { readonly kind: 'audit' }>;

/**
 * audit trigger가 column을 복사하는지 알린다. audit column은 언제나, exclude 목록의 column은
 * 언제나 아니며, include 목록이 있으면 그 column만 복사한다.
 */
export function auditRecords(a: DbspecAuditSetting, column: string): boolean {
  if (column === a.column) return true;
  if (a.exclude !== null) return !a.exclude.includes(column);
  if (a.include !== null) return a.include.includes(column);
  return true;
}

/** audit trigger가 복사하지 않는 table의 column을 column 순서로 돌려준다. schema text가 쓰는 목록이다. */
export function auditExcluded(a: DbspecAuditSetting, t: DbspecTable): string[] {
  return t.columns.filter(c => !auditRecords(a, c.name)).map(c => c.name);
}

/** setting 줄이다. columns가 null이면 목록 없이, 아니면 list keyword와 그 column을 쓴다. */
export function auditLine(a: DbspecAuditSetting, list: 'exclude' | 'include', columns: readonly string[] | null): string {
  const head = `audit into ${a.into} column ${a.column} references ${a.references} action ${a.action} previous ${a.previous}`;
  return columns === null || columns.length === 0 ? head : `${head} ${list} (${columns.join(', ')})`;
}
