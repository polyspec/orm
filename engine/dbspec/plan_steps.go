package dbspec

import (
	"slices"
	"strconv"
	"strings"
)

// PlanStep은 plan의 step 하나다(docs/plans.md "Steps"). Rollback이 비어 있으면
// finalize step이거나 Irreversible이 그 이유를 적는다.
type PlanStep struct {
	Statement    string
	Rollback     string
	Irreversible string
	Effect       Effect
	// Restore와 RollbackRestore는 RestoreIf가 참일 때 Statement와 Rollback 대신 실행하는
	// statement다(rollback이 숨긴 더한 column이 table에 있을 때).
	Restore         string
	RollbackRestore string
	RestoreIf       Effect
	NullChecks      []NullCheck
	Finalize        bool
}

// Effect는 statement가 효과를 냈는지 catalog나 table에서 읽는 방법이다. Kind는
// table, column, index, constraint, trigger, function, sequence, rows, repeat 중
// 하나다. Present는 statement 뒤의 상태다.
type Effect struct {
	Kind    string
	Table   string
	Name    string
	Present bool
}

// String은 docs/plans.md "Effects"의 text 형식이다.
func (e Effect) String() string {
	if e.Kind == "repeat" {
		return "repeat"
	}
	state := "absent"
	if e.Present {
		state = "present"
	}
	s := state + " " + e.Kind
	for _, n := range []string{e.Table, e.Name} {
		if n != "" {
			s += " " + n
		}
	}
	return s
}

// NullCheck는 rollback이 다시 non-null로 만드는 column이다. Column은 적용한 plan에서의
// 이름이고, HasDefault이면 Default가 source default의 SQL text다.
type NullCheck struct {
	Table      string
	Column     string
	Default    string
	HasDefault bool
}

// 되돌릴 수 없는 step의 이유(docs/plans.md "Irreversible steps").
const irreversiblePrecision = "narrowing the precision rounds the values written since"

// rebuildTable은 SQLite 다시 만들기의 작업 table이다.
const rebuildTable = "dbspec$rebuild"

// PlanSteps는 plan의 step을 dialect로 쓴다(docs/plans.md "Steps"). source는 plan이
// 시작하는 schema이며 빈 database이면 nil이다.
func PlanSteps(source *Document, p *Plan, dialect Dialect) ([]PlanStep, []Diagnostic) {
	switch dialect {
	case DialectMySQL, DialectPostgres, DialectSQLite:
	default:
		panic("dbspec: unknown dialect " + string(dialect))
	}
	d, diagnostics := diffPlan(source, p)
	if len(diagnostics) > 0 {
		return nil, diagnostics
	}
	w := &planWriter{d: d, r: renderer{d: dialect}, holdPrefix: "dbspec$hold$" + strings.TrimPrefix(p.To, "sha256:")[:12] + "$"}
	return w.steps(), nil
}

type planWriter struct {
	d          *planDiff
	r          renderer
	out        []PlanStep
	rebuilt    map[string]bool // SQLite에서 다시 만드는 target table
	holdPrefix string
	// 보관 이름: "table.column"(지우는 column, source table과 column 이름),
	// table(지우는 table), "+table.column"(더하는 column, target 이름)
	holds     map[string]string
	holdOrder []string
}

func (w *planWriter) add(s PlanStep) { w.out = append(w.out, s) }

func (w *planWriter) q(name string) string { return w.r.q(name) }

func present(kind, table, name string) Effect { return Effect{kind, table, name, true} }
func absent(kind, table, name string) Effect  { return Effect{kind, table, name, false} }

var repeat = Effect{Kind: "repeat"}

func (w *planWriter) hold(key string) string { return w.holds[key] }

// numberHolds는 docs/plans.md "Hiding instead of dropping"의 순서로 보관 이름을 정한다.
func (w *planWriter) numberHolds() {
	d := w.d
	w.holds = map[string]string{}
	n := 0
	next := func(key string) {
		n++
		w.holds[key] = w.holdPrefix + strconv.Itoa(n)
		w.holdOrder = append(w.holdOrder, key)
	}
	for _, name := range d.matched {
		for _, c := range d.removed[name] {
			next(d.tableOf[name] + "." + c)
		}
	}
	for _, name := range d.dropped {
		next(name)
	}
	for _, name := range d.matched {
		for _, c := range d.added[name] {
			next("+" + name + "." + c)
		}
	}
}

