package dbspec

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// MySQL catalog queries. All of them read the whole current database at once.
const (
	mysqlTablesQuery = `SELECT TABLE_NAME, TABLE_TYPE, IFNULL(CREATE_OPTIONS, '') FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME NOT LIKE 'dbspec$%' ORDER BY TABLE_NAME`
	mysqlColumnsQuery = `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA,
IFNULL(CHARACTER_SET_NAME, ''), IFNULL(COLLATION_NAME, ''), IFNULL(GENERATION_EXPRESSION, '')
FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME NOT LIKE 'dbspec$%' ORDER BY TABLE_NAME, ORDINAL_POSITION`
	mysqlIndexesQuery = `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, IFNULL(COLUMN_NAME, ''), IFNULL(COLLATION, 'A'),
SUB_PART IS NOT NULL, EXPRESSION IS NOT NULL, INDEX_TYPE FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`
	mysqlForeignKeysQuery = `SELECT rc.TABLE_NAME, rc.CONSTRAINT_NAME, rc.REFERENCED_TABLE_NAME, rc.DELETE_RULE, rc.UPDATE_RULE,
rc.MATCH_OPTION, k.COLUMN_NAME, k.REFERENCED_COLUMN_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS rc
JOIN information_schema.KEY_COLUMN_USAGE k ON k.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
AND k.CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND k.TABLE_NAME = rc.TABLE_NAME
WHERE rc.CONSTRAINT_SCHEMA = DATABASE() ORDER BY rc.TABLE_NAME, rc.CONSTRAINT_NAME, k.ORDINAL_POSITION`
	// The join of CHECK_CONSTRAINTS and TABLE_CONSTRAINTS gets slower in proportion to the table count, so
	// (over 60 seconds with 2000 tables) they are read in two queries and joined by name. MySQL's CHECK
	// names are unique within the database.
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
	pending := map[string]map[string]string{} // Table: column: the type candidate that is decided only when the renderer CHECK is present
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
		if generation != "" {
			c.report("column", table, name, "a generated column has no dbspec definition")
			return nil
		}
		typ, needsCheck, ok := mysqlType(columnType, charset, collation)
		if !ok {
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
	var checks [][3]string
	err = eachRow(ctx, q, mysqlChecksQuery, func(r scanner) error {
		var table, name, enforced string
		if err := r.Scan(&table, &name, &enforced); err != nil {
			return err
		}
		checks = append(checks, [3]string{table, name, enforced})
		return nil
	})
	if err != nil {
		return nil, err
	}
	shown, err := mysqlShownChecks(ctx, q, checks, clauses)
	if err != nil {
		return nil, err
	}
	handle := func(table, name, enforced string) error {
		clause, ok := clauses[name]
		if !ok {
			return fmt.Errorf("check %s.%s has no CHECK_CLAUSE", table, name)
		}
		if text, wide := shown[table][name]; wide {
			clause = text
		}
		t := c.table(table)
		if t == nil {
			return nil
		}
		if enforced != "YES" {
			c.report("check", table, name, "the check is not enforced")
			return nil
		}
		if strings.Contains(name, "$") {
			column, found := renderedColumn(table, name, columns[table])
			col := columns[table][column]
			if !found || withoutIntroducers(clause) != withoutIntroducers(mysqlRendererCheck(col)) {
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
	}
	for _, check := range checks {
		if err := handle(check[0], check[1], check[2]); err != nil {
			return nil, err
		}
	}
	// A type that needs the renderer CHECK is not a dbspec type without that CHECK.
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

// mysqlType reads COLUMN_TYPE, character set, and collation as a dbspec type.
// needsCheck is the catalog type for a case where the type holds only if the renderer CHECK is present.
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

// mysqlRendererCheck is the form in which a renderer CHECK remains in CHECK_CLAUSE
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

// mysqlIntroducer is the character set introducer before a string literal in CHECK_CLAUSE.
var mysqlIntroducer = regexp.MustCompile(`_[a-z0-9]+\\'`)

// mysqlTimeFraction is the fractional digits after a time literal in CHECK_CLAUSE, which are only 0.
var mysqlTimeFraction = regexp.MustCompile(`\\'(\d\d:\d\d:\d\d)\.0+\\'`)

// withoutIntroducers is CHECK_CLAUSE with the character set introducers removed. ALTER TABLE
// rewrites CHECK_CLAUSE, changing or removing introducers, so
// (probe mysql.check.alter_rewrites_introducers) the renderer CHECK is compared without introducers.
// The same rewrite adds fractional digits of 0 in the p position to a time literal that meets a time(p) column,
// (probe mysql.check.alter_writes_time_precision) so those digits are removed too.
// The literals in this template are ASCII, and fractional digits of 0 do not change the value, so the meaning is the same.
func withoutIntroducers(clause string) string {
	return mysqlTimeFraction.ReplaceAllString(mysqlIntroducer.ReplaceAllString(clause, `\'`), `\'$1\'`)
}

// mysqlShownChecks reads, from SHOW CREATE
// TABLE, the body of a check whose CHECK_CLAUSE has a byte of 0x80 or above. The MySQL 8.4.11 information_schema shows the UTF-8
// bytes of non-ASCII string literals encoded once more (`café` as `cafÃ©`), but SHOW CREATE TABLE writes the
// expression correctly. That CHECK_CLAUSE is the text the server stored, read as is, so it is not
// reversed on the client. The result is in CHECK_CLAUSE form: this function escapes the body of SHOW CREATE
// once more, as CHECK_CLAUSE does, and decodeCheck undoes that. It reads SHOW CREATE TABLE once per table,
// and runs only after rows is closed (it does not query inside rows that are open on the same connection).
func mysqlShownChecks(ctx context.Context, q Querier, checks [][3]string, clauses map[string]string) (map[string]map[string]string, error) {
	shown := map[string]map[string]string{}
	created := map[string]string{}
	for _, check := range checks {
		table, name := check[0], check[1]
		if !mysqlNonASCII(clauses[name]) {
			continue
		}
		if _, ok := created[table]; !ok {
			text, err := mysqlCreateTable(ctx, q, table)
			if err != nil {
				return nil, err
			}
			created[table] = text
		}
		if shown[table] == nil {
			shown[table] = map[string]string{}
		}
		clause, ok := mysqlShownCheck(created[table], name)
		if !ok {
			return nil, fmt.Errorf("check %s.%s has no CHECK in SHOW CREATE TABLE", table, name)
		}
		shown[table][name] = clause
	}
	return shown, nil
}

// mysqlCreateTable is the statement of SHOW CREATE TABLE.
func mysqlCreateTable(ctx context.Context, q Querier, table string) (string, error) {
	var text string
	err := eachRow(ctx, q, "SHOW CREATE TABLE `"+strings.ReplaceAll(table, "`", "``")+"`", func(r scanner) error {
		var name string
		return r.Scan(&name, &text)
	})
	return text, err
}

// mysqlShownCheck returns, in CHECK_CLAUSE form, the body of the CHECK named name in the SHOW CREATE TABLE statement
// The string literals of SHOW CREATE escape `\` and `'` once, so the body skips over those literals
// and ends at the ) that pairs with CHECK (.
func mysqlShownCheck(create, name string) (string, bool) {
	prefix := "CONSTRAINT `" + name + "` CHECK ("
	at := strings.Index(create, prefix)
	if at < 0 {
		return "", false
	}
	start := at + len(prefix)
	depth := 1
	for i := start; i < len(create); i++ {
		switch create[i] {
		case '\'':
			for i++; i < len(create) && create[i] != '\''; i++ {
				if create[i] == '\\' {
					i++
				}
			}
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return escapeMySQLClause(create[start:i]), true
			}
		}
	}
	return "", false
}

// escapeMySQLClause is the inverse of unescapeMySQLClause: it escapes `\` and `'`.
func escapeMySQLClause(text string) string {
	return strings.NewReplacer(`\`, `\\`, `'`, `\'`).Replace(text)
}

// mysqlNonASCII reports whether CHECK_CLAUSE has a byte of 0x80 or above.
func mysqlNonASCII(clause string) bool {
	for i := 0; i < len(clause); i++ {
		if clause[i] >= 0x80 {
			return true
		}
	}
	return false
}

// mysqlNow reports whether a DEFAULT_GENERATED default is the renderer clock default of that column,
// or not.
func mysqlNow(text string, typ Type) bool {
	if typ.Kind != TypeDatetime {
		return false
	}
	if typ.Precision == 0 {
		return text == "CURRENT_TIMESTAMP"
	}
	return text == "CURRENT_TIMESTAMP("+strconv.Itoa(typ.Precision)+")"
}

// mysqlDefault writes the COLUMN_DEFAULT value, with its escapes undone, as a dbspec literal. parse
// decides the canonical form and the validity.
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
	// The remaining column rows of a reported key are skipped.
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

// dropColumn removes a column whose type is not determined.
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

// eachRow calls f on every row of the query and returns the error of rows.
// If q is a QueryObserver, QueryEnded is called when all rows have been read or reading has failed.
func eachRow(ctx context.Context, q Querier, query string, f func(scanner) error) error {
	rows, err := q.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	var fErr error
	for rows.Next() {
		if fErr = f(rows); fErr != nil {
			break
		}
	}
	err = rows.Err()
	if closeErr := rows.Close(); err == nil {
		err = closeErr
	}
	if o, ok := q.(QueryObserver); ok {
		if oErr := o.QueryEnded(query, err); oErr != nil {
			return oErr
		}
	}
	if fErr != nil {
		return fErr
	}
	return err
}

// readMySQLTriggers rewrites triggers in renderer statement form and recognizes them.
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
