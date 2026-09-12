package main

import (
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/polyspec/orm/engine/schema"
)

type schemaChange struct {
	sql         string
	destructive bool
}

func diffCmd(args []string) {
	fs := flag.NewFlagSet("diff", flag.ExitOnError)
	fromPath := fs.String("from", "", "previous .mmd, .json, ormgen .sql, or db:<dsn> (required)")
	toPath := fs.String("to", "", "target .mmd, .json, ormgen .sql, or db:<dsn> (required)")
	dialect := fs.String("dialect", "mysql", "mysql|postgres|sqlite")
	out := fs.String("out", "", "output file (required)")
	allow := fs.Bool("allow-destructive", false, "allow table/column removal and type changes")
	fs.Parse(args)
	if *fromPath == "" || *toPath == "" || *out == "" {
		fmt.Fprintln(os.Stderr, "usage: ormgen diff --from old.json --to new.json --dialect mysql|postgres|sqlite --out <file.sql> [--allow-destructive]")
		os.Exit(2)
	}
	from, err := loadSchemaSource(*fromPath, *dialect)
	if err != nil {
		fail(err)
	}
	to, err := loadSchemaSource(*toPath, *dialect)
	if err != nil {
		fail(err)
	}
	text, err := renderDiff(from, to, *dialect, *allow)
	if err != nil {
		fail(err)
	}
	if err := os.WriteFile(*out, []byte(text), 0o644); err != nil {
		fail(err)
	}
}

func loadManifestFile(path string) (*schema.Manifest, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return schema.Load(b)
}

