package orm_test

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/polyspec/orm/internal/testcase"
	"github.com/polyspec/orm/packages/orm-go/orm"
)

func TestDecimalModelFixture(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	data, err := os.ReadFile("../../../contracts/fixtures/decimal_model.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Columns []struct {
			ID        string `json:"id"`
			Precision int    `json:"precision"`
			Scale     int    `json:"scale"`
		} `json:"columns"`
		Cases []struct {
			ID       string `json:"id"`
			Column   string `json:"column"`
			Input    string `json:"input"`
			Expected struct {
				Value string `json:"value"`
				Error string `json:"error"`
			} `json:"expected"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	columns := map[string]struct{ precision, scale int }{}
	for _, column := range fixture.Columns {
		columns[column.ID] = struct{ precision, scale int }{column.Precision, column.Scale}
	}
	for _, tc := range fixture.Cases {
		t.Run(tc.ID, func(t *testing.T) {
			column, ok := columns[tc.Column]
			if !ok {
				t.Fatalf("unknown column %q", tc.Column)
			}
			actual, err := orm.NormalizeDecimal(tc.Input, column.precision, column.scale)
			if tc.Expected.Error != "" {
				if err == nil {
					t.Fatalf("expected %s", tc.Expected.Error)
				}
				if code := orm.ErrorCode(err); code != tc.Expected.Error {
					t.Fatalf("error code = %s, want %s", code, tc.Expected.Error)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if actual != tc.Expected.Value {
				t.Fatalf("decimal = %q, want %q", actual, tc.Expected.Value)
			}
			scaled, err := orm.DecimalScaledInt(tc.Input, column.precision, column.scale)
			if err != nil {
				t.Fatal(err)
			}
			decoded, err := orm.DecimalFromScaledInt(scaled, column.precision, column.scale)
			if err != nil {
				t.Fatal(err)
			}
			if decoded != tc.Expected.Value {
				t.Fatalf("SQLite decimal = %q, want %q", decoded, tc.Expected.Value)
			}
		})
	}
}
