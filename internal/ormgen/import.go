// ormgen import: a live MySQL schema → Mermaid erDiagram (docs/schema.md).
//
//	ormgen import --dsn "root@unix(/tmp/mysql.sock)/orm_bench" --out schema/app.mmd [--tables a,b]
//
// Deterministic (tables alphabetical, columns by ordinal position) so a
// re-import of an unchanged database is a no-op diff. When --out already
// exists, hand-written facts that the database cannot express are carried
// over: relation name overrides "(child / parent)", column attributes lazy /
// bool / int / explicit styles, and %% predicate lines.
package ormgen

import (
	"database/sql"
	"flag"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"

	_ "github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/polyspec/orm/engine/schema"
)

type impColumn struct {
	Name, Type, Default, Extra, Key string
	Nullable                        bool
	Comment                         string
}

type impIndex struct {
	Name     string
	Unique   bool
	Fulltext bool
	Columns  []string
}

type impForeignKey struct {
	Name          string
	Columns       []string
	Target        string
	TargetColumns []string
	OnDelete      string
}

type impCheck struct {
	Name string
	Expr string
}

type impTable struct {
	Name        string
	Comment     string
	Columns     []impColumn
	Indexes     []impIndex
	ForeignKeys []impForeignKey
	Checks      []impCheck
}

func importCmd(args []string) {
	fs := flag.NewFlagSet("import", flag.ExitOnError)
	dsn := fs.String("dsn", "", "DSN/URL (required)")
	driver := fs.String("driver", "", "mysql|postgres (default: inferred from the DSN)")
	out := fs.String("out", "", "output .mmd path (required)")
	tables := fs.String("tables", "", "comma-separated subset of tables")
	fs.Parse(args)
	if *dsn == "" || *out == "" {
		fmt.Fprintln(os.Stderr, "usage: ormgen import --dsn <dsn> [--driver mysql|postgres] --out schema/app.mmd [--tables a,b]")
		os.Exit(2)
	}
	if *driver == "" {
		*driver = "mysql"
		if strings.HasPrefix(*dsn, "postgres://") || strings.HasPrefix(*dsn, "postgresql://") || strings.Contains(*dsn, "host=") {
			*driver = "postgres"
		}
	}
	sqlDriver := map[string]string{"mysql": "mysql", "postgres": "pgx"}[*driver]
	if sqlDriver == "" {
		fail(fmt.Errorf("driver %q: want mysql or postgres", *driver))
	}
	db, err := sql.Open(sqlDriver, *dsn)
	if err != nil {
		fail(err)
	}
	defer db.Close()
	var only map[string]bool
	if *tables != "" {
		only = map[string]bool{}
		for _, t := range strings.Split(*tables, ",") {
			only[strings.TrimSpace(t)] = true
		}
	}
	ts, err := readTables(db, *driver, only)
	if err != nil {
		fail(err)
	}
	var prev *schema.Diagram
	if src, err := os.ReadFile(*out); err == nil {
		if prev, err = schema.Parse(string(src)); err != nil {
			fail(fmt.Errorf("%s: %w (fix or remove it before importing over it)", *out, err))
		}
	}
	text := renderMermaid(ts, prev)
	if err := os.WriteFile(*out, []byte(text), 0o644); err != nil {
		fail(err)
	}
	if _, err := schema.Parse(text); err != nil {
		fail(fmt.Errorf("imported diagram does not parse: %w", err))
	}
	fmt.Fprintf(os.Stderr, "ormgen: %d tables → %s\n", len(ts), *out)
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "ormgen: %v\n", err)
	os.Exit(1)
}

