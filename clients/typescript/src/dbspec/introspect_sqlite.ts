// SQLite의 main database를 catalog으로 읽는다 (docs/dialects.md "Introspection").
// sqlite_master와 table-valued pragma를 join해 모든 table을 한 번에 읽는다.
import { actionName, Catalog, rendererCheckName, tableTypes, type CatalogQuery, type DbspecUnsupported, type IForeignKey } from './introspect_catalog.js';
import { CheckDecodeError, decodeCheck, unscaledDecimal } from './introspect_check.js';
import { recognizeTriggers, type ITrigger } from './introspect_trigger.js';
import type { DbspecAction, DbspecType } from './model.js';
import { Renderer } from './render.js';

const MASTER_QUERY = `SELECT type, name, tbl_name, IFNULL(sql, '') FROM sqlite_master
WHERE name NOT LIKE 'sqlite_%' AND tbl_name <> 'dbspec$plans' ORDER BY type, name`;
const COLUMNS_QUERY = `SELECT m.name, p.name, p.type, p."notnull", p.dflt_value, p.pk, p.hidden FROM sqlite_master m
JOIN pragma_table_xinfo(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid`;
const INDEXES_QUERY = `SELECT m.name, l.name, l."unique", l.origin, l.partial,
IFNULL((SELECT group_concat(IFNULL(x.name, ''), ',') FROM (SELECT name FROM pragma_index_xinfo(l.name) WHERE key = 1 ORDER BY seqno) x), ''),
IFNULL((SELECT group_concat(x."desc", ',') FROM (SELECT "desc" FROM pragma_index_xinfo(l.name) WHERE key = 1 ORDER BY seqno) x), '')
FROM sqlite_master m JOIN pragma_index_list(m.name) l WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, l.name`;

const DECLARED_PATTERN = /^(smallint|integer|bigint|BOOLEAN|REAL|TEXT|BLOB|DATE|TIME|DATETIME|INTEGER)$|^DECIMALINT\((\d+),(\d+)\)$|^varchar\((\d+)\)$/;
const FOREIGN_KEY_ITEM =
  /^CONSTRAINT "([^"]+)" FOREIGN KEY \(([^)]*)\) REFERENCES "([^"]+)" \(([^)]*)\) ON DELETE (RESTRICT|CASCADE|SET NULL) ON UPDATE (RESTRICT|CASCADE|SET NULL)$/;
const CHECK_ITEM = /^CONSTRAINT "([^"]+)" CHECK \((.*)\)$/;
const PRIMARY_KEY_ITEM = /^PRIMARY KEY \(([^)]*)\)$/;
const IDENTITY_COLUMN = /^"([^"]+)" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT$/;
const COLUMN_ITEM = /^"([^"]+)" /;
const CONSTRAINT_ITEM = /^(?:CONSTRAINT "([^"]+)" )?(CHECK|UNIQUE|FOREIGN KEY|PRIMARY KEY)\b/;
const NUMBER_DEFAULT = /^-?\d+(\.\d+)?$/;

/** CREATE TABLE text에서 읽은 constraint다. */
interface SqliteTable {
  /** 이름: 식 */
  checks: Map<string, string>;
  /** check 이름의 선언 순서 */
  order: string[];
  fks: IForeignKey[];
  primary: string[];
  identity: string;
  /** 이름: column 정의 text */
  columns: Map<string, string>;
  /** 비어 있지 않으면 table 전체를 읽지 못한 이유다. */
  unsupported: string;
}

