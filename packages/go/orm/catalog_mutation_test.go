package orm

import (
	"testing"
	"time"
)

// Requirements: INT-101.
func TestCatalogSameWrittenCellMatchesDateTimeTextToDriverTime(t *testing.T) {
	defaultStored := time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)
	stored := time.Date(2026, time.January, 2, 3, 4, 5, 123000000, time.UTC)
	tests := []struct {
		name       string
		stored     any
		requested  any
		columnType string
		dialect    string
		want       bool
	}{
		{name: "default precision", stored: defaultStored, requested: "2026-01-02 03:04:05", columnType: "DATETIME", dialect: "sqlite", want: true},
		{name: "matching declared fraction", stored: stored, requested: "2026-01-02 03:04:05.123", columnType: "DATETIME(3)", dialect: "sqlite", want: true},
		{name: "PostgreSQL default precision", stored: stored, requested: "2026-01-02 03:04:05.123", columnType: "timestamp without time zone", dialect: "postgres", want: true},
		{name: "MySQL native datetime", stored: defaultStored, requested: "2026-01-02 03:04:05", columnType: "datetime", dialect: "mysql", want: true},
		{name: "different instant", stored: stored, requested: "2026-01-02 03:04:05.124", columnType: "DATETIME", dialect: "sqlite", want: false},
		{name: "rejects unsupported fraction width", stored: stored, requested: "2026-01-02 03:04:05.1234567", columnType: "DATETIME", dialect: "sqlite", want: false},
		{name: "rejects nonzero fraction beyond column precision", stored: stored, requested: "2026-01-02 03:04:05.1234", columnType: "DATETIME(3)", dialect: "sqlite", want: false},
		{name: "does not coerce text column", stored: stored, requested: "2026-01-02 03:04:05.123", columnType: "TEXT", dialect: "sqlite", want: false},
		{name: "does not coerce an unknown dialect", stored: stored, requested: "2026-01-02 03:04:05.123", columnType: "DATETIME", dialect: "other", want: false},
	}
	db := &DB{location: time.UTC}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := catalogSameWrittenCell(db, test.stored, test.requested, CatalogColumn{NativeType: test.columnType}, test.dialect)
			if err != nil || got != test.want {
				t.Fatalf("catalogSameWrittenCell() = %v, %v; want %v, nil", got, err, test.want)
			}
		})
	}
}

// Requirements: INT-101.
func TestCatalogBytesValuePreservesNativeTimeAsText(t *testing.T) {
	for _, nativeType := range []string{"TIME", "TIME(3)", "time without time zone", "time(3) without time zone"} {
		got, err := catalogBytesValue([]byte("12:34:56.123"), nativeType)
		if err != nil || got != "12:34:56.123" {
			t.Errorf("catalogBytesValue(%q) = %T(%v), %v; want time text", nativeType, got, got, err)
		}
	}
	for _, nativeType := range []string{"TIMETZ", "TIME WITH TIME ZONE", "TIME(7)"} {
		if _, err := catalogBytesValue([]byte("12:34:56.123"), nativeType); err == nil {
			t.Errorf("catalogBytesValue(%q) accepted an unsupported time type", nativeType)
		}
	}
}

// Requirements: INT-111.
func TestCatalogChangesRejectsValuesBeyondDeclaredCapacity(t *testing.T) {
	tests := []struct {
		name       string
		nativeType string
		value      any
		wantError  bool
	}{
		{name: "varchar boundary counts Unicode code points", nativeType: "varchar(3)", value: "界界界"},
		{name: "varchar over boundary counts Unicode code points", nativeType: "varchar(3)", value: "界界界界", wantError: true},
		{name: "character varying boundary", nativeType: "CHARACTER VARYING (3)", value: "界界界"},
		{name: "character varying over boundary", nativeType: "character varying(3)", value: "界界界界", wantError: true},
		{name: "varbinary boundary counts bytes", nativeType: "varbinary(3)", value: []byte{0, 1, 2}},
		{name: "varbinary over boundary counts bytes", nativeType: "varbinary(3)", value: []byte{0, 1, 2, 3}, wantError: true},
		{name: "binary boundary counts bytes", nativeType: "BINARY(3)", value: "éa"},
		{name: "binary over boundary counts string bytes", nativeType: "binary(3)", value: "éé", wantError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			metadata := CatalogTableMetadata{Columns: []CatalogColumn{{Name: "value", NativeType: test.nativeType}}}
			_, err := catalogChanges(metadata, []CatalogAssignment{{Name: "value", Value: test.value}}, "ROW_UPDATE_INVALID", false)
			if test.wantError {
				if ErrorCode(err) != "ROW_UPDATE_INVALID" {
					t.Fatalf("catalogChanges error = %v, want ROW_UPDATE_INVALID", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("catalogChanges rejected an in-capacity value: %v", err)
			}
		})
	}
}
