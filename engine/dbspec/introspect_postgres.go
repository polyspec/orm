package dbspec

import (
	"context"
	"database/sql"
	"regexp"
	"strconv"
	"strings"
)

// PostgreSQL catalog query. 모두 현재 schema 전체를 한 번에 읽는다.
const (
	postgresTablesQuery = `SELECT c.relname, c.relkind::text, c.relispartition FROM pg_class c
WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND c.relname NOT LIKE 'dbspec$%' ORDER BY c.relname`
	postgresSequencesQuery = `SELECT c.relname FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'S'
AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'i') ORDER BY c.relname`
	postgresColumnsQuery = `SELECT c.relname, a.attname, quote_ident(a.attname), format_type(a.atttypid, a.atttypmod), a.attnotnull,
pg_get_expr(d.adbin, d.adrelid), a.attidentity::text, a.attgenerated::text, coalesce(co.collname, '')
FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
LEFT JOIN pg_collation co ON co.oid = a.attcollation
WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND a.attname NOT LIKE 'dbspec$%'
ORDER BY c.relname, a.attnum`
	postgresConstraintsQuery = `SELECT c.relname, con.conname, con.contype::text, pg_get_constraintdef(con.oid), con.condeferrable,
con.convalidated, con.confmatchtype::text, con.confdeltype::text, con.confupdtype::text, CASE WHEN r.relnamespace = c.relnamespace THEN r.relname ELSE '' END,
array_to_string(ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, o)
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.o), ','),
array_to_string(ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, o)
  JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.o), ',')
FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid LEFT JOIN pg_class r ON r.oid = con.confrelid
WHERE c.relnamespace = current_schema()::regnamespace AND con.contype <> 'n' ORDER BY c.relname, con.conname`
	postgresIndexesQuery = `SELECT c.relname, i.relname, x.indisunique, x.indpred IS NOT NULL, x.indexprs IS NOT NULL,
x.indnatts <> x.indnkeyatts, am.amname,
array_to_string(ARRAY(SELECT a.attname FROM unnest(x.indkey) WITH ORDINALITY k(n, o)
  JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.n ORDER BY k.o), ','),
array_to_string(ARRAY(SELECT (o & 1)::text FROM unnest(x.indoption::int2[]) o), ',')
FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid JOIN pg_am am ON am.oid = i.relam
WHERE c.relnamespace = current_schema()::regnamespace
AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = x.indexrelid AND con.contype IN ('p', 'u', 'x'))
ORDER BY c.relname, i.relname`
	postgresTriggersQuery = `SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid), p.proname, p.prosrc, l.lanname
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_language l ON l.oid = p.prolang
WHERE NOT t.tgisinternal AND c.relnamespace = current_schema()::regnamespace ORDER BY c.relname, t.tgname`
	postgresRoutinesQuery = `SELECT p.proname FROM pg_proc p WHERE p.pronamespace = current_schema()::regnamespace ORDER BY p.proname`
)

var (
	postgresTypePattern    = regexp.MustCompile(`^(smallint|integer|bigint|boolean|double precision|text|bytea|uuid|date)$|^numeric\((\d+),(\d+)\)$|^character varying\((\d+)\)$|^(time|timestamp)\((\d)\) without time zone$`)
	postgresLiteralPattern = regexp.MustCompile(`^'((?:[^']|'')*)'::([a-z ]+)$`)
	postgresTriggerPattern = regexp.MustCompile(`^CREATE TRIGGER (\S+) (BEFORE|AFTER) (INSERT|UPDATE|DELETE) ON (?:\S+\.)?(\S+) FOR EACH ROW EXECUTE FUNCTION (\S+)\(\)$`)
)

