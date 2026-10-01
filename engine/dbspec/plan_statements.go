package dbspec

import (
	"slices"
	"strings"
)

// PlanStatements는 plan의 statement를 dialect로 쓴다(docs/plans.md
// "Statements"). source는 plan이 시작하는 schema이며 빈 database이면 nil이다.
func PlanStatements(source *Document, p *Plan, dialect Dialect) ([]string, []Diagnostic) {
	switch dialect {
	case DialectMySQL, DialectPostgres, DialectSQLite:
	default:
		panic("dbspec: unknown dialect " + string(dialect))
	}
	d, diagnostics := diffPlan(source, p)
	if len(diagnostics) > 0 {
		return nil, diagnostics
	}
	w := &planWriter{d: d, r: renderer{d: dialect, tables: d.target}, rs: renderer{d: dialect, tables: d.source}}
	return w.statements(), nil
}

type planWriter struct {
	d       *planDiff
	r, rs   renderer // target과 source table을 아는 renderer
	out     []string
	rebuilt map[string]bool // SQLite에서 다시 만드는 target table
}

func (w *planWriter) add(s ...string) { w.out = append(w.out, s...) }

func (w *planWriter) q(name string) string { return w.r.q(name) }

func (w *planWriter) statements() []string {
	d, sqlite := w.d, w.r.d == DialectSQLite
	w.rebuilt = map[string]bool{}
	if sqlite {
		for _, name := range d.matched {
			if w.sqliteRebuilds(name) {
				w.rebuilt[name] = true
			}
		}
	}
	// 1. trigger
	for _, name := range d.matched {
		src := d.source[d.tableOf[name]]
		if src.hasTriggers() && (d.triggers[name] || w.rebuilt[name]) {
			w.dropTriggers(src)
		}
	}
	for _, name := range d.dropped {
		if d.source[name].hasTriggers() {
			w.dropTriggers(d.source[name])
		}
	}
	// 2. foreign key, 3. check, unique, index
	if !sqlite {
		for _, s := range sortedKeys(d.dropObjects) {
			for _, o := range d.dropObjects[s] {
				if o.kind == "foreign_key" {
					w.dropObject(s, o)
				}
			}
		}
	}
	for _, s := range sortedKeys(d.dropObjects) {
		if sqlite && (w.rebuilt[w.targetName(s)] || slices.Contains(d.dropped, s)) {
			continue
		}
		for _, o := range d.dropObjects[s] {
			if o.kind != "foreign_key" && !(sqlite && o.kind == "check") {
				w.dropObject(s, o)
			}
		}
	}
	rendererChecks := map[string][2]map[string]string{}
	if !sqlite {
		for _, name := range d.matched {
			src := d.source[d.tableOf[name]]
			before, after := w.rendererChecks(w.rs, src), w.rendererChecks(w.r, d.target[name])
			rendererChecks[name] = [2]map[string]string{before, after}
			for _, n := range sortedKeys(before) {
				if after[n] != before[n] {
					w.add(w.dropCheck(src.Name, n))
				}
			}
		}
	}
	// 4. rename
	for _, r := range sortedBy(d.renamedTables, func(r TableRename) string { return r.Old }) {
		w.add("ALTER TABLE " + w.q(r.Old) + " RENAME TO " + w.q(r.New))
	}
	for _, r := range sortedBy(d.renamedColumns, func(r ColumnRename) string { return r.Table + "." + r.Old }) {
		w.add("ALTER TABLE " + w.q(r.Table) + " RENAME COLUMN " + w.q(r.Old) + " TO " + w.q(r.New))
	}
	// 5. drop column, drop table
	if !sqlite {
		for _, name := range d.matched {
			for _, c := range d.removed[name] {
				w.add("ALTER TABLE " + w.q(name) + " DROP COLUMN " + w.q(c))
			}
		}
	}
	for _, name := range d.dropped {
		w.add("DROP TABLE " + w.q(name))
	}
	// 6. create table
	for _, name := range d.created {
		w.add(w.r.table(d.target[name])...)
	}
	// 7. add, alter column; SQLite rebuild
	for _, name := range d.matched {
		if sqlite {
			if w.rebuilt[name] {
				w.rebuild(name)
			}
			continue
		}
		t := d.target[name]
		for _, c := range d.added[name] {
			w.add("ALTER TABLE " + w.q(name) + " ADD COLUMN " + w.r.column(*columnOf(t, c)))
		}
		for _, c := range d.altered[name] {
			w.alterColumn(name, *columnOf(d.source[d.tableOf[name]], d.columnOf[name][c]), *columnOf(t, c))
		}
	}
	// 8. unique, index, check
	for _, t := range sortedKeys(d.addObjects) {
		if w.rebuilt[t] {
			continue
		}
		for _, o := range d.addObjects[t] {
			if o.kind != "foreign_key" && !(sqlite && o.kind == "check") {
				w.addObject(t, o)
			}
		}
	}
	if !sqlite {
		for _, name := range d.matched {
			before, after := rendererChecks[name][0], rendererChecks[name][1]
			for _, n := range sortedKeys(after) {
				if after[n] != before[n] {
					w.add("ALTER TABLE " + w.q(name) + " ADD CONSTRAINT " + w.q(n) + " CHECK (" + after[n] + ")")
				}
			}
		}
	}
	// 9. foreign key
	if !sqlite {
		for _, name := range d.created {
			for _, f := range sortedBy(d.target[name].ForeignKeys, func(f ForeignKey) string { return f.Name }) {
				w.add("ALTER TABLE " + w.q(name) + " ADD " + w.r.foreignKey(f))
			}
		}
		for _, t := range sortedKeys(d.addObjects) {
			for _, o := range d.addObjects[t] {
				if o.kind == "foreign_key" {
					w.addObject(t, o)
				}
			}
		}
	}
	// 10. trigger
	for _, name := range d.created {
		w.add(w.r.triggers(d.target[name])...)
	}
	for _, name := range d.matched {
		if t := d.target[name]; t.hasTriggers() && (d.triggers[name] || w.rebuilt[name]) {
			w.add(w.r.triggers(t)...)
		}
	}
	return w.out
}

