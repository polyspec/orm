package orm_test

import (
	"encoding/json/jsontext"
	"testing"

	orderedjson "github.com/polyspec/ordered-json/packages/go"
	"github.com/polyspec/orm/packages/go/orm"
	_ "github.com/polyspec/orm/packages/go/orm/pg"
	_ "github.com/polyspec/orm/packages/go/orm/sqlite"

	"github.com/polyspec/orm/packages/go/testcase"
)

// jsonTextRow is a model for a table with a jsontext column: a row of the
// keyword model, which holds its column values by name.
type jsonTextRow = keywordRow

var jsonTextColumns = []string{"seq", "data"}

func jsonTextEntity(s *orm.Schema) *orm.Entity {
	return rowEntity("json_data", s, jsonTextColumns...)
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
	// The test of DIA-26, COD-15 (docs/spec).
	testcase.Start(t, testcase.Database)
	s := documentSchema(t, jsonTextSchema)
	eachDatabase(t, []string{"sqlite", "mysql", "postgres"}, s, 1, func(t *testing.T, driver, dsn string, db *orm.DB) {

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
				seq := as[*jsonTextRow](t, created).vals["seq"]

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
