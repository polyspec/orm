package dbspec

import "strings"

// AddTablesAndColumnsSteps는 연결의 addTablesAndColumns가 실행할 step을 쓴다
// (docs/schema.md "Adding tables and columns"). live는 연결의 database를 introspect한
// 문서, unsupported는 introspection이 읽지 못한 객체, target은 document set의 schema
// text 문서다. set에 없는 database의 table은 비교하지도 바꾸지도 않는다. database에
// 있는 set의 table과 set의 차이가 database에 없는 table의 create_table과 null이거나
// default가 있는 column의 add_column뿐이면, database에 있는 set의 table에서 set까지의
// plan step(docs/plans.md "Steps")과, table 이름 순으로 만드는 table은 "table", 더하는
// column은 column 순서로 "table.column"인 목록을 돌려준다. 다른 차이는 step 없이
// differences에 "<kind> <table>[.<name>]"로 돌려준다.
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
		default:
			differences = append(differences, d.Kind+" "+qualified(d.Table, d.Name))
		}
	}
	if len(differences) > 0 || len(adding) == 0 {
		return nil, nil, differences
	}
	// 만드는 table과 더하는 column은 table 이름 순, table 안에서는 column 순서다.
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
	}
	// 더하는 table과 column은 plan 하나로 쓴다. plan은 database에 있는 set의 table에서
	// 시작하므로(하나도 없으면 빈 database) step은 docs/plans.md의 순서와 rollback을 그대로
	// 갖는다.
	from, start := "", (*Document)(nil)
	var diagnostics []Diagnostic
	if len(source.Tables) > 0 {
		manifest, manifestDiagnostics := ManifestOf([]*Document{source})
		diagnostics = manifestDiagnostics
		from, start = manifest.SchemaHash, source
	}
	if len(diagnostics) == 0 {
		// target은 외부 문서를 쓰는 set의 schema text일 수 있으므로 plan 문서를 parse하지
		// 않고 target으로 plan을 만든다.
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

// InstalledDifferences는 database가 document set과 같은지 확인한다(docs/schema.md "Schema
// installation"). live는 연결의 database를 introspect한 문서, unsupported는 introspection이
// 읽지 못한 객체, target은 document set의 schema text 문서다. set에 없는 database의 table은
// 비교하지 않는다. set의 table에 읽지 못한 객체가 있으면 그 객체를
// "unsupported_<kind> <table>[.<name>]: <reason>"로, 아니면 database에 있는 set의 table에서
// set까지의 모든 차이를 "<kind> <table>[.<name>]"로 돌려준다. 빈 목록이면 같다.
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

// compareSet은 database에 있는 set의 table(source)과 set을 비교한다. set의 table에 읽지 못한
// 객체가 있으면 source 없이 그 객체를 differences로 돌려준다. 아니면 set의 table 이름별
// 정의, source, CompareSchemas의 차이와 그 diagnostic을 돌려준다.
func compareSet(live *Document, unsupported []Unsupported, target *Document) (declared map[string]*Table, source *Document, found []Difference, differences []string) {
	declared = map[string]*Table{}
	for i := range target.Tables {
		declared[target.Tables[i].Name] = &target.Tables[i]
	}
	// set의 table에 읽지 못한 객체가 있으면 그 table은 set과 같다고 할 수 없다.
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
