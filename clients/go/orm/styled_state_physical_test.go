package orm_test

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/schema"
)

const styledStateSchema = `erDiagram
  styled_case {
    bigint   seq                 PK "auto"
    jsontext json_payload       "?"
    jsontext jsons_payload      "?"
    text     serialize_payload  "?"
    text     yaml_payload       "?"
    jsontext json_required
  }
`

func TestStyledFixturePhysicalCells(t *testing.T) {
	data, err := os.ReadFile("../../../contracts/fixtures/styled_column_states.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct {
			ID       string `json:"id"`
			Style    string `json:"style"`
			Nullable bool   `json:"nullable"`
			Input    struct {
				Kind  string `json:"kind"`
				Value any    `json:"value"`
			} `json:"input"`
			StoredText *string        `json:"stored_text"`
			Output     map[string]any `json:"output"`
			Error      string         `json:"error"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	diagram, err := schema.Parse(styledStateSchema)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := schema.Build(diagram)
	if err != nil {
		t.Fatal(err)
	}
	manifestJSON, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	for driver, dsn := range map[string]string{
		"sqlite":   "sqlite://" + filepath.Join(t.TempDir(), "styled-state.sqlite"),
		"mysql":    os.Getenv("ORM_TEST_MYSQL_DSN"),
		"postgres": os.Getenv("ORM_TEST_POSTGRES_DSN"),
	} {
		t.Run(driver, func(t *testing.T) {
			requireTarget(t, driver, dsn)
			dropTable(t, driver, dsn, "styled_case")
			defer dropTable(t, driver, dsn, "styled_case")
			eng, err := engine.New(manifest, driver)
			if err != nil {
				t.Fatal(err)
			}
			db, err := orm.Open(dsn, eng, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if err := db.Utils().Schema().Install(manifestJSON); err != nil {
				t.Fatal(err)
			}
			var raw *sql.DB
			if driver == "sqlite" {
				raw, err = sql.Open("sqlite", strings.TrimPrefix(dsn, "sqlite://"))
			} else {
				raw = openNative(t, driver, dsn)
			}
			if err != nil {
				t.Fatal(err)
			}
			defer raw.Close()
			entity := rowEntity("styled_case", manifest.SchemaHash, "seq", "json_payload", "jsons_payload", "serialize_payload", "yaml_payload", "json_required")
			newRow := func() *orm.Core { c := orm.NewCore(entity); entity.New(c); c.Connect(db); return c }
			bind := "?"
			if driver == "postgres" {
				bind = "$1"
			}
			for _, tc := range fixture.Cases {
				t.Run(tc.ID, func(t *testing.T) {
					column := tc.Style + "_payload"
					if !tc.Nullable {
						column = "json_required"
					}
					if tc.ID == "unselected" {
						if newRow().Selected(column) {
							t.Fatal("unselected column reported as selected")
						}
						return
					}
					if tc.ID == "empty_text" {
						query := "INSERT INTO styled_case (json_payload, json_required) VALUES (" + bind + ", 'null')"
						if _, err := raw.Exec(query, ""); err != nil {
							t.Fatal(err)
						}
						q := newRow()
						q.AddColumn("json_payload")
						if _, err := orm.Gets[*keywordRow](q); orm.ErrorCode(err) != orm.CodeCodecDecode {
							t.Fatalf("empty stored cell error = %v", err)
						}
						return
					}
					var input orm.StyledValue
					switch tc.Input.Kind {
					case "sql-null":
						input = orm.SqlNull()
					case "value":
						input = orm.Value(tc.Input.Value)
					default:
						t.Fatalf("unknown fixture input kind %q", tc.Input.Kind)
					}
					if tc.ID == "nonnull_sql_null" {
						if _, err := orm.NormalizeStyled([]string{"json"}, false, input); orm.ErrorCode(err) != orm.CodeCodecEncode {
							t.Fatalf("non-null setter error = %v", err)
						}
						return
					}
					c := newRow()
					c.Set("json_required", orm.Value(nil))
					c.Set(column, input)
					created, err := c.Create()
					if err != nil {
						t.Fatal(err)
					}
					id := created.(*keywordRow).vals["seq"]
					var cell sql.NullString
					query := fmt.Sprintf("SELECT %s FROM styled_case WHERE seq = %s", column, bind)
					if err := raw.QueryRow(query, id).Scan(&cell); err != nil {
						t.Fatal(err)
					}
					if tc.StoredText == nil {
						if cell.Valid {
							t.Fatalf("stored cell = %q; want SQL NULL", cell.String)
						}
					} else if !cell.Valid || cell.String != *tc.StoredText {
						t.Fatalf("stored cell = %+v; want %q", cell, *tc.StoredText)
					}
					q := newRow()
					q.AddColumn(column)
					q.Where("", []orm.ChainKey{{Column: "seq"}}, id)
					rows, err := orm.Gets[*keywordRow](q)
					if err != nil {
						t.Fatal(err)
					}
					if rows.Len() != 1 {
						t.Fatalf("rows = %d", rows.Len())
					}
					got, ok := rows.First().vals[column].(orm.StyledValue)
					if !ok {
						t.Fatalf("decoded column = %T", rows.First().vals[column])
					}
					actual, err := json.Marshal(got)
					if err != nil {
						t.Fatal(err)
					}
					want, err := json.Marshal(tc.Output)
					if err != nil {
						t.Fatal(err)
					}
					if string(actual) != string(want) {
						t.Fatalf("decoded state = %s; want %s", actual, want)
					}
				})
			}
		})
	}
}
