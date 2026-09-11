package contracts

import (
	"fmt"
	"strings"
	"unicode"
)

func compact(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, s)
}

// Validate the language adapters against logical inputs/outputs. Updating a
// native signature and its snapshot together must not change the common API.
func validateRules(d document) error {
	seen := map[string]bool{}
	outputs := map[string]map[string]string{
		"Optional<Row>":   {"go": "(*{Entity}Row,error)", "php": "?App\\Orm\\{Entity}Row", "rust": "Result<Option<{Entity}Row>>"},
		"Collection<Row>": {"go": "(*orm.Collection[{Entity}Row],error)", "php": "Orm\\Collection", "rust": "Result<Collection<{Entity}Row>>"},
		"I64":             {"go": "(int64,error)", "php": "int", "rust": "Result<i64>"},
		"AffectedRows":    {"go": "(int64,error)", "php": "int", "rust": "Result<u64>"},
		"Page<Row>":       {"go": "(*orm.Page[{Entity}Row],error)", "php": "Orm\\Page", "rust": "Result<Page<{Entity}Row>>"},
		"SqlStatement":    {"go": "(*orm.Statement,error)", "php": "array", "rust": "Result<db::Sql>"},
		"Success":         {"go": "error", "php": "void", "rust": "Result<()>"},
		"Bool":            {"go": "bool", "php": "bool", "rust": "bool"},
		"RowMap":          {"go": "(map[string]any,error)", "php": "array", "rust": "Result<serde_json::Value>"},
		"Query":           {"go": "*{Entity}Query", "php": "static", "rust": "Self"},
		"Where":           {"go": "*{Entity}Where", "php": "static", "rust": "Self"},
		"Row":             {"go": "*{Entity}Row", "php": "static", "rust": "&mutSelf"},
	}
	for _, r := range d.Rules {
		if seen[r.ID] {
			return fmt.Errorf("duplicate rule %s", r.ID)
		}
		seen[r.ID] = true
		role := strings.Split(r.ID, ".")[0]
		for _, lang := range []string{"go", "php", "rust"} {
			n, ok := r.Native[lang]
			if !ok {
				return fmt.Errorf("%s missing %s", r.ID, lang)
			}
			sig := compact(n.Signature)
			begin, end := strings.Index(sig, "("), strings.Index(sig, ")")
			if begin < 0 || end < begin {
				return fmt.Errorf("%s/%s invalid signature", r.ID, lang)
			}
			args, ret := sig[begin+1:end], sig[end+1:]
			if lang == "php" {
				ret = strings.TrimPrefix(ret, ":")
			}
			if lang == "rust" {
				ret = strings.TrimPrefix(ret, "->")
			}
			want, ok := outputs[r.Output][lang]
			if !ok {
				return fmt.Errorf("%s unknown output %s", r.ID, r.Output)
			}
			if r.ID == "Query.construct" && lang == "php" {
				want = ""
			}
			if ret != want {
				return fmt.Errorf("%s/%s return %s does not implement %s", r.ID, lang, ret, r.Output)
			}
			if lang == "rust" {
				if strings.Contains(args, "self") {
					parts := strings.SplitN(args, ",", 2)
					receiver := parts[0]
					args = ""
					if len(parts) == 2 {
						args = parts[1]
					}
					if len(r.Errors) > 0 && role == "Query" && receiver != "&mutself" {
						return fmt.Errorf("%s must borrow query for execution", r.ID)
					}
				}
				if len(r.Errors) > 0 && r.ID != "Row.export" && !strings.Contains(sig, "asyncfn") {
					return fmt.Errorf("%s Rust execution must be async", r.ID)
				}
			}
			var permitted []string
			switch strings.Join(r.Inputs, ",") {
			case "":
				permitted = []string{""}
			case "ColumnValue":
				permitted = map[string][]string{"go": {"v{type}"}, "php": {"{type}$v", "{type}$value"}, "rust": {"v:{type}"}}[lang]
			case "Executor,NativeExecutionControl":
				permitted = map[string][]string{"go": {"ctxcontext.Context,exorm.Exec"}, "php": {"Orm\\Db|PDO$db"}, "rust": {"ex:&implExec"}}[lang]
			case "page,per":
				permitted = map[string][]string{"go": {"page,perint"}, "php": {"int$page,int$per"}, "rust": {"page:u32,per:u32"}}[lang]
			case "Column", "Relation":
				permitted = map[string][]string{"go": {"namestring", "relstring"}, "php": {"string$col", "string$name"}, "rust": {"name:&str"}}[lang]
			default:
				return fmt.Errorf("%s unrecognized input contract %v", r.ID, r.Inputs)
			}
			if r.ID == "Query.construct" && lang == "php" {
				permitted = []string{"Orm\\Db|PDO|null$db=null"}
			}
			if r.ID == "Row.delete" && lang == "php" {
				permitted = []string{"bool$cascade=false"}
			}
			valid := false
			for _, p := range permitted {
				if args == p {
					valid = true
				}
			}
			if !valid {
				return fmt.Errorf("%s/%s arguments %s do not implement %v", r.ID, lang, args, r.Inputs)
			}
		}
	}
	return nil
}