func renderDiff(from, to *schema.Manifest, dialect string, allowDestructive bool) (string, error) {
	if dialect != "mysql" && dialect != "postgres" && dialect != "sqlite" {
		return "", fmt.Errorf("unknown dialect %q", dialect)
	}
	quote := func(s string) string { return `"` + s + `"` }
	if dialect == "mysql" {
		quote = func(s string) string { return "`" + s + "`" }
	}
	changes := make([]schemaChange, 0)
	allNames := map[string]bool{}
	for n := range from.Entities {
		allNames[n] = true
	}
	for n := range to.Entities {
		allNames[n] = true
	}
	names := make([]string, 0, len(allNames))
	for n := range allNames {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, name := range names {
		oldEnt, oldOK := from.Entities[name]
		newEnt, newOK := to.Entities[name]
		switch {
		case !oldOK:
			one := &schema.Manifest{SchemaHash: to.SchemaHash, Order: []string{name}, Entities: map[string]*schema.Entity{name: newEnt}}
			create, err := renderDDL(one, dialect)
			if err != nil {
				return "", err
			}
			create = removeDropStatement(create)
			changes = append(changes, schemaChange{sql: strings.TrimSpace(create)})
		case !newOK:
			changes = append(changes, schemaChange{sql: "DROP TABLE " + quote(oldEnt.Table) + ";", destructive: true})
		default:
			if oldEnt.Table != newEnt.Table {
				return "", fmt.Errorf("table rename %s -> %s requires explicit migration", oldEnt.Table, newEnt.Table)
			}
			drops, adds, err := diffIndexesAndForeignKeys(from, to, oldEnt, newEnt, dialect, quote)
			if err != nil {
				return "", err
			}
			changes = append(changes, drops...)
			oldCols, newCols := map[string]*schema.Col{}, map[string]*schema.Col{}
			for _, c := range oldEnt.Columns {
				oldCols[c.Name] = c
			}
			for _, c := range newEnt.Columns {
				newCols[c.Name] = c
			}
			cols := map[string]bool{}
			for c := range oldCols {
				cols[c] = true
			}
			for c := range newCols {
				cols[c] = true
			}
			colNames := make([]string, 0, len(cols))
			for c := range cols {
				colNames = append(colNames, c)
			}
			sort.Strings(colNames)
			for _, col := range colNames {
				o, ook := oldCols[col]
				n, nok := newCols[col]
				switch {
				case !ook:
					def, err := ddlColumn(n, dialect, quote)
					if err != nil {
						return "", err
					}
					changes = append(changes, schemaChange{sql: fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s;", quote(newEnt.Table), def)})
				case !nok:
					changes = append(changes, schemaChange{sql: fmt.Sprintf("ALTER TABLE %s DROP COLUMN %s;", quote(oldEnt.Table), quote(col)), destructive: true})
				case columnChanged(o, n):
					stmts, err := alterColumn(newEnt.Table, o, n, dialect, quote)
					if err != nil {
						return "", fmt.Errorf("column %s.%s changed from type=%s raw=%s nullable=%t default=%s to type=%s raw=%s nullable=%t default=%s: %w", newEnt.Table, col, o.Type, o.Raw, o.Nullable, colDefault(o), n.Type, n.Raw, n.Nullable, colDefault(n), err)
					}
					for _, stmt := range stmts {
						changes = append(changes, schemaChange{sql: stmt, destructive: true})
					}
				}
				if ook && nok && o.Comment != n.Comment {
					stmt, err := alterComment(newEnt.Table, n, dialect, quote)
					if err != nil {
						return "", err
					}
					changes = append(changes, schemaChange{sql: stmt})
				}
			}
			if oldEnt.Comment != newEnt.Comment {
				changes = append(changes, schemaChange{sql: alterTableComment(newEnt.Table, newEnt.Comment, dialect, quote)})
			}
			changes = append(changes, adds...)
		}
	}
	for _, c := range changes {
		if c.destructive && !allowDestructive {
			return "", fmt.Errorf("destructive schema change requires --allow-destructive: %s", c.sql)
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "-- generated by ormgen diff (%s) from %s to %s\n", dialect, from.SchemaHash, to.SchemaHash)
	metadata, err := manifestMetadata(to)
	if err != nil {
		return "", fmt.Errorf("encode target schema metadata: %w", err)
	}
	b.WriteString(metadata)
	if len(changes) == 0 {
		b.WriteString("-- no changes\n")
	}
	for _, c := range changes {
		b.WriteString(c.sql)
		b.WriteByte('\n')
	}
	return b.String(), nil
}

func removeDropStatement(s string) string {
	lines := strings.Split(s, "\n")
	var out []string
	for _, line := range lines {
		if !strings.HasPrefix(line, "DROP TABLE IF EXISTS ") && !strings.HasPrefix(line, "-- generated by") {
			out = append(out, line)
		}
	}
	return strings.Join(out, "\n")
}

func columnChanged(a, b *schema.Col) bool {
	return a.Type != b.Type || a.Raw != b.Raw || a.Nullable != b.Nullable || colDefault(a) != colDefault(b) || a.Auto != b.Auto || a.OnUpdate != b.OnUpdate || a.Unsigned != b.Unsigned || a.Len != b.Len || a.Precision != b.Precision || a.Scale != b.Scale
}

func colDefault(c *schema.Col) string {
	if c.Default == nil {
		return ""
	}
	return *c.Default
}

func alterColumn(table string, old, next *schema.Col, dialect string, quote func(string) string) ([]string, error) {
	switch dialect {
	case "mysql":
		def, err := ddlColumn(next, dialect, quote)
		if err != nil {
			return nil, err
		}
		return []string{fmt.Sprintf("ALTER TABLE %s MODIFY COLUMN %s;", quote(table), def)}, nil
	case "postgres":
		var out []string
		oldType, err := ddlType(old, dialect)
		if err != nil {
			return nil, err
		}
		newType, err := ddlType(next, dialect)
		if err != nil {
			return nil, err
		}
		prefix := fmt.Sprintf("ALTER TABLE %s ALTER COLUMN %s ", quote(table), quote(next.Name))
		if oldType != newType {
			out = append(out, prefix+"TYPE "+newType+";")
		}
		if old.Nullable != next.Nullable {
			if next.Nullable {
				out = append(out, prefix+"DROP NOT NULL;")
			} else {
				out = append(out, prefix+"SET NOT NULL;")
			}
		}
		if colDefault(old) != colDefault(next) || (old.Default == nil) != (next.Default == nil) {
			if next.Default == nil {
				out = append(out, prefix+"DROP DEFAULT;")
			} else {
				value, err := ddlDefault(next, dialect)
				if err != nil {
					return nil, err
				}
				out = append(out, prefix+"SET DEFAULT "+value+";")
			}
		}
		if old.Auto != next.Auto {
			if next.Auto {
				out = append(out, prefix+"ADD GENERATED BY DEFAULT AS IDENTITY;")
			} else {
				out = append(out, prefix+"DROP IDENTITY IF EXISTS;")
			}
		}
		if len(out) == 0 {
			return nil, fmt.Errorf("postgres does not support the requested attribute change")
		}
		return out, nil
	case "sqlite":
		return nil, fmt.Errorf("sqlite does not support deterministic ALTER COLUMN; recreate the table explicitly")
	default:
		return nil, fmt.Errorf("unknown dialect %q", dialect)
	}
}

func ddlDefault(c *schema.Col, dialect string) (string, error) {
	if c.Default == nil {
		return "", fmt.Errorf("column %s has no default", c.Name)
	}
	v := *c.Default
	switch {
	case v == "now":
		return "CURRENT_TIMESTAMP", nil
	case v == "null":
		return "NULL", nil
	case isNumber(v) && c.Type == "bool" && dialect == "postgres":
		if v == "0" {
			return "false", nil
		}
		return "true", nil
	case isNumber(v):
		return v, nil
	default:
		return "'" + sqlQuote(strings.Trim(v, "'")) + "'", nil
	}
}

type diffIndex struct {
	name string
	kind string
	cols []string
}

type diffForeignKey struct {
	name      string
	column    string
	target    string
	targetCol string
	onDelete  string
}

func diffIndexesAndForeignKeys(from, to *schema.Manifest, oldEnt, newEnt *schema.Entity, dialect string, quote func(string) string) ([]schemaChange, []schemaChange, error) {
	oldIndexes := entityIndexes(oldEnt)
	newIndexes := entityIndexes(newEnt)
	var indexDrops, indexAdds, foreignDrops, foreignAdds []schemaChange
	keys := unionSortedKeys(oldIndexes, newIndexes)
	for _, key := range keys {
		o, ook := oldIndexes[key]
		n, nok := newIndexes[key]
		if ook && nok && o.kind == n.kind && stringSlicesEqual(o.cols, n.cols) {
			continue
		}
		if ook {
			stmt, err := dropIndex(oldEnt.Table, o, dialect, quote)
			if err != nil {
				return nil, nil, err
			}
			indexDrops = append(indexDrops, schemaChange{sql: stmt})
		}
		if nok {
			stmt, err := createIndex(newEnt.Table, n, dialect, quote)
			if err != nil {
				return nil, nil, err
			}
			indexAdds = append(indexAdds, schemaChange{sql: stmt})
		}
	}

	oldFKs := entityForeignKeys(from, oldEnt)
	newFKs := entityForeignKeys(to, newEnt)
	fkKeys := unionSortedKeys(oldFKs, newFKs)
	for _, key := range fkKeys {
		o, ook := oldFKs[key]
		n, nok := newFKs[key]
		if ook && nok && o == n {
			continue
		}
		if dialect == "sqlite" {
			return nil, nil, fmt.Errorf("sqlite foreign key changes require a verified table rebuild")
		}
		if ook {
			verb := "DROP CONSTRAINT"
			if dialect == "mysql" {
				verb = "DROP FOREIGN KEY"
			}
			foreignDrops = append(foreignDrops, schemaChange{sql: fmt.Sprintf("ALTER TABLE %s %s %s;", quote(oldEnt.Table), verb, quote(o.name))})
		}
		if nok {
			foreignAdds = append(foreignAdds, schemaChange{sql: "ALTER TABLE " + quote(newEnt.Table) + " ADD " + foreignKeyClause(n, to, quote) + ";"})
		}
	}
	return append(foreignDrops, indexDrops...), append(indexAdds, foreignAdds...), nil
}

func entityIndexes(e *schema.Entity) map[string]diffIndex {
	out := map[string]diffIndex{}
	for name, cols := range e.Indexes {
		out["index:"+name] = diffIndex{name: name, kind: "index", cols: append([]string(nil), cols...)}
	}
	for _, cols := range e.Unique {
		name := "uq_" + e.Table + "_" + strings.Join(cols, "_")
		out["unique:"+name] = diffIndex{name: name, kind: "unique", cols: append([]string(nil), cols...)}
	}
	for _, cols := range e.Fulltext {
		name := "ft_" + strings.Join(cols, "_")
		out["fulltext:"+name] = diffIndex{name: name, kind: "fulltext", cols: append([]string(nil), cols...)}
	}
	return out
}

func entityForeignKeys(m *schema.Manifest, e *schema.Entity) map[string]diffForeignKey {
	out := map[string]diffForeignKey{}
	for _, c := range e.Columns {
		if c.Ref == nil {
			continue
		}
		fk := diffForeignKey{name: "fk_" + e.Table + "_" + c.Name, column: c.Name, target: c.Ref.Entity, targetCol: c.Ref.Column}
		for _, rel := range e.Relations {
			if rel.Left == c.Name && rel.Target == c.Ref.Entity && rel.Right == c.Ref.Column {
				fk.onDelete = rel.OnDelete
				break
			}
		}
		out[c.Name] = fk
	}
	return out
}

func foreignKeyClause(fk diffForeignKey, m *schema.Manifest, quote func(string) string) string {
	target := fk.target
	if e := m.Entities[fk.target]; e != nil {
		target = e.Table
	}
	stmt := fmt.Sprintf("CONSTRAINT %s FOREIGN KEY (%s) REFERENCES %s (%s)", quote(fk.name), quote(fk.column), quote(target), quote(fk.targetCol))
	switch fk.onDelete {
	case "cascade":
		stmt += " ON DELETE CASCADE"
	case "setnull":
		stmt += " ON DELETE SET NULL"
	default:
		stmt += " ON DELETE RESTRICT"
	}
	return stmt
}

func dropIndex(table string, index diffIndex, dialect string, quote func(string) string) (string, error) {
	if index.kind == "unique" {
		switch dialect {
		case "postgres":
			return fmt.Sprintf("ALTER TABLE %s DROP CONSTRAINT %s;", quote(table), quote(index.name)), nil
		case "sqlite":
			return "", fmt.Errorf("sqlite unique constraint changes require a verified table rebuild")
		}
	}
	name := index.name
	if dialect == "postgres" && index.kind != "unique" {
		name = table + "_" + name
	}
	if dialect == "mysql" {
		return fmt.Sprintf("DROP INDEX %s ON %s;", quote(name), quote(table)), nil
	}
	if dialect == "sqlite" && index.kind == "fulltext" {
		return "", fmt.Errorf("sqlite full-text index changes are not supported")
	}
	return fmt.Sprintf("DROP INDEX %s;", quote(name)), nil
}

func createIndex(table string, index diffIndex, dialect string, quote func(string) string) (string, error) {
	if index.kind == "unique" {
		switch dialect {
		case "postgres":
			return fmt.Sprintf("ALTER TABLE %s ADD CONSTRAINT %s UNIQUE (%s);", quote(table), quote(index.name), joinQuoted(index.cols, quote)), nil
		case "sqlite":
			return "", fmt.Errorf("sqlite unique constraint changes require a verified table rebuild")
		}
	}
	name := index.name
	if dialect == "postgres" && index.kind != "unique" {
		name = table + "_" + name
	}
	switch index.kind {
	case "index":
		return fmt.Sprintf("CREATE INDEX %s ON %s (%s);", quote(name), quote(table), joinQuoted(index.cols, quote)), nil
	case "unique":
		return fmt.Sprintf("CREATE UNIQUE INDEX %s ON %s (%s);", quote(name), quote(table), joinQuoted(index.cols, quote)), nil
	case "fulltext":
		switch dialect {
		case "mysql":
			return fmt.Sprintf("CREATE FULLTEXT INDEX %s ON %s (%s);", quote(name), quote(table), joinQuoted(index.cols, quote)), nil
		case "postgres":
			doc := make([]string, len(index.cols))
			for i, c := range index.cols {
				doc[i] = "coalesce(" + quote(c) + ", '')"
			}
			return fmt.Sprintf("CREATE INDEX %s ON %s USING GIN (to_tsvector('simple', %s));", quote(name), quote(table), strings.Join(doc, " || ' ' || ")), nil
		default:
			return "", fmt.Errorf("sqlite full-text index changes are not supported")
		}
	}
	return "", fmt.Errorf("unknown index kind %q", index.kind)
}

func unionSortedKeys[T any](left, right map[string]T) []string {
	set := map[string]bool{}
	for key := range left {
		set[key] = true
	}
	for key := range right {
		set[key] = true
	}
	keys := make([]string, 0, len(set))
	for key := range set {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func stringSlicesEqual(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func alterTableComment(table, comment, dialect string, quote func(string) string) string {
	q := sqlQuote(comment)
	switch dialect {
	case "mysql":
		return fmt.Sprintf("ALTER TABLE %s COMMENT = '%s';", quote(table), q)
	case "postgres":
		if comment == "" {
			return fmt.Sprintf("COMMENT ON TABLE %s IS NULL;", quote(table))
		}
		return fmt.Sprintf("COMMENT ON TABLE %s IS '%s';", quote(table), q)
	default:
		if comment == "" {
			return fmt.Sprintf("DELETE FROM orm_schema_comments WHERE table_name='%s' AND column_name='';", sqlQuote(table))
		}
		return fmt.Sprintf("INSERT OR REPLACE INTO orm_schema_comments (table_name,column_name,comment) VALUES ('%s','','%s');", sqlQuote(table), q)
	}
}

func alterComment(table string, c *schema.Col, dialect string, quote func(string) string) (string, error) {
	q := sqlQuote(c.Comment)
	switch dialect {
	case "mysql":
		def, err := ddlColumn(c, dialect, quote)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("ALTER TABLE %s MODIFY COLUMN %s;", quote(table), def+func() string {
			if c.Comment != "" {
				return " COMMENT '" + q + "'"
			}
			return " COMMENT ''"
		}()), nil
	case "postgres":
		if c.Comment == "" {
			return fmt.Sprintf("COMMENT ON COLUMN %s.%s IS NULL;", quote(table), quote(c.Name)), nil
		}
		return fmt.Sprintf("COMMENT ON COLUMN %s.%s IS '%s';", quote(table), quote(c.Name), q), nil
	default:
		if c.Comment == "" {
			return fmt.Sprintf("DELETE FROM orm_schema_comments WHERE table_name='%s' AND column_name='%s';", sqlQuote(table), sqlQuote(c.Name)), nil
		}
		return fmt.Sprintf("INSERT OR REPLACE INTO orm_schema_comments (table_name,column_name,comment) VALUES ('%s','%s','%s');", sqlQuote(table), sqlQuote(c.Name), q), nil
	}
}
