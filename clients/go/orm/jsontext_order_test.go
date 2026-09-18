package orm_test

import (
	"encoding/json"
	"encoding/json/jsontext"
	"os"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/clients/go/orm"
	_ "github.com/polyspec/orm/clients/go/orm/pg"
	_ "github.com/polyspec/orm/clients/go/orm/sqlite"
	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/schema"
)

// jsonTextRow is a model for a table with a jsontext column.
type jsonTextRow struct {
	m    *orm.Core
	vals map[string]any
}

func (r *jsonTextRow) Orm_() *orm.Core { return r.m }

var jsonTextColumns = []string{"seq", "data"}

func jsonTextEntity(hash string) *orm.Entity {
	return &orm.Entity{
		Name:   "json_data",
		Schema: &orm.Schema{Hash: hash},
		New: func(c *orm.Core) orm.Model {
			r := &jsonTextRow{m: c, vals: map[string]any{}}
			c.Bind(r)
			return r
		},
		Assign: func(m orm.Model, name string, v any) bool {
			for _, c := range jsonTextColumns {
				if c == name {
					m.(*jsonTextRow).vals[name] = v
					return true
				}
			}
			return false
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

const jsonTextSchema = `erDiagram
  json_data {
    bigint       seq     PK "auto"
    jsontext     data
  }
`

// TestJsonTextOrderPreservation writes a jsontext value with a specific key
// order to the database and verifies that the order is preserved when read
// back, ensuring that {"b":1,"a":2} stays as {"b":1,"a":2} and not reordered
// to {"a":2,"b":1}.
func TestJsonTextOrderPreservation(t *testing.T) {
	d, err := schema.Parse(jsonTextSchema)
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	targets := map[string]string{
		"sqlite":   "sqlite://" + filepath.Join(t.TempDir(), "jsontext.sqlite"),
		"mysql":    os.Getenv("ORM_TEST_MYSQL_DSN"),
		"postgres": os.Getenv("ORM_TEST_POSTGRES_DSN"),
	}
	for driver, dsn := range targets {
		t.Run(driver, func(t *testing.T) {
			requireTarget(t, driver, dsn)
			dropTable(t, driver, dsn, "json_data")
			defer dropTable(t, driver, dsn, "json_data")
			eng, err := engine.New(m, driver)
			if err != nil {
				t.Fatal(err)
			}
			db, err := orm.Open(dsn, eng, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if err := db.Utils().Schema().Install(manifest); err != nil {
				t.Fatal(err)
			}

			entity := jsonTextEntity(m.SchemaHash)
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
					c.Set("data", tc.input)
					created, err := c.Create()
					if err != nil {
						t.Fatalf("create: %v", err)
					}
					seq := created.(*jsonTextRow).vals["seq"]

					// Read back the value
					q := model()
					q.AddAllColumns()
					q.Where("", []orm.ChainKey{{Column: "seq"}}, orm.AsInt64(seq))
					rows, err := orm.Gets[*jsonTextRow](q)
					if err != nil {
						t.Fatalf("read: %v", err)
					}
					if rows.Len() != 1 {
						t.Fatalf("expected 1 row, got %d", rows.Len())
					}

					readRow := rows.First()
					readData := readRow.vals["data"]
					if readData == nil {
						t.Fatal("data is nil")
					}

					// Convert read data to string for comparison
					var readStr string
					switch v := readData.(type) {
					case string:
						readStr = v
					case jsontext.Value:
						readStr = string(v)
					case []byte:
						readStr = string(v)
					default:
						b, _ := json.Marshal(v)
						readStr = string(b)
					}

					if readStr != tc.expected {
						t.Errorf("order mismatch:\n  expected: %s\n  got:      %s", tc.expected, readStr)
					}
				})
			}
		})
	}
}
