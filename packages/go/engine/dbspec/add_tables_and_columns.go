package dbspec

import "strings"

// AddTablesAndColumnsSteps writes the steps that the connection's addTablesAndColumns runs
// (docs/schema.md "Adding tables and columns"). live is the connection's database, introspected
// document, unsupported is an object that introspection could not read, target is the document set's schema
// text document. Tables of the database that are not in the set are neither compared nor changed. For the database
// tables that exist in the database, the set's differences where the database lacks a table: create_table, and
// add_column for a column that is null or has a default, and add_index for non-unique indexes only, when
// the plan steps from the database's tables up to the set (docs/plans.md "Steps"), ordered by table name
// Tables it creates are listed as "table", added columns as "table.column" in column order, then the added
// indexes are listed in index order as "table.index". Other differences are returned without a step
// in differences as "<kind> <table>[.<name>]", and a missing unique key can fail on existing rows,
// so it is returned with that reason.
func AddTablesAndColumnsSteps(live *Document, unsupported []Unsupported, target *Document, dialect Dialect) (added []string, steps []PlanStep, differences []string) {
	declared, source, found, differences := compareSet(live, unsupported, target)
	if source == nil {
		return nil, nil, differences
	}
	adding := map[string]bool{}
	for _, d := range found {
		switch d.Kind {
		case "create_table":
			adding[d.Table] = true
		case "add_column":
			c := columnOf(declared[d.Table], d.Name)
			if c.Identity || (!c.Null && c.Default == nil) {
				differences = append(differences, "add_column "+qualified(d.Table, d.Name)+" without null or default")
				continue
			}
			adding[qualified(d.Table, d.Name)] = true
		case "add_index":
			// An index does not reject rows, so it is added even to an existing table.
			adding[qualified(d.Table, d.Name)] = true
		case "add_unique":
			// A unique key fails when existing rows collide, so the plan and apply handle it.
			differences = append(differences, "add_unique "+qualified(d.Table, d.Name)+": a missing unique key can fail on the existing rows; add it with a plan")
		default:
			differences = append(differences, d.Kind+" "+qualified(d.Table, d.Name))
		}
	}
	if len(differences) > 0 || len(adding) == 0 {
		return nil, nil, differences
	}
	// Tables to create, and columns and indexes to add, are in table-name order; within a table, column order then
	// index order.
	for _, t := range target.Tables {
		if adding[t.Name] {
			added = append(added, t.Name)
			continue
		}
		for _, c := range t.Columns {
			if adding[qualified(t.Name, c.Name)] {
				added = append(added, qualified(t.Name, c.Name))
			}
		}
		for _, i := range t.Indexes {
			if adding[qualified(t.Name, i.Name)] {
				added = append(added, qualified(t.Name, i.Name))
			}
		}
	}
	// The tables and columns to add are written as one plan. The plan starts from the set's tables that exist in the database
	// (an empty database if there are none), so its steps keep the order and rollback of docs/plans.md
	// as they are.
	from, start := "", (*Document)(nil)
	var diagnostics []Diagnostic
	if len(source.Tables) > 0 {
		manifest, manifestDiagnostics := ManifestOf([]*Document{source})
		diagnostics = manifestDiagnostics
		from, start = manifest.SchemaHash, source
	}
	if len(diagnostics) == 0 {
		// Target can be the schema text of a set that writes an external document, so the plan document is not parsed
		// and the plan is built from target.
		var plan *Plan
		plan, diagnostics = planTo(&Plan{Name: "add_tables_and_columns", From: from}, target, Emit(target))
		if len(diagnostics) == 0 {
			steps, diagnostics = PlanSteps(start, plan, dialect)
		}
	}
	for _, d := range diagnostics {
		differences = append(differences, d.Rule+": "+d.Message)
	}
	if len(differences) > 0 {
		return nil, nil, differences
	}
	return added, steps, nil
}

// InstalledDifferences checks that the database equals the document set (docs/schema.md "Schema
// installation"). live is the database of the connection, introspected into a document; unsupported is the objects
// that introspection could not read; target is the schema text document of the document set. Tables of the database
// that are not in the set are not compared. If a table of the set has an object that could not be read, that object
// is reported as "unsupported_<kind> <table>[.<name>]: <reason>"; otherwise all differences from the database's
// set tables up to the set are reported as "<kind> <table>[.<name>]". An empty list means they match.
func InstalledDifferences(live *Document, unsupported []Unsupported, target *Document) []string {
	_, source, found, differences := compareSet(live, unsupported, target)
	if source == nil {
		return differences
	}
	for _, d := range found {
		differences = append(differences, d.Kind+" "+qualified(d.Table, d.Name))
	}
	return differences
}

// compareSet compares the set's tables that exist in the database (source) with the set. If a set table has an object
// that could not be read, it returns that object as a difference without a source. Otherwise it returns, per table name,
// the definitions, the source, and the differences and diagnostic from CompareSchemas.
func compareSet(live *Document, unsupported []Unsupported, target *Document) (declared map[string]*Table, source *Document, found []Difference, differences []string) {
	declared = map[string]*Table{}
	for i := range target.Tables {
		declared[target.Tables[i].Name] = &target.Tables[i]
	}
	// A set table that has an object that could not be read cannot be said to equal the set.
	for _, u := range unsupported {
		if declared[u.Table] != nil {
			differences = append(differences, "unsupported_"+u.Kind+" "+qualified(u.Table, u.Name)+": "+u.Reason)
		}
	}
	if len(differences) > 0 {
		return nil, nil, nil, differences
	}
	source = &Document{Name: "schema"}
	for _, t := range live.Tables {
		if declared[t.Name] != nil {
			source.Tables = append(source.Tables, t)
		}
	}
	found, diagnostics := CompareSchemas(source, target)
	for _, d := range diagnostics {
		differences = append(differences, d.Rule+": "+d.Message)
	}
	return declared, source, found, differences
}

func qualified(table, name string) string {
	if name == "" {
		return table
	}
	return strings.Join([]string{table, name}, ".")
}
