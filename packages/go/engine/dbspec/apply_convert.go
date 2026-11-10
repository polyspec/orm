package dbspec

import (
	"maps"
	"slices"
	"strings"
)

// convertSavepoint is the savepoint of the SQLite rebuild of a table in the text storage of a uuid (PLN-110).
const convertSavepoint = `"dbspec$convert"`

// convert converts the uuid columns in the text storage of a release up to 0.0.28 to 16 bytes, before the drift check
// and before any plan (PLN-108). It converts nothing on PostgreSQL, on a database with no recorded plan, and when an
// unsupported object other than such a column exists or the schema with such columns read as uuid is not the state;
// the drift check then reports the database.
func (a *applier) convert(position int) error {
	if a.r.d == DialectPostgres || position == 0 {
		return nil
	}
	state := a.chain[position-1]
	live, unsupported, err := Introspect(a.ctx, a.c, a.r.d, a.server, "schema")
	if err != nil {
		return &ApplyError{Code: "verify", Err: err}
	}
	text := map[string][]string{}
	for _, u := range unsupported {
		if u.Kind != "column" || u.Reason != TextStorageReason {
			return nil
		}
		text[u.Table] = append(text[u.Table], u.Name)
	}
	if len(text) == 0 {
		return nil
	}
	// A dropped foreign key is missing only while its table holds a column in text storage (PLN-109).
	missing := map[string][]ForeignKey{}
	for i := range live.Tables {
		t := &live.Tables[i]
		want := documentTable(state.Schema, t.Name)
		if text[t.Name] == nil || want == nil {
			continue
		}
		for _, f := range want.ForeignKeys {
			if !slices.ContainsFunc(t.ForeignKeys, func(g ForeignKey) bool { return g.Name == f.Name }) {
				t.ForeignKeys = append(t.ForeignKeys, f)
				missing[t.Name] = append(missing[t.Name], f)
			}
		}
	}
	manifest, diagnostics := ManifestOf([]*Document{live})
	if len(diagnostics) > 0 || manifest.SchemaHash != state.To {
		return nil
	}
	var statements []string
	if a.r.d == DialectMySQL {
		statements, err = a.mysqlConversion(state.Schema, text, missing)
	} else {
		statements, err = a.sqliteConversion(state.Schema, text)
	}
	if err != nil {
		return &ApplyError{Code: "convert", Err: err}
	}
	open := false
	for i, statement := range statements {
		if err := a.emit(ApplyEvent{Kind: "convert", Step: i, Statement: statement}); err != nil {
			return a.endConversion(open, err)
		}
		if _, err := a.c.ExecContext(a.ctx, statement); err != nil {
			return a.endConversion(open, &ApplyError{Code: "convert", Step: i, Message: statement, Err: err})
		}
		switch {
		case strings.HasPrefix(statement, "SAVEPOINT "):
			open = true
		case strings.HasPrefix(statement, "RELEASE "):
			open = false
		}
	}
	return nil
}

// endConversion returns err after a stop or a failure of the conversion; inside the SQLite rebuild of a table it rolls
// the table back first, so that the table is kept as it was (PLN-110).
func (a *applier) endConversion(open bool, err error) error {
	if !open {
		return err
	}
	_, back := a.c.ExecContext(a.ctx, "ROLLBACK TO "+convertSavepoint)
	_, release := a.c.ExecContext(a.ctx, "RELEASE "+convertSavepoint)
	return joinCleanup(err, back, release)
}

func documentTable(d *Document, name string) *Table {
	if d == nil {
		return nil
	}
	for i := range d.Tables {
		if d.Tables[i].Name == name {
			return &d.Tables[i]
		}
	}
	return nil
}

