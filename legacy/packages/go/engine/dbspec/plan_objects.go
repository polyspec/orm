package dbspec

import (
	"slices"
	"strings"
)

// objects compares unique, index, foreign key, and check by name and definition. The source
// definitions are read under the rename, with the target name (docs/spec/plans.md "Diff").
func (d *planDiff) objects(renamedFrom map[string]string, renamedColumn map[string]map[string]string) {
	targetTable := func(s string) string { return renamedOr(renamedFrom, s) }
	// source definition with the column rename applied
	column := func(target, c string) string { return renamedOr(renamedColumn[target], c) }
	alteredColumn := map[string]bool{} // "table.column" target name
	renamedCol := map[string]bool{}
	for t, cols := range d.altered {
		for _, c := range cols {
			alteredColumn[t+"."+c] = true
		}
	}
	for t, m := range renamedColumn {
		for _, c := range m {
			renamedCol[t+"."+c] = true
		}
	}
	for _, name := range d.matched {
		src, tgt := d.source[d.tableOf[name]], d.target[name]
		// A foreign key on an index or unique key that is dropped is recreated together with it, since MySQL will not let
		// that index be dropped while the foreign key depends on it.
		droppedKeys := map[string]bool{}
		// unique
		for _, u := range src.Uniques {
			def := uniqueDef(name, u.Columns, func(c string) string { return column(name, c) })
			if t := uniqueOf(tgt, u.Name); t == nil || uniqueDef(name, t.Columns, func(c string) string { return c }) != def {
				d.dropObjects[src.Name] = append(d.dropObjects[src.Name], objectRef{"unique", u.Name})
				droppedKeys[strings.Join(mapNames(u.Columns, func(c string) string { return column(name, c) }), ",")] = true
			}
		}
		for _, u := range tgt.Uniques {
			s := uniqueOf(src, u.Name)
			if s == nil || uniqueDef(name, s.Columns, func(c string) string { return column(name, c) }) != uniqueDef(name, u.Columns, func(c string) string { return c }) {
				d.addObjects[name] = append(d.addObjects[name], objectRef{"unique", u.Name})
			}
		}
		// index
		for _, x := range src.Indexes {
			t := indexOf(tgt, x.Name)
			if t == nil || indexDef(x, func(c string) string { return column(name, c) }) != indexDef(*t, func(c string) string { return c }) {
				d.dropObjects[src.Name] = append(d.dropObjects[src.Name], objectRef{"index", x.Name})
				var cols []string
				for _, c := range x.Columns {
					cols = append(cols, column(name, c.Name))
				}
				droppedKeys[strings.Join(cols, ",")] = true
			}
		}
		for _, x := range tgt.Indexes {
			s := indexOf(src, x.Name)
			if s == nil || indexDef(*s, func(c string) string { return column(name, c) }) != indexDef(x, func(c string) string { return c }) {
				d.addObjects[name] = append(d.addObjects[name], objectRef{"index", x.Name})
			}
		}
		// foreign key
		forcedFK := func(f ForeignKey, child string, cols []string, parent string, refs []string) bool {
			for _, c := range cols {
				if alteredColumn[child+"."+c] {
					return true
				}
			}
			for _, c := range refs {
				if alteredColumn[parent+"."+c] {
					return true
				}
			}
			for k := range droppedKeys {
				if strings.HasPrefix(k+",", strings.Join(cols, ",")+",") {
					return true
				}
			}
			return false
		}
		for _, f := range src.ForeignKeys {
			parent := targetTable(f.Table)
			cols := mapNames(f.Columns, func(c string) string { return column(name, c) })
			refs := mapNames(f.References, func(c string) string { return column(parent, c) })
			t := foreignKeyOf(tgt, f.Name)
			if t == nil || foreignKeyDef(cols, parent, refs, f) != foreignKeyDef(t.Columns, t.Table, t.References, *t) || forcedFK(f, name, cols, parent, refs) {
				d.dropObjects[src.Name] = append(d.dropObjects[src.Name], objectRef{"foreign_key", f.Name})
			}
		}
		for _, f := range tgt.ForeignKeys {
			s := foreignKeyOf(src, f.Name)
			keep := false
			if s != nil {
				parent := targetTable(s.Table)
				cols := mapNames(s.Columns, func(c string) string { return column(name, c) })
				refs := mapNames(s.References, func(c string) string { return column(parent, c) })
				keep = foreignKeyDef(cols, parent, refs, *s) == foreignKeyDef(f.Columns, f.Table, f.References, f) && !forcedFK(f, name, cols, parent, refs)
			}
			if !keep {
				d.addObjects[name] = append(d.addObjects[name], objectRef{"foreign_key", f.Name})
			}
		}
		// check: a check on a renamed column, or on a changed column, is recreated.
		forcedCheck := func(k Check) bool {
			for _, c := range exprColumns(k.Expression) {
				if renamedCol[name+"."+c] || alteredColumn[name+"."+c] {
					return true
				}
			}
			return false
		}
		for _, k := range src.Checks {
			t := checkOf(tgt, k.Name)
			if t == nil || exprText(k.Expression, func(c string) string { return column(name, c) }) != exprText(t.Expression, func(c string) string { return c }) || forcedCheck(*t) {
				d.dropObjects[src.Name] = append(d.dropObjects[src.Name], objectRef{"check", k.Name})
			}
		}
		for _, k := range tgt.Checks {
			s := checkOf(src, k.Name)
			if s == nil || exprText(s.Expression, func(c string) string { return column(name, c) }) != exprText(k.Expression, func(c string) string { return c }) || forcedCheck(k) {
				d.addObjects[name] = append(d.addObjects[name], objectRef{"check", k.Name})
			}
		}
	}
	// A remaining table's foreign key that refers to a table being dropped is already removed by the target,
	// so it is dropped above. A dropped table's own foreign keys are dropped with the table.
	for _, name := range d.dropped {
		for _, f := range d.source[name].ForeignKeys {
			d.dropObjects[name] = append(d.dropObjects[name], objectRef{"foreign_key", f.Name})
		}
	}
	for k := range d.dropObjects {
		slices.SortFunc(d.dropObjects[k], compareRef)
	}
	for k := range d.addObjects {
		slices.SortFunc(d.addObjects[k], compareRef)
	}
}

