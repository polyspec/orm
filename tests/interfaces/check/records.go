package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"reflect"
	"strings"
)

// Record fixes the full value-free request/plan graph independently of either
// implementation. Native names are adapters; fields and nested types are shared.
type Record struct {
	ID       string            `json:"id"`
	Native   map[string]string `json:"native"`
	Fields   map[string]string `json:"fields"`
	Optional []string          `json:"optional"`
	Extends  string            `json:"extends"`
	Union    bool              `json:"union"`
}

func goWireType(t ast.Expr) string {
	switch n := t.(type) {
	case *ast.StarExpr:
		return goWireType(n.X)
	case *ast.ArrayType:
		return "list<" + goWireType(n.Elt) + ">"
	case *ast.MapType:
		if goWireType(n.Key) != "text" {
			return "invalid-map-key"
		}
		return "map<" + goWireType(n.Value) + ">"
	case *ast.Ident:
		switch n.Name {
		case "string":
			return "text"
		case "bool":
			return "bool"
		case "int", "int32", "int64", "uint32", "uint64", "uint":
			return "integer"
		default:
			return n.Name
		}
	}
	return fmt.Sprintf("unsupported-%T", t)
}

func checkRecords(lang string, symbols Symbols, records []Record) []string {
	// PHP's array records are checked at the compiler boundary by generated
	// Wire definitions. Reflection still checks Req.ir/Rows.plan ownership.
	if lang == "php" {
		return nil
	}
	byID, byNative := map[string]Record{}, map[string]Record{}
	for _, r := range records {
		byID[r.ID] = r
		byNative[r.Native[lang]] = r
	}
	var flattenExpected func(Record) map[string]string
	flattenExpected = func(r Record) map[string]string {
		out := map[string]string{}
		if r.Extends != "" {
			for k, v := range flattenExpected(byID[r.Extends]) {
				out[k] = v
			}
		}
		for k, v := range r.Fields {
			out[k] = v
		}
		return out
	}
	var normalize func(string, string) string
	normalize = func(prefix, t string) string {
		for _, kind := range []string{"list", "map"} {
			if strings.HasPrefix(t, kind+"<") && strings.HasSuffix(t, ">") {
				return kind + "<" + normalize(prefix, t[len(kind)+1:len(t)-1]) + ">"
			}
		}
		if r, ok := byNative[prefix+t]; ok {
			return r.ID
		}
		return t
	}
	var readNative func(Record) (map[string]string, error)
	readNative = func(r Record) (map[string]string, error) {
		key := r.Native[lang]
		prefix := key[:strings.LastIndex(key, "::")+2]
		raw, ok := symbols[key+"#wire"]
		if !ok {
			return nil, fmt.Errorf("%s: missing record %s", lang, key)
		}
		var fields map[string]string
		if err := json.Unmarshal([]byte(raw), &fields); err != nil {
			return nil, err
		}
		out := map[string]string{}
		for k, t := range fields {
			if k == "@flatten" {
				parent, ok := byNative[prefix+t]
				if !ok {
					return nil, fmt.Errorf("unknown flattened record %s", t)
				}
				base, err := readNative(parent)
				if err != nil {
					return nil, err
				}
				for bk, bv := range base {
					out[bk] = bv
				}
			} else {
				out[k] = normalize(prefix, t)
			}
		}
		return out, nil
	}
	var failures []string
	for _, r := range records {
		actual, err := readNative(r)
		if err != nil {
			failures = append(failures, err.Error())
			continue
		}
		expected := flattenExpected(r)
		if !reflect.DeepEqual(actual, expected) {
			for _, d := range differences(Symbols(expected), Symbols(actual)) {
				failures = append(failures, lang+"/"+r.ID+": "+d)
			}
		}
	}
	return failures
}
