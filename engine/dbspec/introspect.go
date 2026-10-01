package dbspec

import (
	"context"
	"database/sql"
	"fmt"
	"slices"
	"strings"
)

// Querier는 introspection이 catalog query를 보내는 connection이다.
// *sql.DB, *sql.Conn, *sql.Tx가 이를 만족한다.
type Querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// Unsupported는 introspection이 dbspec으로 읽지 못한 객체다(docs/dialects.md
// "Introspection"). Kind는 column, index, unique, foreign_key, check, trigger,
// view, routine, sequence, event, partition, table 중 하나다.
type Unsupported struct {
	Kind   string
	Table  string
	Name   string
	Reason string
}

// Introspect는 connection의 현재 database, schema 또는 main database를 읽어
// name이라는 dbspec 문서와 읽지 못한 객체 목록을 돌려준다. query 수는 table 수와
// 무관하다. query 실패와 문서를 만들 수 없는 catalog는 error다.
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

// catalog은 dialect reader가 채우는 중립 중간 model이다. type은 Type이고,
// default literal과 predicate는 이미 dbspec 표기다.
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

// document는 중간 model을 dbspec text로 쓰고 parse한다. parse가 어떤 줄을
// 거부하면 그 줄의 객체를 미지원으로 보고하고 빼서 다시 만든다. 빠진 객체를
// 참조하던 객체는 다음 parse에서 거부되므로 같은 방식으로 빠진다. 객체에 속하지
// 않는 줄의 diagnostic은 reader의 결함이므로 error다.
func (c *catalog) document(name string) (*Document, []Unsupported, error) {
	c.dropTablesWithoutKey()
	for {
		text, objects := c.text(name)
		document, diagnostics := Parse(text, nil)
		if len(diagnostics) == 0 {
			slices.SortStableFunc(c.unsupported, func(a, b Unsupported) int {
				return strings.Compare(a.Table+"\x00"+a.Kind+"\x00"+a.Name, b.Table+"\x00"+b.Kind+"\x00"+b.Name)
			})
			return document, c.unsupported, nil
		}
		removed := map[lineObject]bool{}
		for _, d := range diagnostics {
			o, ok := objects[d.Line]
			if !ok {
				return nil, nil, fmt.Errorf("introspected document does not parse: %v\n%s", diagnostics, text)
			}
			if !removed[o] {
				removed[o] = true
				c.report(o.kind, o.table, o.name, "%s: %s", d.Rule, d.Message)
				c.remove(o)
			}
		}
	}
}

// lineObject는 dbspec text 한 줄이 나타내는 객체다. kind는 Unsupported의 kind다.
type lineObject struct{ kind, table, name string }

// remove는 객체 하나를 뺀다. table이나 primary key를 빼면 table 전체가 빠진다.
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

// dropTablesWithoutKey는 primary key가 없는 table을 뺀다. 그 table을 참조하던
// foreign key는 parse가 거부해 빠진다.
func (c *catalog) dropTablesWithoutKey() {
	c.tables = slices.DeleteFunc(c.tables, func(t *itable) bool {
		if len(t.primary) == 0 {
			c.report("table", t.name, t.name, "the table has no primary key")
			return true
		}
		return false
	})
}

// text는 table을 이름 순으로 쓴 dbspec text와, 줄 번호마다 그 줄의 객체를
// 돌려준다. 닫는 괄호와 primary key 줄은 table에 속한다.
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

// actionName은 catalog의 참조 action을 dbspec action으로 바꾼다.
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

// rendererCheckName은 renderer CHECK의 이름 <table>$<column>이다.
func rendererCheckName(table, column string) string { return table + "$" + column }