func compareRef(a, b objectRef) int {
	return strings.Compare(a.kind+"\x00"+a.name, b.kind+"\x00"+b.name)
}

// triggerChanges marks the tables whose rendered trigger statements differ in any one of the three dialects.
// The source is rendered with its name as it was before the rename is applied.
func (d *planDiff) triggerChanges(renamedFrom map[string]string, renamedColumn map[string]map[string]string) {
	for _, name := range d.matched {
		src, tgt := d.source[d.tableOf[name]], d.target[name]
		for _, dialect := range []Dialect{DialectMySQL, DialectPostgres, DialectSQLite} {
			r := renderer{d: dialect}
			if !slices.Equal(r.triggers(src), r.triggers(tgt)) {
				d.triggers[name] = true
				break
			}
		}
	}
}

func (d *planDiff) collectChanges() {
	add := func(kind, table, name string) {
		d.changes = append(d.changes, Change{Kind: kind, Table: table, Name: name})
	}
	for _, name := range d.matched {
		if d.triggers[name] && d.source[d.tableOf[name]].hasTriggers() {
			add("drop_triggers", d.tableOf[name], "")
		}
	}
	for _, s := range sortedKeys(d.dropObjects) {
		for _, o := range d.dropObjects[s] {
			add("drop_"+o.kind, s, o.name)
		}
	}
	for _, r := range sortedBy(d.renamedTables, func(r TableRename) string { return r.Old }) {
		add("rename_table", r.Old, r.New)
	}
	for _, r := range sortedBy(d.renamedColumns, func(r ColumnRename) string { return r.Table + "." + r.Old }) {
		add("rename_column", r.Table, r.Old+" "+r.New)
	}
	for _, name := range d.matched {
		for _, c := range d.removed[name] {
			add("drop_column", d.tableOf[name], c)
		}
	}
	for _, name := range d.dropped {
		add("drop_table", name, "")
	}
	for _, name := range d.created {
		add("create_table", name, "")
	}
	for _, name := range d.matched {
		for _, c := range d.added[name] {
			add("add_column", name, c)
		}
		for _, c := range d.altered[name] {
			add("alter_column", name, c)
		}
	}
	for _, t := range sortedKeys(d.addObjects) {
		for _, o := range d.addObjects[t] {
			add("add_"+o.kind, t, o.name)
		}
	}
	for _, name := range d.matched {
		if d.triggers[name] && d.target[name].hasTriggers() {
			add("create_triggers", name, "")
		}
	}
}

