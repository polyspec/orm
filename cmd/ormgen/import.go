// ormgen import: a live MySQL schema → Mermaid erDiagram (docs/schema.md).
//
//	ormgen import --dsn "root@unix(/tmp/mysql.sock)/orm_bench" --out schema/app.mmd [--tables a,b]
//
// Deterministic (tables alphabetical, columns by ordinal position) so a
// re-import of an unchanged database is a no-op diff. When --out already
// exists, hand-written facts that the database cannot express are carried
// over: relation name overrides "(child / parent)", column attributes lazy /
// bool / int / explicit styles, and %% predicate lines.
package main

import (
	"database/sql"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"

	_ "github.com/go-sql-driver/mysql"

	"github.com/maxkwon/orm/engine/schema"
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

type impTable struct {
	Name    string
	Columns []impColumn
	Indexes []impIndex
}

func importCmd(args []string) {
	fs := flag.NewFlagSet("import", flag.ExitOnError)
	dsn := fs.String("dsn", "", "go-sql-driver DSN (required)")
	out := fs.String("out", "", "output .mmd path (required)")
	tables := fs.String("tables", "", "comma-separated subset of tables")
	fs.Parse(args)
	if *dsn == "" || *out == "" {
		fmt.Fprintln(os.Stderr, "usage: ormgen import --dsn <dsn> --out schema/app.mmd [--tables a,b]")
		os.Exit(2)
	}
	db, err := sql.Open("mysql", *dsn)
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
	ts, err := readTables(db, only)
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

func readTables(db *sql.DB, only map[string]bool) ([]impTable, error) {
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
	for _, t := range ts {
		tables[t.Name] = true
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
			prevLabels[r.Parent+"/"+r.Child+"/"+r.FK] = r
		}
		for _, d := range prev.Directives {
			if d.Kind == "predicate" {
				prevPredicates = append(prevPredicates, fmt.Sprintf("  %%%% predicate %s %s : %s", d.Table, d.Name, d.Raw))
			}
		}
	}
	var sb strings.Builder
	sb.WriteString("erDiagram\n")
	type rel struct{ parent, child, fk string }
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
		for _, c := range t.Columns {
			typ, unsigned := mermaidType(c.Type)
			var keys []string
			if c.Key == "PRI" {
				keys = append(keys, "PK")
			}
			target := fkTarget(c.Name, tables)
			if target != "" && target != t.Name && c.Key != "PRI" {
				keys = append(keys, "FK")
				rels = append(rels, rel{target, t.Name, c.Name})
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
	}
	if len(rels) > 0 {
		sb.WriteString("\n")
	}
	for _, r := range rels {
		label := r.fk
		if pr := prevLabels[r.parent+"/"+r.child+"/"+r.fk]; pr != nil && (pr.ChildName != "" || pr.ParentName != "") {
			label += " (" + pr.ChildName + " / " + pr.ParentName + ")"
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
