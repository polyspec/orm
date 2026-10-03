package dbspec

import "strings"

// AddColumnSteps는 연결의 addColumns가 실행할 step을 쓴다(docs/schema.md
// "Adding columns"). live는 연결의 database를 introspect한 문서, unsupported는
// introspection이 읽지 못한 객체, target은 document set의 schema text 문서다.
// 두 쪽에 다 있는 table만 비교하므로 database에 없는 set의 table과 set에 없는
// database의 table은 그대로 둔다. 차이가 null이거나 default가 있는 column의
// add_column뿐이면, 그 table들의 live 문서에서 target까지의 plan step(docs/plans.md
// "Steps")과 더하는 column을 table 이름, column 순서로 "table.column"으로 돌려준다.
// 다른 차이는 step 없이 differences에 "<kind> <table>[.<name>]"로 돌려준다.
func AddColumnSteps(live *Document, unsupported []Unsupported, target *Document, dialect Dialect) (added []string, steps []PlanStep, differences []string) {
	declared := map[string]*Table{}
	for i := range target.Tables {
		declared[target.Tables[i].Name] = &target.Tables[i]
	}
	// set의 table에 읽지 못한 객체가 있으면 그 table은 set과 같다고 할 수 없다.
	for _, u := range unsupported {
		if declared[u.Table] != nil {
			differences = append(differences, "unsupported_"+u.Kind+" "+qualified(u.Table, u.Name)+": "+u.Reason)
		}
	}
	existing := map[string]bool{}
	source := &Document{Name: "schema"}
	for _, t := range live.Tables {
		if declared[t.Name] != nil {
			existing[t.Name] = true
			source.Tables = append(source.Tables, t)
		}
	}
	part := &Document{Name: "schema"}
	for _, t := range target.Tables {
		if existing[t.Name] {
			part.Tables = append(part.Tables, t)
		}
	}
	if len(differences) > 0 || len(part.Tables) == 0 {
		return nil, nil, differences
	}
	found, diagnostics := CompareSchemas(source, part)
	for _, d := range diagnostics {
		differences = append(differences, d.Rule+": "+d.Message)
	}
	adding := map[string]bool{}
	for _, d := range found {
		if d.Kind == "add_column" {
			c := columnOf(declared[d.Table], d.Name)
			if c.Identity || (!c.Null && c.Default == nil) {
				differences = append(differences, "add_column "+qualified(d.Table, d.Name)+" without null or default")
				continue
			}
			adding[qualified(d.Table, d.Name)] = true
			continue
		}
		differences = append(differences, d.Kind+" "+qualified(d.Table, d.Name))
	}
	if len(differences) > 0 || len(adding) == 0 {
		return nil, nil, differences
	}
	// 더하는 column은 table 이름 순, table 안에서는 column 순서다.
	for _, t := range part.Tables {
		for _, c := range t.Columns {
			if adding[qualified(t.Name, c.Name)] {
				added = append(added, qualified(t.Name, c.Name))
			}
		}
	}
	// 더하는 column은 plan 하나로 쓴다. plan은 source schema에서 시작하므로
	// step은 docs/plans.md의 순서와 rollback을 그대로 갖는다.
	manifest, diagnostics := ManifestOf([]*Document{source})
	if len(diagnostics) == 0 {
		var plan *Plan
		plan, diagnostics = ParsePlan("dbplan 1 add_columns\nfrom " + manifest.SchemaHash + "\n\n" + Emit(part))
		if len(diagnostics) == 0 {
			steps, diagnostics = PlanSteps(source, plan, dialect)
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

func qualified(table, name string) string {
	if name == "" {
		return table
	}
	return strings.Join([]string{table, name}, ".")
}
