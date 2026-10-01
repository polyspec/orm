// plan 없이 두 schema의 모든 차이를 나열한다 (docs/plans.md "Comparison").
// 기준은 Go 엔진(engine/dbspec/compare.go)이며 diagnostic message는 Go와 같은 바이트다.
import { dbspecManifest, emitDbspec } from './index.js';
import type { DbspecDiagnostic, DbspecDocument, DbspecSetting, DbspecTable } from './model.js';
import { columnOf, sameDefault, sameType, sortedKeys, widens } from './plan_diff.js';
import { foreignKeyDef, indexDef } from './plan_objects.js';

/** 두 schema의 차이 하나다. name은 column이나 객체의 이름이고, table 단위 차이에서는 빈 문자열이다. */
export interface DbspecDifference {
  readonly kind: string;
  readonly table: string;
  readonly name: string;
}

/** diagnostic 없는 차이, 또는 차이 없는 compare diagnostic이다. */
export type DbspecComparisonResult =
  | { readonly differences: readonly DbspecDifference[]; readonly diagnostics: readonly [] }
  | { readonly differences: null; readonly diagnostics: readonly DbspecDiagnostic[] };

/** 한 table 안에서 차이가 오는 순서다. */
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
 * plan 없이 source에서 target까지의 모든 차이를 돌려준다. rename은 없고 table과
 * column은 이름으로만 맞춘다. 두 문서는 schema text여야 하며, 아닌 쪽마다 compare
 * diagnostic을 source, target 순으로 돌려준다.
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
  return Object.freeze({ differences: Object.freeze(differences), diagnostics: Object.freeze([]) as readonly [] });
}

/** 문서의 canonical emission이 그 문서 하나의 schema text인지 알려 준다. */
function isSchemaText(document: DbspecDocument): boolean {
  const { manifest } = dbspecManifest([document]);
  return manifest !== null && emitDbspec(document) === manifest.schemaText;
}

/** 두 쪽에 다 있는 table의 column, primary key, 객체, setting 차이를 더한다. */
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
    const from = settingOf(s, kind);
    const to = settingOf(t, kind);
    if (from !== to) {
      if (from !== null) add(`drop_${kind}`, '');
      if (to !== null) add(`add_${kind}`, '');
    }
  }
}

/** 이름으로 맞춘 객체가 한쪽에만 있으면 drop이나 add를, 정의가 다르면 둘 다 더한다. */
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

/** table에 하나뿐인 setting의 정의, 없으면 null이다. */
function settingOf(t: DbspecTable, kind: 'immutable' | 'audit'): string | null {
  const setting: DbspecSetting | undefined = t.settings?.settings.find(x => x.kind === kind);
  if (setting === undefined) return null;
  return setting.kind === 'audit' ? `${setting.into} ${setting.operation} ${setting.action} ${setting.previous}` : setting.kind;
}
