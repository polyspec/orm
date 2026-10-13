package orm_test

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/plan"
	"github.com/polyspec/orm/engine/runtimemodel"
	"github.com/polyspec/orm/internal/testcase"
	"github.com/polyspec/orm/packages/go/orm"
)

// A datetime(p) or time(p) value binds on SQLite with exactly p fraction digits, the
// form the renderer's CHECK requires (dialects.md, Rules that keep the three databases
// identical). Six zero digits are the wire form of an IR message (protocol.md §5), so a
// zero past p is dropped; a non-zero digit past p is no value of the column (CODEC_ENCODE).

// timePrecisionInsert compiles the insert of one time_probe row from three parameters.
func timePrecisionInsert(t *testing.T, m *runtimemodel.Model) *plan.Step {
	t.Helper()
	request := map[string]any{
		"ir_version": 1, "manifest_hash": m.ManifestHash, "kind": "insert", "entity": "time_probe", "n_params": 3,
		"set": []map[string]any{{"column": "at", "p": 0}, {"column": "micro", "p": 1}, {"column": "clock", "p": 2}},
	}
	text, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	e, err := engine.New(m, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	out, err := e.Compile(text)
	if err != nil {
		t.Fatal(err)
	}
	var compiled plan.Plan
	if err := json.Unmarshal(out, &compiled); err != nil {
		t.Fatal(err)
	}
	return &compiled.Steps[0]
}

func TestSQLiteTimePrecision(t *testing.T) {
	testcase.Start(t, testcase.Database)
	m, err := runtimemodel.LoadFiles(filepath.Join("..", "..", "..", "contracts", "fixtures", "time_precision.dbs"))
	if err != nil {
		t.Fatal(err)
	}
	schema := &orm.Schema{Hash: m.ManifestHash, Text: m.ManifestText}
	cases := []struct {
		name                string
		params              []any
		at, micro, clock    string
		code, messagePrefix string
	}{
		{name: "no digits", params: []any{"2026-01-02 03:04:05", "2026-01-02 03:04:05.123456", "10:00:00.500"},
			at: "2026-01-02 03:04:05", micro: "2026-01-02 03:04:05.123456", clock: "10:00:00.500"},
		{name: "six zero digits past p are dropped", params: []any{"2026-01-02 03:04:05.000000", "2026-01-02 03:04:05.100000", "10:00:00.500000"},
			at: "2026-01-02 03:04:05", micro: "2026-01-02 03:04:05.100000", clock: "10:00:00.500"},
		{name: "fewer digits are padded", params: []any{"2026-01-02 03:04:05", "2026-01-02 03:04:05.1", "10:00:00"},
			at: "2026-01-02 03:04:05", micro: "2026-01-02 03:04:05.100000", clock: "10:00:00.000"},
		{name: "a digit past p of a datetime", params: []any{"2026-01-02 03:04:05.5", "2026-01-02 03:04:05", "10:00:00"}, code: "CODEC_ENCODE"},
		{name: "a digit past p of a time", params: []any{"2026-01-02 03:04:05", "2026-01-02 03:04:05", "10:00:00.0005"}, code: "CODEC_ENCODE"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dsn := newDatabase(t, "sqlite")
			db, err := orm.ConnectSchema(dsn, schema, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if err := db.Utils().Schema().Install(schema); err != nil {
				t.Fatal(err)
			}
			err = db.Execute(timePrecisionInsert(t, m), c.params)
			if c.code != "" {
				if orm.ErrorCode(err) != c.code {
					t.Fatalf("execute = %v; want %s", err, c.code)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			raw := openNative(t, "sqlite", dsn)
			defer raw.Close()
			var at, micro, clock string
			if err := raw.QueryRow(`SELECT CAST("at" AS TEXT), CAST("micro" AS TEXT), CAST("clock" AS TEXT) FROM "time_probe"`).Scan(&at, &micro, &clock); err != nil {
				t.Fatal(err)
			}
			if at != c.at || micro != c.micro || clock != c.clock {
				t.Fatalf("stored %q %q %q, want %q %q %q", at, micro, clock, c.at, c.micro, c.clock)
			}
		})
	}
}