func (w *planWriter) steps() []PlanStep {
	d, sqlite := w.d, w.r.d == DialectSQLite
	w.numberHolds()
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
	// 2. foreign key
	if !sqlite {
		for _, s := range sortedKeys(d.dropObjects) {
			for _, o := range d.dropObjects[s] {
				if o.kind == "foreign_key" {
					w.dropObject(d.source[s], o)
				}
			}
		}
	}
	// 3. check, unique, index와 지우는 table의 객체
	dropTables := map[string][]objectRef{}
	for s, objects := range d.dropObjects {
		if sqlite && (w.rebuilt[w.targetName(s)] || slices.Contains(d.dropped, s)) {
			continue
		}
		for _, o := range objects {
			if o.kind != "foreign_key" && !(sqlite && o.kind == "check") {
				dropTables[s] = append(dropTables[s], o)
			}
		}
	}
	for _, s := range d.dropped {
		t := d.source[s]
		for _, u := range t.Uniques {
			dropTables[s] = append(dropTables[s], objectRef{"unique", u.Name})
		}
		for _, x := range t.Indexes {
			dropTables[s] = append(dropTables[s], objectRef{"index", x.Name})
		}
		if !sqlite {
			for _, k := range t.Checks {
				dropTables[s] = append(dropTables[s], objectRef{"check", k.Name})
			}
		}
	}
	for _, s := range sortedKeys(dropTables) {
		objects := dropTables[s]
		slices.SortFunc(objects, compareRef)
		for _, o := range objects {
			w.dropObject(d.source[s], o)
		}
	}
	rendererChecks := map[string][2]map[string]string{}
	if !sqlite {
		for _, name := range d.matched {
			src := d.source[d.tableOf[name]]
			before, after := w.rendererChecks(src), w.rendererChecks(d.target[name])
			rendererChecks[name] = [2]map[string]string{before, after}
			for _, n := range sortedKeys(before) {
				if after[n] != before[n] {
					w.dropRendererCheck(src.Name, n, before[n])
				}
			}
		}
		for _, s := range d.dropped {
			before := w.rendererChecks(d.source[s])
			for _, n := range sortedKeys(before) {
				w.dropRendererCheck(s, n, before[n])
			}
		}
	}
	// 4. rename
	for _, r := range sortedBy(d.renamedTables, func(r TableRename) string { return r.Old }) {
		w.add(PlanStep{
			Statement: "ALTER TABLE " + w.q(r.Old) + " RENAME TO " + w.q(r.New),
			Rollback:  "ALTER TABLE " + w.q(r.New) + " RENAME TO " + w.q(r.Old),
			Effect:    present("table", r.New, ""),
		})
	}
	for _, r := range sortedBy(d.renamedColumns, func(r ColumnRename) string { return r.Table + "." + r.Old }) {
		w.add(PlanStep{
			Statement: w.renameColumn(r.Table, r.Old, r.New),
			Rollback:  w.renameColumn(r.Table, r.New, r.Old),
			Effect:    present("column", r.Table, r.New),
		})
	}
	// 5. 지우는 column과 table을 숨긴다
	if !sqlite {
		for _, name := range d.matched {
			src := d.source[d.tableOf[name]]
			for _, c := range d.removed[name] {
				w.hideColumn(name, *columnOf(src, c), w.hold(src.Name+"."+c))
			}
		}
	}
	for _, name := range d.dropped {
		h := w.hold(name)
		w.add(PlanStep{
			Statement: "ALTER TABLE " + w.q(name) + " RENAME TO " + w.q(h),
			Rollback:  "ALTER TABLE " + w.q(h) + " RENAME TO " + w.q(name),
			Effect:    present("table", h, ""),
		})
	}
	// 6. create table
	for _, name := range d.created {
		t := d.target[name]
		w.add(PlanStep{
			Statement: w.r.table(t)[0],
			Rollback:  "DROP TABLE " + w.q(name),
			Effect:    present("table", name, ""),
		})
		w.createIndexes(t, name)
	}
	// 7. add, alter column; SQLite 다시 만들기
	for _, name := range d.matched {
		if sqlite {
			if w.rebuilt[name] {
				w.rebuild(name)
			}
			continue
		}
		t := d.target[name]
		src := d.source[d.tableOf[name]]
		for _, c := range d.added[name] {
			h := w.hold("+" + name + "." + c)
			w.add(PlanStep{
				Statement: "ALTER TABLE " + w.q(name) + " ADD COLUMN " + w.r.column(*columnOf(t, c)),
				Rollback:  w.renameColumn(name, c, h),
				Effect:    present("column", name, c),
				Restore:   w.renameColumn(name, h, c),
				RestoreIf: present("column", name, h),
			})
		}
		for _, c := range d.altered[name] {
			w.alterColumn(name, *columnOf(src, d.columnOf[name][c]), *columnOf(t, c))
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
					w.add(PlanStep{
						Statement: "ALTER TABLE " + w.q(name) + " ADD CONSTRAINT " + w.q(n) + " CHECK (" + after[n] + ")",
						Rollback:  w.dropCheck(name, n),
						Effect:    present("constraint", name, n),
					})
				}
			}
		}
	}
	// 9. foreign key
	if !sqlite {
		for _, name := range d.created {
			for _, f := range sortedBy(d.target[name].ForeignKeys, func(f ForeignKey) string { return f.Name }) {
				w.addForeignKey(name, f)
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
		w.createTriggers(d.target[name])
	}
	for _, name := range d.matched {
		if t := d.target[name]; t.hasTriggers() && (d.triggers[name] || w.rebuilt[name]) {
			w.createTriggers(t)
		}
	}
	// 11. finalize
	for _, key := range w.holdOrder {
		h := w.holds[key]
		switch {
		case strings.HasPrefix(key, "+"):
		case strings.Contains(key, "."):
			source, _, _ := strings.Cut(key, ".")
			table := w.targetName(source)
			w.add(PlanStep{Statement: "ALTER TABLE " + w.q(table) + " DROP COLUMN " + w.q(h), Effect: absent("column", table, h), Finalize: true})
		default:
			w.add(PlanStep{Statement: "DROP TABLE " + w.q(h), Effect: absent("table", h, ""), Finalize: true})
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

func (w *planWriter) renameColumn(table, from, to string) string {
	return "ALTER TABLE " + w.q(table) + " RENAME COLUMN " + w.q(from) + " TO " + w.q(to)
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

// hideColumn은 MySQL과 PostgreSQL에서 지우는 column을 nullable로 바꾸고 보관
// 이름으로 숨긴다.
func (w *planWriter) hideColumn(table string, c Column, h string) {
	if !c.Null {
		nullable := c
		nullable.Null = true
		step := PlanStep{Effect: repeat, NullChecks: []NullCheck{w.nullCheck(table, h, c)}}
		if w.r.d == DialectMySQL {
			step.Statement = "ALTER TABLE " + w.q(table) + " MODIFY COLUMN " + w.r.column(nullable)
			step.Rollback = "ALTER TABLE " + w.q(table) + " MODIFY COLUMN " + w.r.column(c)
		} else {
			prefix := "ALTER TABLE " + w.q(table) + " ALTER COLUMN " + w.q(c.Name)
			step.Statement, step.Rollback = prefix+" DROP NOT NULL", prefix+" SET NOT NULL"
		}
		w.add(step)
	}
	w.add(PlanStep{
		Statement: w.renameColumn(table, c.Name, h),
		Rollback:  w.renameColumn(table, h, c.Name),
		Effect:    present("column", table, h),
	})
}

// nullCheck는 source column c를 non-null로 되돌리는 rollback의 null 검사다.
func (w *planWriter) nullCheck(table, column string, c Column) NullCheck {
	check := NullCheck{Table: table, Column: column}
	if c.Default != nil {
		check.Default, check.HasDefault = w.r.defaultText(c.Type, *c.Default), true
	}
	return check
}

// precisionGrows는 time이나 datetime의 정밀도가 커지는지 알려 준다.
func precisionGrows(from, to Type) bool {
	return (to.Kind == TypeTime || to.Kind == TypeDatetime) && to.Precision > from.Precision
}

// rebuild는 SQLite table을 작업 table을 거쳐 다시 만든다(docs/plans.md "Steps").
func (w *planWriter) rebuild(name string) {
	d := w.d
	t := d.target[name]
	src := d.source[d.tableOf[name]]
	q := w.q
	work := q(rebuildTable)
	// 새 정의: target table과 보관 이름의 지우는 column
	var hiddenDropped []Column
	for _, c := range d.removed[name] {
		col := *columnOf(src, c)
		col.Name = w.hold(src.Name + "." + c)
		hiddenDropped = append(hiddenDropped, col)
	}
	// 옛 정의: 이름 바꾸기를 적용한 source table과 보관 이름의 더하는 column
	old := w.renamedSource(name)
	var hiddenAdded []Column
	for _, c := range d.added[name] {
		col := *columnOf(t, c)
		col.Name = w.hold("+" + name + "." + c)
		hiddenAdded = append(hiddenAdded, col)
	}
	newCreate := func(as string) string {
		return w.r.createTable(t, as, func(c string) string { return t.Name + "$" + c }, hiddenDropped)
	}
	// sourceColumn은 옛 정의 column의 source 이름이다. 지우는 column은 이름이 그대로다.
	sourceColumn := func(c string) string {
		if s, ok := d.columnOf[name][c]; ok {
			return s
		}
		return c
	}
	oldCreate := w.r.createTable(old, name, func(c string) string { return src.Name + "$" + sourceColumn(c) }, hiddenAdded)
	newColumns := make([]string, 0, len(t.Columns)+len(hiddenDropped))
	for _, c := range t.Columns {
		newColumns = append(newColumns, c.Name)
	}
	for _, c := range hiddenDropped {
		newColumns = append(newColumns, c.Name)
	}
	newList := w.r.list(newColumns)
	// 옛 table에서 새 정의로 옮기는 식
	var into, from, intoRestore, fromRestore []string
	for _, c := range t.Columns {
		old, ok := d.columnOf[name][c.Name]
		if ok {
			e := w.copyValue(*columnOf(src, old), c)
			into, from = append(into, q(c.Name)), append(from, e)
			intoRestore, fromRestore = append(intoRestore, q(c.Name)), append(fromRestore, e)
		} else {
			intoRestore = append(intoRestore, q(c.Name))
			fromRestore = append(fromRestore, q(w.hold("+"+name+"."+c.Name)))
		}
	}
	for i, c := range d.removed[name] {
		into, from = append(into, q(hiddenDropped[i].Name)), append(from, q(c))
		intoRestore, fromRestore = append(intoRestore, q(hiddenDropped[i].Name)), append(fromRestore, q(c))
	}
	// 새 정의에서 옛 정의로 되돌리는 식
	var backInto, backFrom []string
	irreversible := ""
	var checks []NullCheck
	for _, c := range old.Columns {
		backInto = append(backInto, q(c.Name))
		sourceName := sourceColumn(c.Name)
		if tc := columnOf(t, c.Name); tc != nil && !slices.Contains(d.removed[name], sourceName) {
			backFrom = append(backFrom, q(c.Name))
			if precisionGrows(c.Type, tc.Type) {
				irreversible = irreversiblePrecision
			}
			if !c.Null && tc.Null {
				checks = append(checks, w.nullCheck(name, c.Name, c))
			}
			continue
		}
		// 지우는 column: 새 정의에서는 보관 이름이다.
		h := w.hold(src.Name + "." + sourceName)
		backFrom = append(backFrom, q(h))
		if !c.Null {
			checks = append(checks, w.nullCheck(name, h, c))
		}
	}
	// 옛 table에 숨긴 더한 column이 있으면 그 값도 되돌린다.
	backIntoRestore, backFromRestore := slices.Clone(backInto), slices.Clone(backFrom)
	for i, c := range d.added[name] {
		backIntoRestore, backFromRestore = append(backIntoRestore, q(hiddenAdded[i].Name)), append(backFromRestore, q(c))
	}
	identity := t.identity() != nil
	sequence := func(to, from string) string {
		return "INSERT INTO sqlite_sequence (name, seq) SELECT '" + to + "', seq FROM sqlite_sequence WHERE name = '" + from + "'"
	}
	unsequence := func(n string) string { return "DELETE FROM sqlite_sequence WHERE name = '" + n + "'" }

	w.add(PlanStep{Statement: newCreate(rebuildTable), Rollback: "DROP TABLE " + work, Effect: present("table", rebuildTable, "")})
	if identity {
		w.add(PlanStep{Statement: sequence(rebuildTable, name), Rollback: unsequence(rebuildTable), Effect: present("sequence", rebuildTable, "")})
	}
	copyIn := PlanStep{
		Statement: "INSERT INTO " + work + " (" + strings.Join(into, ", ") + ") SELECT " + strings.Join(from, ", ") + " FROM " + q(name),
		Rollback:  "DELETE FROM " + work,
		Effect:    present("rows", rebuildTable, ""),
	}
	if len(hiddenAdded) > 0 {
		copyIn.Restore = "INSERT INTO " + work + " (" + strings.Join(intoRestore, ", ") + ") SELECT " + strings.Join(fromRestore, ", ") + " FROM " + q(name)
		copyIn.RestoreIf = present("column", name, hiddenAdded[0].Name)
	}
	w.add(copyIn)
	for _, x := range w.indexes(old, name) {
		w.add(PlanStep{Statement: x.drop, Rollback: x.create, Effect: absent("index", name, x.name)})
	}
	empty := PlanStep{Statement: "DELETE FROM " + q(name), Effect: absent("rows", name, ""), NullChecks: checks}
	if irreversible != "" {
		empty.Irreversible = irreversible
	} else {
		empty.Rollback = "INSERT INTO " + q(name) + " (" + strings.Join(backInto, ", ") + ") SELECT " + strings.Join(backFrom, ", ") + " FROM " + work
		if len(hiddenAdded) > 0 {
			empty.RollbackRestore = "INSERT INTO " + q(name) + " (" + strings.Join(backIntoRestore, ", ") + ") SELECT " + strings.Join(backFromRestore, ", ") + " FROM " + work
			empty.RestoreIf = present("column", name, hiddenAdded[0].Name)
		}
	}
	w.add(empty)
	if identity {
		w.add(PlanStep{Statement: unsequence(name), Rollback: sequence(name, rebuildTable), Effect: absent("sequence", name, "")})
	}
	w.add(PlanStep{Statement: "DROP TABLE " + q(name), Rollback: oldCreate, Effect: absent("table", name, "")})
	w.add(PlanStep{Statement: newCreate(name), Rollback: "DROP TABLE " + q(name), Effect: present("table", name, "")})
	if identity {
		w.add(PlanStep{Statement: sequence(name, rebuildTable), Rollback: unsequence(name), Effect: present("sequence", name, "")})
	}
	w.add(PlanStep{
		Statement: "INSERT INTO " + q(name) + " (" + newList + ") SELECT " + newList + " FROM " + work,
		Rollback:  "DELETE FROM " + q(name),
		Effect:    present("rows", name, ""),
	})
	w.add(PlanStep{
		Statement: "DELETE FROM " + work,
		Rollback:  "INSERT INTO " + work + " (" + newList + ") SELECT " + newList + " FROM " + q(name),
		Effect:    absent("rows", rebuildTable, ""),
	})
	if identity {
		w.add(PlanStep{Statement: unsequence(rebuildTable), Rollback: sequence(rebuildTable, name), Effect: absent("sequence", rebuildTable, "")})
	}
	w.add(PlanStep{Statement: "DROP TABLE " + work, Rollback: newCreate(rebuildTable), Effect: absent("table", rebuildTable, "")})
	w.createIndexes(t, name)
}

// renamedSource는 target table name의 source table에 이름 바꾸기를 적용한 정의다.
// 지우는 table을 참조하는 foreign key는 source 이름을 유지한다.
func (w *planWriter) renamedSource(name string) *Table {
	d := w.d
	src := d.source[d.tableOf[name]]
	targetOfTable := map[string]string{}
	for t, s := range d.tableOf {
		targetOfTable[s] = t
	}
	column := func(table, c string) string {
		for tc, sc := range d.columnOf[table] {
			if sc == c {
				return tc
			}
		}
		return c
	}
	t := *src
	t.Name = name
	t.Columns = slices.Clone(src.Columns)
	for i := range t.Columns {
		t.Columns[i].Name = column(name, t.Columns[i].Name)
	}
	rename := func(cols []string) []string { return mapNames(cols, func(c string) string { return column(name, c) }) }
	t.PrimaryKey.Columns = rename(src.PrimaryKey.Columns)
	t.Uniques = nil
	for _, u := range src.Uniques {
		u.Columns = rename(u.Columns)
		t.Uniques = append(t.Uniques, u)
	}
	t.Indexes = nil
	for _, x := range src.Indexes {
		cols := make([]IndexColumn, len(x.Columns))
		for i, c := range x.Columns {
			cols[i] = IndexColumn{Name: column(name, c.Name), Descending: c.Descending}
		}
		x.Columns = cols
		t.Indexes = append(t.Indexes, x)
	}
	t.ForeignKeys = nil
	for _, f := range src.ForeignKeys {
		parent := f.Table
		if n, ok := targetOfTable[f.Table]; ok {
			parent = n
		}
		f.Columns = rename(f.Columns)
		f.References = mapNames(f.References, func(c string) string { return column(parent, c) })
		f.Table = parent
		t.ForeignKeys = append(t.ForeignKeys, f)
	}
	t.Checks = nil
	for _, k := range src.Checks {
		k.Expression = renameExpr(k.Expression, func(c string) string { return column(name, c) })
		t.Checks = append(t.Checks, k)
	}
	return &t
}

// copyValue는 SQLite 다시 만들기에서 source 값을 target column 형식으로 옮기는 식이다.
// time과 datetime은 늘어난 소수 자리를 0으로 채운다.
func (w *planWriter) copyValue(from, to Column) string {
	q := w.q(to.Name)
	if precisionGrows(from.Type, to.Type) {
		pad := strings.Repeat("0", to.Type.Precision-from.Type.Precision)
		if from.Type.Precision == 0 {
			pad = "." + pad
		}
		return q + " || '" + pad + "'"
	}
	return q
}

func (w *planWriter) alterColumn(table string, from, to Column) {
	irreversible := ""
	if precisionGrows(from.Type, to.Type) {
		irreversible = irreversiblePrecision
	}
	source := from
	source.Name = to.Name
	var checks []NullCheck
	if !from.Null && to.Null {
		checks = []NullCheck{w.nullCheck(table, to.Name, source)}
	}
	if w.r.d == DialectMySQL {
		step := PlanStep{
			Statement:  "ALTER TABLE " + w.q(table) + " MODIFY COLUMN " + w.r.column(to),
			Effect:     repeat,
			NullChecks: checks,
		}
		if irreversible != "" {
			step.Irreversible = irreversible
		} else {
			step.Rollback = "ALTER TABLE " + w.q(table) + " MODIFY COLUMN " + w.r.column(source)
		}
		w.add(step)
		return
	}
	prefix := "ALTER TABLE " + w.q(table) + " ALTER COLUMN " + w.q(to.Name)
	if from.Type != to.Type {
		step := PlanStep{Statement: prefix + " TYPE " + w.r.typeText(to.Type), Effect: repeat}
		if irreversible != "" {
			step.Irreversible = irreversible
		} else {
			step.Rollback = prefix + " TYPE " + w.r.typeText(from.Type)
		}
		w.add(step)
	}
	if from.Null != to.Null {
		if to.Null {
			w.add(PlanStep{Statement: prefix + " DROP NOT NULL", Rollback: prefix + " SET NOT NULL", Effect: repeat, NullChecks: checks})
		} else {
			w.add(PlanStep{Statement: prefix + " SET NOT NULL", Rollback: prefix + " DROP NOT NULL", Effect: repeat})
		}
	}
	if !sameDefault(from.Default, to.Default) || (to.Default != nil && from.Type != to.Type) {
		back := prefix + " DROP DEFAULT"
		if from.Default != nil {
			back = prefix + " SET DEFAULT " + w.r.defaultText(from.Type, *from.Default)
		}
		forward := prefix + " DROP DEFAULT"
		if to.Default != nil {
			forward = prefix + " SET DEFAULT " + w.r.defaultText(to.Type, *to.Default)
		}
		w.add(PlanStep{Statement: forward, Rollback: back, Effect: repeat})
	}
}

// triggerParts는 렌더링한 trigger statement에서 trigger와 PostgreSQL function을 짝짓는다.
type triggerPart struct {
	name, create, function string
}

func (w *planWriter) triggerParts(t *Table) []triggerPart {
	var out []triggerPart
	function := ""
	for _, s := range w.r.triggers(t) {
		if strings.HasPrefix(s, "CREATE FUNCTION ") {
			function = s
			continue
		}
		rest := strings.TrimPrefix(s, "CREATE TRIGGER ")
		quoted := rest[:strings.Index(rest, " ")]
		out = append(out, triggerPart{name: quoted[1 : len(quoted)-1], create: s, function: function})
		function = ""
	}
	return out
}

func (w *planWriter) dropTriggers(t *Table) {
	for _, p := range w.triggerParts(t) {
		if w.r.d == DialectPostgres {
			w.add(PlanStep{Statement: "DROP TRIGGER " + w.q(p.name) + " ON " + w.q(t.Name), Rollback: p.create, Effect: absent("trigger", t.Name, p.name)})
			w.add(PlanStep{Statement: "DROP FUNCTION " + w.q(p.name) + "()", Rollback: p.function, Effect: absent("function", "", p.name)})
			continue
		}
		w.add(PlanStep{Statement: "DROP TRIGGER " + w.q(p.name), Rollback: p.create, Effect: absent("trigger", t.Name, p.name)})
	}
}

func (w *planWriter) createTriggers(t *Table) {
	for _, p := range w.triggerParts(t) {
		if w.r.d == DialectPostgres {
			w.add(PlanStep{Statement: p.function, Rollback: "DROP FUNCTION " + w.q(p.name) + "()", Effect: present("function", "", p.name)})
			w.add(PlanStep{Statement: p.create, Rollback: "DROP TRIGGER " + w.q(p.name) + " ON " + w.q(t.Name), Effect: present("trigger", t.Name, p.name)})
			continue
		}
		w.add(PlanStep{Statement: p.create, Rollback: "DROP TRIGGER " + w.q(p.name), Effect: present("trigger", t.Name, p.name)})
	}
}

func (w *planWriter) dropCheck(table, name string) string {
	if w.r.d == DialectMySQL {
		return "ALTER TABLE " + w.q(table) + " DROP CHECK " + w.q(name)
	}
	return "ALTER TABLE " + w.q(table) + " DROP CONSTRAINT " + w.q(name)
}

func (w *planWriter) dropRendererCheck(table, name, expression string) {
	w.add(PlanStep{
		Statement: w.dropCheck(table, name),
		Rollback:  "ALTER TABLE " + w.q(table) + " ADD CONSTRAINT " + w.q(name) + " CHECK (" + expression + ")",
		Effect:    absent("constraint", table, name),
	})
}

// namedIndex는 table의 unique key나 index 하나를 만들고 지우는 statement다.
type namedIndex struct {
	name, create, drop string
	constraint         bool // MySQL과 PostgreSQL의 unique constraint
}

// indexes는 table t를 name으로 둔 unique key와 index를 renderer 순서로 돌려준다.
// SQLite unique key는 unique index다.
func (w *planWriter) indexes(t *Table, name string) []namedIndex {
	var out []namedIndex
	if w.r.d == DialectSQLite {
		for _, u := range sortedBy(t.Uniques, func(u Unique) string { return u.Name }) {
			out = append(out, namedIndex{name: u.Name, create: "CREATE UNIQUE INDEX " + w.q(u.Name) + " ON " + w.q(name) + " (" + w.r.list(u.Columns) + ")", drop: w.dropIndex(name, u.Name)})
		}
	}
	for _, x := range sortedBy(t.Indexes, func(x Index) string { return x.Name }) {
		columns := make([]string, len(x.Columns))
		for i, c := range x.Columns {
			columns[i] = w.q(c.Name)
			if c.Descending {
				columns[i] += " DESC"
			}
		}
		out = append(out, namedIndex{name: x.Name, create: "CREATE INDEX " + w.q(x.Name) + " ON " + w.q(name) + " (" + strings.Join(columns, ", ") + ")", drop: w.dropIndex(name, x.Name)})
	}
	return out
}

func (w *planWriter) dropIndex(table, name string) string {
	if w.r.d == DialectMySQL {
		return "DROP INDEX " + w.q(name) + " ON " + w.q(table)
	}
	return "DROP INDEX " + w.q(name)
}

// createIndexes는 renderer가 CREATE TABLE 뒤에 쓰는 unique index와 index다.
func (w *planWriter) createIndexes(t *Table, name string) {
	for _, x := range w.indexes(t, name) {
		w.add(PlanStep{Statement: x.create, Rollback: x.drop, Effect: present("index", name, x.name)})
	}
}

// objectStatements는 table t(name으로 둔)의 객체 o를 더하는 statement, 지우는
// statement, 그 효과의 종류다.
func (w *planWriter) objectStatements(t *Table, name string, o objectRef) (create, drop, kind string) {
	switch o.kind {
	case "unique":
		u := uniqueOf(t, o.name)
		if w.r.d == DialectSQLite {
			return "CREATE UNIQUE INDEX " + w.q(u.Name) + " ON " + w.q(name) + " (" + w.r.list(u.Columns) + ")", w.dropIndex(name, u.Name), "index"
		}
		create = "ALTER TABLE " + w.q(name) + " ADD CONSTRAINT " + w.q(u.Name) + " UNIQUE (" + w.r.list(u.Columns) + ")"
		if w.r.d == DialectMySQL {
			return create, "ALTER TABLE " + w.q(name) + " DROP INDEX " + w.q(u.Name), "index"
		}
		return create, "ALTER TABLE " + w.q(name) + " DROP CONSTRAINT " + w.q(u.Name), "constraint"
	case "index":
		for _, x := range w.indexes(&Table{Indexes: []Index{*indexOf(t, o.name)}}, name) {
			return x.create, x.drop, "index"
		}
	case "check":
		k := checkOf(t, o.name)
		var b strings.Builder
		w.r.predicate(&b, t, k.Expression)
		return "ALTER TABLE " + w.q(name) + " ADD CONSTRAINT " + w.q(k.Name) + " CHECK (" + b.String() + ")", w.dropCheck(name, k.Name), "constraint"
	case "foreign_key":
		f := foreignKeyOf(t, o.name)
		drop := "ALTER TABLE " + w.q(name) + " DROP CONSTRAINT " + w.q(f.Name)
		if w.r.d == DialectMySQL {
			drop = "ALTER TABLE " + w.q(name) + " DROP FOREIGN KEY " + w.q(f.Name)
		}
		return "ALTER TABLE " + w.q(name) + " ADD " + w.r.foreignKey(*f), drop, "constraint"
	}
	panic("dbspec: unknown object kind " + o.kind)
}

// dropObject는 source table t의 객체를 지우고, rollback은 source 정의로 다시 만든다.
func (w *planWriter) dropObject(t *Table, o objectRef) {
	create, drop, kind := w.objectStatements(t, t.Name, o)
	w.add(PlanStep{Statement: drop, Rollback: create, Effect: absent(kind, t.Name, o.name)})
}

func (w *planWriter) addObject(table string, o objectRef) {
	create, drop, kind := w.objectStatements(w.d.target[table], table, o)
	w.add(PlanStep{Statement: create, Rollback: drop, Effect: present(kind, table, o.name)})
}

func (w *planWriter) addForeignKey(table string, f ForeignKey) {
	w.addObject(table, objectRef{"foreign_key", f.Name})
}

// rendererChecks는 table의 renderer CHECK 이름과 식이다.
func (w *planWriter) rendererChecks(t *Table) map[string]string {
	out := map[string]string{}
	for _, c := range t.Columns {
		if check := w.r.typeCheck(c); check != "" {
			out[t.Name+"$"+c.Name] = check
		}
	}
	return out
}
