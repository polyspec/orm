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
		"Optional<Row>":     {"go": "(*{Entity}Row,error)", "php": "?App\\Orm\\{Entity}Row", "rust": "Result<Option<{Entity}Row>>", "typescript": "Promise<{Entity}Row|null>"},
		"Collection<Row>":   {"go": "(*orm.Collection[{Entity}Row],error)", "php": "Orm\\Collection", "rust": "Result<Collection<{Entity}Row>>", "typescript": "Promise<Collection<{Entity}Row>>"},
		"I64":               {"go": "(int64,error)", "php": "int", "rust": "Result<i64>", "typescript": "Promise<number>"},
		"AffectedRows":      {"go": "(int64,error)", "php": "int", "rust": "Result<u64>", "typescript": "Promise<number>"},
		"Page<Row>":         {"go": "(*orm.Page[{Entity}Row],error)", "php": "Orm\\Page", "rust": "Result<Page<{Entity}Row>>", "typescript": "Promise<Page<{Entity}Row>>"},
		"SqlStatement":      {"go": "(*orm.Statement,error)", "php": "array", "rust": "Result<db::Sql>", "typescript": "Promise<{sql:string;binds:unknown[];}>"},
		"Success":           {"go": "error", "php": "void", "rust": "Result<()>", "typescript": "Promise<void>"},
		"Bool":              {"go": "bool", "php": "bool", "rust": "bool", "typescript": "boolean"},
		"RowMap":            {"go": "(map[string]any,error)", "php": "array", "rust": "Result<serde_json::Value>", "typescript": "Record<string,unknown>"},
		"Query":             {"go": "*{Entity}Query", "php": "static", "rust": "Self", "typescript": "this"},
		"Where":             {"go": "*{Entity}Where", "php": "static", "rust": "Self", "typescript": "this"},
		"Row":               {"go": "*{Entity}Row", "php": "static", "rust": "&mutSelf", "typescript": "this"},
		"AESRotationStatus": {"go": "(orm.AESRotationStatus,error)", "php": "Orm\\AesRotationStatus", "rust": "Result<orm::aes_rotation::AesRotationStatus>", "typescript": "Promise<AesRotationStatus>"},
		"RowCount":          {"go": "(int,error)", "php": "int", "rust": "Result<u64>", "typescript": "Promise<number>"},
		"StreamResult":      {"go": "(orm.StreamResult,error)", "php": "Orm\\StreamResult", "rust": "Result<db::StreamResult>", "typescript": "Promise<StreamResult>"},
	}
	for _, r := range d.Rules {
		if seen[r.ID] {
			return fmt.Errorf("duplicate rule %s", r.ID)
		}
		seen[r.ID] = true
		role := strings.Split(r.ID, ".")[0]
		for _, lang := range []string{"go", "php", "rust", "typescript"} {
			n, ok := r.Native[lang]
			if !ok {
				return fmt.Errorf("%s missing %s", r.ID, lang)
			}
			sig := compact(n.Signature)
			begin := strings.Index(sig, "(")
			end := matchingParen(sig, begin)
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
			if lang == "typescript" {
				ret = strings.TrimPrefix(ret, ":")
			}
			want, ok := outputs[r.Output][lang]
			if !ok {
				return fmt.Errorf("%s unknown output %s", r.ID, r.Output)
			}
			if r.ID == "Query.query" && lang == "rust" {
				want = "{Entity}"
			}
			if r.ID == "Query.query" && lang == "typescript" {
				want = "{Entity}Query"
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
					if len(r.Errors) > 0 && role == "Query" && receiver != "&mutself" && r.For != "aes_entity" {
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
				permitted = map[string][]string{"go": {"v{type}"}, "php": {"{type}$v", "{type}$value"}, "rust": {"v:{type}"}, "typescript": {"value:{type}"}}[lang]
			case "Executor,NativeExecutionControl":
				permitted = map[string][]string{"go": {"ctxcontext.Context,exorm.Exec"}, "php": {"Orm\\Db|PDO$db"}, "rust": {"ex:&implExec"}, "typescript": {"database:Db"}}[lang]
			case "page,per":
				permitted = map[string][]string{"go": {"page,perint"}, "php": {"int$page,int$per"}, "rust": {"page:u32,per:u32"}, "typescript": {"page:number,per:number"}}[lang]
			case "AESKeyring":
				permitted = map[string][]string{"go": {"keyringorm.AESKeyring"}, "php": {"Orm\\AesKeyring$keyring"}, "rust": {"keyring:&orm::aes_rotation::AesKeyring"}, "typescript": {"keyring:AesKeyring"}}[lang]
			case "RowVisitor":
				permitted = map[string][]string{
					"go":         {"visitfunc(*{Entity}Row)bool"},
					"php":        {"callable$visit"},
					"rust":       {"visit:implFnMut({Entity}Row)->bool"},
					"typescript": {"visitor:(row:{Entity}Row)=>boolean|Promise<boolean>"},
				}[lang]
			case "Column", "Relation":
				permitted = map[string][]string{"go": {"namestring", "relstring"}, "php": {"string$col", "string$name"}, "rust": {"name:&str"}, "typescript": {"column:string", "relation:string"}}[lang]
			default:
				return fmt.Errorf("%s unrecognized input contract %v", r.ID, r.Inputs)
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

func matchingParen(value string, open int) int {
	if open < 0 || open >= len(value) || value[open] != '(' {
		return -1
	}
	depth := 0
	for i := open; i < len(value); i++ {
		switch value[i] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}
