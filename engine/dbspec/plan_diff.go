package dbspec

import (
	"fmt"
	"slices"
)

// Change는 diff의 변경 하나다(docs/plans.md "Diff"). Table은 target 이름이고,
// drop_table, drop_* 객체는 source 이름이다.
type Change struct {
	Kind  string
	Table string
	Name  string
}

// planDiff는 Diff와 statement 렌더링이 함께 쓰는 diff 결과다.
type planDiff struct {
	source, target   map[string]*Table // 이름: table
	tableOf          map[string]string // target table: source table
	columnOf         map[string]map[string]string
	created, dropped []string
	matched          []string // target 이름 순
	added, removed   map[string][]string
	altered          map[string][]string
	renamedTables    []TableRename
	renamedColumns   []ColumnRename
	dropObjects      map[string][]objectRef // source table: 지울 객체
	addObjects       map[string][]objectRef // target table: 더할 객체
	triggers         map[string]bool        // target table: trigger가 바뀐다
	changes          []Change
}

type objectRef struct{ kind, name string }

// Diff는 source schema(nil이면 빈 schema)에서 plan의 target으로 가는 변경을
// 돌려준다. source의 schemaHash가 plan의 from과 다르면 diagnostic이다.
func Diff(source *Document, p *Plan) ([]Change, []Diagnostic) {
	d, diagnostics := diffPlan(source, p)
	if len(diagnostics) > 0 {
		return nil, diagnostics
	}
	return d.changes, nil
}

