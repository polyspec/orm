package ormgen

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

type diffEntityPair struct {
	old  *schema.Entity
	next *schema.Entity
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
	if err := alignSourceChecks(*fromPath, *toPath, from, to); err != nil {
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
	if err := validateRenameSources(from, to); err != nil {
		return "", err
	}
	changes := make([]schemaChange, 0)
	pairs := matchDiffEntities(from, to)
	rebuilt := map[string]bool{}
	for _, pair := range pairs {
		oldEnt, newEnt := pair.old, pair.next
		oldOK, newOK := oldEnt != nil, newEnt != nil
		switch {
		case !oldOK:
			one := &schema.Manifest{SchemaHash: to.SchemaHash, Order: []string{newEnt.Name}, Entities: map[string]*schema.Entity{newEnt.Name: newEnt}}
			create, err := renderDDL(one, dialect)
			if err != nil {
				return "", err
			}
			create = removeDropStatement(create)
			changes = append(changes, schemaChange{sql: strings.TrimSpace(create)})
		case !newOK:
			changes = append(changes, schemaChange{sql: "DROP TABLE " + quote(oldEnt.Table) + ";", destructive: true})
		default:
			var tableRename string
			if oldEnt.Table != newEnt.Table {
				if newEnt.RenamedFrom != oldEnt.Name && oldEnt.RenamedFrom != newEnt.Name {
					return "", fmt.Errorf("table rename %s -> %s requires explicit migration", oldEnt.Table, newEnt.Table)
				}
				tableRename = fmt.Sprintf("ALTER TABLE %s RENAME TO %s;", quote(oldEnt.Table), quote(newEnt.Table))
			}
			if dialect == "sqlite" {
				if err := validateSQLiteAddedColumns(oldEnt, newEnt); err != nil {
					return "", err
				}
				if sqliteNeedsRebuild(from, to, oldEnt, newEnt) {
					rebuilt[oldEnt.Table] = true
					rebuilt[newEnt.Table] = true
					statement, destructive, err := renderSQLiteRebuild(from, to, oldEnt, newEnt, quote)
					if err != nil {
						return "", err
					}
					changes = append(changes, schemaChange{sql: statement, destructive: destructive})
					continue
				}
			}
			drops, adds, err := diffIndexesAndForeignKeys(from, to, oldEnt, newEnt, dialect, quote)
			if err != nil {
				return "", err
			}
			checkDrops, checkAdds, err := diffChecks(oldEnt, newEnt, dialect, quote)
			if err != nil {
				return "", err
			}
			changes = append(changes, drops...)
			changes = append(changes, checkDrops...)
			if tableRename != "" {
				changes = append(changes, schemaChange{sql: tableRename})
			}
			oldCols, newCols := map[string]*schema.Col{}, map[string]*schema.Col{}
			for _, c := range oldEnt.Columns {
				oldCols[c.Name] = c
			}
			for _, c := range newEnt.Columns {
				newCols[c.Name] = c
			}
			for _, columns := range matchDiffColumns(oldEnt, newEnt) {
				o, n := columns[0], columns[1]
				ook, nok := o != nil, n != nil
				col := ""
				if n != nil {
					col = n.Name
				} else {
					col = o.Name
				}
				switch {
				case !ook:
					def, err := ddlColumn(n, dialect, quote)
					if err != nil {
						return "", err
					}
					if dialect == "mysql" && n.Comment != "" {
						def += " COMMENT '" + sqlQuote(n.Comment) + "'"
					}
					changes = append(changes, schemaChange{sql: fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s;", quote(newEnt.Table), def)})
					if dialect != "mysql" && n.Comment != "" {
						stmt, err := alterComment(newEnt.Table, n, dialect, quote)
						if err != nil {
							return "", err
						}
						changes = append(changes, schemaChange{sql: stmt})
					}
				case !nok:
					changes = append(changes, schemaChange{sql: fmt.Sprintf("ALTER TABLE %s DROP COLUMN %s;", quote(oldEnt.Table), quote(col)), destructive: true})
				default:
					if o.Name != n.Name {
						changes = append(changes, schemaChange{sql: fmt.Sprintf("ALTER TABLE %s RENAME COLUMN %s TO %s;", quote(newEnt.Table), quote(o.Name), quote(n.Name))})
					}
					changed := columnChanged(o, n, dialect)
					if dialect == "sqlite" {
						changed = !sqliteColumnsEquivalent(o, n)
					}
					if !changed {
						break
					}
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
			changes = append(changes, checkAdds...)
		}
	}
	triggerDrops, triggerCreates, err := diffTriggers(from, to, dialect, rebuilt)
	if err != nil {
		return "", err
	}
	changes = append(append(triggerDrops, changes...), triggerCreates...)
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

func validateSQLiteAddedColumns(old, next *schema.Entity) error {
	for _, pair := range matchDiffColumns(old, next) {
		previous, c := pair[0], pair[1]
		if c == nil || previous != nil {
			continue
		}
		if !c.Nullable && c.Default == nil && !c.Auto {
			return fmt.Errorf("sqlite table %s cannot add required column %s without a default during a data-preserving migration", next.Table, c.Name)
		}
	}
	return nil
}

func sqliteNeedsRebuild(from, to *schema.Manifest, old, next *schema.Entity) bool {
	if !stringSlicesEqual(old.PK, next.PK) || !columnGroupsEqual(old.Unique, next.Unique) || !checksEqual(old.Checks, next.Checks) {
		return true
	}
	for _, pair := range matchDiffColumns(old, next) {
		if pair[0] == nil || pair[1] == nil {
			if pair[1] == nil {
				return true
			}
			continue
		}
		if !sqliteColumnsEquivalent(pair[0], pair[1]) {
			return true
		}
	}
	oldFKs, newFKs := entityForeignKeys(from, old), entityForeignKeys(to, next)
	if len(oldFKs) != len(newFKs) {
		return true
	}
	for column, left := range oldFKs {
		right, ok := newFKs[column]
		if !ok || !foreignKeysEqualWithoutName(left, right) {
			return true
		}
	}
	return false
}

func checksEqual(left, right []schema.Check) bool {
	if len(left) != len(right) {
		return false
	}
	keys := func(values []schema.Check) []string {
		out := make([]string, len(values))
		for i, value := range values {
			out[i] = value.Name + "\x00" + value.Expr
		}
		sort.Strings(out)
		return out
	}
	return stringSlicesEqual(keys(left), keys(right))
}

func diffChecks(oldEnt, newEnt *schema.Entity, dialect string, quote func(string) string) ([]schemaChange, []schemaChange, error) {
	if dialect == "sqlite" && !checksEqual(oldEnt.Checks, newEnt.Checks) {
		return nil, nil, fmt.Errorf("sqlite CHECK constraint changes require a verified table rebuild")
	}
	oldChecks, newChecks := map[string]schema.Check{}, map[string]schema.Check{}
	for _, check := range oldEnt.Checks {
		oldChecks[check.Name] = check
	}
	for _, check := range newEnt.Checks {
		newChecks[check.Name] = check
	}
	names := make([]string, 0, len(oldChecks)+len(newChecks))
	seen := map[string]bool{}
	for name := range oldChecks {
		names = append(names, name)
		seen[name] = true
	}
	for name := range newChecks {
		if !seen[name] {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	var drops, adds []schemaChange
	for _, name := range names {
		oldCheck, oldOK := oldChecks[name]
		newCheck, newOK := newChecks[name]
		if oldOK && (!newOK || oldCheck.Expr != newCheck.Expr) {
			drops = append(drops, schemaChange{sql: fmt.Sprintf("ALTER TABLE %s DROP CONSTRAINT %s;", quote(oldEnt.Table), quote(ddlCheckName(oldEnt.Table, name, dialect))), destructive: true})
		}
		if newOK && (!oldOK || oldCheck.Expr != newCheck.Expr) {
			expr, err := renderedCheckExpression(newCheck.Expr, dialect, quote)
			if err != nil {
				return nil, nil, fmt.Errorf("%s check %s: %w", newEnt.Table, name, err)
			}
			adds = append(adds, schemaChange{sql: fmt.Sprintf("ALTER TABLE %s ADD CONSTRAINT %s CHECK (%s);", quote(newEnt.Table), quote(ddlCheckName(newEnt.Table, name, dialect)), expr)})
		}
	}
	return drops, adds, nil
}

func sqliteColumnsEquivalent(left, right *schema.Col) bool {
	typeMatch := sqliteTypeMatches(right.Type, left.Type) || sqliteTypeMatches(left.Type, right.Type)
	return typeMatch && left.Nullable == right.Nullable && normalizedDefault(left) == normalizedDefault(right) && left.Auto == right.Auto
}

func normalizedDefault(column *schema.Col) string {
	if column.Default == nil {
		return ""
	}
	return strings.Trim(*column.Default, "'\"")
}

func columnGroupsEqual(left, right [][]string) bool {
	if len(left) != len(right) {
		return false
	}
	keys := func(groups [][]string) []string {
		out := make([]string, len(groups))
		for i, group := range groups {
			out[i] = strings.Join(group, "\x00")
		}
		sort.Strings(out)
		return out
	}
	return stringSlicesEqual(keys(left), keys(right))
}

func renderSQLiteRebuild(from, to *schema.Manifest, old, next *schema.Entity, quote func(string) string) (string, bool, error) {
	temp := "__orm_rebuild_" + next.Table
	lines := make([]string, 0, len(next.Columns)+len(next.Unique)+len(next.Columns))
	for _, c := range next.Columns {
		def, err := ddlColumn(c, "sqlite", quote)
		if err != nil {
			return "", false, err
		}
		lines = append(lines, "  "+def)
	}
	if len(next.PK) == 1 && next.Auto == next.PK[0] {
		for i, line := range lines {
			if strings.HasPrefix(line, "  "+quote(next.PK[0])+" ") {
				lines[i] = "  " + quote(next.PK[0]) + " INTEGER PRIMARY KEY AUTOINCREMENT"
			}
		}
	} else {
		lines = append(lines, "  PRIMARY KEY ("+joinQuoted(next.PK, quote)+")")
	}
	for _, unique := range next.Unique {
		lines = append(lines, "  CONSTRAINT "+quote(boundedIdentifier("uq_"+next.Table+"_"+strings.Join(unique, "_"), "sqlite"))+" UNIQUE ("+joinQuoted(unique, quote)+")")
	}
	for _, fk := range sortedForeignKeys(to, next, "sqlite") {
		lines = append(lines, "  "+foreignKeyClause(fk, to, "sqlite", quote))
	}
	for _, check := range next.Checks {
		expr, err := renderedCheckExpression(check.Expr, "sqlite", quote)
		if err != nil {
			return "", false, fmt.Errorf("%s check %s: %w", next.Table, check.Name, err)
		}
		lines = append(lines, "  CONSTRAINT "+quote(check.Name)+" CHECK ("+expr+")")
	}
	var targetCols, sourceCols []string
	for _, pair := range matchDiffColumns(old, next) {
		o, n := pair[0], pair[1]
		if o == nil {
			continue
		}
		if n == nil {
			continue
		}
		targetCols = append(targetCols, quote(n.Name))
		sourceCols = append(sourceCols, quote(o.Name))
	}
	var b strings.Builder
	b.WriteString("SELECT 'orm-sqlite-rebuild table=" + old.Table + " target=" + next.Table + " temp=" + temp + "';\n")
	b.WriteString("PRAGMA defer_foreign_keys = ON;\n")
	b.WriteString("CREATE TABLE " + quote(temp) + " (\n" + strings.Join(lines, ",\n") + "\n);\n")
	if len(targetCols) > 0 {
		b.WriteString("INSERT INTO " + quote(temp) + " (" + strings.Join(targetCols, ", ") + ") SELECT " + strings.Join(sourceCols, ", ") + " FROM " + quote(old.Table) + ";\n")
	}
	b.WriteString("DROP TABLE " + quote(old.Table) + ";\n")
	b.WriteString("ALTER TABLE " + quote(temp) + " RENAME TO " + quote(next.Table) + ";\n")
	for _, name := range sortedIndexNames(next.Indexes) {
		b.WriteString("CREATE INDEX " + quote(next.Table+"_"+name) + " ON " + quote(next.Table) + " (" + joinQuoted(next.Indexes[name], quote) + ");\n")
	}
	b.WriteString("CREATE TABLE IF NOT EXISTS orm_schema_comments (table_name TEXT NOT NULL, column_name TEXT NOT NULL, comment TEXT NOT NULL, PRIMARY KEY (table_name, column_name));\n")
	b.WriteString("DELETE FROM orm_schema_comments WHERE table_name='" + sqlQuote(old.Table) + "';\n")
	if next.Comment != "" {
		b.WriteString("INSERT OR REPLACE INTO orm_schema_comments (table_name,column_name,comment) VALUES ('" + sqlQuote(next.Table) + "','','" + sqlQuote(next.Comment) + "');\n")
	}
	for _, c := range next.Columns {
		if c.Comment != "" {
			b.WriteString("INSERT OR REPLACE INTO orm_schema_comments (table_name,column_name,comment) VALUES ('" + sqlQuote(next.Table) + "','" + sqlQuote(c.Name) + "','" + sqlQuote(c.Comment) + "');\n")
		}
	}
	return strings.TrimSpace(b.String()), true, nil
}

func validateRenameSources(from, to *schema.Manifest) error {
	for _, next := range to.Entities {
		old := from.Entities[next.Name]
		alreadyRenamed := old != nil
		if next.RenamedFrom != "" && !alreadyRenamed {
			old = from.Entities[next.RenamedFrom]
			if old == nil {
				return fmt.Errorf("table %s rename source %s does not exist", next.Name, next.RenamedFrom)
			}
		}
		if old == nil {
			continue
		}
		oldColumns := map[string]bool{}
		for _, column := range old.Columns {
			oldColumns[column.Name] = true
		}
		for _, column := range next.Columns {
			if column.RenamedFrom != "" && !oldColumns[column.Name] && !oldColumns[column.RenamedFrom] {
				return fmt.Errorf("column %s.%s rename source %s does not exist", next.Name, column.Name, column.RenamedFrom)
			}
		}
	}
	return nil
}

func matchDiffEntities(from, to *schema.Manifest) []diffEntityPair {
	used := map[string]bool{}
	names := make([]string, 0, len(to.Entities))
	for name := range to.Entities {
		names = append(names, name)
	}
	sort.Strings(names)
	pairs := make([]diffEntityPair, 0, len(from.Entities)+len(to.Entities))
	for _, name := range names {
		next := to.Entities[name]
		old := from.Entities[name]
		if old == nil && next.RenamedFrom != "" {
			old = from.Entities[next.RenamedFrom]
		}
		if old == nil {
			for _, candidate := range from.Entities {
				if candidate.RenamedFrom == name {
					old = candidate
					break
				}
			}
		}
		if old != nil {
			used[old.Name] = true
		}
		pairs = append(pairs, diffEntityPair{old: old, next: next})
	}
	oldNames := make([]string, 0)
	for name := range from.Entities {
		if !used[name] {
			oldNames = append(oldNames, name)
		}
	}
	sort.Strings(oldNames)
	for _, name := range oldNames {
		pairs = append(pairs, diffEntityPair{old: from.Entities[name]})
	}
	return pairs
}

func matchDiffColumns(old, next *schema.Entity) [][2]*schema.Col {
	oldByName := map[string]*schema.Col{}
	for _, c := range old.Columns {
		oldByName[c.Name] = c
	}
	used := map[string]bool{}
	out := make([][2]*schema.Col, 0, len(old.Columns)+len(next.Columns))
	for _, n := range next.Columns {
		o := oldByName[n.Name]
		if o == nil && n.RenamedFrom != "" {
			o = oldByName[n.RenamedFrom]
		}
		if o == nil {
			for _, candidate := range old.Columns {
				if candidate.RenamedFrom == n.Name {
					o = candidate
					break
				}
			}
		}
		if o != nil {
			used[o.Name] = true
		}
		out = append(out, [2]*schema.Col{o, n})
	}
	for _, o := range old.Columns {
		if !used[o.Name] {
			out = append(out, [2]*schema.Col{o, nil})
		}
	}
	return out
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

// columnChanged reports a physical column difference. The update time is a
// column property only on MySQL; the other dialects assign it in the planned
// UPDATE statement.
func columnChanged(a, b *schema.Col, dialect string) bool {
	onUpdate := dialect == "mysql" && a.OnUpdate != b.OnUpdate
	aType, aRaw, aLen := columnStorage(a, dialect)
	bType, bRaw, bLen := columnStorage(b, dialect)
	return aType != bType || aRaw != bRaw || a.Nullable != b.Nullable || colDefault(a) != colDefault(b) || a.Auto != b.Auto || onUpdate || a.Unsigned != b.Unsigned || aLen != bLen || a.Precision != b.Precision || a.Scale != b.Scale
}

// columnStorage returns the type, raw type, and length a dialect stores: a
// MySQL uuid column is char(36), and a jsontext column is the dialect's text
// type, which a live schema reports without the codec. A PostgreSQL enum
// column is text, which a live schema reports without the value list.
func columnStorage(c *schema.Col, dialect string) (string, string, int) {
	if dialect == "mysql" && strings.EqualFold(c.Raw, "uuid") {
		return c.Type, mysqlUUID, 36
	}
	if c.Type == "jsontext" || c.Type == "text" || (c.Type == "enum" && dialect == "postgres") {
		raw := "text"
		if dialect == "mysql" {
			raw = mysqlJSONText
		}
		return "text", raw, 0
	}
	return c.Type, c.Raw, c.Len
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
		if next.Comment != "" {
			def += " COMMENT '" + sqlQuote(next.Comment) + "'"
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
	t, err := ddlType(c, dialect)
	if err != nil {
		return "", err
	}
	return defaultExpression(c, t, dialect), nil
}

type diffIndex struct {
	name string
	kind string
	cols []string
}

type diffForeignKey struct {
	name       string
	columns    []string
	target     string
	targetCols []string
	onDelete   string
	deferred   bool
}

func diffIndexesAndForeignKeys(from, to *schema.Manifest, oldEnt, newEnt *schema.Entity, dialect string, quote func(string) string) ([]schemaChange, []schemaChange, error) {
	oldIndexes := entityIndexes(oldEnt, dialect)
	newIndexes := entityIndexes(newEnt, dialect)
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

	oldFKs := entityForeignKeys(from, oldEnt, dialect)
	newFKs := entityForeignKeys(to, newEnt, dialect)
	fkKeys := unionSortedKeys(oldFKs, newFKs)
	for _, key := range fkKeys {
		o, ook := oldFKs[key]
		n, nok := newFKs[key]
		if ook && nok && foreignKeysEqual(o, n, dialect != "sqlite") {
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
			foreignAdds = append(foreignAdds, schemaChange{sql: "ALTER TABLE " + quote(newEnt.Table) + " ADD " + foreignKeyClause(n, to, dialect, quote) + ";"})
		}
	}
	return append(foreignDrops, indexDrops...), append(indexAdds, foreignAdds...), nil
}

func foreignKeysEqualWithoutName(left, right diffForeignKey) bool {
	return foreignKeysEqual(left, right, false)
}

func foreignKeysEqual(left, right diffForeignKey, compareName bool) bool {
	return (!compareName || left.name == right.name) && stringSlicesEqual(left.columns, right.columns) && left.target == right.target && stringSlicesEqual(left.targetCols, right.targetCols) && left.onDelete == right.onDelete && left.deferred == right.deferred
}

// entityIndexes lists the physical indexes of an entity. SQLite evaluates
// full-text conditions without an index, so it has no full-text objects.
func entityIndexes(e *schema.Entity, dialect string) map[string]diffIndex {
	out := map[string]diffIndex{}
	for name, cols := range e.Indexes {
		out["index:"+name] = diffIndex{name: name, kind: "index", cols: append([]string(nil), cols...)}
	}
	for _, cols := range e.Unique {
		name := boundedIdentifier("uq_"+e.Table+"_"+strings.Join(cols, "_"), dialect)
		out["unique:"+name] = diffIndex{name: name, kind: "unique", cols: append([]string(nil), cols...)}
	}
	for _, cols := range e.Fulltext {
		if dialect == "sqlite" {
			break
		}
		name := "ft_" + strings.Join(cols, "_")
		out["fulltext:"+name] = diffIndex{name: name, kind: "fulltext", cols: append([]string(nil), cols...)}
	}
	return out
}

func entityForeignKeys(m *schema.Manifest, e *schema.Entity, dialect ...string) map[string]diffForeignKey {
	d := ""
	if len(dialect) > 0 {
		d = dialect[0]
	}
	out := map[string]diffForeignKey{}
	consumed := map[string]bool{}
	for _, rel := range e.Relations {
		if rel.Kind != "one" || (!rel.ForeignKey && !relationMatchesColumnReference(e, rel)) {
			continue
		}
		columns := make([]string, len(rel.Keys))
		targetColumns := make([]string, len(rel.Keys))
		valid := len(rel.Keys) > 0
		for i, key := range rel.Keys {
			var column *schema.Col
			for _, candidate := range e.Columns {
				if candidate.Name == key.Local {
					column = candidate
					break
				}
			}
			if column == nil {
				valid = false
				break
			}
			columns[i], targetColumns[i] = key.Local, key.Target
		}
		if !valid {
			continue
		}
		name := boundedIdentifier("fk_"+e.Table+"_"+strings.Join(columns, "_"), d)
		key := strings.Join(columns, "\x1f")
		out[key] = diffForeignKey{name: name, columns: columns, target: rel.Target, targetCols: targetColumns, onDelete: rel.OnDelete}
		for _, column := range columns {
			consumed[column] = true
		}
	}
	for _, c := range e.Columns {
		if c.Ref == nil || consumed[c.Name] {
			continue
		}
		fk := diffForeignKey{name: boundedIdentifier("fk_"+e.Table+"_"+c.Name, d), columns: []string{c.Name}, target: c.Ref.Entity, targetCols: []string{c.Ref.Column}}
		out[c.Name] = fk
	}
	for _, fk := range m.ExternalFKs {
		if fk.Entity != e.Name {
			continue
		}
		name := fk.Name
		if name == "" {
			name = boundedIdentifier("fk_"+strings.ReplaceAll(e.Table, ".", "_")+"_"+strings.Join(fk.Columns, "_"), d)
		}
		matched := false
		for key, existing := range out {
			target := existing.target
			if targetEntity := m.Entities[target]; targetEntity != nil {
				target = targetEntity.Table
			}
			if target == fk.TargetTable && stringSlicesEqual(existing.columns, fk.Columns) && stringSlicesEqual(existing.targetCols, fk.TargetCols) {
				existing.name, existing.deferred = name, fk.Deferred
				out[key], matched = existing, true
				break
			}
		}
		if matched {
			continue
		}
		key := "external:" + strings.Join(fk.Columns, "\x1f") + "\x1e" + fk.TargetTable
		out[key] = diffForeignKey{name: name, columns: append([]string(nil), fk.Columns...), target: fk.TargetTable, targetCols: append([]string(nil), fk.TargetCols...), onDelete: fk.OnDelete, deferred: fk.Deferred}
	}
	return out
}

func foreignKeyClause(fk diffForeignKey, m *schema.Manifest, dialect string, quote func(string) string) string {
	target := fk.target
	if e := m.Entities[fk.target]; e != nil {
		target = e.Table
	}
	columns := make([]string, len(fk.columns))
	targetColumns := make([]string, len(fk.targetCols))
	for i, column := range fk.columns {
		columns[i] = quote(column)
	}
	for i, column := range fk.targetCols {
		targetColumns[i] = quote(column)
	}
	stmt := fmt.Sprintf("CONSTRAINT %s FOREIGN KEY (%s) REFERENCES %s (%s)", quote(boundedIdentifier(strings.ReplaceAll(fk.name, ".", "_"), dialect)), strings.Join(columns, ", "), quote(target), strings.Join(targetColumns, ", "))
	switch fk.onDelete {
	case "cascade":
		stmt += " ON DELETE CASCADE"
	case "setnull":
		stmt += " ON DELETE SET NULL"
	default:
		stmt += " ON DELETE RESTRICT"
	}
	if fk.deferred && (dialect == "postgres" || dialect == "sqlite") {
		stmt += " DEFERRABLE INITIALLY DEFERRED"
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
	if dialect != "mysql" && index.kind != "unique" {
		name = table + "_" + name
	}
	if dialect == "mysql" {
		return fmt.Sprintf("DROP INDEX %s ON %s;", quote(name), quote(table)), nil
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
	if dialect != "mysql" && index.kind != "unique" {
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
		return fmt.Sprintf("CREATE TABLE IF NOT EXISTS orm_schema_comments (table_name TEXT NOT NULL, column_name TEXT NOT NULL, comment TEXT NOT NULL, PRIMARY KEY (table_name, column_name));\nINSERT OR REPLACE INTO orm_schema_comments (table_name,column_name,comment) VALUES ('%s','%s','%s');", sqlQuote(table), sqlQuote(c.Name), q), nil
	}
}