func readTables(db *sql.DB, driver string, only map[string]bool) ([]impTable, error) {
	if driver == "postgres" {
		return readTablesPG(db, only)
	}
	rows, err := db.Query(`SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_KEY, COLUMN_COMMENT
		FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byName := map[string]*impTable{}
	var order []string
	for rows.Next() {
		var t, c impColumn
		var table, nullable string
		var def sql.NullString
		if err := rows.Scan(&table, &c.Name, &c.Type, &nullable, &def, &c.Extra, &c.Key, &c.Comment); err != nil {
			return nil, err
		}
		_ = t
		if only != nil && !only[table] {
			continue
		}
		c.Nullable = nullable == "YES"
		if def.Valid {
			c.Default = def.String
		} else {
			c.Default = "\x00" // no default
		}
		tb := byName[table]
		if tb == nil {
			tb = &impTable{Name: table}
			byName[table] = tb
			order = append(order, table)
		}
		tb.Columns = append(tb.Columns, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	comments, err := db.Query(`SELECT TABLE_NAME, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`)
	if err != nil {
		return nil, err
	}
	for comments.Next() {
		var name, comment string
		if err := comments.Scan(&name, &comment); err != nil {
			comments.Close()
			return nil, err
		}
		if tb := byName[name]; tb != nil {
			tb.Comment = comment
		}
	}
	if err := comments.Close(); err != nil {
		return nil, err
	}
	irows, err := db.Query(`SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, INDEX_TYPE, COLUMN_NAME FROM information_schema.STATISTICS
		WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`)
	if err != nil {
		return nil, err
	}
	defer irows.Close()
	for irows.Next() {
		var table, name, typ, col string
		var nonUnique int
		if err := irows.Scan(&table, &name, &nonUnique, &typ, &col); err != nil {
			return nil, err
		}
		tb := byName[table]
		if tb == nil || name == "PRIMARY" {
			continue
		}
		if n := len(tb.Indexes); n > 0 && tb.Indexes[n-1].Name == name {
			tb.Indexes[n-1].Columns = append(tb.Indexes[n-1].Columns, col)
			continue
		}
		tb.Indexes = append(tb.Indexes, impIndex{Name: name, Unique: nonUnique == 0, Fulltext: typ == "FULLTEXT", Columns: []string{col}})
	}
	if err := irows.Err(); err != nil {
		return nil, err
	}
	if err := irows.Close(); err != nil {
		return nil, err
	}
	frows, err := db.Query(`SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME,
		k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.DELETE_RULE
		FROM information_schema.KEY_COLUMN_USAGE k
		JOIN information_schema.REFERENTIAL_CONSTRAINTS r
		  ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
		WHERE k.TABLE_SCHEMA=DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL
		ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`)
	if err != nil {
		return nil, err
	}
	defer frows.Close()
	for frows.Next() {
		var table, name, column, target, targetColumn, action string
		if err := frows.Scan(&table, &name, &column, &target, &targetColumn, &action); err != nil {
			return nil, err
		}
		tb := byName[table]
		if tb == nil {
			continue
		}
		n := len(tb.ForeignKeys)
		if n == 0 || tb.ForeignKeys[n-1].Name != name {
			tb.ForeignKeys = append(tb.ForeignKeys, impForeignKey{Name: name, Target: target, OnDelete: importDeleteAction(action)})
			n++
		}
		fk := &tb.ForeignKeys[n-1]
		fk.Columns = append(fk.Columns, column)
		fk.TargetColumns = append(fk.TargetColumns, targetColumn)
	}
	if err := frows.Err(); err != nil {
		return nil, err
	}
	checks, err := db.Query(`SELECT tc.TABLE_NAME, tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE
		FROM information_schema.TABLE_CONSTRAINTS tc
		JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
		WHERE tc.CONSTRAINT_SCHEMA=DATABASE() AND tc.CONSTRAINT_TYPE='CHECK'
		ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME`)
	if err != nil {
		return nil, err
	}
	for checks.Next() {
		var table, name, expr string
		if err := checks.Scan(&table, &name, &expr); err != nil {
			checks.Close()
			return nil, err
		}
		if tb := byName[table]; tb != nil {
			tb.Checks = append(tb.Checks, impCheck{Name: name, Expr: expr})
		}
	}
	if err := checks.Err(); err != nil {
		checks.Close()
		return nil, err
	}
	if err := checks.Close(); err != nil {
		return nil, err
	}
	sort.Strings(order)
	out := make([]impTable, 0, len(order))
	for _, n := range order {
		out = append(out, *byName[n])
	}
	return out, nil
}

// fkTarget infers the parent table of a `<role>_<table>_seq` column by
// dropping leading words until a table name matches (no FK constraints needed).
func fkTarget(col string, tables map[string]bool) string {
	if !strings.HasSuffix(col, "_seq") {
		return ""
	}
	parts := strings.Split(strings.TrimSuffix(col, "_seq"), "_")
	for i := 0; i < len(parts); i++ {
		if t := strings.Join(parts[i:], "_"); tables[t] {
			return t
		}
	}
	return ""
}

// mermaidType rewrites a MySQL COLUMN_TYPE into the diagram spelling:
// "bigint unsigned" → bigint (+ unsigned attribute), decimal(13,3) → decimal(13_3), enum('a','b') → enum(a_b).
func mermaidType(t string) (string, bool) {
	t = strings.ToLower(t)
	unsigned := strings.HasSuffix(t, " unsigned")
	t = strings.TrimSuffix(t, " unsigned")
	if i := strings.IndexByte(t, '('); i >= 0 && strings.HasSuffix(t, ")") {
		inner := t[i+1 : len(t)-1]
		inner = strings.ReplaceAll(inner, "'", "")
		inner = strings.ReplaceAll(inner, ",", "_")
		t = t[:i] + "(" + inner + ")"
	}
	return t, unsigned
}

func renderMermaid(ts []impTable, prev *schema.Diagram) string {
	tables := map[string]bool{}
	primary := map[string][]string{}
	for _, t := range ts {
		tables[t.Name] = true
		for _, c := range t.Columns {
			if c.Key == "PRI" {
				primary[t.Name] = append(primary[t.Name], c.Name)
			}
		}
	}
	// facts to carry over from the previous diagram
	prevCols := map[string]*schema.DColumn{}
	prevLabels := map[string]*schema.DRelation{}
	var prevPredicates []string
	if prev != nil {
		for _, e := range prev.Entities {
			for _, c := range e.Columns {
				prevCols[e.Name+"."+c.Name] = c
			}
		}
		for _, r := range prev.Relations {
			prevLabels[r.Parent+"/"+r.Child+"/"+strings.Join(r.FKs, ",")] = r
		}
		for _, d := range prev.Directives {
			if d.Kind == "predicate" {
				prevPredicates = append(prevPredicates, fmt.Sprintf("  %%%% predicate %s %s : %s", d.Table, d.Name, d.Raw))
			}
		}
	}
	var sb strings.Builder
	sb.WriteString("erDiagram\n")
	type rel struct {
		parent, child, onDelete string
		fks                     []string
	}
	var rels []rel
	var directives []string
	for _, t := range ts {
		sb.WriteString("  " + t.Name + " {\n")
		single := map[string]impIndex{} // single-column indexes by column
		for _, ix := range t.Indexes {
			if len(ix.Columns) == 1 {
				single[ix.Columns[0]] = ix
			}
		}
		type foreignColumn struct {
			key   impForeignKey
			index int
		}
		foreignByColumn := map[string]foreignColumn{}
		for _, fk := range t.ForeignKeys {
			if len(fk.Columns) != len(fk.TargetColumns) {
				continue
			}
			for i, column := range fk.Columns {
				foreignByColumn[column] = foreignColumn{key: fk, index: i}
			}
			if fk.Target != t.Name && stringSlicesEqual(primary[fk.Target], fk.TargetColumns) {
				rels = append(rels, rel{parent: fk.Target, child: t.Name, fks: append([]string(nil), fk.Columns...), onDelete: fk.OnDelete})
			}
		}
		for _, c := range t.Columns {
			typ, unsigned := mermaidType(c.Type)
			var keys []string
			if c.Key == "PRI" {
				keys = append(keys, "PK")
			}
			target := ""
			targetColumn := ""
			onDelete := ""
			if item, ok := foreignByColumn[c.Name]; ok {
				target, targetColumn, onDelete = item.key.Target, item.key.TargetColumns[item.index], item.key.OnDelete
			} else {
				target = fkTarget(c.Name, tables)
			}
			if target != "" && target != t.Name {
				keys = append(keys, "FK")
				if targetColumn == "" {
					targetColumn = "seq"
				}
				_ = onDelete
			}
			if ix, ok := single[c.Name]; ok && ix.Unique && c.Key != "PRI" {
				keys = append(keys, "UK")
			}
			var attrs []string
			if c.Nullable {
				attrs = append(attrs, "?")
			}
			switch {
			case c.Default == "\x00":
			case strings.HasPrefix(strings.ToUpper(c.Default), "CURRENT_TIMESTAMP"):
				attrs = append(attrs, "=now")
			case c.Nullable && strings.EqualFold(c.Default, "NULL"):
			default:
				d := c.Default
				if strings.ContainsAny(d, " ") || (!isNumber(d) && !strings.HasPrefix(d, "'")) {
					d = "'" + d + "'"
				}
				attrs = append(attrs, "="+d)
			}
			if strings.Contains(strings.ToLower(c.Extra), "on update current_timestamp") {
				attrs = append(attrs, "onupdate")
			}
			if strings.Contains(c.Extra, "auto_increment") {
				attrs = append(attrs, "auto")
			}
			if unsigned && !strings.HasPrefix(c.Name, "is_") {
				attrs = append(attrs, "unsigned")
			}
			if pc := prevCols[t.Name+"."+c.Name]; pc != nil {
				if pc.Lazy {
					attrs = append(attrs, "lazy")
				}
				if pc.Bool {
					attrs = append(attrs, "bool")
				}
				if pc.Int {
					attrs = append(attrs, "int")
				}
				attrs = append(attrs, pc.Styles...)
			}
			line := fmt.Sprintf("    %-13s %-28s", typ, c.Name)
			if len(keys) > 0 {
				line += " " + strings.Join(keys, ", ")
			}
			if len(attrs) > 0 {
				line += fmt.Sprintf(" %q", strings.Join(attrs, " "))
			}
			sb.WriteString(strings.TrimRight(line, " ") + "\n")
		}
		sb.WriteString("  }\n")
		if t.Comment != "" {
			directives = append(directives, fmt.Sprintf("  %%%% table_comment %s %s", t.Name, quoteDirective(t.Comment)))
		}
		for _, c := range t.Columns {
			if c.Comment != "" {
				directives = append(directives, fmt.Sprintf("  %%%% column_comment %s %s %s", t.Name, c.Name, quoteDirective(c.Comment)))
			}
		}
		for _, ix := range t.Indexes {
			cols := "(" + strings.Join(ix.Columns, ", ") + ")"
			switch {
			case ix.Fulltext:
				directives = append(directives, fmt.Sprintf("  %%%% fulltext %s %s", t.Name, cols))
			case ix.Unique && len(ix.Columns) > 1:
				directives = append(directives, fmt.Sprintf("  %%%% unique %s %s", t.Name, cols))
			case ix.Unique:
				// single-column unique → UK on the column line
			case len(ix.Columns) == 1 && fkTarget(ix.Columns[0], tables) != "":
				// single-column FK index is implied
			default:
				directives = append(directives, fmt.Sprintf("  %%%% index %s %s %s", t.Name, cols, ix.Name))
			}
		}
		for _, check := range t.Checks {
			directives = append(directives, fmt.Sprintf("  %%%% check %s %s : %s", t.Name, check.Name, check.Expr))
		}
	}
	if len(rels) > 0 {
		sb.WriteString("\n")
	}
	for _, r := range rels {
		label := r.fks[0]
		if len(r.fks) > 1 {
			label = "(" + strings.Join(r.fks, ", ") + ")"
		}
		if pr := prevLabels[r.parent+"/"+r.child+"/"+strings.Join(r.fks, ",")]; pr != nil && (pr.ChildName != "" || pr.ParentName != "") {
			label += " (" + pr.ChildName + " / " + pr.ParentName + ")"
		} else if len(r.fks) > 1 {
			label += " (" + r.parent + " / " + importPlural(r.child) + ")"
		}
		if r.onDelete != "" {
			label += " " + r.onDelete
		}
		sb.WriteString(fmt.Sprintf("  %-14s ||--o{ %-14s : %s\n", r.parent, r.child, label))
	}
	if len(directives)+len(prevPredicates) > 0 {
		sb.WriteString("\n")
	}
	for _, d := range append(directives, prevPredicates...) {
		sb.WriteString(d + "\n")
	}
	return sb.String()
}

func importPlural(value string) string {
	if strings.HasSuffix(value, "y") && len(value) > 1 && !strings.ContainsRune("aeiou", rune(value[len(value)-2])) {
		return value[:len(value)-1] + "ies"
	}
	if strings.HasSuffix(value, "s") || strings.HasSuffix(value, "x") || strings.HasSuffix(value, "ch") || strings.HasSuffix(value, "sh") {
		return value + "es"
	}
	return value + "s"
}

func importDeleteAction(action string) string {
	switch strings.ToUpper(strings.ReplaceAll(action, "_", " ")) {
	case "CASCADE":
		return "cascade"
	case "SET NULL":
		return "setnull"
	default:
		return ""
	}
}

func quoteDirective(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `\\"`) + `"`
}

func isNumber(s string) bool {
	if s == "" {
		return false
	}
	for i, r := range s {
		if !(r >= '0' && r <= '9' || r == '.' || (i == 0 && r == '-')) {
			return false
		}
	}
	return true
}

// readTablesPG is the PostgreSQL half of the importer: information_schema for
// columns (assembled back into a MySQL-shaped type text so one renderer serves
// both) and pg_index for keys and indexes.
func readTablesPG(db *sql.DB, only map[string]bool) ([]impTable, error) {
	rows, err := db.Query(`SELECT c.table_name, c.column_name, c.data_type, c.character_maximum_length,
		       c.numeric_precision, c.numeric_scale, c.datetime_precision, c.udt_name,
		       c.is_nullable, c.column_default, c.is_identity, coalesce(d.description, '')
		  FROM information_schema.columns c
		  JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
		  LEFT JOIN pg_catalog.pg_class cl ON cl.relname = c.table_name
		  LEFT JOIN pg_catalog.pg_description d ON d.objoid = cl.oid AND d.objsubid = c.ordinal_position
		 WHERE c.table_schema = current_schema()
		 ORDER BY c.table_name, c.ordinal_position`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byName := map[string]*impTable{}
	var order []string
	for rows.Next() {
		var table, dataType, udt, nullable, identity, comment string
		var charLen, numPrec, numScale, dtPrec sql.NullInt64
		var def sql.NullString
		var c impColumn
		if err := rows.Scan(&table, &c.Name, &dataType, &charLen, &numPrec, &numScale, &dtPrec, &udt, &nullable, &def, &identity, &comment); err != nil {
			return nil, err
		}
		if only != nil && !only[table] {
			continue
		}
		c.Type = pgTypeText(dataType, udt, charLen, numPrec, numScale, dtPrec)
		c.Nullable = nullable == "YES"
		c.Comment = comment
		switch {
		case identity == "YES" || (def.Valid && strings.HasPrefix(def.String, "nextval(")):
			c.Extra = "auto_increment"
			c.Default = "\x00"
		case def.Valid:
			c.Default = pgDefaultText(def.String)
		default:
			c.Default = "\x00"
		}
		tb := byName[table]
		if tb == nil {
			tb = &impTable{Name: table}
			byName[table] = tb
			order = append(order, table)
		}
		tb.Columns = append(tb.Columns, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	trows, err := db.Query(`SELECT c.relname, coalesce(d.description, '')
		FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace AND n.nspname=current_schema()
		LEFT JOIN pg_catalog.pg_description d ON d.objoid=c.oid AND d.objsubid=0
		WHERE c.relkind='r'`)
	if err != nil {
		return nil, err
	}
	for trows.Next() {
		var name, comment string
		if err := trows.Scan(&name, &comment); err != nil {
			trows.Close()
			return nil, err
		}
		if tb := byName[name]; tb != nil {
			tb.Comment = comment
		}
	}
	if err := trows.Close(); err != nil {
		return nil, err
	}
	irows, err := db.Query(`SELECT cl.relname AS table_name, ic.relname AS index_name, ix.indisunique, ix.indisprimary,
		       am.amname, a.attname, k.ord
		  FROM pg_class cl
		  JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = current_schema()
		  JOIN pg_index ix ON ix.indrelid = cl.oid
		  JOIN pg_class ic ON ic.oid = ix.indexrelid
		  JOIN pg_am am ON am.oid = ic.relam
		  JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
		  JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = k.attnum
		 ORDER BY cl.relname, ic.relname, k.ord`)
	if err != nil {
		return nil, err
	}
	defer irows.Close()
	for irows.Next() {
		var table, name, am, col string
		var unique, primary bool
		var ord int
		if err := irows.Scan(&table, &name, &unique, &primary, &am, &col, &ord); err != nil {
			return nil, err
		}
		tb := byName[table]
		if tb == nil {
			continue
		}
		if primary {
			for i := range tb.Columns {
				if tb.Columns[i].Name == col {
					tb.Columns[i].Key = "PRI"
				}
			}
			continue
		}
		logicalName := postgresLogicalIndexName(table, name, unique)
		if n := len(tb.Indexes); n > 0 && tb.Indexes[n-1].Name == logicalName {
			tb.Indexes[n-1].Columns = append(tb.Indexes[n-1].Columns, col)
			continue
		}
		tb.Indexes = append(tb.Indexes, impIndex{Name: logicalName, Unique: unique, Fulltext: am == "gin", Columns: []string{col}})
	}
	if err := irows.Err(); err != nil {
		return nil, err
	}
	if err := irows.Close(); err != nil {
		return nil, err
	}
	frows, err := db.Query(`SELECT child.relname, con.conname, ca.attname, parent.relname, pa.attname, con.confdeltype, ck.ord
		FROM pg_constraint con
		JOIN pg_class child ON child.oid=con.conrelid
		JOIN pg_namespace n ON n.oid=child.relnamespace AND n.nspname=current_schema()
		JOIN pg_class parent ON parent.oid=con.confrelid
		JOIN LATERAL unnest(con.conkey) WITH ORDINALITY ck(attnum, ord) ON true
		JOIN LATERAL unnest(con.confkey) WITH ORDINALITY pk(attnum, ord) ON pk.ord=ck.ord
		JOIN pg_attribute ca ON ca.attrelid=child.oid AND ca.attnum=ck.attnum
		JOIN pg_attribute pa ON pa.attrelid=parent.oid AND pa.attnum=pk.attnum
		WHERE con.contype='f'
		ORDER BY child.relname, con.conname, ck.ord`)
	if err != nil {
		return nil, err
	}
	defer frows.Close()
	for frows.Next() {
		var table, name, column, target, targetColumn, action string
		var ord int
		if err := frows.Scan(&table, &name, &column, &target, &targetColumn, &action, &ord); err != nil {
			return nil, err
		}
		tb := byName[table]
		if tb == nil {
			continue
		}
		n := len(tb.ForeignKeys)
		if n == 0 || tb.ForeignKeys[n-1].Name != name {
			tb.ForeignKeys = append(tb.ForeignKeys, impForeignKey{Name: name, Target: target, OnDelete: postgresDeleteAction(action)})
			n++
		}
		fk := &tb.ForeignKeys[n-1]
		fk.Columns = append(fk.Columns, column)
		fk.TargetColumns = append(fk.TargetColumns, targetColumn)
	}
	if err := frows.Err(); err != nil {
		return nil, err
	}
	if err := frows.Close(); err != nil {
		return nil, err
	}
	crows, err := db.Query(`SELECT child.relname, con.conname, pg_get_constraintdef(con.oid)
		FROM pg_constraint con
		JOIN pg_class child ON child.oid=con.conrelid
		JOIN pg_namespace n ON n.oid=child.relnamespace AND n.nspname=current_schema()
		WHERE con.contype='c' ORDER BY child.relname, con.conname`)
	if err != nil {
		return nil, err
	}
	for crows.Next() {
		var table, name, definition string
		if err := crows.Scan(&table, &name, &definition); err != nil {
			crows.Close()
			return nil, err
		}
		expr := strings.TrimSpace(definition)
		if len(expr) >= 5 && strings.EqualFold(expr[:5], "CHECK") {
			expr = strings.TrimSpace(expr[5:])
		}
		if tb := byName[table]; tb != nil {
			tb.Checks = append(tb.Checks, impCheck{Name: name, Expr: expr})
		}
	}
	if err := crows.Err(); err != nil {
		crows.Close()
		return nil, err
	}
	if err := crows.Close(); err != nil {
		return nil, err
	}
	grows, err := db.Query(`SELECT cl.relname, ic.relname, pg_get_indexdef(ic.oid)
		FROM pg_class cl
		JOIN pg_namespace n ON n.oid=cl.relnamespace AND n.nspname=current_schema()
		JOIN pg_index ix ON ix.indrelid=cl.oid
		JOIN pg_class ic ON ic.oid=ix.indexrelid
		JOIN pg_am am ON am.oid=ic.relam
		WHERE am.amname='gin'
		ORDER BY cl.relname, ic.relname`)
	if err != nil {
		return nil, err
	}
	defer grows.Close()
	for grows.Next() {
		var table, name, definition string
		if err := grows.Scan(&table, &name, &definition); err != nil {
			return nil, err
		}
		tb := byName[table]
		if tb == nil {
			continue
		}
		columns, err := postgresFulltextColumns(definition)
		if err != nil {
			return nil, fmt.Errorf("table %s index %s: %w", table, name, err)
		}
		tb.Indexes = append(tb.Indexes, impIndex{Name: name, Fulltext: true, Columns: columns})
	}
	if err := grows.Err(); err != nil {
		return nil, err
	}
	sort.Strings(order)
	out := make([]impTable, 0, len(order))
	for _, n := range order {
		out = append(out, *byName[n])
	}
	return out, nil
}

func postgresDeleteAction(code string) string {
	switch code {
	case "c":
		return "cascade"
	case "n":
		return "setnull"
	default:
		return ""
	}
}

func postgresLogicalIndexName(table, physical string, unique bool) string {
	if unique {
		return physical
	}
	return strings.TrimPrefix(physical, table+"_")
}

var postgresCoalesceColumn = regexp.MustCompile(`(?i)coalesce\s*\(\s*\(?\s*"?([a-z_][a-z0-9_]*)"?\s*,`)

func postgresFulltextColumns(definition string) ([]string, error) {
	if !strings.Contains(strings.ToLower(definition), "to_tsvector") {
		return nil, fmt.Errorf("unsupported PostgreSQL GIN expression: %s", definition)
	}
	matches := postgresCoalesceColumn.FindAllStringSubmatch(definition, -1)
	columns := make([]string, 0, len(matches))
	seen := map[string]bool{}
	for _, match := range matches {
		if !seen[match[1]] {
			seen[match[1]] = true
			columns = append(columns, match[1])
		}
	}
	if len(columns) == 0 {
		return nil, fmt.Errorf("unsupported PostgreSQL GIN expression: %s", definition)
	}
	return columns, nil
}

// pgTypeText renders a PostgreSQL column as the DB type text the diagram uses
// (the manifest maps it to a canonical type either way).
func pgTypeText(dataType, udt string, charLen, numPrec, numScale, dtPrec sql.NullInt64) string {
	switch dataType {
	case "character varying", "character":
		if charLen.Valid {
			return fmt.Sprintf("varchar(%d)", charLen.Int64)
		}
		return "text"
	case "integer":
		return "int"
	case "smallint":
		return "smallint"
	case "bigint":
		return "bigint"
	case "boolean":
		return "tinyint"
	case "double precision", "real":
		return "double"
	case "numeric":
		if numPrec.Valid {
			return fmt.Sprintf("decimal(%d,%d)", numPrec.Int64, numScale.Int64)
		}
		return "decimal"
	case "timestamp without time zone", "timestamp with time zone":
		if dtPrec.Valid && dtPrec.Int64 > 0 {
			return fmt.Sprintf("datetime(%d)", dtPrec.Int64)
		}
		return "datetime"
	case "date":
		return "date"
	case "time without time zone", "time with time zone":
		return "time"
	case "bytea":
		return "blob"
	case "json", "jsonb":
		return "json"
	case "inet":
		return "varbinary(16)"
	case "text":
		return "text"
	}
	return udt
}

// pgDefaultText strips PostgreSQL's cast suffixes so the diagram shows the value.
func pgDefaultText(d string) string {
	if i := strings.Index(d, "::"); i > 0 {
		d = d[:i]
	}
	d = strings.Trim(d, "'")
	switch strings.ToLower(d) {
	case "now()", "current_timestamp":
		return "CURRENT_TIMESTAMP"
	case "true":
		return "1"
	case "false":
		return "0"
	}
	return d
}
