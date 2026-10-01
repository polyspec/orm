package dbspec

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// MySQL catalog query. 모두 현재 database 전체를 한 번에 읽는다.
const (
	mysqlTablesQuery = `SELECT TABLE_NAME, TABLE_TYPE, IFNULL(CREATE_OPTIONS, '') FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`
	mysqlColumnsQuery = `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA,
IFNULL(CHARACTER_SET_NAME, ''), IFNULL(COLLATION_NAME, ''), IFNULL(GENERATION_EXPRESSION, '')
FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`
	mysqlIndexesQuery = `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, IFNULL(COLUMN_NAME, ''), IFNULL(COLLATION, 'A'),
SUB_PART IS NOT NULL, EXPRESSION IS NOT NULL, INDEX_TYPE FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`
	mysqlForeignKeysQuery = `SELECT rc.TABLE_NAME, rc.CONSTRAINT_NAME, rc.REFERENCED_TABLE_NAME, rc.DELETE_RULE, rc.UPDATE_RULE,
rc.MATCH_OPTION, k.COLUMN_NAME, k.REFERENCED_COLUMN_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS rc
JOIN information_schema.KEY_COLUMN_USAGE k ON k.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
AND k.CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND k.TABLE_NAME = rc.TABLE_NAME
WHERE rc.CONSTRAINT_SCHEMA = DATABASE() ORDER BY rc.TABLE_NAME, rc.CONSTRAINT_NAME, k.ORDINAL_POSITION`
	// CHECK_CONSTRAINTS와 TABLE_CONSTRAINTS의 join은 table 수에 비례해 느려지므로
	// (2000 table에서 60초 이상) 두 query로 읽고 이름으로 잇는다. MySQL의 CHECK
	// 이름은 database 안에서 유일하다.
	mysqlCheckClausesQuery = `SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE() ORDER BY CONSTRAINT_NAME`
	mysqlChecksQuery = `SELECT TABLE_NAME, CONSTRAINT_NAME, ENFORCED FROM information_schema.TABLE_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'CHECK' ORDER BY TABLE_NAME, CONSTRAINT_NAME`
	mysqlTriggersQuery = `SELECT EVENT_OBJECT_TABLE, TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT
FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME`
	mysqlRoutinesQuery = `SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE() ORDER BY ROUTINE_NAME`
	mysqlEventsQuery   = `SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE() ORDER BY EVENT_NAME`
)

var mysqlTypePattern = regexp.MustCompile(`^(smallint|int|bigint|tinyint\(1\)|double|longtext|longblob|date|char\(36\)|time|datetime)(?:\((\d+)\))?$|^(decimal)\((\d+),(\d+)\)$|^(varchar)\((\d+)\)$`)

