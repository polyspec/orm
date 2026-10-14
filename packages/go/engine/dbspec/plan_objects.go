package dbspec

import (
	"slices"
	"strings"
)

// objects는 unique, index, foreign key, check를 이름과 정의로 비교한다. source
// 정의는 rename을 적용해 target 이름으로 읽는다(docs/plans.md "Diff").
func (d *planDiff) objects(renamedFrom map[string]string, renamedColumn map[string]map[string]string) {
	targetTable := func(s string) string { return renamedOr(renamedFrom, s) }
	// column rename을 적용한 source 정의
	column := func(target, c string) string { return renamedOr(renamedColumn[target], c) }
	alteredColumn := map[string]bool{} // "table.column" target 이름
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
		// 지우는 index나 unique 위의 foreign key는 MySQL이 그 index를 지우지 못하게
		// 하므로 함께 다시 만든다.
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
		// check: 이름 바뀐 column이나 바뀐 column을 쓰는 check는 다시 만든다.
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
	// 지우는 table을 참조하는 남은 table의 foreign key는 target이 이미 뺐으므로
	// 위에서 지운다. 지우는 table 자신의 foreign key는 table과 함께 지운다.
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

// triggerChanges는 세 dialect 중 하나에서라도 렌더링한 trigger statement가 다른
// table을 표시한다. source는 rename을 적용하기 전 이름 그대로 렌더링한다.
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

// exprColumns는 식이 쓰는 column 이름이다.
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

// exprText는 column 이름을 f로 바꾼 식의 canonical text다.
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
