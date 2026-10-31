package orm

import (
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/testcase"
)

// Requirements: INT-117, INT-123.
func TestCatalogSameCellComparesWrittenTemporalTextExactly(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	tests := []struct {
		name      string
		stored    any
		requested any
		want      bool
	}{
		{name: "the written text of the declared digits", stored: "2026-01-02 03:04:05.123", requested: "2026-01-02 03:04:05.123", want: true},
		{name: "different instant", stored: "2026-01-02 03:04:05.123", requested: "2026-01-02 03:04:05.124", want: false},
		{name: "more digits than declared", stored: "2026-01-02 03:04:05.123", requested: "2026-01-02 03:04:05.1230", want: false},
		{name: "fewer digits than declared", stored: "12:34:56.500", requested: "12:34:56.5", want: false},
		{name: "a time value is not its text", stored: "2026-01-02 03:04:05", requested: time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC), want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := catalogSameCell(test.stored, test.requested)
			if err != nil || got != test.want {
				t.Fatalf("catalogSameCell() = %v, %v; want %v, nil", got, err, test.want)
			}
		})
	}
}

// Requirements: INT-101.
func TestCatalogBytesValuePreservesNativeTimeAsText(t *testing.T) {
	testcase.Start(t, testcase.Compute)
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
	testcase.Start(t, testcase.Compute)
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
			_, err := catalogChanges(metadata, []CatalogAssignment{{Name: "value", Value: test.value}}, "ROW_UPDATE_INVALID", false, "mysql")
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