func readMySQL(ctx context.Context, q Querier) (*catalog, error) {
	c := &catalog{}
	err := eachRow(ctx, q, mysqlTablesQuery, func(r scanner) error {
		var name, kind, options string
		if err := r.Scan(&name, &kind, &options); err != nil {
			return err
		}
		if kind != "BASE TABLE" {
			c.report("view", name, name, "a %s has no dbspec definition", strings.ToLower(kind))
			return nil
		}
		if strings.Contains(options, "partitioned") {
			c.report("partition", name, name, "a partitioned table has no dbspec definition")
			return nil
		}
		c.tables = append(c.tables, &itable{name: name})
		return nil
	})
	if err != nil {
		return nil, err
	}
	columns := map[string]map[string]icolumn{}
	pending := map[string]map[string]string{} // 표: column: renderer CHECK가 있어야 정해지는 type 후보
	err = eachRow(ctx, q, mysqlColumnsQuery, func(r scanner) error {
		var table, name, columnType, nullable, extra, charset, collation, generation string
		var dflt sql.NullString
		if err := r.Scan(&table, &name, &columnType, &nullable, &dflt, &extra, &charset, &collation, &generation); err != nil {
			return err
		}
		t := c.table(table)
		if t == nil {
			return nil
		}
		col := icolumn{name: name, null: nullable == "YES"}
		typ, needsCheck, ok := mysqlType(columnType, charset, collation)
		if !ok || generation != "" {
			c.report("column", table, name, "type %s %s %s has no dbspec type", columnType, charset, collation)
			return nil
		}
		col.typ = typ
		extra = strings.TrimSpace(extra)
		switch {
		case extra == "auto_increment":
			col.identity = true
		case extra == "DEFAULT_GENERATED" && dflt.Valid:
			if !mysqlNow(dflt.String, typ) {
				c.report("column", table, name, "default %s is not a dbspec default", dflt.String)
				return nil
			}
			col.dflt = "now"
		case extra != "":
			c.report("column", table, name, "extra %s has no dbspec definition", extra)
			return nil
		case dflt.Valid:
			col.dflt = mysqlDefault(dflt.String, typ)
		}
		t.columns = append(t.columns, col)
		if columns[table] == nil {
			columns[table] = map[string]icolumn{}
		}
		columns[table][name] = col
		if needsCheck != "" {
			if pending[table] == nil {
				pending[table] = map[string]string{}
			}
			pending[table][name] = needsCheck
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := readMySQLIndexes(ctx, q, c); err != nil {
		return nil, err
	}
	if err := readMySQLForeignKeys(ctx, q, c); err != nil {
		return nil, err
	}
	checked := map[string]map[string]bool{}
	clauses := map[string]string{}
	err = eachRow(ctx, q, mysqlCheckClausesQuery, func(r scanner) error {
		var name, clause string
		if err := r.Scan(&name, &clause); err != nil {
			return err
		}
		clauses[name] = clause
		return nil
	})
	if err != nil {
		return nil, err
	}
	err = eachRow(ctx, q, mysqlChecksQuery, func(r scanner) error {
		var table, name, enforced string
		if err := r.Scan(&table, &name, &enforced); err != nil {
			return err
		}
		clause, ok := clauses[name]
		if !ok {
			return fmt.Errorf("check %s.%s has no CHECK_CLAUSE", table, name)
		}
		t := c.table(table)
		if t == nil {
			return nil
		}
		if enforced != "YES" {
			c.report("check", table, name, "the check is not enforced")
			return nil
		}
		if owner, column, generated := strings.Cut(name, "$"); generated {
			col, known := columns[table][column]
			if owner != table || !known || withoutIntroducers(clause) != withoutIntroducers(mysqlRendererCheck(col)) {
				c.report("check", table, name, "the check %s is not the renderer CHECK", clause)
				return nil
			}
			if checked[table] == nil {
				checked[table] = map[string]bool{}
			}
			checked[table][column] = true
			return nil
		}
		predicate, err := decodeCheck(DialectMySQL, clause, tableTypes(t))
		if err != nil {
			c.report("check", table, name, "%v", err)
			return nil
		}
		t.checks = append(t.checks, icheck{name: name, predicate: predicate})
		return nil
	})
	if err != nil {
		return nil, err
	}
	// renderer CHECK이 있어야 하는 type은 그 CHECK이 없으면 dbspec type이 아니다.
	for table, cols := range pending {
		for column, need := range cols {
			if !checked[table][column] {
				c.report("column", table, column, "%s without its renderer CHECK has no dbspec type", need)
				c.dropColumn(table, column)
			}
		}
	}
	if err := readMySQLTriggers(ctx, q, c); err != nil {
		return nil, err
	}
	for _, others := range []struct{ kind, query string }{
		{"routine", mysqlRoutinesQuery}, {"event", mysqlEventsQuery},
	} {
		err = eachRow(ctx, q, others.query, func(r scanner) error {
			var name string
			if err := r.Scan(&name); err != nil {
				return err
			}
			c.report(others.kind, "", name, "a %s has no dbspec definition", others.kind)
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return c, err
}

// mysqlType은 COLUMN_TYPE과 character set, collation을 dbspec type으로 읽는다.
// needsCheck는 renderer CHECK이 있어야 그 type이 되는 경우의 catalog type이다.
func mysqlType(columnType, charset, collation string) (typ Type, needsCheck string, ok bool) {
	m := mysqlTypePattern.FindStringSubmatch(columnType)
	if m == nil {
		return Type{}, "", false
	}
	text := charset == "utf8mb4" && collation == "utf8mb4_0900_bin"
	switch {
	case m[3] == "decimal":
		p, _ := strconv.Atoi(m[4])
		s, _ := strconv.Atoi(m[5])
		return Type{Kind: TypeDecimal, Precision: p, Scale: s}, "", charset == ""
	case m[6] == "varchar":
		n, _ := strconv.Atoi(m[7])
		return Type{Kind: TypeVarchar, Length: n}, "", text
	}
	precision := 0
	if m[2] != "" {
		precision, _ = strconv.Atoi(m[2])
	}
	switch m[1] {
	case "smallint":
		return Type{Kind: TypeI16}, "", m[2] == ""
	case "int":
		return Type{Kind: TypeI32}, "", m[2] == ""
	case "bigint":
		return Type{Kind: TypeI64}, "", m[2] == ""
	case "tinyint(1)":
		return Type{Kind: TypeBool}, columnType, true
	case "double":
		return Type{Kind: TypeF64}, "", m[2] == ""
	case "longtext":
		return Type{Kind: TypeText}, "", text
	case "longblob":
		return Type{Kind: TypeBytes}, "", true
	case "char(36)":
		return Type{Kind: TypeUUID}, columnType, charset == "ascii" && collation == "ascii_bin"
	case "date":
		return Type{Kind: TypeDate}, "", m[2] == ""
	case "time":
		return Type{Kind: TypeTime, Precision: precision}, columnType, true
	case "datetime":
		return Type{Kind: TypeDatetime, Precision: precision}, "", true
	}
	return Type{}, "", false
}

// mysqlRendererCheck는 renderer CHECK이 CHECK_CLAUSE에 남는 형식이다
// (docs/dialects.md "Introspection", "Checks").
func mysqlRendererCheck(col icolumn) string {
	c := "`" + col.name + "`"
	switch col.typ.Kind {
	case TypeBool:
		return "(" + c + " in (0,1))"
	case TypeUUID:
		return "regexp_like(" + c + ",_utf8mb4\\'" + uuidPattern + "\\',_utf8mb4\\'c\\')"
	case TypeTime:
		return "((" + c + " >= _utf8mb4\\'00:00:00\\') and (" + c + " < _utf8mb4\\'24:00:00\\'))"
	}
	return ""
}

// mysqlIntroducer는 CHECK_CLAUSE의 문자열 literal 앞 character set introducer다.
var mysqlIntroducer = regexp.MustCompile(`_[a-z0-9]+\\'`)

// withoutIntroducers는 character set introducer를 뺀 CHECK_CLAUSE다. ALTER TABLE은
// CHECK_CLAUSE를 다시 쓰며 introducer를 바꾸거나 빼므로(probe
// mysql.check.alter_rewrites_introducers) renderer CHECK은 introducer 없이
// 비교한다. 이 template의 literal은 ASCII이므로 의미가 같다.
func withoutIntroducers(clause string) string {
	return mysqlIntroducer.ReplaceAllString(clause, `\'`)
}

// mysqlNow는 DEFAULT_GENERATED default가 그 column의 renderer 시각 default인지
// 알려 준다.
func mysqlNow(text string, typ Type) bool {
	if typ.Kind != TypeDatetime {
		return false
	}
	if typ.Precision == 0 {
		return text == "CURRENT_TIMESTAMP"
	}
	return text == "CURRENT_TIMESTAMP("+strconv.Itoa(typ.Precision)+")"
}

// mysqlDefault는 escape를 푼 COLUMN_DEFAULT 값을 dbspec literal로 쓴다. parse가
// canonical form과 유효성을 정한다.
func mysqlDefault(value string, typ Type) string {
	switch typ.Kind {
	case TypeBool:
		if value == "1" {
			return "true"
		}
		if value == "0" {
			return "false"
		}
		return quote(value)
	case TypeI16, TypeI32, TypeI64, TypeDecimal, TypeF64:
		return value
	}
	return quote(value)
}

func readMySQLIndexes(ctx context.Context, q Querier, c *catalog) error {
	type indexRow struct {
		table, name, column, collation string
		unique, part, expression       bool
		kind                           string
	}
	var rows []indexRow
	err := eachRow(ctx, q, mysqlIndexesQuery, func(r scanner) error {
		var x indexRow
		var nonUnique int
		if err := r.Scan(&x.table, &x.name, &nonUnique, &x.column, &x.collation, &x.part, &x.expression, &x.kind); err != nil {
			return err
		}
		x.unique = nonUnique == 0
		rows = append(rows, x)
		return nil
	})
	if err != nil {
		return err
	}
	for i := 0; i < len(rows); {
		j := i
		for j < len(rows) && rows[j].table == rows[i].table && rows[j].name == rows[i].name {
			j++
		}
		group := rows[i:j]
		i = j
		t := c.table(group[0].table)
		if t == nil {
			continue
		}
		key := ikey{name: group[0].name}
		supported := group[0].kind == "BTREE"
		for _, x := range group {
			if x.part || x.expression || x.column == "" {
				supported = false
			}
			key.columns = append(key.columns, x.column)
			key.desc = append(key.desc, x.collation == "D")
		}
		switch {
		case !supported:
			c.report("index", t.name, key.name, "a prefix, expression or %s index has no dbspec definition", strings.ToLower(group[0].kind))
		case key.name == "PRIMARY":
			t.primary = key.columns
		case strings.Contains(key.name, "$"):
			c.report("index", t.name, key.name, "the name contains $")
		case group[0].unique:
			t.uniques = append(t.uniques, key)
		default:
			t.indexes = append(t.indexes, key)
		}
	}
	return nil
}

func readMySQLForeignKeys(ctx context.Context, q Querier, c *catalog) error {
	var current *ifk
	var currentTable *itable
	// 보고한 key의 나머지 column row는 건너뛴다.
	skipped := ""
	flush := func() {
		if current != nil && currentTable != nil {
			currentTable.fks = append(currentTable.fks, *current)
		}
		current, currentTable = nil, nil
	}
	err := eachRow(ctx, q, mysqlForeignKeysQuery, func(r scanner) error {
		var table, name, refTable, onDelete, onUpdate, match, column, refColumn string
		if err := r.Scan(&table, &name, &refTable, &onDelete, &onUpdate, &match, &column, &refColumn); err != nil {
			return err
		}
		if current != nil && (current.name != name || currentTable.name != table) {
			flush()
		}
		if skipped == table+"\x00"+name {
			return nil
		}
		skipped = ""
		if current == nil {
			t := c.table(table)
			del, okDelete := actionName(onDelete)
			upd, okUpdate := actionName(onUpdate)
			if t == nil {
				return nil
			}
			if !okDelete || !okUpdate || match != "NONE" {
				c.report("foreign_key", table, name, "actions %s, %s or match %s have no dbspec definition", onDelete, onUpdate, match)
				skipped = table + "\x00" + name
				return nil
			}
			current, currentTable = &ifk{name: name, table: refTable, onDelete: del, onUpdate: upd}, t
		}
		current.columns = append(current.columns, column)
		current.refs = append(current.refs, refColumn)
		return nil
	})
	flush()
	return err
}

// dropColumn은 type이 정해지지 않은 column을 뺀다.
func (c *catalog) dropColumn(table, column string) {
	t := c.table(table)
	for i, col := range t.columns {
		if col.name == column {
			t.columns = append(t.columns[:i], t.columns[i+1:]...)
			return
		}
	}
}

func tableTypes(t *itable) map[string]Type {
	out := map[string]Type{}
	for _, col := range t.columns {
		out[col.name] = col.typ
	}
	return out
}

type scanner interface{ Scan(dest ...any) error }

// eachRow는 query의 모든 row에 f를 부르고 rows의 error를 돌려준다.
func eachRow(ctx context.Context, q Querier, query string, f func(scanner) error) error {
	rows, err := q.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := f(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}

// readMySQLTriggers는 trigger를 renderer statement 형식으로 다시 쓰고 알아본다.
func readMySQLTriggers(ctx context.Context, q Querier, c *catalog) error {
	triggers := map[string][]itrigger{}
	err := eachRow(ctx, q, mysqlTriggersQuery, func(r scanner) error {
		var table, name, timing, event, statement string
		if err := r.Scan(&table, &name, &timing, &event, &statement); err != nil {
			return err
		}
		triggers[table] = append(triggers[table], itrigger{name: name,
			statements: []string{"CREATE TRIGGER `" + name + "` " + timing + " " + event + " ON `" + table + "` FOR EACH ROW " + statement}})
		return nil
	})
	if err != nil {
		return err
	}
	c.recognizeTriggers(DialectMySQL, triggers)
	return nil
}
