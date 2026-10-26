package orm

import "testing"

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
