// renderer가 쓴 trigger 집합을 immutable이나 audit setting으로 알아본다
// (docs/dialects.md "Introspection", "Triggers").
import { byteOrder, type Catalog, type ITable } from './introspect_catalog.js';
import type { DbspecSetting, DbspecTable } from './model.js';
import { Renderer, type DbspecDialect } from './render.js';

/** catalog trigger 하나를 renderer가 쓰는 statement 형식으로 다시 쓴 것이다. PostgreSQL은 function과 trigger statement 두 개다. */
export interface ITrigger {
  readonly name: string;
  readonly statements: readonly string[];
}

const AUDIT_INSERT_PATTERN = /^INSERT INTO [`"]([a-z0-9_]+)[`"] \([`"]([a-z0-9_]+)[`"], [`"]([a-z0-9_]+)[`"],/;
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
    const setting = triggerSetting(dialect, t, list);
    if (setting === null) {
      for (const tr of list) c.report('trigger', table, tr.name, 'the trigger is not the renderer output of immutable or audit');
      continue;
    }
    t.settings.push(setting);
  }
}

/** trigger 집합이 같은 renderer 출력을 주는 setting 줄을 돌려준다. 없으면 null이다. */
function triggerSetting(dialect: DbspecDialect, t: ITable, list: readonly ITrigger[]): string | null {
  const names = new Map(list.map(tr => [tr.name, tr]));
  const candidates: DbspecSetting[] = [];
  if (list.length === 2) candidates.push({ comments: [], kind: 'immutable' });
  const insert = names.get(`${t.name}$audit_insert`);
  if (insert !== undefined && list.length === 3) {
    const update = names.get(`${t.name}$audit_update`);
    const m = AUDIT_INSERT_PATTERN.exec(statementBody(insert.statements));
    const u = AUDIT_UPDATE_PATTERN.exec(statementBody(update?.statements ?? []));
    if (m !== null && u !== null) {
      candidates.push({ comments: [], kind: 'audit', into: m[1]!, action: m[2]!, previous: m[3]!, operation: u[1]! });
    }
  }
  const r = new Renderer(dialect);
  for (const setting of candidates) {
    const want = r.triggers(triggerModel(t, setting));
    const got: string[] = [];
    let complete = true;
    for (const name of triggerOrder(want)) {
      const tr = names.get(name);
      if (tr === undefined) {
        complete = false;
        break;
      }
      got.push(...tr.statements);
    }
    if (!complete || got.length !== want.length || got.some((s, i) => s !== want[i])) continue;
    if (setting.kind === 'immutable') return 'immutable';
    if (setting.kind === 'audit') {
      return `audit into ${setting.into} operation ${setting.operation} action ${setting.action} previous ${setting.previous}`;
    }
  }
  return null;
}

/** renderer가 trigger를 쓰는 데 필요한 table: 이름, column 이름과 type, setting 하나다. */
function triggerModel(t: ITable, setting: DbspecSetting): DbspecTable {
  return {
    comments: [],
    name: t.name,
    columns: t.columns.map(c => ({ comments: [], name: c.name, type: c.type, nullable: false, identity: false, default: null })),
    primaryKey: { comments: [], columns: [] },
    uniques: [],
    indexes: [],
    foreignKeys: [],
    checks: [],
    settings: { comments: [], settings: [setting], closingComments: [] },
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
