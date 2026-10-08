package orm_test

import (
	"encoding/json/jsontext"
	"testing"

	orderedjson "github.com/polyspec/ordered-json/go"
	"github.com/polyspec/orm/packages/orm-go/orm"
	_ "github.com/polyspec/orm/packages/orm-go/orm/pg"
	_ "github.com/polyspec/orm/packages/orm-go/orm/sqlite"

	"github.com/polyspec/orm/internal/testcase"
)

// jsonTextRow is a model for a table with a jsontext column.
type jsonTextRow struct {
	m    *orm.Core
	vals map[string]any
}

func (r *jsonTextRow) Orm_() *orm.Core { return r.m }

var jsonTextColumns = []string{"seq", "data"}

func jsonTextEntity(s *orm.Schema) *orm.Entity {
	return &orm.Entity{
		Name:   "json_data",
		Schema: s,
		New: func(c *orm.Core) orm.Model {
			r := &jsonTextRow{m: c, vals: map[string]any{}}
			c.Bind(r)
			return r
		},
		Assign: func(m orm.Model, name string, v any) (bool, error) {
			for _, c := range jsonTextColumns {
				if c == name {
					m.(*jsonTextRow).vals[name] = v
					return true, nil
				}
			}
			return false, nil
		},
		Value: func(m orm.Model, name string) (any, bool) {
			v, ok := m.(*jsonTextRow).vals[name]
			return v, ok
		},
		Collect: func(keys []orm.Key, items map[orm.Key]*orm.Core, fetched map[orm.Key]any) any {
			return orm.CollectOf[*jsonTextRow](keys, items, fetched)
		},
	}
}

const jsonTextSchema = `dbspec 1 json_text

table json_data {
  seq i64 identity
  data text
  primary key (seq)
  settings {
    codec data ordered_json
  }
}
`

// TestJsonTextOrderPreservation writes a jsontext value with a specific key
// order to the database and verifies that the order is preserved when read
// back, ensuring that {"b":1,"a":2} stays as {"b":1,"a":2} and not reordered
// to {"a":2,"b":1}.
func TestJsonTextOrderPreservation(t *testing.T) {
	testcase.Start(t, testcase.Database)
	s := documentSchema(t, jsonTextSchema)
	manifest := s
	for _, driver := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(driver, func(t *testing.T) {
			dsn := newDatabase(t, driver)
			db, err := orm.ConnectSchema(dsn, s, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if err := db.Utils().Schema().Install(manifest); err != nil {
				t.Fatal(err)
			}

			entity := jsonTextEntity(s)
			model := func() *orm.Core {
				c := orm.NewCore(entity)
				entity.New(c)
				c.Connect(db)
				return c
			}

			// Write a jsontext value with reversed key order: b, a
			// This should preserve the order when read back.
			testCases := []struct {
				name     string
				input    jsontext.Value
				expected string
			}{
				{
					name:     "reversed key order",
					input:    jsontext.Value(`{"b":1,"a":2}`),
					expected: `{"b":1,"a":2}`,
				},
				{
					name:     "nested object with key order",
					input:    jsontext.Value(`{"z":{},"a":[],"nested":{"second":2,"first":1}}`),
					expected: `{"z":{},"a":[],"nested":{"second":2,"first":1}}`,
				},
			}

			for _, tc := range testCases {
				t.Run(tc.name, func(t *testing.T) {
					c := model()
					c.Set("data", orm.Value(tc.input))
					created, err := c.Create()
					if err != nil {
						t.Fatalf("create: %v", err)
					}
					seq := created.(*jsonTextRow).vals["seq"]

					// Read back the value
					q := model()
					q.AddAllColumns()
					q.Where("", []orm.ChainKey{{Column: "seq"}}, mustInt64(seq))
					rows, err := orm.Gets[*jsonTextRow](q)
					if err != nil {
						t.Fatalf("read: %v", err)
					}
					if rows.Len() != 1 {
						t.Fatalf("expected 1 row, got %d", rows.Len())
					}

					readRow := rows.First()
					styled, ok := readRow.vals["data"].(orm.StyledValue)
					if !ok || styled.Kind() != "value" {
						t.Fatalf("data state is %T (%v)", readRow.vals["data"], readRow.vals["data"])
					}
					data, _ := styled.Data()
					value, ok := data.(*orderedjson.Value)
					if !ok {
						t.Fatalf("data is %T, want *orderedjson.Value", data)
					}
					readStr, err := orderedjson.Stringify(value)
					if err != nil {
						t.Fatal(err)
					}

					if readStr != tc.expected {
						t.Errorf("order mismatch:\n  expected: %s\n  got:      %s", tc.expected, readStr)
					}
				})
			}
		})
	}
}
