package model_test

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/polyspec/orm/clients/go/model"
	"github.com/polyspec/orm/clients/go/orm"
)

func TestGeneratedStyledGetterAndSetterStates(t *testing.T) {
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

	if _, err := orm.NormalizeStyled([]string{"json"}, false, orm.SqlNull()); err == nil || !strings.Contains(err.Error(), orm.CodeCodecEncode) {
		t.Fatalf("non-null SQL NULL setter validation = %v", err)
	}
	if _, err := orm.NormalizeStyled([]string{"json"}, false, orm.Value(nil)); err != nil {
		t.Fatalf("non-null encoded null rejected: %v", err)
	}
}

func TestStyledStatesAcrossDatabases(t *testing.T) {
	each(t, func(t *testing.T, db *orm.DB) {
		f := seed(t, db)
		id := f.authors[0].GetSeq()
		if _, err := model.Author().Connect(db).GetBySeq(id); err != nil {
			t.Fatal(err)
		}
		plain := must(model.Author().Connect(db).GetBySeq(id))
		if _, err := plain.GetJsonSetting(); orm.ErrorCode(err) != orm.CodeColumnUnselected {
			t.Fatalf("unselected json_setting getter: %v", err)
		}
		for _, tc := range []struct {
			name   string
			value  orm.StyledValue
			stored sql.NullString
			kind   string
		}{
			{"sql_null", orm.SqlNull(), sql.NullString{}, "sql-null"},
			{"encoded_null", orm.Value(nil), sql.NullString{String: "null", Valid: true}, "value"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				row := must(model.Author().Connect(db).GetBySeq(id))
				var err error
				row, err = row.SetJsonSetting(tc.value)
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
				for _, name := range []string{"json_setting", "jsons_tags", "serialize_data"} {
					got := read.ToArray()[name]
					encoded, err := json.Marshal(got)
					if err != nil {
						t.Fatal(err)
					}
					if !strings.Contains(string(encoded), `"kind":"`+tc.kind+`"`) {
						t.Fatalf("%s row array = %s", name, encoded)
					}
				}
				if _, err := json.Marshal(read); err != nil {
					t.Fatal(err)
				}

				dsn := dsnOf(t, db)
				driver := strings.SplitN(dsn, ":", 2)[0]
				var raw *sql.DB
				if driver == "sqlite" {
					raw, err = sql.Open("sqlite", strings.TrimPrefix(dsn, "sqlite://"))
					if err != nil {
						t.Fatal(err)
					}
				} else {
					raw = openNative(t, driver, dsn)
				}
				defer raw.Close()
				bind := "?"
				if driver == "postgres" {
					bind = "$1"
				}
				var jsonText, jsonsText, serializeText sql.NullString
				if err := raw.QueryRow(fmt.Sprintf("SELECT json_setting, jsons_tags, serialize_data FROM author WHERE seq = %s", bind), id).Scan(&jsonText, &jsonsText, &serializeText); err != nil {
					t.Fatal(err)
				}
				for _, cell := range []sql.NullString{jsonText, jsonsText} {
					if cell != tc.stored {
						t.Fatalf("JSON stored cell = %+v; want %+v", cell, tc.stored)
					}
				}
				wantSerialize := sql.NullString{}
				if tc.kind == "value" {
					wantSerialize = sql.NullString{String: "N;", Valid: true}
				}
				if serializeText != wantSerialize {
					t.Fatalf("serialize stored cell = %+v; want %+v", serializeText, wantSerialize)
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
