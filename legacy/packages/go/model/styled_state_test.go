package model_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/model"
	"github.com/polyspec/orm/legacy/packages/go/orm"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// Requirements: DBS-116, COD-17, COD-20.
func TestGeneratedStyledGetterAndSetterStates(t *testing.T) {
	// The test of COD-17, COD-20 (docs/spec).
	testcase.Start(t)
	row := model.Author()
	for _, invalid := range []any{nil, orm.StyledValue{}} {
		if _, err := row.Orm_().Entity().Assign(row, "json_setting", invalid); orm.ErrorCode(err) != orm.CodeCodecDecode {
			t.Fatalf("generated styled assignment of %T: %v", invalid, err)
		}
	}
	if _, err := row.GetJsonSetting(); err == nil || !strings.Contains(err.Error(), orm.CodeColumnUnselected) {
		t.Fatalf("unselected getter error = %v", err)
	}
	if _, err := row.SetJsonSetting(orm.StyledValue{}); err == nil || !strings.Contains(err.Error(), orm.CodeCodecEncode) {
		t.Fatalf("unset styled setter error = %v", err)
	}
	if _, err := row.GetJsonSetting(); err == nil || !strings.Contains(err.Error(), orm.CodeColumnUnselected) {
		t.Fatalf("rejected setter changed selection: %v", err)
	}

	var err error
	row, err = row.SetJsonSetting(orm.SqlNull())
	if err != nil {
		t.Fatal(err)
	}
	got, err := row.GetJsonSetting()
	if err != nil || got.Kind() != "sql-null" {
		t.Fatalf("SQL NULL getter = %v, %v", got, err)
	}
	checkStyledOutput(t, row, `{"json_setting":{"kind":"sql-null"}}`)

	row, err = row.SetJsonSetting(orm.Value(nil))
	if err != nil {
		t.Fatal(err)
	}
	got, err = row.GetJsonSetting()
	if err != nil || got.Kind() != "value" {
		t.Fatalf("stored null getter = %v, %v", got, err)
	}
	value, present := got.Data()
	if !present {
		t.Fatal("stored null has no value variant")
	}
	encodedValue, err := json.Marshal(value)
	if err != nil || string(encodedValue) != "null" {
		t.Fatalf("stored null data = %s, %v", encodedValue, err)
	}
	checkStyledOutput(t, row, `{"json_setting":{"kind":"value","value":null}}`)

	if _, err := orm.NormalizeStyled("json_setting", []string{"ordered_json"}, false, orm.SqlNull()); err == nil || err.Error() != "CODEC_ENCODE: json_setting does not accept SQL NULL" {
		t.Fatalf("non-null SQL NULL setter validation = %v", err)
	}
	if _, err := orm.NormalizeStyled("json_setting", []string{"ordered_json"}, false, orm.Value(nil)); err != nil {
		t.Fatalf("non-null encoded null rejected: %v", err)
	}
}

func TestStyledStatesAcrossDatabases(t *testing.T) {
	testcase.Start(t)
	each(t, func(t *testing.T, db *orm.DB) {
		f := seed(t, db)
		id := readColumn(t, f.authors[0].GetSeq)
		plain := must(model.Author().Connect(db).GetBySeq(id))
		if _, err := plain.GetJsonSetting(); orm.ErrorCode(err) != orm.CodeColumnUnselected {
			t.Fatalf("unselected json_setting getter: %v", err)
		}
		for _, tc := range []struct {
			name  string
			value orm.StyledValue
			kind  string
		}{
			{"sql_null", orm.SqlNull(), "sql-null"},
			{"encoded_null", orm.Value(nil), "value"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				row := must(model.Author().Connect(db).GetBySeq(id))
				row, err := row.SetJsonSetting(tc.value)
				if err != nil {
					t.Fatal(err)
				}
				row, err = row.SetJsonsTags(tc.value)
				if err != nil {
					t.Fatal(err)
				}
				row, err = row.SetSerializeData(tc.value)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := row.Update(); err != nil {
					t.Fatal(err)
				}
				read := must(model.Author().Connect(db).AddColumnJsonSetting().AddColumnJsonsTags().AddColumnSerializeData().GetBySeq(id))
				for _, getter := range []func() (orm.StyledValue, error){read.GetJsonSetting, read.GetJsonsTags, read.GetSerializeData} {
					got, err := getter()
					if err != nil || got.Kind() != tc.kind {
						t.Fatalf("getter = %v, %v", got, err)
					}
				}
			})
		}
	})
}

func checkStyledOutput(t *testing.T, row *model.AuthorModel, want string) {
	t.Helper()
	arrayJSON, err := json.Marshal(row.ToArray())
	if err != nil {
		t.Fatal(err)
	}
	if string(arrayJSON) != want {
		t.Fatalf("row array = %s; want %s", arrayJSON, want)
	}
	modelJSON, err := json.Marshal(row)
	if err != nil {
		t.Fatal(err)
	}
	if string(modelJSON) != want {
		t.Fatalf("model JSON = %s; want %s", modelJSON, want)
	}
}
