package model_test

import (
	"os"
	"reflect"
	"testing"

	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
)

// TestGroupRowsDatabase reads the grouped counts of the seeded bench database (BENCH_SQLITE_DSN, from make run-databases)
// through the model: a group holds only the grouped column and its count, the grouped boolean and integer values keep their
// types, the counts sum to the row count, and a SQL NULL group is kept.
// Requirements: INT-31.
func TestGroupRowsDatabase(t *testing.T) {
	dsn := os.Getenv("BENCH_SQLITE_DSN")
	if dsn == "" {
		t.Fatal("BENCH_SQLITE_DSN is required; run it through make run-databases")
	}
	db := must(model.Connect(dsn, orm.Config{AESKey: "bench-salt", BlindIndexKey: "bench-blind-index"}))
	defer db.Close()
	groups := must(model.Author().Connect(db).GroupByIsClose().OrderByIsCloseAsc().GetsCount())
	if groups.Len() != 2 {
		t.Fatalf("getsCount returned %d rows, want 2", groups.Len())
	}
	if keys := groups.ToArray()[0]; !reflect.DeepEqual(sortedKeys(keys), []string{"is_close", "row_count"}) {
		t.Fatalf("group row includes an unselected field: %#v", keys)
	}
	var total int64
	for row := range groups.All() {
		value, err := row.Value("is_close")
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := value.(bool); !ok {
			t.Fatalf("grouped boolean has type %T", value)
		}
		if row.Count() < 1 {
			t.Fatalf("grouped count %d", row.Count())
		}
		if _, err := row.Value("name"); orm.ErrorCode(err) != orm.CodeColumnUnselected {
			t.Fatalf("unselected model column error = %v", err)
		}
		total += row.Count()
	}
	if want := must(model.Author().Connect(db).GetCount()); total != want {
		t.Fatalf("group counts sum to %d, want the row count %d", total, want)
	}
	services := must(model.Author().Connect(db).GroupByServiceSeq().GetsCount())
	var serviceTotal int64
	for row := range services.All() {
		value, err := row.Value("service_seq")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := orm.AsInt64(value); err != nil {
			t.Fatalf("grouped integer changed type %T", value)
		}
		serviceTotal += row.Count()
	}
	if serviceTotal != total {
		t.Fatalf("service group counts sum to %d, want %d", serviceTotal, total)
	}
	nullable := must(model.Author().Connect(db).GroupByPrice().GetsCount())
	var sawNull bool
	var nullableTotal int64
	for row := range nullable.All() {
		value, err := row.Value("price")
		if err != nil {
			t.Fatal(err)
		}
		sawNull = sawNull || value == nil
		nullableTotal += row.Count()
	}
	if !sawNull || nullableTotal != total {
		t.Fatalf("SQL NULL group value was lost: seen %v, total %d", sawNull, nullableTotal)
	}
}

func sortedKeys(row map[string]any) []string {
	keys := make([]string, 0, len(row))
	for key := range row {
		keys = append(keys, key)
	}
	for i := range keys {
		for j := i + 1; j < len(keys); j++ {
			if keys[j] < keys[i] {
				keys[i], keys[j] = keys[j], keys[i]
			}
		}
	}
	return keys
}
