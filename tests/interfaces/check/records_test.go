package main

import (
	"reflect"
	"testing"
)

func TestCommonRecordRejectsRecapturedNativeDrift(t *testing.T) {
	records := []Record{
		{ID: "Query", Native: map[string]string{"go": "ir.go::Query"}, Fields: map[string]string{"entity": "text", "group": "Group"}},
		{ID: "Group", Native: map[string]string{"go": "ir.go::Group"}, Fields: map[string]string{"items": "list<text>"}},
	}
	symbols := Symbols{"ir.go::Query#wire": `{"entity":"text","group":"Group"}`, "ir.go::Group#wire": `{"items":"list<text>"}`}
	if errors := checkRecords("go", symbols, records); len(errors) != 0 {
		t.Fatal(errors)
	}
	for _, changed := range []string{`{}`, `{"items":"text"}`, `{"items":"list<integer>"}`, `{"items":"list<text>","controller":"text"}`} {
		symbols["ir.go::Group#wire"] = changed
		if len(checkRecords("go", symbols, records)) == 0 {
			t.Fatal("nested drift accepted even with recaptured native symbol snapshot", changed)
		}
	}
}

func TestStateComparisonPreservesI64Keys(t *testing.T) {
	var first, second, text any
	_ = decodeJSON([]byte(`[[9223372036854775806,"row"]]`), &first)
	_ = decodeJSON([]byte(`[[9223372036854775807,"row"]]`), &second)
	_ = decodeJSON([]byte(`[["9223372036854775806","row"]]`), &text)
	if reflect.DeepEqual(first, second) || reflect.DeepEqual(first, text) {
		t.Fatal("comparison lost I64 precision or key type")
	}
}
