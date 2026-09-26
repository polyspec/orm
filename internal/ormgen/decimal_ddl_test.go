package ormgen

import (
	"testing"

	"github.com/polyspec/orm/engine/schema"
)

func TestSQLiteDecimalUsesExactScaledStorage(t *testing.T) {
	column := &schema.Col{Type: "decimal", Precision: 13, Scale: 4}
	actual, err := ddlType(column, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if actual != "DECIMALINT(13,4)" {
		t.Fatalf("SQLite decimal DDL = %s, want DECIMALINT(13,4)", actual)
	}
}
