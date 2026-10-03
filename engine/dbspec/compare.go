package dbspec

import (
	"slices"
	"strings"
)

// RuleCompare는 schema text가 아닌 비교 대상의 diagnostic이다(docs/plans.md "Comparison").
const RuleCompare = "compare"

// Difference는 두 schema의 차이 하나다(docs/plans.md "Comparison"). Name은
// column이나 객체의 이름이고, table 단위 차이에서는 빈 문자열이다.
type Difference struct {
	Kind  string
	Table string
	Name  string
}

// differenceKinds는 한 table 안에서 차이가 오는 순서다.
var differenceKinds = []string{
	"create_table", "drop_table",
	"drop_column", "add_column", "alter_column", "change_column_type", "change_column_identity",
	"reorder_columns", "change_primary_key",
	"drop_unique", "add_unique", "drop_index", "add_index",
	"drop_foreign_key", "add_foreign_key", "drop_check", "add_check",
	"drop_immutable", "add_immutable", "drop_audit", "add_audit",
}

// CompareSchemas는 plan 없이 source에서 target까지의 모든 차이를 돌려준다.
// rename은 없고 table과 column은 이름으로만 맞춘다. 두 문서는 schema text여야
// 하며, 아닌 쪽마다 compare diagnostic을 source, target 순으로 돌려준다.
func CompareSchemas(source, target *Document) ([]Difference, []Diagnostic) {
	var out []Diagnostic
	for _, side := range []struct {
		name     string
		document *Document
	}{{"source", source}, {"target", target}} {
		if !isSchemaText(side.document) {
			out = append(out, Diagnostic{Rule: RuleCompare, Line: 1, Column: 1, Message: "the " + side.name + " is not a schema text: one document named schema in canonical form with its tables in name order and only the immutable and audit settings"})
		}
	}
	if len(out) > 0 {
		return nil, out
	}
	sourceTables, targetTables := map[string]*Table{}, map[string]*Table{}
	for i := range source.Tables {
		sourceTables[source.Tables[i].Name] = &source.Tables[i]
	}
	for i := range target.Tables {
		targetTables[target.Tables[i].Name] = &target.Tables[i]
	}
	names := sortedKeys(sourceTables)
	for _, name := range sortedKeys(targetTables) {
		if sourceTables[name] == nil {
			names = append(names, name)
		}
	}
	slices.Sort(names)
	differences := []Difference{}
	for _, name := range names {
		var found []Difference
		add := func(kind, n string) { found = append(found, Difference{Kind: kind, Table: name, Name: n}) }
		s, t := sourceTables[name], targetTables[name]
		switch {
		case s == nil:
			add("create_table", "")
		case t == nil:
			add("drop_table", "")
		default:
			compareTables(s, t, add)
		}
		slices.SortStableFunc(found, func(a, b Difference) int {
			if k := slices.Index(differenceKinds, a.Kind) - slices.Index(differenceKinds, b.Kind); k != 0 {
				return k
			}
			return strings.Compare(a.Name, b.Name)
		})
		differences = append(differences, found...)
	}
	return differences, nil
}

// isSchemaText는 문서의 canonical emission이 그 문서 하나의 schema text인지 알려 준다.
func isSchemaText(d *Document) bool {
	manifest, diagnostics := ManifestOf([]*Document{d})
	return len(diagnostics) == 0 && Emit(d) == manifest.SchemaText
}

// compareTables는 두 쪽에 다 있는 table의 column, primary key, 객체, setting 차이를 더한다.
func compareTables(s, t *Table, add func(kind, name string)) {
	for _, c := range s.Columns {
		if columnOf(t, c.Name) == nil {
			add("drop_column", c.Name)
		}
	}
	var kept, keptTarget []string
	lastKept, firstAdded := -1, -1
	for i, c := range t.Columns {
		sc := columnOf(s, c.Name)
		if sc == nil {
			add("add_column", c.Name)
			if firstAdded < 0 {
				firstAdded = i
			}
			continue
		}
		keptTarget = append(keptTarget, c.Name)
		lastKept = i
		if (sc.Type != c.Type && widens(sc.Type, c.Type)) || sc.Null != c.Null || !sameDefault(sc.Default, c.Default) {
			add("alter_column", c.Name)
		}
		if sc.Type != c.Type && !widens(sc.Type, c.Type) {
			add("change_column_type", c.Name)
		}
		if sc.Identity != c.Identity {
			add("change_column_identity", c.Name)
		}
	}
	for _, c := range s.Columns {
		if columnOf(t, c.Name) != nil {
			kept = append(kept, c.Name)
		}
	}
	if !slices.Equal(kept, keptTarget) || (firstAdded >= 0 && firstAdded < lastKept) {
		add("reorder_columns", "")
	}
	if !slices.Equal(s.PrimaryKey.Columns, t.PrimaryKey.Columns) {
		add("change_primary_key", "")
	}
	same := func(c string) string { return c }
	compareObjects(add, "unique", s.Uniques, t.Uniques, func(u Unique) string { return u.Name }, func(u Unique) string { return strings.Join(u.Columns, ",") })
	compareObjects(add, "index", s.Indexes, t.Indexes, func(x Index) string { return x.Name }, func(x Index) string { return indexDef(x, same) })
	compareObjects(add, "foreign_key", s.ForeignKeys, t.ForeignKeys, func(f ForeignKey) string { return f.Name }, func(f ForeignKey) string {
		return foreignKeyDef(f.Columns, f.Table, f.References, f)
	})
	compareObjects(add, "check", s.Checks, t.Checks, func(k Check) string { return k.Name }, func(k Check) string { return exprText(k.Expression, same) })
	immutable := func(x *Table) []string {
		if x.Settings == nil || x.Settings.Immutable == nil {
			return nil
		}
		return []string{"immutable"}
	}
	// audit은 두 쪽에 다 있는 column 가운데 기록하지 않는 column까지 비교한다.
	// 한쪽에만 있는 column은 add_column이나 drop_column이 차이로 남긴다.
	audit := func(x *Table) []string {
		if x.Settings == nil || x.Settings.Audit == nil {
			return nil
		}
		a := x.Settings.Audit
		def := []string{a.History + " " + a.Operation + " " + a.Action + " " + a.Previous}
		for _, c := range t.Columns {
			if columnOf(s, c.Name) != nil && !a.Records(c.Name) {
				def = append(def, c.Name)
			}
		}
		return def
	}
	compareSettings(add, "immutable", immutable(s), immutable(t))
	compareSettings(add, "audit", audit(s), audit(t))
}

// compareObjects는 이름으로 맞춘 객체가 한쪽에만 있으면 drop이나 add를, 정의가
// 다르면 둘 다 더한다.
func compareObjects[T any](add func(kind, name string), kind string, source, target []T, name, def func(T) string) {
	defs := map[string]string{}
	for _, o := range target {
		defs[name(o)] = def(o)
	}
	sourceDefs := map[string]string{}
	for _, o := range source {
		sourceDefs[name(o)] = def(o)
		if d, ok := defs[name(o)]; !ok || d != def(o) {
			add("drop_"+kind, name(o))
		}
	}
	for _, o := range target {
		if d, ok := sourceDefs[name(o)]; !ok || d != def(o) {
			add("add_"+kind, name(o))
		}
	}
}

// compareSettings는 table에 하나뿐인 setting의 정의(없으면 nil)를 비교한다.
func compareSettings(add func(kind, name string), kind string, source, target []string) {
	if !slices.Equal(source, target) {
		if source != nil {
			add("drop_"+kind, "")
		}
		if target != nil {
			add("add_"+kind, "")
		}
	}
}