// targetName은 source table의 target 이름이다.
func (w *planWriter) targetName(source string) string {
	for t, s := range w.d.tableOf {
		if s == source {
			return t
		}
	}
	return source
}

// sqliteRebuilds는 SQLite가 table을 다시 만들어야 하는지 알려 준다: 이름,
// column, foreign key, check 중 하나라도 바뀌면 그렇다. index와 unique만
// 바뀌거나 trigger만 바뀌면 다시 만들지 않는다.
func (w *planWriter) sqliteRebuilds(name string) bool {
	d := w.d
	if d.tableOf[name] != name || len(d.added[name]) > 0 || len(d.removed[name]) > 0 || len(d.altered[name]) > 0 {
		return true
	}
	for _, r := range d.renamedColumns {
		if r.Table == name {
			return true
		}
	}
	for _, o := range d.dropObjects[d.tableOf[name]] {
		if o.kind == "foreign_key" || o.kind == "check" {
			return true
		}
	}
	for _, o := range d.addObjects[name] {
		if o.kind == "foreign_key" || o.kind == "check" {
			return true
		}
	}
	return false
}

// rebuild는 SQLite table을 target 정의로 다시 만들고 맞는 column을 옮긴다.
func (w *planWriter) rebuild(name string) {
	d := w.d
	t := d.target[name]
	src := d.source[d.tableOf[name]]
	statements := w.r.table(t)
	create := statements[0]
	prefix := "CREATE TABLE " + w.q(name) + " ("
	w.add("CREATE TABLE " + w.q("$rebuild") + " (" + strings.TrimPrefix(create, prefix))
	var into, from []string
	for _, c := range t.Columns {
		old, ok := d.columnOf[name][c.Name]
		if !ok {
			continue
		}
		into = append(into, w.q(c.Name))
		// rename은 이미 끝났으므로 source column은 target 이름이다.
		from = append(from, w.copyValue(*columnOf(src, old), c))
	}
	w.add("INSERT INTO " + w.q("$rebuild") + " (" + strings.Join(into, ", ") + ") SELECT " + strings.Join(from, ", ") + " FROM " + w.q(name))
	w.add("DROP TABLE " + w.q(name))
	w.add("ALTER TABLE " + w.q("$rebuild") + " RENAME TO " + w.q(name))
	w.add(statements[1:]...)
}

// copyValue는 SQLite rebuild에서 source 값을 target column 형식으로 옮기는 식이다.
// time과 datetime은 늘어난 소수 자리를 0으로 채운다.
func (w *planWriter) copyValue(from, to Column) string {
	q := w.q(to.Name)
	if (to.Type.Kind == TypeTime || to.Type.Kind == TypeDatetime) && to.Type.Precision > from.Type.Precision {
		pad := strings.Repeat("0", to.Type.Precision-from.Type.Precision)
		if from.Type.Precision == 0 {
			pad = "." + pad
		}
		return q + " || '" + pad + "'"
	}
	return q
}

