package dbspec

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// SQLite catalog query. sqlite_master와 table-valued pragma를 join해 모든
// table을 한 번에 읽는다.
const (
	sqliteMasterQuery = `SELECT type, name, tbl_name, IFNULL(sql, '') FROM sqlite_master
WHERE name NOT LIKE 'sqlite_%' AND tbl_name <> 'dbspec$plans' ORDER BY type, name`
	sqliteColumnsQuery = `SELECT m.name, p.name, p.type, p."notnull", p.dflt_value, p.pk, p.hidden FROM sqlite_master m
JOIN pragma_table_xinfo(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid`
	sqliteIndexesQuery = `SELECT m.name, l.name, l."unique", l.origin, l.partial,
IFNULL((SELECT group_concat(IFNULL(x.name, ''), ',') FROM (SELECT name FROM pragma_index_xinfo(l.name) WHERE key = 1 ORDER BY seqno) x), ''),
IFNULL((SELECT group_concat(x."desc", ',') FROM (SELECT "desc" FROM pragma_index_xinfo(l.name) WHERE key = 1 ORDER BY seqno) x), '')
FROM sqlite_master m JOIN pragma_index_list(m.name) l WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, l.name`
)

var (
	sqliteDeclaredPattern = regexp.MustCompile(`^(smallint|integer|bigint|BOOLEAN|REAL|TEXT|BLOB|DATE|TIME|DATETIME|INTEGER)$|^DECIMALINT\((\d+),(\d+)\)$|^varchar\((\d+)\)$`)
	sqliteForeignKeyItem  = regexp.MustCompile(`^CONSTRAINT "([^"]+)" FOREIGN KEY \(([^)]*)\) REFERENCES "([^"]+)" \(([^)]*)\) ON DELETE (RESTRICT|CASCADE|SET NULL) ON UPDATE (RESTRICT|CASCADE|SET NULL)$`)
	sqliteCheckItem       = regexp.MustCompile(`^CONSTRAINT "([^"]+)" CHECK \((.*)\)$`)
	sqlitePrimaryKeyItem  = regexp.MustCompile(`^PRIMARY KEY \(([^)]*)\)$`)
	sqliteIdentityColumn  = regexp.MustCompile(`^"([^"]+)" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT$`)
	sqliteColumnItem      = regexp.MustCompile(`^"([^"]+)" `)
	sqliteConstraintItem  = regexp.MustCompile(`^(?:CONSTRAINT "([^"]+)" )?(CHECK|UNIQUE|FOREIGN KEY|PRIMARY KEY)\b`)
	sqliteNumberDefault   = regexp.MustCompile(`^-?\d+(\.\d+)?$`)
)

// sqliteTable은 CREATE TABLE text에서 읽은 constraint다.
type sqliteTable struct {
	checks   map[string]string // 이름: 식
	order    []string          // check 이름의 선언 순서
	fks      []ifk
	primary  []string
	identity string
	columns  map[string]string // 이름: column 정의 text
	// unsupported가 비어 있지 않으면 table 전체를 읽지 못한 이유다.
	unsupported string
}

