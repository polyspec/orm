package dbspec

import (
	"context"
	"database/sql"
	"fmt"
	"slices"
	"strings"
)

// Querier is the connection on which introspection sends catalog queries.
// *sql.DB, *sql.Conn, and *sql.Tx satisfy it.
type Querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// QueryObserver, if the Querier implements it, is called for each catalog query when all its rows have been read
// or when reading fails. err is the query's error. The error that QueryEnded returns ends the introspection
// with that error.
type QueryObserver interface {
	QueryEnded(query string, err error) error
}

// Unsupported is an object that introspection could not read as dbspec (docs/spec/dialects.md
// "Introspection"). Kind is one of column, index, unique, foreign_key, check, trigger,
// view, routine, sequence, event, partition, or table.
type Unsupported struct {
	Kind   string
	Table  string
	Name   string
	Reason string
}

// Introspect reads the connection's current database, schema, or main database
// and returns a dbspec document named name and the list of objects it could not read. The number of queries is
// unrelated to the number of tables. A query failure, or a catalog from which no document can be made, is an error.
func Introspect(ctx context.Context, q Querier, dialect Dialect, name string) (*Document, []Unsupported, error) {
	var cat *catalog
	var err error
	switch dialect {
	case DialectMySQL:
		cat, err = readMySQL(ctx, q)
	case DialectPostgres:
		cat, err = readPostgres(ctx, q)
	case DialectSQLite:
		cat, err = readSQLite(ctx, q)
	default:
		panic("dbspec: unknown dialect " + string(dialect))
	}
	if err != nil {
		return nil, nil, err
	}
	return cat.document(name)
}

// catalog is the neutral intermediate model that the dialect reader fills. type is Type, and
// default literals and predicates are already in dbspec notation.
type catalog struct {
	tables      []*itable
	unsupported []Unsupported
}

type itable struct {
	name     string
	columns  []icolumn
	primary  []string
	uniques  []ikey
	indexes  []ikey
	fks      []ifk
	checks   []icheck
	settings []string
}

type icolumn struct {
	name     string
	typ      Type
	null     bool
	identity bool
	dflt     string
}

type ikey struct {
	name    string
	columns []string
	desc    []bool
}

type ifk struct {
	name     string
	columns  []string
	table    string
	refs     []string
	onDelete string
	onUpdate string
}

type icheck struct {
	name      string
	predicate string
}

func (c *catalog) report(kind, table, name, format string, args ...any) {
	c.unsupported = append(c.unsupported, Unsupported{Kind: kind, Table: table, Name: name, Reason: fmt.Sprintf(format, args...)})
}

func (c *catalog) table(name string) *itable {
	for _, t := range c.tables {
		if t.name == name {
			return t
		}
	}
	return nil
}

// document writes the intermediate model as dbspec text and parses it. When parse rejects a line,
// it reports that line's object as unsupported, removes it, and builds again. Objects that referred to a removed object
// are rejected at the next parse, so they are removed in the same way. A diagnostic on a line that does not belong
// to an object is a defect of the reader, so it is an error.
func (c *catalog) document(name string) (*Document, []Unsupported, error) {
	c.dropTablesWithoutKey()
	for {
		text, objects := c.text(name)
		document, _, diagnostics := Parse(text, nil)
		if len(diagnostics) == 0 {
			slices.SortStableFunc(c.unsupported, func(a, b Unsupported) int {
				return strings.Compare(a.Table+"\x00"+a.Kind+"\x00"+a.Name, b.Table+"\x00"+b.Kind+"\x00"+b.Name)
			})
			return document, c.unsupported, nil
		}
		// Objects of a table that was rejected are removed along with the table, so they are not reported separately.
		rejected := map[string]bool{}
		for _, d := range diagnostics {
			o, ok := objects[d.Line]
			if !ok {
				return nil, nil, fmt.Errorf("introspected document does not parse: %v\n%s", diagnostics, text)
			}
			if o.kind == "table" {
				rejected[o.table] = true
			}
		}
		removed := map[lineObject]bool{}
		for _, d := range diagnostics {
			o := objects[d.Line]
			if removed[o] || (o.kind != "table" && rejected[o.table]) {
				continue
			}
			removed[o] = true
			c.report(o.kind, o.table, o.name, "%s: %s", d.Rule, d.Message)
			c.remove(o)
		}
	}
}