func (w *planWriter) alterColumn(table string, from, to Column) {
	if w.r.d == DialectMySQL {
		w.add("ALTER TABLE " + w.q(table) + " MODIFY COLUMN " + w.r.column(to))
		return
	}
	prefix := "ALTER TABLE " + w.q(table) + " ALTER COLUMN " + w.q(to.Name)
	if from.Type != to.Type {
		w.add(prefix + " TYPE " + w.r.typeText(to.Type))
	}
	if from.Null != to.Null {
		if to.Null {
			w.add(prefix + " DROP NOT NULL")
		} else {
			w.add(prefix + " SET NOT NULL")
		}
	}
	if !sameDefault(from.Default, to.Default) || (to.Default != nil && from.Type != to.Type) {
		if to.Default == nil {
			w.add(prefix + " DROP DEFAULT")
		} else {
			w.add(prefix + " SET DEFAULT " + w.r.defaultText(to.Type, *to.Default))
		}
	}
}

func (w *planWriter) dropTriggers(t *Table) {
	for _, s := range w.rs.triggers(t) {
		if !strings.HasPrefix(s, "CREATE TRIGGER ") {
			continue
		}
		rest := strings.TrimPrefix(s, "CREATE TRIGGER ")
		name := rest[:strings.Index(rest, " ")]
		switch w.r.d {
		case DialectPostgres:
			w.add("DROP TRIGGER "+name+" ON "+w.q(t.Name), "DROP FUNCTION "+name+"()")
		default:
			w.add("DROP TRIGGER " + name)
		}
	}
}

func (w *planWriter) dropCheck(table, name string) string {
	if w.r.d == DialectMySQL {
		return "ALTER TABLE " + w.q(table) + " DROP CHECK " + w.q(name)
	}
	return "ALTER TABLE " + w.q(table) + " DROP CONSTRAINT " + w.q(name)
}

func (w *planWriter) dropObject(table string, o objectRef) {
	switch {
	case o.kind == "check":
		w.add(w.dropCheck(table, o.name))
	case o.kind == "foreign_key" && w.r.d == DialectMySQL:
		w.add("ALTER TABLE " + w.q(table) + " DROP FOREIGN KEY " + w.q(o.name))
	case o.kind == "unique" && w.r.d == DialectMySQL:
		w.add("ALTER TABLE " + w.q(table) + " DROP INDEX " + w.q(o.name))
	case o.kind == "index" && w.r.d == DialectMySQL:
		w.add("DROP INDEX " + w.q(o.name) + " ON " + w.q(table))
	case (o.kind == "foreign_key" || o.kind == "unique") && w.r.d == DialectPostgres:
		w.add("ALTER TABLE " + w.q(table) + " DROP CONSTRAINT " + w.q(o.name))
	default:
		w.add("DROP INDEX " + w.q(o.name))
	}
}

func (w *planWriter) addObject(table string, o objectRef) {
	t := w.d.target[table]
	switch o.kind {
	case "unique":
		u := uniqueOf(t, o.name)
		if w.r.d == DialectSQLite {
			w.add("CREATE UNIQUE INDEX " + w.q(u.Name) + " ON " + w.q(table) + " (" + w.r.list(u.Columns) + ")")
			return
		}
		w.add("ALTER TABLE " + w.q(table) + " ADD CONSTRAINT " + w.q(u.Name) + " UNIQUE (" + w.r.list(u.Columns) + ")")
	case "index":
		x := indexOf(t, o.name)
		columns := make([]string, len(x.Columns))
		for i, c := range x.Columns {
			columns[i] = w.q(c.Name)
			if c.Descending {
				columns[i] += " DESC"
			}
		}
		w.add("CREATE INDEX " + w.q(x.Name) + " ON " + w.q(table) + " (" + strings.Join(columns, ", ") + ")")
	case "check":
		k := checkOf(t, o.name)
		var b strings.Builder
		w.r.predicate(&b, t, k.Expression)
		w.add("ALTER TABLE " + w.q(table) + " ADD CONSTRAINT " + w.q(k.Name) + " CHECK (" + b.String() + ")")
	case "foreign_key":
		w.add("ALTER TABLE " + w.q(table) + " ADD " + w.r.foreignKey(*foreignKeyOf(t, o.name)))
	}
}

// rendererChecks는 table의 renderer CHECK 이름과 식이다.
func (w *planWriter) rendererChecks(r renderer, t *Table) map[string]string {
	out := map[string]string{}
	for _, c := range t.Columns {
		if check := r.typeCheck(c); check != "" {
			out[t.Name+"$"+c.Name] = check
		}
	}
	return out
}