func diffPlan(source *Document, p *Plan) (*planDiff, []Diagnostic) {
	from := ""
	if source != nil {
		manifest, diagnostics := ManifestOf([]*Document{source})
		if len(diagnostics) > 0 {
			return nil, diagnostics
		}
		from = manifest.SchemaHash
	}
	if from != p.From {
		return nil, planError("the plan starts from %s, and the source schema is %s", hashOrEmpty(p.From), hashOrEmpty(from))
	}
	d := &planDiff{
		source: map[string]*Table{}, target: map[string]*Table{}, tableOf: map[string]string{},
		columnOf: map[string]map[string]string{}, added: map[string][]string{}, removed: map[string][]string{},
		altered: map[string][]string{}, dropObjects: map[string][]objectRef{}, addObjects: map[string][]objectRef{},
		triggers: map[string]bool{},
	}
	if source != nil {
		for i := range source.Tables {
			d.source[source.Tables[i].Name] = &source.Tables[i]
		}
	}
	for i := range p.Schema.Tables {
		d.target[p.Schema.Tables[i].Name] = &p.Schema.Tables[i]
	}
	var out []Diagnostic
	// table rename
	renamedFrom := map[string]string{} // source: target
	for _, r := range sortedBy(p.RenameTables, func(r TableRename) string { return r.Old }) {
		switch {
		case d.source[r.Old] == nil:
			out = append(out, planError("rename table %s: the source has no table %s", r.Old, r.Old)...)
		case d.source[r.New] != nil:
			out = append(out, planError("rename table %s: the source already has a table %s", r.Old, r.New)...)
		case d.target[r.New] == nil:
			out = append(out, planError("rename table %s: the target has no table %s", r.Old, r.New)...)
		default:
			renamedFrom[r.Old] = r.New
			d.renamedTables = append(d.renamedTables, r)
		}
	}
	targetOf := func(sourceName string) string {
		if n, ok := renamedFrom[sourceName]; ok {
			return n
		}
		return sourceName
	}
	for _, name := range sortedKeys(d.source) {
		if t := targetOf(name); d.target[t] != nil {
			d.tableOf[t] = name
		} else {
			d.dropped = append(d.dropped, name)
		}
	}
	for _, name := range sortedKeys(d.target) {
		if _, ok := d.tableOf[name]; ok {
			d.matched = append(d.matched, name)
		} else {
			d.created = append(d.created, name)
		}
	}
	// table drop permission
	allowedTables := map[string]bool{}
	for _, t := range p.DropTables {
		allowedTables[t] = true
		if !slices.Contains(d.dropped, t) {
			out = append(out, planError("allow drop table %s drops nothing", t)...)
		}
	}
	for _, t := range d.dropped {
		if !allowedTables[t] {
			out = append(out, planError("table %s is dropped without allow drop table %s", t, t)...)
		}
	}
	// column rename
	renamedColumn := map[string]map[string]string{} // target table: source column: target column
	for _, r := range sortedBy(p.RenameColumns, func(r ColumnRename) string { return r.Table + "." + r.Old }) {
		src, ok := d.tableOf[r.Table]
		switch {
		case !ok:
			out = append(out, planError("rename column %s.%s: %s is not a table of both schemas", r.Table, r.Old, r.Table)...)
		case columnOf(d.source[src], r.Old) == nil:
			out = append(out, planError("rename column %s.%s: the source table has no column %s", r.Table, r.Old, r.Old)...)
		case columnOf(d.source[src], r.New) != nil:
			out = append(out, planError("rename column %s.%s: the source table already has a column %s", r.Table, r.Old, r.New)...)
		case columnOf(d.target[r.Table], r.New) == nil:
			out = append(out, planError("rename column %s.%s: the target table has no column %s", r.Table, r.Old, r.New)...)
		default:
			if renamedColumn[r.Table] == nil {
				renamedColumn[r.Table] = map[string]string{}
			}
			renamedColumn[r.Table][r.Old] = r.New
			d.renamedColumns = append(d.renamedColumns, r)
		}
	}
	allowedColumns := map[ColumnName]bool{}
	for _, c := range p.DropColumns {
		allowedColumns[c] = true
	}
	usedColumnPermissions := map[ColumnName]bool{}
	// matched table의 column
	for _, name := range d.matched {
		src, tgt := d.source[d.tableOf[name]], d.target[name]
		d.columnOf[name] = map[string]string{}
		for _, c := range src.Columns {
			n := c.Name
			if r, ok := renamedColumn[name][n]; ok {
				n = r
			}
			if columnOf(tgt, n) == nil {
				ref := ColumnName{Table: src.Name, Name: c.Name}
				if !allowedColumns[ref] {
					out = append(out, planError("column %s.%s is dropped without allow drop column %s.%s", src.Name, c.Name, src.Name, c.Name)...)
				}
				usedColumnPermissions[ref] = true
				d.removed[name] = append(d.removed[name], c.Name)
				continue
			}
			d.columnOf[name][n] = c.Name
		}
		for _, c := range tgt.Columns {
			old, ok := d.columnOf[name][c.Name]
			if !ok {
				if !c.Null && c.Default == nil {
					out = append(out, planError("column %s.%s is added non-null without a default; add it null, fill it, and make it non-null in a later plan", name, c.Name)...)
				}
				if c.Identity {
					out = append(out, planError("column %s.%s adds an identity, which changes the primary key", name, c.Name)...)
				}
				d.added[name] = append(d.added[name], c.Name)
				continue
			}
			sc := columnOf(src, old)
			if sc.Identity != c.Identity {
				out = append(out, planError("column %s.%s changes identity; it needs a new table", name, c.Name)...)
				continue
			}
			if sc.Type != c.Type && !widens(sc.Type, c.Type) {
				out = append(out, planError("column %s.%s changes type from %s to %s, which does not keep every value; it needs a new column", name, c.Name, sc.Type, c.Type)...)
				continue
			}
			if sc.Type != c.Type || sc.Null != c.Null || !sameDefault(sc.Default, c.Default) {
				d.altered[name] = append(d.altered[name], c.Name)
			}
		}
		// PostgreSQL은 column 자리를 정하지 못하므로 남는 column의 순서는 그대로이고
		// 더한 column은 남는 column 뒤에 온다.
		var kept, keptTarget []string
		for _, c := range src.Columns {
			if n := renamedOr(renamedColumn[name], c.Name); columnOf(tgt, n) != nil {
				kept = append(kept, n)
			}
		}
		lastKept := -1
		for i, c := range tgt.Columns {
			if _, ok := d.columnOf[name][c.Name]; ok {
				keptTarget = append(keptTarget, c.Name)
				lastKept = i
			}
		}
		if !slices.Equal(kept, keptTarget) {
			out = append(out, planError("table %s reorders its columns; columns keep their order", name)...)
		}
		for i, c := range tgt.Columns {
			if _, ok := d.columnOf[name][c.Name]; !ok && i < lastKept {
				out = append(out, planError("column %s.%s is added before a kept column; added columns come last", name, c.Name)...)
			}
		}
		var sourceKey []string
		for _, k := range src.PrimaryKey.Columns {
			sourceKey = append(sourceKey, renamedOr(renamedColumn[name], k))
		}
		if !slices.Equal(sourceKey, tgt.PrimaryKey.Columns) {
			out = append(out, planError("table %s changes its primary key; it needs a new table", name)...)
		}
	}
	for _, c := range p.DropColumns {
		if !usedColumnPermissions[c] {
			out = append(out, planError("allow drop column %s.%s drops nothing", c.Table, c.Name)...)
		}
	}
	if len(out) > 0 {
		return nil, out
	}
	d.objects(renamedFrom, renamedColumn)
	d.triggerChanges(renamedFrom, renamedColumn)
	d.collectChanges()
	return d, nil
}

// widens는 세 database에서 모든 값을 지키는 type 변경인지 알려 준다.
func widens(from, to Type) bool {
	switch {
	case from.Kind == TypeI16:
		return to.Kind == TypeI32 || to.Kind == TypeI64
	case from.Kind == TypeI32:
		return to.Kind == TypeI64
	case from.Kind == TypeVarchar:
		return (to.Kind == TypeVarchar && to.Length >= from.Length) || to.Kind == TypeText
	case from.Kind == TypeDecimal:
		return to.Kind == TypeDecimal && to.Scale == from.Scale && to.Precision >= from.Precision
	case from.Kind == TypeTime || from.Kind == TypeDatetime:
		return to.Kind == from.Kind && to.Precision >= from.Precision
	}
	return false
}

func sameDefault(a, b *Default) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func columnOf(t *Table, name string) *Column {
	for i := range t.Columns {
		if t.Columns[i].Name == name {
			return &t.Columns[i]
		}
	}
	return nil
}

func renamedOr(m map[string]string, name string) string {
	if r, ok := m[name]; ok {
		return r
	}
	return name
}

func planError(format string, args ...any) []Diagnostic {
	return []Diagnostic{{Rule: RulePlan, Line: 1, Column: 1, Message: fmt.Sprintf(format, args...)}}
}

func hashOrEmpty(h string) string {
	if h == "" {
		return "empty"
	}
	return h
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}