func (t *Table) hasTriggers() bool {
	return t.Settings != nil && (t.Settings.Immutable != nil || t.Settings.Audit != nil)
}

func mapNames(names []string, f func(string) string) []string {
	out := make([]string, len(names))
	for i, n := range names {
		out[i] = f(n)
	}
	return out
}

func uniqueDef(table string, cols []string, f func(string) string) string {
	return strings.Join(mapNames(cols, f), ",")
}

func indexDef(x Index, f func(string) string) string {
	var b strings.Builder
	for _, c := range x.Columns {
		b.WriteString(f(c.Name))
		if c.Descending {
			b.WriteString(" desc")
		}
		b.WriteString(",")
	}
	return b.String()
}

func foreignKeyDef(cols []string, parent string, refs []string, f ForeignKey) string {
	return strings.Join(cols, ",") + ">" + parent + "(" + strings.Join(refs, ",") + ")" + string(f.OnDelete) + "/" + string(f.OnUpdate)
}

func uniqueOf(t *Table, name string) *Unique {
	for i := range t.Uniques {
		if t.Uniques[i].Name == name {
			return &t.Uniques[i]
		}
	}
	return nil
}

func indexOf(t *Table, name string) *Index {
	for i := range t.Indexes {
		if t.Indexes[i].Name == name {
			return &t.Indexes[i]
		}
	}
	return nil
}

func foreignKeyOf(t *Table, name string) *ForeignKey {
	for i := range t.ForeignKeys {
		if t.ForeignKeys[i].Name == name {
			return &t.ForeignKeys[i]
		}
	}
	return nil
}

func checkOf(t *Table, name string) *Check {
	for i := range t.Checks {
		if t.Checks[i].Name == name {
			return &t.Checks[i]
		}
	}
	return nil
}

// exprColumns is the column names the expression uses.
func exprColumns(e Expr) []string {
	switch e := e.(type) {
	case ColumnRef:
		return []string{e.Name}
	case Binary:
		return append(exprColumns(e.Left), exprColumns(e.Right)...)
	case In:
		return exprColumns(e.Operand)
	case IsNull:
		return exprColumns(e.Operand)
	}
	return nil
}

// exprText is the canonical text of the expression, with its column names changed by f.
func exprText(e Expr, f func(string) string) string {
	var b strings.Builder
	writeExpr(&b, renameExpr(e, f))
	return b.String()
}

func renameExpr(e Expr, f func(string) string) Expr {
	switch e := e.(type) {
	case ColumnRef:
		e.Name = f(e.Name)
		return e
	case Binary:
		e.Left, e.Right = renameExpr(e.Left, f), renameExpr(e.Right, f)
		return e
	case In:
		e.Operand = renameExpr(e.Operand, f)
		return e
	case IsNull:
		e.Operand = renameExpr(e.Operand, f)
		return e
	}
	return e
}