// mysqlConversion is the statements of PLN-109 on MySQL and MariaDB, from the storage that the database has now: a
// command that stopped between two statements writes the statements that remain.
func (a *applier) mysqlConversion(state *Document, text map[string][]string, missing map[string][]ForeignKey) ([]string, error) {
	q := a.r.q
	tables := slices.Sorted(maps.Keys(text))
	textColumn := func(table, column string) bool { return slices.Contains(text[table], column) }
	// The column types of the columns in text storage: char(36), or varbinary(36) of a conversion that stopped.
	types := map[string]map[string]string{}
	for _, t := range tables {
		types[t] = map[string]string{}
		for _, c := range text[t] {
			var columnType string
			if err := a.queryRowArgs("SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
				[]any{t, c}, &columnType); err != nil {
				return nil, err
			}
			types[t][c] = columnType
		}
	}
	var out []string
	// 1. The foreign keys of the state that the database has and whose columns or referenced columns are in text storage.
	dropped := map[string][]ForeignKey{}
	for _, st := range sortedBy(state.Tables, func(t Table) string { return t.Name }) {
		for _, f := range sortedBy(st.ForeignKeys, func(f ForeignKey) string { return f.Name }) {
			if slices.ContainsFunc(missing[st.Name], func(g ForeignKey) bool { return g.Name == f.Name }) {
				continue
			}
			uses := slices.ContainsFunc(f.Columns, func(c string) bool { return textColumn(st.Name, c) }) ||
				slices.ContainsFunc(f.References, func(c string) bool { return textColumn(f.Table, c) })
			if uses {
				out = append(out, "ALTER TABLE "+q(st.Name)+" DROP FOREIGN KEY "+q(f.Name))
				dropped[st.Name] = append(dropped[st.Name], f)
			}
		}
	}
	for t, fs := range missing {
		dropped[t] = append(dropped[t], fs...)
	}
	column := func(table, name string) Column {
		return *columnOf(documentTable(state, table), name)
	}
	textDefinition := func(c Column) string {
		s := q(c.Name) + " VARBINARY(36)"
		if c.Null {
			s += " NULL"
		} else {
			s += " NOT NULL"
		}
		if c.Default != nil {
			s += " DEFAULT " + c.Default.Literal
		}
		return s
	}
	// 2. Each char(36) column becomes varbinary(36), which holds both forms.
	for _, t := range tables {
		for _, c := range stateColumnOrder(state, t, text[t]) {
			if types[t][c] != "char(36)" {
				continue
			}
			check := q(rendererName(t, c))
			out = append(out, "ALTER TABLE "+q(t)+" DROP CONSTRAINT "+check+", MODIFY COLUMN "+textDefinition(column(t, c))+
				", ADD CONSTRAINT "+check+" CHECK (length("+q(c)+") IN (16, 36))")
		}
	}
	// 3. The texts become their 16 bytes.
	for _, t := range tables {
		for _, c := range stateColumnOrder(state, t, text[t]) {
			var n int64
			if err := a.queryRow("SELECT COUNT(*) FROM (SELECT 1 FROM "+q(t)+" WHERE length("+q(c)+") = 36 LIMIT 1) x", &n); err != nil {
				return nil, err
			}
			if n > 0 {
				out = append(out, "UPDATE "+q(t)+" SET "+q(c)+" = UNHEX(REPLACE("+q(c)+", '-', '')) WHERE length("+q(c)+") = 36")
			}
		}
	}
	// 4. Each table gets its rendered form, a referenced table before the tables that reference it, with its dropped
	// foreign keys whose referenced table has its rendered form.
	pending := map[string]bool{}
	for _, t := range tables {
		pending[t] = true
	}
	added := map[string]bool{}
	for len(pending) > 0 {
		next := ""
		for _, t := range tables {
			if !pending[t] {
				continue
			}
			ready := !slices.ContainsFunc(documentTable(state, t).ForeignKeys, func(f ForeignKey) bool { return f.Table != t && pending[f.Table] })
			if ready {
				next = t
				break
			}
			if next == "" {
				next = "?" + t
			}
		}
		// A cycle of such tables takes the first of them by name; its foreign keys to a pending table are added last.
		next = strings.TrimPrefix(next, "?")
		delete(pending, next)
		var parts []string
		for _, c := range stateColumnOrder(state, next, text[next]) {
			check := q(rendererName(next, c))
			col := column(next, c)
			parts = append(parts, "DROP CONSTRAINT "+check, "MODIFY COLUMN "+a.r.column(col), "ADD CONSTRAINT "+check+" CHECK ("+a.r.typeCheck(col)+")")
		}
		for _, f := range sortedBy(dropped[next], func(f ForeignKey) string { return f.Name }) {
			if !pending[f.Table] {
				parts = append(parts, "ADD "+a.r.foreignKey(f))
				added[next+"."+f.Name] = true
			}
		}
		out = append(out, "ALTER TABLE "+q(next)+" "+strings.Join(parts, ", "))
	}
	// 5. A foreign key of a cycle, and one of a table without text storage, is added last.
	owners := make([]string, 0, len(dropped))
	for t := range dropped {
		owners = append(owners, t)
	}
	slices.Sort(owners)
	for _, t := range owners {
		for _, f := range sortedBy(dropped[t], func(f ForeignKey) string { return f.Name }) {
			if !added[t+"."+f.Name] {
				out = append(out, "ALTER TABLE "+q(t)+" ADD "+a.r.foreignKey(f))
			}
		}
	}
	return out, nil
}

// stateColumnOrder is the columns of table t among names, in the order of the state table.
func stateColumnOrder(state *Document, t string, names []string) []string {
	var out []string
	for _, c := range documentTable(state, t).Columns {
		if slices.Contains(names, c.Name) {
			out = append(out, c.Name)
		}
	}
	return out
}

// sqliteConversion is the statements of PLN-110: each table that holds a column in text storage, in name order, is
// rebuilt in its rendered form inside one savepoint.
func (a *applier) sqliteConversion(state *Document, text map[string][]string) ([]string, error) {
	q := a.r.q
	tables := slices.Sorted(maps.Keys(text))
	var out []string
	for _, name := range tables {
		t := documentTable(state, name)
		out = append(out, "SAVEPOINT "+convertSavepoint,
			a.r.createTable(t, rebuildTable, func(c string) string { return rendererName(t.Name, c) }, nil))
		if t.identity() != nil {
			out = append(out, "INSERT INTO sqlite_sequence (name, seq) SELECT '"+rebuildTable+"', seq FROM sqlite_sequence WHERE name = '"+name+"'")
		}
		var into, from []string
		for _, c := range t.Columns {
			into = append(into, q(c.Name))
			if slices.Contains(text[name], c.Name) {
				from = append(from, "unhex(replace("+q(c.Name)+", '-', ''))")
			} else {
				from = append(from, q(c.Name))
			}
		}
		out = append(out,
			"INSERT INTO "+q(rebuildTable)+" ("+strings.Join(into, ", ")+") SELECT "+strings.Join(from, ", ")+" FROM "+q(name),
			"DROP TABLE "+q(name),
			"ALTER TABLE "+q(rebuildTable)+" RENAME TO "+q(name))
		out = append(out, a.r.table(t)[1:]...)
		out = append(out, a.r.triggers(t)...)
		out = append(out, "RELEASE "+convertSavepoint)
	}
	return out, nil
}
