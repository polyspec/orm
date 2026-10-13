// renderer가 쓴 trigger 집합을 immutable이나 audit setting으로 알아본다
// (docs/dialects.md "Introspection", "Triggers").
import { byteOrder, type Catalog, type ITable } from './introspect_catalog.js';
import type { DbspecSetting, DbspecTable } from './model.js';
import { auditLine } from './audit.js';
import { Renderer, type DbspecDialect } from './render.js';import { rendererName } from './names.js';


/** catalog trigger 하나를 renderer가 쓰는 statement 형식으로 다시 쓴 것이다. PostgreSQL은 function과 trigger statement 두 개다. */
export interface ITrigger {
  readonly name: string;
  readonly statements: readonly string[];
}

const AUDIT_INSERT_PATTERN = /^INSERT INTO [`"]([a-z0-9_]+)[`"] \(([^)]*)\) VALUES /;
const AUDIT_COLUMN_PATTERN = /^[`"]([a-z0-9_]+)[`"]$/;
const AUDIT_UPDATE_PATTERN = /VALUES \('update', OLD\.[`"]([a-z0-9_]+)[`"],/;

/**
 * table마다 trigger 집합이 immutable이나 audit의 renderer 출력과 같으면 그
 * setting을 더하고, 아니면 모든 trigger를 미지원으로 보고한다. triggers는
 * table 이름마다 catalog 순서의 trigger다.
 */
export function recognizeTriggers(c: Catalog, dialect: DbspecDialect, triggers: ReadonlyMap<string, readonly ITrigger[]>): void {
  for (const table of [...triggers.keys()].sort(byteOrder)) {
    const list = triggers.get(table)!;
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
 * 각 setting을 자기 trigger 이름(재계산한 renderer 이름)으로 알아보고, trigger 집합이 알아본 setting들의
 * renderer 출력과 이름과 내용이 모두 같을 때만 그 setting 줄들을 돌려준다. 아니면 null이다(docs/dialects.md
 * "Triggers"). 두 setting을 함께 쓴 table은 두 출력의 합이며 개수로 판단하지 않는다.
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
    const audit = m !== null && u !== null ? auditOf(t, m[1]!, m[2]!.split(', '), u[1]!) : null;
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
 * audit insert trigger의 column 목록(action, previous, 기록하는 column)과 update trigger의 audit column으로
 * audit setting을 만든다. audit 기록 table은 audit column 하나만 가진 table의 foreign key가 가리키는
 * table이다. 기록하지 않는 column은 table의 column 순서로 exclude 목록이 된다. 목록이 renderer 형식이
 * 아니거나, audit column을 기록하지 않거나, 그 foreign key가 하나가 아니면 null이다. 만든 setting은 다시
 * 렌더링해 catalog trigger와 비교한다.
 */
function auditOf(t: ITable, into: string, quoted: readonly string[], column: string): DbspecSetting | null {
  const names: string[] = [];
  for (const q of quoted) {
    const m = AUDIT_COLUMN_PATTERN.exec(q);
    if (m === null) return null;
    names.push(m[1]!);
  }
  const recorded = names.slice(2);
  if (recorded.length === 0 || !recorded.includes(column)) return null;
  const references = t.fks.filter(f => f.columns.length === 1 && f.columns[0] === column).map(f => f.table);
  if (references.length !== 1) return null;
  const excluded = t.columns.filter(c => !recorded.includes(c.name)).map(c => c.name);
  return {
    comments: [], kind: 'audit', into, column, references: references[0]!, action: names[0]!, previous: names[1]!,
    exclude: excluded.length === 0 ? null : excluded, include: null,
  };
}

/** renderer가 trigger를 쓰는 데 필요한 table: 이름, column 이름과 type, setting 하나다. */
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

/** renderer statement 목록에서 trigger 이름을 순서대로 꺼낸다. */
function triggerOrder(statements: readonly string[]): string[] {
  const names: string[] = [];
  for (const s of statements) {
    if (!s.startsWith('CREATE TRIGGER ')) continue;
    const rest = s.slice('CREATE TRIGGER '.length);
    const end = rest.indexOf(rest[0]!, 1);
    names.push(rest.slice(1, end));
  }
  return names;
}

/** trigger statement에서 본문을 꺼낸다: MySQL은 FOR EACH ROW 뒤, PostgreSQL은 function의 BEGIN 뒤, SQLite는 BEGIN 뒤다. */
function statementBody(statements: readonly string[]): string {
  for (const s of statements) {
    for (const marker of ['$$BEGIN ', 'FOR EACH ROW BEGIN ', 'FOR EACH ROW ']) {
      const i = s.indexOf(marker);
      if (i >= 0) return s.slice(i + marker.length);
    }
  }
  return '';
}