export async function readSQLite(query: CatalogQuery): Promise<Catalog> {
  const c = new Catalog();
  const parsed = new Map<string, SqliteTable>();
  const triggers = new Map<string, ITrigger[]>();
  for (const r of await query(MASTER_QUERY)) {
    const [kind, name, table, text] = [r.text(0), r.text(1), r.text(2), r.text(3)];
    if (kind === 'table') {
      if (text.startsWith('CREATE VIRTUAL TABLE') || text.endsWith('WITHOUT ROWID')) {
        c.report('table', name, name, 'a virtual or WITHOUT ROWID table has no dbspec definition');
        continue;
      }
      const { table: st, unsupported } = parseSQLiteTable(text);
      if (st.unsupported !== '') {
        c.report('table', name, name, st.unsupported);
        continue;
      }
      for (const u of unsupported) c.report(u.kind, name, u.name, u.reason);
      parsed.set(name, st);
      c.addTable(name, st.primary, st.fks);
    } else if (kind === 'view') {
      c.report('view', name, name, 'a view has no dbspec definition');
    } else if (kind === 'trigger') {
      if (!triggers.has(table)) triggers.set(table, []);
      triggers.get(table)!.push({ name, statements: [text] });
    }
  }
  const renderer = new Renderer('sqlite');
  for (const r of await query(COLUMNS_QUERY)) {
    const [table, name, declared, notNull, dflt, hidden] = [r.text(0), r.text(1), r.text(2), r.integer(3), r.nullableText(4), r.integer(6)];
    // pk는 쓰지 않는다. primary key와 identity는 CREATE TABLE text가 정한다.
    r.integer(5);
    const t = c.table(table);
    if (t === undefined) continue;
    const st = parsed.get(table)!;
    if (hidden !== 0) {
      c.report('column', table, name, 'a generated column has no dbspec definition');
      continue;
    }
    if (st.identity !== name && !sqliteColumnText(st.columns.get(name) ?? '', name, declared, notNull !== 0, dflt)) {
      c.report('column', table, name, `the column definition ${JSON.stringify(st.columns.get(name) ?? '')} has clauses that dbspec does not read`);
      continue;
    }
    const checkName = rendererCheckName(table, name);
    const check = st.checks.get(checkName);
    let type: DbspecType;
    let identity = false;
    if (st.identity === name) {
      type = { kind: 'i64' };
      identity = true;
    } else {
      const read = sqliteType(renderer, declared, name, check);
      if (read === null) {
        c.report('column', table, name, `declared type ${declared} with CHECK ${JSON.stringify(check ?? '')} has no dbspec type`);
        continue;
      }
      type = read;
    }
    st.checks.delete(checkName);
    let value = '';
    if (dflt !== null) {
      const read = sqliteDefault(renderer, dflt, type);
      if (read === null) {
        c.report('column', table, name, `default ${dflt} is not a dbspec default`);
        continue;
      }
      value = read;
    }
    t.columns.push({ name, type, nullable: notNull === 0, identity, dflt: value });
  }
  for (const t of c.tables) {
    const st = parsed.get(t.name)!;
    for (const name of st.order) {
      const expression = st.checks.get(name);
      if (expression === undefined) continue;
      if (name.includes('$')) {
        c.report('check', t.name, name, `the check ${expression} is not the renderer CHECK`);
        continue;
      }
      let predicate: string;
      try {
        predicate = decodeCheck('sqlite', expression, tableTypes(t));
      } catch (error) {
        if (!(error instanceof CheckDecodeError)) throw error;
        c.report('check', t.name, name, error.message);
        continue;
      }
      t.checks.push({ name, predicate });
    }
  }
  for (const r of await query(INDEXES_QUERY)) {
    const [table, name, unique, origin, partial, columns, desc] = [r.text(0), r.text(1), r.integer(2), r.text(3), r.integer(4), r.text(5), r.text(6)];
    const t = c.table(table);
    // pk와 u origin index는 primary key와 unique 정의에서 나오며, 그 정의를 읽거나 보고한다.
    if (t === undefined || origin === 'pk' || origin === 'u') continue;
    const list = columns.split(',');
    if (origin !== 'c' || partial !== 0 || name.includes('$') || list.includes('')) {
      c.report('index', table, name, `an index of origin ${origin}, a partial or an expression index has no dbspec definition`);
      continue;
    }
    const key = { name, columns: list, desc: desc.split(',').map(d => d === '1') };
    if (unique !== 0) t.uniques.push(key);
    else t.indexes.push(key);
  }
  recognizeTriggers(c, 'sqlite', triggers);
  return c;
}

/**
 * 선언 type과 그 column의 renderer CHECK로 dbspec type을 정한다. CHECK은 그
 * type의 renderer 출력과 정확히 같아야 한다. check이 undefined면 CHECK이 없다.
 */
function sqliteType(r: Renderer, declared: string, column: string, check: string | undefined): DbspecType | null {
  const m = DECLARED_PATTERN.exec(declared);
  if (m === null) return null;
  let candidates: DbspecType[] = [];
  if (m[2] !== undefined) {
    candidates = [{ kind: 'decimal', precision: Number(m[2]), scale: Number(m[3]) }];
  } else if (m[4] !== undefined) {
    candidates = [{ kind: 'varchar', length: Number(m[4]) }];
  } else {
    switch (m[1]) {
      case 'smallint':
        candidates = [{ kind: 'i16' }];
        break;
      case 'integer':
      case 'INTEGER':
        // SQLite는 keyword인 integer를 INTEGER로 보고한다. identity는 CREATE text가 정한다.
        candidates = [{ kind: 'i32' }];
        break;
      case 'bigint':
        candidates = [{ kind: 'i64' }];
        break;
      case 'BOOLEAN':
        candidates = [{ kind: 'bool' }];
        break;
      case 'REAL':
        candidates = [{ kind: 'f64' }];
        break;
      case 'TEXT':
        candidates = [{ kind: 'text' }, { kind: 'uuid' }];
        break;
      case 'BLOB':
        candidates = [{ kind: 'bytes' }];
        break;
      case 'DATE':
        candidates = [{ kind: 'date' }];
        break;
      case 'TIME':
      case 'DATETIME': {
        const kind = m[1] === 'DATETIME' ? 'datetime' : 'time';
        for (let p = 0; p <= 6; p++) candidates.push({ kind, precision: p });
        break;
      }
    }
  }
  for (const type of candidates) {
    const want = r.typeCheck({ comments: [], name: column, type, nullable: false, identity: false, default: null });
    if ((want === '' && check === undefined) || (want !== '' && check !== undefined && want === check)) return type;
  }
  return null;
}