// lineObject is the object that one line of dbspec text stands for. kind is the kind of Unsupported.
type lineObject struct{ kind, table, name string }

// remove removes one object. Removing a table or a primary key removes the whole table.
func (c *catalog) remove(o lineObject) {
	t := c.table(o.table)
	switch o.kind {
	case "table":
		c.tables = slices.DeleteFunc(c.tables, func(x *itable) bool { return x == t })
	case "column":
		t.columns = slices.DeleteFunc(t.columns, func(x icolumn) bool { return x.name == o.name })
	case "unique":
		t.uniques = slices.DeleteFunc(t.uniques, func(x ikey) bool { return x.name == o.name })
	case "index":
		t.indexes = slices.DeleteFunc(t.indexes, func(x ikey) bool { return x.name == o.name })
	case "foreign_key":
		t.fks = slices.DeleteFunc(t.fks, func(x ifk) bool { return x.name == o.name })
	case "check":
		t.checks = slices.DeleteFunc(t.checks, func(x icheck) bool { return x.name == o.name })
	case "trigger":
		t.settings = slices.DeleteFunc(t.settings, func(x string) bool { return strings.Fields(x)[0] == o.name })
	}
}

// dropTablesWithoutKey removes tables that have no primary key. Foreign keys
// that refer to that table are rejected by parse and removed.
func (c *catalog) dropTablesWithoutKey() {
	c.tables = slices.DeleteFunc(c.tables, func(t *itable) bool {
		if len(t.primary) == 0 {
			c.report("table", t.name, t.name, "the table has no primary key")
			return true
		}
		return false
	})
}

// text returns the dbspec text with tables in name order, and, for each line number, the object on that line.
// The closing parenthesis and the primary key line belong to the table.
func (c *catalog) text(name string) (string, map[int]lineObject) {
	tables := slices.Clone(c.tables)
	slices.SortFunc(tables, func(a, b *itable) int { return strings.Compare(a.name, b.name) })
	lines := []string{"dbspec 1 " + name}
	objects := map[int]lineObject{}
	add := func(line string, o lineObject) {
		lines = append(lines, line)
		objects[len(lines)] = o
	}
	for _, t := range tables {
		table := lineObject{"table", t.name, t.name}
		lines = append(lines, "")
		add("table "+t.name+" {", table)
		for _, col := range t.columns {
			s := "  " + col.name + " " + col.typ.String()
			if col.null {
				s += " null"
			}
			if col.identity {
				s += " identity"
			}
			if col.dflt != "" {
				s += " default " + col.dflt
			}
			add(s, lineObject{"column", t.name, col.name})
		}
		add("  primary key ("+strings.Join(t.primary, ", ")+")", table)
		for _, u := range t.uniques {
			add("  unique "+u.name+" ("+strings.Join(u.columns, ", ")+")", lineObject{"unique", t.name, u.name})
		}
		for _, x := range t.indexes {
			columns := make([]string, len(x.columns))
			for i, col := range x.columns {
				columns[i] = col
				if x.desc[i] {
					columns[i] += " desc"
				}
			}
			add("  index "+x.name+" ("+strings.Join(columns, ", ")+")", lineObject{"index", t.name, x.name})
		}
		for _, f := range t.fks {
			add("  foreign key "+f.name+" ("+strings.Join(f.columns, ", ")+") references "+f.table+
				" ("+strings.Join(f.refs, ", ")+") on delete "+f.onDelete+" on update "+f.onUpdate, lineObject{"foreign_key", t.name, f.name})
		}
		for _, k := range t.checks {
			add("  check "+k.name+" ("+k.predicate+")", lineObject{"check", t.name, k.name})
		}
		if len(t.settings) > 0 {
			add("  settings {", table)
			for _, s := range t.settings {
				add("    "+s, lineObject{"trigger", t.name, strings.Fields(s)[0]})
			}
			add("  }", table)
		}
		add("}", table)
	}
	return strings.Join(lines, "\n") + "\n", objects
}

// actionName converts the catalog's referential action to a dbspec action.
func actionName(rule string) (string, bool) {
	switch strings.ToUpper(rule) {
	case "RESTRICT":
		return "restrict", true
	case "CASCADE":
		return "cascade", true
	case "SET NULL":
		return "set_null", true
	}
	return "", false
}