func readPostgres(ctx context.Context, q Querier) (*catalog, error) {
	c := &catalog{}
	err := eachRow(ctx, q, postgresTablesQuery, func(r scanner) error {
		var name, kind string
		var partition bool
		if err := r.Scan(&name, &kind, &partition); err != nil {
			return err
		}
		switch {
		case kind == "p" || partition:
			c.report("partition", name, name, "a partitioned table or a partition has no dbspec definition")
		case kind == "r":
			c.tables = append(c.tables, &itable{name: name})
		default:
			c.report("view", name, name, "a relation of kind %s has no dbspec definition", kind)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	err = eachRow(ctx, q, postgresSequencesQuery, func(r scanner) error {
		var name string
		if err := r.Scan(&name); err != nil {
			return err
		}
		c.report("sequence", "", name, "a sequence outside identity has no dbspec definition")
		return nil
	})
	if err != nil {
		return nil, err
	}
	quoted := map[string]map[string]string{}
	pending := map[string]map[string]bool{}
	err = eachRow(ctx, q, postgresColumnsQuery, func(r scanner) error {
		var table, name, quotedName, formatted, identity, generated, collation string
		var notNull bool
		var dflt sql.NullString
		if err := r.Scan(&table, &name, &quotedName, &formatted, &notNull, &dflt, &identity, &generated, &collation); err != nil {
			return err
		}
		t := c.table(table)
		if t == nil {
			return nil
		}
		if generated != "" {
			c.report("column", table, name, "a generated column has no dbspec definition")
			return nil
		}
		typ, ok := postgresType(formatted, collation)
		if !ok {
			c.report("column", table, name, "type %s with collation %q has no dbspec type", formatted, collation)
			return nil
		}
		col := icolumn{name: name, typ: typ, null: !notNull}
		switch identity {
		case "d":
			col.identity = true
		case "a":
			c.report("column", table, name, "an identity generated always has no dbspec definition")
			return nil
		}
		if dflt.Valid {
			value, ok := postgresDefault(dflt.String, typ)
			if !ok {
				c.report("column", table, name, "default %s is not a dbspec default", dflt.String)
				return nil
			}
			col.dflt = value
		}
		t.columns = append(t.columns, col)
		if quoted[table] == nil {
			quoted[table] = map[string]string{}
		}
		quoted[table][name] = quotedName
		if typ.Kind == TypeTime {
			if pending[table] == nil {
				pending[table] = map[string]bool{}
			}
			pending[table][name] = true
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	checked := map[string]map[string]bool{}
	err = eachRow(ctx, q, postgresConstraintsQuery, func(r scanner) error {
		var table, name, kind, definition, match, onDelete, onUpdate, refTable, columns, refs string
		var deferrable, validated bool
		if err := r.Scan(&table, &name, &kind, &definition, &deferrable, &validated, &match, &onDelete, &onUpdate, &refTable, &columns, &refs); err != nil {
			return err
		}
		t := c.table(table)
		if t == nil {
			return nil
		}
		list := strings.Split(columns, ",")
		switch {
		case !validated || deferrable:
			c.report(postgresKind(kind), table, name, "a deferrable or not validated constraint has no dbspec definition")
		case kind == "p":
			t.primary = list
		case kind == "u":
			if strings.Contains(name, "$") || !strings.HasPrefix(definition, "UNIQUE (") {
				c.report("unique", table, name, "the unique constraint %s has no dbspec definition", definition)
				return nil
			}
			t.uniques = append(t.uniques, ikey{name: name, columns: list, desc: make([]bool, len(list))})
		case kind == "f" && refTable == "":
			// 다른 schema의 table을 가리키는 foreign key는 이 문서 밖의 table을 가리킨다.
			c.report("foreign_key", table, name, "the referenced table is outside the current schema")
		case kind == "f":
			del, okDelete := postgresAction(onDelete)
			upd, okUpdate := postgresAction(onUpdate)
			if !okDelete || !okUpdate || match != "s" {
				c.report("foreign_key", table, name, "actions %s, %s or match %s have no dbspec definition", onDelete, onUpdate, match)
				return nil
			}
			t.fks = append(t.fks, ifk{name: name, columns: list, table: refTable, refs: strings.Split(refs, ","), onDelete: del, onUpdate: upd})
		case kind == "c":
			if owner, column, generated := strings.Cut(name, "$"); generated {
				want := "CHECK ((" + quoted[table][column] + " < '24:00:00'::time without time zone))"
				if owner != table || !pending[table][column] || definition != want {
					c.report("check", table, name, "the check %s is not the renderer CHECK", definition)
					return nil
				}
				if checked[table] == nil {
					checked[table] = map[string]bool{}
				}
				checked[table][column] = true
				return nil
			}
			predicate, err := decodeCheck(DialectPostgres, definition, tableTypes(t))
			if err != nil {
				c.report("check", table, name, "%v", err)
				return nil
			}
			t.checks = append(t.checks, icheck{name: name, predicate: predicate})
		default:
			c.report(postgresKind(kind), table, name, "a constraint of kind %s has no dbspec definition", kind)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	for table, cols := range pending {
		for column := range cols {
			if !checked[table][column] {
				c.report("column", table, column, "time without its renderer CHECK has no dbspec type")
				c.dropColumn(table, column)
			}
		}
	}
	err = eachRow(ctx, q, postgresIndexesQuery, func(r scanner) error {
		var table, name, method, columns, options string
		var unique, partial, expression, include bool
		if err := r.Scan(&table, &name, &unique, &partial, &expression, &include, &method, &columns, &options); err != nil {
			return err
		}
		t := c.table(table)
		if t == nil {
			return nil
		}
		if unique || partial || expression || include || method != "btree" || strings.Contains(name, "$") {
			c.report("index", table, name, "a unique, partial, expression, covering or %s index has no dbspec index", method)
			return nil
		}
		key := ikey{name: name, columns: strings.Split(columns, ",")}
		for _, o := range strings.Split(options, ",") {
			key.desc = append(key.desc, o == "1")
		}
		t.indexes = append(t.indexes, key)
		return nil
	})
	if err != nil {
		return nil, err
	}
	triggers := map[string][]itrigger{}
	functions := map[string]bool{}
	err = eachRow(ctx, q, postgresTriggersQuery, func(r scanner) error {
		var table, name, definition, function, source, language string
		if err := r.Scan(&table, &name, &definition, &function, &source, &language); err != nil {
			return err
		}
		functions[function] = true
		m := postgresTriggerPattern.FindStringSubmatch(definition)
		if m == nil || language != "plpgsql" || strings.Trim(m[1], `"`) != name || strings.Trim(m[5], `"`) != function {
			triggers[table] = append(triggers[table], itrigger{name: name, statements: []string{definition}})
			return nil
		}
		triggers[table] = append(triggers[table], itrigger{name: name, statements: []string{
			`CREATE FUNCTION "` + function + `"() RETURNS trigger LANGUAGE plpgsql AS $$` + source + `$$`,
			`CREATE TRIGGER "` + name + `" ` + m[2] + " " + m[3] + ` ON "` + strings.Trim(m[4], `"`) + `" FOR EACH ROW EXECUTE FUNCTION "` + function + `"()`,
		}})
		return nil
	})
	if err != nil {
		return nil, err
	}
	c.recognizeTriggers(DialectPostgres, triggers)
	err = eachRow(ctx, q, postgresRoutinesQuery, func(r scanner) error {
		var name string
		if err := r.Scan(&name); err != nil {
			return err
		}
		if !functions[name] {
			c.report("routine", "", name, "a function outside the renderer triggers has no dbspec definition")
		}
		return nil
	})
	return c, err
}

// postgresType은 format_type과 collation을 dbspec type으로 읽는다.
func postgresType(formatted, collation string) (Type, bool) {
	m := postgresTypePattern.FindStringSubmatch(formatted)
	if m == nil {
		return Type{}, false
	}
	switch {
	case m[2] != "":
		p, _ := strconv.Atoi(m[2])
		s, _ := strconv.Atoi(m[3])
		return Type{Kind: TypeDecimal, Precision: p, Scale: s}, true
	case m[4] != "":
		n, _ := strconv.Atoi(m[4])
		return Type{Kind: TypeVarchar, Length: n}, collation == "C"
	case m[5] != "":
		p, _ := strconv.Atoi(m[6])
		if m[5] == "time" {
			return Type{Kind: TypeTime, Precision: p}, true
		}
		return Type{Kind: TypeDatetime, Precision: p}, true
	}
	switch m[1] {
	case "smallint":
		return Type{Kind: TypeI16}, true
	case "integer":
		return Type{Kind: TypeI32}, true
	case "bigint":
		return Type{Kind: TypeI64}, true
	case "boolean":
		return Type{Kind: TypeBool}, true
	case "double precision":
		return Type{Kind: TypeF64}, true
	case "text":
		return Type{Kind: TypeText}, collation == "C"
	case "bytea":
		return Type{Kind: TypeBytes}, true
	case "uuid":
		return Type{Kind: TypeUUID}, true
	case "date":
		return Type{Kind: TypeDate}, true
	}
	return Type{}, false
}

// postgresDefault는 pg_get_expr의 default를 dbspec literal이나 now로 읽는다.
func postgresDefault(text string, typ Type) (string, bool) {
	if text == "statement_timestamp()" {
		return "now", typ.Kind == TypeDatetime
	}
	if m := postgresLiteralPattern.FindStringSubmatch(text); m != nil {
		value := strings.ReplaceAll(m[1], "''", "'")
		switch typ.Kind {
		case TypeI16, TypeI32, TypeI64, TypeDecimal, TypeF64:
			return value, true
		}
		return quote(value), true
	}
	switch {
	case text == "true" || text == "false":
		return text, typ.Kind == TypeBool
	case regexp.MustCompile(`^-?\d+(\.\d+)?$`).MatchString(text):
		return text, true
	}
	return "", false
}

func postgresAction(code string) (string, bool) {
	switch code {
	case "r":
		return "restrict", true
	case "c":
		return "cascade", true
	case "n":
		return "set_null", true
	}
	return "", false
}

func postgresKind(contype string) string {
	switch contype {
	case "p", "u":
		return "unique"
	case "f":
		return "foreign_key"
	case "c":
		return "check"
	}
	return "index"
}
