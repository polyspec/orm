package dbspec

import (
	"slices"
	"strconv"
	"strings"
)

// PlanStep is one step of a plan (docs/spec/plans.md "Steps"). If Rollback is empty,
// it is a finalize step, or Irreversible gives the reason.
type PlanStep struct {
	Statement    string
	Rollback     string
	Irreversible string
	Effect       Effect
	// Restore and RollbackRestore are the statements that run instead of Statement and Rollback when RestoreIf is true
	// (when a column that rollback hid and added is in the table).
	Restore         string
	RollbackRestore string
	RestoreIf       Effect
	NullChecks      []NullCheck
	Finalize        bool
}

// Effect is how to read, from the catalog or the table, whether a statement had its effect. Kind is
// one of table, column, index, constraint, trigger, function, sequence, rows, or repeat.
// Present is the state after the statement.
type Effect struct {
	Kind    string
	Table   string
	Name    string
	Present bool
}

// String is the text form of docs/spec/plans.md "Effects".
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

// NullCheck is a column that the rollback returns to non-null. Column is its name
// in the applied plan; if HasDefault, Default is the SQL text of the source default.
type NullCheck struct {
	Table      string
	Column     string
	Default    string
	HasDefault bool
}

// The reason a step cannot be reversed (docs/spec/plans.md "Irreversible steps").
const irreversiblePrecision = "narrowing the precision rounds the values written since"

// rebuildTable is the work table for a SQLite rebuild.
const rebuildTable = "dbspec$rebuild"

// PlanSteps writes the plan's steps per dialect (docs/spec/plans.md "Steps"). source is the schema
// that the plan starts from; it is nil if the database is empty.
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
	rebuilt    map[string]bool // target table to rebuild in SQLite
	holdPrefix string
	// kept name: "table.column" (the column being dropped, with source table and column name),
	// table (the table being dropped), "+table.column" (the column being added, with its target name)
	holds     map[string]string
	holdOrder []string
}

func (w *planWriter) add(s PlanStep) { w.out = append(w.out, s) }

func (w *planWriter) q(name string) string { return w.r.q(name) }

func present(kind, table, name string) Effect { return Effect{kind, table, name, true} }
func absent(kind, table, name string) Effect  { return Effect{kind, table, name, false} }

var repeat = Effect{Kind: "repeat"}

func (w *planWriter) hold(key string) string { return w.holds[key] }