func readSQLite(ctx context.Context, q Querier) (*catalog, error) {
	c := &catalog{}
	parsed := map[string]*sqliteTable{}
	var triggers = map[string][]itrigger{}
	err := eachRow(ctx, q, sqliteMasterQuery, func(r scanner) error {
		var kind, name, table, text string
		if err := r.Scan(&kind, &name, &table, &text); err != nil {
			return err
		}
		switch kind {
		case "table":
			if strings.HasPrefix(text, "CREATE VIRTUAL TABLE") || strings.HasSuffix(text, "WITHOUT ROWID") {
				c.report("table", name, name, "a virtual or WITHOUT ROWID table has no dbspec definition")
				return nil
			}
			st, unsupported := parseSQLiteTable(text)
			if st.unsupported != "" {
				c.report("table", name, name, "%s", st.unsupported)
				return nil
			}
			for _, u := range unsupported {
				c.report(u.Kind, name, u.Name, "%s", u.Reason)
			}
			parsed[name] = st
			c.tables = append(c.tables, &itable{name: name, primary: st.primary, fks: st.fks})
		case "view":
			c.report("view", name, name, "a view has no dbspec definition")
		case "trigger":
			triggers[table] = append(triggers[table], itrigger{name: name, statements: []string{text}})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	r := renderer{d: DialectSQLite}
	err = eachRow(ctx, q, sqliteColumnsQuery, func(row scanner) error {
		var table, name, declared string
		var notNull, pk, hidden int
		var dflt sql.NullString
		if err := row.Scan(&table, &name, &declared, &notNull, &dflt, &pk, &hidden); err != nil {
			return err
		}
		t := c.table(table)
		if t == nil {
			return nil
		}
		st := parsed[table]
		if hidden != 0 {
			c.report("column", table, name, "a generated column has no dbspec definition")
			return nil
		}
		col := icolumn{name: name, null: notNull == 0}
		if st.identity != name && !sqliteColumnText(st.columns[name], name, declared, notNull != 0, dflt) {
			c.report("column", table, name, "the column definition %q has clauses that dbspec does not read", st.columns[name])
			return nil
		}
		check, hasCheck := st.checks[rendererCheckName(table, name)]
		if st.identity == name {
			col.typ, col.identity = Type{Kind: TypeI64}, true
		} else {
			typ, ok := sqliteType(r, declared, name, check, hasCheck)
			if !ok {
				c.report("column", table, name, "declared type %s with CHECK %q has no dbspec type", declared, check)
				return nil
			}
			col.typ = typ
		}
		delete(st.checks, rendererCheckName(table, name))
		if dflt.Valid {
			value, ok := sqliteDefault(r, dflt.String, col.typ)
			if !ok {
				c.report("column", table, name, "default %s is not a dbspec default", dflt.String)
				return nil
			}
			col.dflt = value
		}
		t.columns = append(t.columns, col)
		return nil
	})
	if err != nil {
		return nil, err
	}
	for _, t := range c.tables {
		st := parsed[t.name]
		for _, name := range st.order {
			expression, ok := st.checks[name]
			if !ok {
				continue
			}
			if strings.Contains(name, "$") {
				c.report("check", t.name, name, "the check %s is not the renderer CHECK", expression)
				continue
			}
			predicate, err := decodeCheck(DialectSQLite, expression, tableTypes(t))
			if err != nil {
				c.report("check", t.name, name, "%v", err)
				continue
			}
			t.checks = append(t.checks, icheck{name: name, predicate: predicate})
		}
	}
	err = eachRow(ctx, q, sqliteIndexesQuery, func(row scanner) error {
		var table, name, origin, columns, desc string
		var unique, partial int
		if err := row.Scan(&table, &name, &unique, &origin, &partial, &columns, &desc); err != nil {
			return err
		}
		t := c.table(table)
		// pk와 u origin index는 primary key와 unique 정의에서 나오며, 그 정의를
		// 읽거나 보고한다.
		if t == nil || origin == "pk" || origin == "u" {
			return nil
		}
		list := strings.Split(columns, ",")
		if origin != "c" || partial != 0 || strings.Contains(name, "$") || slicesContainEmpty(list) {
			c.report("index", table, name, "an index of origin %s, a partial or an expression index has no dbspec definition", origin)
			return nil
		}
		key := ikey{name: name, columns: list}
		for _, d := range strings.Split(desc, ",") {
			key.desc = append(key.desc, d == "1")
		}
		if unique != 0 {
			t.uniques = append(t.uniques, key)
		} else {
			t.indexes = append(t.indexes, key)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	c.recognizeTriggers(DialectSQLite, triggers)
	return c, nil
}

func slicesContainEmpty(list []string) bool {
	for _, s := range list {
		if s == "" {
			return true
		}
	}
	return false
}

// sqliteType은 선언 type과 그 column의 renderer CHECK로 dbspec type을 정한다.
// CHECK은 그 type의 renderer 출력과 정확히 같아야 한다.
func sqliteType(r renderer, declared, column, check string, hasCheck bool) (Type, bool) {
	m := sqliteDeclaredPattern.FindStringSubmatch(declared)
	if m == nil {
		return Type{}, false
	}
	var candidates []Type
	switch {
	case m[2] != "":
		p, _ := strconv.Atoi(m[2])
		s, _ := strconv.Atoi(m[3])
		candidates = []Type{{Kind: TypeDecimal, Precision: p, Scale: s}}
	case m[4] != "":
		n, _ := strconv.Atoi(m[4])
		candidates = []Type{{Kind: TypeVarchar, Length: n}}
	default:
		switch m[1] {
		case "smallint":
			candidates = []Type{{Kind: TypeI16}}
		case "integer", "INTEGER":
			// SQLite는 keyword인 integer를 INTEGER로 보고한다. identity는 CREATE text가 정한다.
			candidates = []Type{{Kind: TypeI32}}
		case "bigint":
			candidates = []Type{{Kind: TypeI64}}
		case "BOOLEAN":
			candidates = []Type{{Kind: TypeBool}}
		case "REAL":
			candidates = []Type{{Kind: TypeF64}}
		case "TEXT":
			candidates = []Type{{Kind: TypeText}, {Kind: TypeUUID}}
		case "BLOB":
			candidates = []Type{{Kind: TypeBytes}}
		case "DATE":
			candidates = []Type{{Kind: TypeDate}}
		case "TIME", "DATETIME":
			kind := TypeTime
			if m[1] == "DATETIME" {
				kind = TypeDatetime
			}
			for p := 0; p <= 6; p++ {
				candidates = append(candidates, Type{Kind: kind, Precision: p})
			}
		}
	}
	for _, typ := range candidates {
		want := r.typeCheck(Column{Name: column, Type: typ})
		if (want == "" && !hasCheck) || (want != "" && hasCheck && want == check) {
			return typ, true
		}
	}
	return Type{}, false
}

// sqliteDefault는 dflt_value를 dbspec literal이나 now로 읽는다. decimal은 scale을
// 곱한 정수이고 bool은 1과 0이다.
func sqliteDefault(r renderer, text string, typ Type) (string, bool) {
	if typ.Kind == TypeDatetime && "("+text+")" == r.defaultText(typ, Default{Now: true}) {
		return "now", true
	}
	switch {
	case typ.Kind == TypeBool && (text == "1" || text == "0"):
		if text == "1" {
			return "true", true
		}
		return "false", true
	case typ.Kind == TypeDecimal && sqliteNumberDefault.MatchString(text):
		return unscaledDecimal(text, typ.Scale), true
	case sqliteNumberDefault.MatchString(text):
		return text, true
	case strings.HasPrefix(text, "'") && strings.HasSuffix(text, "'"):
		return text, true
	}
	return "", false
}

// parseSQLiteTable은 renderer가 쓰는 한 줄 CREATE TABLE text에서 primary key,
// identity, foreign key, check를 읽는다. 그 밖의 table 수준 항목은 미지원이다.
func parseSQLiteTable(text string) (*sqliteTable, []Unsupported) {
	st := &sqliteTable{checks: map[string]string{}, columns: map[string]string{}}
	var unsupported []Unsupported
	open := strings.IndexByte(text, '(')
	if open < 0 || !strings.HasSuffix(text, ")") {
		st.unsupported = "the CREATE TABLE text has no column list"
		return st, nil
	}
	for _, item := range splitTopLevel(text[open+1 : len(text)-1]) {
		switch {
		case sqliteIdentityColumn.MatchString(item):
			st.identity = sqliteIdentityColumn.FindStringSubmatch(item)[1]
			st.primary = []string{st.identity}
		case sqlitePrimaryKeyItem.MatchString(item):
			st.primary = unquoteList(sqlitePrimaryKeyItem.FindStringSubmatch(item)[1])
		case sqliteForeignKeyItem.MatchString(item):
			m := sqliteForeignKeyItem.FindStringSubmatch(item)
			del, _ := actionName(m[5])
			upd, _ := actionName(m[6])
			st.fks = append(st.fks, ifk{name: m[1], columns: unquoteList(m[2]), table: m[3], refs: unquoteList(m[4]), onDelete: del, onUpdate: upd})
		case sqliteCheckItem.MatchString(item):
			m := sqliteCheckItem.FindStringSubmatch(item)
			st.checks[m[1]] = m[2]
			st.order = append(st.order, m[1])
		case sqliteConstraintItem.MatchString(item):
			// 이름 없는 constraint는 이름이 빈 객체로 보고한다. primary key의 다른
			// 형식은 table을 읽지 못하게 한다.
			m := sqliteConstraintItem.FindStringSubmatch(item)
			kind := map[string]string{"CHECK": "check", "UNIQUE": "unique", "FOREIGN KEY": "foreign_key"}[m[2]]
			if kind == "" {
				st.unsupported = fmt.Sprintf("the primary key %q has no dbspec definition", item)
				return st, nil
			}
			unsupported = append(unsupported, Unsupported{Kind: kind, Name: m[1], Reason: fmt.Sprintf("the table item %q has no dbspec definition", item)})
		case sqliteColumnItem.MatchString(item):
			// 정의는 pragma_table_xinfo가 읽고, 그 text는 renderer 형식인지 확인한다.
			st.columns[sqliteColumnItem.FindStringSubmatch(item)[1]] = item
		default:
			st.unsupported = fmt.Sprintf("the table item %q has no dbspec definition", item)
			return st, nil
		}
	}
	return st, unsupported
}

// splitTopLevel은 괄호와 따옴표 밖의 쉼표로 나눈다.
func splitTopLevel(text string) []string {
	var out []string
	depth, start := 0, 0
	var quote byte
	for i := 0; i < len(text); i++ {
		ch := text[i]
		switch {
		case quote != 0:
			if ch == quote {
				quote = 0
			}
		case ch == '\'' || ch == '"':
			quote = ch
		case ch == '(':
			depth++
		case ch == ')':
			depth--
		case ch == ',' && depth == 0:
			out = append(out, strings.TrimSpace(text[start:i]))
			start = i + 1
		}
	}
	return append(out, strings.TrimSpace(text[start:]))
}

func unquoteList(text string) []string {
	var out []string
	for _, part := range strings.Split(text, ",") {
		out = append(out, strings.Trim(strings.TrimSpace(part), `"`))
	}
	return out
}

// sqliteColumnText는 column 정의 text가 renderer의 column 형식, 곧 이름, 선언
// type, NULL이나 NOT NULL, 그리고 있으면 DEFAULT뿐인지 알려 준다. 그 밖의
// clause(CHECK, REFERENCES, UNIQUE, COLLATE 등)가 있으면 false다. SQLite는
// keyword인 type 이름을 대문자로 보고하므로 type은 대소문자 없이 비교한다.
func sqliteColumnText(item, name, declared string, notNull bool, dflt sql.NullString) bool {
	rest, ok := strings.CutPrefix(item, `"`+name+`" `)
	if !ok || len(rest) < len(declared) || !strings.EqualFold(rest[:len(declared)], declared) {
		return false
	}
	rest = rest[len(declared):]
	tail := " NULL"
	if notNull {
		tail = " NOT NULL"
	}
	if !dflt.Valid {
		return rest == tail
	}
	return rest == tail+" DEFAULT "+dflt.String || rest == tail+" DEFAULT ("+dflt.String+")"
}
