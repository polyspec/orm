package dbspec

import (
	"slices"
	"strings"
)

// RuleCompare is the diagnostic for a comparison target that is not schema text (docs/plans.md "Comparison").
const RuleCompare = "compare"

// Difference is one difference between two schemas (docs/plans.md "Comparison"). Name is
// the name of a column or object, and is an empty string for a table-level difference.
type Difference struct {
	Kind  string
	Table string
	Name  string
}

// differenceKinds is the order in which differences occur within one table.
var differenceKinds = []string{
	"create_table", "drop_table",
	"drop_column", "add_column", "alter_column", "change_column_type", "change_column_identity",
	"reorder_columns", "change_primary_key",
	"drop_unique", "add_unique", "drop_index", "add_index",
	"drop_foreign_key", "add_foreign_key", "drop_check", "add_check",
	"drop_immutable", "add_immutable", "drop_audit", "add_audit",
}

// CompareSchemas returns all differences from source to target without a plan.
// There is no rename; tables and columns are matched by name only. Both documents must be schema text,
// and for each one that is not, it returns a compare diagnostic in source, target order.
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

// isSchemaText reports whether the document's canonical emission is the schema text of that one document.
// The use lines of an external document must be in document-name order, and its tables in name order. The external document itself
// is not needed.
func isSchemaText(d *Document) bool {
	if d.Name != "schema" {
		return false
	}
	schema := &Document{Name: d.Name, Tables: slices.Clone(d.Tables)}
	slices.SortStableFunc(schema.Tables, func(a, b Table) int { return strings.Compare(a.Name, b.Name) })
	for _, u := range d.Uses {
		tables := slices.Clone(u.Tables)
		slices.Sort(tables)
		schema.Uses = append(schema.Uses, Use{Document: u.Document, Tables: slices.Compact(tables)})
	}
	return Emit(d) == emitDocument(schema, viewSchema)
}

// compareTables adds the column, primary key, object, and setting differences of tables present on both sides.
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
	// audit compares, among the columns present on both sides, even columns that are not recorded.
	// A column present on only one side is left as a difference: add_column or drop_column.
	audit := func(x *Table) []string {
		if x.Settings == nil || x.Settings.Audit == nil {
			return nil
		}
		a := x.Settings.Audit
		def := []string{a.History + " " + a.Column + " " + a.References + " " + a.Action + " " + a.Previous + " " + a.Tables + " " + a.TablesRecord + " " + a.TablesName}
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

// compareObjects, for an object matched by name that is on only one side, adds a drop or an add; if its definition
// differs, it adds both.
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

// compareSettings compares the definition (nil if none) of the setting that a table has at most one of.
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