// numberHolds picks the kept names in the order of docs/spec/plans.md "Hiding instead of dropping".
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
	// 3. check, unique, index, and the objects of the table being dropped
	dropTables := map[string][]objectRef{}
	for s, objects := range d.dropObjects {
		if sqlite && (w.rebuilt[w.targetName(s)] || slices.Contains(d.dropped, s)) {
			continue
		}
		for _, o := range objects {
			if o.kind != "foreign_key" && (!sqlite || o.kind != "check") {
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
	// 5. hide the columns and the table being dropped
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
	// 7. add and alter columns; SQLite rebuild
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
			if o.kind != "foreign_key" && (!sqlite || o.kind != "check") {
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

// targetName is the target name of the source table.
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

// sqliteRebuilds reports whether SQLite must rebuild the table: it does if the name,
// a column, a foreign key, or a check changes. It does not if only index and unique
// changes, or if only trigger changes.
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

// hideColumn, in MySQL and PostgreSQL, makes the column being dropped nullable and hides it
// under its kept name.
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

// nullCheck is the null check of the rollback that returns source column c to non-null.
func (w *planWriter) nullCheck(table, column string, c Column) NullCheck {
	check := NullCheck{Table: table, Column: column}
	if c.Default != nil {
		check.Default, check.HasDefault = w.r.defaultText(c.Type, *c.Default), true
	}
	return check
}

// precisionGrows reports whether the precision of a time or datetime grows.
func precisionGrows(from, to Type) bool {
	return (to.Kind == TypeTime || to.Kind == TypeDatetime) && to.Precision > from.Precision
}

// rebuild rebuilds a SQLite table through a work table (docs/spec/plans.md "Steps").
func (w *planWriter) rebuild(name string) {
	d := w.d
	t := d.target[name]
	src := d.source[d.tableOf[name]]
	q := w.q
	work := q(rebuildTable)
	// new definition: the target table, with the column being dropped under its kept name
	var hiddenDropped []Column
	for _, c := range d.removed[name] {
		col := *columnOf(src, c)
		col.Name = w.hold(src.Name + "." + c)
		hiddenDropped = append(hiddenDropped, col)
	}
	// old definition: the source table with the rename applied, with the column being added under its kept name
	old := w.renamedSource(name)
	var hiddenAdded []Column
	for _, c := range d.added[name] {
		col := *columnOf(t, c)
		col.Name = w.hold("+" + name + "." + c)
		hiddenAdded = append(hiddenAdded, col)
	}
	newCreate := func(as string) string {
		return w.r.createTable(t, as, func(c string) string { return rendererName(t.Name, c) }, hiddenDropped)
	}
	// sourceColumn is the source name of a column in the old definition. A column being dropped keeps its name.
	sourceColumn := func(c string) string {
		if s, ok := d.columnOf[name][c]; ok {
			return s
		}
		return c
	}
	oldCreate := w.r.createTable(old, name, func(c string) string { return rendererName(src.Name, sourceColumn(c)) }, hiddenAdded)
	newColumns := make([]string, 0, len(t.Columns)+len(hiddenDropped))
	for _, c := range t.Columns {
		newColumns = append(newColumns, c.Name)
	}
	for _, c := range hiddenDropped {
		newColumns = append(newColumns, c.Name)
	}
	newList := w.r.list(newColumns)
	// expression that moves a value from the old table to the new definition
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
	// expression that moves a value from the new definition back to the old definition
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
		// column being dropped: in the new definition it is the kept name.
		h := w.hold(src.Name + "." + sourceName)
		backFrom = append(backFrom, q(h))
		if !c.Null {
			checks = append(checks, w.nullCheck(name, h, c))
		}
	}
	// If the old table had a hidden added column, its value is restored as well.
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

// renamedSource is the definition of the source table with the rename applied to the target table name.
// A foreign key that refers to a table being dropped keeps the source name.
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

// copyValue is the expression that moves a source value into the target column type in a SQLite rebuild.
// time and datetime fill the added fractional digits with 0.
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

// triggerParts pairs a trigger with a PostgreSQL function in the rendered trigger statements.
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

// namedIndex is the statement that creates or drops one unique key or index of a table.
type namedIndex struct {
	name, create, drop string
}

// indexes returns the unique keys and indexes of table t, named by name, in renderer order.
// SQLite unique keys are unique indexes.
func (w *planWriter) indexes(t *Table, name string) []namedIndex {
	var out []namedIndex
	if w.r.d == DialectSQLite {
		for _, u := range sortedBy(t.Uniques, func(u Unique) string { return u.Name }) {
			out = append(out, namedIndex{name: u.Name, create: "CREATE UNIQUE INDEX " + w.q(u.Name) + " ON " + w.q(name) + " (" + w.r.list(u.Columns) + ")", drop: w.dropIndex(name, u.Name)})
		}
	}
	for _, x := range sortedBy(t.Indexes, func(x Index) string { return x.Name }) {
		out = append(out, namedIndex{name: x.Name, create: "CREATE INDEX " + w.q(x.Name) + " ON " + w.q(name) + " (" + indexColumnList(x.Columns, w.q) + ")", drop: w.dropIndex(name, x.Name)})
	}
	return out
}

func (w *planWriter) dropIndex(table, name string) string {
	if w.r.d == DialectMySQL {
		return "DROP INDEX " + w.q(name) + " ON " + w.q(table)
	}
	return "DROP INDEX " + w.q(name)
}

// createIndexes is the unique indexes and indexes that the renderer writes after CREATE TABLE.
func (w *planWriter) createIndexes(t *Table, name string) {
	for _, x := range w.indexes(t, name) {
		w.add(PlanStep{Statement: x.create, Rollback: x.drop, Effect: present("index", name, x.name)})
	}
}

// objectStatements: the statements that add object o of table t (named name), the statements that drop it,
// and the kind of effect of those statements.
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

// dropObject drops an object of the source table t, and rollback recreates it from the source definition.
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

// rendererChecks is the renderer CHECK names and expressions of the table.
func (w *planWriter) rendererChecks(t *Table) map[string]string {
	out := map[string]string{}
	for _, c := range t.Columns {
		if check := w.r.typeCheck(c); check != "" {
			out[rendererName(t.Name, c.Name)] = check
		}
	}
	return out
}
