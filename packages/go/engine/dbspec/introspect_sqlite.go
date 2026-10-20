package dbspec

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// SQLite catalog queries. They join sqlite_master with table-valued pragmas, to read every
// table at once.
const (
	sqliteMasterQuery = `SELECT type, name, tbl_name, IFNULL(sql, '') FROM sqlite_master
WHERE name NOT LIKE 'sqlite_%' AND tbl_name NOT LIKE 'dbspec$%' ORDER BY type, name`
	sqliteColumnsQuery = `SELECT m.name, p.name, p.type, p."notnull", p.dflt_value, p.pk, p.hidden FROM sqlite_master m
JOIN pragma_table_xinfo(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND p.name NOT LIKE 'dbspec$%' ORDER BY m.name, p.cid`
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

// sqliteTable is a constraint read from the CREATE TABLE text.
type sqliteTable struct {
	checks   map[string]string // Name: expression
	order    []string          // declaration order of the check name
	fks      []ifk
	primary  []string
	identity string
	columns  map[string]string // Name: column definition text
	// If unsupported is not empty, it is the reason the whole table could not be read.
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
		check, hasCheck := st.checks[rendererName(table, name)]
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
		delete(st.checks, rendererName(table, name))
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
		// The pk and u origin indexes come from the primary key and unique definitions, and that definition
		// is read or reported.
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

// sqliteType decides the dbspec type from the declared type and the column's renderer CHECK.
// The CHECK must match the renderer output of that type exactly.
func sqliteType(r renderer, declared, column, check string, hasCheck bool) (Type, bool) {
	m := sqliteDeclaredPattern.FindStringSubmatch(declared)
	if m == nil {
		return Type{}, false
	}
	var candidates []Type
	switch {
	case m[2] != "":
		p, s, ok := decimalDigits(m[2], m[3])
		if !ok {
			return Type{}, false
		}
		candidates = []Type{{Kind: TypeDecimal, Precision: p, Scale: s}}
	case m[4] != "":
		n, err := strconv.Atoi(m[4])
		if err != nil {
			return Type{}, false
		}
		candidates = []Type{{Kind: TypeVarchar, Length: n}}
	default:
		switch m[1] {
		case "smallint":
			candidates = []Type{{Kind: TypeI16}}
		case "integer", "INTEGER":
			// SQLite reports the keyword integer as INTEGER. Identity is decided by the CREATE text.
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

// sqliteDefault reads dflt_value as a dbspec literal or now. A decimal is the integer multiplied by the scale,
// and a bool is 1 or 0.
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

// parseSQLiteTable reads the primary key, identity, foreign keys, and checks from the one-line CREATE TABLE text that the renderer writes,
// reads the primary key, identity, foreign keys, and checks. Other table-level items are unsupported.
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
			// A constraint without a name is reported as an object with an empty name. A primary key in another
			// form makes the table unreadable.
			m := sqliteConstraintItem.FindStringSubmatch(item)
			kind := map[string]string{"CHECK": "check", "UNIQUE": "unique", "FOREIGN KEY": "foreign_key"}[m[2]]
			if kind == "" {
				st.unsupported = fmt.Sprintf("the primary key %q has no dbspec definition", item)
				return st, nil
			}
			unsupported = append(unsupported, Unsupported{Kind: kind, Name: m[1], Reason: fmt.Sprintf("the table item %q has no dbspec definition", item)})
		case sqliteColumnItem.MatchString(item):
			// Its definition is read by pragma_table_xinfo, and the text is checked to be in renderer form.
			st.columns[sqliteColumnItem.FindStringSubmatch(item)[1]] = item
		default:
			st.unsupported = fmt.Sprintf("the table item %q has no dbspec definition", item)
			return st, nil
		}
	}
	return st, unsupported
}

// splitTopLevel splits on commas outside parentheses and quotes.
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

// sqliteColumnText reports whether the column definition text is only the renderer's column form: name, declared
// type, NULL or NOT NULL, and DEFAULT if present.
// It is false if there is any other clause (CHECK, REFERENCES, UNIQUE, COLLATE, and so on). SQLite
// reports a type name that is a keyword in uppercase, so types are compared without regard to case.
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