/** dflt_value를 dbspec literal이나 now로 읽는다. decimal은 scale을 곱한 정수이고 bool은 1과 0이다. 읽을 수 없으면 null이다. */
function sqliteDefault(r: Renderer, text: string, type: DbspecType): string | null {
  if (type.kind === 'datetime' && `(${text})` === r.defaultText(type, { kind: 'now' })) return 'now';
  if (type.kind === 'bool' && (text === '1' || text === '0')) return text === '1' ? 'true' : 'false';
  if (type.kind === 'decimal' && NUMBER_DEFAULT.test(text)) return unscaledDecimal(text, type.scale);
  if (NUMBER_DEFAULT.test(text)) return text;
  if (text.startsWith("'") && text.endsWith("'")) return text;
  return null;
}

/**
 * renderer가 쓰는 한 줄 CREATE TABLE text에서 primary key, identity, foreign
 * key, check를 읽는다. 그 밖의 table 수준 항목은 미지원이다.
 */
function parseSQLiteTable(text: string): { table: SqliteTable; unsupported: DbspecUnsupported[] } {
  const st: SqliteTable = { checks: new Map(), order: [], fks: [], primary: [], identity: '', columns: new Map(), unsupported: '' };
  const unsupported: DbspecUnsupported[] = [];
  const open = text.indexOf('(');
  if (open < 0 || !text.endsWith(')')) {
    st.unsupported = 'the CREATE TABLE text has no column list';
    return { table: st, unsupported: [] };
  }
  for (const item of splitTopLevel(text.slice(open + 1, -1))) {
    let m: RegExpExecArray | null;
    if ((m = IDENTITY_COLUMN.exec(item)) !== null) {
      st.identity = m[1]!;
      st.primary = [st.identity];
    } else if ((m = PRIMARY_KEY_ITEM.exec(item)) !== null) {
      st.primary = unquoteList(m[1]!);
    } else if ((m = FOREIGN_KEY_ITEM.exec(item)) !== null) {
      st.fks.push({
        name: m[1]!,
        columns: unquoteList(m[2]!),
        table: m[3]!,
        refs: unquoteList(m[4]!),
        onDelete: actionName(m[5]!) as DbspecAction,
        onUpdate: actionName(m[6]!) as DbspecAction,
      });
    } else if ((m = CHECK_ITEM.exec(item)) !== null) {
      st.checks.set(m[1]!, m[2]!);
      st.order.push(m[1]!);
    } else if ((m = CONSTRAINT_ITEM.exec(item)) !== null) {
      // 이름 없는 constraint는 이름이 빈 객체로 보고한다. primary key의 다른 형식은 table을 읽지 못하게 한다.
      const kind = ({ CHECK: 'check', UNIQUE: 'unique', 'FOREIGN KEY': 'foreign_key' } as Record<string, DbspecUnsupported['kind']>)[m[2]!];
      if (kind === undefined) {
        st.unsupported = `the primary key ${JSON.stringify(item)} has no dbspec definition`;
        return { table: st, unsupported: [] };
      }
      unsupported.push({ kind, table: '', name: m[1] ?? '', reason: `the table item ${JSON.stringify(item)} has no dbspec definition` });
    } else if ((m = COLUMN_ITEM.exec(item)) !== null) {
      // 정의는 pragma_table_xinfo가 읽고, 그 text는 renderer 형식인지 확인한다.
      st.columns.set(m[1]!, item);
    } else {
      st.unsupported = `the table item ${JSON.stringify(item)} has no dbspec definition`;
      return { table: st, unsupported: [] };
    }
  }
  return { table: st, unsupported };
}

/** 괄호와 따옴표 밖의 쉼표로 나눈다. */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== '') {
      if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out;
}

function unquoteList(text: string): string[] {
  return text.split(',').map(part => part.trim().replace(/^"+|"+$/g, ''));
}

/**
 * column 정의 text가 renderer의 column 형식, 곧 이름, 선언 type, NULL이나 NOT
 * NULL, 그리고 있으면 DEFAULT뿐인지 알려 준다. SQLite는 keyword인 type 이름을
 * 대문자로 보고하므로 type은 대소문자 없이 비교한다.
 */
function sqliteColumnText(item: string, name: string, declared: string, notNull: boolean, dflt: string | null): boolean {
  const prefix = `"${name}" `;
  if (!item.startsWith(prefix)) return false;
  let rest = item.slice(prefix.length);
  if (rest.length < declared.length || rest.slice(0, declared.length).toUpperCase() !== declared.toUpperCase()) return false;
  rest = rest.slice(declared.length);
  const tail = notNull ? ' NOT NULL' : ' NULL';
  if (dflt === null) return rest === tail;
  return rest === `${tail} DEFAULT ${dflt}` || rest === `${tail} DEFAULT (${dflt})`;
}
